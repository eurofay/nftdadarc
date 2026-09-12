// What a collection is worth, from trades rather than from listings.
//
// Everywhere this bot quotes a price it has been quoting OpenSea's floor and
// best offer. Both are useful and neither is a transaction:
//
//   floor  the cheapest ASK. What someone hopes to get. Nobody has agreed.
//   offer  the highest BID. What someone hopes to pay. Same problem.
//   index  both arrive through an API that lags, caches, and on a chain this
//          new often has no entry at all.
//
// A settled sale has none of those problems. Seaport emits OrderFulfilled on
// execution, so the price two people actually agreed on is on-chain, exact,
// and available the moment it happens. On a thin market that difference is not
// academic: a floor can sit stale for hours above or below anything real.
//
// This is a COMPANION to the OpenSea numbers, not a replacement. A collection
// with no sales in the window has no on-chain price and the floor is all there
// is. The right answer is to show both and say which is which.

import { SaleRecord, scanSales } from "./seaport-sales";

const WEI = 1e18;

export interface OnchainMarket {
  contract: string;
  /** The most recent settled sale. */
  lastSaleEth: number | null;
  lastSaleBlock: number | null;
  /**
   * The middle sale of the window.
   *
   * Preferred to the mean because one wash trade or one fat finger moves a
   * mean and barely touches a median, and thin markets produce both.
   */
  medianSaleEth: number | null;
  /** Sales in the window — the number that says how much to trust the rest. */
  sales: number;
  volumeEth: number;
  /** The lowest and highest settled price, so a spread is visible. */
  lowEth: number | null;
  highEth: number | null;
}

export const EMPTY_MARKET = (contract: string): OnchainMarket => ({
  contract,
  lastSaleEth: null,
  lastSaleBlock: null,
  medianSaleEth: null,
  sales: 0,
  volumeEth: 0,
  lowEth: null,
  highEth: null,
});

/** Roll a collection's sales into the numbers worth quoting. */
export function marketFromSales(contract: string, sales: SaleRecord[]): OnchainMarket {
  const mine = sales.filter((s) => s.contract.toLowerCase() === contract.toLowerCase());
  if (mine.length === 0) return EMPTY_MARKET(contract);

  // Gross, not proceeds: this is "what does one of these go for", which is
  // what a buyer pays. Proceeds is the seller's side and belongs in P&L.
  const prices = mine.map((s) => Number(s.grossWei) / WEI).sort((a, b) => a - b);
  const newest = mine.reduce((a, b) => (b.blockNumber > a.blockNumber ? b : a));
  const mid = Math.floor(prices.length / 2);

  return {
    contract,
    lastSaleEth: Number(newest.grossWei) / WEI,
    lastSaleBlock: newest.blockNumber,
    medianSaleEth: prices.length % 2 === 1 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2,
    sales: mine.length,
    volumeEth: prices.reduce((a, b) => a + b, 0),
    lowEth: prices[0],
    highEth: prices[prices.length - 1],
  };
}

export interface ReadMarketOpts {
  chunkBlocks?: number;
  /** How far back to look. Defaults to whatever the caller scanned. */
  fromBlock: number;
  toBlock: number;
  maxRecords?: number;
}

/** Scan the chain for one collection's sales. */
export async function readOnchainMarket(
  rpcUrl: string,
  contract: string,
  opts: ReadMarketOpts
): Promise<OnchainMarket> {
  const sales = await scanSales(rpcUrl, opts.fromBlock, opts.toBlock, {
    chunkBlocks: opts.chunkBlocks,
    maxRecords: opts.maxRecords ?? 20_000,
  });
  return marketFromSales(contract, sales);
}

/**
 * The most defensible number to value a holding at.
 *
 * Order matters and it is not "whatever is biggest". A settled median beats a
 * standing bid because one is a completed trade and the other is a hope; a
 * standing bid beats a floor because a bid can be taken now while a floor is
 * an ask nobody has met. The floor is the last resort, not the default it has
 * been until now.
 */
export function bestValuation(m: OnchainMarket, bestOfferEth?: number | null, floorEth?: number | null): {
  eth: number | null;
  basis: "settled" | "offer" | "floor" | "none";
} {
  // One sale is an anecdote; it still beats a stale index, but the median
  // only starts meaning something with a few behind it.
  if (m.medianSaleEth !== null && m.sales >= 2) return { eth: m.medianSaleEth, basis: "settled" };
  if (m.lastSaleEth !== null) return { eth: m.lastSaleEth, basis: "settled" };
  if (bestOfferEth != null && bestOfferEth > 0) return { eth: bestOfferEth, basis: "offer" };
  if (floorEth != null && floorEth > 0) return { eth: floorEth, basis: "floor" };
  return { eth: null, basis: "none" };
}

/** Plain words for where a number came from, so it is never mistaken. */
export function describeBasis(basis: ReturnType<typeof bestValuation>["basis"]): string {
  switch (basis) {
    case "settled":
      return "from settled sales on-chain";
    case "offer":
      return "from the best standing bid — nothing has sold recently";
    case "floor":
      return "from the floor, which is an ask rather than a sale";
    default:
      return "no price available";
  }
}

/** One line for a message. Empty when there is nothing to say. */
export function describeMarket(m: OnchainMarket, symbol: string): string {
  if (m.sales === 0) return "";
  const parts = [`${m.sales} sale${m.sales === 1 ? "" : "s"} on-chain`];
  if (m.lastSaleEth !== null) parts.push(`last ${m.lastSaleEth.toFixed(4)} ${symbol}`);
  if (m.medianSaleEth !== null && m.sales >= 2) parts.push(`median ${m.medianSaleEth.toFixed(4)}`);
  if (m.lowEth !== null && m.highEth !== null && m.highEth > m.lowEth) {
    parts.push(`range ${m.lowEth.toFixed(4)}–${m.highEth.toFixed(4)}`);
  }
  return parts.join(" · ");
}
