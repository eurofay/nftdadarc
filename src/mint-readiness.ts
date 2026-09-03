// Answering "can this wallet mint this, right now, and what will it cost".
//
// Three things independently stop a mint, and each fails differently:
//
//   the stage    — not open yet, or already closed
//   the wallet   — already at its per-wallet cap, or the supply is gone
//   the balance  — short of the upfront reservation, which is gasLimit x
//                  maxFee plus the mint price, NOT the mint price alone
//
// Checking all three before sending turns three separate on-chain reverts
// into one readable answer. The last one matters most in practice: a wallet
// with plenty for the mint price still can't send if it can't cover what the
// node reserves, and that failure reads as an unhelpful "insufficient funds".

import { gasLimitForQuantity, upfrontReservation } from "./gas";

export interface StageWindow {
  live: boolean;
  /** Milliseconds until it opens; 0 when already open. */
  opensInMs: number;
  /** True once endTime has passed. */
  ended: boolean;
}

/** endTime of 0 means the stage is unconfigured, not "open forever". */
export function stageWindow(startTime: number, endTime: number, now = Date.now()): StageWindow {
  const startMs = startTime * 1000;
  const endMs = endTime * 1000;
  if (endTime === 0) return { live: false, opensInMs: 0, ended: true };
  const ended = now >= endMs;
  const live = now >= startMs && !ended;
  return { live, opensInMs: live || ended ? 0 : startMs - now, ended };
}

export interface WalletReadiness {
  address: string;
  /** What it can actually take: the smallest of cap, supply and balance. */
  canMint: number;
  /** What the chain would allow, ignoring money. */
  allowedByChain: number;
  /** What the balance can cover. */
  affordable: number;
  reason?: string;
}

/**
 * How many this wallet can mint, once every limit is applied.
 *
 * Quantity is solved for rather than assumed: at a given price and fee
 * ceiling a balance covers some number of items, and that is frequently
 * smaller than what the stage permits. Reporting the smaller number is the
 * difference between a mint and a revert.
 */
export function assessWallet(
  address: string,
  opts: {
    balanceWei: bigint | null;
    mintPriceWei: bigint;
    maxFeePerGas: bigint;
    /** 0 means "size it from the quantity" — see gas.ts. */
    gasLimit: number;
    maxPerWallet: number;
    alreadyMinted: number;
    supplyRemaining: number;
    requested?: number;
  }
): WalletReadiness {
  const walletRoom = Math.max(0, opts.maxPerWallet - opts.alreadyMinted);
  const allowedByChain = Math.max(0, Math.min(walletRoom, opts.supplyRemaining));

  let affordable = allowedByChain;
  if (opts.balanceWei !== null) {
    affordable = 0;
    // Walk down from what the chain allows: the reservation grows with
    // quantity on both terms, so the largest affordable amount is not a
    // simple division.
    for (let q = allowedByChain; q >= 1; q--) {
      const limit = opts.gasLimit > 0 ? opts.gasLimit : gasLimitForQuantity(q);
      const needed = upfrontReservation(limit, opts.maxFeePerGas, opts.mintPriceWei * BigInt(q));
      if (opts.balanceWei >= needed) {
        affordable = q;
        break;
      }
    }
  }

  const capped = Math.min(allowedByChain, affordable);
  const canMint = opts.requested ? Math.min(capped, opts.requested) : capped;

  let reason: string | undefined;
  if (allowedByChain === 0) {
    reason =
      walletRoom === 0
        ? `already minted its limit of ${opts.maxPerWallet}`
        : "collection is sold out";
  } else if (affordable === 0) {
    reason = "not enough for gas and price";
  } else if (affordable < allowedByChain) {
    reason = `balance covers ${affordable} of ${allowedByChain}`;
  } else if (opts.supplyRemaining < walletRoom) {
    reason = `only ${opts.supplyRemaining} left in the collection`;
  }

  return { address, canMint, allowedByChain, affordable, reason };
}

/** One line per wallet for the confirmation screen. */
export function describeReadiness(r: WalletReadiness, mask: (a: string) => string): string {
  const head = r.canMint > 0 ? `✅ ${mask(r.address)} — ${r.canMint}` : `⛔ ${mask(r.address)}`;
  return r.reason ? `${head} (${r.reason})` : head;
}

/**
 * Whether the quantity step can be skipped.
 *
 * With one mintable item there is nothing to ask, and asking anyway is a tap
 * between the user and a live stage.
 */
export function needsQuantityStep(readiness: WalletReadiness[]): boolean {
  return readiness.some((r) => r.canMint > 1);
}
