import { describe, it, expect } from "vitest";
import { describeStages, Stage } from "./seadrop-stages";

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
