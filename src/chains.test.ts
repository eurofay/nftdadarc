import { describe, it, expect } from "vitest";
import { explorerTx, resolveChain } from "./chains";

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
