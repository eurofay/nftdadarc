import { describe, it, expect, afterEach } from "vitest";
import { createProvider, clearProviderCache, backoffMs, DEFAULT_RPC_TIMEOUT_MS } from "./rpc-provider";
import { scanPublicDropUpdates } from "./seadrop-events";
import { startMockRpc, MockRpc } from "./test-support/mock-rpc";

let mock: MockRpc | undefined;

afterEach(async () => {
  clearProviderCache();
  await mock?.close();
  mock = undefined;
});

describe("createProvider", () => {
  it("sets a bounded timeout instead of ethers' 300s default", () => {
    const provider = createProvider("http://127.0.0.1:1");
    expect((provider as any)._getConnection().timeout).toBe(DEFAULT_RPC_TIMEOUT_MS);
    expect(DEFAULT_RPC_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it("honors a custom timeout when given one", () => {
    const provider = createProvider("http://127.0.0.1:1", 3_000);
    expect((provider as any)._getConnection().timeout).toBe(3_000);
  });

  it("preserves the URL", () => {
    const provider = createProvider("http://127.0.0.1:1");
    expect((provider as any)._getConnection().url).toBe("http://127.0.0.1:1");
  });

  it("returns the same instance for the same URL, and a distinct one per URL/timeout", () => {
    const a = createProvider("http://127.0.0.1:1");
    const b = createProvider("http://127.0.0.1:1");
    expect(a).toBe(b);

    expect(createProvider("http://127.0.0.1:2")).not.toBe(a);
    expect(createProvider("http://127.0.0.1:1", 5_000)).not.toBe(a);
  });

  it("hands out a fresh instance after the cache is cleared", () => {
    const before = createProvider("http://127.0.0.1:1");
    clearProviderCache();
    expect(createProvider("http://127.0.0.1:1")).not.toBe(before);
  });

  it("detects the network once across repeated scans, not once per call", async () => {
    // Regression guard for the real cost this caching fixes: every poll tick
    // used to build a new provider, and every new provider ran its own
    // eth_chainId detection before it could serve anything.
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getLogs: () => [],
    });

    for (let i = 0; i < 5; i++) {
      await scanPublicDropUpdates(mock.url, 1, 5);
    }

    const chainIdCalls = mock.calls.filter((c) => c.method === "eth_chainId").length;
    expect(chainIdCalls).toBe(1);
  });
});

describe("backoffMs", () => {
  it("returns the base interval while nothing is failing", () => {
    expect(backoffMs(4000, 0)).toBe(4000);
    expect(backoffMs(4000, -1)).toBe(4000);
  });

  it("grows exponentially with consecutive failures", () => {
    expect(backoffMs(1000, 1)).toBe(2000);
    expect(backoffMs(1000, 2)).toBe(4000);
    expect(backoffMs(1000, 3)).toBe(8000);
  });

  it("caps so a long outage still recovers promptly once the RPC returns", () => {
    expect(backoffMs(4000, 99)).toBe(60_000);
    expect(backoffMs(1_000_000, 1)).toBe(60_000);
  });
});
