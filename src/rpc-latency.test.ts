import { describe, it, expect } from "vitest";
import { labelEndpoint, renderLatency, LatencySample } from "./rpc-latency";

describe("labelEndpoint", () => {
  it("names the endpoints that matter distinctly", () => {
    expect(labelEndpoint("https://sequencer.mainnet.chain.robinhood.com")).toBe("sequencer (origin)");
    expect(labelEndpoint("https://rpc.mainnet.chain.robinhood.com")).toBe("public rpc (cloudflare)");
    expect(labelEndpoint("https://robinhood-mainnet.g.alchemy.com/v2/abc")).toBe("alchemy");
  });

  it("falls back to the hostname, and doesn't leak an api key", () => {
    expect(labelEndpoint("https://example.com/v2/secret-key")).toBe("example.com");
  });

  it("survives a malformed url", () => {
    expect(labelEndpoint("not a url")).toBe("not a url");
  });
});

describe("renderLatency", () => {
  const samples: LatencySample[] = [
    { url: "a", label: "sequencer (origin)", medianMs: 40, bestMs: 35 },
    { url: "b", label: "public rpc (cloudflare)", medianMs: 320, bestMs: 290 },
    { url: "c", label: "dead", medianMs: null, bestMs: null, error: "timeout" },
  ];

  it("expresses latency in blocks, which is the unit that decides a race", () => {
    const out = renderLatency(samples, 0.1); // 100ms blocks
    expect(out).toContain("0.4 block(s)");
    expect(out).toContain("3.2 block(s)");
  });

  it("names the fastest endpoint and what to do about it", () => {
    const out = renderLatency(samples, 0.1);
    expect(out).toContain("Fastest: sequencer (origin)");
    expect(out).toMatch(/RPC_URL_/);
  });

  it("reports a dead endpoint instead of dropping it silently", () => {
    expect(renderLatency(samples, 0.1)).toContain("dead — timeout");
  });

  it("scales to a slow chain too", () => {
    expect(renderLatency([samples[1]], 12.12)).toContain("0.0 block(s)");
  });
});
