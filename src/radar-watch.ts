// The loop behind the radar: watch PublicDropUpdated, keep the board, alert.
//
// Deliberately separate from drop-radar.ts, which holds the decisions and is
// pure. This file is the part that touches the network and the clock, and it
// is thin on purpose -- everything worth arguing about lives next door where
// it can be tested without an RPC.

import { ChainProfile } from "./chains";
import { scanPublicDropUpdates } from "./seadrop-events";
import { Logger, defaultLogger } from "./logger";
import { RadarBoard, UpcomingDrop, Verdict, shouldAlert, isUpcoming, isLive, STILL_HOT_MS } from "./drop-radar";

export interface RadarOpts {
  chain: ChainProfile;
  rpcUrls: string[];
  board: RadarBoard;
  /** Fired for sightings worth a push. Awaited, so alerts cannot interleave. */
  onAlert: (drop: UpcomingDrop, verdict: Verdict) => Promise<void>;
  pollIntervalMs?: number;
  logChunkBlocks?: number;
  logger?: Logger;
  stopSignal?: { stopped: boolean };
  /**
   * Blocks to look back on the first pass.
   *
   * A drop configured before the radar started is still upcoming, and is
   * exactly the one worth knowing about -- starting at the head would mean
   * missing every drop announced while the bot was being redeployed.
   */
  backfillBlocks?: number;
}

export async function runDropRadar(opts: RadarOpts): Promise<void> {
  const log = opts.logger ?? defaultLogger;
  const signal = opts.stopSignal ?? { stopped: false };
  const poll = opts.pollIntervalMs ?? 15_000;
  const chunk = opts.logChunkBlocks ?? 2_000;
  const { createProvider } = await import("./rpc-provider");
  const provider = createProvider(opts.rpcUrls[0]);

  let head: number;
  try {
    head = await provider.getBlockNumber();
  } catch (err: any) {
    log.errorBold(`Radar could not reach ${opts.chain.name}: ${err?.message ?? err}`);
    return;
  }

  let cursor = Math.max(0, head - (opts.backfillBlocks ?? chunk));
  log.successBold(`📡 Radar on ${opts.chain.name} — watching for drops before they open.`);

  while (!signal.stopped) {
    try {
      const latest = await provider.getBlockNumber();
      if (latest >= cursor) {
        const sightings = await scanPublicDropUpdates(opts.rpcUrls[0], cursor, latest, chunk);
        cursor = latest + 1;

        for (const s of sightings) {
          const drop: UpcomingDrop = {
            contract: s.nftContract,
            chainKey: opts.chain.key,
            startTime: Number(s.drop.startTime),
            endTime: Number(s.drop.endTime),
            priceWei: s.drop.mintPrice,
            maxPerWallet: Number(s.drop.maxTotalMintableByWallet),
            blockNumber: s.blockNumber,
            firstSeenMs: Date.now(),
          };
          // A stage configured in the past with no end is not a drop anyone
          // can act on; the board would fill with them within an hour.
          if (!isUpcoming(drop) && !isLive(drop)) continue;

          const verdict = opts.board.note(drop);
          if (shouldAlert(verdict, drop)) {
            try {
              await opts.onAlert(drop, verdict);
            } catch (err: any) {
              // A failed send must not stop the watch; the next drop is more
              // valuable than retrying this one.
              log.error(`  radar alert failed: ${err?.message ?? err}`);
            }
          }
        }
      }
      opts.board.prune();
    } catch (err: any) {
      log.error(`  radar scan failed on ${opts.chain.name}: ${err?.message ?? err}`);
    }

    await new Promise((r) => setTimeout(r, poll));
  }

  log.successBold(`📡 Radar off — ${opts.chain.name}.`);
}

/** Still worth showing on the board, live or not. */
export function boardEntries(board: RadarBoard, nowMs = Date.now()): UpcomingDrop[] {
  return board.board(nowMs);
}

export { STILL_HOT_MS };
