// Knowing about a drop before it opens.
//
// SeaDrop's PublicDropUpdated carries the stage's startTime, and a project
// configuring a drop in advance is therefore announcing it on-chain. Measured
// on Robinhood over 45 consecutive events:
//
//   25 of 45 (56%)  were scheduled AHEAD of the block that configured them
//   advance notice  min 1.4m | median 37.2m | max 720h
//   14 of 45        were free
//
// Auto Mint only ever reacted to drops already live, so on more than half of
// them it was throwing away a median 37 minutes of warning. That is a far
// larger edge than anything the early-fire work can buy: milliseconds matter
// only once you are already at the start line.
//
// This file is the bookkeeping, deliberately free of network and Telegram so
// the decisions can be tested: what counts as upcoming, what counts as news,
// and when to stop caring.

export interface UpcomingDrop {
  contract: string;
  chainKey: string;
  /** Seconds since epoch, from the stage itself. */
  startTime: number;
  endTime: number;
  priceWei: bigint;
  maxPerWallet: number;
  /** Where the announcement was seen, for the explorer link. */
  blockNumber: number;
  /** When this process first saw it, for "spotted 3 minutes ago". */
  firstSeenMs: number;
}

/** How long until it opens. Negative once it has. */
export function leadMs(drop: Pick<UpcomingDrop, "startTime">, nowMs = Date.now()): number {
  return drop.startTime * 1000 - nowMs;
}

export function isUpcoming(drop: Pick<UpcomingDrop, "startTime">, nowMs = Date.now()): boolean {
  return leadMs(drop, nowMs) > 0;
}

/**
 * Still worth showing, even though it has opened.
 *
 * A drop that opened four minutes ago is usually still mintable and is
 * exactly what someone opening the radar wants to see. Dropping it the
 * instant the clock passes would make the board look empty during the only
 * minutes that matter.
 */
export const STILL_HOT_MS = 10 * 60 * 1000;

export function isLive(drop: Pick<UpcomingDrop, "startTime" | "endTime">, nowMs = Date.now()): boolean {
  const now = Math.floor(nowMs / 1000);
  return drop.startTime <= now && (drop.endTime === 0 || drop.endTime > now);
}

/**
 * Too far out to be news.
 *
 * One drop in the sample was configured 720 hours ahead. Alerting on that is
 * not an edge, it is a notification you will have forgotten by the time it
 * matters -- and it would arrive again every time the project touched the
 * stage. It still appears on the board, it just does not buzz.
 */
export const ALERT_HORIZON_MS = 24 * 60 * 60 * 1000;

export type Verdict = "new" | "changed" | "known" | "stale";

/**
 * What the radar currently knows.
 *
 * Keyed by contract because a project reconfigures the SAME stage rather than
 * adding another -- 19 of the 45 sampled events were edits to a drop that was
 * already live. Without dedupe, one project adjusting its price would alert
 * every time it saved.
 */
export class RadarBoard {
  private readonly seen = new Map<string, UpcomingDrop>();

  private key(contract: string, chainKey: string): string {
    return `${chainKey}:${contract.toLowerCase()}`;
  }

  /**
   * Record a sighting and say whether it is worth telling anyone about.
   *
   * "changed" is its own answer rather than folded into "new": a price or
   * time moving on a drop you are already armed for is the single most
   * important thing the radar can tell you, and it must not be silenced by
   * the dedupe that exists to stop repeats.
   */
  note(drop: UpcomingDrop): Verdict {
    const k = this.key(drop.contract, drop.chainKey);
    const before = this.seen.get(k);
    this.seen.set(k, before ? { ...drop, firstSeenMs: before.firstSeenMs } : drop);

    if (!before) return isUpcoming(drop) ? "new" : "stale";
    if (!isUpcoming(drop) && !isLive(drop)) return "stale";
    const moved =
      before.startTime !== drop.startTime ||
      before.priceWei !== drop.priceWei ||
      before.maxPerWallet !== drop.maxPerWallet;
    return moved ? "changed" : "known";
  }

  get(contract: string, chainKey: string): UpcomingDrop | undefined {
    return this.seen.get(this.key(contract, chainKey));
  }

  /** Soonest first — the board is a countdown, so the top row is the next one. */
  board(nowMs = Date.now()): UpcomingDrop[] {
    return [...this.seen.values()]
      .filter((d) => isUpcoming(d, nowMs) || (isLive(d, nowMs) && nowMs - d.startTime * 1000 < STILL_HOT_MS))
      .sort((a, b) => a.startTime - b.startTime);
  }

  /** Forget what has ended, so a long-running process does not grow forever. */
  prune(nowMs = Date.now()): number {
    let removed = 0;
    for (const [k, d] of this.seen) {
      const overByAn = d.startTime * 1000 < nowMs - 24 * 60 * 60 * 1000;
      const ended = d.endTime !== 0 && d.endTime * 1000 < nowMs;
      if (overByAn || ended) {
        this.seen.delete(k);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.seen.size;
  }
}

/** Whether this sighting should actually push a notification. */
export function shouldAlert(verdict: Verdict, drop: UpcomingDrop, nowMs = Date.now()): boolean {
  if (verdict === "known" || verdict === "stale") return false;
  const lead = leadMs(drop, nowMs);
  return lead > 0 && lead <= ALERT_HORIZON_MS;
}

/** "in 34 min", "in 2h 05m", "opening now". */
export function countdown(ms: number): string {
  if (ms <= 0) return "opening now";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return `in ${Math.max(1, Math.round(ms / 1000))}s`;
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 48) return `in ${h}h ${String(m).padStart(2, "0")}m`;
  return `in ${Math.round(h / 24)} days`;
}

export function priceLabel(wei: bigint, symbol: string): string {
  if (wei === 0n) return "FREE";
  const eth = Number(wei) / 1e18;
  return `${eth < 0.001 ? eth.toExponential(2) : eth.toFixed(4)} ${symbol}`;
}
