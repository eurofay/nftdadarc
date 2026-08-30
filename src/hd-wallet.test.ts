import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import {
  generateMnemonic,
  deriveWallets,
  isValidMnemonic,
  normalizeMnemonic,
  ETH_BASE_PATH,
} from "./hd-wallet";

// The canonical BIP-39 test vector. Pinning real addresses against it proves
// the derivation path matches what MetaMask/Rabby/Ledger produce — if this
// ever drifts, a user's phrase would restore to different wallets than the
// bot used, and the funds would look lost.
const VECTOR = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("generateMnemonic", () => {
  it("produces a valid 12-word phrase by default", () => {
    const phrase = generateMnemonic();
    expect(phrase.split(" ")).toHaveLength(12);
    expect(isValidMnemonic(phrase)).toBe(true);
  });

  it("produces 24 words when asked", () => {
    expect(generateMnemonic(24).split(" ")).toHaveLength(24);
  });

  it("is different every time", () => {
    const seen = new Set(Array.from({ length: 8 }, () => generateMnemonic()));
    expect(seen.size).toBe(8);
  });
});

describe("deriveWallets", () => {
  it("matches the standard derivation every major wallet uses", () => {
    const [first] = deriveWallets(VECTOR, 1);
    expect(first.address).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
    expect(first.path).toBe(`${ETH_BASE_PATH}/0`);
  });

  it("derives distinct sequential wallets", () => {
    const five = deriveWallets(VECTOR, 5);
    expect(five).toHaveLength(5);
    expect(new Set(five.map((w) => w.address)).size).toBe(5);
    expect(five.map((w) => w.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("is deterministic — the phrase really is the whole backup", () => {
    expect(deriveWallets(VECTOR, 3)).toEqual(deriveWallets(VECTOR, 3));
  });

  it("can continue from an offset without repeating earlier wallets", () => {
    const firstThree = deriveWallets(VECTOR, 3);
    const nextTwo = deriveWallets(VECTOR, 2, 3);
    expect(nextTwo.map((w) => w.index)).toEqual([3, 4]);
    expect(firstThree.map((w) => w.address)).not.toContain(nextTwo[0].address);
  });

  it("returns keys that actually control the addresses", () => {
    for (const w of deriveWallets(VECTOR, 3)) {
      expect(new Wallet(w.privateKey).address).toBe(w.address);
    }
  });

  it("accepts a sloppily pasted phrase", () => {
    const messy = `  ABANDON abandon\n abandon abandon abandon abandon abandon abandon abandon abandon abandon   about `;
    expect(normalizeMnemonic(messy)).toBe(VECTOR);
    expect(deriveWallets(messy, 1)[0].address).toBe(deriveWallets(VECTOR, 1)[0].address);
  });

  it("refuses an invalid phrase rather than deriving from nonsense", () => {
    // A wrong checksum is the common typo case and must not silently work.
    const badChecksum = VECTOR.replace(/about$/, "abandon");
    expect(isValidMnemonic(badChecksum)).toBe(false);
    expect(() => deriveWallets(badChecksum, 1)).toThrow(/not a valid/i);
    expect(() => deriveWallets("hello world", 1)).toThrow(/not a valid/i);
  });

  it("rejects nonsensical counts", () => {
    expect(() => deriveWallets(VECTOR, 0)).toThrow(/at least one/i);
    expect(() => deriveWallets(VECTOR, 1, -1)).toThrow(/negative/i);
  });
});
