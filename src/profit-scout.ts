// Ranking wallets by what they actually made.
//
// minter-scout ranks on earliness and breadth, which are proxies: they say a
// wallet behaves like someone who knows what they are doing. This ranks on the
// thing itself -- mints matched to Seaport sales, cost against proceeds, both
// sides settled on-chain.
//
// It is the better signal and it is not a replacement, because it needs a
// wallet to have SOLD. A wallet that mints early and holds everything scores
// nothing here and may still be the best one to follow. So the two run side by
// side and answer different questions:
//
//   scout         who behaves like they know something
//   profit scout  who has been proved right
//
// WIN RATE IS THE POINT, not total profit. One wallet that made 3 ETH on a
// single lucky mint and lost on nine others is a worse thing to copy than one
// that made 0.4 ETH across eleven straight wins -- copying buys you their
// NEXT trade, which resembles their median, not their best.

import { MintRecord } from "./minter-scout";
import { SaleRecord } from "./seaport-sales";

const WEI = 1e18;

export interface ProfitStats {
  address: string;
  /** Collections they both minted and sold in this window. */
  collections: number;
  sold: number;
  /** Net of fees, from the sale events. */
  proceedsEth: number;
  /** Mint cost of exactly the items that sold. */
  costEth: number;
  realisedEth: number;
  /** Share of sales that beat their own mint cost, 0..1. */
  winRate: number;
  /** Biggest single win, which is what a lucky-once wallet is made of. */
  bestSaleEth: number;
  /** Realised profit divided by sales — the number that survives copying. */
  perSaleEth: number;
}

export interface RankedProfit extends ProfitStats {
  score: number;
}

/**
 * Below this there is no rate to speak of.
 *
 * Three sales is the least that can distinguish a habit from a coincidence --
 * a single win is a 100% win rate, and ranking on that would put every
 * one-hit wallet above every consistent one.
 */
export const MIN_SALES = 3;

/**
 * What a sale has to clear before it counts as a win.
 *
 * Cost alone is not the bar, and the live data showed why: on a chain where
 * most mints are free, cost is ZERO, so every sale above a single wei
 * "beat its cost" and the top of the table was a wall of 100% win rates that
 * distinguished nobody.
 *
 * A round trip is really two transactions -- the mint and the sale -- and on
 * this chain each costs roughly 0.000011 ETH at a 0.106 gwei base fee. So a
 * free mint sold for less than about 0.00003 lost money, and calling that a
 * win is how a metric ends up flattering exactly the wallets worth avoiding.
 */
export const ROUND_TRIP_GAS_ETH = 0.00003;

export function rankByProfit(
  mints: MintRecord[],
  sales: SaleRecord[],
  gasFloorEth = ROUND_TRIP_GAS_ETH
): RankedProfit[] {
  // Cost basis per wallet per collection, from the mints.
  interface Basis {
    minted: number;
    spentWei: bigint;
  }
  const basis = new Map<string, Basis>();
  const key = (addr: string, contract: string) => `${addr.toLowerCase()}:${contract.toLowerCase()}`;

  for (const m of mints) {
    const k = key(m.minter, m.nftContract);
    const qty = m.quantity > 0 ? m.quantity : 1;
    const b = basis.get(k);
    if (b) {
      b.minted += qty;
      b.spentWei += m.unitPriceWei * BigInt(qty);
    } else {
      basis.set(k, { minted: qty, spentWei: m.unitPriceWei * BigInt(qty) });
    }
  }

  interface Acc {
    collections: Set<string>;
    sold: number;
    proceedsEth: number;
    costEth: number;
    wins: number;
    bestSaleEth: number;
  }
  const acc = new Map<string, Acc>();

  for (const s of sales) {
    const k = key(s.seller, s.contract);
    const b = basis.get(k);
    // No mint in this window means no cost basis. Counting it at zero cost
    // would invent a profit equal to the entire sale price, which is how a
    // wallet that only ever resells other people's mints tops the table.
    if (!b || b.minted === 0) continue;

    const addr = s.seller.toLowerCase();
    let a = acc.get(addr);
    if (!a) {
      a = { collections: new Set(), sold: 0, proceedsEth: 0, costEth: 0, wins: 0, bestSaleEth: 0 };
      acc.set(addr, a);
    }

    const unitCostEth = Number(b.spentWei) / WEI / b.minted;
    const proceedsEth = Number(s.proceedsWei) / WEI;
    a.collections.add(s.contract.toLowerCase());
    a.sold++;
    a.proceedsEth += proceedsEth;
    a.costEth += unitCostEth;
    // Must clear the cost AND the gas it took to get there.
    if (proceedsEth > unitCostEth + gasFloorEth) a.wins++;
    a.bestSaleEth = Math.max(a.bestSaleEth, proceedsEth - unitCostEth);
  }

  const out: RankedProfit[] = [];
  for (const [address, a] of acc) {
    const stats: ProfitStats = {
      address,
      collections: a.collections.size,
      sold: a.sold,
      proceedsEth: a.proceedsEth,
      costEth: a.costEth,
      realisedEth: a.proceedsEth - a.costEth,
      winRate: a.sold > 0 ? a.wins / a.sold : 0,
      bestSaleEth: a.bestSaleEth,
      perSaleEth: a.sold > 0 ? (a.proceedsEth - a.costEth) / a.sold : 0,
    };
    out.push({ ...stats, score: profitScore(stats) });
  }
  return out.sort((a, b) => b.score - a.score || b.realisedEth - a.realisedEth);
}

/**
 * Consistency first, size second.
 *
 * Win rate is cubed, so 90% is worth roughly three times 60% rather than one
 * and a half: the gap between a wallet that usually wins and one that usually
 * does not is the whole question, and a linear term flattens it.
 *
 * Profit enters through a log, so a wallet ten times richer ranks higher but
 * not ten places higher. Without that, one outsized sale buys the top spot
 * outright -- and the single number that predicts the NEXT trade is the rate,
 * not the record.
 */
export function profitScore(s: ProfitStats): number {
  if (s.sold < MIN_SALES || s.realisedEth <= 0) return 0;
  const consistency = s.winRate ** 3;
  const size = Math.log10(1 + s.realisedEth * 1000);
  return consistency * size * Math.sqrt(s.collections);
}

export interface ProfitScoutOpts {
  limit?: number;
  exclude?: string[];
  /** Only wallets at or above this win rate, 0..1. */
  minWinRate?: number;
  /** Override what a sale must clear to count as a win. */
  gasFloorEth?: number;
}

export function profitScout(
  mints: MintRecord[],
  sales: SaleRecord[],
  opts: ProfitScoutOpts = {}
): RankedProfit[] {
  const skip = new Set((opts.exclude ?? []).map((a) => a.toLowerCase()));
  const floor = opts.minWinRate ?? 0;
  return rankByProfit(mints, sales, opts.gasFloorEth)
    .filter((m) => m.score > 0 && m.winRate >= floor && !skip.has(m.address))
    .slice(0, opts.limit ?? 10);
}

/** The reason, in one line — a rate, a record, and what it rests on. */
export function whyProfit(m: RankedProfit): string {
  const sign = m.realisedEth >= 0 ? "+" : "";
  return (
    `${Math.round(m.winRate * 100)}% win rate over ${m.sold} sales · ` +
    `${sign}${m.realisedEth.toFixed(4)} realised · ${m.perSaleEth.toFixed(5)} per sale`
  );
}
