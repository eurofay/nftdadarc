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

// Providers are cached per URL because several call sites (the log/block
// scanners, every buildLocalMintPlan) construct one on *every* poll tick.
// Each fresh JsonRpcProvider must run its own eth_chainId network detection
// before it can serve a single request, so recreating them meant a wasted
// detection call every few seconds per watcher — and when that detection
// failed, ethers' own "failed to detect network... retry in 1s" loop on top.
// One cached provider per endpoint detects once and reuses it.
const providerCache = new Map<string, JsonRpcProvider>();

export function createProvider(url: string, timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS): JsonRpcProvider {
  const cacheKey = `${timeoutMs}|${url}`;
  const cached = providerCache.get(cacheKey);
  if (cached) return cached;

  const request = new FetchRequest(url);
  request.timeout = timeoutMs;
  // staticNetwork: true = detect the network once, then never re-detect. The
  // chain behind a given URL doesn't change under us, so re-detecting is pure
  // overhead (and a failure path) on every reconnect.
  const provider = new JsonRpcProvider(request, undefined, { staticNetwork: true });
  providerCache.set(cacheKey, provider);
  return provider;
}

// Tests point successive mock servers at freshly-assigned ports; clearing
// keeps a dead endpoint from being reused if a port ever repeats.
export function clearProviderCache(): void {
  for (const provider of providerCache.values()) provider.destroy();
  providerCache.clear();
}

// Ethers wraps a provider error together with the entire request payload.
// For a topic-filtered getLogs that payload includes every watched address,
// so one failure logs ~1500 characters of noise to say "Internal error".
// This digs out the part that actually identifies the problem.
export function describeRpcError(err: unknown): string {
  const e = err as any;

  // The node's own message, where ethers preserved it.
  const inner = e?.error?.message ?? e?.info?.error?.message;
  if (typeof inner === "string" && inner.trim()) return inner.trim();

  // Otherwise ethers' own summary, minus its parenthesised payload dump.
  const raw = typeof e?.shortMessage === "string" && e.shortMessage.trim()
    ? e.shortMessage
    : e?.message ?? String(err);

  return String(raw).split(" (")[0].trim().slice(0, 200);
}

// Poll loops must never die on a transient RPC failure, but they also
// shouldn't hammer a struggling endpoint every tick. Backs off exponentially
// while failures persist, capped so recovery stays quick once it returns.
export function backoffMs(baseMs: number, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return baseMs;
  return Math.min(baseMs * 2 ** Math.min(consecutiveFailures, 5), 60_000);
}
