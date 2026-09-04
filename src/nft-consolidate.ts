// Gather NFTs from the wallets that minted them into one wallet.
//
// Copy mint and auto mint spread a collection across every wallet that fired.
// That is what you want at mint time and the opposite of what you want
// afterwards: listing, accepting an offer, or simply seeing what you own all
// get easier once a collection sits in one place.
//
// Purely on-chain — balanceOf / tokenOfOwnerByIndex to find them,
// safeTransferFrom to move them — so this works for collections no
// marketplace has indexed, which on this chain is most of the recent ones.
// Nothing here touches the OpenSea API.

import { Contract, Interface, Wallet, formatEther } from "ethers";
import { createProvider } from "./rpc-provider";
import { waitForReceipt } from "./rpc-blast";
import { Logger, defaultLogger } from "./logger";

const ERC721 = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
]);

// safeTransferFrom to an EOA is ~60k, but an Enumerable collection rewrites
// two owner indexes on the way out, and a receiver hook can add more. Sized
// to cover that rather than to be tight: a transfer that runs out of gas
// still costs the gas it burned.
export const TRANSFER_GAS_LIMIT = 150_000n;

/** One movable token, and the wallet holding it. */
export interface HeldToken {
  owner: string;
  tokenId: bigint;
}

export interface SkippedWallet {
  address: string;
  reason: string;
}

export interface ConsolidationPlan {
  contract: string;
  destination: string;
  tokens: HeldToken[];
  /** Wallets holding nothing here, or whose holdings could not be read. */
  skipped: SkippedWallet[];
}

/**
 * Worst case, assuming every transfer burns the full fee ceiling.
 *
 * The same pessimistic bound the funding wizard uses — it is what the node
 * reserves upfront, so it is what actually has to be in the wallet.
 */
export function estimateConsolidationCost(tokenCount: number, maxFeePerGas: bigint): bigint {
  return BigInt(tokenCount) * TRANSFER_GAS_LIMIT * maxFeePerGas;
}

/** Tokens grouped by the wallet that holds them, in first-seen order. */
export function groupByOwner(tokens: HeldToken[]): Map<string, bigint[]> {
  const byOwner = new Map<string, bigint[]>();
  for (const t of tokens) {
    const existing = byOwner.get(t.owner);
    if (existing) existing.push(t.tokenId);
    else byOwner.set(t.owner, [t.tokenId]);
  }
  return byOwner;
}

/**
 * Read what each wallet holds in this collection.
 *
 * Enumeration uses tokenOfOwnerByIndex, the ERC-721 Enumerable extension.
 * Most SeaDrop collections implement it; one that does not cannot be walked
 * from the chain alone, so that wallet is reported as skipped along with its
 * balance rather than silently contributing nothing to the plan.
 */
export async function planConsolidation(
  rpcUrl: string,
  contract: string,
  owners: string[],
  destination: string
): Promise<ConsolidationPlan> {
  const provider = createProvider(rpcUrl);
  const nft = new Contract(contract, ERC721, provider);
  const tokens: HeldToken[] = [];
  const skipped: SkippedWallet[] = [];

  for (const owner of owners) {
    // The destination keeps what it already holds; a self-transfer would burn
    // gas to change nothing.
    if (owner.toLowerCase() === destination.toLowerCase()) continue;

    let balance: bigint;
    try {
      balance = await nft.balanceOf(owner);
    } catch (err: any) {
      const detail = err?.shortMessage ?? err?.message ?? String(err);
      skipped.push({ address: owner, reason: `could not read balance — ${detail}` });
      continue;
    }

    if (balance === 0n) {
      skipped.push({ address: owner, reason: "holds none" });
      continue;
    }

    const found: bigint[] = [];
    let enumerable = true;
    for (let i = 0n; i < balance; i++) {
      try {
        found.push(await nft.tokenOfOwnerByIndex(owner, i));
      } catch {
        enumerable = false;
        break;
      }
    }

    // Partial enumeration is worse than none: it would move some tokens and
    // leave the rest behind without saying so. Report the whole wallet.
    if (!enumerable) {
      skipped.push({
        address: owner,
        reason: `holds ${balance}, but the collection is not enumerable — move these by token id`,
      });
      continue;
    }
    for (const tokenId of found) tokens.push({ owner, tokenId });
  }

  return { contract, destination, tokens, skipped };
}

export interface TransferResult {
  tokenId: bigint;
  from: string;
  txHash: string | null;
  status?: "SUCCESS" | "FAILED" | "TIMEOUT";
  error?: string;
}

export interface ConsolidateOpts {
  rpcUrl: string;
  plan: ConsolidationPlan;
  /** Decrypted key for a holding wallet. Throwing here skips that wallet. */
  keyFor: (owner: string) => string;
  maxFeePerGas: bigint;
  maxPriorityFee: bigint;
  logger?: Logger;
  confirmTimeoutMs?: number;
}

/**
 * Move every planned token to the destination.
 *
 * Sends are serialized per wallet with a locally-incremented nonce, because
 * transfers from one address share a nonce and firing them together would
 * collide. A failure never stops the rest: a partly finished consolidation is
 * worth far more than an all-or-nothing one that aborts on the first bad
 * token, and every token here is independent of the others.
 */
export async function consolidate(opts: ConsolidateOpts): Promise<TransferResult[]> {
  const log = opts.logger ?? defaultLogger;
  const provider = createProvider(opts.rpcUrl);
  const byOwner = groupByOwner(opts.plan.tokens);

  log.title("\n── CONSOLIDATE NFTs ──");
  log.info(`  Collection: ${opts.plan.contract}`);
  log.info(`  ${opts.plan.tokens.length} token(s) from ${byOwner.size} wallet(s) → ${opts.plan.destination}`);

  const sent: TransferResult[] = [];

  for (const [owner, tokenIds] of byOwner) {
    let wallet: Wallet;
    try {
      wallet = new Wallet(opts.keyFor(owner), provider);
    } catch (err: any) {
      const error = `no usable key — ${err?.message ?? err}`;
      log.error(`  ✗ ${owner}: ${error}`);
      for (const tokenId of tokenIds) sent.push({ tokenId, from: owner, txHash: null, error });
      continue;
    }

    // Gas comes out of the holding wallet, not the destination. A wallet that
    // spent itself down minting can hold the NFT and still not afford to move
    // it — worth saying once, plainly, instead of letting each send fail.
    const needed = estimateConsolidationCost(tokenIds.length, opts.maxFeePerGas);
    const balance = await provider.getBalance(owner);
    if (balance < needed) {
      const error = `needs up to ${formatEther(needed)} for gas, holds ${formatEther(balance)}`;
      log.error(`  ✗ ${owner}: ${error}`);
      for (const tokenId of tokenIds) sent.push({ tokenId, from: owner, txHash: null, error });
      continue;
    }

    let nonce = await provider.getTransactionCount(owner, "pending");
    const nft = new Contract(opts.plan.contract, ERC721, wallet);

    for (const tokenId of tokenIds) {
      try {
        const tx = await nft.safeTransferFrom(owner, opts.plan.destination, tokenId, {
          nonce: nonce,
          maxFeePerGas: opts.maxFeePerGas,
          maxPriorityFeePerGas: opts.maxPriorityFee,
          gasLimit: TRANSFER_GAS_LIMIT,
        });
        nonce++;
        log.success(`  → #${tokenId} from ${owner.slice(0, 8)}…: ${tx.hash}`);
        sent.push({ tokenId, from: owner, txHash: tx.hash });
      } catch (err: any) {
        // The nonce was never consumed, so the next token reuses it.
        const error = err?.shortMessage ?? err?.message ?? String(err);
        log.error(`  ✗ #${tokenId} from ${owner.slice(0, 8)}…: ${error}`);
        sent.push({ tokenId, from: owner, txHash: null, error });
      }
    }
  }

  log.info("\n  Waiting for confirmations...");
  const results = await Promise.all(
    sent.map(async (r): Promise<TransferResult> => {
      if (!r.txHash) return r;
      const receipt = await waitForReceipt(r.txHash, opts.rpcUrl, opts.confirmTimeoutMs ?? 60_000);
      if (!receipt) return { ...r, status: "TIMEOUT" };
      return { ...r, status: receipt.status === "SUCCESS" ? "SUCCESS" : "FAILED" };
    })
  );

  const ok = results.filter((r) => r.status === "SUCCESS").length;
  log.done(`\n===== CONSOLIDATION COMPLETE: ${ok}/${results.length} confirmed =====`);
  return results;
}

/** What happened, in one message. */
export function summarise(results: TransferResult[], destination: string): string {
  if (results.length === 0) return "Nothing to move.";

  const confirmed = results.filter((r) => r.status === "SUCCESS");
  const pending = results.filter((r) => r.txHash && r.status === "TIMEOUT");
  const failed = results.filter((r) => !r.txHash || r.status === "FAILED");

  const lines = [`📦 ${confirmed.length}/${results.length} moved to ${destination.slice(0, 8)}…`];
  if (pending.length > 0) {
    lines.push(`⏳ ${pending.length} sent but not confirmed yet — they may still land.`);
  }
  if (failed.length > 0) {
    lines.push(`❌ ${failed.length} failed:`);
    // Grouped by reason: twenty tokens failing the same way is one problem,
    // and listing it twenty times buries it.
    const byReason = new Map<string, number>();
    for (const f of failed) {
      const reason = f.error ?? "reverted on chain";
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }
    for (const [reason, count] of byReason) lines.push(`  ${count}× ${reason}`);
  }
  return lines.join("\n");
}
