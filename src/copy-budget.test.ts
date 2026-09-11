import { describe, it, expect } from "vitest";
import { parseEther } from "ethers";
import { quantityWithinBudget } from "./copy-mint";

const eth = (n: string) => parseEther(n);

describe("the overspend that started this", () => {
  it("does not mint twenty at a price that only one was checked against", () => {
    // The reported case. The cap was compared against the price of ONE item,
    // which passed, and then the mint went ahead at the drop's full
    // per-wallet maximum of 20 -- spending twenty times the cap.
    const out = quantityWithinBudget({
      unitPriceWei: eth("0.0005"),
      maxSpendWei: eth("0.001"),
      dropMaxPerWallet: 20,
    });
    expect(out.quantity).toBe(2); // 0.001 / 0.0005, not 20
    expect(out.trimmed).toBe(true);
  });

  it("spends no more than the cap, whatever the drop allows", () => {
    for (const [unit, cap, max] of [
      ["0.0005", "0.001", 20],
      ["0.01", "0.05", 100],
      ["0.003", "0.01", 7],
    ] as const) {
      const out = quantityWithinBudget({
        unitPriceWei: eth(unit),
        maxSpendWei: eth(cap),
        dropMaxPerWallet: max,
      });
      const spend = eth(unit) * BigInt(out.quantity);
      expect(spend, `${out.quantity} x ${unit} exceeds ${cap}`).toBeLessThanOrEqual(eth(cap));
    }
  });
});

describe("trimming rather than skipping", () => {
  it("takes what fits when the full amount would not", () => {
    // A cap is a budget, not a filter: if six fit and twenty do not, six is
    // what was asked for.
    const out = quantityWithinBudget({
      unitPriceWei: eth("0.001"),
      maxSpendWei: eth("0.006"),
      dropMaxPerWallet: 20,
    });
    expect(out.quantity).toBe(6);
  });

  it("skips only when even one item is over budget", () => {
    const out = quantityWithinBudget({
      unitPriceWei: eth("0.05"),
      maxSpendWei: eth("0.01"),
      dropMaxPerWallet: 20,
    });
    expect(out.quantity).toBe(0);
  });

  it("rounds down, since half an NFT cannot be minted", () => {
    // Rounding up would reintroduce the overspend in miniature.
    const out = quantityWithinBudget({
      unitPriceWei: eth("0.003"),
      maxSpendWei: eth("0.01"),
      dropMaxPerWallet: 20,
    });
    expect(out.quantity).toBe(3); // 3.33 -> 3
  });

  it("is not trimmed when the whole allowance fits", () => {
    const out = quantityWithinBudget({
      unitPriceWei: eth("0.0001"),
      maxSpendWei: eth("1"),
      dropMaxPerWallet: 5,
    });
    expect(out).toMatchObject({ quantity: 5, trimmed: false });
  });
});

describe("limits other than money", () => {
  it("never exceeds the drop's own per-wallet maximum", () => {
    // SeaDrop enforces this itself, so asking for more is a revert that still
    // pays gas rather than a bigger mint.
    const out = quantityWithinBudget({
      unitPriceWei: eth("0.0001"),
      maxSpendWei: eth("10"),
      dropMaxPerWallet: 3,
      requested: 50,
    });
    expect(out.quantity).toBe(3);
  });

  it("honours a smaller requested amount", () => {
    const out = quantityWithinBudget({
      unitPriceWei: 0n,
      maxSpendWei: 0n,
      dropMaxPerWallet: 20,
      requested: 2,
    });
    expect(out.quantity).toBe(2);
  });
});

describe("free drops", () => {
  it("are bounded only by the drop, since no price can exceed a cap", () => {
    const out = quantityWithinBudget({
      unitPriceWei: 0n,
      maxSpendWei: 0n,
      dropMaxPerWallet: 20,
    });
    expect(out).toMatchObject({ quantity: 20, trimmed: false });
  });

  it("keeps what a cap of zero has always meant: free only", () => {
    // A zero cap must still refuse anything priced, or turning the cap down
    // to its safest value would silently start spending.
    const paid = quantityWithinBudget({
      unitPriceWei: 1n,
      maxSpendWei: 0n,
      dropMaxPerWallet: 20,
    });
    expect(paid.quantity).toBe(0);
  });
});
