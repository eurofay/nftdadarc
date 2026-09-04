import { describe, it, expect } from "vitest";
import {
  buildPlan,
  estimateConsolidationCost,
  groupByOwner,
  holders,
  summarise,
  ScanResult,
  TRANSFER_GAS_LIMIT,
  TransferResult,
} from "./nft-consolidate";

const GWEI = 1_000_000_000n;
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";
const DEST = "0xdddddddddddddddddddddddddddddddddddddddd";
const CONTRACT = "0x1111111111111111111111111111111111111111";

const scan = (tokens: { owner: string; tokenId: bigint }[]): ScanResult => ({
  contract: CONTRACT,
  tokens,
  skipped: [],
});

describe("estimateConsolidationCost", () => {
  it("scales with the number of tokens, not the number of wallets", () => {
    const one = estimateConsolidationCost(1, GWEI);
    expect(estimateConsolidationCost(4, GWEI)).toBe(one * 4n);
  });

  it("is the full ceiling per transfer, since that is what gets reserved", () => {
    expect(estimateConsolidationCost(3, 2n * GWEI)).toBe(3n * TRANSFER_GAS_LIMIT * 2n * GWEI);
  });

  it("costs nothing when there is nothing to move", () => {
    expect(estimateConsolidationCost(0, GWEI)).toBe(0n);
  });
});

describe("groupByOwner", () => {
  it("collects every token a wallet holds under one entry", () => {
    const grouped = groupByOwner([
      { owner: A, tokenId: 1n },
      { owner: B, tokenId: 2n },
      { owner: A, tokenId: 3n },
    ]);
    expect(grouped.size).toBe(2);
    expect(grouped.get(A)).toEqual([1n, 3n]);
    expect(grouped.get(B)).toEqual([2n]);
  });

  it("keeps first-seen order, so nonces are assigned predictably", () => {
    const grouped = groupByOwner([
      { owner: B, tokenId: 9n },
      { owner: A, tokenId: 1n },
    ]);
    expect([...grouped.keys()]).toEqual([B, A]);
  });

  it("handles an empty plan", () => {
    expect(groupByOwner([]).size).toBe(0);
  });
});

describe("holders", () => {
  it("lists only wallets that hold something, with their tokens", () => {
    const found = holders(scan([{ owner: A, tokenId: 1n }, { owner: B, tokenId: 2n }]));
    expect(found).toHaveLength(2);
    expect(found.map((h) => h.address).sort()).toEqual([A, B]);
  });

  it("puts the biggest holder first, so the obvious destination is on top", () => {
    const found = holders(
      scan([
        { owner: A, tokenId: 1n },
        { owner: B, tokenId: 2n },
        { owner: B, tokenId: 3n },
        { owner: B, tokenId: 4n },
        { owner: C, tokenId: 5n },
        { owner: C, tokenId: 6n },
      ])
    );
    expect(found.map((h) => h.address)).toEqual([B, C, A]);
    expect(found[0].tokenIds).toEqual([2n, 3n, 4n]);
  });

  it("is empty when nothing was found", () => {
    expect(holders(scan([]))).toEqual([]);
  });
});

describe("buildPlan", () => {
  const full = scan([
    { owner: A, tokenId: 1n },
    { owner: B, tokenId: 2n },
    { owner: C, tokenId: 3n },
  ]);

  it("keeps only the wallets that were selected", () => {
    const plan = buildPlan(full, [A, C], DEST);
    expect(plan.tokens.map((t) => t.owner)).toEqual([A, C]);
  });

  it("leaves the destination's own tokens alone even when it was selected", () => {
    // Sweeping the rest into the wallet that already holds the most is the
    // common case; it must not pay gas to send to itself.
    const plan = buildPlan(full, [A, B, C], B);
    expect(plan.tokens.map((t) => t.owner)).toEqual([A, C]);
  });

  it("matches addresses regardless of case", () => {
    const plan = buildPlan(full, [A.toUpperCase()], DEST);
    expect(plan.tokens).toHaveLength(1);
  });

  it("plans nothing when the only selected wallet is the destination", () => {
    expect(buildPlan(full, [B], B).tokens).toEqual([]);
  });

  it("carries the contract and destination through to the plan", () => {
    const plan = buildPlan(full, [A], DEST);
    expect(plan.contract).toBe(CONTRACT);
    expect(plan.destination).toBe(DEST);
  });

  it("ignores a selection that holds nothing", () => {
    expect(buildPlan(full, [DEST], DEST).tokens).toEqual([]);
  });
});

describe("summarise", () => {
  const ok = (tokenId: bigint): TransferResult => ({
    tokenId,
    from: A,
    txHash: `0x${tokenId.toString(16).padStart(64, "0")}`,
    status: "SUCCESS",
  });

  it("says nothing to move when the plan was empty", () => {
    expect(summarise([], DEST)).toBe("Nothing to move.");
  });

  it("reports confirmed out of attempted", () => {
    expect(summarise([ok(1n), ok(2n)], DEST)).toContain("2/2 moved");
  });

  it("counts a send that never confirmed as pending, not failed", () => {
    const out = summarise([ok(1n), { tokenId: 2n, from: A, txHash: "0xabc", status: "TIMEOUT" }], DEST);
    expect(out).toContain("1/2 moved");
    expect(out).toContain("1 sent but not confirmed");
    expect(out).not.toContain("failed");
  });

  it("counts an on-chain revert as failed even though it has a hash", () => {
    const out = summarise([{ tokenId: 2n, from: A, txHash: "0xabc", status: "FAILED" }], DEST);
    expect(out).toContain("1 failed");
    expect(out).toContain("reverted on chain");
  });

  it("groups identical failures so one problem reads as one line", () => {
    const broke = (tokenId: bigint): TransferResult => ({
      tokenId,
      from: A,
      txHash: null,
      error: "insufficient funds",
    });
    const out = summarise([broke(1n), broke(2n), broke(3n)], DEST);
    expect(out).toContain("3 failed");
    expect(out).toContain("3× insufficient funds");
    // One line for the reason, not three.
    expect(out.split("\n").filter((l) => l.includes("insufficient funds"))).toHaveLength(1);
  });

  it("keeps distinct failures distinct", () => {
    const out = summarise(
      [
        { tokenId: 1n, from: A, txHash: null, error: "insufficient funds" },
        { tokenId: 2n, from: B, txHash: null, error: "no usable key" },
      ],
      DEST
    );
    expect(out).toContain("1× insufficient funds");
    expect(out).toContain("1× no usable key");
  });

  it("names the destination so the message stands alone", () => {
    expect(summarise([ok(1n)], DEST)).toContain(DEST.slice(0, 8));
  });
});
