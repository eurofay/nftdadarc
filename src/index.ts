#!/usr/bin/env node

import path from "path";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { runWizard } from "./wizard";
import { closePrompts } from "./prompt";
import { resolveChain } from "./chains";
import { resolveRpcsForChain } from "./rpc-resolver";
import { runAutoMintWatcher } from "./auto-mint";
import { withPrefix } from "./logger";

const HELP = `
NFT Public Mint Sniper

  Mints public SeaDrop stages. Calldata is built from on-chain state, so no
  OpenSea account or access token is required.

Usage
  npm start              run the interactive wizard
  npm start -- --auto    run the autonomous free-mint watcher
  npm start -- --help    show this message

Wizard mode asks for everything interactively: keys, chain, quantity, NFT
link, RPC, gas and timing. Optional defaults can be set in .env.

Auto mode watches the chain for any SeaDrop public drop going live at
price 0, and mints the max per wallet immediately — no confirmation. It is
config-only (see AUTO_* in .env.example), since nothing prompts. Unlike the
wizard, its wallet keys must live in .env — use a dedicated, low-balance
wallet only. AUTO_CHAIN accepts a comma-separated list (e.g.
"robinhood,ethereum") to watch several chains at once in one process —
output is prefixed per chain, and Ctrl+C stops all of them together.
`;

function gweiToWei(gwei: number): bigint {
  return BigInt(Math.round(gwei * 1e9));
}

async function runAutoForChain(chainKey: string, walletKeys: string[]): Promise<void> {
  const chain = resolveChain(chainKey)!; // validated by caller before any watcher starts
  const log = withPrefix(chainKey);

  const { urls: rpcUrls, source } = resolveRpcsForChain(chainKey);
  log.info(`  RPC source: ${source}`);

  const maxFeeGwei = Number(process.env.MAX_FEE_PER_GAS || (chainKey === "ethereum" ? 80 : 2));
  const priorityGwei = Number(process.env.MAX_PRIORITY_FEE || (chainKey === "ethereum" ? 5 : 0.05));
  const gasLimit = parseInt(process.env.GAS_LIMIT || "0", 10) || 250_000;
  const pollIntervalMs = parseInt(process.env.AUTO_POLL_MS || "0", 10) || 4000;
  const maxQuantityPerWallet = process.env.AUTO_MAX_QUANTITY
    ? parseInt(process.env.AUTO_MAX_QUANTITY, 10)
    : undefined;
  const maxMintsPerRun = process.env.AUTO_MAX_MINTS_PER_RUN
    ? parseInt(process.env.AUTO_MAX_MINTS_PER_RUN, 10)
    : undefined;
  const logChunkBlocks = process.env.AUTO_LOG_CHUNK_BLOCKS
    ? parseInt(process.env.AUTO_LOG_CHUNK_BLOCKS, 10)
    : undefined;

  await runAutoMintWatcher({
    chain,
    rpcUrls,
    walletKeys,
    maxFeePerGas: gweiToWei(maxFeeGwei),
    maxPriorityFee: gweiToWei(priorityGwei),
    gasLimit,
    pollIntervalMs,
    maxQuantityPerWallet,
    maxMintsPerRun,
    openseaApiKey: process.env.OPENSEA_API_KEY,
    logChunkBlocks,
    logger: log,
  });
}

async function runAuto(): Promise<void> {
  const chainKeys = [...new Set(
    (process.env.AUTO_CHAIN || process.env.CHAIN || "base")
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length > 0)
  )];

  // Validate every chain before starting any watcher — a typo in the second
  // chain shouldn't leave the first one running while silently missing the
  // second, with no clear signal anything went wrong.
  for (const key of chainKeys) {
    if (!resolveChain(key)) throw new Error(`Unknown chain "${key}" in AUTO_CHAIN/CHAIN.`);
  }

  const walletKeys = (process.env.AUTO_WALLET_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (walletKeys.length === 0) {
    throw new Error("AUTO_WALLET_KEYS is empty — auto mode has no prompt, so keys must be in .env.");
  }

  if (chainKeys.length > 1) {
    console.log(chalk.gray(`  Watching ${chainKeys.length} chains at once: ${chainKeys.join(", ")}`));
  }
  await Promise.all(chainKeys.map((key) => runAutoForChain(key, walletKeys)));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  try {
    if (args.includes("--auto")) {
      await runAuto();
    } else {
      await runWizard();
    }
    closePrompts();
    process.exit(0);
  } catch (err: any) {
    closePrompts();
    console.error(chalk.red(`\n❌ ${err.message}\n`));
    process.exit(1);
  }
}

void main();
