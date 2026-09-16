// Deciding when to sell, and getting out when the floor disappears.
//
// The half most sniper bots are weakest at. Entering is a race and everyone
// optimises it; exiting is a series of judgement calls made while the number
// is moving, which is exactly when people make them badly. So the rules are
// decided in advance, written down here, and evaluated by a pure function
// that cannot be argued with at three in the morning.
//
// THE LADDER, and why the first rung is where it is. A memecoin position has
// two completely different risk profiles either side of one moment: before you
// have recovered your stake, a rug costs you money; after, it costs you
// profit. Selling half at 2x moves you across that line -- the original stake
// is back in the wallet and everything still held is free. Every rung after
// that is about how much of the upside to keep exposed, which is a preference.
// The first one is arithmetic.
//
// THE TRIPWIRE, and why it outranks everything. A ladder assumes you can sell
// when you decide to. That assumption fails in exactly two ways, both of them
// sudden: the liquidity is pulled, or the token stops permitting sells. Both
// are detectable, neither is recoverable, and in both cases the right move is
// to leave immediately at whatever price exists rather than wait for a rung.
// So the tripwire is checked first and ignores every other rule.
//
// WHAT THIS FILE DOES NOT DO. It does not send anything. It reads a position
// and the current state and returns a decision, so the rules can be tested
// exhaustively without a chain, and so the code that spends money stays small
// enough to read in one go.

export interface LadderRung {
  /** Multiple of the entry price at which this rung fires. */
  multiple: number;
  /** How much of the ORIGINAL position to sell, in basis points. */
  sellBps: number;
}

/**
 * The default ladder.
 *
 * 2x/50% first because that is the rung that changes the character of the
 * position rather than the size of it -- after it fires the stake is home and
 * the rest is free. The later rungs total 50%, so a position that runs all the
 * way is fully closed rather than leaving a remainder nobody decided about.
 */
export const DEFAULT_LADDER: readonly LadderRung[] = Object.freeze([
  { multiple: 2, sellBps: 5_000 },
  { multiple: 5, sellBps: 2_500 },
  { multiple: 10, sellBps: 1_500 },
  { multiple: 25, sellBps: 1_000 },
]);

export interface Position {
  token: string;
  /** Pool this was bought in, so the exit uses the same one. */
  poolId: string;
  wallet: string;
  /** Quote asset spent, in the quote token's own decimals. */
  costQuote: bigint;
  /** Token amount received, raw. */
  tokensHeld: bigint;
  /** Tokens originally received, so ladder rungs stay sized to the entry. */
  tokensAtEntry: bigint;
  openedAt: number;
  /** Quote asset taken back out so far, across every partial sell. */
  realisedQuote: bigint;
  /** Rung multiples already fired, so none fires twice. */
  firedRungs: number[];
  /** Highest value this position has been worth, for the trailing stop. */
  peakQuote: bigint;
  ladder?: readonly LadderRung[];
  /** Trailing stop, in basis points off the peak. 0 disables it. */
  trailingStopBps?: number;
  /**
   * Gain required before the trailing stop arms, in basis points.
   *
   * Without this a stop is hit by ordinary noise minutes after entry: a new
   * token routinely moves 30% in either direction before it does anything,
   * and a stop that fires there converts every position into a small loss.
   */
  trailingArmsAtBps?: number;
}

export const DEFAULT_TRAILING_STOP_BPS = 3_500;
export const DEFAULT_TRAILING_ARMS_AT_BPS = 5_000;

export type ExitReason =
  /** Liquidity pulled, or the token stopped permitting sells. Leave now. */
  | "RUG"
  /** A ladder rung was reached. */
  | "LADDER"
  /** Dropped too far from the peak, after arming. */
  | "TRAILING_STOP"
  /** Nothing to do. */
  | "HOLD";

export interface ExitDecision {
  reason: ExitReason;
  /** How much of what is currently held to sell, raw. Zero for HOLD. */
  sellTokens: bigint;
  /** Said plainly, because this ends up in an alert. */
  detail: string;
  /** The rung that fired, so the caller can record it. */
  rung?: number;
}

export interface MarketState {
  /** What the whole remaining position is worth now, in quote decimals. */
  valueQuote: bigint;
  /** False when a sell test that used to pass has started failing. */
  sellable: boolean;
  /** Quote asset left in the pool. Used to spot liquidity being pulled. */
  poolQuote?: bigint;
  /** Pool liquidity at entry, for the same comparison. */
  poolQuoteAtEntry?: bigint;
}

/**
 * How far liquidity can fall before it counts as pulled.
 *
 * Not zero, because a pool drains a little as people sell into it, and not
 * generous, because the whole point is to be early. 60% off the level at entry
 * is far more than ordinary selling and far less than a removal.
 */
export const RUG_LIQUIDITY_DROP_BPS = 6_000;

/**
 * What the ORIGINAL position would be worth at the current price.
 *
 * The number every rule below is measured against, and getting this wrong
 * breaks the ladder and the stop in opposite directions.
 *
 * The obvious thing is to compare the value of what is still held against what
 * was paid. That is wrong as soon as a rung has fired. After selling half at
 * 2x the remainder is worth about 1x the cost again, so a naive comparison
 * would need the price to reach 10x before it called it 5x -- the later rungs
 * would essentially never fire. And the trailing stop would see the value halve
 * the instant a rung sold, read it as a 50% drop from the peak, and dump the
 * rest of the position as a "stop" triggered by its own sale.
 *
 * Scaling the current value back up to the entry quantity removes both: this
 * tracks the PRICE, and selling part of the position does not move it.
 */
export function entryEquivalentValue(p: Position, valueQuote: bigint): bigint {
  if (p.tokensHeld === 0n) return 0n;
  return (valueQuote * p.tokensAtEntry) / p.tokensHeld;
}

/**
 * What to do with this position right now.
 *
 * Pure, and deliberately so: every rule in here is a decision about money, and
 * a decision about money should be testable without a network.
 */
export function evaluatePosition(p: Position, m: MarketState): ExitDecision {
  // ── The tripwire, first and unconditionally ────────────────────────────
  //
  // A ladder assumes you can sell when you decide to. These are the two ways
  // that assumption fails, and neither recovers.
  if (!m.sellable) {
    return {
      reason: "RUG",
      sellTokens: p.tokensHeld,
      detail: "this token has stopped allowing sells — leaving now, at whatever price exists",
    };
  }
  if (
    m.poolQuote !== undefined &&
    m.poolQuoteAtEntry !== undefined &&
    m.poolQuoteAtEntry > 0n &&
    m.poolQuote * 10_000n < m.poolQuoteAtEntry * BigInt(10_000 - RUG_LIQUIDITY_DROP_BPS)
  ) {
    const pct = Number((m.poolQuote * 100n) / m.poolQuoteAtEntry);
    return {
      reason: "RUG",
      sellTokens: p.tokensHeld,
      detail: `pool liquidity is down to ${pct}% of what it was at entry — leaving now`,
    };
  }

  if (p.tokensHeld === 0n) {
    return { reason: "HOLD", sellTokens: 0n, detail: "nothing left to sell" };
  }

  // ── Ladder ─────────────────────────────────────────────────────────────
  //
  // Measured against the ENTRY cost, not against the peak or the last rung,
  // so "2x" means what a person means by it.
  const ladder = p.ladder ?? DEFAULT_LADDER;
  // Price, not remaining value -- see entryEquivalentValue for why the
  // difference matters and what breaks without it.
  const priced = entryEquivalentValue(p, m.valueQuote);
  if (p.costQuote > 0n) {
    // Highest unfired rung that the current value has passed. Highest rather
    // than lowest so a position that gaps from 1x to 6x does not sell in
    // three separate dribbles on the way through.
    let hit: LadderRung | null = null;
    for (const rung of ladder) {
      if (p.firedRungs.includes(rung.multiple)) continue;
      if (priced * 100n >= p.costQuote * BigInt(Math.round(rung.multiple * 100))) {
        if (!hit || rung.multiple > hit.multiple) hit = rung;
      }
    }
    if (hit) {
      // Sized against the ENTRY holding, so the rung means the same thing
      // whatever earlier rungs have already sold.
      const want = (p.tokensAtEntry * BigInt(hit.sellBps)) / 10_000n;
      const sell = want > p.tokensHeld ? p.tokensHeld : want;
      return {
        reason: "LADDER",
        sellTokens: sell,
        rung: hit.multiple,
        detail:
          hit.multiple === 2
            ? "up 2x — selling half, which puts the original stake back in the wallet"
            : `up ${hit.multiple}x — selling ${hit.sellBps / 100}% of the entry position`,
      };
    }
  }

  // ── Trailing stop ──────────────────────────────────────────────────────
  const stopBps = p.trailingStopBps ?? DEFAULT_TRAILING_STOP_BPS;
  const armsAt = p.trailingArmsAtBps ?? DEFAULT_TRAILING_ARMS_AT_BPS;
  if (stopBps > 0 && p.costQuote > 0n) {
    const armed = p.peakQuote * 10_000n >= p.costQuote * BigInt(10_000 + armsAt);
    if (armed && p.peakQuote > 0n) {
      const floor = (p.peakQuote * BigInt(10_000 - stopBps)) / 10_000n;
      if (priced < floor) {
        const off = Number(((p.peakQuote - priced) * 10_000n) / p.peakQuote) / 100;
        return {
          reason: "TRAILING_STOP",
          sellTokens: p.tokensHeld,
          detail: `down ${off.toFixed(1)}% from its peak — closing the rest`,
        };
      }
    }
  }

  return { reason: "HOLD", sellTokens: 0n, detail: "holding" };
}

/**
 * Slippage allowed on a planned sale.
 *
 * Wide, deliberately. The expected figure it is applied to is a MID price read
 * from the pool: it ignores the fee and it ignores the sale's own impact, and
 * on a thin new pool the impact of selling half a position is the larger of
 * the two. A tight floor here does not protect against a bad fill, it just
 * reverts the sale and leaves the position open -- which on the way down is
 * the worst of both.
 */
export const DEFAULT_SELL_SLIPPAGE_BPS = 1_500;

/**
 * The floor to put under a sale, or zero to accept any price.
 *
 * The distinction this exists to make: a RUG exit must not have a floor. The
 * whole point of that path is to leave while leaving is still possible, and a
 * minimum-out turns it into a transaction that reverts precisely when the
 * price is collapsing -- which is the one moment the position must actually
 * move. A ladder sell is the opposite case: it is discretionary, there is no
 * emergency, and accepting any price at all means a sandwich or a dying pool
 * can take the lot.
 *
 * So: floors on the rungs and the stop, no floor on the rug.
 */
export function minOutForExit(
  decision: ExitDecision,
  expectedQuote: bigint,
  slippageBps: number = DEFAULT_SELL_SLIPPAGE_BPS
): bigint {
  if (decision.reason === "RUG") return 0n;
  if (expectedQuote <= 0n) return 0n;
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.floor(slippageBps))));
  return (expectedQuote * (10_000n - bps)) / 10_000n;
}

/** Apply a decision to a position, returning the updated one. */
export function applyExit(p: Position, d: ExitDecision, receivedQuote: bigint): Position {
  const sold = d.sellTokens > p.tokensHeld ? p.tokensHeld : d.sellTokens;
  return {
    ...p,
    tokensHeld: p.tokensHeld - sold,
    // Recorded so the same rung cannot fire again on the next tick, which
    // would sell the position out in a handful of seconds.
    firedRungs: d.rung === undefined ? p.firedRungs : [...p.firedRungs, d.rung],
    // Realised proceeds reduce what is still at risk, which is what makes
    // "the stake is home" a fact rather than a feeling.
    realisedQuote: p.realisedQuote + receivedQuote,
  };
}

/**
 * Track the high-water mark the trailing stop measures from.
 *
 * Recorded at entry-equivalent scale, for the same reason the ladder is: a
 * peak stored as the value of the CURRENT holding would collapse the moment a
 * rung sold half the position, and the stop would then fire on its own sale.
 */
export function markPeak(p: Position, valueQuote: bigint): Position {
  const priced = entryEquivalentValue(p, valueQuote);
  return priced > p.peakQuote ? { ...p, peakQuote: priced } : p;
}

export interface PositionPnL {
  /** Proceeds already taken. */
  realisedQuote: bigint;
  /** What the remainder is worth now. */
  unrealisedQuote: bigint;
  /** Realised plus unrealised, less what it cost. Can be negative. */
  netQuote: bigint;
  /** Whether the original stake has been recovered. */
  stakeRecovered: boolean;
}

/**
 * Where this position stands.
 *
 * stakeRecovered is called out separately because it is the fact that changes
 * how the position should be treated, and it is not visible from a percentage.
 */
export function positionPnL(p: Position, valueQuote: bigint): PositionPnL {
  const realised = p.realisedQuote;
  return {
    realisedQuote: realised,
    unrealisedQuote: valueQuote,
    netQuote: realised + valueQuote - p.costQuote,
    stakeRecovered: realised >= p.costQuote,
  };
}
