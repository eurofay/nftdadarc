// Measuring how far the bot actually is from each RPC endpoint.
//
// In a contested mint on a chain with ~100ms blocks, round-trip time is the
// dominant term — far more than anything the signing path can save. It is
// also the one number that cannot be reasoned about from a laptop: what
// matters is the latency from wherever the bot is deployed, which is why
// this measures from inside the running process.

import { performance } from "perf_hooks";

export interface LatencySample {
  url: string;
  label: string;
  medianMs: number | null;
  bestMs: number | null;
  error?: string;
  /** Answers reads at all (the sequencer does not — it only takes txs). */
  canRead?: boolean;
  /** Widest eth_getLogs range it accepted, 0 if it refuses them. */
  logRange?: number;
}

/** Short, recognisable name for an endpoint. */
export function labelEndpoint(url: string): string {
  const u = url.toLowerCase();
  if (u.includes("sequencer")) return "sequencer (origin)";
  if (u.includes("alchemy")) return "alchemy";
  if (u.includes("rpc.mainnet.chain.robinhood")) return "public rpc (cloudflare)";
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 30);
  }
}

const BODY = JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 });

async function once(url: string, timeoutMs: number): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: BODY,
      signal: controller.signal,
    });
    await res.arrayBuffer(); // drain, so the timing covers the whole exchange
    return performance.now() - t0;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Can this endpoint serve the reads the watchers depend on?
 *
 * Latency alone is a trap: the fastest endpoint here is often a free-tier
 * provider that caps eth_getLogs at 10 blocks, and the copy watcher scans
 * thousands. Ranking on speed alone would recommend making the bot blind.
 */
export async function probeCapability(
  url: string,
  timeoutMs = 10_000
): Promise<{ canRead: boolean; logRange: number }> {
  const call = async (method: string, params: unknown[]) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
        signal: controller.signal,
      });
      return (await res.json()) as any;
    } finally {
      clearTimeout(timer);
    }
  };

  let head: number;
  try {
    const res = await call("eth_blockNumber", []);
    if (res?.error || !res?.result) return { canRead: false, logRange: 0 };
    head = parseInt(res.result, 16);
  } catch {
    return { canRead: false, logRange: 0 };
  }

  // Widest first: the answer we want is the largest range that works, and the
  // common failure is an explicit "range too large" rather than a timeout.
  for (const range of [10_000, 2_000, 500, 100, 10]) {
    try {
      const res = await call("eth_getLogs", [
        {
          fromBlock: `0x${Math.max(0, head - range).toString(16)}`,
          toBlock: `0x${head.toString(16)}`,
          address: "0x00005ea00ac477b1030ce78506496e8c2de24bf5",
        },
      ]);
      if (!res?.error) return { canRead: true, logRange: range };
    } catch {
      /* try a narrower range */
    }
  }
  return { canRead: true, logRange: 0 };
}

/**
 * Sequential samples per endpoint — concurrent ones would contend for the
 * same socket pool and measure the pool rather than the network.
 */
export async function measureLatency(
  urls: string[],
  samples = 5,
  timeoutMs = 8000
): Promise<LatencySample[]> {
  const out: LatencySample[] = [];
  for (const url of urls) {
    const times: number[] = [];
    let error: string | undefined;
    for (let i = 0; i < samples; i++) {
      try {
        times.push(await once(url, timeoutMs));
      } catch (err: any) {
        error = err?.name === "AbortError" ? "timeout" : err?.message ?? String(err);
        break;
      }
    }
    times.sort((a, b) => a - b);
    out.push({
      url,
      label: labelEndpoint(url),
      medianMs: times.length ? times[Math.floor(times.length / 2)] : null,
      bestMs: times.length ? times[0] : null,
      error,
    });
  }
  return out;
}

/**
 * Report, with the interpretation that matters: on a 100ms-block chain a
 * round trip is measured in blocks, not milliseconds.
 */
export function renderLatency(samples: LatencySample[], blockSeconds: number): string {
  const lines = ["📡 Round-trip from the bot to each endpoint:", ""];
  const blockMs = blockSeconds * 1000;

  for (const s of samples) {
    if (s.medianMs === null) {
      lines.push(`  ${s.label} — ${s.error ?? "no response"}`);
      continue;
    }
    const role =
      s.canRead === false
        ? " · send-only"
        : s.logRange !== undefined
          ? ` · scans ${s.logRange >= 1000 ? `${s.logRange / 1000}k` : s.logRange} blocks/call`
          : "";
    const blocks = s.medianMs / blockMs;
    lines.push(
      `  ${s.label}${role}\n     median ${s.medianMs.toFixed(0)}ms · best ${s.bestMs!.toFixed(0)}ms · ${blocks.toFixed(1)} block(s)`
    );
  }

  const answered = samples.filter((s) => s.medianMs !== null);
  // The read endpoint must be able to SCAN, not merely be quick. Ranking on
  // latency alone once recommended a free-tier endpoint capped at 10-block
  // getLogs, which would have made the copy watcher blind.
  const readable = answered
    .filter((s) => s.canRead !== false && (s.logRange ?? 0) >= 1000)
    .sort((a, b) => a.medianMs! - b.medianMs!)[0];
  const closest = answered.slice().sort((a, b) => a.medianMs! - b.medianMs!)[0];

  lines.push("");
  if (readable) {
    lines.push(`Reads → ${readable.label} — put it first in RPC_URL_<CHAIN>. Fastest that can still scan wide ranges.`);
  } else if (answered.length > 0) {
    lines.push("⚠ No endpoint here serves wide log scans — copy mint can't see new mints.");
  }
  if (closest && closest !== readable) {
    lines.push(`Closest overall: ${closest.label} at ${closest.medianMs!.toFixed(0)}ms, but it isn't the read endpoint.`);
  }
  lines.push("Order only decides reads — every endpoint is blasted in parallel when a mint fires.");
  return lines.join("\n");
}
