import { describe, it, expect } from "vitest";
import { matchWallets, checkAffordability } from "./bot";
import { WalletRecord } from "./store";

const WALLETS: WalletRecord[] = [
  { label: "main", address: "0x1111111111111111111111111111111111111111", encryptedKey: "x", addedAt: 0 },
  { label: "Sniper 2", address: "0x2222222222222222222222222222222222222222", encryptedKey: "x", addedAt: 0 },
];

describe("matchWallets (used by /mint's fast wallet filter)", () => {
  it("matches by exact label", () => {
    expect(matchWallets(WALLETS, "main")).toEqual([WALLETS[0]]);
  });

  it("matches by label case-insensitively", () => {
    expect(matchWallets(WALLETS, "SNIPER 2")).toEqual([WALLETS[1]]);
  });

  it("matches by address case-insensitively", () => {
    expect(matchWallets(WALLETS, WALLETS[0].address.toUpperCase())).toEqual([WALLETS[0]]);
  });

  it("matches several comma-separated tokens, preserving order and dropping duplicates", () => {
    expect(matchWallets(WALLETS, "Sniper 2, main, main")).toEqual([WALLETS[1], WALLETS[0]]);
  });

  it("throws naming the exact token that didn't match anything", () => {
    expect(() => matchWallets(WALLETS, "main, nope")).toThrow(/nope/);
  });

  it("ignores stray whitespace around tokens", () => {
    expect(matchWallets(WALLETS, "  main  ,  Sniper 2  ")).toEqual([WALLETS[0], WALLETS[1]]);
  });
});

describe("checkAffordability (dry-run / transaction validation)", () => {
  it("requires gasLimit × maxFee + mint value, matching what a node actually reserves", () => {
    const { requiredWei } = checkAffordability(0n, 250_000, 2_000_000_000n, 0n);
    expect(requiredWei).toBe(250_000n * 2_000_000_000n);
  });

  it("adds the mint's own value on top of the gas reservation", () => {
    const { requiredWei } = checkAffordability(0n, 250_000, 2_000_000_000n, 10_000_000_000_000_000n);
    expect(requiredWei).toBe(250_000n * 2_000_000_000n + 10_000_000_000_000_000n);
  });

  it("is affordable when balance meets or exceeds the requirement", () => {
    const required = 250_000n * 2_000_000_000n;
    expect(checkAffordability(required, 250_000, 2_000_000_000n, 0n).affordable).toBe(true);
    expect(checkAffordability(required + 1n, 250_000, 2_000_000_000n, 0n).affordable).toBe(true);
  });

  it("is not affordable when balance falls short, even by 1 wei", () => {
    const required = 250_000n * 2_000_000_000n;
    expect(checkAffordability(required - 1n, 250_000, 2_000_000_000n, 0n).affordable).toBe(false);
  });

  it("reports affordable as null (unknown) rather than guessing when balance lookup failed", () => {
    expect(checkAffordability(null, 250_000, 2_000_000_000n, 0n).affordable).toBeNull();
  });
});
