import { describe, it, expect } from "vitest";
import {
  Activity,
  ClusterTracker,
  isNoteworthy,
  describeActivity,
  describeCluster,
  CLUSTER_WINDOW_MS,
  CLUSTER_MIN_WALLETS,
} from "./wallet-activity";

const C1 = "0x" + "c".repeat(40);
const C2 = "0x" + "d".repeat(40);
const W = (n: string) => "0x" + n.repeat(40);
const ETH = 10n ** 18n;

const act = (over: Partial<Activity> = {}): Activity => ({
  kind: "mint", wallet: W("a"), contract: C1, blockNumber: 1, txHash: "0x", ...over,
});

describe("what is worth waking you for", () => {
  it("stays quiet about something merely arriving", () => {
    // A transfer in is usually the other leg of an event already reported, or
    // an airdrop nobody asked for.
    expect(isNoteworthy(act({ kind: "in" }))).toBe(false);
  });

  it("reports a wallet moving inventory out", () => {
    // It may be shifting stock before selling somewhere this cannot see.
    expect(isNoteworthy(act({ kind: "out" }))).toBe(true);
  });

  it("reports every way money changes hands", () => {
    for (const kind of ["mint", "buy", "sell", "sell-offer"] as const) {
      expect(isNoteworthy(act({ kind })), kind).toBe(true);
    }
  });
});

describe("clustering", () => {
  it("says nothing about one wallet acting alone", () => {
    const t = new ClusterTracker();
    expect(t.note(act(), 1000)).toBe(null);
  });

  it("fires once several wallets hit the same collection", () => {
    const t = new ClusterTracker();
    t.note(act({ wallet: W("a") }), 1000);
    const c = t.note(act({ wallet: W("b") }), 2000);
    expect(c?.wallets).toHaveLength(2);
    expect(CLUSTER_MIN_WALLETS).toBe(2);
  });

  it("does not count one busy wallet as a crowd", () => {
    // Minting five times is one opinion held firmly, not five opinions.
    const t = new ClusterTracker();
    for (let i = 0; i < 5; i++) expect(t.note(act({ wallet: W("a") }), 1000 + i)).toBe(null);
  });

  it("does not repeat itself at the same size", () => {
    const t = new ClusterTracker();
    t.note(act({ wallet: W("a") }), 1000);
    expect(t.note(act({ wallet: W("b") }), 2000)).not.toBe(null);
    expect(t.note(act({ wallet: W("b") }), 3000)).toBe(null);
  });

  it("speaks up again when the crowd grows", () => {
    // Two is news. Five, having been told about two, is also news.
    const t = new ClusterTracker();
    t.note(act({ wallet: W("a") }), 1000);
    expect(t.note(act({ wallet: W("b") }), 1100)).not.toBe(null);
    expect(t.note(act({ wallet: W("c") }), 1200)?.wallets).toHaveLength(3);
  });

  it("keeps buying and selling apart", () => {
    // Four wallets minting and four dumping are opposite messages; merged,
    // the cluster would mean nothing at all.
    const t = new ClusterTracker();
    t.note(act({ wallet: W("a"), kind: "mint" }), 1000);
    expect(t.note(act({ wallet: W("b"), kind: "sell" }), 1100)).toBe(null);
  });

  it("treats both ways of selling as one behaviour", () => {
    const t = new ClusterTracker();
    t.note(act({ wallet: W("a"), kind: "sell" }), 1000);
    expect(t.note(act({ wallet: W("b"), kind: "sell-offer" }), 1100)).not.toBe(null);
  });

  it("keeps collections apart", () => {
    const t = new ClusterTracker();
    t.note(act({ wallet: W("a"), contract: C1 }), 1000);
    expect(t.note(act({ wallet: W("b"), contract: C2 }), 1100)).toBe(null);
  });

  it("does not join up wallets hours apart", () => {
    const t = new ClusterTracker();
    t.note(act({ wallet: W("a") }), 1000);
    expect(t.note(act({ wallet: W("b") }), 1000 + CLUSTER_WINDOW_MS + 1)).toBe(null);
  });

  it("totals what the crowd spent", () => {
    const t = new ClusterTracker();
    t.note(act({ wallet: W("a"), valueWei: ETH }), 1000);
    const c = t.note(act({ wallet: W("b"), valueWei: ETH * 2n }), 1100);
    expect(c?.totalValueWei).toBe(ETH * 3n);
  });

  it("forgets what aged out, and can cluster again after", () => {
    const t = new ClusterTracker();
    t.note(act({ wallet: W("a") }), 1000);
    t.note(act({ wallet: W("b") }), 1100);
    // Past the window measured from the LAST entry, not the first — the
    // second wallet was recorded 100ms later and is legitimately still live
    // until its own window closes.
    t.prune(1100 + CLUSTER_WINDOW_MS + 1);
    expect(t.size).toBe(0);
    t.note(act({ wallet: W("a") }), 9_000_000);
    expect(t.note(act({ wallet: W("b") }), 9_000_100)).not.toBe(null);
  });
});

describe("wording", () => {
  it("says free rather than 0.0000", () => {
    expect(describeActivity(act({ valueWei: 0n }), "l00p-1", "Vessels", "ETH")).toContain("free");
  });

  it("names the price when one was paid", () => {
    expect(describeActivity(act({ kind: "buy", valueWei: ETH / 2n }), "l00p-1", "Vessels", "ETH"))
      .toContain("0.5000 ETH");
  });

  it("shows a quantity only when there was more than one", () => {
    expect(describeActivity(act({ quantity: 3 }), "l00p-1", "V", "ETH")).toContain("×3");
    expect(describeActivity(act({ quantity: 1 }), "l00p-1", "V", "ETH")).not.toContain("×1");
  });

  it("uses the chain's own currency", () => {
    expect(describeActivity(act({ valueWei: ETH }), "w", "V", "AVAX")).toContain("AVAX");
  });

  it("leads a cluster with how many wallets, since that is the signal", () => {
    const t = new ClusterTracker();
    t.note(act({ wallet: W("a") }), 1000);
    const c = t.note(act({ wallet: W("b") }), 1100)!;
    const text = describeCluster(c, "Vessels", "ETH", (a) => a.slice(0, 6));
    expect(text).toContain("2 smart wallets minting Vessels");
  });
});
