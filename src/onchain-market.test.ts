import { describe, it, expect } from "vitest";
import { marketFromSales, bestValuation, describeBasis, describeMarket, EMPTY_MARKET } from "./onchain-market";
import { SaleRecord } from "./seaport-sales";
import { computePnl } from "./pnl";
import { headline, accent } from "./pnl-card";

const C1 = "0x" + "c".repeat(40);
const C2 = "0x" + "d".repeat(40);
const eth = (n: number) => BigInt(Math.round(n * 1e18));

const sale = (contract: string, priceEth: number, block: number): SaleRecord => ({
  contract, tokenId: "1", grossWei: eth(priceEth), proceedsWei: eth(priceEth * 0.95),
  seller: "0x" + "a".repeat(40), buyer: "0x" + "b".repeat(40),
  viaOffer: false, blockNumber: block, txHash: "0x",
});

describe("reading a market off the chain", () => {
  it("takes the newest sale as the last price, not the last in the array", () => {
    const m = marketFromSales(C1, [sale(C1, 0.5, 300), sale(C1, 0.1, 900), sale(C1, 0.3, 100)]);
    expect(m.lastSaleEth).toBeCloseTo(0.1, 9);
    expect(m.lastSaleBlock).toBe(900);
  });

  it("uses the median, because one fat finger moves a mean", () => {
    const m = marketFromSales(C1, [sale(C1, 0.1, 1), sale(C1, 0.1, 2), sale(C1, 10, 3)]);
    expect(m.medianSaleEth).toBeCloseTo(0.1, 9);
  });

  it("averages the middle two on an even count", () => {
    const m = marketFromSales(C1, [sale(C1, 0.1, 1), sale(C1, 0.2, 2), sale(C1, 0.3, 3), sale(C1, 0.4, 4)]);
    expect(m.medianSaleEth).toBeCloseTo(0.25, 9);
  });

  it("quotes gross, since that is what a buyer pays for one", () => {
    // Proceeds is the seller's side and belongs in P&L, not in "what does one
    // of these go for".
    expect(marketFromSales(C1, [sale(C1, 1, 1)]).lastSaleEth).toBeCloseTo(1, 9);
  });

  it("ignores other collections' sales", () => {
    expect(marketFromSales(C1, [sale(C2, 5, 1)]).sales).toBe(0);
  });

  it("reports a spread, so a thin market looks thin", () => {
    const m = marketFromSales(C1, [sale(C1, 0.1, 1), sale(C1, 2, 2)]);
    expect(m.lowEth).toBeCloseTo(0.1, 9);
    expect(m.highEth).toBeCloseTo(2, 9);
  });

  it("says nothing rather than zero when there are no sales", () => {
    const m = marketFromSales(C1, []);
    expect(m).toEqual(EMPTY_MARKET(C1));
    expect(m.lastSaleEth).toBe(null);
  });
});

describe("which price wins", () => {
  it("prefers settled sales over any standing order", () => {
    // The whole point. A floor is an ask and an offer is a bid; only a sale
    // is two people agreeing, and on a thin market the other two go stale.
    const m = marketFromSales(C1, [sale(C1, 0.5, 1), sale(C1, 0.5, 2)]);
    const v = bestValuation(m, 0.9, 1.5);
    expect(v.basis).toBe("settled");
    expect(v.eth).toBeCloseTo(0.5, 9);
  });

  it("takes a lone sale over an index, but knows it is one sale", () => {
    const v = bestValuation(marketFromSales(C1, [sale(C1, 0.4, 1)]), 0.9, 1.5);
    expect(v.basis).toBe("settled");
    expect(v.eth).toBeCloseTo(0.4, 9);
  });

  it("falls to the best bid before the floor", () => {
    // A bid can be taken right now; a floor is an ask nobody has met.
    const v = bestValuation(EMPTY_MARKET(C1), 0.9, 1.5);
    expect(v.basis).toBe("offer");
    expect(v.eth).toBe(0.9);
  });

  it("uses the floor only as a last resort", () => {
    const v = bestValuation(EMPTY_MARKET(C1), null, 1.5);
    expect(v.basis).toBe("floor");
  });

  it("admits when it has no price at all", () => {
    expect(bestValuation(EMPTY_MARKET(C1), null, null)).toEqual({ eth: null, basis: "none" });
  });

  it("names its basis in words, so a number is never mistaken for a sale", () => {
    expect(describeBasis("floor")).toContain("ask rather than a sale");
    expect(describeBasis("offer")).toContain("bid");
    expect(describeBasis("settled")).toContain("settled");
  });
});

describe("P&L built on a settled price", () => {
  const base = { quantity: 10, wallets: 2, mintPriceEth: 0.01, gasEth: 0.001, floorEth: 0.5, bestOfferEth: 0.4 };

  it("values the haul at what one actually sold for", () => {
    const pnl = computePnl({ ...base, settledEth: 0.3, settledSales: 5 });
    expect(pnl.settledValueEth).toBeCloseTo(3, 9);
    expect(pnl.profitAtSettledEth).toBeCloseTo(3 - 0.101, 6);
  });

  it("leaves the settled figures null when nothing has sold", () => {
    const pnl = computePnl(base);
    expect(pnl.settledValueEth).toBe(null);
    expect(pnl.profitAtSettledEth).toBe(null);
  });

  it("leads the card with the settled number when there is one", () => {
    expect(headline(computePnl({ ...base, settledEth: 0.3 })).unit).toBe("ETH AT LAST SALE");
    expect(headline(computePnl(base)).unit).not.toBe("ETH AT LAST SALE");
  });

  it("tints the card off the settled number, not a stale floor", () => {
    // A card tinted green off an ask nobody met is a lie with a colour on it.
    const green = accent(computePnl({ ...base, settledEth: 5 }));
    const red = accent(computePnl({ ...base, settledEth: 0.0001 }));
    expect(green).not.toBe(red);
  });
});

describe("describeMarket", () => {
  it("is empty when there is nothing to report, rather than saying zero", () => {
    expect(describeMarket(EMPTY_MARKET(C1), "ETH")).toBe("");
  });

  it("leads with how many sales it rests on", () => {
    const text = describeMarket(marketFromSales(C1, [sale(C1, 0.1, 1), sale(C1, 0.3, 2)]), "ETH");
    expect(text).toMatch(/^2 sales on-chain/);
    expect(text).toContain("median");
  });

  it("does not claim a median off a single sale", () => {
    expect(describeMarket(marketFromSales(C1, [sale(C1, 0.1, 1)]), "ETH")).not.toContain("median");
  });
});
