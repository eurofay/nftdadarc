// A JsonRpcProvider constructed from a bare URL string inherits ethers'
// undocumented default request timeout: 300 seconds. A single stuck request
// on a flaky endpoint can silently hang that long before the caller's own
// retry/error handling ever gets a chance to run — on a poll loop with a
// pollIntervalMs of a few seconds, that looks like the watcher going dark
// for minutes at a time, not "retrying next tick" the way its own logs claim.
//
// Every JsonRpcProvider in this repo should be built through here instead of
// `new JsonRpcProvider(url)` directly, so a bad endpoint fails fast and the
// existing retry logic actually gets to do its job.

import { FetchRequest, JsonRpcProvider } from "ethers";

// Generous enough for genuinely heavy reads (eth_getBlockByNumber with full
// transactions on a busy chain, eth_getLogs against a rate-limited free tier)
// while still being ~10x tighter than ethers' 300s default. Too low and a
// slow-but-working endpoint produces constant spurious failures; too high and
// a dead one stalls the poll loop. Override with RPC_TIMEOUT_MS.
export const DEFAULT_RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS) || 30_000;

export function createProvider(url: string, timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS): JsonRpcProvider {
  const request = new FetchRequest(url);
  request.timeout = timeoutMs;
  return new JsonRpcProvider(request);
}

// Poll loops must never die on a transient RPC failure, but they also
// shouldn't hammer a struggling endpoint every tick. Backs off exponentially
// while failures persist, capped so recovery stays quick once it returns.
export function backoffMs(baseMs: number, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return baseMs;
  return Math.min(baseMs * 2 ** Math.min(consecutiveFailures, 5), 60_000);
}
