// Profit and loss for one collection, summed across every wallet that minted.
//
// Two numbers matter and they are not the same. Floor is the cheapest ASK —
// what someone is willing to sell for, which you only realise by finding a
// buyer. The best collection offer is the highest BID — what you can take
// right now, today, without waiting. A haul is worth its floor on paper and
// its best offer in practice, so both are computed and the gap between them
// is shown rather than hidden behind one optimistic figure.
//
// Cost basis is the honest weak point. The store records what was minted but
// never what it cost, so the mint price comes from the collection's on-chain
// stage and gas from the measured model in gas.ts. Both are labelled as
// estimates where they are shown, because a wallet that minted an allow-list
// stage at a different price would otherwise read as fact.

export interface PnlInputs {
  /** Tokens held across all wallets, counted on-chain. */
  quantity: number;
  /** How many wallets hold them. */
  wallets: number;
  /** Per-item mint price, from the collection's stage. Null when unknown. */
  mintPriceEth: number | null;
  /** Estimated gas across every mint transaction. Null when unknown. */
  gasEth: number | null;
  /** Cheapest ask. */
  floorEth: number | null;
  /** Highest standing bid for any item in the collection. */
  bestOfferEth: number | null;
}

export interface Pnl {
  /** Mint price × quantity. Null when the price is unknown. */
  mintCostEth: number | null;
  /** Mint cost plus gas — what the haul actually cost to acquire. */
  totalCostEth: number | null;
  /** Paper value: quantity × floor. */
  floorValueEth: number | null;
  /** Realisable value: quantity × best offer. */
  offerValueEth: number | null;
  /** Floor value minus cost. */
  profitAtFloorEth: number | null;
  /** Offer value minus cost — the number you can act on. */
  profitAtOfferEth: number | null;
  /** Return on the total cost, at floor. Null when the mint was free. */
  roiPercent: number | null;
  /** Floor at which the haul breaks even. Null when there was no cost. */
  breakEvenFloorEth: number | null;
}

const usable = (n: number | null | undefined): n is number =>
  n !== null && n !== undefined && Number.isFinite(n);

export function computePnl(input: PnlInputs): Pnl {
  const { quantity } = input;

  const mintCostEth = usable(input.mintPriceEth) ? input.mintPriceEth * quantity : null;
  // Gas alone is still a real cost — a free mint across nine wallets is not
  // free — so a known gas figure counts even when the mint price is not.
  const totalCostEth =
    mintCostEth === null && !usable(input.gasEth)
      ? null
      : (mintCostEth ?? 0) + (usable(input.gasEth) ? input.gasEth : 0);

  const floorValueEth = usable(input.floorEth) ? input.floorEth * quantity : null;
  const offerValueEth = usable(input.bestOfferEth) ? input.bestOfferEth * quantity : null;

  const profitAtFloorEth =
    floorValueEth === null || totalCostEth === null ? null : floorValueEth - totalCostEth;
  const profitAtOfferEth =
    offerValueEth === null || totalCostEth === null ? null : offerValueEth - totalCostEth;

  // ROI against a zero cost basis is not infinity, it is meaningless — a free
  // mint has no denominator to return against.
  const roiPercent =
    profitAtFloorEth === null || totalCostEth === null || totalCostEth <= 0
      ? null
      : (profitAtFloorEth / totalCostEth) * 100;

  const breakEvenFloorEth =
    totalCostEth === null || totalCostEth <= 0 || quantity <= 0 ? null : totalCostEth / quantity;

  return {
    mintCostEth,
    totalCostEth,
    floorValueEth,
    offerValueEth,
    profitAtFloorEth,
    profitAtOfferEth,
    roiPercent,
    breakEvenFloorEth,
  };
}

/** Compact ETH, keeping small numbers legible instead of rounding them away. */
export function eth(value: number | null | undefined): string {
  if (!usable(value)) return "—";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1) return value.toFixed(3);
  if (abs >= 0.001) return value.toFixed(4);
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/** Signed, so a loss reads as a loss at a glance. */
export function signedEth(value: number | null | undefined): string {
  if (!usable(value)) return "—";
  return `${value > 0 ? "+" : ""}${eth(value)}`;
}

export function pnlEmoji(profit: number | null): string {
  if (profit === null) return "◦";
  if (profit > 0) return "🟢";
  if (profit < 0) return "🔴";
  return "⚪";
}

export interface PnlReport extends PnlInputs {
  name: string;
  contract: string;
  symbol: string;
  /** Where the mint price came from, so an estimate is never read as fact. */
  priceSource: "stage" | "unknown";
  /** Wallets holding, with counts, biggest first. */
  breakdown: { address: string; label: string; count: number }[];
}

/**
 * The message body. Deliberately leads with what is certain — how many, in
 * how many wallets — because that comes off the chain and is always right,
 * while every value below it depends on someone else's index.
 */
export function renderPnl(report: PnlReport, pnl: Pnl): string {
  const lines: string[] = [];
  lines.push(`📊 *${report.name}* — P&L`);
  lines.push("");
  lines.push(`Held: *${report.quantity}* across *${report.wallets}* wallet(s)`);

  lines.push("");
  lines.push("*Cost*");
  lines.push(
    report.priceSource === "stage"
      ? `  Mint  ${eth(report.mintPriceEth)} ${report.symbol} each → ${eth(pnl.mintCostEth)}`
      : "  Mint  unknown — no readable stage price"
  );
  if (usable(report.gasEth)) lines.push(`  Gas   ~${eth(report.gasEth)} (estimated)`);
  lines.push(`  Total ${eth(pnl.totalCostEth)} ${report.symbol}`);

  lines.push("");
  lines.push("*Value*");
  lines.push(
    report.floorEth === null
      ? "  Floor  — (nothing listed)"
      : `  Floor  ${eth(report.floorEth)} each → ${eth(pnl.floorValueEth)}`
  );
  lines.push(
    report.bestOfferEth === null
      ? "  Offer  — (no standing bid)"
      : `  Offer  ${eth(report.bestOfferEth)} each → ${eth(pnl.offerValueEth)}`
  );

  lines.push("");
  lines.push("*P&L*");
  lines.push(
    `  ${pnlEmoji(pnl.profitAtFloorEth)} At floor  ${signedEth(pnl.profitAtFloorEth)} ${report.symbol}` +
      (pnl.roiPercent === null ? "" : `  (${pnl.roiPercent > 0 ? "+" : ""}${pnl.roiPercent.toFixed(0)}%)`)
  );
  lines.push(
    pnl.profitAtOfferEth === null
      ? "  ◦ At offer  — nobody is bidding on this collection yet"
      : `  ${pnlEmoji(pnl.profitAtOfferEth)} At offer  ${signedEth(pnl.profitAtOfferEth)} ${report.symbol}` +
        "  ← what you'd get selling now"
  );
  if (pnl.breakEvenFloorEth !== null) {
    lines.push(`  Break-even floor: ${eth(pnl.breakEvenFloorEth)} ${report.symbol}`);
  }

  if (report.breakdown.length > 0) {
    lines.push("");
    lines.push("*Per wallet*");
    for (const w of report.breakdown.slice(0, 15)) {
      lines.push(`  ${w.label} — ${w.count}`);
    }
    if (report.breakdown.length > 15) lines.push(`  …and ${report.breakdown.length - 15} more`);
  }

  // Said once, at the end, rather than hedging every line above it.
  const caveats: string[] = [];
  if (report.priceSource === "stage") {
    caveats.push("mint price is the collection's current stage price, not what each wallet actually paid");
  }
  if (usable(report.gasEth)) caveats.push("gas is modelled, not read back from receipts");
  if (report.floorEth === null && report.bestOfferEth === null) {
    caveats.push("OpenSea has no market data for this collection yet");
  }
  if (caveats.length > 0) {
    lines.push("");
    lines.push(`_Estimates: ${caveats.join("; ")}._`);
  }

  return lines.join("\n");
}
