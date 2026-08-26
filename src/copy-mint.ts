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

import { JsonRpcProvider } from "ethers";
import { buildLocalMintPlan, decodeMintPublic, SEADROP_ADDRESS } from "./seadrop-public";
import { localPublicSnipe } from "./local-mint";
import { ChainProfile } from "./chains";
import { defaultLogger, Logger } from "./logger";

export interface WatchedMint {
  txHash: string;
  from: string;
  nftContract: string;
  blockNumber: number;
}

// Blocks (not events) have to be fetched individually — there's no getLogs
// equivalent for "every tx in this range". Small concurrent batches avoid
// both serial slowness and hammering a rate-limited free-tier RPC.
const BLOCK_BATCH = 5;

export async function scanWatchedMints(
  rpcUrl: string,
  fromBlock: number,
  toBlock: number,
  watchTargets: string[]
): Promise<WatchedMint[]> {
  if (fromBlock > toBlock || watchTargets.length === 0) return [];
  const provider = new JsonRpcProvider(rpcUrl);
  const targets = new Set(watchTargets.map((a) => a.toLowerCase()));
  const found: WatchedMint[] = [];

  const blockNumbers: number[] = [];
  for (let b = fromBlock; b <= toBlock; b++) blockNumbers.push(b);

  for (let i = 0; i < blockNumbers.length; i += BLOCK_BATCH) {
    const batch = blockNumbers.slice(i, i + BLOCK_BATCH);
    const blocks = await Promise.all(batch.map((n) => provider.getBlock(n, true)));

    for (const block of blocks) {
      if (!block) continue;
      for (const tx of block.prefetchedTransactions) {
        if (!tx.from || !tx.to) continue;
        if (!targets.has(tx.from.toLowerCase())) continue;
        if (tx.to.toLowerCase() !== SEADROP_ADDRESS.toLowerCase()) continue;

        const decoded = decodeMintPublic(tx.data);
        if (!decoded) continue;

        found.push({
          txHash: tx.hash,
          from: tx.from,
          nftContract: decoded.nftContract,
          blockNumber: block.number,
        });
      }
    }
  }

  return found;
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
  logger?: Logger;
  stopSignal?: { stopped: boolean };
}

export async function runCopyMintWatcher(opts: CopyMintOpts): Promise<void> {
  const { chain, rpcUrls, walletKeys, watchTargets, maxFeePerGas, maxPriorityFee, gasLimit, pollIntervalMs } = opts;
  const log = opts.logger ?? defaultLogger;
  const provider = new JsonRpcProvider(rpcUrls[0]);

  log.title("\n── COPY-MINT WATCHER ──");
  log.info(`  Chain:    ${chain.name} (${chain.chainId})`);
  log.info(`  Watching: ${watchTargets.length} wallet(s)`);
  log.info(`  Max price accepted: ${opts.maxPriceEth} ETH per wallet`);
  log.warn("  Any mintPublic call from a watched wallet is copied with your own wallets. Ctrl+C to stop.\n");

  const copied = new Set<string>(); // dedupe by "nftContract" so a busy source wallet doesn't trigger repeats
  let lastScanned = await provider.getBlockNumber();

  const signal = opts.stopSignal ?? { stopped: false };
  process.once("SIGINT", () => {
    signal.stopped = true;
  });

  while (!signal.stopped) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (signal.stopped) break;

    const latest = await provider.getBlockNumber();
    if (latest <= lastScanned) continue;

    let sightings: WatchedMint[] = [];
    try {
      sightings = await scanWatchedMints(rpcUrls[0], lastScanned + 1, latest, watchTargets);
    } catch (err: any) {
      log.error(`  ⚠ block scan failed: ${err.message} — retrying next tick`);
    }
    lastScanned = latest;

    for (const sighting of sightings) {
      if (copied.has(sighting.nftContract.toLowerCase())) continue;
      copied.add(sighting.nftContract.toLowerCase());

      log.warnBold(
        `\n  👀 ${sighting.from} minted ${sighting.nftContract} (block ${sighting.blockNumber}) — copying`
      );

      const drop = await buildLocalMintPlan(rpcUrls[0], sighting.nftContract, 1);
      if (!drop) {
        log.error("     ✗ Skipped — couldn't resolve a public drop for this contract.");
        continue;
      }
      const priceEth = Number(drop.drop.mintPrice) / 1e18;
      if (priceEth > opts.maxPriceEth) {
        log.error(`     ✗ Skipped — price ${priceEth} ETH exceeds your ${opts.maxPriceEth} ETH cap.`);
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
        log.error("     ✗ Skipped — drop no longer resolvable at the intended quantity.");
        continue;
      }

      try {
        await localPublicSnipe({
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
      } catch (err: any) {
        log.error(`     ✗ Copy-mint attempt failed: ${err.message}`);
      }
    }
  }

  log.done(`\n\n  Stopped. Copied ${copied.size} collection(s) this run.`);
}
