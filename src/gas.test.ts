import { describe, it, expect } from "vitest";
import { gasLimitForQuantity, upfrontReservation, MINT_GAS_CEILING } from "./gas";

// The 33 real Robinhood mints the model is fitted to. Worst case per
// quantity, so the limit has to clear every one of them.
const OBSERVED: [number, number][] = [
  [1, 104_364],
  [2, 107_803],
  [3, 111_588],
  [4, 114_498],
  [5, 142_127], // an outlier ~20% above the line — the margin exists for this
  [7, 125_112],
  [10, 135_072],
  [69, 337_395],
];

describe("gasLimitForQuantity", () => {
  it("covers every real mint observed, including the outlier", () => {
    for (const [qty, used] of OBSERVED) {
      expect(gasLimitForQuantity(qty)).toBeGreaterThan(used);
    }
  });

  it("does not overshoot wildly — the reservation is the cost of being generous", () => {
    for (const [qty, used] of OBSERVED) {
      expect(gasLimitForQuantity(qty)).toBeLessThan(used * 2);
    }
  });

  it("reserves far less than the old flat 250k for a single mint", () => {
    expect(gasLimitForQuantity(1)).toBeLessThan(250_000 / 1.7);
  });

  it("exceeds the old flat 250k where that would have run out of gas", () => {
    // The qty-69 mint really burned 337,395 — a fixed 250,000 would have
    // reverted out of gas and still charged for it.
    expect(gasLimitForQuantity(69)).toBeGreaterThan(337_395);
    expect(gasLimitForQuantity(43)).toBeGreaterThan(250_000);
  });

  it("treats a nonsensical quantity as one mint rather than zero gas", () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      expect(gasLimitForQuantity(bad as number)).toBe(gasLimitForQuantity(1));
    }
  });

  it("stays inside a block for an absurd per-wallet cap", () => {
    // One live drop allowed 10,000 per wallet.
    expect(gasLimitForQuantity(10_000)).toBe(MINT_GAS_CEILING);
  });
});

describe("upfrontReservation", () => {
  it("is what actually blocked the live wallets", () => {
    // The stored settings: 250,000 x 2 gwei.
    const old = upfrontReservation(250_000, 2_000_000_000n);
    expect(old).toBe(500_000_000_000_000n); // 0.0005 ETH
    // Every wallet held less than this.
    expect(old).toBeGreaterThan(471_785_589_032_063n);
  });

  it("falls sharply once the limit is sized and the fee ceiling is realistic", () => {
    // Observed gas price was ~0.12 gwei; 0.5 gwei leaves 4x headroom.
    const now = upfrontReservation(gasLimitForQuantity(1), 500_000_000n);
    expect(now).toBeLessThan(500_000_000_000_000n / 7n);
  });

  it("includes the mint price, which a paid drop still requires", () => {
    expect(upfrontReservation(100_000, 1n, 5n)).toBe(100_005n);
  });
});
