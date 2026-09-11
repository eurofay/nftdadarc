import { describe, it, expect } from "vitest";
import { CHAINS, resolveChain } from "./chains";
import { DEFAULT_SETTINGS_FOR_TEST } from "./telegram/store";

// The radar borrowed Auto Mint's chain list at first, which sounds tidy and is
// wrong: Auto Mint SPENDS on every chain it is given, so that list is kept
// deliberately short, and the radar only reads. Worse, the fallback was the
// single current chain — so it looked like it only knew one.

describe("the radar's default chains", () => {
  const keys = DEFAULT_SETTINGS_FOR_TEST().radarChainKeys ?? [];

  it("watches every chain that actually runs drops", () => {
    // Measured SeaDropMint traffic: robinhood 5,853/18min, ink 745/36min,
    // ethereum 130/3.3h, base 3/1.1h.
    for (const key of ["robinhood", "ethereum", "ink", "base"]) {
      expect(keys, `${key} should be watched by default`).toContain(key);
    }
  });

  it("leaves out the one with nothing to find", () => {
    // SeaDrop is deployed on Avalanche and nothing uses it: 0 drops and 0
    // mints across a 5.9 hour sample. Watching it is a poll loop that can
    // never fire, so it is opt-in from the picker rather than on by default.
    expect(keys).not.toContain("avalanche");
  });

  it("names only chains that exist", () => {
    for (const key of keys) expect(resolveChain(key), key).toBeDefined();
  });

  it("is not tied to the auto-mint list", () => {
    // Different jobs, different risk: one notifies, the other spends.
    const d = DEFAULT_SETTINGS_FOR_TEST();
    expect(d.radarChainKeys).not.toBe(d.autoChainKeys);
  });

  it("could watch every chain without changing anything else", () => {
    // Nothing about a chain makes it unwatchable, so the picker can offer all
    // of them; the default is a judgement about traffic, not capability.
    expect(CHAINS.every((c) => (c.rpc.logChunkBlocks ?? 0) > 0)).toBe(true);
  });
});
