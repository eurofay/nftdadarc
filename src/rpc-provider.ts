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

export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

export function createProvider(url: string, timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS): JsonRpcProvider {
  const request = new FetchRequest(url);
  request.timeout = timeoutMs;
  return new JsonRpcProvider(request);
}
