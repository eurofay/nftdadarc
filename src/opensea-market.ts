// Read-only market data from OpenSea's documented REST v2 API: collection
// art, floor price, recent activity and standing offers.
//
// Everything here is best-effort and non-blocking by design. This is
// decoration and alerting around the mint engine, never a dependency of it —
// the mint path itself stays on-chain-only (see seadrop-public.ts), so an
// OpenSea outage, a missing API key or an unindexed collection degrades the
// display rather than stopping anything from minting.

const BASE = "https://api.opensea.io/api/v2";

export interface CollectionInfo {
  slug: string;
  name: string;
  description: string;
  imageUrl: string | null;
  bannerUrl: string | null;
  openseaUrl: string;
}

export interface CollectionStats {
  floorPrice: number | null;
  floorSymbol: string;
  totalVolume: number;
  totalSales: number;
  owners: number;
  oneDayVolume: number;
  oneDaySales: number;
}

export interface ActivityEvent {
  type: string; // "sale" | "transfer" | "order" | ...
  timestamp: number;
  chain: string;
  txHash: string | null;
  tokenId: string | null;
  imageUrl: string | null;
  openseaUrl: string | null;
  priceEth: number | null;
}

export interface CollectionOffer {
  priceEth: number;
  quantity: number;
  orderHash: string;
}

async function get(path: string, apiKey?: string): Promise<any | null> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  try {
    const res = await fetch(`${BASE}/${path}`, { headers });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function openseaCollectionUrl(slug: string): string {
  return `https://opensea.io/collection/${slug}`;
}

export async function fetchCollection(slug: string, apiKey?: string): Promise<CollectionInfo | null> {
  const json = await get(`collections/${slug}`, apiKey);
  if (!json?.collection) return null;
  return {
    slug: json.collection,
    name: json.name || slug,
    description: json.description || "",
    imageUrl: json.image_url || null,
    bannerUrl: json.banner_image_url || null,
    openseaUrl: openseaCollectionUrl(json.collection),
  };
}

export async function fetchStats(slug: string, apiKey?: string): Promise<CollectionStats | null> {
  const json = await get(`collections/${slug}/stats`, apiKey);
  if (!json?.total) return null;
  const day = (json.intervals ?? []).find((i: any) => i.interval === "one_day");
  return {
    // A collection with nothing listed reports no floor at all — null is
    // "nothing for sale", which is different from a floor of zero.
    floorPrice: typeof json.total.floor_price === "number" ? json.total.floor_price : null,
    floorSymbol: json.total.floor_price_symbol || "ETH",
    totalVolume: Number(json.total.volume) || 0,
    totalSales: Number(json.total.sales) || 0,
    owners: Number(json.total.num_owners) || 0,
    oneDayVolume: Number(day?.volume) || 0,
    oneDaySales: Number(day?.sales) || 0,
  };
}

// OpenSea returns prices as {value, decimals, symbol} with value in the
// token's base units, so it needs scaling rather than reading directly.
function priceToEth(payment: any): number | null {
  if (!payment?.value) return null;
  const decimals = Number(payment.decimals ?? 18);
  const value = Number(payment.value);
  if (!Number.isFinite(value)) return null;
  return value / 10 ** decimals;
}

export async function fetchActivity(
  slug: string,
  apiKey?: string,
  limit = 20,
  eventType?: string
): Promise<ActivityEvent[]> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (eventType) q.set("event_type", eventType);
  const json = await get(`events/collection/${slug}?${q}`, apiKey);
  if (!json?.asset_events) return [];
  return json.asset_events.map((e: any) => ({
    type: e.event_type,
    timestamp: Number(e.event_timestamp) || 0,
    chain: e.chain || "",
    txHash: e.transaction || null,
    tokenId: e.nft?.identifier ?? null,
    imageUrl: e.nft?.display_image_url || e.nft?.image_url || null,
    openseaUrl: e.nft?.opensea_url || null,
    priceEth: priceToEth(e.payment),
  }));
}

export async function fetchBestCollectionOffer(
  slug: string,
  apiKey?: string
): Promise<CollectionOffer | null> {
  const json = await get(`offers/collection/${slug}`, apiKey);
  const offers = json?.offers;
  if (!Array.isArray(offers) || offers.length === 0) return null;

  let best: CollectionOffer | null = null;
  for (const offer of offers) {
    const params = offer?.protocol_data?.parameters;
    const consideration = offer?.price;
    const priceEth = priceToEth(consideration);
    if (priceEth === null) continue;
    // A collection offer can be for several items at once; the quoted price
    // is the total, so per-item is what's comparable against a floor.
    const quantity = Number(params?.offer?.[0]?.startAmount) || 1;
    const perItem = priceEth / Math.max(1, quantity);
    if (!best || perItem > best.priceEth) {
      best = { priceEth: perItem, quantity, orderHash: offer.order_hash || "" };
    }
  }
  return best;
}
