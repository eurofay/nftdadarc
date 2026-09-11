// What each wallet actually spent on gas, and when.
//
// Not an estimate. A transaction's real cost is only knowable after it lands:
//
//   cost = gasUsed x effectiveGasPrice
//
// Both come from the receipt. gasLimit is a ceiling that gets refunded, and
// maxFeePerGas is a bid that is usually not what you pay — quoting either as
// "what this cost" overstates it, often by 20x. So nothing here is recorded
// until a receipt exists.
//
// The explorer would be the obvious source and is not available: Blockscout
// answers 403 to its own API on this chain. So the bot records its own
// spending as it happens, which has the useful side effect of being exactly
// scoped to "what the bot did with my wallets" rather than everything an
// address ever touched.

/** One landed transaction, and what it cost. */
export interface GasEntry {
  address: string;
  /** Milliseconds since epoch, from when the receipt was read. */
  at: number;
  /** What the bot was doing — "Smart Mint", "Consolidate", "Fund Wallets". */
  action: string;
  txHash: string;
  gasUsed: number;
  /** Wei per unit of gas actually charged, as a decimal string. */
  effectiveGasPriceWei: string;
  /** True when the transaction reverted — the gas is spent either way. */
  reverted?: boolean;
}

export function entryCostWei(e: GasEntry): bigint {
  return BigInt(Math.max(0, Math.floor(e.gasUsed))) * BigInt(e.effectiveGasPriceWei || "0");
}

export interface GasTotals {
  entries: number;
  gasUsed: number;
  costWei: bigint;
  /** Gas burned on transactions that reverted — spent for nothing. */
  wastedWei: bigint;
}

export function totalise(entries: GasEntry[]): GasTotals {
  let gasUsed = 0;
  let costWei = 0n;
  let wastedWei = 0n;
  for (const e of entries) {
    const cost = entryCostWei(e);
    gasUsed += e.gasUsed;
    costWei += cost;
    if (e.reverted) wastedWei += cost;
  }
  return { entries: entries.length, gasUsed, costWei, wastedWei };
}

/** Local calendar day, so "today" means the operator's today. */
export function dayKey(at: number, now = new Date(at)): string {
  const d = new Date(at);
  void now;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function since(entries: GasEntry[], fromMs: number): GasEntry[] {
  return entries.filter((e) => e.at >= fromMs);
}

/** Start of the local day, `daysAgo` days back. */
export function startOfDay(daysAgo = 0, now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

function group<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

export interface Bucket {
  key: string;
  totals: GasTotals;
}

/** Biggest spender first — the wallet worth looking at is the expensive one. */
function ranked(groups: Map<string, GasEntry[]>): Bucket[] {
  return [...groups.entries()]
    .map(([key, list]) => ({ key, totals: totalise(list) }))
    .sort((a, b) => (a.totals.costWei < b.totals.costWei ? 1 : a.totals.costWei > b.totals.costWei ? -1 : 0));
}

export const byWallet = (entries: GasEntry[]): Bucket[] => ranked(group(entries, (e) => e.address.toLowerCase()));
export const byAction = (entries: GasEntry[]): Bucket[] => ranked(group(entries, (e) => e.action));

/** Chronological, newest day first — a spend history reads backwards. */
export function byDay(entries: GasEntry[]): Bucket[] {
  return [...group(entries, (e) => dayKey(e.at)).entries()]
    .map(([key, list]) => ({ key, totals: totalise(list) }))
    .sort((a, b) => (a.key < b.key ? 1 : -1));
}

/**
 * Wei as a short ETH string.
 *
 * formatEther gives 18 decimals, which for a 0.000011 ETH mint is a wall of
 * digits that hides the magnitude rather than showing it. This keeps enough
 * significant figures to compare two numbers and no more.
 */
export function shortEth(wei: bigint): string {
  if (wei === 0n) return "0";
  const eth = Number(wei) / 1e18;
  if (eth >= 0.001) return eth.toFixed(4);
  if (eth >= 0.000001) return eth.toFixed(7);
  return eth.toExponential(2);
}

/** Average price paid per unit of gas, in gwei — the number that says "am I overpaying?". */
export function averageGwei(totals: GasTotals): number {
  if (totals.gasUsed === 0) return 0;
  return Number(totals.costWei) / totals.gasUsed / 1e9;
}
