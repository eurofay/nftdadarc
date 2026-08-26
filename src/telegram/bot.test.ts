import { describe, it, expect } from "vitest";
import { matchWallets } from "./bot";
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
