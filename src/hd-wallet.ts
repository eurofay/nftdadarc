// Deriving many wallets from one seed phrase (BIP-39 / BIP-44).
//
// The point is to hold one backup instead of N private keys: the phrase
// regenerates every wallet, in order, on any standard wallet software
// (MetaMask, Rabby, Ledger) using the path below.
//
// The phrase is deliberately NOT persisted. Each derived key is encrypted
// into the store exactly like a pasted key, and the phrase is shown once for
// the user to write down. Storing it would mean a single stolen string
// controls every wallet derived from it — including ones not yet created —
// where a stolen key file costs only the wallets already in it.

import { HDNodeWallet, Mnemonic, randomBytes } from "ethers";

/** The path MetaMask, Rabby and Ledger all use, so the phrase imports cleanly. */
export const ETH_BASE_PATH = "m/44'/60'/0'/0";

export interface DerivedWallet {
  index: number;
  address: string;
  privateKey: string;
  path: string;
}

/**
 * A fresh BIP-39 phrase. 12 words (128 bits) by default — the same strength
 * every major wallet defaults to; 24 words (256 bits) is available for those
 * who want it.
 */
export function generateMnemonic(words: 12 | 24 = 12): string {
  const entropy = randomBytes(words === 24 ? 32 : 16);
  return Mnemonic.fromEntropy(entropy).phrase;
}

export function isValidMnemonic(phrase: string): boolean {
  try {
    return Mnemonic.isValidMnemonic(normalizeMnemonic(phrase));
  } catch {
    return false;
  }
}

/** Collapses whitespace and case so a pasted phrase validates as typed. */
export function normalizeMnemonic(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Derive `count` wallets from `phrase`, starting at `startIndex`.
 * Deriving the same phrase and index always yields the same wallet, which is
 * what makes the phrase a complete backup.
 */
export function deriveWallets(phrase: string, count: number, startIndex = 0): DerivedWallet[] {
  const normalized = normalizeMnemonic(phrase);
  if (!Mnemonic.isValidMnemonic(normalized)) {
    throw new Error("That is not a valid BIP-39 seed phrase.");
  }
  if (!Number.isFinite(count) || count < 1) throw new Error("Ask for at least one wallet.");
  if (!Number.isFinite(startIndex) || startIndex < 0) throw new Error("startIndex cannot be negative.");

  const mnemonic = Mnemonic.fromPhrase(normalized);
  const out: DerivedWallet[] = [];
  for (let i = startIndex; i < startIndex + Math.floor(count); i++) {
    const path = `${ETH_BASE_PATH}/${i}`;
    const node = HDNodeWallet.fromMnemonic(mnemonic, path);
    out.push({ index: i, address: node.address, privateKey: node.privateKey, path });
  }
  return out;
}
