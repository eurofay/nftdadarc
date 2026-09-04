// Copy-mint: watch specific wallets, and whenever one of them calls
// SeaDrop.mintPublic() for some collection, independently mint that same
// collection with your own wallets.
//
// "Independently" matters: this never replays the watched wallet's calldata.
// It only uses their transaction as a *signal* — "this contract is worth
// minting" — then builds a fresh plan via the exact same buildLocalMintPlan
// used everywhere else in this repo (fresh price, fresh fee recipient, fresh
// per-wallet cap read straight from the chain). A copied wallet's tx is
// external input; trusting its calldata directly would mean trusting
// whatever fee recipient or quantity it happened to encode.
//
// Unlike the free-mint watcher, this is not restricted to price = 0 — the
// whole point is following a wallet's judgment, which may include paid
// mints — so maxPriceEth is the one guardrail against blindly following it
// into an expensive mint.

import { Wallet, formatEther } from "ethers";
import { buildLocalMintPlan } from "./seadrop-public";
import { raceRead, raceReadOrNull } from "./fast-read";
import { RepeatFilter } from "./copy-mint-message";
import { checkEligibility } from "./seadrop-stages";
import { gasLimitForQuantity } from "./gas";
import { resolveMaxFee } from "./gas-fit";
import { DEFAULT_CHUNK_BLOCKS, MintSighting, scanSeaDropMints } from "./seadrop-events";
import { localPublicSnipe, SnipeOutcome } from "./local-mint";
import { backoffMs, createProvider, describeRpcError } from "./rpc-provider";
import { ChainProfile, backfillBlocksFor, catchupBlocksFor } from "./chains";
import { defaultLogger, Logger } from "./logger";


export interface CopyAttemptReport {
  sourceWallet: string;
  sourceTxHash: string;
  nftContract: string;
  quantity: number;
  outcome: "success" | "failed" | "skipped";
  reason?: string;
  txHashes: string[];
}

export interface WatchedMint {
  txHash: string;
  from: string;
  nftContract: string;
  blockNumber: number;
}

function toWatchedMint(s: MintSighting): WatchedMint {
  return {
    txHash: s.txHash,
    from: s.minter,
    nftContract: s.nftContract,
    blockNumber: s.blockNumber,
  };
}

export interface WatchedScanOpts {
  // Receives each chunk as it lands, so a scan that dies part-way still hands
  // back the ground it covered. See ScanOpts.onProgress in seadrop-events.ts.
  onProgress?: (scannedThrough: number, found: WatchedMint[]) => void;
  /** Checked between chunks, so a long scan can be cut short. */
  shouldStop?: () => boolean;
}

export async function scanWatchedMints(
  rpcUrl: string,
  fromBlock: number,
  toBlock: number,
  watchTargets: string[],
  chunkBlocks?: number,
  opts: WatchedScanOpts = {}
): Promise<WatchedMint[]> {
  const { onProgress } = opts;
  const sightings = await scanSeaDropMints(rpcUrl, fromBlock, toBlock, watchTargets, chunkBlocks, {
    onProgress: onProgress && ((through, found) => onProgress(through, found.map(toWatchedMint))),
    shouldStop: opts.shouldStop,
  });
  return sightings.map(toWatchedMint);
}

// Halving the block range only helps when the provider is complaining about
// the RANGE. A timeout or a rate-limit is the endpoint saying "too many
// calls", and halving the chunk DOUBLES the call count — strictly the wrong
// response. Retrying a timeout smaller is how a scan already at the 10-block
// floor ends up logging "failed at chunk 10 — retrying at 10" on a loop:
// the resize was both a no-op and the opposite of what the failure asked for.
const RANGE_LIMIT_ERROR = /block range|range is too|too many blocks|returned more than|response size|exceeds? maximum|query timeout exceeded/i;

export function looksLikeRangeLimit(err: unknown): boolean {
  return RANGE_LIMIT_ERROR.test(describeRpcError(err));
}

// Above this many eth_getLogs calls, a backfill is a configuration problem
// rather than a long wait, and the watcher says so at startup.
const NOISY_BACKFILL_CALLS = 500;

export interface CopyMintOpts {
  chain: ChainProfile;
  rpcUrls: string[];
  walletKeys: string[]; // your wallets, doing the copying
  watchTargets: string[]; // wallets whose mints you're following
  maxFeePerGas: bigint;
  maxPriorityFee: bigint;
  gasLimit: number;
  pollIntervalMs: number;
  maxPriceEth: number; // skip anything pricier than this per wallet
  quantityPerWallet?: number; // default: the drop's own max-per-wallet cap
  // Blocks to look back on startup. Defaults to the chain's 12-hour span;
  // 0 starts at the head. See backfillBlocksFor.
  backfillBlocks?: number;
  logChunkBlocks?: number; // eth_getLogs range per call — see seadrop-events.ts
  onMinted?: (outcome: SnipeOutcome) => void | Promise<void>; // portfolio bookkeeping; never allowed to fail a mint
  // Every attempt, including the ones that never fired. "Why didn't it copy
  // that one" is only answerable if skips are recorded too.
  onAttempt?: (attempt: CopyAttemptReport) => void | Promise<void>;
  alreadyMinted?: (nftContract: string) => boolean;
  /** Resolves a contract to a readable name, so logs aren't a wall of hex. */
  describeCollection?: (nftContract: string) => Promise<string | null>; // see auto-mint.ts — avoids re-minting across restarts
  logger?: Logger;
  stopSignal?: { stopped: boolean };
}

export async function runCopyMintWatcher(opts: CopyMintOpts): Promise<void> {
  const { chain, rpcUrls, walletKeys, watchTargets, maxFeePerGas, maxPriorityFee, gasLimit, pollIntervalMs } = opts;
  const log = opts.logger ?? defaultLogger;
  const provider = createProvider(rpcUrls[0]);

  log.title("\n── COPY-MINT WATCHER ──");
  log.info(`  Chain:    ${chain.name} (${chain.chainId})`);
  log.info(`  Watching: ${watchTargets.length} wallet(s)`);
  log.info(`  Max price accepted: ${opts.maxPriceEth} ETH per wallet`);
  log.warn("  Any mintPublic call from a watched wallet is copied with your own wallets. Ctrl+C to stop.\n");

  const chunkBlocks = opts.logChunkBlocks ?? DEFAULT_CHUNK_BLOCKS;

  const copied = new Set<string>(); // dedupe by "nftContract" so a busy source wallet doesn't trigger repeats
  // Established on the first successful poll rather than up front, so a
  // failure reading the chain head is handled by the loop's own retry/backoff
  // instead of throwing before the watcher has even started.
  let lastScanned: number | null = null;
  let consecutiveFailures = 0;
  let firstPass = false;
  // The last scan failure already reported, so a persistent outage doesn't
  // repeat one line every tick. Cleared on recovery.
  let scanErrorReported: string | null = null;
  const maxCatchup = catchupBlocksFor(chain.key);

  // Nineteen watched wallets produce the same failure many times an hour —
  // underfunded wallets, most often. The first report is information; the
  // fourth is noise burying anything new. Repeats are counted and resurfaced
  // periodically rather than printed every time.
  const repeats = new RepeatFilter();

  const signal = opts.stopSignal ?? { stopped: false };
  process.once("SIGINT", () => {
    signal.stopped = true;
  });

  // Recording must never be able to break a copy attempt.
  const report = async (a: CopyAttemptReport) => {
    try {
      await opts.onAttempt?.(a);
    } catch {
      /* history is bookkeeping */
    }
  };

  while (!signal.stopped) {
    await new Promise((r) => setTimeout(r, backoffMs(pollIntervalMs, consecutiveFailures)));
    if (signal.stopped) break;

    // Everything below is wrapped: a transient RPC failure anywhere in a poll
    // must never escape and kill the watcher. Before this, a timeout on the
    // getBlockNumber() below propagated all the way out and the watcher was
    // dead until the whole process restarted.
    try {
      // Same defensive margin as auto-mint.ts: a load-balanced RPC's backend
      // nodes can briefly disagree on the head, so staying a couple of blocks
      // behind the reported tip avoids asking a lagging node for a block it
      // doesn't have yet.
      const latest = (await provider.getBlockNumber()) - 2;

      // First successful poll: look BACK before following the head.
      //
      // This used to start at the head, on the reasoning that a stale mint
      // isn't worth copying. Measurement says otherwise — of 28 collections
      // watched wallets minted over 12 hours, 25 were still open, with
      // windows of 1 to 365 days. Starting at the head threw all of them
      // away. Unlike a contested free mint, a copy signal keeps its value
      // for as long as the drop stays open.
      if (lastScanned === null) {
        const backfill = opts.backfillBlocks ?? backfillBlocksFor(chain.key);
        lastScanned = Math.max(0, latest - backfill);
        consecutiveFailures = 0;
        if (backfill > 0) {
          const hours = ((backfill * chain.blockSeconds) / 3600).toFixed(1);
          log.info(`  ⏮ Backfilling ${backfill} blocks (~${hours}h) for drops that are still open…`);
          // The backfill is walked one eth_getLogs per chunk. On a fast chain
          // with a small chunk that is tens of thousands of sequential calls
          // — hours before the watcher ever reaches the head, and enough
          // sustained load to cause the very timeouts that stall it. Say so,
          // because the fix is configuration, not patience.
          const calls = Math.ceil(backfill / chunkBlocks);
          if (calls > NOISY_BACKFILL_CALLS) {
            const native = chain.rpc.logChunkBlocks;
            const advice =
              native && native > chunkBlocks
                ? `This chain's own RPC serves ${native} blocks per call — set AUTO_LOG_CHUNK_BLOCKS_${chain.key.toUpperCase()}=${native} (a global AUTO_LOG_CHUNK_BLOCKS overrides it).`
                : `Raise AUTO_LOG_CHUNK_BLOCKS_${chain.key.toUpperCase()} if your RPC allows a wider range, or shorten the backfill.`;
            log.warn(
              `  ⚠ That's ${calls} scans at ${chunkBlocks} blocks each. ${advice}`
            );
          }
        }
        // Fall through and scan it, rather than `continue` — but suspend the
        // catch-up guard below, which would otherwise discard the backfill as
        // "too far behind" the instant it was set.
        //
        // Only when there IS a range to protect. With the backfill off,
        // lastScanned is already the head, so the poll short-circuits before
        // reaching the reset — and the flag would survive into the next poll
        // and disable the guard there for nothing.
        firstPass = backfill > 0;
      }

      // Same reasoning as auto-mint.ts: on a fast chain a backlog compounds
      // and the watcher drifts permanently behind. Copying a mint from
      // thousands of blocks ago is pointless anyway.
      if (!firstPass && latest - lastScanned > maxCatchup) {
        const behind = latest - lastScanned;
        const skipped = behind - maxCatchup;
        // Say both numbers: how far behind it had fallen, and how many
        // blocks are being given up unscanned. Those skipped blocks are
        // never examined, so a drop inside them is genuinely missed —
        // reporting only one of the two hides that.
        log.warn(
          `  ⏩ ${behind} blocks behind — skipping ${skipped} unscanned to stay near the head.`
        );
        lastScanned = latest - maxCatchup;
      }

      if (latest <= lastScanned) {
        consecutiveFailures = 0;
        continue;
      }

      const sightings: WatchedMint[] = [];
      let scanFailed = false;
      // The highest block a chunk actually covered. A scan that dies at chunk
      // 300 of 400 has still done 300 chunks of real work, and keeping it is
      // the difference between a backfill that finishes and one that cannot:
      // rescanning the whole range every tick means every tick has to get
      // through EVERY chunk without a single transient failure, which over
      // hundreds of thousands of blocks never happens.
      let scannedThrough: number = lastScanned;
      const collect = (through: number, found: WatchedMint[]) => {
        scannedThrough = Math.max(scannedThrough, through);
        sightings.push(...found);
      };

      try {
        try {
          await scanWatchedMints(rpcUrls[0], lastScanned + 1, latest, watchTargets, chunkBlocks, {
            onProgress: collect,
            shouldStop: () => signal.stopped,
          });
        } catch (err: any) {
          // Retry smaller ONLY if the provider is objecting to the range, and
          // only if "smaller" is a real change — at the 10-block floor,
          // Math.max(10, 10/2) is still 10, so this used to re-issue the
          // identical failing request and announce it as a retry.
          const halved = Math.max(1, Math.floor(chunkBlocks / 2));
          if (!looksLikeRangeLimit(err) || halved >= chunkBlocks) throw err;
          // Routine and self-correcting, so it stays in the local log rather
          // than being forwarded to the bot's chat. See logger.ts.
          log.info(
            `  ↻ chunk ${chunkBlocks} rejected (${describeRpcError(err)}) — rescanning from ${scannedThrough + 1} at ${halved}`
          );
          // Resume from what's already covered instead of starting over.
          await scanWatchedMints(rpcUrls[0], scannedThrough + 1, latest, watchTargets, halved, {
            onProgress: collect,
            shouldStop: () => signal.stopped,
          });
        }
        // Only the whole range if the scan wasn't cut short by a stop.
        lastScanned = signal.stopped ? Math.max(lastScanned, scannedThrough) : latest;
        if (scanErrorReported) {
          log.success("  ✓ Block scan recovered.");
          scanErrorReported = null;
        }
      } catch (err: any) {
        scanFailed = true;
        // Keep the ground the scan did cover. Holding lastScanned back would
        // re-request those blocks on every future tick forever.
        lastScanned = Math.max(lastScanned, scannedThrough);
        const reason = describeRpcError(err);
        // A persistent outage produces this identical line every tick, and at
        // a 4s poll that is a wall of duplicates in the chat saying one thing.
        // Report it once, then again only when the failure itself changes.
        if (scanErrorReported !== reason) {
          log.error(
            `  ⚠ Block scan failed: ${reason} — scanned through ${lastScanned}, ${latest - lastScanned} block(s) still behind. Retrying with backoff.`
          );
          scanErrorReported = reason;
        }
      } finally {
        // One backfill attempt only. If it failed, the catch-up guard above
        // takes over next tick and reports honestly what it gives up on,
        // rather than re-scanning an hours-long range forever.
        firstPass = false;
      }

      for (const sighting of sightings) {
        if (signal.stopped) break;
        if (copied.has(sighting.nftContract.toLowerCase())) continue;
        copied.add(sighting.nftContract.toLowerCase());

        if (opts.alreadyMinted?.(sighting.nftContract)) {
          const reason = "already in your portfolio";
          log.info(`  ↷ Skipping ${sighting.nftContract} — ${reason}.`);
          await report({
            sourceWallet: sighting.from,
            sourceTxHash: sighting.txHash,
            nftContract: sighting.nftContract,
            quantity: 0,
            outcome: "skipped",
            reason,
            txHashes: [],
          });
          continue;
        }

        const name =
          (await opts.describeCollection?.(sighting.nftContract).catch(() => null)) ??
          sighting.nftContract;
        log.warnBold(
          `
  👀 ${name} — minted by ${sighting.from.slice(0, 8)}… (block ${sighting.blockNumber}), copying`
        );

        // Raced across every endpoint rather than pinned to rpcUrls[0]. That
        // one is chosen for scan width, which is not the same as being quick:
        // measured at 1609ms where another endpoint answered in 18ms, and
        // this sits directly between seeing a mint and sending one.
        const drop = await raceReadOrNull(
          rpcUrls,
          (url) => buildLocalMintPlan(url, sighting.nftContract, 1),
          log
        );
        if (!drop) {
          const reason = "no public drop resolvable for this contract";
          const seen = repeats.consider(reason);
          if (seen.send) {
            log.error(`     ✗ Skipped — ${reason}.${seen.count > 1 ? ` (${seen.count}× recently)` : ""}`);
          }
          await report({ sourceWallet: sighting.from, sourceTxHash: sighting.txHash, nftContract: sighting.nftContract, quantity: 0, outcome: "skipped", reason, txHashes: [] });
          continue;
        }
        const priceEth = Number(drop.drop.mintPrice) / 1e18;
        if (priceEth > opts.maxPriceEth) {
          const reason = `price ${priceEth} ETH exceeds your ${opts.maxPriceEth} ETH cap`;
          log.error(`     ✗ Skipped — ${reason}.`);
          await report({ sourceWallet: sighting.from, sourceTxHash: sighting.txHash, nftContract: sighting.nftContract, quantity: 0, outcome: "skipped", reason, txHashes: [] });
          continue;
        }

        // Cap at whichever is smaller — the drop's own per-wallet max, or your
        // chosen cap. Using quantityPerWallet outright when it's above the
        // drop's real max would revert on-chain (SeaDrop enforces that limit
        // itself) instead of just minting what's actually available.
        const quantity = opts.quantityPerWallet
          ? Math.min(drop.drop.maxTotalMintableByWallet, opts.quantityPerWallet)
          : drop.drop.maxTotalMintableByWallet;
        // Reuse the drop already fetched: only the encoded quantity differs,
        // and re-reading it was two more round trips on the critical path.
        // Fire only with wallets the chain will actually accept.
        //
        // Without this the watcher fires blind: a wallet already at the
        // drop's per-wallet cap, or a collection that sold out between the
        // sighting and now, both revert — and a revert still burns the gas it
        // used. The sighting says someone ELSE could mint, which is not the
        // same as us being able to.
        const eligible: string[] = [];
        for (const key of walletKeys) {
          const address = new Wallet(key).address;
          try {
            const e = await raceRead(rpcUrls, (url) =>
              checkEligibility(url, sighting.nftContract, address, drop.drop.maxTotalMintableByWallet)
            );
            if (e.canMint > 0) eligible.push(key);
            else log.info(`     ↷ ${address.slice(0, 8)}… — ${e.reason ?? "cannot mint"}`);
          } catch {
            // Couldn't check: assume eligible rather than miss the drop. A
            // revert costs gas; not firing costs the mint.
            eligible.push(key);
          }
        }
        if (eligible.length === 0) {
          const reason = "no wallet is eligible — already minted, or sold out";
          const seen = repeats.consider(reason);
          if (seen.send) {
            log.error(`     ✗ Skipped — ${reason}.${seen.count > 1 ? ` (${seen.count}× recently)` : ""}`);
          }
          await report({ sourceWallet: sighting.from, sourceTxHash: sighting.txHash, nftContract: sighting.nftContract, quantity: 0, outcome: "skipped", reason, txHashes: [] });
          continue;
        }

        const plan =
          quantity === 1
            ? drop
            : await raceReadOrNull(
                rpcUrls,
                (url) => buildLocalMintPlan(url, sighting.nftContract, quantity),
                log
              );
        if (!plan) {
          const reason = `drop no longer resolvable at quantity ${quantity}`;
          log.error(`     ✗ Skipped — ${reason}.`);
          await report({ sourceWallet: sighting.from, sourceTxHash: sighting.txHash, nftContract: sighting.nftContract, quantity, outcome: "skipped", reason, txHashes: [] });
          continue;
        }

        // A node reserves gasLimit x maxFeePerGas upfront, regardless of what
        // the transaction actually ends up paying. A wallet below that can't
        // send at all — and with the backfill above surfacing many drops at
        // once, an unfunded wallet would otherwise produce one "insufficient
        // funds" failure per collection. Checked once per copy, not per
        // collection, so the cost is one balance read.
        // Mirror what the signer will actually reserve: an auto ceiling reads
        // as zero here, and the sizing is per-quantity, not a flat number.
        const effectiveLimit = gasLimit > 0 ? gasLimit : gasLimitForQuantity(quantity);
        const head = await provider.getBlock("latest").catch(() => null);
        const ceiling = resolveMaxFee(maxFeePerGas, head?.baseFeePerGas ?? 0n, maxPriorityFee).maxFeePerGas;
        const required = BigInt(effectiveLimit) * ceiling + plan.value;
        const affordable: string[] = [];
        for (const key of eligible) {
          const address = new Wallet(key).address;
          let balance = 0n;
          try {
            balance = await provider.getBalance(address);
          } catch {
            // A balance we can't read is not evidence of an empty wallet;
            // let the mint proceed and fail honestly if it must.
            affordable.push(key);
            continue;
          }
          if (balance >= required) affordable.push(key);
          else
            log.warn(
              `     ⚠ ${address.slice(0, 10)}… holds ${formatEther(balance)} ETH, needs ${formatEther(required)} to send — skipping it.`
            );
        }
        if (affordable.length === 0) {
          const reason = `no wallet can cover ${formatEther(required)} ETH (gas ${effectiveLimit} x ${formatEther(ceiling)} + mint price)`;
          log.error(`     ✗ Skipped — ${reason}.`);
          await report({ sourceWallet: sighting.from, sourceTxHash: sighting.txHash, nftContract: sighting.nftContract, quantity, outcome: "skipped", reason, txHashes: [] });
          continue;
        }

        try {
          const outcome = await localPublicSnipe({
            nftContract: sighting.nftContract,
            quantity,
            walletKeys: affordable,
            rpcUrls,
            maxFeePerGas,
            maxPriorityFee,
            gasLimit,
            targetStart: null,
            plan,
            logger: log,
          });
          try {
            await opts.onMinted?.(outcome);
          } catch {
            /* bookkeeping only */
          }
          // Dispatch alone isn't a copy — only confirmed receipts count.
          await report({
            sourceWallet: sighting.from,
            sourceTxHash: sighting.txHash,
            nftContract: sighting.nftContract,
            quantity,
            outcome: outcome.minted.length > 0 ? "success" : "failed",
            reason: outcome.minted.length > 0 ? undefined : "broadcast but no wallet confirmed a receipt",
            txHashes: outcome.minted.map((m) => m.txHash),
          });
        } catch (err: any) {
          const reason = describeRpcError(err);
          log.error(`     ✗ Copy-mint attempt failed: ${reason}`);
          await report({ sourceWallet: sighting.from, sourceTxHash: sighting.txHash, nftContract: sighting.nftContract, quantity, outcome: "failed", reason, txHashes: [] });
        }
      }

      // A failed scan is a failed poll. Resetting the counter here regardless
      // was why a broken scan retried every 4s forever instead of backing
      // off — the loop looked healthy because getBlockNumber() had worked.
      if (scanFailed) consecutiveFailures++;
      else consecutiveFailures = 0;
    } catch (err: any) {
      consecutiveFailures++;
      log.error(
        `  ⚠ poll failed (${consecutiveFailures}x): ${describeRpcError(err)} — still running, retrying with backoff`
      );
    }
  }

  log.done(`\n\n  Stopped. Copied ${copied.size} collection(s) this run.`);
}
