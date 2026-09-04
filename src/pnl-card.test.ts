import { describe, it, expect } from "vitest";
import { accent, headline, fit, renderPnlCard } from "./pnl-card";
import { computePnl, PnlReport } from "./pnl";
import { PALETTE } from "./mint-card";

const report: PnlReport = {
  name: "Glitchy",
  contract: "0x54953Ce3802fCE0c94DF335c0d819521cB3Ea903",
  symbol: "ETH",
  quantity: 10,
  wallets: 5,
  mintPriceEth: 0.01,
  gasEth: 0.001,
  floorEth: 0.05,
  bestOfferEth: 0.03,
  priceSource: "stage",
  breakdown: [],
};

describe("accent", () => {
  it("is green when the offer clears the cost", () => {
    expect(accent(computePnl(report))).toBe(PALETTE.mint);
  });

  it("is red when it does not", () => {
    expect(accent(computePnl({ ...report, bestOfferEth: 0.0001 }))).toBe(PALETTE.ember);
  });

  it("follows the offer, not the flattering floor", () => {
    // Floor says +0.4; the best anyone will actually pay says a loss. A P&L
    // card that goes green on an ask nobody has accepted is lying politely.
    const optimistic = { ...report, floorEth: 10, bestOfferEth: 0.0001 };
    expect(accent(computePnl(optimistic))).toBe(PALETTE.ember);
  });

  it("stays neutral when there is nothing to compare against", () => {
    const dark = { ...report, floorEth: null, bestOfferEth: null };
    expect(accent(computePnl(dark))).toBe(PALETTE.flame);
  });
});

describe("headline", () => {
  it("leads with what you would get selling now", () => {
    expect(headline(computePnl(report))).toMatchObject({ unit: "ETH IF SOLD NOW" });
  });

  it("signs a gain", () => {
    expect(headline(computePnl(report)).value.startsWith("+")).toBe(true);
  });

  it("falls back to the floor when there is no bid", () => {
    expect(headline(computePnl({ ...report, bestOfferEth: null }))).toMatchObject({
      unit: "ETH AT FLOOR",
    });
  });

  it("says so plainly when there is no market at all", () => {
    const dark = { ...report, floorEth: null, bestOfferEth: null };
    expect(headline(computePnl(dark))).toEqual({ value: "—", unit: "NO MARKET YET" });
  });

  it("still leads with the floor value when cost is unknown", () => {
    const noCost = { ...report, mintPriceEth: null, gasEth: null, bestOfferEth: null };
    expect(headline(computePnl(noCost))).toMatchObject({ unit: "ETH AT FLOOR" });
  });
});

describe("fit", () => {
  it("leaves a short name alone", () => {
    expect(fit("Glitchy", 20)).toBe("Glitchy");
  });

  it("truncates a long one with an ellipsis", () => {
    expect(fit("A".repeat(40), 10)).toBe("AAAAAAAAA…");
  });
});

describe("renderPnlCard", () => {
  const svg = renderPnlCard({ report, pnl: computePnl(report) });

  it("produces a self-contained svg", () => {
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("shows the collection art when there is some", () => {
    const withArt = renderPnlCard({
      report,
      pnl: computePnl(report),
      artHref: "https://example.test/art.png",
    });
    expect(withArt).toContain('href="https://example.test/art.png"');
  });

  it("falls back to a monogram rather than an empty panel", () => {
    expect(svg).toContain(">GL</text>");
  });

  it("escapes a name that would otherwise break the markup", () => {
    const nasty = renderPnlCard({ report: { ...report, name: 'Ku<>&"' }, pnl: computePnl(report) });
    expect(nasty).not.toContain('Ku<>&"');
    expect(nasty).toContain("&lt;&gt;&amp;&quot;");
  });

  it("escapes an art url with a quote in it", () => {
    const nasty = renderPnlCard({
      report,
      pnl: computePnl(report),
      artHref: 'https://x.test/a"onload="alert(1)',
    });
    expect(nasty).not.toContain('a"onload');
  });

  it("carries the numbers a reader would check", () => {
    expect(svg).toContain("10 in 5 wallets");
    expect(svg).toContain("PROFIT &amp; LOSS");
    expect(svg).toContain("BEST OFFER");
  });

  it("says the cost basis is estimated, since it is", () => {
    expect(svg).toContain("ESTIMATED COST BASIS");
  });

  it("shows the per-item mint price and the break-even it implies", () => {
    expect(svg).toContain("MINT EACH");
    expect(svg).toContain("BREAK-EVEN");
  });

  it("marks the mint price unknown rather than printing a confident zero", () => {
    const noPrice = { ...report, mintPriceEth: null, priceSource: "unknown" as const };
    const out = renderPnlCard({ report: noPrice, pnl: computePnl(noPrice) });
    expect(out).toContain(">?</text>");
  });

  it("singularises a lone wallet", () => {
    const one = renderPnlCard({ report: { ...report, wallets: 1 }, pnl: computePnl(report) });
    expect(one).toContain("10 in 1 wallet<");
  });

  it("renders without a market instead of failing", () => {
    const dark = { ...report, floorEth: null, bestOfferEth: null };
    expect(() => renderPnlCard({ report: dark, pnl: computePnl(dark) })).not.toThrow();
  });
});
