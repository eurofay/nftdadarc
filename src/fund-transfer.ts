// Batch-send native currency from one funded wallet to several others — for
// topping up sniper wallets before a multi-wallet mint. Not speed-critical
// like a snipe, so this deliberately skips the multi-RPC blast in
// rpc-blast.ts and just sends through one provider, sequentially, with a
// locally-incrementing nonce (each send would otherwise race the same
// "pending" nonce read). Confirmation waiting reuses waitForReceipt from
// rpc-blast.ts (plain fetch + JSON-RPC) rather than ethers' own
// TransactionResponse.wait(), which demands a fully-formed receipt object
// (logsBloom, cumulativeGasUsed, blockHash, ...) from every provider.

import { Wallet, formatEther, TransactionResponse } from "ethers";
import { waitForReceipt } from "./rpc-blast";
import { defaultLogger, Logger } from "./logger";
import { createProvider } from "./rpc-provider";

const TRANSFER_GAS_LIMIT = 21_000n;

export interface BatchTransferOpts {
  rpcUrl: string;
  sourceKey: string;
  targets: string[];
  amountWei: bigint; // sent to EACH target
  maxFeePerGas: bigint;
  maxPriorityFee: bigint;
  logger?: Logger;
  confirmTimeoutMs?: number; // per-transfer receipt wait, default 60s
}

export interface TransferOutcome {
  to: string;
  txHash: string | null;
  status?: "SUCCESS" | "FAILED" | "TIMEOUT";
  error?: string;
}

// Worst-case cost assuming every tx burns the full maxFeePerGas ceiling —
// same pessimistic-but-safe bound the wizard uses for mint affordability.
export function estimateBatchCost(targetCount: number, amountWei: bigint, maxFeePerGas: bigint): bigint {
  return BigInt(targetCount) * (amountWei + TRANSFER_GAS_LIMIT * maxFeePerGas);
}

export async function batchTransfer(opts: BatchTransferOpts): Promise<TransferOutcome[]> {
  const { rpcUrl, sourceKey, targets, amountWei, maxFeePerGas, maxPriorityFee } = opts;
  const log = opts.logger ?? defaultLogger;
  const provider = createProvider(rpcUrl);
  const wallet = new Wallet(sourceKey, provider);

  log.title("\n── BATCH FUND TRANSFER ──");
  log.info(`  From: ${wallet.address}`);
  log.info(`  To ${targets.length} wallet(s), ${formatEther(amountWei)} each`);

  const [balance, nonce0, network] = await Promise.all([
    provider.getBalance(wallet.address),
    provider.getTransactionCount(wallet.address, "pending"),
    provider.getNetwork(),
  ]);

  const worstCase = estimateBatchCost(targets.length, amountWei, maxFeePerGas);
  if (balance < worstCase) {
    log.errorBold(
      `  ✗ Insufficient balance — need up to ${formatEther(worstCase)}, source only has ${formatEther(balance)}.`
    );
    return targets.map((to) => ({ to, txHash: null, error: "aborted: insufficient source balance" }));
  }

  const sent: { to: string; response: TransactionResponse | null; error?: string }[] = [];
  for (let i = 0; i < targets.length; i++) {
    const to = targets[i];
    try {
      const response = await wallet.sendTransaction({
        to,
        value: amountWei,
        nonce: nonce0 + i,
        maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFee,
        gasLimit: TRANSFER_GAS_LIMIT,
        type: 2,
        chainId: network.chainId,
      });
      log.success(`  → ${to}: ${response.hash}`);
      sent.push({ to, response });
    } catch (err: any) {
      log.error(`  → ${to}: FAILED to send — ${err.message}`);
      sent.push({ to, response: null, error: err.message });
    }
  }

  log.info("\n  Waiting for confirmations...");
  const results: TransferOutcome[] = await Promise.all(
    sent.map(async ({ to, response, error }): Promise<TransferOutcome> => {
      if (!response) return { to, txHash: null, error };
      const receipt = await waitForReceipt(response.hash, rpcUrl, opts.confirmTimeoutMs ?? 60_000);
      if (!receipt) return { to, txHash: response.hash, status: "TIMEOUT" };
      return { to, txHash: response.hash, status: receipt.status === "SUCCESS" ? "SUCCESS" : "FAILED" };
    })
  );

  const succeeded = results.filter((r) => r.status === "SUCCESS").length;
  log.done(`\n===== BATCH TRANSFER COMPLETE: ${succeeded}/${targets.length} confirmed =====`);
  return results;
}
