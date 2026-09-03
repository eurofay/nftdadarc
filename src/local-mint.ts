// Public-mint execution with no API in the loop.
//
// Because the calldata is known ahead of time (see seadrop-public.ts), every
// transaction can be signed and serialised *before* the stage opens. At T-0 the
// only work left is writing bytes to sockets — no API poll, no signing, no
// encoding. That is strictly faster than the OpenSea path, which cannot sign
// until the API hands over calldata roughly a second after the stage starts.
//
// Worth being precise, since this repo now uses OpenSea elsewhere (portfolio,
// activity alerts, selling): none of that touches the path below. Firing a
// mint reads only chain state, so it still works when OpenSea is down,
// rate-limiting, or has never indexed the collection. The one OpenSea thing
// involved is an on-chain address — their fee recipient, which SeaDrop itself
// requires as a mint parameter (see seadrop-public.ts) — not a network call.

import { performance } from "perf_hooks";
import { Wallet, formatEther, formatUnits } from "ethers";
import { blastToAll, parseRpcEndpoints, prepareBlast, waitForReceipt, PreparedBlast } from "./rpc-blast";
import { warmConnections, startWarmKeeper } from "./connection-warmer";
import { waitForMintTime } from "./timer";
import { explorerTx } from "./chains";
import { LocalMintPlan } from "./seadrop-public";
import { defaultLogger, Logger } from "./logger";
import { gasLimitForQuantity } from "./gas";
import { fitFeeToBalance, fitPriority } from "./gas-fit";
import { createProvider } from "./rpc-provider";

export interface LocalSnipeOpts {
  nftContract: string;
  quantity: number;
  walletKeys: string[];
  rpcUrls: string[];
  maxFeePerGas: bigint;
  maxPriorityFee: bigint;
  gasLimit: number;
  targetStart: Date | null;
  plan: LocalMintPlan;
  logger?: Logger; // defaults to printing locally — the Telegram bot passes one that also forwards to a chat
}

// Returned so callers can record what was actually acquired. Only a
// confirmed on-chain SUCCESS counts — a dispatched tx that reverted or timed
// out is not a mint, and portfolio tracking that assumed otherwise would
// quietly fill up with NFTs that were never received.
export interface SnipeOutcome {
  nftContract: string;
  quantity: number;
  chainId: number;
  minted: { address: string; txHash: string; block: number }[];
}

export async function localPublicSnipe(opts: LocalSnipeOpts): Promise<SnipeOutcome> {
  const {
    nftContract, quantity, walletKeys, rpcUrls,
    maxFeePerGas, maxPriorityFee, gasLimit, targetStart, plan,
  } = opts;
  const log = opts.logger ?? defaultLogger;

  const provider = createProvider(rpcUrls[0]);
  const endpoints = parseRpcEndpoints(rpcUrls);
  const wallets = walletKeys.map((k) => new Wallet(k, provider));

  log.title("\n── PUBLIC MINT · on-chain only, no API ──");
  log.info(`  SeaDrop:       ${plan.to}`);
  log.info(`  NFT:           ${nftContract}`);
  log.info(`  Fee recipient: ${plan.feeRecipient}`);
  log.info(
    `  Price:         ${formatEther(plan.drop.mintPrice)} × ${quantity} = ${formatEther(plan.value)} per wallet`
  );
  log.info(`  Calldata:      ${(plan.data.length - 2) / 2} bytes (identical for every wallet)`);

  // ── Warm sockets and pre-fetch everything the signature depends on ──
  await warmConnections(rpcUrls, log);

  const [nonces, network, balances, head] = await Promise.all([
    Promise.all(wallets.map((w) => provider.getTransactionCount(w.address, "pending"))),
    provider.getNetwork(),
    // Balances and base fee feed the per-wallet fee fitting below. Fetched
    // here, with the nonces, so none of it lands on the critical path.
    Promise.all(wallets.map((w) => provider.getBalance(w.address).catch(() => null))),
    provider.getBlock("latest").catch(() => null),
  ]);
  const chainId = network.chainId;
  const baseFee = head?.baseFeePerGas ?? 0n;
  log.info(`  Nonces: [${nonces.join(", ")}] | chainId: ${chainId}`);

  // ── Sign everything now, well before the stage opens ──
  const signStart = performance.now();
  const effectiveGasLimit = gasLimit > 0 ? gasLimit : gasLimitForQuantity(quantity);
  const prepared: { idx: number; address: string; blast: PreparedBlast }[] = [];

  for (let i = 0; i < wallets.length; i++) {
    // The configured maxFee is a worst-case allowance, and a node reserves it
    // in full — so a wallet holding the price plus modest gas is refused by
    // the protocol before the mint is ever attempted. Where that wallet can
    // still cover a viable fee, sign it at the lower ceiling rather than lose
    // the mint. A wallet that can afford the configured fee is untouched.
    let walletMaxFee = maxFeePerGas;
    let walletPriority = maxPriorityFee;

    const balance = balances[i];
    if (balance !== null) {
      const fit = fitFeeToBalance({
        balanceWei: balance,
        mintValueWei: plan.value,
        gasLimit: effectiveGasLimit,
        configuredMaxFeeWei: maxFeePerGas,
        baseFeeWei: baseFee,
        priorityWei: maxPriorityFee,
      });
      if (!fit) {
        log.error(
          `    [W${i}] ${wallets[i].address} skipped — ${formatEther(balance)} won't cover the mint plus a viable fee.`
        );
        continue;
      }
      if (fit.reduced) {
        walletMaxFee = fit.maxFeePerGas;
        walletPriority = fitPriority(fit.maxFeePerGas, maxPriorityFee);
        log.warn(
          `    [W${i}] fee ceiling lowered to ${formatUnits(walletMaxFee, "gwei")} gwei to fit this balance.`
        );
      }
    }

    const rawTx = await wallets[i].signTransaction({
      to: plan.to,
      data: plan.data,
      value: plan.value,
      nonce: nonces[i],
      maxFeePerGas: walletMaxFee,
      maxPriorityFeePerGas: walletPriority,
      // 0 (or unset) means "size it from the quantity" — see gas.ts. A
      // non-zero value is an explicit override and is honoured as given.
      gasLimit: effectiveGasLimit,
      type: 2,
      chainId,
    });
    prepared.push({ idx: i, address: wallets[i].address, blast: prepareBlast(rawTx) });
  }

  if (prepared.length === 0) {
    log.errorBold("  No wallet could cover this mint — nothing signed, nothing sent.");
    return { nftContract, quantity, chainId: Number(chainId), minted: [] };
  }

  log.success(
    `  ✓ ${prepared.length} tx(s) signed and serialised in ${(performance.now() - signStart).toFixed(1)}ms — nothing left to compute at fire time`
  );

  // ── Wait for the stage, then blast pre-built bytes ──
  //
  // The connections warmed above go cold during the wait — Node drops an
  // idle keep-alive socket after a few seconds, and a scheduled stage can
  // be hours away. Firing on a cold socket pays a TCP and a TLS handshake
  // before the transaction moves: measured against this sequencer at
  // ~765ms cold versus ~245ms warm, three round trips instead of one. The
  // keeper holds the pool open through the run-up.
  const stopWarmKeeper = startWarmKeeper(rpcUrls, targetStart ? targetStart.getTime() : null);
  try {
    if (targetStart) {
      await waitForMintTime(targetStart, 0);
    } else {
      log.warnBold("\n  🚀 Firing immediately...");
    }
  } finally {
    // Stop before dispatching: a ping racing the real transaction for the
    // same socket is the one thing this must not do.
    stopWarmKeeper();
  }

  const stageStartMs = targetStart ? targetStart.getTime() : Date.now();
  const dispatchStart = performance.now();

  const fired = prepared.map(({ idx, address, blast }) => {
    const { txHash, responsePromise } = blastToAll(blast, endpoints);
    return { idx, address, txHash, responsePromise };
  });

  const dispatchMs = (performance.now() - dispatchStart).toFixed(2);
  const sinceStage = Math.max(0, Date.now() - stageStartMs);
  log.successBold(`  DISPATCHED ${fired.length} tx(s) (${dispatchMs}ms, +${sinceStage}ms after stage)`);
  for (const f of fired) {
    log.info(`    [W${f.idx}] ${f.txHash}`);
  }

  // Dispatch only means "bytes written". Find out whether any endpoint actually
  // took the transaction before promising a receipt that may never exist.
  const settled = await Promise.all(
    fired.map(async (f) => ({ ...f, results: await f.responsePromise }))
  );

  const accepted = settled.filter(({ results }) =>
    results.some((r) => r.txHash !== null || (r.error ?? "").includes("already known"))
  );
  const rejected = settled.filter((s) => !accepted.includes(s));

  for (const { idx, results } of rejected) {
    const reasons = [...new Set(results.map((r) => r.error).filter(Boolean))];
    log.errorBold(`\n  ✗ [W${idx}] REJECTED by every RPC — never broadcast.`);
    for (const reason of reasons) log.error(`      ${reason}`);
    if (reasons.some((r) => (r ?? "").includes("less than block base fee"))) {
      log.warn("      → Your max fee is under the chain's base fee. Raise it and re-run.");
    }
  }

  const outcome: SnipeOutcome = {
    nftContract,
    quantity,
    chainId: Number(chainId),
    minted: [],
  };

  if (accepted.length === 0) {
    log.errorBold("\n===== NOTHING WAS BROADCAST — no receipts to wait for =====\n");
    return outcome;
  }

  // ── Receipts (only for txs an endpoint actually accepted) ──
  log.info("\n  Waiting for receipts...");
  await Promise.all(
    accepted.map(async ({ idx, address, txHash }) => {
      const receipt = await waitForReceipt(txHash, rpcUrls[0], 60_000);
      if (!receipt) {
        log.warn(`  [W${idx}] TIMEOUT — check: ${explorerTx(chainId, txHash)}`);
        return;
      }
      const emit = receipt.status === "SUCCESS" ? log.successBold : log.errorBold;
      emit(`  [W${idx}] Block: ${receipt.block} | Pos: ${receipt.position} | ${receipt.status} | Gas: ${receipt.gasUsed}`);
      log.info(`  [W${idx}] Track: ${explorerTx(chainId, txHash)}`);
      if (receipt.status === "SUCCESS") {
        outcome.minted.push({ address, txHash, block: receipt.block });
      }
    })
  );

  log.done("\n===== LOCAL PUBLIC MINT COMPLETE =====");
  return outcome;
}
