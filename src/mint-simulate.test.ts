import { describe, it, expect } from "vitest";
import { AbiCoder, id } from "ethers";
import { classifyRevert, isTimingFailure } from "./mint-simulate";

// Simulation earns its place only if it turns a revert into something a person
// can act on. "It failed" is not actionable; "this wallet is not on the list"
// and "the stage has not opened yet" want completely different responses.

const CODER = AbiCoder.defaultAbiCoder();
const errorString = (message: string) =>
  "0x08c379a0" + CODER.encode(["string"], [message]).slice(2);
const customError = (signature: string) => id(signature).slice(0, 10);

describe("reading a revert string", () => {
  const cases: [string, string][] = [
    ["Sale not started", "DROP_NOT_STARTED"],
    ["Public sale has ended", "DROP_ENDED"],
    ["Pausable: paused", "STAGE_NOT_ACTIVE"],
    ["Exceeds max supply", "SUPPLY_EXHAUSTED"],
    ["Sold out", "SUPPLY_EXHAUSTED"],
    ["Exceeds max per wallet", "WALLET_LIMIT_EXCEEDED"],
    ["Invalid merkle proof", "NOT_ELIGIBLE"],
    ["Not on the list", "NOT_ELIGIBLE"],
    ["Invalid signature", "INVALID_AUTHORIZATION"],
    ["Ether value sent is not correct", "INSUFFICIENT_BALANCE"],
    ["Insufficient payment", "INSUFFICIENT_BALANCE"],
  ];

  for (const [message, code] of cases) {
    it(`reads "${message}" as ${code}`, () => {
      const info = classifyRevert(errorString(message));
      expect(info.code).toBe(code);
      // The contract's own words are kept, because they are often more
      // specific than any category.
      expect(info.detail).toBe(message);
    });
  }

  it("keeps a message it cannot categorise instead of discarding it", () => {
    const info = classifyRevert(errorString("Frobnicator misaligned"));
    expect(info.code).toBe("UNKNOWN_REVERT");
    expect(info.detail).toBe("Frobnicator misaligned");
  });
});

describe("reading a custom error", () => {
  it("names the ones that recur across ERC721A contracts", () => {
    expect(classifyRevert(customError("InvalidProof()")).code).toBe("NOT_ELIGIBLE");
    expect(classifyRevert(customError("SoldOut()")).code).toBe("SUPPLY_EXHAUSTED");
    expect(classifyRevert(customError("SaleNotStarted()")).code).toBe("DROP_NOT_STARTED");
    expect(classifyRevert(customError("InvalidSignature()")).code).toBe("INVALID_AUTHORIZATION");
    expect(classifyRevert(customError("ExceedsMaxPerWallet()")).code).toBe("WALLET_LIMIT_EXCEEDED");
  });

  it("reports an unrecognised selector rather than guessing at it", () => {
    // A custom error is four bytes with no text. Naming the selector is the
    // useful thing: it can be looked up. Inventing a meaning cannot.
    const info = classifyRevert("0xdeadbeef");
    expect(info.code).toBe("UNKNOWN_REVERT");
    expect(info.selector).toBe("0xdeadbeef");
    expect(info.detail).toContain("0xdeadbeef");
  });

  it("reads a solidity panic as a panic", () => {
    const panic = "0x4e487b71" + CODER.encode(["uint256"], [0x11]).slice(2);
    expect(classifyRevert(panic).detail).toContain("panic");
  });
});

describe("reverts with no data", () => {
  it("falls back to whatever the node said", () => {
    const info = classifyRevert(null, "execution reverted: sale is not active");
    expect(info.code).toBe("STAGE_NOT_ACTIVE");
  });

  it("says so plainly when there is nothing to go on", () => {
    expect(classifyRevert(undefined, "").detail).toContain("no reason given");
  });
});

describe("early versus wrong", () => {
  it("treats an unopened stage as early, not as a broken transaction", () => {
    // This is what makes preparing ahead possible at all. Simulating a mint an
    // hour before it opens SHOULD revert -- refusing to arm on that would
    // remove the entire point of arming.
    expect(isTimingFailure("DROP_NOT_STARTED")).toBe(true);
    expect(isTimingFailure("STAGE_NOT_ACTIVE")).toBe(true);
  });

  it("treats everything else as a reason not to arm", () => {
    for (const code of [
      "NOT_ELIGIBLE",
      "INVALID_AUTHORIZATION",
      "SUPPLY_EXHAUSTED",
      "WALLET_LIMIT_EXCEEDED",
      "INSUFFICIENT_BALANCE",
      "DROP_ENDED",
    ] as const) {
      expect(isTimingFailure(code), code).toBe(false);
    }
  });
});
