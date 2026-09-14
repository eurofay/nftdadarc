#!/usr/bin/env node

import path from "path";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { runWizard } from "./wizard";
import { closePrompts } from "./prompt";
import { resolveChain, logChunkBlocksFor } from "./chains";
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
  npm start -- --dry-run --contract 0x… --wallets 0x…,0x… [options]
  npm start -- --help    show this message

Dry run options
  --contract 0x…         the NFT contract to mint (required)
  --wallets 0x…,0x…      addresses to check (required; keys are never read)
  --quantity N           how many per wallet (default 1)
  --chain <key>          ethereum | base | robinhood | … (default CHAIN in .env)
  --mint-fn "sig"        the mint function, when it isn't auto-detected
  --mint-args a,b,c      what each argument means: quantity, minter, proof,
                         signature, allowance, price, currency, nonce, tokenId,
                         empty, operator
  --list <uri>           the project's published allow list, for a Merkle stage
  --auth-api <url>       the project's authorisation endpoint, for a signed
                         stage; {address} is replaced per wallet
  --price <wei>          price per token, where the contract exposes none

A dry run does everything except sign: it reads the contract, resolves the
stage, obtains each wallet's proof or signature, builds that wallet's calldata
and simulates it. It never signs and never broadcasts — only addresses are
needed, so no private key is read at all.

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
  const logChunkBlocks = logChunkBlocksFor(chainKey);

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

/** `--flag value`, or undefined. Kept tiny so the CLI needs no arg parser. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= args.length) return undefined;
  const value = args[i + 1];
  return value.startsWith("--") ? undefined : value;
}

/**
 * Resolve and simulate a mint without signing anything.
 *
 * Deliberately takes ADDRESSES, not keys. There is no code path from here to a
 * signature, which is a stronger guarantee than a flag that says so.
 */
async function runDryRun(args: string[]): Promise<void> {
  const { dryRun } = await import("./dry-run");

  const contract = flag(args, "contract");
  const wallets = (flag(args, "wallets") ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);

  if (!contract || wallets.length === 0) {
    console.error(chalk.red("\n--dry-run needs --contract 0x… and --wallets 0x…,0x…\n"));
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  const mintArgs = flag(args, "mint-args");
  const authApi = flag(args, "auth-api");
  const price = flag(args, "price");

  const result = await dryRun({
    chainKey: flag(args, "chain") ?? process.env.CHAIN ?? "ethereum",
    contract,
    wallets,
    quantity: Number(flag(args, "quantity") ?? 1) || 1,
    generic: {
      signature: flag(args, "mint-fn"),
      args: mintArgs ? (mintArgs.split(",").map((a) => a.trim()) as never) : undefined,
      listUri: flag(args, "list"),
      authApi: authApi ? { kind: "api", urlTemplate: authApi } : undefined,
      priceWei: price === undefined ? undefined : BigInt(price),
    },
  });

  console.log(result.lines.join("\n"));
  // A non-zero exit when nothing would send, so this is usable in a script
  // that should stop rather than proceed to a real mint.
  process.exitCode = result.ready > 0 ? 0 : 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  try {
    if (args.includes("--dry-run")) {
      await runDryRun(args);
    } else if (args.includes("--auto")) {
      await runAuto();
    } else {
      await runWizard();
    }
    closePrompts();
    // A dry run that found nothing sendable sets a non-zero code, so it can
    // gate a script rather than being read by a human every time. Exiting a
    // flat 0 here would throw that away.
    process.exit(process.exitCode ? Number(process.exitCode) : 0);
  } catch (err: any) {
    closePrompts();
    console.error(chalk.red(`\n❌ ${err.message}\n`));
    process.exit(1);
  }
}

void main();
