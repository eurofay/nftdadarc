import { describe, it, expect } from "vitest";
import { diffCollection, pctChange } from "./activity-watcher";

const OPTS = { sweepSalesThreshold: 3, floorMovePct: 10, offerVsFloorPct: 80 };
const base = { totalSales: 100, floor: 0.01, bestOfferHash: null };

describe("pctChange", () => {
  it("computes a normal percentage move", () => {
    expect(pctChange(0.01, 0.012)).toBeCloseTo(20);
    expect(pctChange(0.01, 0.008)).toBeCloseTo(-20);
  });

  it("treats a move away from zero as +100% rather than dividing by zero", () => {
    expect(pctChange(0, 5)).toBe(100);
    expect(pctChange(0, 0)).toBe(0);
  });
});

describe("diffCollection", () => {
  it("flags a burst of sales as a possible sweep", () => {
    const alerts = diffCollection("X", "x", base, { ...base, totalSales: 104 }, OPTS);
    expect(alerts.some((a) => a.includes("possible sweep"))).toBe(true);
    expect(alerts.some((a) => a.includes("4 sales"))).toBe(true);
  });

  it("stays quiet for sales below the sweep threshold", () => {
    const alerts = diffCollection("X", "x", base, { ...base, totalSales: 102 }, OPTS);
    expect(alerts).toEqual([]);
  });

  it("flags a floor move up and down once it clears the noise threshold", () => {
    expect(diffCollection("X", "x", base, { ...base, floor: 0.02 }, OPTS)[0]).toContain("up");
    expect(diffCollection("X", "x", base, { ...base, floor: 0.005 }, OPTS)[0]).toContain("down");
  });

  it("ignores floor wobble under the threshold", () => {
    // 5% move, threshold is 10%
    expect(diffCollection("X", "x", base, { ...base, floor: 0.0105 }, OPTS)).toEqual([]);
  });

  it("reports the first listing appearing on a previously unlisted collection", () => {
    const alerts = diffCollection("X", "x", { ...base, floor: null }, { ...base, floor: 0.05 }, OPTS);
    expect(alerts[0]).toContain("first listing");
  });

  it("says nothing when a collection goes from listed to unlisted", () => {
    // Everything delisting is not a price signal, and has no percentage.
    expect(diffCollection("X", "x", base, { ...base, floor: null }, OPTS)).toEqual([]);
  });

  it("can report a sweep and a floor move together", () => {
    const alerts = diffCollection("X", "x", base, { totalSales: 110, floor: 0.02, bestOfferHash: null }, OPTS);
    expect(alerts).toHaveLength(2);
  });

  it("includes the collection's OpenSea link in every alert", () => {
    const alerts = diffCollection("X", "osborns", base, { totalSales: 110, floor: 0.02, bestOfferHash: null }, OPTS);
    for (const a of alerts) expect(a).toContain("https://opensea.io/collection/osborns");
  });
});
