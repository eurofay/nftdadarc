// Watching an open position and acting on the rules in position.ts.
//
// The split is deliberate: position.ts decides, this executes. Every rule
// about money is a pure function tested without a chain, and the part that
// can actually spend is small enough to read in one sitting.
//
// WHY IT POLLS RATHER THAN SUBSCRIBES. Same reason as the launch watcher: a
// websocket dies silently and takes the watcher with it, and a position whose
// monitor died looks exactly like a position that is fine. Arc's blocks are
// ~0.5s, so a few seconds of poll interval is a handful of blocks -- and the
// thing being watched for, a rug, is not a one-block event that can be missed
// by being slightly late. It is a state you remain in.
//
// WHAT IT CHECKS EVERY TICK, and why both. Price alone misses a rug: a pool
// that has been drained can still quote a price, and a token that has stopped
// permitting sells quotes the best price it ever had. So the sell test runs on
// a slower cadence alongside the price read -- it costs a couple of eth_calls
// and it is the only thing that catches a token turning into a trap while it
// is held.

import { formatUnits } from "ethers";
import { DexConfig } from "./dex-registry";
import {
  ExitDecision,
  MarketState,
  Position,
  applyExit,
  evaluatePosition,
  markPeak,
  positionPnL,
} from "./position";
import { V4Pool, poolIdFor, quoteValueOf, readPoolState } from "./v4-swap";
import { checkSellable } from "./token-safety";

export interface WatchPositionOpts {
  rpcUrl: string;
  dex: DexConfig;
  pool: V4Pool;
  position: Position;
  /** Milliseconds between price reads. */
  pollMs?: number;
  /**
   * How often to re-run the sell test, in ticks.
   *
   * Less often than the price read because it is several calls rather than
   * one, and because a token turning into a trap is not something that needs
   * catching within a second -- it needs catching at all.
   */
  sellCheckEveryTicks?: number;
  /** Executes a sale and returns what the quote asset actually came back as. */
  sell: (p: Position, d: ExitDecision) => Promise<{ receivedQuote: bigint; txHash?: string }>;
  onUpdate?: (p: Position, m: MarketState) => void;
  onExit?: (p: Position, d: ExitDecision, txHash?: string) => void;
  onError?: (err: Error) => void;
}

export const DEFAULT_POSITION_POLL_MS = 6_000;
export const DEFAULT_SELL_CHECK_TICKS = 5;

/** Read everything the rules need to make a decision. */
export async function readMarketState(
  rpcUrl: string,
  dex: DexConfig,
  pool: V4Pool,
  position: Position,
  opts: { checkSell?: boolean; poolQuoteAtEntry?: bigint } = {}
): Promise<MarketState> {
  const state = await readPoolState(rpcUrl, dex, poolIdFor(pool.key));
  const valueQuote = state ? quoteValueOf(pool, state.sqrtPriceX96, position.tokensHeld) : 0n;

  // Default TRUE when the check is not run this tick. Defaulting to false
  // would dump every position on every tick that skipped the test, which is
  // the most expensive possible way to be cautious.
  let sellable = true;
  if (opts.checkSell && dex.v4PoolManager) {
    // A V4 pool is not a contract -- it is an entry inside the PoolManager
    // singleton, and the tokens live in the singleton. So the sell test moves
    // tokens THERE, which is exactly where a real sale sends them.
    const report = await checkSellable(rpcUrl, position.token, dex.v4PoolManager).catch(() => null);
    // Only a definite HONEYPOT counts. UNKNOWN means the check could not run,
    // and treating "I could not tell" as "get out now" would sell good
    // positions on an RPC hiccup.
    if (report && report.verdict === "HONEYPOT") sellable = false;
  }

  return {
    valueQuote,
    sellable,
    // The pool's OWN liquidity, from its slot in the PoolManager. Reading a
    // token balance would not work here: every V4 pool's tokens sit in the
    // same singleton, so a balance there is the sum of every pool on the
    // chain and says nothing about this one.
    poolQuote: state?.liquidity,
    poolQuoteAtEntry: opts.poolQuoteAtEntry,
  };
}

/**
 * Watch one position until it is closed or stopped.
 *
 * Returns a stop function. Never throws out of the loop -- an unhandled
 * rejection here would take the whole bot process down, and it would do it
 * while holding an open position.
 */
export function watchPosition(opts: WatchPositionOpts): () => void {
  let position = opts.position;
  let stopped = false;
  let tick = 0;
  const pollMs = opts.pollMs ?? DEFAULT_POSITION_POLL_MS;
  const sellEvery = opts.sellCheckEveryTicks ?? DEFAULT_SELL_CHECK_TICKS;
  // Captured once, at the start, because the rug check compares against what
  // the pool held when the position was opened.
  let poolQuoteAtEntry: bigint | undefined;

  const loop = async (): Promise<void> => {
    while (!stopped && position.tokensHeld > 0n) {
      try {
        const m = await readMarketState(opts.rpcUrl, opts.dex, opts.pool, position, {
          checkSell: tick % sellEvery === 0,
          poolQuoteAtEntry,
        });
        poolQuoteAtEntry ??= m.poolQuote;

        position = markPeak(position, m.valueQuote);
        opts.onUpdate?.(position, m);

        const decision = evaluatePosition(position, m);
        if (decision.reason !== "HOLD" && decision.sellTokens > 0n) {
          const result = await opts.sell(position, decision);
          position = applyExit(position, decision, result.receivedQuote);
          opts.onExit?.(position, decision, result.txHash);
        }
      } catch (err) {
        // One bad tick costs a tick. Anything else costs the position.
        opts.onError?.(err as Error);
      }
      tick++;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };

  void loop();
  return () => {
    stopped = true;
  };
}

/** One line for a chat, written for someone glancing at it. */
export function describePosition(p: Position, m: MarketState, dex: DexConfig): string {
  const pnl = positionPnL(p, m.valueQuote);
  const q = (v: bigint) => `${Number(formatUnits(v, dex.quoteDecimals)).toFixed(2)} ${dex.quoteSymbol}`;
  const multiple = p.costQuote > 0n ? Number((p.peakQuote * 100n) / p.costQuote) / 100 : 0;
  return [
    `${p.token.slice(0, 10)}… ${pnl.netQuote >= 0n ? "+" : ""}${q(pnl.netQuote)}`,
    `cost ${q(p.costQuote)} · out ${q(pnl.realisedQuote)} · held ${q(pnl.unrealisedQuote)}`,
    `peak ${multiple.toFixed(2)}x${pnl.stakeRecovered ? " · stake recovered" : ""}`,
  ].join(String.fromCharCode(10));
}
