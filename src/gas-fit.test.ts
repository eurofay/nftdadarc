import { describe, it, expect } from "vitest";
import { fitFeeToBalance, fitPriority, minimumViableFee } from "./gas-fit";

const GWEI = 1_000_000_000n;
const BASE = 323_096_000n; // 0.323 gwei, measured on Robinhood
const TIP = 50_000_000n; // 0.05 gwei
const GAS = 141_075; // gasLimitForQuantity(1)

const base = {
  mintValueWei: 0n,
  gasLimit: GAS,
  configuredMaxFeeWei: GWEI / 2n, // 0.5 gwei
  baseFeeWei: BASE,
  priorityWei: TIP,
};

describe("minimumViableFee", () => {
  it("sits above the base fee, since base can rise before inclusion", () => {
    const floor = minimumViableFee(BASE, TIP);
    expect(floor).toBeGreaterThan(BASE);
  });

  it("includes the tip, so the transaction isn't deprioritised", () => {
    expect(minimumViableFee(BASE, TIP)).toBeGreaterThan(minimumViableFee(BASE, 0n));
  });
});

describe("fitFeeToBalance", () => {
  it("keeps the configured ceiling when the wallet can afford it", () => {
    const fit = fitFeeToBalance({ ...base, balanceWei: 1_000_000_000_000_000_000n });
    expect(fit).not.toBeNull();
    expect(fit!.reduced).toBe(false);
    expect(fit!.maxFeePerGas).toBe(base.configuredMaxFeeWei);
  });

  it("lowers the ceiling rather than refusing a wallet that's a little short", () => {
    // Enough for ~0.46 gwei but not the configured 0.5. Above the viable
    // floor (1.2x base + tip = ~0.438), so it should mint at the lower
    // ceiling instead of being turned away.
    const balance = BigInt(GAS) * 460_000_000n;
    const fit = fitFeeToBalance({ ...base, balanceWei: balance });
    expect(fit).not.toBeNull();
    expect(fit!.reduced).toBe(true);
    expect(fit!.maxFeePerGas).toBeLessThan(base.configuredMaxFeeWei);
    // Still above what the chain needs, or it would never be included.
    expect(fit!.maxFeePerGas).toBeGreaterThanOrEqual(minimumViableFee(BASE, TIP));
  });

  it("refuses below the minimum viable fee instead of sending a stuck tx", () => {
    // A ceiling under the base fee is a transaction that never gets included.
    const balance = BigInt(GAS) * (BASE / 2n);
    expect(fitFeeToBalance({ ...base, balanceWei: balance })).toBeNull();
  });

  it("refuses a wallet holding only the mint price", () => {
    // The exact-price case: real, and still unsendable, because the ceiling
    // is reserved on top of the price.
    const price = 10_000_000_000_000_000n;
    expect(fitFeeToBalance({ ...base, mintValueWei: price, balanceWei: price })).toBeNull();
  });

  it("accounts for the mint price before working out what's left for gas", () => {
    const price = 1_000_000_000_000_000n; // 0.001 ETH
    const forGas = BigInt(GAS) * 460_000_000n;
    const fit = fitFeeToBalance({ ...base, mintValueWei: price, balanceWei: price + forGas });
    expect(fit).not.toBeNull();
    expect(fit!.maxFeePerGas).toBeLessThanOrEqual(460_000_000n);
  });

  it("returns null when the balance can't even cover the price", () => {
    expect(fitFeeToBalance({ ...base, mintValueWei: 100n, balanceWei: 50n })).toBeNull();
  });

  it("scales with gas limit — a bigger mint needs a lower ceiling to fit", () => {
    const balance = BigInt(GAS) * 460_000_000n;
    const small = fitFeeToBalance({ ...base, balanceWei: balance })!;
    const large = fitFeeToBalance({ ...base, balanceWei: balance, gasLimit: GAS * 3 });
    // Three times the gas out of the same balance means either a third of the
    // ceiling, or no viable fee at all.
    if (large) expect(large.maxFeePerGas).toBeLessThan(small.maxFeePerGas);
    else expect(large).toBeNull();
  });
});

describe("fitPriority", () => {
  it("leaves the tip alone when it fits under the ceiling", () => {
    expect(fitPriority(GWEI, TIP)).toBe(TIP);
  });

  it("clamps the tip to the ceiling — a node rejects a tip above it", () => {
    expect(fitPriority(TIP / 2n, TIP)).toBe(TIP / 2n);
  });
});
