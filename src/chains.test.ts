import { describe, it, expect } from "vitest";
import { explorerTx, resolveChain, logChunkBlocksFor, blocksForSeconds, catchupBlocksFor, backfillBlocksFor } from "./chains";

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

describe("blocksForSeconds", () => {
  it("converts a time span using each chain's own block rate", () => {
    expect(blocksForSeconds("ethereum", 3600)).toBe(297); // ~12.12s blocks
    expect(blocksForSeconds("base", 3600)).toBe(1800);    // 2s blocks
    expect(blocksForSeconds("robinhood", 3600)).toBe(36000); // 0.1s blocks
  });

  it("never returns zero, so a span can't silently become 'no blocks'", () => {
    expect(blocksForSeconds("ethereum", 1)).toBe(1);
    expect(blocksForSeconds("ethereum", 0)).toBe(1);
  });
});

describe("catchupBlocksFor", () => {
  it("gives every chain the same tolerance in TIME, not in blocks", () => {
    // The bug this replaces: a flat 200 blocks meant 40 minutes of slack on
    // Ethereum but 20 seconds on Robinhood — less than one RPC timeout, so a
    // single slow response silently discarded every sighting in the gap.
    // Within one block: a whole number of blocks can't land on exactly 600
    // seconds when they're 12.12s apart.
    for (const k of ["ethereum", "base", "robinhood"]) {
      const blockSeconds = resolveChain(k)!.blockSeconds;
      const span = catchupBlocksFor(k, {} as any) * blockSeconds;
      // Exact to within the rounding of a single block.
      expect(Math.abs(span - 600)).toBeLessThanOrEqual(blockSeconds);
    }
  });

  it("is far more forgiving on a fast chain than the old flat count", () => {
    expect(catchupBlocksFor("robinhood", {} as any)).toBe(6000); // was 200
  });

  it("honours an override and ignores a nonsensical one", () => {
    expect(catchupBlocksFor("base", { COPY_CATCHUP_SECONDS: "60" } as any)).toBe(30);
    expect(catchupBlocksFor("base", { COPY_CATCHUP_SECONDS: "0" } as any)).toBe(300);
    expect(catchupBlocksFor("base", { COPY_CATCHUP_SECONDS: "x" } as any)).toBe(300);
  });
});

describe("backfillBlocksFor", () => {
  it("looks back half a day by default, because drops stay open for days", () => {
    expect(backfillBlocksFor("robinhood", {} as any)).toBe(432000); // 12h at 0.1s
    expect(backfillBlocksFor("ethereum", {} as any)).toBe(3564);
  });

  it("can be switched off entirely", () => {
    expect(backfillBlocksFor("robinhood", { COPY_BACKFILL_HOURS: "0" } as any)).toBe(0);
  });

  it("honours an override", () => {
    expect(backfillBlocksFor("robinhood", { COPY_BACKFILL_HOURS: "1" } as any)).toBe(36000);
  });
});
