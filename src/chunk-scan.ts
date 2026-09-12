// Walking a block range in parallel instead of one chunk at a time.
//
// Both log scans were a for-loop with an await in it, which means the next
// request waits for the previous round trip to finish even though the two are
// completely independent. Measured against Robinhood's public RPC:
//
//   6 chunks of 10,000, sequential   2,466ms
//   6 chunks of 10,000, concurrent     695ms   3.5x
//
// The ceiling is not CPU, it is the endpoint's patience. Public nodes
// rate-limit sustained eth_getLogs -- measured elsewhere in this repo at five
// back-to-back calls succeeding and fifteen not -- so this runs a bounded
// number at a time rather than firing the whole range at once and being
// throttled into a slower result than the sequential version.

export interface Range {
  from: number;
  to: number;
}

/**
 * Split a span into chunks, newest first.
 *
 * Newest-first matters when a scan is capped: stopping early having read the
 * most recent blocks is a better answer than stopping having read the oldest.
 */
export function chunksOf(fromBlock: number, toBlock: number, chunkBlocks: number): Range[] {
  const size = Math.max(1, Math.floor(chunkBlocks));
  const out: Range[] = [];
  for (let to = toBlock; to >= fromBlock; to -= size) {
    out.push({ from: Math.max(fromBlock, to - size + 1), to });
  }
  return out;
}

/**
 * How many requests to have in flight.
 *
 * Three rather than the whole range: the gain from parallelism is steep at
 * first and flat after, while the risk of being throttled keeps climbing.
 * Six was measured at 3.5x over serial in a burst, but sustained at that rate
 * the endpoint started refusing chunks. Three keeps most of the gain with
 * headroom for the rest of the bot sharing the same endpoint.
 */
export const DEFAULT_CONCURRENCY = 3;

/**
 * Attempts per chunk.
 *
 * Public nodes throttle sustained eth_getLogs, and running chunks in parallel
 * reaches that threshold far sooner than running them one at a time. Without
 * retries the first parallel version came back with 2,362 mints where the
 * sequential one found 6,441 -- a third of the data, no error, and a ranking
 * built on it that looked perfectly normal.
 */
export const DEFAULT_RETRIES = 3;

/** Ethers caches an identical request for ~250ms; a retry must outlast that. */
export const RETRY_FLOOR_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RunOpts {
  concurrency?: number;
  /** Attempts per chunk before giving up on it. */
  retries?: number;
  /** Stop starting new chunks once this many results are in hand. */
  maxResults?: number;
  onProgress?: (done: number, total: number, found: number) => void;
  shouldStop?: () => boolean;
}

/**
 * Run `fn` over every chunk, a few at a time, and concatenate what comes back.
 *
 * Results stay in chunk order regardless of which request finishes first --
 * an ordering that varies run to run would make a "first N" cap return
 * different data each time.
 */
export async function runChunks<T>(
  ranges: Range[],
  fn: (range: Range) => Promise<T[]>,
  opts: RunOpts = {}
): Promise<{ results: T[]; failed: number }> {
  const limit = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const attempts = Math.max(1, opts.retries ?? DEFAULT_RETRIES);
  const cap = opts.maxResults ?? Infinity;
  const results: T[][] = new Array(ranges.length);
  let next = 0;
  let done = 0;
  let found = 0;
  let failed = 0;
  let stopped = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped || opts.shouldStop?.()) return;
      const i = next++;
      if (i >= ranges.length) return;

      let got: T[] | null = null;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          got = await fn(ranges[i]);
          break;
        } catch {
          if (attempt >= attempts) break;
          // Backoff, and it has to clear ethers' ~250ms request cache or the
          // retry is handed the same failure without touching the network.
          await sleep(RETRY_FLOOR_MS * attempt * attempt);
        }
      }

      if (got === null) {
        // Counted, not hidden. A swallowed chunk is missing data in a ranking
        // that looks complete -- the first version of this returned a third of
        // the mints the sequential scan found and said nothing about it.
        results[i] = [];
        failed++;
      } else {
        results[i] = got;
        found += got.length;
      }

      done++;
      opts.onProgress?.(done, ranges.length, found);
      if (found >= cap) stopped = true;
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, ranges.length) }, worker));

  const out: T[] = [];
  for (const part of results) if (part) out.push(...part);
  return { results: out, failed };
}
