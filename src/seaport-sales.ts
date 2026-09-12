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

import { Interface } from "ethers";
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
  const chunk = Math.max(1, opts.chunkBlocks ?? 2_000);
  const cap = opts.maxRecords ?? 20_000;
  const out: SaleRecord[] = [];

  for (let to = toBlock; to >= fromBlock; to -= chunk) {
    if (opts.shouldStop?.()) break;
    const from = Math.max(fromBlock, to - chunk + 1);

    let logs;
    try {
      logs = await provider.getLogs({
        address: SEAPORT_ADDRESS,
        topics: [ORDER_FULFILLED_TOPIC],
        fromBlock: from,
        toBlock: to,
      });
    } catch {
      // Usually the node's result cap. Reported rather than hidden, because a
      // skipped chunk biases the sample, but one gap must not end the scan.
      opts.onProgress?.(toBlock - from, out.length);
      continue;
    }

    for (const lg of logs) {
      const sale = decodeSale(lg as any);
      if (sale) out.push(sale);
    }

    opts.onProgress?.(toBlock - from, out.length);
    if (out.length >= cap) break;
  }

  return out;
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
