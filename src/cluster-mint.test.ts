import { describe, it, expect } from "vitest";
import { decideClusterMint, DEFAULT_CLUSTER_MINT, describeAsk, DecideOpts, ASK_TTL_MS } from "./cluster-mint";

const W = (n: string) => "0x" + n.repeat(40);

const opts = (over: Partial<DecideOpts> = {}): DecideOpts => ({
  settings: { ...DEFAULT_CLUSTER_MINT, enabled: true },
  clusterWallets: 4,
  kind: "mint",
  priceEth: 0,
  eligible: [W("a"), W("b"), W("c"), W("d")],
  maxPerWallet: 5,
  firedToday: 0,
  ...over,
});

describe("the line between free and paid", () => {
  it("fires a free mint on its own", () => {
    const d = decideClusterMint(opts());
    expect(d.action).toBe("fire");
  });

  it("NEVER fires a paid mint, however cheap", () => {
    // The whole safety property. A paid mint has exactly one path and it
    // goes through a human.
    for (const priceEth of [0.000001, 0.001, 0.05, 5]) {
      const d = decideClusterMint(
        opts({ priceEth, settings: { ...DEFAULT_CLUSTER_MINT, enabled: true, maxPriceEth: 100 } })
      );
      expect(d.action, `at ${priceEth}`).not.toBe("fire");
    }
  });

  it("asks about a paid mint when a ceiling has been set", () => {
    const d = decideClusterMint(
      opts({ priceEth: 0.01, settings: { ...DEFAULT_CLUSTER_MINT, enabled: true, maxPriceEth: 0.05 } })
    );
    expect(d.action).toBe("ask");
  });

  it("will not even ask when paid auto-mint was never enabled", () => {
    // maxPriceEth 0 is the shipped default: turning the feature on does not
    // by itself authorise spending anything.
    expect(DEFAULT_CLUSTER_MINT.maxPriceEth).toBe(0);
    const d = decideClusterMint(opts({ priceEth: 0.01 }));
    expect(d.action).toBe("skip");
    expect(d.why).toContain("not enabled");
  });

  it("will not ask above the ceiling", () => {
    const d = decideClusterMint(
      opts({ priceEth: 0.2, settings: { ...DEFAULT_CLUSTER_MINT, enabled: true, maxPriceEth: 0.05 } })
    );
    expect(d.action).toBe("skip");
    expect(d.why).toContain("over your 0.05 ceiling");
  });

  it("treats an unreadable price as paid, not as free", () => {
    // Assuming free is how a rule meant for free mints spends money.
    const d = decideClusterMint(opts({ priceEth: null }));
    expect(d.action).toBe("skip");
    expect(d.why).toContain("not safe to assume free");
  });
});

describe("when it declines to act at all", () => {
  it("is off until turned on", () => {
    expect(DEFAULT_CLUSTER_MINT.enabled).toBe(false);
    expect(decideClusterMint(opts({ settings: DEFAULT_CLUSTER_MINT })).action).toBe("skip");
  });

  it("ignores a crowd that was selling", () => {
    // Following a crowd OUT of a position by minting into it is backwards.
    for (const kind of ["sell", "sell-offer", "buy", "out"]) {
      expect(decideClusterMint(opts({ kind })).action, kind).toBe("skip");
    }
  });

  it("wants a bigger crowd than a mere notification does", () => {
    // Two wallets is enough to be TOLD. Spending deserves a higher bar.
    expect(DEFAULT_CLUSTER_MINT.minWallets).toBe(3);
    expect(decideClusterMint(opts({ clusterWallets: 2 })).action).toBe("skip");
  });

  it("does not buy what you already hold", () => {
    expect(decideClusterMint(opts({ alreadyHold: true })).action).toBe("skip");
  });

  it("stops for the day once it has fired enough", () => {
    const d = decideClusterMint(opts({ firedToday: DEFAULT_CLUSTER_MINT.maxPerDay }));
    expect(d.action).toBe("skip");
    expect(d.why).toContain("today");
  });

  it("does nothing with no eligible wallet", () => {
    expect(decideClusterMint(opts({ eligible: [] })).action).toBe("skip");
  });
});

describe("sizing", () => {
  it("uses no more wallets than configured", () => {
    const d = decideClusterMint(
      opts({ settings: { ...DEFAULT_CLUSTER_MINT, enabled: true, maxWallets: 2 } })
    );
    expect(d.action === "fire" && d.wallets).toHaveLength(2);
  });

  it("never asks for more than the stage allows", () => {
    const d = decideClusterMint(
      opts({ maxPerWallet: 1, settings: { ...DEFAULT_CLUSTER_MINT, enabled: true, quantityPerWallet: 9 } })
    );
    expect(d.action === "fire" && d.quantity).toBe(1);
  });

  it("totals the real spend across quantity and wallets", () => {
    const d = decideClusterMint(
      opts({
        priceEth: 0.01,
        settings: { ...DEFAULT_CLUSTER_MINT, enabled: true, maxPriceEth: 1, maxWallets: 3, quantityPerWallet: 2 },
      })
    );
    // 0.01 x 2 each x 3 wallets. A per-item price shown alone would read as
    // a sixth of what it actually costs.
    expect(d.action === "ask" && d.totalCostEth).toBeCloseTo(0.06, 9);
  });
});

describe("the confirmation message", () => {
  it("leads with the total, and says it will not act on its own", () => {
    const d = decideClusterMint(
      opts({ priceEth: 0.01, settings: { ...DEFAULT_CLUSTER_MINT, enabled: true, maxPriceEth: 1 } })
    );
    if (d.action !== "ask") throw new Error("expected ask");
    const text = describeAsk(d, "Vessels", "ETH", 0.01);
    expect(text).toContain("Total");
    expect(text).toContain("will not fire on its own");
  });

  it("expires quickly, because a stale tap is a tap on stale terms", () => {
    expect(ASK_TTL_MS).toBeLessThanOrEqual(5 * 60 * 1000);
  });
});
