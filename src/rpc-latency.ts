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
    const blocks = s.medianMs / blockMs;
    lines.push(
      `  ${s.label}\n     median ${s.medianMs.toFixed(0)}ms · best ${s.bestMs!.toFixed(0)}ms · ${blocks.toFixed(1)} block(s)`
    );
  }
  const best = samples.filter((s) => s.medianMs !== null).sort((a, b) => a.medianMs! - b.medianMs!)[0];
  if (best) {
    lines.push("", `Fastest: ${best.label}. Put it first in RPC_URL_<CHAIN> — the first entry is used for reads.`);
    lines.push("Every endpoint is blasted in parallel at fire time, so extra ones cost nothing but add coverage.");
  }
  return lines.join("\n");
}
