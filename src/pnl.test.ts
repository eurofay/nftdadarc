import { describe, it, expect } from "vitest";
import { computePnl, eth, signedEth, pnlEmoji, renderPnl, PnlInputs, PnlReport } from "./pnl";

const base: PnlInputs = {
  quantity: 10,
  wallets: 5,
  mintPriceEth: 0.01,
  gasEth: 0.001,
  floorEth: 0.05,
  bestOfferEth: 0.03,
};

describe("computePnl", () => {
  it("multiplies the mint price by everything held", () => {
    expect(computePnl(base).mintCostEth).toBeCloseTo(0.1);
  });

  it("counts gas as part of what the haul cost", () => {
    expect(computePnl(base).totalCostEth).toBeCloseTo(0.101);
  });

  it("values the haul at floor and at the best offer separately", () => {
    const pnl = computePnl(base);
    expect(pnl.floorValueEth).toBeCloseTo(0.5);
    expect(pnl.offerValueEth).toBeCloseTo(0.3);
  });

  it("reports both profits, since only the offer one is realisable today", () => {
    const pnl = computePnl(base);
    expect(pnl.profitAtFloorEth).toBeCloseTo(0.399);
    expect(pnl.profitAtOfferEth).toBeCloseTo(0.199);
  });

  it("returns ROI against the total cost", () => {
    // 0.399 profit on 0.101 spent.
    expect(computePnl(base).roiPercent).toBeCloseTo(395.05, 1);
  });

  it("shows a loss as a negative rather than clamping at zero", () => {
    const pnl = computePnl({ ...base, floorEth: 0.001 });
    expect(pnl.profitAtFloorEth).toBeLessThan(0);
    expect(pnl.roiPercent).toBeLessThan(0);
  });

  it("gives the floor each item must reach to break even", () => {
    expect(computePnl(base).breakEvenFloorEth).toBeCloseTo(0.0101);
  });

  describe("free mints", () => {
    const free = { ...base, mintPriceEth: 0, gasEth: 0 };

    it("still values the haul", () => {
      expect(computePnl(free).profitAtFloorEth).toBeCloseTo(0.5);
    });

    it("has no ROI, because there is nothing to return against", () => {
      // A percentage return on zero is not infinity, it is meaningless.
      expect(computePnl(free).roiPercent).toBe(null);
    });

    it("has no break-even floor either", () => {
      expect(computePnl(free).breakEvenFloorEth).toBe(null);
    });
  });

  describe("missing data", () => {
    it("counts gas alone when the mint price is unknown", () => {
      // Nine wallets minting free is not free.
      const pnl = computePnl({ ...base, mintPriceEth: null });
      expect(pnl.mintCostEth).toBe(null);
      expect(pnl.totalCostEth).toBeCloseTo(0.001);
    });

    it("gives up on cost only when neither price nor gas is known", () => {
      const pnl = computePnl({ ...base, mintPriceEth: null, gasEth: null });
      expect(pnl.totalCostEth).toBe(null);
      expect(pnl.profitAtFloorEth).toBe(null);
    });

    it("reports no floor value when nothing is listed", () => {
      const pnl = computePnl({ ...base, floorEth: null });
      expect(pnl.floorValueEth).toBe(null);
      expect(pnl.profitAtFloorEth).toBe(null);
      // The offer side is unaffected — they are independent readings.
      expect(pnl.profitAtOfferEth).toBeCloseTo(0.199);
    });

    it("reports no offer value when there is no standing bid", () => {
      const pnl = computePnl({ ...base, bestOfferEth: null });
      expect(pnl.offerValueEth).toBe(null);
      expect(pnl.profitAtFloorEth).toBeCloseTo(0.399);
    });

    it("handles holding nothing without dividing by zero", () => {
      const pnl = computePnl({ ...base, quantity: 0 });
      expect(pnl.floorValueEth).toBe(0);
      expect(pnl.breakEvenFloorEth).toBe(null);
    });
  });
});

describe("eth", () => {
  it("keeps small values legible instead of rounding them to zero", () => {
    expect(eth(0.000123)).toBe("0.000123");
  });

  it("trims trailing zeros", () => {
    expect(eth(0.0001)).toBe("0.0001");
  });

  it("uses three decimals once past one", () => {
    expect(eth(12.3456)).toBe("12.346");
  });

  it("renders an unknown as a dash, not a zero", () => {
    expect(eth(null)).toBe("—");
    expect(eth(undefined)).toBe("—");
    expect(eth(NaN)).toBe("—");
  });

  it("keeps zero as zero", () => {
    expect(eth(0)).toBe("0");
  });

  it("formats a negative without losing the sign", () => {
    expect(eth(-0.5)).toBe("-0.5000");
  });
});

describe("signedEth", () => {
  it("marks a gain with a plus", () => {
    expect(signedEth(0.5)).toBe("+0.5000");
  });

  it("leaves a loss with its own minus", () => {
    expect(signedEth(-0.5)).toBe("-0.5000");
  });

  it("does not sign a dash", () => {
    expect(signedEth(null)).toBe("—");
  });
});

describe("pnlEmoji", () => {
  it("distinguishes gain, loss, flat and unknown", () => {
    expect(pnlEmoji(1)).toBe("🟢");
    expect(pnlEmoji(-1)).toBe("🔴");
    expect(pnlEmoji(0)).toBe("⚪");
    expect(pnlEmoji(null)).toBe("◦");
  });
});

describe("renderPnl", () => {
  const report: PnlReport = {
    ...base,
    name: "Glitchy",
    contract: "0x54953Ce3802fCE0c94DF335c0d819521cB3Ea903",
    symbol: "ETH",
    priceSource: "stage",
    breakdown: [
      { address: "0xaaa", label: "Wallet 1", count: 6 },
      { address: "0xbbb", label: "Wallet 2", count: 4 },
    ],
  };

  it("leads with the count, which is the only certain number", () => {
    const out = renderPnl(report, computePnl(report));
    expect(out.indexOf("Held: *10* across *5* wallet(s)")).toBeGreaterThan(-1);
    expect(out.indexOf("Held:")).toBeLessThan(out.indexOf("Floor"));
  });

  it("shows both the floor and the offer P&L", () => {
    const out = renderPnl(report, computePnl(report));
    expect(out).toContain("At floor");
    expect(out).toContain("At offer");
  });

  it("says which number can actually be acted on", () => {
    expect(renderPnl(report, computePnl(report))).toContain("what you'd get selling now");
  });

  it("drops that note when there is no bid, rather than dangling it off a dash", () => {
    const noBid: PnlReport = { ...report, bestOfferEth: null };
    const out = renderPnl(noBid, computePnl(noBid));
    expect(out).toContain("nobody is bidding");
    expect(out).not.toContain("what you'd get selling now");
  });

  it("breaks the holding down per wallet", () => {
    const out = renderPnl(report, computePnl(report));
    expect(out).toContain("Wallet 1 — 6");
    expect(out).toContain("Wallet 2 — 4");
  });

  it("truncates a long wallet list rather than flooding the message", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      address: `0x${i}`,
      label: `Wallet ${i}`,
      count: 1,
    }));
    const out = renderPnl({ ...report, breakdown: many }, computePnl(report));
    expect(out).toContain("…and 5 more");
  });

  it("flags the mint price as the stage price, not what was paid", () => {
    const out = renderPnl(report, computePnl(report));
    expect(out).toContain("not what each wallet actually paid");
  });

  it("says plainly when there is no stage price to use", () => {
    const unknown: PnlReport = { ...report, mintPriceEth: null, priceSource: "unknown" };
    const out = renderPnl(unknown, computePnl(unknown));
    expect(out).toContain("no readable stage price");
  });

  it("distinguishes an empty market from a zero price", () => {
    const dark: PnlReport = { ...report, floorEth: null, bestOfferEth: null };
    const out = renderPnl(dark, computePnl(dark));
    expect(out).toContain("nothing listed");
    expect(out).toContain("no standing bid");
    expect(out).toContain("no market data");
  });

  it("keeps the caveats to one closing line rather than hedging every row", () => {
    const out = renderPnl(report, computePnl(report));
    expect(out.split("\n").filter((l) => l.startsWith("_Estimates:"))).toHaveLength(1);
  });
});
