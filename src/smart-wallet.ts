// A dossier on a wallet you have decided is worth watching.
//
// The scout says who to look at; this says what they actually did. Both are
// built from the same SeaDropMint stream, but the event carries more than the
// ranking needed: quantityMinted and unitMintPrice are in there, which means a
// wallet's real spend is knowable from the chain alone, without asking any
// marketplace what anything was worth.
//
// WHAT IS CERTAIN AND WHAT IS NOT, because a dossier that blurs the two is
// worse than none:
//
//   certain    what they minted, how many, what they paid. All from the event.
//   certain    what they still hold. balanceOf, read now.
//   derived    what they flipped -- minted minus held. Sound as a count, and
//              it says nothing about the price they got.
//   estimated  value of what remains, at the collection's floor. Someone
//              else's index, and a floor is an ask, not a sale.
//
// So realised profit is still not claimed. What IS claimed, and is new, is
// exact cost and an honest unrealised position on what they are still sitting
// on -- which between them answer "is this wallet actually any good".

import { computePnl, Pnl } from "./pnl";
import { MintRecord } from "./minter-scout";
import { SaleRecord, salesByCollection } from "./seaport-sales";

export interface SmartWallet {
  address: string;
  label: string;
  /** When it was recorded, so a stale dossier is visibly stale. */
  addedAt: number;
  chainKey: string;
  /** The scout numbers at the moment it was recorded. */
  scoutedScore?: number;
  scoutedEarliness?: number;
  note?: string;
}

/** One collection this wallet touched. */
export interface Position {
  contract: string;
  name?: string;
  minted: number;
  /** Total paid for them, in wei — from the event, not an estimate. */
  spentWei: bigint;
  /** Held now. Undefined when the balance could not be read. */
  held?: number;
  /** Cheapest ask, when a marketplace knows one. */
  floorEth?: number | null;
  /** Best standing bid. */
  bestOfferEth?: number | null;
  /** Sales this wallet actually made in this collection, from Seaport. */
  sold?: number;
  /** What those sales put in their pocket, after fees. */
  proceedsWei?: bigint;
  /** Sales that beat the per-item mint cost. */
  wins?: number;
}

export interface Dossier {
  address: string;
  chainKey: string;
  symbol: string;
  from: number;
  to: number;
  positions: Position[];
  totals: {
    mints: number;
    collections: number;
    spentEth: number;
    heldItems: number;
    /**
     * Minted minus held — what left the wallet. Null when unknowable.
     *
     * The two sides come from different bases: minted is whatever the scan
     * window saw, while balanceOf is all-time. A wallet that minted before
     * the window therefore holds more than the window shows it minting, and
     * subtracting gives a negative that clamps to a confident, wrong zero.
     */
    flipped: number | null;
    /** True when a balance exceeded the mints seen, so history predates the window. */
    partialHistory: boolean;
    /** Floor value of what is still held. Null when no floor is known. */
    heldFloorValueEth: number | null;
    /** Held value minus what the held items cost. Null when unknowable. */
    unrealisedEth: number | null;
    /** Items actually sold on Seaport, from OrderFulfilled. */
    sold: number;
    /** Net proceeds of those sales. */
    proceedsEth: number;
    /**
     * Proceeds minus what the sold items cost to mint.
     *
     * Unlike everything above it, this is settled: both sides are prices that
     * a transaction actually happened at, not an ask and not a bid.
     */
    realisedEth: number | null;
    /** Share of sales that beat their mint cost. Null with nothing sold. */
    winRate: number | null;
  };
}

/** Positions from a wallet's own mints, newest collection activity first. */
export function positionsFor(address: string, records: MintRecord[]): Position[] {
  const mine = records.filter((r) => r.minter.toLowerCase() === address.toLowerCase());
  const byContract = new Map<string, Position>();
  for (const r of mine) {
    const key = r.nftContract.toLowerCase();
    const p = byContract.get(key);
    const qty = r.quantity > 0 ? r.quantity : 1;
    const spent = r.unitPriceWei * BigInt(qty);
    if (p) {
      p.minted += qty;
      p.spentWei += spent;
    } else {
      byContract.set(key, { contract: r.nftContract, minted: qty, spentWei: spent });
    }
  }
  return [...byContract.values()].sort((a, b) => b.minted - a.minted);
}

/**
 * Attach this wallet's actual sales to the positions it minted.
 *
 * A sale is only counted against a position when the wallet also MINTED that
 * collection in the window, because the cost basis comes from the mint. A sale
 * of something they bought elsewhere is real money, but its profit is not
 * knowable from here, and folding it in at a cost of zero would invent a
 * profit equal to the whole sale price.
 */
export function attachSales(address: string, positions: Position[], sales: SaleRecord[]): Position[] {
  const byCollection = salesByCollection(address, sales);
  return positions.map((p) => {
    const mine = byCollection.get(p.contract.toLowerCase());
    if (!mine || mine.length === 0) return p;
    const unitCostWei = p.minted > 0 ? p.spentWei / BigInt(p.minted) : 0n;
    let proceeds = 0n;
    let wins = 0;
    for (const s of mine) {
      proceeds += s.proceedsWei;
      // A free mint that sold for anything at all is a win; the comparison
      // still holds because unitCost is then zero.
      if (s.proceedsWei > unitCostWei) wins++;
    }
    return { ...p, sold: mine.length, proceedsWei: proceeds, wins };
  });
}

const WEI = 1e18;

/**
 * Roll positions into the numbers worth reading.
 *
 * Held value is computed only from positions whose balance AND floor are both
 * known. A position missing either is left out of the value rather than
 * counted as zero -- treating an unknown as nothing is how a portfolio quietly
 * reports a loss it does not have.
 */
export function summarise(
  address: string,
  chainKey: string,
  symbol: string,
  positions: Position[],
  window: { from: number; to: number }
): Dossier {
  let mints = 0;
  let spentWei = 0n;
  let heldItems = 0;
  // Only positions whose balance was actually read can say anything about
  // flipping. Counting an unreadable one would report every mint in it as
  // sold, which is the opposite of what an unreadable balance means.
  let mintedWhereKnown = 0;
  let heldWhereKnown = 0;
  let partial = false;
  let heldFloor = 0;
  let heldCost = 0;
  let valued = 0;
  let sold = 0;
  let proceedsWei = 0n;
  let soldCostEth = 0;
  let wins = 0;
  let costedSales = 0;

  for (const p of positions) {
    mints += p.minted;
    spentWei += p.spentWei;

    if (p.sold) {
      sold += p.sold;
      proceedsWei += p.proceedsWei ?? 0n;
      wins += p.wins ?? 0;
      // Only sales with a cost basis contribute to realised profit, and only
      // those count toward the win rate.
      if (p.minted > 0) {
        costedSales += p.sold;
        soldCostEth += (Number(p.spentWei) / WEI / p.minted) * p.sold;
      }
    }

    if (p.held === undefined) continue;
    heldItems += p.held;
    if (p.held > p.minted) {
      // Holds more than this window saw it mint, so it was minting before the
      // window opened and nothing here can say what it sold.
      partial = true;
    } else {
      mintedWhereKnown += p.minted;
      heldWhereKnown += p.held;
    }
    if (p.floorEth == null || p.minted === 0) continue;
    valued++;
    heldFloor += p.held * p.floorEth;
    // Cost attributed per item, so holding 2 of 10 carries two items' cost.
    heldCost += (Number(p.spentWei) / WEI / p.minted) * p.held;
  }

  const heldFloorValueEth = valued > 0 ? heldFloor : null;
  return {
    address,
    chainKey,
    symbol,
    from: window.from,
    to: window.to,
    positions,
    totals: {
      mints,
      collections: positions.length,
      spentEth: Number(spentWei) / WEI,
      heldItems,
      flipped: mintedWhereKnown === 0 && partial ? null : Math.max(0, mintedWhereKnown - heldWhereKnown),
      partialHistory: partial,
      heldFloorValueEth,
      unrealisedEth: heldFloorValueEth === null ? null : heldFloorValueEth - heldCost,
      sold,
      proceedsEth: Number(proceedsWei) / WEI,
      realisedEth: costedSales > 0 ? Number(proceedsWei) / WEI - soldCostEth : null,
      winRate: costedSales > 0 ? wins / costedSales : null,
    },
  };
}

/** The existing P&L maths, applied to one position. */
export function positionPnl(p: Position): Pnl {
  const qty = p.held ?? p.minted;
  return computePnl({
    quantity: qty,
    wallets: 1,
    mintPriceEth: p.minted > 0 ? Number(p.spentWei) / WEI / p.minted : null,
    gasEth: null,
    floorEth: p.floorEth ?? null,
    bestOfferEth: p.bestOfferEth ?? null,
  });
}

const n = (v: number | null | undefined, dp = 4): string =>
  v === null || v === undefined ? "" : v.toFixed(dp);

/**
 * One row per position, for the export.
 *
 * Flat and wide rather than nested, because the point of a CSV is that it
 * opens in a spreadsheet and gets sorted by whichever column the reader cares
 * about -- which nesting defeats.
 */
export function dossierRows(d: Dossier): Record<string, string | number>[] {
  return d.positions.map((p) => {
    const pnl = positionPnl(p);
    return {
      wallet: d.address,
      chain: d.chainKey,
      collection: p.name ?? "",
      contract: p.contract,
      minted: p.minted,
      held: p.held ?? "",
      flipped: p.held === undefined || p.held > p.minted ? "" : p.minted - p.held,
      spent_eth: n(Number(p.spentWei) / WEI),
      unit_cost_eth: n(p.minted > 0 ? Number(p.spentWei) / WEI / p.minted : null, 6),
      floor_eth: n(p.floorEth),
      best_offer_eth: n(p.bestOfferEth),
      sold: p.sold ?? 0,
      proceeds_eth: n(p.proceedsWei === undefined ? null : Number(p.proceedsWei) / WEI),
      realised_eth: n(
        p.sold && p.minted > 0
          ? Number(p.proceedsWei ?? 0n) / WEI - (Number(p.spentWei) / WEI / p.minted) * p.sold
          : null
      ),
      win_rate: p.sold && p.minted > 0 ? ((p.wins ?? 0) / p.sold).toFixed(2) : "",
      floor_value_eth: n(pnl.floorValueEth),
      profit_at_floor_eth: n(pnl.profitAtFloorEth),
      roi_percent: pnl.roiPercent === null ? "" : pnl.roiPercent.toFixed(1),
    };
  });
}

/** One row per wallet, for a portfolio-level export across many. */
export function summaryRow(d: Dossier, w?: SmartWallet): Record<string, string | number> {
  return {
    wallet: d.address,
    label: w?.label ?? "",
    chain: d.chainKey,
    scout_score: w?.scoutedScore === undefined ? "" : w.scoutedScore.toFixed(2),
    earliness_percent: w?.scoutedEarliness === undefined ? "" : (w.scoutedEarliness * 100).toFixed(0),
    collections: d.totals.collections,
    mints: d.totals.mints,
    held: d.totals.heldItems,
    flipped: d.totals.flipped ?? "",
    spent_eth: n(d.totals.spentEth),
    sold: d.totals.sold,
    proceeds_eth: n(d.totals.proceedsEth),
    realised_eth: n(d.totals.realisedEth),
    win_rate: d.totals.winRate === null ? "" : d.totals.winRate.toFixed(2),
    held_floor_value_eth: n(d.totals.heldFloorValueEth),
    unrealised_eth: n(d.totals.unrealisedEth),
    recorded_at: w ? new Date(w.addedAt).toISOString() : "",
  };
}

export function describeDossier(d: Dossier, label?: string): string {
  const t = d.totals;
  const lines = [
    `${label ? `${label} — ` : ""}\`${d.address}\``,
    "",
    `${t.mints} mints across ${t.collections} collections`,
    `Spent ${t.spentEth.toFixed(4)} ${d.symbol}`,
    t.flipped === null
      ? `Holds ${t.heldItems} — flips unknown, they were minting before this window`
      : `Holds ${t.heldItems} · flipped ${t.flipped}`,
  ];
  if (t.sold > 0) {
    const sign = (t.realisedEth ?? 0) >= 0 ? "+" : "";
    lines.push(
      "",
      `Sold ${t.sold} on Seaport for ${t.proceedsEth.toFixed(4)} ${d.symbol} net`,
      t.realisedEth === null
        ? "Realised profit unknown — those sales have no mint cost in this window"
        : `*Realised ${sign}${t.realisedEth.toFixed(4)} ${d.symbol}*` +
          (t.winRate === null ? "" : ` · ${Math.round(t.winRate * 100)}% of sales beat their mint cost`)
    );
  }

  if (t.heldFloorValueEth !== null) {
    lines.push(`Still holding ≈ ${t.heldFloorValueEth.toFixed(4)} ${d.symbol} at floor`);
    if (t.unrealisedEth !== null) {
      const sign = t.unrealisedEth >= 0 ? "+" : "";
      lines.push(`Unrealised ${sign}${t.unrealisedEth.toFixed(4)} ${d.symbol}`);
    }
  }
  // Said once, plainly, rather than implied by a number that looks exact.
  if (t.partialHistory && t.flipped !== null) {
    lines.push("", "_Some holdings predate this window, so the flip count covers only what it saw._");
  }
  // The old caveat is gone: Seaport settles on-chain, so a sale price IS
  // knowable. What remains uncertain is only the part still unsold.
  lines.push(
    "",
    t.heldFloorValueEth !== null
      ? "_Realised is settled on-chain. Unrealised is at floor, which is an ask rather than a sale._"
      : "_Realised figures are settled on-chain, from Seaport._"
  );
  return lines.join("\n");
}
