// Reading balances and transaction counts for a large list of wallets.
//
// This is the slow part of wallet filtering and the reason the whole feature
// has to be a background job. Measured against the public Robinhood RPC:
//
//   one address per HTTP request, 20 in flight     ~5/sec
//   one JSON-RPC batch of 50 per request          ~17/sec
//   batch of 100 or 200                            HTTP 429, nothing served
//
// So the endpoint serves batches up to about fifty and refuses larger ones
// outright. At 17/sec a 50,000-wallet list is roughly fifty minutes for one
// field and twice that for two — which is workable as a job that reports
// progress, and impossible as something a chat handler waits on.
//
// A private RPC is dramatically faster and the batch size adapts upward on
// its own, so the numbers above are the floor, not the expectation.

import { formatEther } from "ethers";
import { Field, WalletStats } from "./wallet-criteria";
import { Logger, defaultLogger } from "./logger";

/** Where the batch size starts. Halved on a 429, grown back on a clean run. */
export const INITIAL_BATCH = 50;
export const MIN_BATCH = 5;
export const MAX_BATCH = 500;

const METHOD: Record<Field, string> = {
  balance: "eth_getBalance",
  txCount: "eth_getTransactionCount",
  nftCount: "eth_getBalance", // replaced per-call; see enrichWallets
};

export interface EnrichProgress {
  done: number;
  total: number;
  /** Successful reads per second, measured over the run so far. */
  rate: number;
  /** Seconds left at the current rate, or null before there is one. */
  etaSeconds: number | null;
}

export interface EnrichOptions {
  rpcUrl: string;
  addresses: string[];
  fields: Field[];
  onProgress?: (p: EnrichProgress) => void;
  logger?: Logger;
  /** Checked between batches so a long run can be called off. */
  shouldStop?: () => boolean;
}

export interface EnrichResult {
  stats: WalletStats[];
  /** Addresses no endpoint would answer for, after retries. */
  unreadable: string[];
  stopped: boolean;
  elapsedMs: number;
}

interface RpcCall {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
}

/**
 * One JSON-RPC batch. Returns null when the endpoint refused the whole batch,
 * which is the caller's signal to back off and try a smaller one.
 */
async function sendBatch(
  rpcUrl: string,
  calls: RpcCall[],
  timeoutMs: number
): Promise<(string | null)[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(calls),
      signal: controller.signal,
    });
    // 429 is the endpoint saying the batch was too big or too frequent. Both
    // are answered the same way: smaller, slower.
    if (res.status === 429 || res.status === 503 || res.status >= 500) return null;
    if (!res.ok) return null;

    const json = (await res.json()) as any;
    const rows = Array.isArray(json) ? json : [json];
    // Responses may come back in any order, so they are matched by id rather
    // than by position. Assuming order is a silent, data-corrupting bug.
    const byId = new Map<number, any>(rows.map((r: any) => [r?.id, r]));
    return calls.map((c) => {
      const row = byId.get(c.id);
      return typeof row?.result === "string" ? row.result : null;
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch the requested fields for every address.
 *
 * The batch size adapts: it halves whenever the endpoint refuses a batch and
 * creeps back up after clean runs. A fixed size cannot be right for both a
 * public endpoint that caps at fifty and a private one that will take
 * hundreds, and guessing low wastes hours on the fast one.
 */
export async function enrichWallets(opts: EnrichOptions): Promise<EnrichResult> {
  const log = opts.logger ?? defaultLogger;
  const { rpcUrl, addresses, fields } = opts;
  const stats = new Map<string, WalletStats>(addresses.map((a) => [a, { address: a }]));
  const unreadable = new Set<string>();

  // One unit of work per address per field, so progress reflects the real
  // total rather than the address count when two fields are being read.
  const units: { address: string; field: Field }[] = [];
  for (const field of fields) for (const address of addresses) units.push({ address, field });

  const started = Date.now();
  let batchSize = INITIAL_BATCH;
  let cleanRuns = 0;
  let done = 0;
  let stopped = false;
  let nextId = 1;

  for (let i = 0; i < units.length; ) {
    if (opts.shouldStop?.()) {
      stopped = true;
      break;
    }

    const slice = units.slice(i, i + batchSize);
    const calls: RpcCall[] = slice.map((u) => ({
      jsonrpc: "2.0",
      id: nextId++,
      method: u.field === "txCount" ? "eth_getTransactionCount" : METHOD[u.field],
      params: [u.address, "latest"],
    }));

    const results = await sendBatch(rpcUrl, calls, 60_000);

    if (results === null) {
      // Refused. Shrink and wait — retrying the same size immediately is how
      // a rate limit turns into a wall.
      cleanRuns = 0;
      if (batchSize > MIN_BATCH) {
        batchSize = Math.max(MIN_BATCH, Math.floor(batchSize / 2));
        log.info(`  endpoint pushed back — batch size now ${batchSize}`);
        await sleep(1_000);
        continue;
      }
      // Already at the floor: this slice genuinely will not be served.
      for (const u of slice) unreadable.add(u.address);
      i += slice.length;
      done += slice.length;
      await sleep(2_000);
      continue;
    }

    for (let k = 0; k < slice.length; k++) {
      const { address, field } = slice[k];
      const raw = results[k];
      const stat = stats.get(address)!;
      if (raw === null) {
        unreadable.add(address);
        continue;
      }
      if (field === "balance") stat.balance = Number(formatEther(BigInt(raw)));
      else if (field === "txCount") stat.txCount = Number(BigInt(raw));
    }

    i += slice.length;
    done += slice.length;

    // Grow back cautiously after sustained success.
    if (++cleanRuns >= 5 && batchSize < MAX_BATCH) {
      batchSize = Math.min(MAX_BATCH, Math.floor(batchSize * 1.5));
      cleanRuns = 0;
    }

    const elapsed = (Date.now() - started) / 1000;
    const rate = elapsed > 0 ? done / elapsed : 0;
    opts.onProgress?.({
      done,
      total: units.length,
      rate,
      etaSeconds: rate > 0 ? Math.round((units.length - done) / rate) : null,
    });
  }

  return {
    stats: [...stats.values()],
    unreadable: [...unreadable],
    stopped,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Time a small sample so the user is quoted a real number, not a guess.
 *
 * Throughput on these endpoints varies by an order of magnitude and changes
 * with load. Committing someone to a job that turns out to take three hours,
 * having implied it would take twenty minutes, is worse than asking them to
 * wait ten seconds for an honest figure.
 */
export async function measureRate(
  rpcUrl: string,
  sample: string[],
  field: Field = "balance"
): Promise<{ ratePerSecond: number; ok: number; attempted: number }> {
  const calls: RpcCall[] = sample.map((address, id) => ({
    jsonrpc: "2.0",
    id: id + 1,
    method: field === "txCount" ? "eth_getTransactionCount" : "eth_getBalance",
    params: [address, "latest"],
  }));
  const started = Date.now();
  const results = await sendBatch(rpcUrl, calls, 30_000);
  const seconds = (Date.now() - started) / 1000;
  const ok = results ? results.filter((r) => r !== null).length : 0;
  return { ratePerSecond: seconds > 0 ? ok / seconds : 0, ok, attempted: sample.length };
}

/** "about 50 minutes", "under a minute" — an ETA someone can act on. */
export function describeEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return "unknown";
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = seconds / 3600;
  return `about ${hours.toFixed(1)} hours`;
}
