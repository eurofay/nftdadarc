// Autonomous free-mint watcher.
//
// Polls the chain for SeaDrop public drops going live at mintPrice = 0 (see
// seadrop-events.ts for how that's detected) and fires the max mint per
// wallet the instant one is live — no confirmation prompt. This is the
// unattended counterpart to the interactive wizard: same on-chain read and
// execution engine (buildLocalMintPlan / localPublicSnipe), just triggered by
// a background scan instead of a pasted contract address.
//
// Discovery is on-chain only, so it can't miss a drop OpenSea hasn't
// indexed yet and can't be fed a spoofed sighting. OpenSea is used only as an
// optional, non-blocking enrichment for readable logs.

import { buildLocalMintPlan } from "./seadrop-public";
import { scanPublicDropUpdates, DropSighting } from "./seadrop-events";
import { localPublicSnipe, SnipeOutcome } from "./local-mint";
import { openseaContractInfo } from "./slug-resolver";
import { ChainProfile } from "./chains";
import { defaultLogger, Logger } from "./logger";
import { backoffMs, createProvider } from "./rpc-provider";

export interface AutoMintOpts {
  chain: ChainProfile;
  rpcUrls: string[];
  walletKeys: string[];
  maxFeePerGas: bigint;
  maxPriorityFee: bigint;
  gasLimit: number;
  pollIntervalMs: number;
  maxQuantityPerWallet?: number; // caps "max per wallet" if a drop's cap is absurdly high
  maxMintsPerRun?: number; // stop after this many distinct collections auto-fired
  openseaApiKey?: string;
  logChunkBlocks?: number; // eth_getLogs range per call — see seadrop-events.ts
  logger?: Logger; // defaults to printing locally — the Telegram bot passes one that also forwards to a chat
  stopSignal?: { stopped: boolean }; // lets a caller (the bot) stop the watcher without SIGINT
  onMinted?: (outcome: SnipeOutcome) => void | Promise<void>; // portfolio bookkeeping; never allowed to fail a mint
  // Consulted before firing. The in-memory 'fired' set below only survives
  // one run, so without a persistent check a restart re-fires collections
  // already minted — which reverts with MintQuantityExceedsMaxMintedPerWallet
  // and burns gas for nothing. The bot backs this with the portfolio store.
  alreadyMinted?: (nftContract: string) => boolean;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function isLive(drop: DropSighting["drop"]): boolean {
  const t = nowSec();
  if (drop.mintPrice !== 0n) return false;
  if (drop.maxTotalMintableByWallet <= 0) return false;
  if (t < drop.startTime) return false;
  if (drop.endTime !== 0 && t > drop.endTime) return false;
  return true;
}

export async function runAutoMintWatcher(opts: AutoMintOpts): Promise<void> {
  const { chain, rpcUrls, walletKeys, maxFeePerGas, maxPriorityFee, gasLimit, pollIntervalMs } = opts;
  const log = opts.logger ?? defaultLogger;
  const provider = createProvider(rpcUrls[0]);

  log.title("\n── AUTO FREE-MINT WATCHER ──");
  log.info(`  Chain:    ${chain.name} (${chain.chainId})`);
  log.info(`  Wallets:  ${walletKeys.length}`);
  log.info(`  Polling:  every ${pollIntervalMs}ms via ${rpcUrls[0]}`);
  log.warn(
    "  Fully autonomous: any SeaDrop drop that goes live at price 0 is minted at max-per-wallet\n" +
      "  immediately, no confirmation. Ctrl+C to stop.\n"
  );

  const candidates = new Map<string, DropSighting["drop"]>();
  const fired = new Set<string>();
  // Established on the first successful poll rather than up front, so a
  // failure reading the chain head is handled by the loop's own retry/backoff
  // instead of throwing before the watcher has even started.
  let lastScanned: number | null = null;
  let consecutiveFailures = 0;
  let firedCount = 0;

  // Promise.race would only stop *awaiting* the loop, not the loop itself —
  // it would keep polling and could keep auto-firing in the background after
  // claiming to have stopped. This flag actually ends the while loop. It can
  // be flipped either by SIGINT (CLI) or by the caller's own stopSignal
  // object (the Telegram bot, which has no terminal to send SIGINT from).
  const signal = opts.stopSignal ?? { stopped: false };
  process.once("SIGINT", () => {
    signal.stopped = true;
  });

  while (!signal.stopped) {
    await new Promise((r) => setTimeout(r, backoffMs(pollIntervalMs, consecutiveFailures)));
    if (signal.stopped) break;

    // Everything below is wrapped: a transient RPC failure anywhere in a poll
    // must never escape and kill the watcher. Before this, a timeout on the
    // getBlockNumber() below propagated all the way out and the watcher was
    // dead until the whole process restarted.
    try {
      // A load-balanced RPC's backend nodes can briefly disagree on the head —
      // one reports a new block before another has caught up, and the second
      // rejects eth_getLogs up to that block as "beyond current head". Staying
      // a couple of blocks behind the reported tip avoids racing that lag.
      const REORG_SAFETY_BLOCKS = 2;
      const latest = (await provider.getBlockNumber()) - REORG_SAFETY_BLOCKS;

      // First successful poll only establishes a baseline — this watches for
      // drops configured from now on, not the entire chain's history.
      if (lastScanned === null) {
        lastScanned = latest;
        consecutiveFailures = 0;
        continue;
      }

      if (latest > lastScanned) {
        let sightings: DropSighting[] = [];
        try {
          sightings = await scanPublicDropUpdates(rpcUrls[0], lastScanned + 1, latest, opts.logChunkBlocks);
          // Only mark this range scanned on success — advancing it on failure
          // would silently skip it forever despite the "retrying" log below.
          lastScanned = latest;
        } catch (err: any) {
          log.error(`  ⚠ log scan failed: ${err.message} — retrying next tick`);
        }

        for (const s of sightings) {
          candidates.set(s.nftContract, s.drop);
          if (s.drop.mintPrice === 0n) {
            log.highlight(
              `  ↳ free public drop configured: ${s.nftContract} (block ${s.blockNumber}, max/wallet ${s.drop.maxTotalMintableByWallet})`
            );
          }
        }
      }

      const t = nowSec();
      for (const [nftContract, drop] of [...candidates]) {
        // Drop the window entirely once it's over — nothing more to check.
        if (drop.endTime !== 0 && t > drop.endTime) {
          candidates.delete(nftContract);
          continue;
        }
        if (fired.has(nftContract) || !isLive(drop)) continue;
        if (opts.alreadyMinted?.(nftContract)) {
          fired.add(nftContract); // remember for this run too, so it isn't re-checked every tick
          log.info(`  ↷ Skipping ${nftContract} — already in your portfolio (would exceed max per wallet).`);
          continue;
        }

        fired.add(nftContract); // mark first so a slow mint doesn't get retried next tick
        await mintCandidate(nftContract, drop.maxTotalMintableByWallet);
        firedCount++;

        if (opts.maxMintsPerRun && firedCount >= opts.maxMintsPerRun) {
          log.done(`\n  Reached AUTO_MAX_MINTS_PER_RUN (${opts.maxMintsPerRun}) — stopping.`);
          signal.stopped = true;
          break;
        }
      }

      consecutiveFailures = 0;
    } catch (err: any) {
      consecutiveFailures++;
      log.error(
        `  ⚠ poll failed (${consecutiveFailures}x): ${err.message} — still running, retrying with backoff`
      );
    }
  }

  log.done(`\n\n  Stopped. Auto-fired ${firedCount} collection(s) this run.`);

  async function mintCandidate(nftContract: string, walletCap: number): Promise<void> {
    const quantity = opts.maxQuantityPerWallet
      ? Math.min(walletCap, opts.maxQuantityPerWallet)
      : walletCap;

    log.warnBold(`\n  🎯 LIVE FREE MINT: ${nftContract} — firing ${quantity}/wallet`);

    const info = await openseaContractInfo(chain.key, nftContract, opts.openseaApiKey);
    log.info(`     OpenSea: ${info ? `${info.name} (${info.slug})` : "not found / unverified"}`);

    // Re-read right before firing — the event only proves a drop *was*
    // configured; the chain is the only source that says it's still true now.
    const plan = await buildLocalMintPlan(rpcUrls[0], nftContract, quantity);
    if (!plan) {
      log.error(`     ✗ Skipped — drop no longer resolvable on-chain (ended or restricted).`);
      return;
    }
    if (plan.value !== 0n) {
      log.error(`     ✗ Skipped — price is no longer 0 as of the latest read.`);
      return;
    }

    try {
      const outcome = await localPublicSnipe({
        nftContract,
        quantity,
        walletKeys,
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
    } catch (err: any) {
      log.error(`     ✗ Auto-mint attempt failed: ${err.message}`);
    }
  }
}
