// Turning new blocks into "one of your wallets just did something".
//
// Three sources, and the filtering strategy differs for each because of what
// the events choose to index:
//
//   mints   SeaDropMint indexes `minter`, so the node filters and the answer
//           comes back tiny however wide the range.
//   sales   OrderFulfilled indexes `offerer` only. That is the seller on a
//           listing and the BUYER on an accepted bid, so a filtered query
//           misses exactly the sales made by taking someone's offer. The
//           window between polls is small, so this reads them all and filters
//           here rather than missing half.
//   moves   ERC-721 Transfer indexes `from` and `to`, so both directions
//           filter at the node -- but across EVERY collection, which means no
//           address argument and a topic-only query.

import { Interface, getAddress, zeroPadValue } from "ethers";
import { createProvider } from "./rpc-provider";
import { scanAllMints } from "./minter-scan";
import { scanSales } from "./seaport-sales";
import { Activity } from "./wallet-activity";

const TRANSFER = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);
const TRANSFER_TOPIC = TRANSFER.getEvent("Transfer")!.topicHash;

export interface ScanActivityOpts {
  rpcUrl: string;
  wallets: string[];
  fromBlock: number;
  toBlock: number;
  chunkBlocks?: number;
  /** Transfers are noisy and optional; mints and sales are the point. */
  includeTransfers?: boolean;
}

/**
 * ERC-721 moves in and out of the watched wallets.
 *
 * Topic-only, with no address filter, because a watched wallet can receive
 * from any collection on the chain and enumerating them first would be a
 * bigger scan than this one. A three-topic Transfer is ERC-721; ERC-20 uses
 * the same signature with the value UNindexed, so it has two topics and is
 * excluded here by the shape of the log rather than by guessing at contracts.
 */
async function scanTransfers(opts: ScanActivityOpts): Promise<Activity[]> {
  const provider = createProvider(opts.rpcUrl);
  const topics = opts.wallets.map((w) => zeroPadValue(getAddress(w), 32));
  const out: Activity[] = [];

  const query = async (position: "from" | "to") => {
    const filter =
      position === "from"
        ? [TRANSFER_TOPIC, topics, null, null]
        : [TRANSFER_TOPIC, null, topics, null];
    try {
      const logs = await provider.getLogs({
        topics: filter as any,
        fromBlock: opts.fromBlock,
        toBlock: opts.toBlock,
      });
      for (const lg of logs) {
        // Four topics or it is not an ERC-721 Transfer.
        if (lg.topics.length !== 4) continue;
        const parsed = TRANSFER.decodeEventLog("Transfer", lg.data, lg.topics);
        out.push({
          kind: position === "from" ? "out" : "in",
          wallet: getAddress(position === "from" ? (parsed.from as string) : (parsed.to as string)),
          contract: getAddress(lg.address),
          tokenId: String(parsed.tokenId),
          blockNumber: lg.blockNumber,
          txHash: lg.transactionHash,
        });
      }
    } catch {
      /* transfers are the optional half; losing them must not cost the rest */
    }
  };

  await Promise.all([query("from"), query("to")]);
  return out;
}

/**
 * Everything the watched wallets did between two blocks.
 *
 * A mint or a sale ALSO emits an ERC-721 Transfer, so the same act shows up
 * twice. Any transfer sharing a transaction with something already reported
 * is dropped -- without it, every mint arrives as "minted X" immediately
 * followed by "received X", which is one event described twice and reads like
 * the bot is confused.
 */
export async function scanActivity(opts: ScanActivityOpts): Promise<Activity[]> {
  if (opts.wallets.length === 0 || opts.fromBlock > opts.toBlock) return [];
  const watched = new Set(opts.wallets.map((w) => w.toLowerCase()));

  const [mints, sales, transfers] = await Promise.all([
    scanAllMints(opts.rpcUrl, opts.fromBlock, opts.toBlock, {
      minters: opts.wallets,
      maxRecords: 5_000,
    }).catch(() => []),
    scanSales(opts.rpcUrl, opts.fromBlock, opts.toBlock, {
      chunkBlocks: opts.chunkBlocks,
      maxRecords: 10_000,
    }).catch(() => []),
    opts.includeTransfers ? scanTransfers(opts).catch(() => []) : Promise.resolve([]),
  ]);

  const out: Activity[] = [];

  for (const m of mints) {
    out.push({
      kind: "mint",
      wallet: m.minter,
      contract: m.nftContract,
      quantity: m.quantity,
      valueWei: m.unitPriceWei * BigInt(Math.max(1, m.quantity)),
      blockNumber: m.blockNumber,
      txHash: m.txHash,
    });
  }

  // Seeded with the mints: a mint IS a transfer from the zero address, and it
  // has already been reported above as the more informative of the two.
  const settledTx = new Set<string>(mints.map((m) => m.txHash.toLowerCase()));
  for (const s of sales) {
    const seller = s.seller.toLowerCase();
    const buyer = s.buyer.toLowerCase();
    if (watched.has(seller)) {
      settledTx.add(s.txHash.toLowerCase());
      out.push({
        // Which side of the trade they were on changes what it tells you: a
        // wallet taking a standing bid is exiting at someone else's price.
        kind: s.viaOffer ? "sell-offer" : "sell",
        wallet: s.seller,
        contract: s.contract,
        tokenId: s.tokenId,
        valueWei: s.proceedsWei,
        blockNumber: s.blockNumber,
        txHash: s.txHash,
      });
    }
    if (watched.has(buyer)) {
      settledTx.add(s.txHash.toLowerCase());
      out.push({
        kind: "buy",
        wallet: s.buyer,
        contract: s.contract,
        tokenId: s.tokenId,
        valueWei: s.grossWei,
        blockNumber: s.blockNumber,
        txHash: s.txHash,
      });
    }
  }

  for (const t of transfers) {
    if (settledTx.has(t.txHash.toLowerCase())) continue;
    out.push(t);
  }

  // Chronological, so a burst reads in the order it happened.
  return out.sort((a, b) => a.blockNumber - b.blockNumber);
}
