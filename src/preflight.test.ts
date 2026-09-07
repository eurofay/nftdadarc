import { describe, it, expect } from "vitest";
import {
  SEADROP_ERRORS,
  revertSelector,
  explainRevert,
  describePreflight,
  selectorFor,
  Preflight,
} from "./preflight";

describe("the error table", () => {
  it("has the right selector for every signature it claims", () => {
    // Hand-written four-byte hashes are exactly the sort of thing that is
    // wrong and stays wrong, because a mismatch just looks like an unknown
    // error rather than a bug.
    const expected: Record<string, string> = {
      "IncorrectPayment(uint256,uint256)": "0x0d35e921",
      "InvalidProof()": "0x09bde339",
      "NotActive(uint256,uint256,uint256)": "0x13da22f2",
      "MintQuantityExceedsMaxMintedPerWallet(uint256,uint256)": "0xedc01273",
      "MintQuantityExceedsMaxSupply(uint256,uint256)": "0xe12d2314",
      "MintQuantityCannotBeZero()": "0x198441cb",
    };
    for (const [sig, sel] of Object.entries(expected)) {
      expect(selectorFor(sig)).toBe(sel);
      expect(SEADROP_ERRORS[sel]).toBeDefined();
    }
  });

  it("treats only NotActive as a pass when testing early", () => {
    // The whole point: being early is the correct outcome for an armed mint,
    // and every other revert is a real problem.
    const passing = Object.entries(SEADROP_ERRORS).filter(([, v]) => v.armedOk);
    expect(passing).toHaveLength(1);
    expect(passing[0][1].name).toBe("NotActive");
  });
});

describe("revertSelector", () => {
  it("finds the selector wherever the node put it", () => {
    const sel = "0x09bde339";
    expect(revertSelector({ data: sel + "00".repeat(8) })).toBe(sel);
    expect(revertSelector({ info: { error: { data: sel } } })).toBe(sel);
    expect(revertSelector({ error: { data: sel } })).toBe(sel);
  });

  it("lowercases, so a table lookup cannot miss on case", () => {
    expect(revertSelector({ data: "0x09BDE339" })).toBe("0x09bde339");
  });

  it("returns null rather than guessing", () => {
    expect(revertSelector({})).toBe(null);
    expect(revertSelector({ data: "0x" })).toBe(null);
    expect(revertSelector({ data: "not hex" })).toBe(null);
    expect(revertSelector(null)).toBe(null);
  });
});

describe("explainRevert", () => {
  it("reads NotActive as correctly armed, not as a failure", () => {
    const p = explainRevert("0x13da22f2");
    expect(p.onlyTooEarly).toBe(true);
    expect(p.errorName).toBe("NotActive");
  });

  it("reads InvalidProof as a real problem", () => {
    const p = explainRevert("0x09bde339");
    expect(p.onlyTooEarly).toBe(false);
    expect(p.detail).toContain("not on the list");
  });

  it("never claims success on a revert", () => {
    for (const sel of Object.keys(SEADROP_ERRORS)) {
      expect(explainRevert(sel).wouldSucceed).toBe(false);
    }
  });

  it("says plainly when a selector is not one it knows", () => {
    const p = explainRevert("0xdeadbeef");
    expect(p.errorName).toBe(null);
    expect(p.detail).toContain("0xdeadbeef");
  });

  it("falls back to the node's own words when there is no selector", () => {
    expect(explainRevert(null, "out of gas").detail).toBe("out of gas");
  });
});

describe("describePreflight", () => {
  const p = (over: Partial<Preflight>): Preflight => ({
    wouldSucceed: false,
    onlyTooEarly: false,
    selector: null,
    errorName: null,
    detail: "x",
    ...over,
  });

  it("distinguishes the three outcomes at a glance", () => {
    expect(describePreflight(p({ wouldSucceed: true }), "w1")).toContain("✅");
    expect(describePreflight(p({ onlyTooEarly: true }), "w1")).toContain("🕓");
    expect(describePreflight(p({}), "w1")).toContain("❌");
  });

  it("says an early mint is armed correctly rather than broken", () => {
    const out = describePreflight(p({ onlyTooEarly: true, detail: "the stage is not open yet" }), "l00p-4f2");
    expect(out).toContain("armed correctly");
    expect(out).toContain("l00p-4f2");
  });
});
