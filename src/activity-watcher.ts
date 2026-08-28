// Watches the collections you actually hold for signs of life: a burst of
// sales (someone sweeping), the floor moving, or a collection offer worth
// taking. Purely observational — it reads OpenSea and reports, and never
// buys, sells or signs anything.
//
// Deliberately built on the same resilience pattern as the mint watchers:
// the whole poll body is wrapped so a transient API failure can't kill the
// loop, and repeated failures back off instead of hammering the API.

import { fetchStats, fetchBestCollectionOffer, openseaCollectionUrl } from "./opensea-market";
import { backoffMs } from "./rpc-provider";
import { defaultLogger, Logger } from "./logger";

export interface WatchedCollection {
  slug: string;
  name: string;
}

export interface ActivityAlertOpts {
  collections: WatchedCollection[];
  apiKey?: string;
  pollIntervalMs: number;
  // A sweep is "several sales landed between two polls" — one sale is
  // ordinary, a cluster is the signal worth waking someone for.
  sweepSalesThreshold: number;
  // Ignore floor noise below this — sub-percent wobble on a thin collection
  // would otherwise alert constantly.
  floorMovePct: number;
  // Only surface offers at or above this fraction of the current floor.
  offerVsFloorPct: number;
  logger?: Logger;
  stopSignal?: { stopped: boolean };
  onAlert?: (text: string) => void | Promise<void>;
}

interface Baseline {
  totalSales: number;
  floor: number | null;
  bestOfferHash: string | null;
}

export function pctChange(from: number, to: number): number {
  if (from === 0) return to === 0 ? 0 : 100;
  return ((to - from) / from) * 100;
}

// Exported for testing: decides what (if anything) is worth reporting for one
// collection between two observations. Pure — no I/O, no formatting decisions
// that depend on when it ran.
export function diffCollection(
  name: string,
  slug: string,
  prev: Baseline,
  next: Baseline,
  opts: Pick<ActivityAlertOpts, "sweepSalesThreshold" | "floorMovePct" | "offerVsFloorPct">
): string[] {
  const alerts: string[] = [];

  const newSales = next.totalSales - prev.totalSales;
  if (newSales >= opts.sweepSalesThreshold) {
    alerts.push(
      `🧹 ${name}: ${newSales} sales just landed — possible sweep\n${openseaCollectionUrl(slug)}`
    );
  }

  if (prev.floor != null && next.floor != null) {
    const move = pctChange(prev.floor, next.floor);
    if (Math.abs(move) >= opts.floorMovePct) {
      const dir = move > 0 ? "📈 up" : "📉 down";
      alerts.push(
        `${dir} ${name}: floor ${prev.floor} → ${next.floor} (${move.toFixed(1)}%)\n${openseaCollectionUrl(slug)}`
      );
    }
  } else if (prev.floor == null && next.floor != null) {
    alerts.push(`🏷 ${name}: first listing appeared at ${next.floor}\n${openseaCollectionUrl(slug)}`);
  }

  return alerts;
}

export async function runActivityWatcher(opts: ActivityAlertOpts): Promise<void> {
  const log = opts.logger ?? defaultLogger;
  const emit = async (text: string) => {
    log.warnBold(text);
    try {
      await opts.onAlert?.(text);
    } catch {
      /* alerting is best-effort */
    }
  };

  log.title("\n── ACTIVITY WATCHER ──");
  log.info(`  Collections: ${opts.collections.length}`);
  log.info(`  Sweep threshold: ${opts.sweepSalesThreshold} sales between polls`);
  log.info(`  Floor move: ${opts.floorMovePct}%  ·  Offer alert: ${opts.offerVsFloorPct}% of floor`);

  const baselines = new Map<string, Baseline>();
  let consecutiveFailures = 0;
  const signal = opts.stopSignal ?? { stopped: false };
  process.once("SIGINT", () => {
    signal.stopped = true;
  });

  while (!signal.stopped) {
    await new Promise((r) => setTimeout(r, backoffMs(opts.pollIntervalMs, consecutiveFailures)));
    if (signal.stopped) break;

    try {
      for (const c of opts.collections) {
        if (signal.stopped) break;

        const [stats, offer] = await Promise.all([
          fetchStats(c.slug, opts.apiKey),
          fetchBestCollectionOffer(c.slug, opts.apiKey),
        ]);
        if (!stats) continue;

        const next: Baseline = {
          totalSales: stats.totalSales,
          floor: stats.floorPrice,
          bestOfferHash: offer?.orderHash ?? null,
        };
        const prev = baselines.get(c.slug);
        baselines.set(c.slug, next);

        // First observation is only a baseline — reporting against zero
        // would alert on every collection's entire history at startup.
        if (!prev) continue;

        for (const alert of diffCollection(c.name, c.slug, prev, next, opts)) {
          await emit(alert);
        }

        // Offers are compared against the live floor rather than a previous
        // offer, since "someone bid near floor" is the actionable part.
        if (offer && offer.orderHash !== prev.bestOfferHash) {
          const floor = stats.floorPrice;
          const worthIt = floor == null || offer.priceEth >= floor * (opts.offerVsFloorPct / 100);
          if (worthIt) {
            const vsFloor = floor != null ? ` (${((offer.priceEth / floor) * 100).toFixed(0)}% of floor)` : "";
            await emit(
              `💰 ${c.name}: collection offer ${offer.priceEth} ETH${vsFloor}\n${openseaCollectionUrl(c.slug)}`
            );
          }
        }
      }
      consecutiveFailures = 0;
    } catch (err: any) {
      consecutiveFailures++;
      log.error(`  ⚠ activity poll failed (${consecutiveFailures}x): ${err.message} — still running`);
    }
  }

  log.done("\n  Activity watcher stopped.");
}
