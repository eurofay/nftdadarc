import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { maskRpc, privateRpcsFromEnv, resolveRpcsForChain, toRpcUrl } from "./rpc-resolver";

const ENV_KEYS = ["RPC_URL_BASE", "RPC_URL_ETHEREUM", "RPC_URL", "EXTRA_RPC_URLS", "CHAIN"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("toRpcUrl", () => {
  it("passes through a well-formed URL unchanged", () => {
    expect(toRpcUrl("https://example.com/v2/abc", "base")).toBe("https://example.com/v2/abc");
  });

  it("rejects a malformed URL", () => {
    expect(toRpcUrl("https://", "base")).toBeNull();
  });

  it("expands a bare Alchemy key against the chain's host", () => {
    expect(toRpcUrl("aBcDeFgHiJkLmNoPqRsT12", "base")).toBe(
      "https://base-mainnet.g.alchemy.com/v2/aBcDeFgHiJkLmNoPqRsT12"
    );
  });

  it("rejects a bare key when the chain has no known Alchemy host", () => {
    expect(toRpcUrl("aBcDeFgHiJkLmNoPqRsT12", "unknown-chain")).toBeNull();
  });

  it("rejects a value that is neither a URL nor a plausible key", () => {
    expect(toRpcUrl("short", "base")).toBeNull();
    expect(toRpcUrl("", "base")).toBeNull();
  });
});

describe("maskRpc", () => {
  it("masks the last path segment of a keyed URL", () => {
    expect(maskRpc("https://base-mainnet.g.alchemy.com/v2/abcdefgh12345678")).toBe(
      "https://base-mainnet.g.alchemy.com/v2/abcd…5678"
    );
  });

  it("leaves a short final segment as an ellipsis rather than leaking it", () => {
    expect(maskRpc("https://example.com/v2/short")).toBe("https://example.com/v2/…");
  });

  it("returns just the origin when there is no path", () => {
    expect(maskRpc("https://mainnet.base.org")).toBe("https://mainnet.base.org");
  });

  it("returns the raw input unchanged if it isn't a valid URL", () => {
    expect(maskRpc("not a url")).toBe("not a url");
  });
});

describe("privateRpcsFromEnv", () => {
  it("returns nothing for an unknown chain", () => {
    expect(privateRpcsFromEnv("not-a-chain")).toEqual([]);
  });

  it("prefers the per-chain RPC_URL_<CHAIN> entry", () => {
    process.env.RPC_URL_BASE = "https://a.example.com, https://b.example.com";
    process.env.RPC_URL = "https://generic.example.com";
    expect(privateRpcsFromEnv("base")).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("uses the generic RPC_URL only when CHAIN matches", () => {
    process.env.CHAIN = "base";
    process.env.RPC_URL = "https://generic.example.com";
    expect(privateRpcsFromEnv("base")).toEqual(["https://generic.example.com"]);
    expect(privateRpcsFromEnv("ethereum")).toEqual([]);
  });

  it("salvages a generic RPC_URL by hostname when CHAIN is unset", () => {
    process.env.RPC_URL = "https://base-mainnet.g.alchemy.com/v2/somekey";
    expect(privateRpcsFromEnv("base")).toEqual(["https://base-mainnet.g.alchemy.com/v2/somekey"]);
    expect(privateRpcsFromEnv("ethereum")).toEqual([]);
  });

  it("returns nothing when nothing in env matches the chain", () => {
    process.env.RPC_URL = "https://base-mainnet.g.alchemy.com/v2/somekey";
    expect(privateRpcsFromEnv("robinhood")).toEqual([]);
  });

  it("trusts an explicit CHAIN pin over hostname, even if the host looks like another chain", () => {
    process.env.RPC_URL = "https://base-mainnet.g.alchemy.com/v2/somekey";
    process.env.CHAIN = "ethereum";
    expect(privateRpcsFromEnv("ethereum")).toEqual(["https://base-mainnet.g.alchemy.com/v2/somekey"]);
  });
});

describe("resolveRpcsForChain", () => {
  it("throws for an unknown chain", () => {
    expect(() => resolveRpcsForChain("not-a-chain")).toThrow();
  });

  it("puts manual entries first, followed by public fallbacks", () => {
    const { urls, source } = resolveRpcsForChain("base", ["https://manual.example.com"]);
    expect(urls[0]).toBe("https://manual.example.com");
    expect(urls).toContain("https://mainnet.base.org");
    expect(source).toMatch(/entered above/);
  });

  it("falls back to .env entries when nothing is entered manually", () => {
    process.env.RPC_URL_BASE = "https://env.example.com";
    const { urls, source } = resolveRpcsForChain("base");
    expect(urls[0]).toBe("https://env.example.com");
    expect(source).toMatch(/\.env/);
  });

  it("falls back to public endpoints only when nothing else is configured", () => {
    const { urls, source } = resolveRpcsForChain("base");
    expect(urls).toEqual(expect.arrayContaining(["https://mainnet.base.org"]));
    expect(source).toMatch(/public endpoints only/);
  });

  it("dedupes repeated URLs", () => {
    const { urls } = resolveRpcsForChain("base", ["https://mainnet.base.org"]);
    expect(urls.filter((u) => u === "https://mainnet.base.org")).toHaveLength(1);
  });
});
