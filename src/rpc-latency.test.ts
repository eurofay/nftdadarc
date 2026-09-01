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
    { url: "a", label: "sequencer (origin)", medianMs: 40, bestMs: 35, canRead: false, logRange: 0 },
    { url: "b", label: "public rpc (cloudflare)", medianMs: 320, bestMs: 290, canRead: true, logRange: 10000 },
    { url: "c", label: "dead", medianMs: null, bestMs: null, error: "timeout" },
  ];

  it("expresses latency in blocks, which is the unit that decides a race", () => {
    const out = renderLatency(samples, 0.1); // 100ms blocks
    expect(out).toContain("0.4 block(s)");
    expect(out).toContain("3.2 block(s)");
  });

  it("never sends reads to an endpoint that can't scan, however fast it is", () => {
    // The regression this exists for: ranking on latency alone recommended a
    // free-tier endpoint capped at 10-block getLogs, which blinds copy mint.
    const fastButBlind: LatencySample[] = [
      { url: "a", label: "alchemy", medianMs: 15, bestMs: 12, canRead: true, logRange: 10 },
      { url: "b", label: "public rpc", medianMs: 320, bestMs: 290, canRead: true, logRange: 10000 },
    ];
    const out = renderLatency(fastButBlind, 0.1);
    expect(out).toContain("Reads → public rpc");
    expect(out).not.toContain("Reads → alchemy");
    // The fast one is still worth naming — it just isn't the read endpoint.
    expect(out).toContain("Closest overall: alchemy");
  });

  it("marks a send-only endpoint rather than offering it for reads", () => {
    const out = renderLatency(samples, 0.1);
    expect(out).toContain("send-only");
    expect(out).toContain("Reads → public rpc (cloudflare)");
  });

  it("warns when nothing can scan, instead of picking the least-bad", () => {
    const out = renderLatency(
      [{ url: "a", label: "alchemy", medianMs: 15, bestMs: 12, canRead: true, logRange: 10 }],
      0.1
    );
    expect(out).toMatch(/can't see new mints/);
  });

  it("shows the scan width, so the tradeoff is visible", () => {
    expect(renderLatency(samples, 0.1)).toContain("scans 10k blocks/call");
  });

  it("reports a dead endpoint instead of dropping it silently", () => {
    expect(renderLatency(samples, 0.1)).toContain("dead — timeout");
  });

  it("scales to a slow chain too", () => {
    expect(renderLatency([samples[1]], 12.12)).toContain("0.0 block(s)");
  });
});
