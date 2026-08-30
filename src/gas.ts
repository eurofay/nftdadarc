// Sizing the gas limit for a SeaDrop mint.
//
// A gas limit is a CEILING, not a cost — unused gas is refunded. So the only
// price of setting it high is the upfront reservation: a node holds
// gasLimit x maxFeePerGas against the balance before it will accept the
// transaction at all. A flat 250,000 was therefore wrong in both directions:
// it reserved ~2.4x what a single mint actually needs, while still being too
// small for a large one.
//
// The model below is fitted to 33 real SeaDrop mints observed on Robinhood
// (August 2026), spanning quantities 1 to 69:
//
//   qty  1  ->  104,364 gas        qty 10  ->  135,072 gas
//   qty  5  ->  142,127 gas (max)  qty 69  ->  337,395 gas
//
// which is a straight line: a fixed cost to enter the contract plus a small
// per-item cost. One qty-5 mint came in 20% above the line — contracts vary —
// so the margin below is sized to cover that worst case, not the median.

/** Fixed cost of the call itself, independent of how many are minted. */
export const MINT_GAS_BASE = 101_000;
/** Marginal cost per additional item, from the 1-to-69 slope. */
export const MINT_GAS_PER_ITEM = 3_500;
/** Covers the worst contract-to-contract variance seen (20%), plus headroom. */
export const MINT_GAS_MARGIN = 1.35;

// Well above any real mint but below a block's capacity, so an absurd
// per-wallet cap (one drop seen allowed 10,000) can't produce a limit no
// block could ever include.
export const MINT_GAS_CEILING = 15_000_000;

/**
 * Gas limit for minting `quantity` items — measured, with margin.
 * Never returns less than a single mint needs, whatever is passed in.
 */
export function gasLimitForQuantity(quantity: number): number {
  const qty = Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1;
  const raw = (MINT_GAS_BASE + MINT_GAS_PER_ITEM * qty) * MINT_GAS_MARGIN;
  return Math.min(MINT_GAS_CEILING, Math.ceil(raw));
}

/**
 * What a node holds against the balance before accepting the transaction.
 * This — not the mint price, and not the gas actually burned — is what stops
 * an underfunded wallet from sending at all.
 */
export function upfrontReservation(gasLimit: number, maxFeePerGas: bigint, mintValue = 0n): bigint {
  return BigInt(Math.max(0, Math.floor(gasLimit))) * maxFeePerGas + mintValue;
}
