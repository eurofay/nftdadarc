import { describe, it, expect } from "vitest";
import { describeStages, describeEligibility, Stage } from "./seadrop-stages";

const stage = (kind: Stage["kind"], present: boolean, mintable: boolean, detail = "x"): Stage => ({
  kind,
  present,
  mintable,
  detail,
});

describe("describeStages", () => {
  it("lists only the stages that actually exist", () => {
    const out = describeStages([
      stage("public", true, true, "anyone can mint"),
      stage("allowlist", false, false, "not configured"),
      stage("signed", true, false, "needs a signature from 0xfCe4"),
      stage("token-gated", false, false, "not configured"),
    ]);
    expect(out).toContain("public");
    expect(out).toContain("signed");
    expect(out).not.toContain("token-gated");
    expect(out).not.toContain("allowlist");
  });

  it("marks what can be fired and what cannot", () => {
    const out = describeStages([stage("public", true, true), stage("signed", true, false)]);
    expect(out).toMatch(/✅ public/);
    expect(out).toMatch(/🔒 signed/);
  });

  it("explains the dead end when nothing is mintable", () => {
    // The case the user hit: a live collection, no public stage, and the old
    // message just said "no public drop found".
    const out = describeStages([stage("signed", true, false, "needs a signature")]);
    expect(out).toMatch(/signature/);
    expect(out).toMatch(/on-chain data alone/);
  });

  it("stays quiet about the dead end when something IS mintable", () => {
    const out = describeStages([stage("public", true, true), stage("signed", true, false)]);
    expect(out).not.toMatch(/on-chain data alone/);
  });

  it("says so plainly when the contract has no stages at all", () => {
    const out = describeStages([
      stage("public", false, false),
      stage("allowlist", false, false),
      stage("signed", false, false),
      stage("token-gated", false, false),
    ]);
    expect(out).toMatch(/No mint stages are configured/);
    expect(out).toMatch(/may not be a SeaDrop collection/);
  });
});

describe("describeEligibility", () => {
  const base = { alreadyMinted: 0, maxPerWallet: 3, supplyRemaining: 100, canMint: 3 };

  it("says how many a wallet can actually take", () => {
    expect(describeEligibility("0xE607f2b18daE93e1f5D4c5a5C71b1d1070823ba0", base)).toContain("can mint 3");
  });

  it("explains a wallet that already used its allocation", () => {
    const out = describeEligibility("0xE607f2b1", {
      ...base,
      alreadyMinted: 3,
      canMint: 0,
      reason: "this wallet already minted its limit of 3",
    });
    expect(out).toContain("⛔");
    expect(out).toContain("already minted its limit");
  });

  it("explains a sold-out collection differently from a used-up wallet", () => {
    const out = describeEligibility("0xE607f2b1", {
      ...base,
      supplyRemaining: 0,
      canMint: 0,
      reason: "the collection is sold out",
    });
    expect(out).toContain("sold out");
  });

  it("flags when supply, not the wallet cap, is the binding limit", () => {
    // Minting the per-wallet max into a collection with 2 left reverts.
    const out = describeEligibility("0xE607f2b1", {
      ...base,
      supplyRemaining: 2,
      canMint: 2,
      reason: "only 2 left in the collection",
    });
    expect(out).toContain("can mint 2");
    expect(out).toContain("only 2 left");
  });
});
