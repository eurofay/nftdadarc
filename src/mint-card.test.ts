import { describe, it, expect } from "vitest";
import { renderMintCard, formatEth, haulValueEth, headline, accentFor, fitText, PALETTE } from "./mint-card";

const base = {
  collection: "Renhe hood",
  contract: "0xc520c32446871aea3d5e16c7b6ad9084a4d95286",
  chain: "robinhood",
  source: "Auto Mint" as const,
  minted: 33,
  wallets: 3,
  pricePaidEth: 0,
  floorEth: 0.00019,
  bestOfferEth: 0.00015,
  mintedAt: Date.UTC(2026, 7, 29),
};

describe("formatEth", () => {
  it("keeps significant digits on tiny values instead of collapsing to 0.00", () => {
    expect(formatEth(0.00019)).toBe("0.00019");
    expect(formatEth(0.0000012)).toBe("0.000001");
  });
  it("labels a zero price rather than printing 0", () => expect(formatEth(0)).toBe("FREE"));
  it("uses an em-dash for absent data", () => {
    expect(formatEth(null)).toBe("—");
    expect(formatEth(undefined)).toBe("—");
    expect(formatEth(NaN)).toBe("—");
  });
  it("trims to three decimals once above 1", () => expect(formatEth(1.23456)).toBe("1.235"));
});

describe("haulValueEth", () => {
  it("multiplies the count by the floor", () => expect(haulValueEth(33, 0.0001)).toBeCloseTo(0.0033));
  it("is null when there is no usable floor", () => {
    expect(haulValueEth(33, null)).toBeNull();
    expect(haulValueEth(33, 0)).toBeNull();
  });
});

describe("headline", () => {
  it("leads with the haul's value when a floor exists", () => {
    expect(headline({ minted: 33, floorEth: 0.00019 })).toEqual({ value: "0.0063", unit: "ETH AT FLOOR" });
  });
  it("falls back to the count, which is always known", () => {
    expect(headline({ minted: 10, floorEth: null })).toEqual({ value: "×10", unit: "MINTED" });
  });
});

describe("accentFor", () => {
  it("uses flame for a free mint", () => {
    expect(accentFor({ minted: 5, pricePaidEth: 0, floorEth: 0.001 })).toBe(PALETTE.flameHot);
  });
  it("uses green when a paid mint is worth more than it cost", () => {
    expect(accentFor({ minted: 5, pricePaidEth: 0.001, floorEth: 0.01 })).toBe(PALETTE.mint);
  });
  it("uses ember when a paid mint is under water", () => {
    expect(accentFor({ minted: 5, pricePaidEth: 0.01, floorEth: 0.001 })).toBe(PALETTE.ember);
  });
});

describe("fitText", () => {
  it("leaves short names alone", () => expect(fitText("Osborns", 18)).toBe("Osborns"));
  it("truncates long names so they can't run into the badge", () => {
    expect(fitText("Original Blokyz NFT Collection Extended", 18)).toHaveLength(18);
    expect(fitText("Original Blokyz NFT Collection Extended", 18).endsWith("…")).toBe(true);
  });
});

describe("renderMintCard", () => {
  it("produces a single well-formed svg root", () => {
    const svg = renderMintCard(base);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trim().endsWith("</svg>")).toBe(true);
    expect((svg.match(/<svg/g) || []).length).toBe(1);
  });

  it("escapes collection names so a quote or bracket can't break the markup", () => {
    // Short enough to survive fitText's 18-char clamp, so every character
    // actually reaches the escaper.
    const svg = renderMintCard({ ...base, collection: 'A&B "<x>"' });
    expect(svg).toContain("&amp;");
    expect(svg).toContain("&quot;");
    expect(svg).toContain("&lt;");
    // No raw angle bracket smuggled in from the data.
    expect(svg).not.toContain("<x>");
  });

  it("embeds the supplied artwork", () => {
    const svg = renderMintCard({ ...base, artHref: "data:image/png;base64,AAA" });
    expect(svg).toContain("data:image/png;base64,AAA");
  });

  it("falls back to a monogram when there is no artwork", () => {
    const svg = renderMintCard({ ...base, artHref: null });
    expect(svg).toContain(">RE<");
  });

  it("omits animation when asked, so rasterising isn't wasted work", () => {
    expect(renderMintCard({ ...base, animated: false })).not.toContain("<animate");
    expect(renderMintCard({ ...base, animated: true })).toContain("<animate");
  });

  it("carries the brand mark and the figures", () => {
    const svg = renderMintCard(base);
    expect(svg).toContain(">00<");
    expect(svg).toContain("0.0063");
    expect(svg).toContain("AUTO MINT · ROBINHOOD");
  });

  it("uses only glyphs the bundled fonts actually have", () => {
    // A missing glyph renders as a tofu box — Ξ did exactly that.
    const text = renderMintCard(base).replace(/<[^>]+>/g, "");
    const exotic = [...new Set(text.match(/[^\x00-\x7F]/g) || [])];
    expect(exotic.sort()).toEqual(["·", "…"]);
  });
});
