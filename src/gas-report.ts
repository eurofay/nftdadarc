// The "where did my gas go" answer, as a chat message.
//
// Kept apart from gas-ledger.ts, which does the arithmetic: this file only
// decides what is worth saying. The distinction matters because the numbers
// here are small and easily meaningless — 0.000011 ETH is not a figure anyone
// can reason about in isolation, so every total is paired with the thing that
// makes it legible: what it was spent on, how many transactions, and the
// average price per unit of gas, which is the number that says whether you
// are overpaying.

import { GasEntry, GasTotals, byAction, byDay, byWallet, shortEth, since, startOfDay, totalise, averageGwei } from "./gas-ledger";

export interface ReportWindow {
  label: string;
  fromMs: number;
}

/** Today, the last week, and everything held — the three questions people ask. */
export function windows(now = Date.now()): Record<"today" | "week" | "all", ReportWindow> {
  return {
    today: { label: "Today", fromMs: startOfDay(0, now) },
    week: { label: "Last 7 days", fromMs: startOfDay(6, now) },
    all: { label: "All time", fromMs: 0 },
  };
}

function headline(totals: GasTotals, symbol: string): string[] {
  if (totals.entries === 0) return ["Nothing sent in this window."];
  const lines = [
    `${shortEth(totals.costWei)} ${symbol} across ${totals.entries} transaction(s)`,
    `${totals.gasUsed.toLocaleString()} gas at ${averageGwei(totals).toFixed(4)} gwei average`,
  ];
  // Only mentioned when it happened. A permanent "wasted: 0" line trains the
  // eye to skip the place where the bad news would appear.
  if (totals.wastedWei > 0n) {
    lines.push(`${shortEth(totals.wastedWei)} ${symbol} of that burned on reverted transactions`);
  }
  return lines;
}

export interface RenderOpts {
  entries: GasEntry[];
  window: ReportWindow;
  symbol: string;
  /** Turns an address into whatever the operator calls it. */
  label: (address: string) => string;
  /** How many rows each breakdown shows before it stops being readable. */
  limit?: number;
}

export function renderGasReport(opts: RenderOpts): string {
  const rows = since(opts.entries, opts.window.fromMs);
  const limit = opts.limit ?? 8;
  const out: string[] = [`⛽ Gas — ${opts.window.label}`, ""];
  out.push(...headline(totalise(rows), opts.symbol));

  if (rows.length === 0) return out.join("\n");

  out.push("", "BY WALLET");
  for (const b of byWallet(rows).slice(0, limit)) {
    out.push(`  ${opts.label(b.key)} — ${shortEth(b.totals.costWei)} (${b.totals.entries} tx)`);
  }

  out.push("", "BY ACTION");
  for (const b of byAction(rows).slice(0, limit)) {
    out.push(`  ${b.key} — ${shortEth(b.totals.costWei)} (${b.totals.entries} tx)`);
  }

  // A single day's report is already "by day", so the breakdown would just
  // restate the headline.
  const days = byDay(rows);
  if (days.length > 1) {
    out.push("", "BY DAY");
    for (const b of days.slice(0, limit)) {
      out.push(`  ${b.key} — ${shortEth(b.totals.costWei)} (${b.totals.entries} tx)`);
    }
  }

  return out.join("\n");
}

/**
 * One line per wallet, for the wallets view.
 *
 * Answers the question that actually comes up when funding: which of these is
 * eating the money.
 */
export function walletGasLine(entries: GasEntry[], address: string, symbol: string, fromMs = 0): string {
  const mine = since(entries, fromMs).filter((e) => e.address.toLowerCase() === address.toLowerCase());
  if (mine.length === 0) return "no gas spent yet";
  const t = totalise(mine);
  return `${shortEth(t.costWei)} ${symbol} over ${t.entries} tx`;
}
