import { describe, it, expect } from "vitest";
import { stageWindow, assessWallet, describeReadiness, needsQuantityStep } from "./mint-readiness";

const GWEI = 1_000_000_000n;
const A = "0xE607f2b18daE93e1f5D4c5a5C71b1d1070823ba0";
const mask = (a: string) => a.slice(0, 6);

const base = {
  balanceWei: 1_000_000_000_000_000_000n, // 1 ETH — never the binding limit
  mintPriceWei: 0n,
  maxFeePerGas: GWEI / 2n, // 0.5 gwei, the configured ceiling
  gasLimit: 0, // auto-size
  maxPerWallet: 5,
  alreadyMinted: 0,
  supplyRemaining: 1000,
};

describe("stageWindow", () => {
  const now = 1_800_000_000_000;
  const s = (t: number) => Math.floor(t / 1000);

  it("is live between start and end", () => {
    const w = stageWindow(s(now - 60_000), s(now + 60_000), now);
    expect(w.live).toBe(true);
    expect(w.opensInMs).toBe(0);
    expect(w.ended).toBe(false);
  });

  it("reports how long until it opens", () => {
    const w = stageWindow(s(now + 30_000), s(now + 90_000), now);
    expect(w.live).toBe(false);
    expect(w.opensInMs).toBeGreaterThan(25_000);
  });

  it("knows when it has closed", () => {
    const w = stageWindow(s(now - 90_000), s(now - 30_000), now);
    expect(w.ended).toBe(true);
    expect(w.live).toBe(false);
  });

  it("treats endTime 0 as unconfigured, not open forever", () => {
    // A drop with no end time set isn't a permanent mint — it's a stage that
    // was never configured, and firing at it wastes gas.
    const w = stageWindow(0, 0, now);
    expect(w.live).toBe(false);
    expect(w.ended).toBe(true);
  });
});

describe("assessWallet", () => {
  it("allows the full cap when nothing binds", () => {
    const r = assessWallet(A, base);
    expect(r.canMint).toBe(5);
    expect(r.reason).toBeUndefined();
  });

  it("subtracts what the wallet already minted", () => {
    const r = assessWallet(A, { ...base, alreadyMinted: 3 });
    expect(r.canMint).toBe(2);
  });

  it("refuses a wallet that used its whole allocation", () => {
    const r = assessWallet(A, { ...base, alreadyMinted: 5 });
    expect(r.canMint).toBe(0);
    expect(r.reason).toMatch(/already minted its limit/);
  });

  it("caps at remaining supply, since minting past it reverts", () => {
    const r = assessWallet(A, { ...base, supplyRemaining: 2 });
    expect(r.canMint).toBe(2);
    expect(r.reason).toMatch(/only 2 left/);
  });

  it("says sold out rather than blaming the wallet", () => {
    const r = assessWallet(A, { ...base, supplyRemaining: 0 });
    expect(r.canMint).toBe(0);
    expect(r.reason).toMatch(/sold out/);
  });

  it("caps at what the balance can actually reserve", () => {
    // Enough for a couple of paid mints, not five. The node reserves
    // gasLimit x maxFee PLUS the price, so the price alone understates it.
    const price = 10_000_000_000_000_000n; // 0.01 ETH
    const r = assessWallet(A, {
      ...base,
      mintPriceWei: price,
      balanceWei: price * 2n + 1_000_000_000_000_000n,
    });
    expect(r.canMint).toBeLessThan(5);
    expect(r.canMint).toBeGreaterThan(0);
    expect(r.reason).toMatch(/balance covers/);
  });

  it("refuses when the balance can't even cover one", () => {
    const r = assessWallet(A, { ...base, balanceWei: 1n });
    expect(r.canMint).toBe(0);
    expect(r.reason).toMatch(/not enough for gas/);
  });

  it("counts the reservation, not just the price — the usual surprise", () => {
    // Exactly the mint price and nothing more: affordable on price, and still
    // unable to send.
    const price = 1_000_000_000_000_000n;
    const r = assessWallet(A, { ...base, mintPriceWei: price, balanceWei: price, maxPerWallet: 1 });
    expect(r.canMint).toBe(0);
  });

  it("honours a smaller requested amount", () => {
    expect(assessWallet(A, { ...base, requested: 2 }).canMint).toBe(2);
  });

  it("never exceeds the chain's limit just because more was requested", () => {
    expect(assessWallet(A, { ...base, maxPerWallet: 2, requested: 10 }).canMint).toBe(2);
  });

  it("treats an unknown balance as no constraint rather than blocking", () => {
    const r = assessWallet(A, { ...base, balanceWei: null });
    expect(r.canMint).toBe(5);
  });
});

describe("needsQuantityStep", () => {
  it("skips the question when only one can be minted", () => {
    // Asking "how many?" when the answer can only be 1 is a tap between the
    // user and a live stage.
    const one = assessWallet(A, { ...base, maxPerWallet: 1 });
    expect(needsQuantityStep([one])).toBe(false);
  });

  it("asks when more is available", () => {
    expect(needsQuantityStep([assessWallet(A, base)])).toBe(true);
  });

  it("asks when any single wallet can take more than one", () => {
    const one = assessWallet(A, { ...base, maxPerWallet: 1 });
    const many = assessWallet(A, base);
    expect(needsQuantityStep([one, many])).toBe(true);
  });

  it("skips when nothing is mintable at all", () => {
    expect(needsQuantityStep([assessWallet(A, { ...base, supplyRemaining: 0 })])).toBe(false);
  });
});

describe("describeReadiness", () => {
  it("leads with the count a wallet can take", () => {
    expect(describeReadiness(assessWallet(A, base), mask)).toContain("5");
  });

  it("gives the reason when something is blocking", () => {
    const r = assessWallet(A, { ...base, alreadyMinted: 5 });
    expect(describeReadiness(r, mask)).toMatch(/⛔.*already minted/);
  });
});
