// Fitting the fee ceiling to what a wallet actually holds.
//
// A node accepts a transaction only when
//
//   balance >= gasLimit x maxFeePerGas + value
//
// That is protocol, not policy: the ceiling is reserved in full at submission
// and the difference refunded after. So a wallet holding exactly the mint
// price cannot send, however cheap the block turns out to be.
//
// The part that IS ours is maxFeePerGas. A configured ceiling is a worst-case
// allowance, and when a wallet can't cover it the useful move is to lower the
// ceiling for that wallet rather than refuse the mint. Two hard floors stop
// this becoming wishful:
//
//   below the base fee, the transaction is never included at all
//   with no tip, it is deprioritised whenever a block is contested
//
// So this lowers the ceiling as far as those floors and no further, and says
// plainly when even that doesn't fit.

export interface FeeFit {
  maxFeePerGas: bigint;
  /** True when the ceiling was reduced from the configured one to fit. */
  reduced: boolean;
  reason?: string;
}

/** Smallest ceiling worth sending: base fee plus a tip, with a little headroom. */
export function minimumViableFee(baseFeeWei: bigint, priorityWei: bigint): bigint {
  // Base fee can rise between building and inclusion, so a ceiling exactly at
  // base is a transaction that fails the moment the next block is fuller.
  return (baseFeeWei * 12n) / 10n + priorityWei;
}

/**
 * The highest fee ceiling this balance supports, capped at the configured one.
 *
 * Returns null when the wallet cannot cover even the minimum viable fee plus
 * the mint price — at which point it genuinely cannot mint, and saying so is
 * the only honest answer.
 */
export function fitFeeToBalance(opts: {
  balanceWei: bigint;
  mintValueWei: bigint;
  gasLimit: number;
  configuredMaxFeeWei: bigint;
  baseFeeWei: bigint;
  priorityWei: bigint;
}): FeeFit | null {
  const gas = BigInt(Math.max(1, Math.floor(opts.gasLimit)));
  const spare = opts.balanceWei - opts.mintValueWei;
  if (spare <= 0n) return null; // can't even cover the price

  const affordableCeiling = spare / gas;
  const floor = minimumViableFee(opts.baseFeeWei, opts.priorityWei);

  if (affordableCeiling >= opts.configuredMaxFeeWei) {
    return { maxFeePerGas: opts.configuredMaxFeeWei, reduced: false };
  }
  if (affordableCeiling < floor) return null;

  return {
    maxFeePerGas: affordableCeiling,
    reduced: true,
    reason: `fee ceiling lowered to fit this wallet's balance`,
  };
}

/**
 * The priority fee to pair with a reduced ceiling.
 *
 * maxPriorityFeePerGas must never exceed maxFeePerGas — a node rejects that
 * outright — so a lowered ceiling has to bring the tip down with it.
 */
export function fitPriority(maxFeeWei: bigint, configuredPriorityWei: bigint): bigint {
  return configuredPriorityWei <= maxFeeWei ? configuredPriorityWei : maxFeeWei;
}

/**
 * A ceiling derived from the block rather than from a setting.
 *
 * A static maxFee is a guess made once and then wrong in both directions: too
 * low and nothing is included, too high and every wallet is asked to reserve
 * far more than the block actually costs. Reading the base fee at signing time
 * gives a ceiling that matches the moment, which is both cheaper to reserve
 * and likelier to land.
 *
 * The multiplier is headroom for the base fee rising between signing and
 * inclusion — it can move up to 12.5% per block, so 2x covers several blocks
 * of climb while still being far under a hand-set worst case.
 */
export function marketFee(baseFeeWei: bigint, priorityWei: bigint, multiplier = 2n): bigint {
  return baseFeeWei * multiplier + priorityWei;
}

/**
 * The ceiling to sign with, given what the chain costs now.
 *
 * A configured ceiling of 0 means "follow the chain". Anything else is an
 * explicit cap and is honoured — but never signed BELOW the market rate,
 * since a ceiling under base fee is a transaction that is never included.
 */
export function resolveMaxFee(
  configuredWei: bigint,
  baseFeeWei: bigint,
  priorityWei: bigint
): { maxFeePerGas: bigint; fromMarket: boolean } {
  const market = marketFee(baseFeeWei, priorityWei);
  if (configuredWei <= 0n) return { maxFeePerGas: market, fromMarket: true };
  // A hand-set ceiling below what the block costs would simply never land.
  if (baseFeeWei > 0n && configuredWei < minimumViableFee(baseFeeWei, priorityWei)) {
    return { maxFeePerGas: market, fromMarket: true };
  }
  return { maxFeePerGas: configuredWei, fromMarket: false };
}
