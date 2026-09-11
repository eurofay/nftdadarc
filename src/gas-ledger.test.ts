import { describe, it, expect } from "vitest";
import {
  GasEntry,
  entryCostWei,
  totalise,
  byWallet,
  byAction,
  byDay,
  shortEth,
  averageGwei,
  startOfDay,
  since,
} from "./gas-ledger";
import { renderGasReport, walletGasLine, windows } from "./gas-report";
import { effectivePriority } from "./gas-fit";
import { migrateGasSettings, LEGACY_GAS_DEFAULTS } from "./telegram/store";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const GWEI = 1_000_000_000;

const entry = (over: Partial<GasEntry> = {}): GasEntry => ({
  address: A,
  at: Date.now(),
  action: "Smart Mint",
  txHash: "0xabc",
  gasUsed: 100_000,
  effectiveGasPriceWei: String(0.106 * GWEI),
  ...over,
});

describe("what a transaction actually cost", () => {
  it("is gasUsed x effectiveGasPrice, not the limit or the bid", () => {
    // A real qty-1 mint measured on this chain: 100,254 gas at 0.110274 gwei.
    // The same transaction carried a 163,000 limit and a 0.21368 gwei bid --
    // quoting either would overstate the cost by roughly 2-3x, and the old
    // 250,000-limit / 2-gwei defaults would have overstated it by ~45x.
    const e = entry({ gasUsed: 100_254, effectiveGasPriceWei: String(0.110274 * GWEI) });
    expect(Number(entryCostWei(e)) / 1e18).toBeCloseTo(0.0000110554, 9);
  });

  it("counts reverted transactions, because the gas is gone either way", () => {
    const t = totalise([entry(), entry({ reverted: true })]);
    expect(t.entries).toBe(2);
    expect(t.wastedWei).toBe(entryCostWei(entry()));
    expect(t.costWei).toBe(entryCostWei(entry()) * 2n);
  });

  it("reports the average price paid, which is the overpaying signal", () => {
    const t = totalise([entry({ effectiveGasPriceWei: String(0.1 * GWEI) })]);
    expect(averageGwei(t)).toBeCloseTo(0.1, 6);
  });

  it("has no average to report when nothing was sent", () => {
    expect(averageGwei(totalise([]))).toBe(0);
  });
});

describe("breakdowns", () => {
  const rows = [
    entry({ address: A, action: "Smart Mint", gasUsed: 100_000 }),
    entry({ address: A, action: "Consolidate", gasUsed: 50_000 }),
    entry({ address: B, action: "Smart Mint", gasUsed: 400_000 }),
  ];

  it("puts the biggest spender first, since that is the one worth looking at", () => {
    expect(byWallet(rows).map((b) => b.key)).toEqual([B.toLowerCase(), A.toLowerCase()]);
  });

  it("groups by what the bot was doing", () => {
    const actions = byAction(rows);
    expect(actions[0].key).toBe("Smart Mint");
    expect(actions[0].totals.gasUsed).toBe(500_000);
  });

  it("reads a spend history backwards, newest day first", () => {
    const day = 86_400_000;
    const out = byDay([entry({ at: Date.now() - day * 2 }), entry({ at: Date.now() })]);
    expect(out[0].key > out[1].key).toBe(true);
  });
});

describe("windows", () => {
  it("counts from the start of the local day, not 24 hours back", () => {
    // "Today" means today. A rolling 24 hours would fold in yesterday evening
    // and quietly disagree with what the operator sees on a calendar.
    const now = new Date();
    now.setHours(9, 0, 0, 0);
    const start = startOfDay(0, now.getTime());
    expect(new Date(start).getHours()).toBe(0);
    expect(new Date(start).getDate()).toBe(now.getDate());
  });

  it("keeps only entries inside the window", () => {
    const day = 86_400_000;
    const rows = [entry({ at: Date.now() - day * 10 }), entry({ at: Date.now() })];
    expect(since(rows, windows().week.fromMs)).toHaveLength(1);
  });
});

describe("shortEth", () => {
  it("keeps small numbers legible instead of printing 18 decimals", () => {
    expect(shortEth(0n)).toBe("0");
    expect(shortEth(BigInt(11_055_409_596_000))).toBe("0.0000111");
    expect(shortEth(BigInt("1500000000000000"))).toBe("0.0015");
  });
});

describe("the report", () => {
  const opts = {
    symbol: "ETH",
    label: (a: string) => (a === A.toLowerCase() ? "l00p-111" : "l00p-222"),
  };

  it("says plainly when nothing was sent", () => {
    const text = renderGasReport({ entries: [], window: windows().today, ...opts });
    expect(text).toContain("Nothing sent in this window.");
    expect(text).not.toContain("BY WALLET");
  });

  it("names wallets the way the operator does", () => {
    const text = renderGasReport({ entries: [entry()], window: windows().all, ...opts });
    expect(text).toContain("l00p-111");
  });

  it("mentions wasted gas only when some was wasted", () => {
    const clean = renderGasReport({ entries: [entry()], window: windows().all, ...opts });
    expect(clean).not.toContain("reverted");
    const dirty = renderGasReport({ entries: [entry({ reverted: true })], window: windows().all, ...opts });
    expect(dirty).toContain("reverted");
  });

  it("skips the per-day breakdown when it would restate the headline", () => {
    const text = renderGasReport({ entries: [entry()], window: windows().today, ...opts });
    expect(text).not.toContain("BY DAY");
  });
});

describe("walletGasLine", () => {
  it("answers which wallet is eating the money", () => {
    expect(walletGasLine([entry()], A, "ETH")).toMatch(/over 1 tx/);
  });

  it("does not pretend an unused wallet has a bill", () => {
    expect(walletGasLine([entry()], B, "ETH")).toBe("no gas spent yet");
  });
});

describe("not paying for what the chain will not sell", () => {
  it("drops the tip where ordering is by arrival", () => {
    // Measured: base fee ~0.106 gwei and eth_maxPriorityFeePerGas answers 0.
    // A 0.05 gwei tip was a 47% surcharge that bought no position at all.
    expect(effectivePriority(BigInt(0.05 * GWEI), true)).toBe(0n);
  });

  it("leaves the tip alone where it does buy position", () => {
    expect(effectivePriority(BigInt(0.05 * GWEI), false)).toBe(BigInt(0.05 * GWEI));
  });
});

describe("the gas settings migration", () => {
  it("moves a store still on the old hand-set numbers to measured ones", () => {
    const out = migrateGasSettings({ ...LEGACY_GAS_DEFAULTS });
    expect(out.migrated).toBe(true);
    expect(out.settings).toMatchObject({ maxFeeGwei: 0, priorityGwei: 0, gasLimit: 0 });
  });

  it("never overwrites a number someone chose", () => {
    // Changing even one means these were looked at. Silently replacing the
    // other two would be overriding a decision, not fixing a default.
    const chosen = { ...LEGACY_GAS_DEFAULTS, maxFeeGwei: 5 };
    expect(migrateGasSettings(chosen)).toEqual({ settings: chosen, migrated: false });
  });

  it("leaves an already-migrated store alone", () => {
    const now = { maxFeeGwei: 0, priorityGwei: 0, gasLimit: 0 };
    expect(migrateGasSettings(now).migrated).toBe(false);
  });
});
