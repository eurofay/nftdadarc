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

import { buildLocalMintPlan } from "./seadrop-public";
import { scanSeaDropMints } from "./seadrop-events";
import { localPublicSnipe, SnipeOutcome } from "./local-mint";
import { backoffMs, createProvider, describeRpcError } from "./rpc-provider";
import { ChainProfile } from "./chains";
import { defaultLogger, Logger } from "./logger";

// See auto-mint.ts — staying near the head matters more than completeness.
const MAX_CATCHUP_BLOCKS = 200;

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

export async function scanWatchedMints(
  rpcUrl: string,
  fromBlock: number,
  toBlock: number,
  watchTargets: string[],
  chunkBlocks?: number
): Promise<WatchedMint[]> {
  const sightings = await scanSeaDropMints(rpcUrl, fromBlock, toBlock, watchTargets, chunkBlocks);
  return sightings.map((s) => ({
    txHash: s.txHash,
    from: s.minter,
    nftContract: s.nftContract,
    blockNumber: s.blockNumber,
  }));
}

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
  logChunkBlocks?: number; // eth_getLogs range per call — see seadrop-events.ts
  onMinted?: (outcome: SnipeOutcome) => void | Promise<void>; // portfolio bookkeeping; never allowed to fail a mint
  // Every attempt, including the ones that never fired. "Why didn't it copy
  // that one" is only answerable if skips are recorded too.
  onAttempt?: (attempt: CopyAttemptReport) => void | Promise<void>;
  alreadyMinted?: (nftContract: string) => boolean; // see auto-mint.ts — avoids re-minting across restarts
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

  const copied = new Set<string>(); // dedupe by "nftContract" so a busy source wallet doesn't trigger repeats
  // Established on the first successful poll rather than up front, so a
  // failure reading the chain head is handled by the loop's own retry/backoff
  // instead of throwing before the watcher has even started.
  let lastScanned: number | null = null;
  let consecutiveFailures = 0;

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

      // First successful poll only establishes a baseline — this follows
      // watched wallets from now on, not through the chain's history.
      if (lastScanned === null) {
        lastScanned = latest;
        consecutiveFailures = 0;
        continue;
      }

      // Same reasoning as auto-mint.ts: on a fast chain a backlog compounds
      // and the watcher drifts permanently behind. Copying a mint from
      // thousands of blocks ago is pointless anyway.
      if (latest - lastScanned > MAX_CATCHUP_BLOCKS) {
        const behind = latest - lastScanned;
        const skipped = behind - MAX_CATCHUP_BLOCKS;
        // Say both numbers: how far behind it had fallen, and how many
        // blocks are being given up unscanned. Those skipped blocks are
        // never examined, so a drop inside them is genuinely missed —
        // reporting only one of the two hides that.
        log.warn(
          `  ⏩ ${behind} blocks behind — skipping ${skipped} unscanned to stay near the head.`
        );
        lastScanned = latest - MAX_CATCHUP_BLOCKS;
      }

      if (latest <= lastScanned) {
        consecutiveFailures = 0;
        continue;
      }

      let sightings: WatchedMint[] = [];
      try {
        sightings = await scanWatchedMints(rpcUrls[0], lastScanned + 1, latest, watchTargets, opts.logChunkBlocks);
        // Only mark this range scanned on success — advancing it on failure
        // would silently skip it forever despite the "retrying" log below.
        lastScanned = latest;
      } catch (err: any) {
        log.error(`  ⚠ block scan failed: ${describeRpcError(err)} — retrying next tick`);
      }

      for (const sighting of sightings) {
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

        log.warnBold(
          `\n  👀 ${sighting.from} minted ${sighting.nftContract} (block ${sighting.blockNumber}) — copying`
        );

        const drop = await buildLocalMintPlan(rpcUrls[0], sighting.nftContract, 1);
        if (!drop) {
          const reason = "no public drop resolvable for this contract";
          log.error(`     ✗ Skipped — ${reason}.`);
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
        const plan = await buildLocalMintPlan(rpcUrls[0], sighting.nftContract, quantity);
        if (!plan) {
          const reason = `drop no longer resolvable at quantity ${quantity}`;
          log.error(`     ✗ Skipped — ${reason}.`);
          await report({ sourceWallet: sighting.from, sourceTxHash: sighting.txHash, nftContract: sighting.nftContract, quantity, outcome: "skipped", reason, txHashes: [] });
          continue;
        }

        try {
          const outcome = await localPublicSnipe({
            nftContract: sighting.nftContract,
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

      consecutiveFailures = 0;
    } catch (err: any) {
      consecutiveFailures++;
      log.error(
        `  ⚠ poll failed (${consecutiveFailures}x): ${describeRpcError(err)} — still running, retrying with backoff`
      );
    }
  }

  log.done(`\n\n  Stopped. Copied ${copied.size} collection(s) this run.`);
}
