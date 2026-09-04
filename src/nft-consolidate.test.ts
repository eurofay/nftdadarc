import { describe, it, expect } from "vitest";
import {
  estimateConsolidationCost,
  groupByOwner,
  summarise,
  TRANSFER_GAS_LIMIT,
  TransferResult,
} from "./nft-consolidate";

const GWEI = 1_000_000_000n;
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DEST = "0xdddddddddddddddddddddddddddddddddddddddd";

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
