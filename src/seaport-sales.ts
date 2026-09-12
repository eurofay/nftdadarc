// Realised sale prices, from the chain.
//
// I said earlier this could not be done -- that a sale price lives on a
// marketplace and not on the chain. That was wrong, and it is worth saying
// why: Seaport settles ON-CHAIN and emits OrderFulfilled carrying the whole
// order, both what moved and what was paid for it. OpenSea's API is a view
// over that, not the source of it.
//
// Measured on Robinhood: Seaport 1.6 is deployed at the canonical address and
// produced 956 OrderFulfilled events in 33 minutes. 1.4 and 1.5 have no code
// there, so one address covers the chain.
//
// This matters beyond tidiness. A floor price is an ASK -- what someone hopes
// to get -- and an offer is a BID. Neither is a transaction. These are the
// prices things actually changed hands at, which is the only number a
// realised profit can honestly be built from.
//
// TWO DIRECTIONS, AND THEY ARE NOT SYMMETRIC:
//
//   listing        the seller offers the NFT and the consideration is money.
//                  The offerer is the seller.
//   accepted bid   a bidder offers money (usually WETH) and the consideration
//                  includes the NFT. The offerer is the BUYER, and the seller
//                  is whoever fulfilled it.
//
// Reading only the first shape would silently miss every sale made by
// accepting an offer, which on a chain with thin liquidity is a lot of them.

import { Interface, getAddress, zeroPadValue } from "ethers";
import { chunksOf, runChunks } from "./chunk-scan";
import { createProvider } from "./rpc-provider";

/** Seaport 1.6, the canonical CREATE2 address. Verified deployed on Robinhood. */
export const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";

const IFACE = new Interface([
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType,address token,uint256 identifier,uint256 amount)[] offer, (uint8 itemType,address token,uint256 identifier,uint256 amount,address recipient)[] consideration)",
]);
export const ORDER_FULFILLED_TOPIC = IFACE.getEvent("OrderFulfilled")!.topicHash;

// Seaport's ItemType enum.
const NATIVE = 0;
const ERC20 = 1;
const ERC721 = 2;
const ERC1155 = 3;

const isNft = (t: number): boolean => t === ERC721 || t === ERC1155;
const isMoney = (t: number): boolean => t === NATIVE || t === ERC20;

export interface SaleRecord {
  contract: string;
  tokenId: string;
  /** Everything the buyer paid, fees included — the headline sale price. */
  grossWei: bigint;
  /**
   * What the seller actually received, once fees were taken out.
   *
   * This, not gross, is what a realised profit is made of: a 0.15 sale with
   * 0.0075 of fees put 0.1425 in the seller's pocket, and calling it 0.15
   * overstates every profit by the fee.
   */
  proceedsWei: bigint;
  seller: string;
  buyer: string;
  /** True when the sale happened by someone accepting a standing offer. */
  viaOffer: boolean;
  blockNumber: number;
  txHash: string;
}

/** Pull the sale out of one OrderFulfilled log, or null if it is not an NFT sale. */
export function decodeSale(log: {
  data: string;
  topics: readonly string[];
  blockNumber: number;
  transactionHash: string;
}): SaleRecord | null {
  let d: any;
  try {
    d = IFACE.decodeEventLog("OrderFulfilled", log.data, log.topics);
  } catch {
    return null;
  }

  const offer = d.offer as any[];
  const consideration = d.consideration as any[];

  const nftInOffer = offer.find((o) => isNft(Number(o.itemType)));
  const nftInConsideration = consideration.find((c) => isNft(Number(c.itemType)));
  const nft = nftInOffer ?? nftInConsideration;
  // A pure token swap with no NFT on either side is not a sale we care about.
  if (!nft) return null;

  const offerer: string = d.offerer;
  const recipient: string = d.recipient;

  let grossWei = 0n;
  let proceedsWei = 0n;
  let seller: string;
  let buyer: string;

  if (nftInOffer) {
    // Listing: offerer sold. Money is in the consideration, and the legs
    // addressed to the offerer are the ones they actually keep.
    seller = offerer;
    buyer = recipient;
    for (const c of consideration) {
      if (!isMoney(Number(c.itemType))) continue;
      grossWei += BigInt(c.amount);
      if (String(c.recipient).toLowerCase() === offerer.toLowerCase()) proceedsWei += BigInt(c.amount);
    }
  } else {
    // Accepted bid: the offerer is the BUYER and put up the money; the
    // fulfiller handed over the NFT. Fees come out of the bid, so the seller
    // nets the offer minus any money legs in the consideration.
    seller = recipient;
    buyer = offerer;
    for (const o of offer) {
      if (isMoney(Number(o.itemType))) grossWei += BigInt(o.amount);
    }
    let fees = 0n;
    for (const c of consideration) {
      if (isMoney(Number(c.itemType))) fees += BigInt(c.amount);
    }
    proceedsWei = grossWei > fees ? grossWei - fees : grossWei;
  }

  return {
    contract: String(nft.token),
    tokenId: String(nft.identifier),
    grossWei,
    proceedsWei,
    seller,
    buyer,
    viaOffer: !nftInOffer,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
  };
}

export interface ScanSalesOpts {
  chunkBlocks?: number;
  /**
   * Restrict to orders these addresses OFFERED, via the indexed topic.
   *
   * A narrower query by far, and incomplete in one specific way: `offerer` is
   * the seller on a listing but the BUYER on an accepted bid, where the seller
   * is `recipient` and not indexed. So this finds every sale a wallet listed
   * and none it made by accepting an offer -- fine for widening history
   * cheaply, wrong as the only source.
   */
  offerers?: string[];
  concurrency?: number;
  /** Called when chunks were lost even after retries. */
  onFailedChunks?: (count: number) => void;
  maxRecords?: number;
  onProgress?: (scanned: number, found: number) => void;
  shouldStop?: () => boolean;
}

/**
 * Every Seaport sale between two blocks, newest first.
 *
 * Newest-first for the same reason the mint scan is: stopping at a record cap
 * having read the most recent blocks is a better answer than stopping having
 * read the oldest.
 */
export async function scanSales(
  rpcUrl: string,
  fromBlock: number,
  toBlock: number,
  opts: ScanSalesOpts = {}
): Promise<SaleRecord[]> {
  if (fromBlock > toBlock) return [];
  const provider = createProvider(rpcUrl);

  const offererTopics =
    opts.offerers && opts.offerers.length > 0
      ? opts.offerers.map((a) => zeroPadValue(getAddress(a), 32))
      : null;
  const topics: (string | string[] | null)[] = offererTopics
    ? [ORDER_FULFILLED_TOPIC, offererTopics]
    : [ORDER_FULFILLED_TOPIC];

  // Narrow enough for the node to answer from an index, so chunking it would
  // only add round trips.
  const chunk = offererTopics
    ? Math.max(1, toBlock - fromBlock + 1)
    : Math.max(1, opts.chunkBlocks ?? 2_000);

  const { results: logs, failed } = await runChunks(
    chunksOf(fromBlock, toBlock, chunk),
    async (range) =>
      provider.getLogs({
        address: SEAPORT_ADDRESS,
        topics,
        fromBlock: range.from,
        toBlock: range.to,
      }),
    {
      concurrency: opts.concurrency,
      maxResults: opts.maxRecords ?? 20_000,
      shouldStop: opts.shouldStop,
      onProgress: (done, total, found) => opts.onProgress?.(done, found),
    }
  );
  // Surfaced rather than swallowed: a scan missing chunks is a scan whose
  // totals are wrong, and the caller has to be able to say so.
  if (failed > 0) opts.onFailedChunks?.(failed);

  const out: SaleRecord[] = [];
  for (const lg of logs) {
    const sale = decodeSale(lg as any);
    if (sale) out.push(sale);
  }
  return out;
}

/** Drop duplicates when two scans overlap, keyed by the log they came from. */
export function mergeSales(...lists: SaleRecord[][]): SaleRecord[] {
  const seen = new Map<string, SaleRecord>();
  for (const list of lists) {
    for (const s of list) seen.set(`${s.txHash}:${s.contract}:${s.tokenId}`, s);
  }
  return [...seen.values()];
}

/** Just this wallet's sales, keyed by the collection they were in. */
export function salesByCollection(address: string, sales: SaleRecord[]): Map<string, SaleRecord[]> {
  const mine = sales.filter((s) => s.seller.toLowerCase() === address.toLowerCase());
  const out = new Map<string, SaleRecord[]>();
  for (const s of mine) {
    const k = s.contract.toLowerCase();
    const list = out.get(k);
    if (list) list.push(s);
    else out.set(k, [s]);
  }
  return out;
}
