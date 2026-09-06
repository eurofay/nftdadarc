import { describe, it, expect } from "vitest";
import {
  resolveEarlyFire,
  flightTimeMs,
  describeEarlyFire,
  EARLY_FIRE_AUTO,
  EARLY_FIRE_CAP_MS,
  EARLY_FIRE_SAFETY,
} from "./early-fire";

describe("flightTimeMs", () => {
  it("is half the round trip, not all of it", () => {
    // Leading by the full round trip is the expensive mistake: it puts the
    // send a whole flight time before the stage opens.
    expect(flightTimeMs(15)).toBe(7.5);
  });
});

describe("resolveEarlyFire", () => {
  describe("off", () => {
    it("leads by nothing when the setting is zero", () => {
      expect(resolveEarlyFire(0, 15)).toBe(0);
    });

    it("leads by nothing for a nonsense setting", () => {
      expect(resolveEarlyFire(NaN, 15)).toBe(0);
      expect(resolveEarlyFire(-7, 15)).toBe(0);
    });
  });

  describe("auto", () => {
    it("leads by less than the one-way flight time", () => {
      // 15ms round trip -> 7.5ms in flight -> 5ms of lead.
      const lead = resolveEarlyFire(EARLY_FIRE_AUTO, 15);
      expect(lead).toBe(Math.floor(7.5 * EARLY_FIRE_SAFETY));
      expect(lead).toBeLessThan(flightTimeMs(15));
    });

    it("never leads by the full round trip", () => {
      for (const rtt of [2, 15, 40, 120]) {
        expect(resolveEarlyFire(EARLY_FIRE_AUTO, rtt)).toBeLessThan(rtt);
      }
    });

    it("sends at the stage start when nothing could be measured", () => {
      // No measurement is no basis for guessing, and guessing early costs a
      // reverted mint.
      expect(resolveEarlyFire(EARLY_FIRE_AUTO, null)).toBe(0);
      expect(resolveEarlyFire(EARLY_FIRE_AUTO, 0)).toBe(0);
      expect(resolveEarlyFire(EARLY_FIRE_AUTO, -5)).toBe(0);
      expect(resolveEarlyFire(EARLY_FIRE_AUTO, NaN)).toBe(0);
    });

    it("is negligible on an already-close path", () => {
      // In-region, there is nothing to compensate for.
      expect(resolveEarlyFire(EARLY_FIRE_AUTO, 1)).toBe(0);
    });

    it("caps a wild measurement rather than trusting it", () => {
      expect(resolveEarlyFire(EARLY_FIRE_AUTO, 10_000)).toBe(EARLY_FIRE_CAP_MS);
    });
  });

  describe("a fixed setting", () => {
    it("is honoured as given", () => {
      expect(resolveEarlyFire(8, 15)).toBe(8);
    });

    it("does not need a measurement", () => {
      expect(resolveEarlyFire(8, null)).toBe(8);
    });

    it("is still capped", () => {
      expect(resolveEarlyFire(5_000, 15)).toBe(EARLY_FIRE_CAP_MS);
    });

    it("is floored to whole milliseconds", () => {
      expect(resolveEarlyFire(8.9, 15)).toBe(8);
    });
  });
});

describe("describeEarlyFire", () => {
  it("says it is off, and why, when nothing was measured", () => {
    expect(describeEarlyFire(EARLY_FIRE_AUTO, null, 0)).toContain("could not be measured");
  });

  it("shows the measurement it reasoned from", () => {
    const out = describeEarlyFire(EARLY_FIRE_AUTO, 15, 5);
    expect(out).toContain("15ms");
    expect(out).toContain("5ms");
  });

  it("warns that a hand-set lead can land early", () => {
    expect(describeEarlyFire(20, null, 20)).toContain("reverts");
  });

  it("says plainly when it is simply off", () => {
    expect(describeEarlyFire(0, 15, 0)).toContain("off");
  });
});
