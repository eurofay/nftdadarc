import { describe, it, expect } from "vitest";
import { createProvider, DEFAULT_RPC_TIMEOUT_MS } from "./rpc-provider";

describe("createProvider", () => {
  it("sets a fast default timeout instead of ethers' 300s default", () => {
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
});
