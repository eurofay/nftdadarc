// `--dry-run`: work out the whole mint, then stop before signing anything.
//
// Every step the real path takes -- connect, read the contract, resolve the
// stage, obtain each wallet's authorisation, build its calldata, simulate it
// -- and then it prints what it found and exits. It never signs and never
// broadcasts. Wallet ADDRESSES are enough for all of it; the private keys are
// not read, which is the strongest possible guarantee that nothing can be
// sent.
//
// This is the thing to run before a drop. A mint that is going to fail almost
// always fails for a reason that is visible an hour early -- not on the list,
// wrong list, sold out, stage misconfigured, wallet underfunded -- and every
// one of those is cheaper to find here than in the race.

import chalk from "chalk";
import { formatEther } from "ethers";
import { ResolvedMint, GenericMintConfig, resolveMint } from "./mint-resolve";
import { MintSpec } from "./mint-spec";
import { ContractProfile, describeProfile, probeContract } from "./contract-probe";
import { readStages, describeStages } from "./seadrop-stages";
import { resolveChain } from "./chains";
import { resolveRpcsForChain } from "./rpc-resolver";
import { createProvider } from "./rpc-provider";
import { simulateMint } from "./mint-simulate";
import { gasLimitForQuantity } from "./gas";

export interface DryRunOpts {
  chainKey: string;
  contract: string;
  quantity: number;
  /** Addresses only. No key is read, so nothing can be signed. */
  wallets: string[];
  generic?: GenericMintConfig;
  /** Defaults to the chain's configured endpoints. */
  rpcUrls?: string[];
}

export interface DryRunResult {
  resolved: ResolvedMint | null;
  profile: ContractProfile | null;
  spec: MintSpec | null;
  lines: string[];
  /** How many wallets would actually have sent something. */
  ready: number;
}

/**
 * Everything short of signing.
 *
 * Returns the lines rather than printing them, so the same routine serves the
 * CLI and the Telegram bot's Dry Run button without either owning the output.
 */
export async function dryRun(opts: DryRunOpts): Promise<DryRunResult> {
  const lines: string[] = [];
  const chain = resolveChain(opts.chainKey);
  const symbol = chain?.nativeSymbol ?? "ETH";
  const rpcUrls = opts.rpcUrls ?? resolveRpcsForChain(opts.chainKey).urls;

  lines.push(
    chalk.bold(`── DRY RUN · ${chain?.name ?? opts.chainKey} ──`),
    `  Contract: ${opts.contract}`,
    `  Wallets:  ${opts.wallets.length}`,
    `  RPC:      ${rpcUrls[0]}`,
    ""
  );

  // ── What is this contract? ───────────────────────────────────────────────
  const profile = await probeContract(rpcUrls[0], opts.contract);
  if (!profile.isContract) {
    lines.push(chalk.red(profile.notes.join("\n")));
    return { resolved: null, profile, spec: null, lines, ready: 0 };
  }

  const stages = await readStages(rpcUrls[0], opts.contract).catch(() => []);
  if (stages.some((s) => s.present)) {
    // A SeaDrop collection: its own stage reader says far more than the
    // generic probe can.
    lines.push(chalk.bold("SeaDrop stages"), describeStages(stages), "");
  } else {
    lines.push(chalk.bold("Contract"), describeProfile(profile, symbol), "");
  }

  // ── How would it be minted, and by whom? ─────────────────────────────────
  let spec: MintSpec | null = null;
  const resolved = await resolveMint({
    rpcUrls,
    chainKey: opts.chainKey,
    chainId: chain?.chainId ?? 1,
    contract: opts.contract,
    wallets: opts.wallets,
    quantity: opts.quantity,
    generic: opts.generic,
    onGenericSpec: (s) => {
      spec = s;
    },
    // No signerFor: OpenSea's route needs a SIWE signature, and a dry run
    // signs nothing at all -- not even a login. If that route is the only one
    // available, this says so rather than quietly signing.
  });

  if (!resolved) {
    lines.push(
      chalk.red("Could not work out how to mint this contract."),
      "",
      "Supply the mint function and what each argument means, and this will build and",
      "simulate it. Nothing can infer them from the address alone."
    );
    return { resolved: null, profile, spec: null, lines, ready: 0 };
  }

  lines.push(chalk.bold("Resolution"), ...resolved.notes, "");

  if (resolved.startTimeMs) {
    const opens = new Date(resolved.startTimeMs);
    const away = opens.getTime() - Date.now();
    lines.push(
      `Opens ${opens.toISOString()}` +
        (away > 0 ? ` — ${Math.round(away / 1000)}s away` : " — already open"),
      ""
    );
  }

  // ── Would each wallet's transaction actually work? ───────────────────────
  const provider = createProvider(rpcUrls[0]);
  const gasLimit = gasLimitForQuantity(resolved.quantity);
  const head = await provider.getBlock("latest").catch(() => null);
  const maxFee = (head?.baseFeePerGas ?? 1_000_000_000n) * 2n;

  lines.push(chalk.bold("Wallets"));
  let ready = 0;

  for (const { address, plan } of resolved.plans) {
    const balance = await provider.getBalance(address).catch(() => null);
    const required = BigInt(gasLimit) * maxFee + plan.value;

    if (balance !== null && balance < required) {
      // A node reserves gasLimit x maxFee plus the value before it will accept
      // the transaction at all, so this wallet would be refused by the
      // protocol before the mint was ever attempted.
      lines.push(
        chalk.red(
          `  ✗ ${address} — holds ${formatEther(balance)} ${symbol}, needs ${formatEther(required)}`
        )
      );
      continue;
    }

    const sim = await simulateMint({
      rpcUrl: rpcUrls[0],
      from: address,
      to: plan.to,
      data: plan.data,
      value: plan.value,
    });

    if (sim.ok) {
      ready++;
      lines.push(
        chalk.green(`  ✓ ${address} — would send ${formatEther(plan.value)} ${symbol}, simulates clean`)
      );
    } else if (sim.failure && (sim.failure.code === "DROP_NOT_STARTED" || sim.failure.code === "STAGE_NOT_ACTIVE")) {
      // Correct behaviour for a stage that has not opened. Counted as ready,
      // because the transaction is right and only the clock is not.
      ready++;
      lines.push(
        chalk.yellow(
          `  ⏳ ${address} — would send ${formatEther(plan.value)} ${symbol}; reverts only because the stage is not open ("${sim.failure.detail}")`
        )
      );
    } else {
      lines.push(chalk.red(`  ✗ ${address} — ${sim.failure?.code}: ${sim.failure?.detail}`));
    }
  }

  for (const s of resolved.skipped) {
    lines.push(chalk.gray(`  – ${s.address} — ${s.reason}`));
  }

  lines.push(
    "",
    chalk.bold(
      `${ready} of ${opts.wallets.length} wallet(s) would send. Nothing was signed and nothing was broadcast.`
    )
  );
  return { resolved, profile, spec, lines, ready };
}
