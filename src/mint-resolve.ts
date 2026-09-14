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
import { buildDropMintTransaction, DropsError } from "./opensea-drops";
import { readStages, Stage } from "./seadrop-stages";
import { probeContract, ContractProfile } from "./contract-probe";
import { KNOWN_MINTS, MintArgKind, MintSignature, selectorOf } from "./mint-signatures";
import { MintSpec, WalletAuthorization, buildMintCalldata, MintSpecError, specFromSignature } from "./mint-spec";
import { parseGenericAllowList, solveAllowList } from "./generic-merkle";
import { AuthSource, AuthorizationError, fetchApiAuthorization, describeSource } from "./mint-authorization";

export type MintSource = "public" | "allowlist" | "opensea" | "generic";

/**
 * Everything a mint on a project's OWN contract needs that the chain cannot
 * supply.
 *
 * SeaDrop puts a pointer to its allow list on-chain (AllowListUpdated), so
 * allowlist-fetch.ts can follow it from nothing but an address. A project's
 * own contract holds the ROOT and nothing else -- there is no standard event,
 * no standard URI field, and no way to discover where the list was published.
 * Same for a signed stage: the contract names the signer, never the endpoint
 * that issues signatures.
 *
 * So those two things are supplied by the operator, and asking for them is not
 * a gap in the implementation -- it is the honest shape of the problem. What
 * IS automatic: detecting the mint function, reading price, supply, per-wallet
 * caps and opening time from the contract, deriving each wallet's proof from
 * the list once its location is known, and simulating everything before a
 * single byte is signed.
 */
export interface GenericMintConfig {
  /**
   * The exact function to call, overriding detection.
   *
   * Needed when the contract's mint is not one of the shapes in
   * mint-signatures.ts. Must come with `args` -- a signature alone says what
   * the types are, never what they MEAN, and filling a uint256 that turns out
   * to be a phase index with a quantity is a revert.
   */
  signature?: string;
  /** What each argument of `signature` is for, in order. */
  args?: MintArgKind[];
  /** Where the project published its allow list. http(s), ipfs, or data. */
  listUri?: string;
  /** The list itself, when it was pasted rather than hosted. */
  listJson?: string;
  /** The project's own authorisation endpoint, for a signed stage. */
  authApi?: Extract<AuthSource, { kind: "api" }>;
  /** Values for arguments nothing can derive -- an instance id, a phase. */
  operatorArgs?: readonly unknown[];
  /** Price per token, where the contract exposes none. */
  priceWei?: bigint;
  /** Flat value for the whole call, where it is not price x quantity. */
  valueOverrideWei?: bigint;
  /** On by default. */
  simulate?: boolean;
}

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
  /**
   * OpenSea's collection slug, when it is already known.
   *
   * Lets the eligibility read share the login the calldata request needs, so
   * "not eligible" arrives as a sentence instead of an empty refusal.
   */
  slug?: string;
  /**
   * "auto" picks the stage these wallets can actually mint, gated first.
   * "public" forces the public stage even when a gated one would work.
   */
  prefer?: "auto" | "public";
  /** For the documented Drops API. Without a working one it falls back. */
  apiKey?: string;
  /**
   * For a contract that is not SeaDrop's and not on OpenSea.
   *
   * Purely additive: the SeaDrop and OpenSea routes are tried first and behave
   * exactly as before. This is what happens when all of them find nothing,
   * which until now was where the bot simply gave up.
   */
  generic?: GenericMintConfig;
  /**
   * The spec the generic route settled on, handed back to the caller.
   *
   * An out-parameter rather than a field on ResolvedMint because ResolvedMint
   * is persisted to the Telegram store, and a bigint inside it would not
   * survive that JSON round trip.
   */
  onGenericSpec?: (spec: MintSpec, profile: ContractProfile) => void;
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
 * How many wallets to authorise at once.
 *
 * Each wallet is an independent SIWE login and an independent calldata
 * request, so running them one after another made wallet nine wait for the
 * eight before it -- on a nine-wallet list that is nine round trips of
 * nothing happening. Four at a time because OpenSea rate-limits, and being
 * throttled into retries is slower than the serial version it replaced.
 */
export const OPENSEA_CONCURRENCY = 4;

/**
 * Ask OpenSea for the exact transaction each wallet should send.
 *
 * TWO TRANSPORTS, DOCUMENTED FIRST. The published Drops API
 * (POST /api/v2/drops/{slug}/mint) is the supported route and the one to
 * prefer: OpenSea selects the stage, so allow-list proofs and signed
 * authorisations both resolve server-side and arrive inside the calldata.
 * opensea-mint.ts talks to gql.opensea.io behind a SIWE login instead --
 * OpenSea's own web app's internal endpoints, which carry no compatibility
 * promise and can change without notice.
 *
 * The documented route needs a working API key, and a key that is rejected
 * takes every wallet with it, so the fallback stays rather than failing the
 * whole resolve shut. Which one ran is reported, because "it worked" over the
 * internal endpoints is a different fact from "it worked" over the documented
 * one and only the second is something to rely on.
 *
 * ONE SESSION PER WALLET, REUSED, on the fallback path. Sign-in and the
 * calldata request used to be separate acts with a separate login each: the
 * eligibility check logged in, read the answer, threw the session away, and
 * then firing logged in again. That is two round trips where one does, and
 * the second landed at the worst possible moment.
 *
 * NO WALLET USES ANOTHER'S AUTHORISATION. The minter is named in the request
 * and the signature is issued to it; the same wallet signs and submits.
 */
async function tryOpenSea(opts: ResolveOpts): Promise<ResolvedMint | null> {
  if (!opts.signerFor) return null;

  const results: { plan?: WalletPlan; skip?: SkippedWallet }[] = new Array(opts.wallets.length);
  const usedDocumented: boolean[] = new Array(opts.wallets.length).fill(false);
  let next = 0;
  // Probed once. Re-learning it per wallet would be one wasted round trip per
  // wallet for an answer that cannot differ between them.
  let documentedWorks: boolean | null = opts.slug ? null : false;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= opts.wallets.length) return;
      const address = opts.wallets[i];

      // 1. The documented route, when there is a slug and the key works.
      if (opts.slug && documentedWorks !== false) {
        try {
          const tx = await buildDropMintTransaction(opts.slug, address, opts.quantity, {
            apiKey: opts.apiKey,
          });
          documentedWorks = true;
          usedDocumented[i] = true;
          results[i] = { plan: { address, plan: asPlan(tx.to, tx.data, tx.value, opts.quantity) } };
          continue;
        } catch (err: any) {
          if (err instanceof DropsError && err.code === "INVALID_KEY") {
            // Nothing wallet-specific about a rejected key, so stop asking.
            documentedWorks = false;
          } else if (err instanceof DropsError && !err.retryable) {
            // A real answer about this wallet: not eligible, sold out, ended.
            results[i] = { skip: { address, reason: `${err.message} (${err.code})` } };
            continue;
          }
        }
      }

      // 2. The internal route, one login, reused for eligibility and calldata.
      try {
        const wallet = await opts.signerFor!(address);
        const client = (opts.makeClient ?? (() => new OpenSeaMintClient()))();
        await client.login(wallet, opts.chainId);

        if (opts.slug) {
          try {
            const stages = await client.eligibility(opts.slug, wallet.address);
            const usable = stages.find((st) => st.isEligible);
            if (stages.length > 0 && !usable) {
              results[i] = {
                skip: { address, reason: "OpenSea says this wallet is not eligible for any stage" },
              };
              continue;
            }
          } catch {
            // A failed eligibility read is not a refusal to mint; let the
            // calldata request give the real answer.
          }
        }

        const calldata = await client.mintCalldata({
          address: wallet.address,
          contractAddress: opts.contract,
          chainIdentifier: opts.chainKey,
          tokenId: "0",
          quantity: opts.quantity,
        });
        results[i] = {
          plan: { address, plan: asPlan(calldata.to, calldata.data, calldata.value, opts.quantity) },
        };
      } catch (err: any) {
        const kind = err instanceof OpenSeaMintError ? err.kind : "error";
        results[i] = { skip: { address, reason: `${err?.message ?? err} (${kind})` } };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(OPENSEA_CONCURRENCY, opts.wallets.length) }, worker)
  );

  // Rebuilt in wallet order, not completion order, so the same list always
  // produces the same plan ordering.
  const plans: WalletPlan[] = [];
  const skipped: SkippedWallet[] = [];
  for (const r of results) {
    if (r?.plan) plans.push(r.plan);
    else if (r?.skip) skipped.push(r.skip);
  }

  if (plans.length === 0 && skipped.length === 0) return null;

  const viaDocumented = usedDocumented.filter(Boolean).length;
  const notes = [`OpenSea issued calldata for ${plans.length} of ${opts.wallets.length} wallet(s).`];
  if (plans.length > 0) {
    notes.push(
      viaDocumented === plans.length
        ? "Via the documented Drops API."
        : viaDocumented > 0
          ? `${viaDocumented} via the documented Drops API, the rest via the internal endpoints.`
          : documentedWorks === false
            ? "Via OpenSea's internal endpoints — the documented Drops API needs a working OPENSEA_API_KEY."
            : "Via OpenSea's internal endpoints."
    );
  }

  return {
    source: "opensea",
    contract: opts.contract,
    startTimeMs: null,
    quantity: opts.quantity,
    plans,
    skipped,
    notes,
  };
}

/**
 * Mint a contract that is not SeaDrop's, using its own mint function.
 *
 * Runs LAST, and only when every SeaDrop and OpenSea route has come back with
 * nothing -- so no existing behaviour changes. This is purely the case that
 * used to end in "no public drop found on this contract".
 *
 * THE SHAPE OF WHAT IT CAN DO ALONE. A public mint is fully automatic: the
 * function is detected from the bytecode, the price and caps are read from the
 * contract's own getters, the calldata is built and simulated per wallet, and
 * nothing needs supplying. A GATED mint is automatic once the operator has
 * said WHERE the list or the authorisation endpoint is, because the chain does
 * not record that and nothing can discover it. Where that is missing, this
 * returns an explanation naming exactly what is needed rather than a mint that
 * would revert.
 */
async function tryGeneric(opts: ResolveOpts): Promise<ResolvedMint | null> {
  const cfg = opts.generic ?? {};

  // Probe once, on the first endpoint that answers. Every later read reuses
  // this endpoint so the simulation and the state it was judged against come
  // from the same node.
  const probed = await firstAnswer(opts.rpcUrls, async (url) => {
    const profile = await probeContract(url, opts.contract);
    return profile.isContract ? { profile, url } : null;
  });
  if (!probed) return null;
  const { profile, url: rpcUrl } = probed;

  const chosen = chooseMintSignature(profile, cfg);
  if (!chosen) {
    return explain(opts, profile, [
      profile.mints.length === 0
        ? "This contract's mint function isn't one this bot recognises, and nothing can infer it " +
          "from the address. Supply the signature and what each argument means."
        : "The mint function found needs an argument only the project knows, so it can't be " +
          "called automatically.",
      ...profile.notes,
    ]);
  }

  // Terms from the contract itself, never from a drop page. A countdown on a
  // website and a startTime in storage can disagree, and only one of them
  // rejects transactions.
  const priceWei = cfg.priceWei ?? profile.state.priceWei ?? 0n;
  const perWallet = Math.max(
    1,
    Math.min(
      opts.quantity,
      profile.state.maxPerTransaction || opts.quantity,
      profile.state.maxPerWallet || opts.quantity
    )
  );

  const spec = specFromSignature(chosen, {
    chainId: opts.chainId,
    contract: opts.contract,
    quantity: perWallet,
    priceWei,
    operatorArgs: cfg.operatorArgs,
    valueOverrideWei: cfg.valueOverrideWei,
  });

  // ── Authorisation, per wallet, from whatever legitimate source applies ──
  let authorize: (address: string) => Promise<WalletAuthorization | null>;
  const notes: string[] = [];

  if (chosen.kind === "merkle") {
    const root = profile.state.merkleRoot;
    const listJson = await loadList(cfg);
    if (!listJson) {
      return explain(opts, profile, [
        "This is a Merkle-gated stage: the contract holds the root" +
          (root ? ` (${root.slice(0, 10)}…)` : "") +
          ", and the proof is computed from the list the project published. " +
          "Point the bot at that list and every wallet's proof is derived and checked against " +
          "the on-chain root before anything is sent.",
      ]);
    }
    if (!root) {
      return explain(opts, profile, [
        "A list was supplied but this contract exposes no Merkle root to check it against, so a " +
          "proof built from it could not be verified before sending. Supply the mint signature " +
          "directly if the root lives somewhere non-standard.",
      ]);
    }

    const solved = solveAllowList(parseGenericAllowList(listJson), root);
    if (!solved) {
      return explain(opts, profile, [
        "That list does not reproduce this contract's on-chain Merkle root under any leaf " +
          "encoding this bot knows. Either it is a list for a different stage, it has been " +
          "replaced since publication, or the project hashed its leaves in an unusual way. " +
          "Nothing was sent -- a proof built from it would have reverted and still cost gas.",
      ]);
    }
    notes.push(
      `Allow list matched the on-chain root under ${solved.encoding.name} — ${solved.entries} entries.`
    );
    authorize = async (address) => {
      const proof = solved.proofs.get(address.toLowerCase());
      if (!proof) return null;
      return {
        address,
        proof,
        allowance: solved.allowances.get(address.toLowerCase()),
        source: "the project's published allow list",
      };
    };
  } else if (chosen.kind === "signed") {
    if (!cfg.authApi) {
      return explain(opts, profile, [
        "This stage is authorised by a signature" +
          (profile.state.signer ? ` from ${profile.state.signer}` : "") +
          ". Only the project's own server can issue one — it cannot be derived, and this bot " +
          "will not fabricate it. Point the bot at the endpoint the project's mint page calls " +
          "and each wallet's signature is requested for that wallet alone.",
      ]);
    }
    notes.push(`Authorisations requested from ${describeSource(cfg.authApi)}.`);
    authorize = async (address) =>
      fetchApiAuthorization(cfg.authApi!, address, {
        quantity: perWallet,
        chainId: opts.chainId,
      });
  } else {
    // Public or a shape that carries its own terms. thirdweb's claim() takes
    // an empty proof for an open phase, which buildMintCalldata handles.
    authorize = async (address) => ({ address });
  }

  // ── Build per wallet, and say plainly why a wallet was left out ─────────
  const plans: WalletPlan[] = [];
  const skipped: SkippedWallet[] = [];
  for (const address of opts.wallets) {
    try {
      const auth = await authorize(address);
      if (!auth) {
        skipped.push({ address, reason: "not on the project's allow list" });
        continue;
      }
      const built = buildMintCalldata(spec, auth);
      plans.push({
        address,
        plan: {
          to: built.to,
          data: built.data,
          value: built.value,
          feeRecipient: built.to,
          drop: {
            mintPrice: priceWei,
            startTime: profile.state.startTime ?? 0,
            endTime: profile.state.endTime ?? 0,
            maxTotalMintableByWallet: perWallet,
            feeBps: 0,
            restrictFeeRecipients: false,
          },
        },
      });
    } catch (err) {
      const reason =
        err instanceof AuthorizationError || err instanceof MintSpecError
          ? err.message
          : ((err as Error)?.message ?? String(err));
      skipped.push({ address, reason });
    }
  }

  opts.onGenericSpec?.(spec, profile);

  return {
    source: "generic",
    contract: opts.contract,
    startTimeMs: profile.state.startTime ? profile.state.startTime * 1000 : null,
    quantity: perWallet,
    plans,
    skipped,
    notes: [
      `Minting this project's own contract via ${chosen.signature}` +
        (chosen.family !== "common" ? ` (${chosen.family})` : "") +
        ".",
      ...notes,
      ...profile.notes,
    ],
  };
}

/**
 * Which function to call: the operator's if they said, otherwise the best
 * detected one.
 *
 * A supplied signature with no argument map is refused rather than guessed at.
 * Types are not meanings: `mint(uint256,uint256)` could be (quantity, tokenId)
 * or (tokenId, quantity), and the two produce completely different mints.
 */
function chooseMintSignature(
  profile: ContractProfile,
  cfg: GenericMintConfig
): MintSignature | null {
  if (cfg.signature) {
    const known = KNOWN_MINTS.find((m) => m.signature === cfg.signature);
    if (known && !cfg.args) return known;
    if (!cfg.args) return null;
    return {
      signature: cfg.signature,
      selector: selectorOf(cfg.signature),
      kind: cfg.args.includes("signature") ? "signed" : cfg.args.includes("proof") ? "merkle" : "public",
      args: cfg.args,
      autofillable: !cfg.args.includes("operator") || (cfg.operatorArgs?.length ?? 0) > 0,
      family: "supplied by the operator",
      payable: true,
    };
  }
  // Gated first, matching resolveMint's own ordering: a contract with both a
  // gated and a public entry point almost always has the gated stage as the
  // reason for being there.
  const fillable = profile.mints.filter(
    (m) => m.autofillable || (cfg.operatorArgs?.length ?? 0) > 0
  );
  return fillable[0] ?? null;
}

/** Read the allow list from wherever it was supplied. */
async function loadList(cfg: GenericMintConfig): Promise<string | null> {
  if (cfg.listJson) return cfg.listJson;
  if (!cfg.listUri) return null;
  try {
    return await fetchAllowList(cfg.listUri);
  } catch {
    return null;
  }
}

/**
 * A result that mints nothing but says exactly what is missing.
 *
 * Deliberately shaped like a normal result rather than a null: "I found the
 * stage and here is the one thing I need" is the most useful answer this can
 * give, and returning null would collapse it into "nothing found".
 */
function explain(opts: ResolveOpts, profile: ContractProfile, notes: string[]): ResolvedMint {
  return {
    source: "generic",
    contract: opts.contract,
    startTimeMs: profile.state.startTime ? profile.state.startTime * 1000 : null,
    quantity: opts.quantity,
    plans: [],
    skipped: opts.wallets.map((address) => ({
      address,
      reason: "the mint could not be built — see the notes above",
    })),
    notes,
  };
}

/** Both transports return a whole transaction, so both become a plan the same way. */
function asPlan(to: string, data: string, value: bigint, quantity: number): LocalMintPlan {
  return {
    to,
    data,
    value,
    // OpenSea handed over a whole transaction, so there is no drop struct to
    // read; the engine only needs somewhere to send bytes.
    feeRecipient: to,
    drop: {
      mintPrice: quantity > 0 ? value / BigInt(quantity) : 0n,
      startTime: 0,
      endTime: 0,
      maxTotalMintableByWallet: quantity,
      feeBps: 0,
      restrictFeeRecipients: false,
    },
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
  const stages = (await firstAnswer(opts.rpcUrls, async (url) => readStages(url, opts.contract))) ?? [];
  const gatedPresent = stages.some((st) => st.present && st.kind !== "public");

  // ORDER MATTERS, AND GETTING IT WRONG IS EXPENSIVE.
  //
  // A whitelist-gated collection almost always has a public stage configured
  // too -- it opens later, costs more, and is contested by everyone. Trying
  // public first because it is the cheapest to RESOLVE meant a wallet that
  // was on the allow list got handed the public stage anyway: it waited hours
  // longer, paid the public price, and raced the whole world for it. The
  // allow list was the entire reason for being there.
  //
  // So when the contract has any gated stage configured, the gated routes are
  // tried first, and public is what is left when none of them fit.
  //
  // tryGeneric is LAST in both orders, deliberately. It handles contracts that
  // are not SeaDrop's at all, and a SeaDrop collection must keep resolving
  // through the SeaDrop routes exactly as it did before -- this is an extra
  // answer for the case that used to have none, not a replacement for the ones
  // that already worked.
  const gatedFirst = gatedPresent && opts.prefer !== "public";
  const attempts = gatedFirst
    ? [tryAllowList, tryOpenSea, tryPublic, tryGeneric]
    : [tryPublic, tryAllowList, tryOpenSea, tryGeneric];

  // A source answering "this stage exists and none of your wallets qualify"
  // is worth keeping -- it is the explanation if nothing else works -- but it
  // must not stop the search. A wallet off the Merkle list may still hold a
  // signature for the signed stage.
  let explanation: ResolvedMint | null = null;
  for (const attempt of attempts) {
    const out = await attempt(opts);
    if (!out) continue;
    if (out.plans.length > 0) return annotate(out, stages, gatedPresent);
    explanation ??= out;
  }
  return explanation ? annotate(explanation, stages, gatedPresent) : null;
}

/**
 * Say what else the contract has, so a public result is never mistaken for
 * "this is the only stage there is".
 */
function annotate(resolved: ResolvedMint, stages: Stage[], gatedPresent: boolean): ResolvedMint {
  const notes = [...resolved.notes];
  if (resolved.source === "public" && gatedPresent) {
    const kinds = stages.filter((st) => st.present && st.kind !== "public").map((st) => st.kind);
    notes.push(
      `Note: this collection also has a ${kinds.join(" and ")} stage, and none of your wallets could use it — ` +
        "so this is the PUBLIC stage, at the public price and time."
    );
  }
  const publicStage = stages.find((st) => st.kind === "public" && st.present);
  if (resolved.source !== "public" && publicStage?.startTime) {
    notes.push(`A public stage also opens later, at ${new Date(publicStage.startTime * 1000).toISOString()}.`);
  }
  return { ...resolved, notes };
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
    generic: "Project's own contract",
  };
  const lines = [label[resolved.source], ...resolved.notes, ""];
  for (const p of resolved.plans) lines.push(`  ✅ ${mask(p.address)} — ready`);
  for (const s of resolved.skipped) lines.push(`  ⛔ ${mask(s.address)} — ${s.reason}`);
  return lines.join("\n");
}
