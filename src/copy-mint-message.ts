// Turning a copy-mint attempt into one message worth reading.
//
// The raw log repeated three lines per sighting, every sighting, with sixteen
// significant figures and bare contract addresses:
//
//   👀 0x49DFF9… minted 0x660eD4D0… (block 53724894) — copying
//        ⚠ 0xEf41Bc3F… holds 0.0004899558491099 ETH, needs 0.0005 — skipping
//        ⚠ 0xE607f2b1… holds 0.000320579997428385 ETH, needs 0.0005 — skipping
//        ✗ Skipped — no wallet can cover 0.0005 ETH
//
// Everything there is true and almost none of it is useful. What the reader
// actually needs is which collection, and — when it failed — what to DO about
// it. "Short by 0.0000001" is actionable; "holds 0.0004899558491099" is a
// number to squint at.

export interface WalletShortfall {
  address: string;
  heldWei: bigint;
  neededWei: bigint;
}

export interface CopyAttemptSummary {
  /** Collection name when known, otherwise the contract address. */
  collection: string;
  contract: string;
  slug?: string;
  sourceWallet: string;
  blockNumber: number;
  outcome: "minted" | "skipped" | "failed";
  reason?: string;
  quantity?: number;
  wallets?: WalletShortfall[];
  txHashes?: string[];
  /** How many times this same reason has already been reported recently. */
  repeatCount?: number;
}

const short = (addr: string): string => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

/**
 * Trim a wei amount to digits a person can hold in their head.
 *
 * Balances here run to eighteen decimals, and the difference that matters is
 * usually in the fourth or fifth. Printing all of them buries the one digit
 * the reader is looking for.
 */
export function trimEth(wei: bigint, significant = 3): string {
  if (wei === 0n) return "0";
  const whole = wei / 10n ** 18n;
  if (whole > 0n) return `${Number(wei) / 1e18}`.slice(0, 8);

  const asNumber = Number(wei) / 1e18;
  // toPrecision keeps the leading zeros that matter and drops the noise after.
  const trimmed = Number(asNumber.toPrecision(significant));
  return trimmed.toString();
}

/**
 * The single most useful sentence about a set of underfunded wallets.
 *
 * Reports the SHORTFALL of the closest wallet, because that is the number that
 * turns "it didn't work" into an action. A wallet 0.00000004 short and one
 * 0.0002 short are the same failure and completely different problems.
 */
export function describeShortfall(wallets: WalletShortfall[]): string | null {
  const underfunded = wallets.filter((w) => w.heldWei < w.neededWei);
  if (underfunded.length === 0) return null;
  const closest = underfunded.reduce((a, b) =>
    b.neededWei - b.heldWei < a.neededWei - a.heldWei ? b : a
  );
  const gap = closest.neededWei - closest.heldWei;
  return (
    `Needs ${trimEth(closest.neededWei)} ETH per wallet. ` +
    `Closest is ${short(closest.address)}, short ${trimEth(gap)}.`
  );
}

/** One compact block per attempt, with the collection leading. */
export function renderCopyAttempt(s: CopyAttemptSummary): string {
  const lines: string[] = [];
  const head =
    s.outcome === "minted" ? "🟢" : s.outcome === "failed" ? "🔴" : "⛔";

  lines.push(`${head} ${s.collection}`);
  if (s.slug) lines.push(`https://opensea.io/collection/${s.slug}`);
  lines.push(`copied from ${short(s.sourceWallet)} · block ${s.blockNumber}`);

  if (s.outcome === "minted") {
    const n = s.txHashes?.length ?? 0;
    lines.push(`Minted ${s.quantity ?? 1} with ${n} wallet(s).`);
    return lines.join("\n");
  }

  // Failures: the reason once, then what to do about it — never a line per
  // wallet, which is the same sentence repeated with different digits.
  if (s.reason) lines.push(s.reason);
  const shortfall = s.wallets ? describeShortfall(s.wallets) : null;
  if (shortfall) lines.push(shortfall);

  if (s.repeatCount && s.repeatCount > 1) {
    lines.push(`(${s.repeatCount}× recently — same reason)`);
  }
  return lines.join("\n");
}

/**
 * Suppress a reason that keeps recurring.
 *
 * A watcher following nineteen wallets reports the same underfunded-wallet
 * failure every time any of them mints. The first is information; the fifth is
 * noise that buries anything else. Counts repeats and reports them
 * periodically instead of every time.
 */
export class RepeatFilter {
  private readonly seen = new Map<string, { count: number; firstAt: number }>();

  constructor(
    private readonly windowMs = 30 * 60 * 1000,
    private readonly reportEvery = 5
  ) {}

  /** Whether to send this now, and how many were folded into it. */
  consider(key: string, now = Date.now()): { send: boolean; count: number } {
    const entry = this.seen.get(key);
    if (!entry || now - entry.firstAt > this.windowMs) {
      this.seen.set(key, { count: 1, firstAt: now });
      return { send: true, count: 1 };
    }
    entry.count += 1;
    // Report the first, then every Nth — so a persistent problem stays visible
    // without repeating itself into the background.
    const send = entry.count % this.reportEvery === 0;
    return { send, count: entry.count };
  }

  reset(): void {
    this.seen.clear();
  }
}
