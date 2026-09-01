// Keeping the RPC connections hot, so firing costs one round trip and not three.
//
// A signed transaction is useless if the socket carrying it has to be built
// first. Measured against the Robinhood sequencer:
//
//   cold connection  ~765ms   (TCP handshake + TLS handshake + request)
//   warm connection  ~245ms   (request only)
//
// Three round trips instead of one. On a chain producing a block every 100ms
// that is two blocks handed to whoever kept their socket open.
//
// Warming once before the wait is not enough: Node's fetch closes an idle
// keep-alive connection after a few seconds, and a scheduled mint waits for
// hours. By fire time every connection is cold again. So the pool is kept
// alive by pinging it — often enough that it never idles out — through the
// window that matters.

import { Logger, defaultLogger } from "./logger";

/** Below Node's ~4s idle keep-alive timeout, with room to spare. */
export const WARM_PING_MS = 3_000;

/**
 * How long before the target to start holding connections open.
 *
 * Pinging for the whole wait would mean thousands of pointless requests to
 * someone else's node. Only the last stretch decides the race.
 */
export const HOT_WINDOW_MS = 120_000;

/**
 * A ping that every endpoint accepts, including send-only ones.
 *
 * The sequencer answers no read methods at all — eth_chainId is rejected —
 * so the ping has to be a transaction submission. "0x00" is not a decodable
 * transaction, so it is refused at parse time and never enters a mempool.
 */
const PING_BODY = JSON.stringify({
  jsonrpc: "2.0",
  method: "eth_sendRawTransaction",
  params: ["0x00"],
  id: 1,
});

async function ping(url: string): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: PING_BODY,
    });
    await res.arrayBuffer(); // drain, or the connection isn't returned to the pool
  } catch {
    /* an endpoint that's down now may be up at fire time; keep trying */
  }
}

/** One warming pass over every endpoint, in parallel. */
export async function warmConnections(rpcUrls: string[], logger: Logger = defaultLogger): Promise<void> {
  logger.info("  Warming connections...");
  await Promise.all(rpcUrls.map(ping));
  logger.success("  Connections hot.");
}

/** Whether the keeper should be pinging yet, given how far off the target is. */
export function shouldPing(msUntilTarget: number, hotWindowMs = HOT_WINDOW_MS): boolean {
  return msUntilTarget <= hotWindowMs;
}

/**
 * Hold connections open through the run-up to `targetMs`.
 *
 * Returns a stop function. Safe to call with a target in the past or with no
 * target at all — it simply does nothing, which is correct for an immediate
 * fire where the connections were warmed moments ago.
 */
export function startWarmKeeper(
  rpcUrls: string[],
  targetMs: number | null,
  opts: { pingMs?: number; hotWindowMs?: number; now?: () => number } = {}
): () => void {
  if (targetMs === null) return () => {};
  const pingMs = opts.pingMs ?? WARM_PING_MS;
  const hotWindowMs = opts.hotWindowMs ?? HOT_WINDOW_MS;
  const now = opts.now ?? Date.now;

  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const remaining = targetMs - now();
    // Past the target: the mint has fired or is firing, and the pool is in use.
    if (remaining < 0) return;
    if (!shouldPing(remaining, hotWindowMs)) return;
    for (const url of rpcUrls) void ping(url);
  }, pingMs);

  // Never hold the process open on account of a warmer.
  if (typeof timer.unref === "function") timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
