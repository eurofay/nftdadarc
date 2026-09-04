// Gather NFTs from the wallets that minted them into one wallet.
//
// Copy mint and auto mint spread a collection across every wallet that fired.
// That is what you want at mint time and the opposite of what you want
// afterwards: listing, accepting an offer, or simply seeing what you own all
// get easier once a collection sits in one place.
//
// Purely on-chain — balanceOf and either enumeration or an ownerOf walk to
// find them, safeTransferFrom to move them — so this works for collections no
// marketplace has indexed, which on this chain is most of the recent ones.
// Nothing here touches the OpenSea API.

import { Contract, Interface, Wallet, formatEther } from "ethers";
import { createProvider } from "./rpc-provider";
import { readableRpcs } from "./fast-read";
import { waitForReceipt } from "./rpc-blast";
import { Logger, defaultLogger } from "./logger";

const ERC721 = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
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

/** What a scan across a set of wallets turned up, before anything is chosen. */
export interface ScanResult {
  contract: string;
  tokens: HeldToken[];
  skipped: SkippedWallet[];
}

/** One wallet's holdings, for picking sources from. */
export interface Holder {
  address: string;
  tokenIds: bigint[];
}

/** Wallets that hold something, most-held first, then by first-seen order. */
export function holders(scan: ScanResult): Holder[] {
  return [...groupByOwner(scan.tokens)]
    .map(([address, tokenIds]) => ({ address, tokenIds }))
    .sort((a, b) => b.tokenIds.length - a.tokenIds.length);
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

// How long an endpoint gets to prove it can answer before the walk starts.
// Short on purpose: this is one cheap call to a node that either works or
// does not, and the walk behind it makes thousands.
const HEALTH_CHECK_MS = 5_000;

/**
 * The endpoints that can actually answer, checked once up front.
 *
 * The walk deals work out across every endpoint, so a dead one is not merely
 * useless — it is actively expensive. Every call routed to it has to reach
 * its own timeout before failing over, and with thousands of calls that turns
 * a 90-second walk into one that never finishes. Measured: adding a single
 * unreachable host to a two-endpoint walk took it past nine minutes.
 *
 * So each endpoint answers one cheap call first, and only the ones that do
 * take part. If none answer, the first is returned anyway so the caller fails
 * with a real RPC error rather than an empty-list one.
 */
async function healthyContracts(urls: string[], contract: string): Promise<Contract[]> {
  const checks = await Promise.all(
    urls.map(async (url) => {
      try {
        // getBlockNumber, deliberately: this has to test the ENDPOINT, not
        // the contract. The first version probed balanceOf(address(0)), which
        // ERC-721 reverts on by specification -- so every healthy endpoint
        // failed its own health check, the list came back empty, and the
        // fallback then picked whichever url was listed first. Which, in the
        // one case this exists to handle, was the dead one.
        await Promise.race([
          createProvider(url, HEALTH_CHECK_MS).getBlockNumber(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("health check timed out")), HEALTH_CHECK_MS)),
        ]);
        return new Contract(contract, ERC721, createProvider(url));
      } catch {
        return null;
      }
    })
  );
  const healthy = checks.filter((c): c is Contract => c !== null);
  // Nothing answered: hand back the first anyway, so the caller fails with a
  // real RPC error rather than an empty-list one that says nothing.
  return healthy.length > 0 ? healthy : [new Contract(contract, ERC721, createProvider(urls[0]))];
}

export interface ScanOptions {
  /** Called as the walk advances, so a slow scan can show it is alive. */
  onProgress?: (checked: number, total: number) => void;
}

/**
 * Read what each wallet holds in this collection.
 *
 * Done before anything is chosen, so the wallets that actually hold the
 * collection can be offered as the list to sweep from — picking sources blind
 * out of a full wallet list means guessing which ones minted.
 *
 * Two ways to find the token ids, because the fast one is not always there:
 *
 *   1. tokenOfOwnerByIndex, the ERC-721 Enumerable extension. One call per
 *      token owned, and it asks only about the wallets we care about.
 *
 *   2. Failing that, walk ownerOf over the id range. Measured on two live
 *      SeaDrop collections: supportsInterface(0x780e9d63) false, both index
 *      functions reverting, totalSupply answering, ownerOf(1) resolving and
 *      ownerOf(0) reverting — the ERC721A shape this bot mints most of the
 *      time. The walk costs one call per token in the collection rather than
 *      per token held, which on a 7,361-token drop is minutes, not seconds.
 *
 * Everything that can be asked at once is: balances go out together rather
 * than one wallet at a time, and enumerability is probed once for the
 * collection instead of once per wallet. On fourteen wallets that alone was
 * twenty-eight sequential round trips before the real work started.
 */
export async function scanHoldings(
  rpcUrls: string | string[],
  contract: string,
  owners: string[],
  opts: ScanOptions = {}
): Promise<ScanResult> {
  const urls = readableRpcs(Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls]);
  const contracts = await healthyContracts(urls, contract);
  const nft = contracts[0];

  const tokens: HeldToken[] = [];
  const skipped: SkippedWallet[] = [];

  // Balances first, all at once: they say who is worth asking about, and
  // later they say whether the walk found everything it should have.
  const balances = await Promise.all(
    owners.map(
      async (owner): Promise<{ owner: string; balance: bigint | null; error: string | null }> => {
        try {
          return { owner, balance: (await nft.balanceOf(owner)) as bigint, error: null };
        } catch (err: any) {
          return { owner, balance: null, error: err?.shortMessage ?? err?.message ?? String(err) };
        }
      }
    )
  );

  const expected = new Map<string, bigint>();
  for (const b of balances) {
    if (b.balance === null) skipped.push({ address: b.owner, reason: `could not read balance — ${b.error}` });
    else if (b.balance === 0n) skipped.push({ address: b.owner, reason: "holds none" });
    else expected.set(b.owner, b.balance);
  }
  if (expected.size === 0) return { contract, tokens, skipped };

  // Enumerability is a property of the contract, not of a wallet, so it is
  // asked once. Probing per wallet meant a non-enumerable collection paid one
  // failed call for every wallet before falling back.
  const probe = [...expected.keys()][0];
  let enumerable = true;
  try {
    await nft.tokenOfOwnerByIndex(probe, 0);
  } catch {
    enumerable = false;
  }

  if (enumerable) {
    for (const [owner, balance] of expected) {
      const found: bigint[] = [];
      let ok = true;
      for (let i = 0n; i < balance; i++) {
        try {
          found.push(await nft.tokenOfOwnerByIndex(owner, i));
        } catch {
          ok = false;
          break;
        }
      }
      // Partial enumeration is worse than none: it would move some tokens and
      // leave the rest behind without saying so.
      if (ok) for (const tokenId of found) tokens.push({ owner, tokenId });
      else
        skipped.push({
          address: owner,
          reason: `holds ${balance}, but enumeration stopped short — move these by token id`,
        });
    }
    return { contract, tokens, skipped };
  }

  const walked = await walkOwners(contracts, expected, opts);
  return { contract, tokens: [...tokens, ...walked.tokens], skipped: [...skipped, ...walked.skipped] };
}

// How many ownerOf calls are in flight against ONE endpoint at a time.
//
// ethers batches concurrent calls into a single JSON-RPC request, so this is
// really the batch size, and the endpoint has a strong opinion about it.
// Benchmarked over 240 ownerOf calls against the public Robinhood RPC:
//
//   concurrency  25   4.2s   241/241 found
//   concurrency  60   130s   181/241 found
//   concurrency 100   105s    41/241 found
//
// Past ~25 it starts dropping requests inside the batch, and a dropped
// ownerOf is indistinguishable from a burned token id — so raising this does
// not merely slow the walk down, it silently loses tokens. Extra throughput
// comes from using more endpoints, not from a bigger batch.
const WALK_CONCURRENCY = 25;

// Ids checked beyond totalSupply before giving up. Burns leave gaps, so the
// highest live id can sit above the supply — but not arbitrarily far, and an
// unbounded walk on a hostile contract would never end.
const WALK_SLACK = 2_000;

/**
 * Find token ids by asking who owns each one, for collections that cannot be
 * enumerated.
 *
 * Walks upward from id 0 and stops as soon as every wallet's balance is
 * accounted for, so the usual case ends early rather than reading the whole
 * collection. Reverts are expected and ignored: id 0 does not exist on an
 * ERC721A that starts at 1, and burned ids revert everywhere.
 *
 * Batches are dealt out across every readable endpoint at once. One endpoint
 * caps out at 25 concurrent calls, so two endpoints halve a 7,361-token walk
 * rather than each being asked to swallow more than it can serve. A call that
 * fails on one endpoint is retried on another before it counts as a gap —
 * without that, a rate-limited endpoint would quietly turn owned tokens into
 * missing ones.
 */
async function walkOwners(
  contracts: Contract[],
  expected: Map<string, bigint>,
  opts: ScanOptions = {}
): Promise<{ tokens: HeldToken[]; skipped: SkippedWallet[] }> {
  const skipped: SkippedWallet[] = [];

  let supply: bigint;
  try {
    supply = await contracts[0].totalSupply();
  } catch (err: any) {
    // No enumeration and no supply: there is no way to discover ids from the
    // chain alone. Say exactly that rather than reporting zero holdings.
    const detail = err?.shortMessage ?? err?.message ?? String(err);
    for (const [owner, balance] of expected) {
      skipped.push({
        address: owner,
        reason: `holds ${balance}, but the collection has neither enumeration nor totalSupply (${detail}) — move these by token id`,
      });
    }
    return { tokens: [], skipped };
  }

  // Index by lowercase address once, so the hot loop is a map lookup rather
  // than a case-insensitive scan of the wallet list per token.
  const wanted = new Map([...expected.keys()].map((o) => [o.toLowerCase(), o]));
  const foundFor = new Map<string, bigint[]>([...expected.keys()].map((o) => [o, []]));
  const outstanding = new Map(expected);

  const lastId = supply + BigInt(WALK_SLACK);
  const total = Number(supply);
  const stride = BigInt(WALK_CONCURRENCY * contracts.length);

  const ownerOf = async (tokenId: bigint, preferred: number): Promise<string | null> => {
    for (let attempt = 0; attempt < contracts.length; attempt++) {
      const nft = contracts[(preferred + attempt) % contracts.length];
      try {
        return (await nft.ownerOf(tokenId)) as string;
      } catch (err: any) {
        // A revert is the contract's answer: this id does not exist. Only a
        // transport failure is worth asking a different endpoint about.
        const message = String(err?.shortMessage ?? err?.message ?? err);
        if (/revert|nonexistent|invalid token/i.test(message)) return null;
      }
    }
    return null;
  };

  for (let start = 0n; start <= lastId; start += stride) {
    const calls: Promise<{ tokenId: bigint; owner: string | null }>[] = [];
    for (let i = 0n; i < stride && start + i <= lastId; i++) {
      const tokenId = start + i;
      // Deal consecutive ids round-robin, so every endpoint carries an equal
      // share of each batch instead of one being saturated first.
      const endpoint = Number(i % BigInt(contracts.length));
      calls.push(ownerOf(tokenId, endpoint).then((owner) => ({ tokenId, owner })));
    }

    for (const { tokenId, owner: holder } of await Promise.all(calls)) {
      if (!holder) continue;
      const owner = wanted.get(holder.toLowerCase());
      if (!owner) continue;
      foundFor.get(owner)!.push(tokenId);
      const left = (outstanding.get(owner) ?? 0n) - 1n;
      if (left <= 0n) outstanding.delete(owner);
      else outstanding.set(owner, left);
    }

    opts.onProgress?.(Math.min(Number(start + stride), total), total);

    // Everything accounted for — no reason to read the rest of the collection.
    if (outstanding.size === 0) break;
  }

  const reconciled = reconcileWalk(expected, foundFor);
  return { tokens: reconciled.tokens, skipped: [...skipped, ...reconciled.skipped] };
}

/**
 * Compare what the walk found against what balanceOf promised.
 *
 * The walk cannot tell a burned id from a dropped RPC call — both just fail —
 * so a short result is possible and must never pass silently. Moving four of
 * a wallet's six tokens while reporting success is the worst outcome here:
 * it looks finished, and the two left behind are only discovered later.
 */
export function reconcileWalk(
  expected: Map<string, bigint>,
  found: Map<string, bigint[]>
): { tokens: HeldToken[]; skipped: SkippedWallet[] } {
  const tokens: HeldToken[] = [];
  const skipped: SkippedWallet[] = [];

  for (const [owner, balance] of expected) {
    const ids = found.get(owner) ?? [];
    if (ids.length === 0) {
      skipped.push({
        address: owner,
        reason: `holds ${balance}, but none of its token ids could be found — move these by token id`,
      });
      continue;
    }
    for (const tokenId of ids) tokens.push({ owner, tokenId });
    if (BigInt(ids.length) < balance) {
      skipped.push({
        address: owner,
        reason: `holds ${balance} but only ${ids.length} could be located — the rest need moving by token id`,
      });
    }
  }

  return { tokens, skipped };
}

/**
 * Narrow a scan to the wallets that were chosen, aimed at a destination.
 *
 * Pure, so the preview the user confirms and the moves that actually run are
 * built by the same code from the same scan — the chain is not re-read
 * between showing the plan and acting on it.
 */
export function buildPlan(scan: ScanResult, selected: string[], destination: string): ConsolidationPlan {
  const wanted = new Set(selected.map((a) => a.toLowerCase()));
  const dest = destination.toLowerCase();
  return {
    contract: scan.contract,
    destination,
    // The destination keeps what it already holds even if it was selected:
    // a self-transfer would burn gas to change nothing.
    tokens: scan.tokens.filter((t) => wanted.has(t.owner.toLowerCase()) && t.owner.toLowerCase() !== dest),
    skipped: scan.skipped,
  };
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
