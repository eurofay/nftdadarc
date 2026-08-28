import { describe, it, expect } from "vitest";
import { explorerTx, resolveChain, logChunkBlocksFor } from "./chains";

describe("resolveChain", () => {
  it("resolves by string key, case-insensitively", () => {
    expect(resolveChain("base")?.chainId).toBe(8453);
    expect(resolveChain("BASE")?.chainId).toBe(8453);
    expect(resolveChain(" Base ")?.chainId).toBe(8453);
  });

  it("resolves by numeric chain id", () => {
    expect(resolveChain(1)?.key).toBe("ethereum");
    expect(resolveChain(8453)?.key).toBe("base");
    expect(resolveChain(4663)?.key).toBe("robinhood");
  });

  it("resolves by bigint chain id", () => {
    expect(resolveChain(8453n)?.key).toBe("base");
  });

  it("returns undefined for an unknown chain", () => {
    expect(resolveChain("solana")).toBeUndefined();
    expect(resolveChain(999999)).toBeUndefined();
    expect(resolveChain(null)).toBeUndefined();
    expect(resolveChain(undefined)).toBeUndefined();
  });
});

describe("explorerTx", () => {
  it("builds a chain-specific explorer link from the chain id", () => {
    expect(explorerTx(8453, "0xdead")).toBe("https://basescan.org/tx/0xdead");
    expect(explorerTx(1, "0xdead")).toBe("https://etherscan.io/tx/0xdead");
    expect(explorerTx(4663, "0xdead")).toBe(
      "https://robinhoodchain.blockscout.com/tx/0xdead"
    );
  });

  it("builds a chain-specific explorer link from the chain key", () => {
    expect(explorerTx("base", "0xdead")).toBe("https://basescan.org/tx/0xdead");
  });

  it("falls back to Basescan for an unrecognized chain", () => {
    expect(explorerTx(999999, "0xdead")).toBe("https://basescan.org/tx/0xdead");
    expect(explorerTx(undefined, "0xdead")).toBe("https://basescan.org/tx/0xdead");
  });
});

describe("logChunkBlocksFor", () => {
  it("uses each chain's measured default", () => {
    // Robinhood's public RPC serves 10k-block ranges; Ethereum's public
    // endpoints cap around 10. A single global value cannot serve both.
    expect(logChunkBlocksFor("robinhood", {})).toBe(2000);
    expect(logChunkBlocksFor("ethereum", {})).toBe(10);
    expect(logChunkBlocksFor("base", {})).toBe(10);
  });

  it("lets a global override raise every chain", () => {
    expect(logChunkBlocksFor("ethereum", { AUTO_LOG_CHUNK_BLOCKS: "50" } as any)).toBe(50);
  });

  it("gives a per-chain override precedence over the global one", () => {
    const env = { AUTO_LOG_CHUNK_BLOCKS: "50", AUTO_LOG_CHUNK_BLOCKS_ROBINHOOD: "5000" } as any;
    expect(logChunkBlocksFor("robinhood", env)).toBe(5000);
    expect(logChunkBlocksFor("ethereum", env)).toBe(50);
  });

  it("falls back to a universally safe value for an unknown chain", () => {
    expect(logChunkBlocksFor("nope", {})).toBe(10);
  });

  it("ignores non-numeric or non-positive overrides rather than breaking scans", () => {
    expect(logChunkBlocksFor("ethereum", { AUTO_LOG_CHUNK_BLOCKS: "abc" } as any)).toBe(10);
    expect(logChunkBlocksFor("ethereum", { AUTO_LOG_CHUNK_BLOCKS: "0" } as any)).toBe(10);
    expect(logChunkBlocksFor("ethereum", { AUTO_LOG_CHUNK_BLOCKS: "-5" } as any)).toBe(10);
  });
});
