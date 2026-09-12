import { describe, it, expect } from "vitest";
import { decodeSale, salesByCollection, SaleRecord } from "./seaport-sales";
import { rankByProfit, profitScout, profitScore, whyProfit, MIN_SALES, ROUND_TRIP_GAS_ETH } from "./profit-scout";
import { MintRecord } from "./minter-scout";
import { attachSales, summarise, positionsFor } from "./smart-wallet";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const C1 = "0x" + "c".repeat(40);
const C2 = "0x" + "d".repeat(40);
const ETH = 10n ** 18n;

const mint = (minter: string, c: string, qty: number, unitWei: bigint): MintRecord => ({
  nftContract: c, minter, blockNumber: 1, logIndex: 0, txHash: "0x", quantity: qty, unitPriceWei: unitWei,
});

const sale = (seller: string, c: string, proceedsWei: bigint, over: Partial<SaleRecord> = {}): SaleRecord => ({
  contract: c, tokenId: "1", grossWei: proceedsWei, proceedsWei, seller, buyer: B,
  viaOffer: false, blockNumber: 2, txHash: "0x", ...over,
});

describe("cost basis", () => {
  it("ignores a sale of something they did not mint here", () => {
    // No mint means no cost. Counting it at zero would invent a profit equal
    // to the entire sale price, putting pure resellers at the top.
    const out = rankByProfit([], [sale(A, C1, ETH)]);
    expect(out).toHaveLength(0);
  });

  it("matches a sale to the mint of the same collection", () => {
    const out = rankByProfit(
      [mint(A, C1, 10, ETH / 100n)],
      [1, 2, 3].map(() => sale(A, C1, ETH / 10n))
    );
    expect(out[0].sold).toBe(3);
    // 3 sold at 0.1 each = 0.3 proceeds, cost 0.01 each = 0.03.
    expect(out[0].realisedEth).toBeCloseTo(0.27, 6);
  });

  it("attributes cost per item, not per mint transaction", () => {
    const out = rankByProfit([mint(A, C1, 4, ETH)], [sale(A, C1, ETH * 2n)]);
    expect(out[0].costEth).toBeCloseTo(1, 9);
  });
});

describe("win rate", () => {
  it("does not count a sale that failed to clear the gas it cost", () => {
    // The flaw the live data exposed. On a chain of free mints, cost is zero,
    // so ANY sale "beat its cost" and the whole table read 100% — a metric
    // that flattered exactly the wallets worth avoiding.
    const tiny = ROUND_TRIP_GAS_ETH / 2;
    const out = rankByProfit(
      [mint(A, C1, 5, 0n)],
      [1, 2, 3].map(() => sale(A, C1, BigInt(Math.round(tiny * 1e18))))
    );
    expect(out[0].winRate).toBe(0);
  });

  it("counts one that clears cost and gas", () => {
    const out = rankByProfit(
      [mint(A, C1, 5, 0n)],
      [1, 2, 3].map(() => sale(A, C1, ETH / 100n))
    );
    expect(out[0].winRate).toBe(1);
  });

  it("reports the rate, not just the total", () => {
    const out = rankByProfit(
      [mint(A, C1, 4, 0n)],
      [sale(A, C1, ETH), sale(A, C1, 1n), sale(A, C1, 1n), sale(A, C1, 1n)]
    );
    // One huge win among four sales is a 25% rate, however big the total.
    expect(out[0].winRate).toBe(0.25);
    expect(out[0].realisedEth).toBeGreaterThan(0);
  });
});

describe("scoring", () => {
  const stats = (over: Partial<Parameters<typeof profitScore>[0]> = {}) => ({
    address: A, collections: 1, sold: 10, proceedsEth: 1, costEth: 0.5,
    realisedEth: 0.5, winRate: 1, bestSaleEth: 0.2, perSaleEth: 0.05, ...over,
  });

  it("ignores a wallet with too few sales to have a rate", () => {
    expect(profitScore(stats({ sold: MIN_SALES - 1 }))).toBe(0);
  });

  it("ignores a wallet that lost money overall", () => {
    expect(profitScore(stats({ realisedEth: -0.1 }))).toBe(0);
  });

  it("prefers consistent over lucky at similar profit", () => {
    // Copying buys their NEXT trade, which resembles the median rather than
    // the best one they ever had.
    const steady = profitScore(stats({ winRate: 0.95, realisedEth: 0.4 }));
    const lucky = profitScore(stats({ winRate: 0.2, realisedEth: 0.5 }));
    expect(steady).toBeGreaterThan(lucky);
  });

  it("still rewards size, just not linearly", () => {
    const big = profitScore(stats({ realisedEth: 5 }));
    const small = profitScore(stats({ realisedEth: 0.5 }));
    expect(big).toBeGreaterThan(small);
    expect(big).toBeLessThan(small * 10);
  });
});

describe("profitScout", () => {
  const mints = [mint(A, C1, 10, 0n), mint(B, C2, 10, 0n)];
  const sales = [
    ...[1, 2, 3, 4].map(() => sale(A, C1, ETH / 10n)),
    ...[1, 2, 3, 4].map(() => sale(B, C2, ETH / 10n)),
  ];

  it("can filter to a minimum win rate", () => {
    expect(profitScout(mints, sales, { minWinRate: 1 }).length).toBeGreaterThan(0);
    expect(profitScout(mints, sales, { minWinRate: 1.1 })).toHaveLength(0);
  });

  it("leaves out wallets already held or watched", () => {
    expect(profitScout(mints, sales, { exclude: [A] }).map((m) => m.address)).not.toContain(A.toLowerCase());
  });

  it("leads its reason with the rate, not the total", () => {
    expect(whyProfit(profitScout(mints, sales, { limit: 1 })[0])).toMatch(/^\d+% win rate/);
  });
});

describe("the dossier's realised numbers", () => {
  it("fills in sold, proceeds and realised from actual sales", () => {
    const records = [mint(A, C1, 10, ETH / 100n)];
    const withSales = attachSales(A, positionsFor(A, records), [
      sale(A, C1, ETH / 10n),
      sale(A, C1, ETH / 10n),
    ]);
    const d = summarise(A, "robinhood", "ETH", withSales, { from: 0, to: 1 });
    expect(d.totals.sold).toBe(2);
    expect(d.totals.proceedsEth).toBeCloseTo(0.2, 6);
    expect(d.totals.realisedEth).toBeCloseTo(0.18, 6); // 0.2 proceeds - 0.02 cost
  });

  it("says null rather than zero when nothing sold", () => {
    const d = summarise(A, "robinhood", "ETH", positionsFor(A, [mint(A, C1, 3, 0n)]), { from: 0, to: 1 });
    expect(d.totals.sold).toBe(0);
    expect(d.totals.realisedEth).toBe(null);
    expect(d.totals.winRate).toBe(null);
  });
});

describe("salesByCollection", () => {
  it("keeps only this wallet's sales", () => {
    const out = salesByCollection(A, [sale(A, C1, ETH), sale(B, C1, ETH)]);
    expect(out.get(C1.toLowerCase())).toHaveLength(1);
  });
});

describe("decodeSale", () => {
  it("returns null for a log that is not an order", () => {
    expect(decodeSale({ data: "0x", topics: [], blockNumber: 1, transactionHash: "0x" })).toBe(null);
  });
});
