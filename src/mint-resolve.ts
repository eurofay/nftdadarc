// One entry point for "here is a contract address — work out how to mint it".
//
// A SeaDrop collection can gate a stage three different ways, and which one it
// uses is not visible from the address:
//
//   public     — terms are on-chain. Anyone may mint. Calldata is derivable,
//                identical for every wallet, and needs no network at all.
//   allow list — the contract holds a Merkle ROOT. Each wallet needs its own
//                PROOF, which is maths over a published list, not permission.
//   signed     — the contract holds a SIGNER ADDRESS. Each wallet needs a
//                SIGNATURE from a key only the project holds. Nothing can
//                derive this; it has to be asked for.
//
// Asking the operator which one applies is asking them to do the bot's job,
// and the answer is discoverable in every case. So this tries all three, in
// the order that costs least, and reports what it found per wallet.
//
// WHAT "PER WALLET" MEANS HERE, because it is the thing that was wrong before:
// a public mint sends identical bytes from every wallet, but an allow-list or
// signed mint does not. The leaf and the signature both name the minter. One
// wallet's calldata sent from another is not a near miss — it is a revert that
// still pays the gas. So this returns a plan PER ADDRESS, and a wallet with no
// plan is reported as skipped rather than handed someone else's.

import { Wallet } from "ethers";
import { LocalMintPlan, buildLocalMintPlan, resolveFeeRecipient } from "./seadrop-public";
import { fetchAllowListRoot, encodeMintAllowList, MintParams } from "./seadrop-allowlist";
import { findAllowListUri, fetchAllowList, parseAllowList, deriveProof, normalizeUri } from "./allowlist-fetch";
import { OpenSeaMintClient, OpenSeaMintError } from "./opensea-mint";

export type MintSource = "public" | "allowlist" | "opensea";

export interface WalletPlan {
  address: string;
  plan: LocalMintPlan;
}

export interface SkippedWallet {
  address: string;
  reason: string;
}

export interface ResolvedMint {
  source: MintSource;
  contract: string;
  /** Milliseconds since epoch, or null when the stage carries no opening time. */
  startTimeMs: number | null;
  quantity: number;
  plans: WalletPlan[];
  skipped: SkippedWallet[];
  /** Lines worth showing the operator — what was tried and what was found. */
  notes: string[];
}

export interface ResolveOpts {
  rpcUrls: string[];
  chainKey: string;
  chainId: number;
  contract: string;
  wallets: string[];
  quantity: number;
  /**
   * A signer for a wallet, used ONLY to sign OpenSea's SIWE login message.
   *
   * That message proves the address is ours and authorises no spend. It is a
   * callback so this module never reaches into the key store itself, and so a
   * caller that must not sign can simply not supply one.
   */
  signerFor?: (address: string) => Promise<Wallet> | Wallet;
  /** Injectable for tests; defaults to a real client per wallet. */
  makeClient?: () => OpenSeaMintClient;
  /** Fetch a published allow list. Injectable for tests. */
  fetchList?: (uri: string) => Promise<string>;
}

/** First endpoint that answers, rather than the first that is listed. */
async function firstAnswer<T>(urls: string[], fn: (url: string) => Promise<T | null>): Promise<T | null> {
  for (const url of urls) {
    try {
      const out = await fn(url);
      if (out !== null && out !== undefined) return out;
    } catch {
      /* try the next endpoint */
    }
  }
  return null;
}

/**
 * A public stage, if there is one.
 *
 * Cheapest by a wide margin — chain reads only, no list fetch, no API, and the
 * same calldata for every wallet. Tried first for that reason.
 */
async function tryPublic(opts: ResolveOpts): Promise<ResolvedMint | null> {
  const plan = await firstAnswer(opts.rpcUrls, (url) =>
    buildLocalMintPlan(url, opts.contract, opts.quantity)
  );
  if (!plan) return null;
  // A drop struct that exists but is switched off — every field zero — is not
  // a stage anyone can mint, and calling it one sends a doomed transaction.
  if (plan.drop.startTime === 0 && plan.drop.endTime === 0 && plan.drop.maxTotalMintableByWallet === 0) {
    return null;
  }
  return {
    source: "public",
    contract: opts.contract,
    startTimeMs: plan.drop.startTime > 0 ? plan.drop.startTime * 1000 : null,
    quantity: opts.quantity,
    plans: opts.wallets.map((address) => ({ address, plan })),
    skipped: [],
    notes: [`Public stage found on-chain — identical calldata for all ${opts.wallets.length} wallet(s).`],
  };
}

/**
 * A Merkle stage, with each wallet's proof derived from the published list.
 *
 * Needs no permission: SeaDrop puts a pointer to the list on-chain, and a
 * proof is a path of hashes over it. The tree built here must reproduce the
 * root the contract already holds — when it doesn't, the list has moved on or
 * the encoding is off, and saying so beats a proof that reverts at T-0.
 */
async function tryAllowList(opts: ResolveOpts): Promise<ResolvedMint | null> {
  const root = await firstAnswer(opts.rpcUrls, (url) => fetchAllowListRoot(url, opts.contract));
  if (!root) return null;

  const found = await firstAnswer(opts.rpcUrls, (url) => findAllowListUri(url, opts.contract));
  if (!found) return null;

  const get = opts.fetchList ?? fetchAllowList;
  let entries;
  try {
    entries = parseAllowList(await get(normalizeUri(found.uri)));
  } catch {
    return null;
  }

  const derived = opts.wallets.map((address) => ({ address, d: deriveProof(entries, address, root) }));
  const usable = derived.find((x) => x.d?.matchesChain);
  if (!usable) {
    // Nobody here is on the list. That is an answer, not a failure, and
    // falling through to OpenSea would only ask a slower version of it.
    return {
      source: "allowlist",
      contract: opts.contract,
      startTimeMs: null,
      quantity: opts.quantity,
      plans: [],
      skipped: derived.map(({ address, d }) => ({
        address,
        reason: d ? "the published list doesn't match the on-chain root" : "not on the allow list",
      })),
      notes: [`Allow list found (${entries.length} entries), but no wallet here is on it.`],
    };
  }

  const params: MintParams = usable.d!.params;
  const fee = await firstAnswer(opts.rpcUrls, (url) =>
    resolveFeeRecipient(url, opts.contract, params.restrictFeeRecipients)
  );
  if (!fee) return null;

  // The stage caps what a wallet may take; asking for more is a revert.
  const perWallet = Math.min(opts.quantity, Number(params.maxTotalMintableByWallet)) || 1;

  const plans: WalletPlan[] = [];
  const skipped: SkippedWallet[] = [];
  for (const { address, d } of derived) {
    if (!d) {
      skipped.push({ address, reason: "not on the allow list" });
      continue;
    }
    if (!d.matchesChain) {
      skipped.push({ address, reason: "the published list doesn't match the on-chain root" });
      continue;
    }
    const e = encodeMintAllowList(opts.contract, fee.address, perWallet, d.params, d.proof);
    plans.push({
      address,
      plan: {
        to: e.to,
        data: e.data,
        value: e.value,
        feeRecipient: fee.address,
        drop: {
          mintPrice: d.params.mintPrice,
          startTime: Number(d.params.startTime),
          endTime: Number(d.params.endTime),
          maxTotalMintableByWallet: Number(d.params.maxTotalMintableByWallet),
          feeBps: Number(d.params.feeBps),
          restrictFeeRecipients: d.params.restrictFeeRecipients,
        },
      },
    });
  }

  return {
    source: "allowlist",
    contract: opts.contract,
    startTimeMs: Number(params.startTime) > 0 ? Number(params.startTime) * 1000 : null,
    quantity: perWallet,
    plans,
    skipped,
    notes: [
      `Allow list found (${entries.length} entries) — ${plans.length} wallet(s) on it, each with its own proof.`,
    ],
  };
}

/**
 * Ask OpenSea for the exact transaction each wallet should send.
 *
 * The last resort, and the only route to a signed stage: the signature is
 * issued by the project's key to a wallet OpenSea has decided is eligible, and
 * arrives already inside the calldata. Nothing here derives or forges a
 * credential — it asks, as the owner, for something the owner is entitled to.
 *
 * One login per wallet, because the answer is per wallet.
 */
async function tryOpenSea(opts: ResolveOpts): Promise<ResolvedMint | null> {
  if (!opts.signerFor) return null;

  const plans: WalletPlan[] = [];
  const skipped: SkippedWallet[] = [];

  for (const address of opts.wallets) {
    try {
      const wallet = await opts.signerFor(address);
      const client = (opts.makeClient ?? (() => new OpenSeaMintClient()))();
      await client.login(wallet, opts.chainId);
      const calldata = await client.mintCalldata({
        address: wallet.address,
        contractAddress: opts.contract,
        chainIdentifier: opts.chainKey,
        tokenId: "0",
        quantity: opts.quantity,
      });
      plans.push({
        address,
        plan: {
          to: calldata.to,
          data: calldata.data,
          value: calldata.value,
          // OpenSea handed over a whole transaction, so there is no drop
          // struct to read; the engine only needs somewhere to send bytes.
          feeRecipient: calldata.to,
          drop: {
            mintPrice: opts.quantity > 0 ? calldata.value / BigInt(opts.quantity) : 0n,
            startTime: 0,
            endTime: 0,
            maxTotalMintableByWallet: opts.quantity,
            feeBps: 0,
            restrictFeeRecipients: false,
          },
        },
      });
    } catch (err: any) {
      const kind = err instanceof OpenSeaMintError ? err.kind : "error";
      skipped.push({ address, reason: `${err?.message ?? err} (${kind})` });
    }
  }

  if (plans.length === 0 && skipped.length === 0) return null;
  return {
    source: "opensea",
    contract: opts.contract,
    startTimeMs: null,
    quantity: opts.quantity,
    plans,
    skipped,
    notes: [`OpenSea issued calldata for ${plans.length} of ${opts.wallets.length} wallet(s).`],
  };
}

/**
 * Work out how to mint this contract, and with which wallets.
 *
 * Cheapest-first, and the first source that yields an answer wins. A source
 * that says "no wallet here qualifies" IS an answer: it stops the search
 * rather than falling through to a slower way of being told the same thing.
 */
export async function resolveMint(opts: ResolveOpts): Promise<ResolvedMint | null> {
  const attempts = [tryPublic, tryAllowList, tryOpenSea];
  for (const attempt of attempts) {
    const out = await attempt(opts);
    if (out) return out;
  }
  return null;
}

/** A lookup the fire path uses, so each wallet signs its own calldata. */
export function planLookup(resolved: ResolvedMint): (address: string) => LocalMintPlan | null {
  const byAddress = new Map(resolved.plans.map((p) => [p.address.toLowerCase(), p.plan]));
  return (address: string) => byAddress.get(address.toLowerCase()) ?? null;
}

/** What to show once it has worked out what this contract actually is. */
export function describeResolved(resolved: ResolvedMint, mask: (a: string) => string): string {
  const label: Record<MintSource, string> = {
    public: "Public stage",
    allowlist: "Allow-list stage",
    opensea: "Signed stage (via OpenSea)",
  };
  const lines = [label[resolved.source], ...resolved.notes, ""];
  for (const p of resolved.plans) lines.push(`  ✅ ${mask(p.address)} — ready`);
  for (const s of resolved.skipped) lines.push(`  ⛔ ${mask(s.address)} — ${s.reason}`);
  return lines.join("\n");
}
