// Regression tests for the copy-mint scan loop stalling on a chain it can
// never finish backfilling.
//
// Symptom in the field (Robinhood, 12h backfill at a 10-block chunk):
//
//   [copy:robinhood] ⚠ scan failed at chunk 10 (timeout) — retrying at 10
//   [copy:robinhood] ⚠ scan failed at chunk 10 (timeout) — retrying at 10
//   ... the same line, five times in one minute, forever.
//
// Four separate faults compounded into that:
//   1. a failed scan discarded every chunk it had already fetched,
//   2. so the next tick rescanned the whole ~432,000-block range from the
//      start, and had to clear all 43,200 chunks without one hiccup,
//   3. the "retry at half the chunk" floor was 10, so at chunk 10 the retry
//      re-issued the identical failing request and called it a retry,
//   4. and consecutiveFailures was reset even when the scan failed, so the
//      poll loop's exponential backoff never engaged and it hammered the
//      endpoint (and the chat) every 4 seconds.

import { describe, it, expect, afterEach, vi } from "vitest";
import { Interface, Wallet } from "ethers";
import { runCopyMintWatcher, looksLikeRangeLimit, scanWatchedMints } from "./copy-mint";
import { SEADROP_ADDRESS } from "./seadrop-public";
import { CHAINS } from "./chains";
import { clearProviderCache } from "./rpc-provider";
import { Logger } from "./logger";
import { startMockRpc, MockRpc } from "./test-support/mock-rpc";

const IFACE = new Interface([
  "event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)",
]);

const WATCHED = new Wallet("0xad6c4582d7bae64497e12e590deb375c3e5e1827044300f6a9d98f06c6dae4bd").address;
const NFT = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

function mintLog(blockNumber: number) {
  const { data, topics } = IFACE.encodeEventLog(IFACE.getEvent("SeaDropMint")!, [
    NFT, WATCHED, RECIPIENT, WATCHED, 1n, 0n, 0n, 0n,
  ]);
  return {
    address: SEADROP_ADDRESS,
    topics,
    data,
    blockNumber: `0x${blockNumber.toString(16)}`,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    transactionIndex: "0x0",
    blockHash: `0x${"a".repeat(64)}`,
    logIndex: "0x0",
    removed: false,
  };
}

// Captures every line the watcher emits, split by the severity that decides
// whether the Telegram sink forwards it to the chat (see logger.ts: info and
// highlight stay local, everything else is forwarded).
function recordingLogger() {
  const forwarded: string[] = [];
  const local: string[] = [];
  const to = (arr: string[]) => (m: string) => void arr.push(m);
  return {
    forwarded,
    local,
    logger: {
      raw: to(forwarded), title: to(forwarded), success: to(forwarded),
      successBold: to(forwarded), warn: to(forwarded), warnBold: to(forwarded),
      error: to(forwarded), errorBold: to(forwarded), done: to(forwarded),
      info: to(local), highlight: to(local),
    } as Logger,
  };
}

let mock: MockRpc | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  clearProviderCache();
  await mock?.close();
  mock = undefined;
});

describe("looksLikeRangeLimit", () => {
  it("does not ask for a smaller range when the node timed out", () => {
    // The screenshot's case. A timeout means "too many calls"; halving the
    // chunk doubles the call count, which is the wrong direction.
    expect(looksLikeRangeLimit(new Error("timeout"))).toBe(false);
    expect(looksLikeRangeLimit(new Error("request timeout"))).toBe(false);
  });

  it("does not ask for a smaller range when the node is rate-limiting", () => {
    expect(looksLikeRangeLimit(new Error("too many requests"))).toBe(false);
    expect(looksLikeRangeLimit(new Error("rate limit exceeded"))).toBe(false);
  });

  it("recognises the providers that really are objecting to the range", () => {
    expect(looksLikeRangeLimit(new Error("query returned more than 10000 results"))).toBe(true);
    expect(looksLikeRangeLimit(new Error("exceed maximum block range: 5000"))).toBe(true);
    expect(looksLikeRangeLimit(new Error("Log response size exceeded"))).toBe(true);
  });
});

describe("scanWatchedMints partial progress", () => {
  it("hands back the chunks that succeeded before a later one failed", async () => {
    // A 40-block range at a 10-block chunk is 4 calls. The 3rd dies, so the
    // scan throws — but the first two chunks were real work, and before
    // onProgress the caller had no way to keep them.
    let calls = 0;
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getLogs: (params) => {
        calls++;
        if (calls >= 3) throw new Error("timeout");
        const from = parseInt(params[0].fromBlock, 16);
        return from === 100 ? [mintLog(105)] : [];
      },
    });

    const seen: { through: number; found: number }[] = [];
    await expect(
      scanWatchedMints(mock.url, 100, 139, [WATCHED], 10, {
        onProgress: (through, found) => void seen.push({ through, found: found.length }),
      })
    ).rejects.toThrow();

    // Chunks [100..109] and [110..119] landed; the caller keeps both the
    // sighting and the knowledge that block 119 is covered.
    expect(seen).toEqual([
      { through: 109, found: 1 },
      { through: 119, found: 0 },
    ]);
  });
});

// Drives the real watcher against a node that never answers eth_getLogs, and
// asserts on what it does about it.
async function runAgainstFailingScan(errorMessage: string, ms = 900) {
  let head = 1000;
  const ranges: { from: number; to: number }[] = [];
  mock = await startMockRpc({
    eth_chainId: () => "0x2105",
    eth_blockNumber: () => `0x${(head += 5).toString(16)}`,
    eth_getLogs: (params) => {
      ranges.push({
        from: parseInt(params[0].fromBlock, 16),
        to: parseInt(params[0].toBlock, 16),
      });
      throw new Error(errorMessage);
    },
  });

  const { forwarded, local, logger } = recordingLogger();
  const stopSignal = { stopped: false };
  const run = runCopyMintWatcher({
    chain: CHAINS.find((c) => c.key === "base")!,
    rpcUrls: [mock.url],
    walletKeys: [],
    watchTargets: [WATCHED],
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFee: 100_000_000n,
    gasLimit: 250_000,
    pollIntervalMs: 30,
    maxPriceEth: 1,
    backfillBlocks: 40,
    logChunkBlocks: 10,
    logger,
    stopSignal,
  });

  await new Promise((r) => setTimeout(r, ms));
  stopSignal.stopped = true;
  await run;
  return { ranges, forwarded, local };
}

describe("runCopyMintWatcher against an RPC that keeps timing out", () => {
  it("reports the failure once instead of once per tick", { timeout: 15000 }, async () => {
    const { forwarded } = await runAgainstFailingScan("timeout");
    const failures = forwarded.filter((l) => l.includes("Block scan failed"));
    // The bug produced one of these every poll. The failure is unchanged, so
    // saying it more than once adds nothing but noise in the chat.
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("timeout");
  });

  it("does not announce a retry at the chunk size that just failed", { timeout: 15000 }, async () => {
    const { forwarded, local } = await runAgainstFailingScan("timeout");
    // "failed at chunk 10 — retrying at 10" was the line in the screenshot:
    // Math.max(10, 10/2) is 10, so it re-sent the identical request.
    expect([...forwarded, ...local].some((l) => /rescanning .* at 10\b/.test(l))).toBe(false);
  });

  it("keeps the ground it covered rather than rescanning from the start", { timeout: 15000 }, async () => {
    // Every chunk fails here, so nothing is covered and every attempt starts
    // at the same block — but the ranges must never *shrink backwards* past
    // what a successful chunk established. The real assertion is that the
    // loop backs off rather than retrying flat out.
    const { ranges } = await runAgainstFailingScan("timeout");
    expect(ranges.length).toBeGreaterThan(0);
    for (const r of ranges) expect(r.to).toBeGreaterThanOrEqual(r.from);
  });

  it("backs off instead of hammering the endpoint every tick", { timeout: 15000 }, async () => {
    // 900ms at a 30ms poll is ~30 ticks with no backoff. With backoff the
    // interval doubles each failure (30, 60, 120, 240, 480…), so the scan is
    // attempted a handful of times, not dozens. Each attempt is one call
    // because the very first chunk throws.
    const { ranges } = await runAgainstFailingScan("timeout");
    expect(ranges.length).toBeLessThan(12);
  });

  it("says so once when it recovers", { timeout: 20000 }, async () => {
    let head = 1000;
    let failing = true;
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_blockNumber: () => `0x${(head += 5).toString(16)}`,
      eth_getLogs: () => {
        if (failing) throw new Error("timeout");
        return [];
      },
    });

    const { forwarded, logger } = recordingLogger();
    const stopSignal = { stopped: false };
    const run = runCopyMintWatcher({
      chain: CHAINS.find((c) => c.key === "base")!,
      rpcUrls: [mock.url],
      walletKeys: [],
      watchTargets: [WATCHED],
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFee: 100_000_000n,
      gasLimit: 250_000,
      pollIntervalMs: 30,
      maxPriceEth: 1,
      backfillBlocks: 20,
      logChunkBlocks: 10,
      logger,
      stopSignal,
    });

    // Long enough for the scan to exhaust scanSeaDropMints' own per-chunk
    // retries (which back off past a second) and report a real failure,
    // rather than recovering on a retry and never logging one.
    await new Promise((r) => setTimeout(r, 3000));
    failing = false;
    await new Promise((r) => setTimeout(r, 1500));
    stopSignal.stopped = true;
    await run;

    expect(forwarded.filter((l) => l.includes("Block scan failed"))).toHaveLength(1);
    expect(forwarded.filter((l) => l.includes("recovered"))).toHaveLength(1);
  });
});

describe("runCopyMintWatcher backfill cost", () => {
  it("warns when the chunk size makes the backfill tens of thousands of calls", { timeout: 15000 }, async () => {
    let head = 500_000;
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_blockNumber: () => `0x${(head += 5).toString(16)}`,
      eth_getLogs: () => [],
    });

    const { forwarded, logger } = recordingLogger();
    const stopSignal = { stopped: false };
    const run = runCopyMintWatcher({
      chain: CHAINS.find((c) => c.key === "robinhood")!,
      rpcUrls: [mock.url],
      walletKeys: [],
      watchTargets: [WATCHED],
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFee: 100_000_000n,
      gasLimit: 250_000,
      pollIntervalMs: 30,
      maxPriceEth: 1,
      // The reported configuration: a 12h Robinhood backfill walked 10 blocks
      // at a time because a global AUTO_LOG_CHUNK_BLOCKS=10 overrode this
      // chain's measured 2000.
      backfillBlocks: 432_000,
      logChunkBlocks: 10,
      logger,
      stopSignal,
    });

    await new Promise((r) => setTimeout(r, 300));
    stopSignal.stopped = true;
    // Must return promptly: a 43,200-chunk scan that ignored the stop signal
    // would hold this open for over an hour.
    await run;

    const warning = forwarded.find((l) => l.includes("scans at 10 blocks each"));
    expect(warning).toBeDefined();
    expect(warning).toContain("43200 scans");
    // Names the fix, and the fact that a global setting is what silenced the
    // chain's own 2000.
    expect(warning).toContain("AUTO_LOG_CHUNK_BLOCKS_ROBINHOOD=2000");
  });
});
