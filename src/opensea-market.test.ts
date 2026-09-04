import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  fetchCollection,
  fetchStats,
  fetchActivity,
  fetchBestCollectionOffer,
  openseaCollectionUrl,
  openSeaAuthFailure,
  clearOpenSeaAuthFailure,
} from "./opensea-market";

function mockFetch(status: number, body: any) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as any);
}

afterEach(() => vi.restoreAllMocks());

describe("openseaCollectionUrl", () => {
  it("builds the public collection link", () => {
    expect(openseaCollectionUrl("osborns")).toBe("https://opensea.io/collection/osborns");
  });
});

describe("fetchCollection", () => {
  it("maps the documented response shape", async () => {
    mockFetch(200, {
      collection: "osborns",
      name: "Osborns",
      description: "d",
      image_url: "https://img/logo.jpg",
      banner_image_url: "https://img/banner.jpg",
    });
    const info = await fetchCollection("osborns", "k");
    expect(info).toEqual({
      slug: "osborns",
      name: "Osborns",
      description: "d",
      imageUrl: "https://img/logo.jpg",
      bannerUrl: "https://img/banner.jpg",
      openseaUrl: "https://opensea.io/collection/osborns",
    });
  });

  it("returns null on a non-OK response rather than throwing", async () => {
    mockFetch(404, {});
    expect(await fetchCollection("nope", "k")).toBeNull();
  });

  it("returns null when the network call itself fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    expect(await fetchCollection("x", "k")).toBeNull();
  });
});

describe("fetchStats", () => {
  it("extracts floor, totals and the one-day interval", async () => {
    mockFetch(200, {
      total: { volume: 0.00061, sales: 155, num_owners: 46, floor_price: 0.00019, floor_price_symbol: "ETH" },
      intervals: [
        { interval: "one_day", volume: 0.0005, sales: 12 },
        { interval: "seven_day", volume: 0.00061, sales: 155 },
      ],
    });
    const s = await fetchStats("osborns", "k");
    expect(s).toMatchObject({
      floorPrice: 0.00019,
      floorSymbol: "ETH",
      totalSales: 155,
      owners: 46,
      oneDaySales: 12,
      oneDayVolume: 0.0005,
    });
  });

  it("reports a missing floor as null, not zero — nothing listed is not a price of 0", async () => {
    mockFetch(200, { total: { volume: 0, sales: 0, num_owners: 1 }, intervals: [] });
    const s = await fetchStats("x", "k");
    expect(s!.floorPrice).toBeNull();
    expect(s!.totalSales).toBe(0);
  });
});

describe("fetchActivity", () => {
  it("flattens events and scales the payment by its decimals", async () => {
    mockFetch(200, {
      asset_events: [
        {
          event_type: "sale",
          event_timestamp: 1787948017,
          chain: "robinhood",
          transaction: "0xabc",
          payment: { value: "1500000000000000", decimals: 18, symbol: "ETH" },
          nft: { identifier: "153", display_image_url: "https://img/153.png", opensea_url: "https://opensea.io/x" },
        },
      ],
    });
    const [e] = await fetchActivity("osborns", "k");
    expect(e.type).toBe("sale");
    expect(e.priceEth).toBeCloseTo(0.0015, 12);
    expect(e.tokenId).toBe("153");
    expect(e.imageUrl).toBe("https://img/153.png");
  });

  it("returns an empty list rather than throwing when there's no activity", async () => {
    mockFetch(200, { asset_events: [] });
    expect(await fetchActivity("x", "k")).toEqual([]);
  });

  it("leaves price null for events that carry no payment (transfers, mints)", async () => {
    mockFetch(200, { asset_events: [{ event_type: "transfer", event_timestamp: 1, nft: {} }] });
    const [e] = await fetchActivity("x", "k");
    expect(e.priceEth).toBeNull();
  });
});

describe("fetchBestCollectionOffer", () => {
  it("picks the highest per-item offer, normalizing multi-item offers", async () => {
    mockFetch(200, {
      offers: [
        {
          order_hash: "0xsingle",
          price: { value: "2000000000000000", decimals: 18 },
          protocol_data: { parameters: { offer: [{ startAmount: "1" }] } },
        },
        {
          // 0.009 total across 5 items = 0.0018 each — lower per item than 0.002
          order_hash: "0xbulk",
          price: { value: "9000000000000000", decimals: 18 },
          protocol_data: { parameters: { offer: [{ startAmount: "5" }] } },
        },
      ],
    });
    const best = await fetchBestCollectionOffer("x", "k");
    expect(best!.orderHash).toBe("0xsingle");
    expect(best!.priceEth).toBeCloseTo(0.002, 12);
  });

  it("returns null when there are no offers", async () => {
    mockFetch(200, { offers: [] });
    expect(await fetchBestCollectionOffer("x", "k")).toBeNull();
  });
});

describe("openSeaAuthFailure", () => {
  beforeEach(() => clearOpenSeaAuthFailure());

  it("records nothing while calls succeed", async () => {
    mockFetch(200, { total: { volume: 0 } });
    await fetchStats("glitchy404", "key");
    expect(openSeaAuthFailure()).toBe(null);
  });

  it("records a refusal, so an unavailable endpoint is not read as no data", async () => {
    mockFetch(401, { errors: ["Invalid API key"] });
    await fetchBestCollectionOffer("glitchy404", "key");
    expect(openSeaAuthFailure()?.detail).toContain("refused this endpoint");
  });

  it("names the endpoint family that was refused", async () => {
    mockFetch(401, {});
    await fetchBestCollectionOffer("glitchy404", "key");
    expect(openSeaAuthFailure()?.areas).toEqual(["offers"]);
  });

  it("does not let a public endpoint succeeding erase a real refusal", async () => {
    // Most of this API answers without a key. A global flag meant the next
    // floor-price read wiped the 401 seconds after it happened.
    mockFetch(401, {});
    await fetchBestCollectionOffer("glitchy404", "key");
    vi.restoreAllMocks();
    mockFetch(200, { total: { volume: 0 } });
    await fetchStats("glitchy404", "key");
    expect(openSeaAuthFailure()?.areas).toEqual(["offers"]);
  });

  it("clears once the same endpoint works again, so a fix needs no restart", async () => {
    mockFetch(401, {});
    await fetchBestCollectionOffer("glitchy404", "bad");
    vi.restoreAllMocks();
    mockFetch(200, []);
    await fetchBestCollectionOffer("glitchy404", "good");
    expect(openSeaAuthFailure()).toBe(null);
  });

  it("says so plainly when no key is configured at all", async () => {
    mockFetch(401, {});
    await fetchBestCollectionOffer("glitchy404");
    expect(openSeaAuthFailure()?.detail).toContain("no OPENSEA_API_KEY is set");
  });
});
