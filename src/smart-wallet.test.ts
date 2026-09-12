import { describe, it, expect } from "vitest";
import { positionsFor, summarise, dossierRows, summaryRow, describeDossier, Position } from "./smart-wallet";
import { toCsv } from "./wallet-csv";
import { MintRecord } from "./minter-scout";

const W = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const C1 = "0xAAAA111111111111111111111111111111111111";
const C2 = "0xBBBB222222222222222222222222222222222222";
const ETH = 10n ** 18n;

const rec = (minter: string, c: string, qty: number, unitWei: bigint, block = 1): MintRecord => ({
  nftContract: c, minter, blockNumber: block, logIndex: 0, txHash: "0x", quantity: qty, unitPriceWei: unitWei,
});

describe("what they minted and paid", () => {
  it("comes from the event, so the spend is exact rather than estimated", () => {
    const p = positionsFor(W, [rec(W, C1, 3, ETH / 100n), rec(W, C1, 2, ETH / 100n)]);
    expect(p[0].minted).toBe(5);
    expect(p[0].spentWei).toBe(ETH / 100n * 5n);
  });

  it("ignores everyone else's mints", () => {
    expect(positionsFor(W, [rec(OTHER, C1, 9, ETH)])).toHaveLength(0);
  });

  it("treats a zero quantity as one, rather than losing the mint", () => {
    expect(positionsFor(W, [rec(W, C1, 0, ETH)])[0].minted).toBe(1);
  });
});

describe("holdings and flips", () => {
  const pos = (over: Partial<Position>): Position =>
    ({ contract: C1, minted: 10, spentWei: ETH, ...over });

  it("counts what left the wallet", () => {
    const d = summarise(W, "robinhood", "ETH", [pos({ held: 2 })], { from: 0, to: 1 });
    expect(d.totals.flipped).toBe(8);
  });

  it("does not call an unreadable balance a flip", () => {
    // Unreadable and empty mean opposite things about whether they sold.
    const d = summarise(W, "robinhood", "ETH", [pos({ held: undefined })], { from: 0, to: 1 });
    expect(d.totals.heldItems).toBe(0);
    expect(d.totals.flipped).toBe(0);
  });

  it("never reports a negative flip, and does not fake a zero either", () => {
    // Holding more than the window saw minted means the history is older than
    // the window, not that nothing was sold. Clamping to 0 would state the
    // second with the confidence of a measurement.
    const d = summarise(W, "robinhood", "ETH", [pos({ minted: 2, held: 5 })], { from: 0, to: 1 });
    expect(d.totals.flipped).toBe(null);
  });
});

describe("a window that does not cover their whole history", () => {
  it("refuses to report a flip count it cannot know", () => {
    // Seen live: a wallet minting 62 in the scan window while holding 72.
    // The mint count is windowed and balanceOf is all-time, so subtracting
    // gives a negative that clamps to a confident, wrong "flipped 0".
    const d = summarise(W, "robinhood", "ETH",
      [{ contract: C1, minted: 62, spentWei: 0n, held: 72 }], { from: 0, to: 1 });
    expect(d.totals.flipped).toBe(null);
    expect(d.totals.partialHistory).toBe(true);
  });

  it("still counts the positions it can, and says the rest is partial", () => {
    const d = summarise(W, "robinhood", "ETH",
      [
        { contract: C1, minted: 10, spentWei: 0n, held: 2 },
        { contract: C2, minted: 5, spentWei: 0n, held: 9 },
      ],
      { from: 0, to: 1 }
    );
    expect(d.totals.flipped).toBe(8);
    expect(d.totals.partialHistory).toBe(true);
    expect(describeDossier(d)).toContain("predate this window");
  });

  it("leaves the CSV cell blank rather than guessing", () => {
    const d = summarise(W, "robinhood", "ETH",
      [{ contract: C1, minted: 62, spentWei: 0n, held: 72 }], { from: 0, to: 1 });
    expect(dossierRows(d)[0].flipped).toBe("");
  });
});

describe("valuing what is left", () => {
  it("prices held items at floor and charges them their share of cost", () => {
    // 10 minted for 1 ETH total, 2 held: those two cost 0.2, worth 0.6 at a
    // 0.3 floor, so +0.4 unrealised.
    const d = summarise(
      W, "robinhood", "ETH",
      [{ contract: C1, minted: 10, spentWei: ETH, held: 2, floorEth: 0.3 }],
      { from: 0, to: 1 }
    );
    expect(d.totals.heldFloorValueEth).toBeCloseTo(0.6, 6);
    expect(d.totals.unrealisedEth).toBeCloseTo(0.4, 6);
  });

  it("says null rather than zero when no floor is known", () => {
    // Treating an unknown price as nothing is how a portfolio quietly reports
    // a loss it does not have.
    const d = summarise(W, "robinhood", "ETH",
      [{ contract: C1, minted: 4, spentWei: ETH, held: 4 }], { from: 0, to: 1 });
    expect(d.totals.heldFloorValueEth).toBe(null);
    expect(d.totals.unrealisedEth).toBe(null);
  });

  it("still totals spend when nothing can be priced", () => {
    const d = summarise(W, "robinhood", "ETH",
      [{ contract: C1, minted: 4, spentWei: ETH * 2n }], { from: 0, to: 1 });
    expect(d.totals.spentEth).toBeCloseTo(2, 9);
  });
});

describe("the export", () => {
  const dossier = summarise(
    W, "robinhood", "ETH",
    [
      { contract: C1, name: "Vessels", minted: 10, spentWei: ETH, held: 2, floorEth: 0.3 },
      { contract: C2, minted: 1, spentWei: 0n, held: 1 },
    ],
    { from: 0, to: 1 }
  );

  it("writes a row per position, with the numbers a spreadsheet can sort", () => {
    const rows = dossierRows(dossier);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ collection: "Vessels", minted: 10, held: 2, flipped: 8 });
    expect(String(rows[0].spent_eth)).toBe("1.0000");
  });

  it("leaves unknown values blank instead of writing a made-up zero", () => {
    const rows = dossierRows(dossier);
    expect(rows[1].floor_eth).toBe("");
    expect(rows[1].profit_at_floor_eth).toBe("");
  });

  it("produces a CSV with a header and one line per row", () => {
    const csv = toCsv(dossierRows(dossier));
    expect(csv.split("\n")[0]).toContain("wallet,chain,collection,contract,minted");
    expect(csv.trim().split("\n")).toHaveLength(3);
  });

  it("summarises a wallet in one row, carrying its scout numbers", () => {
    const row = summaryRow(dossier, {
      address: W, label: "smart-1111", addedAt: 0, chainKey: "robinhood",
      scoutedScore: 13.76, scoutedEarliness: 0.88,
    });
    expect(row).toMatchObject({ label: "smart-1111", collections: 2, mints: 11, held: 3, flipped: 8 });
    expect(row.scout_score).toBe("13.76");
    expect(row.earliness_percent).toBe("88");
  });
});

describe("the written summary", () => {
  it("distinguishes what is settled from what is only an ask", () => {
    // The old caveat said a sale price is not on-chain. It is: Seaport
    // settles on-chain and emits the whole order. What stays uncertain is
    // only the part still unsold, valued at a floor, which is an ask.
    const text = describeDossier(
      summarise(W, "robinhood", "ETH",
        [{ contract: C1, minted: 10, spentWei: ETH, held: 2, floorEth: 0.3 }], { from: 0, to: 1 })
    );
    expect(text).toContain("Unrealised +0.4000 ETH");
    expect(text).toContain("ask rather than a sale");
  });

  it("leads with the settled number once something has sold", () => {
    const text = describeDossier(
      summarise(W, "robinhood", "ETH",
        [{ contract: C1, minted: 10, spentWei: ETH, held: 2, floorEth: 0.3, sold: 4, proceedsWei: ETH, wins: 4 }],
        { from: 0, to: 1 })
    );
    expect(text).toContain("Sold 4 on Seaport");
    expect(text).toContain("Realised");
    expect(text).toContain("100% of sales beat their mint cost");
  });

  it("names the chain's own currency", () => {
    const text = describeDossier(
      summarise(W, "avalanche", "AVAX", [{ contract: C1, minted: 2, spentWei: ETH }], { from: 0, to: 1 })
    );
    expect(text).toContain("AVAX");
  });
});
