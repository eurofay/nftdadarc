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

import chalk from "chalk";
import { JsonRpcProvider } from "ethers";
import { buildLocalMintPlan } from "./seadrop-public";
import { scanPublicDropUpdates, DropSighting } from "./seadrop-events";
import { localPublicSnipe } from "./local-mint";
import { openseaContractInfo } from "./slug-resolver";
import { ChainProfile } from "./chains";

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
  const provider = new JsonRpcProvider(rpcUrls[0]);

  console.log(chalk.bold.magenta("\n── AUTO FREE-MINT WATCHER ──"));
  console.log(chalk.gray(`  Chain:    ${chain.name} (${chain.chainId})`));
  console.log(chalk.gray(`  Wallets:  ${walletKeys.length}`));
  console.log(chalk.gray(`  Polling:  every ${pollIntervalMs}ms via ${rpcUrls[0]}`));
  console.log(
    chalk.yellow(
      "  Fully autonomous: any SeaDrop drop that goes live at price 0 is minted at max-per-wallet\n" +
        "  immediately, no confirmation. Ctrl+C to stop.\n"
    )
  );

  const candidates = new Map<string, DropSighting["drop"]>();
  const fired = new Set<string>();
  let lastScanned = await provider.getBlockNumber();
  let firedCount = 0;

  // Promise.race would only stop *awaiting* the loop, not the loop itself —
  // it would keep polling and could keep auto-firing in the background after
  // claiming to have stopped. This flag actually ends the while loop.
  let stopped = false;
  process.once("SIGINT", () => {
    stopped = true;
  });

  while (!stopped) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (stopped) break;

    const latest = await provider.getBlockNumber();
    if (latest > lastScanned) {
      let sightings: DropSighting[] = [];
      try {
        sightings = await scanPublicDropUpdates(rpcUrls[0], lastScanned + 1, latest);
      } catch (err: any) {
        console.log(chalk.red(`  ⚠ log scan failed: ${err.message} — retrying next tick`));
      }
      lastScanned = latest;

      for (const s of sightings) {
        candidates.set(s.nftContract, s.drop);
        if (s.drop.mintPrice === 0n) {
          console.log(
            chalk.cyan(
              `  ↳ free public drop configured: ${s.nftContract} (block ${s.blockNumber}, max/wallet ${s.drop.maxTotalMintableByWallet})`
            )
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

      fired.add(nftContract); // mark first so a slow mint doesn't get retried next tick
      await mintCandidate(nftContract, drop.maxTotalMintableByWallet);
      firedCount++;

      if (opts.maxMintsPerRun && firedCount >= opts.maxMintsPerRun) {
        console.log(chalk.bold.white(`\n  Reached AUTO_MAX_MINTS_PER_RUN (${opts.maxMintsPerRun}) — stopping.`));
        stopped = true;
        break;
      }
    }
  }

  console.log(chalk.bold.white(`\n\n  Stopped. Auto-fired ${firedCount} collection(s) this run.`));

  async function mintCandidate(nftContract: string, walletCap: number): Promise<void> {
    const quantity = opts.maxQuantityPerWallet
      ? Math.min(walletCap, opts.maxQuantityPerWallet)
      : walletCap;

    console.log(chalk.bold.yellow(`\n  🎯 LIVE FREE MINT: ${nftContract} — firing ${quantity}/wallet`));

    const info = await openseaContractInfo(chain.key, nftContract, opts.openseaApiKey);
    console.log(chalk.gray(`     OpenSea: ${info ? `${info.name} (${info.slug})` : "not found / unverified"}`));

    // Re-read right before firing — the event only proves a drop *was*
    // configured; the chain is the only source that says it's still true now.
    const plan = await buildLocalMintPlan(rpcUrls[0], nftContract, quantity);
    if (!plan) {
      console.log(chalk.red(`     ✗ Skipped — drop no longer resolvable on-chain (ended or restricted).`));
      return;
    }
    if (plan.value !== 0n) {
      console.log(chalk.red(`     ✗ Skipped — price is no longer 0 as of the latest read.`));
      return;
    }

    try {
      await localPublicSnipe({
        nftContract,
        quantity,
        walletKeys,
        rpcUrls,
        maxFeePerGas,
        maxPriorityFee,
        gasLimit,
        targetStart: null,
        plan,
      });
    } catch (err: any) {
      console.log(chalk.red(`     ✗ Auto-mint attempt failed: ${err.message}`));
    }
  }
}
