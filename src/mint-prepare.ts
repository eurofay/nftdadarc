// Separating PREPARING a gated mint from FIRING it.
//
// The whole problem in one sequence. The old signed path did this:
//
//   stage opens -> log in -> ask for calldata -> sign -> send
//
// Two API round trips and a signature after the only moment that matters.
// Every other path in this repo is pre-signed before the wait; this was the
// one that was not. What this file does instead:
//
//   ARM     resolve -> eligibility -> mint transaction -> VALIDATE -> hold
//   OPEN    sign -> submit
//
// and nothing between OPEN and submit that could have happened earlier.
//
// WHAT MAY SAFELY BE HELD, which is the question the split rests on. SeaDrop's
// signed digest covers (nftContract, minter, feeRecipient, mintParams, salt)
// and carries no issue time and no expiry -- the only clock in it is the
// stage's own startTime/endTime, inside mintParams. So an authorisation
// obtained an hour early is exactly as valid at the open as one obtained a
// second before. What CAN void it is the stage being reconfigured or the
// signer being removed, both readable on-chain, both checked by
// armed-calldata.validateArmed.
//
// Held calldata is still refreshed in the pre-roll (see local-mint.ts) because
// that window already exists for the round-trip measurement, so the refresh
// costs nothing that was not already being spent -- and because whether
// OpenSea will issue a transaction for a stage that has not opened yet is
// genuinely unknown. This design works whichever way that falls.
//
// NO WALLET EVER USES ANOTHER'S AUTHORISATION. The minter is named in the
// request, the signature is issued to it, and the same wallet signs and
// submits. Reusing one wallet's calldata for another is not a shortcut; it is
// a different transaction the contract rejects.

import { Wallet } from "ethers";
import { DropsError, DropMintTransaction, buildDropMintTransaction, checkDropEligibility } from "./opensea-drops";
import { validateArmed, decodeMint, DecodedMint } from "./armed-calldata";

/** Where a wallet has got to. Visible before the stage opens, which is the point. */
export type WalletState =
  | "PENDING"
  | "PREPARING"
  | "READY"
  | "INELIGIBLE"
  | "FAILED"
  | "SUBMITTING"
  | "SUBMITTED"
  | "CONFIRMED"
  | "REVERTED";

export type FailureCode =
  | "NOT_ELIGIBLE"
  | "STAGE_NOT_ACTIVE"
  | "DROP_NOT_STARTED"
  | "DROP_ENDED"
  | "SUPPLY_EXHAUSTED"
  | "WALLET_LIMIT_EXCEEDED"
  | "INVALID_TRANSACTION"
  | "INVALID_AUTHORIZATION"
  | "INSUFFICIENT_BALANCE"
  | "RPC_ERROR"
  | "API_ERROR"
  | "SIGNING_ERROR"
  | "NONCE_ERROR"
  | "UNKNOWN_REVERT";

/**
 * Which failures are worth trying again.
 *
 * Retrying "not eligible" cannot succeed however many times it runs, and
 * spends a rate-limit budget the retryable failures need. The split is by
 * cause, not by status code.
 */
export const RETRYABLE: ReadonlySet<FailureCode> = new Set<FailureCode>([
  "RPC_ERROR",
  "API_ERROR",
  "NONCE_ERROR",
]);

export interface Timings {
  /** Preparation started. */
  t0?: number;
  /** Mint transaction data received. */
  t1?: number;
  /** Transaction validated. */
  t2?: number;
  /** Opening condition detected. */
  t3?: number;
  /** Signing started. */
  t4?: number;
  /** RPC submission started. */
  t5?: number;
  /** Transaction hash returned. */
  t6?: number;
}

export interface PreparedMint {
  address: string;
  state: WalletState;
  quantity: number;
  /** Held transaction, once one has been obtained and validated. */
  tx?: DropMintTransaction;
  /** What the calldata actually says, read rather than assumed. */
  decoded?: DecodedMint;
  /** This wallet's own nonce, read at preparation. Never shared. */
  nonce?: number;
  /** Pre-signed bytes, when signing happened ahead of the open. */
  raw?: string;
  txHash?: string;
  failure?: { code: FailureCode; detail: string };
  timings: Timings;
}

export const newPrepared = (address: string, quantity: number): PreparedMint => ({
  address,
  state: "PENDING",
  quantity,
  timings: {},
});

/** Map a Drops API failure onto the local vocabulary, keeping the cause. */
export function fromDropsError(err: unknown): { code: FailureCode; detail: string } {
  if (err instanceof DropsError) {
    const map: Record<string, FailureCode> = {
      INVALID_KEY: "API_ERROR",
      NOT_ELIGIBLE: "NOT_ELIGIBLE",
      STAGE_NOT_ACTIVE: "STAGE_NOT_ACTIVE",
      DROP_NOT_STARTED: "DROP_NOT_STARTED",
      DROP_ENDED: "DROP_ENDED",
      SUPPLY_EXHAUSTED: "SUPPLY_EXHAUSTED",
      WALLET_LIMIT_EXCEEDED: "WALLET_LIMIT_EXCEEDED",
      RATE_LIMITED: "API_ERROR",
      API_ERROR: "API_ERROR",
    };
    return { code: map[err.code] ?? "API_ERROR", detail: err.message };
  }
  const msg = (err as any)?.message ?? String(err);
  if (/insufficient funds|insufficient balance/i.test(msg)) {
    return { code: "INSUFFICIENT_BALANCE", detail: msg };
  }
  if (/nonce/i.test(msg)) return { code: "NONCE_ERROR", detail: msg };
  return { code: "RPC_ERROR", detail: msg };
}

export interface PrepareOpts {
  slug: string;
  quantity: number;
  chainId: number;
  rpcUrl: string;
  expectedContract: string;
  apiKey?: string;
  /** Reads a wallet's current nonce. Injected so preparation stays testable. */
  nonceFor: (address: string) => Promise<number>;
  /** Signs ahead of the open. Omit to hold unsigned and sign at fire time. */
  signerFor?: (address: string) => Promise<Wallet> | Wallet;
  /** Gas terms, needed only when pre-signing. */
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gasLimit: number };
  /** Skip eligibility; the mint call is authoritative and this is for reasons. */
  skipEligibility?: boolean;
  onEvent?: (e: PrepareEvent) => void;
}

export interface PrepareEvent {
  at: number;
  address: string;
  state: WalletState;
  detail?: string;
}

const now = () => Date.now();

/**
 * Everything for one wallet that can legitimately happen before the open.
 *
 * Ends with the wallet either READY -- holding a validated, usually pre-signed
 * transaction -- or carrying a reason it is not. Never throws: one wallet's
 * refusal must not stop the others being prepared.
 */
export async function prepareOpenSeaMint(address: string, opts: PrepareOpts): Promise<PreparedMint> {
  const p = newPrepared(address, opts.quantity);
  const emit = (state: WalletState, detail?: string) => {
    p.state = state;
    opts.onEvent?.({ at: now(), address, state, detail });
  };

  p.timings.t0 = now();
  emit("PREPARING");

  try {
    if (!opts.skipEligibility) {
      const elig = await checkDropEligibility(opts.slug, address, opts.quantity, { apiKey: opts.apiKey });
      if (!elig.eligible) {
        p.failure = { code: "NOT_ELIGIBLE", detail: elig.reason ?? "OpenSea says this wallet is not eligible" };
        emit("INELIGIBLE", p.failure.detail);
        return p;
      }
      // Honour a smaller allowance rather than asking for more and being
      // refused at the only moment that counts.
      if (elig.quantity && elig.quantity < p.quantity) p.quantity = elig.quantity;
    }

    const tx = await buildDropMintTransaction(opts.slug, address, p.quantity, { apiKey: opts.apiKey });
    p.timings.t1 = now();

    // Never sign what has not been read. Everything below is a check on data
    // that came from someone else's API.
    const check = await validateArmed(
      { to: tx.to, data: tx.data },
      { rpcUrl: opts.rpcUrl, expectedContract: opts.expectedContract }
    );
    if (!check.ok) {
      p.failure = { code: "INVALID_TRANSACTION", detail: check.detail };
      emit("FAILED", check.detail);
      return p;
    }
    p.tx = tx;
    p.decoded = check.decoded;
    p.timings.t2 = now();

    // Each wallet's own nonce, read for that wallet. A shared counter would
    // put two transactions on one number and lose one of them.
    p.nonce = await opts.nonceFor(address);

    if (opts.signerFor && opts.fees) {
      const wallet = await opts.signerFor(address);
      if (wallet.address.toLowerCase() !== address.toLowerCase()) {
        // The authorisation names the minter. A different signer produces a
        // transaction the contract rejects.
        p.failure = { code: "INVALID_AUTHORIZATION", detail: "signer does not match the minter" };
        emit("FAILED", p.failure.detail);
        return p;
      }
      p.raw = await wallet.signTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value,
        nonce: p.nonce,
        maxFeePerGas: opts.fees.maxFeePerGas,
        maxPriorityFeePerGas: opts.fees.maxPriorityFeePerGas,
        gasLimit: opts.fees.gasLimit,
        type: 2,
        chainId: opts.chainId,
      });
    }

    emit("READY");
    return p;
  } catch (err) {
    p.failure = fromDropsError(err);
    emit(RETRYABLE.has(p.failure.code) ? "FAILED" : "INELIGIBLE", p.failure.detail);
    return p;
  }
}

export interface FireOpts {
  /** Writes raw bytes and returns a hash. The only network call at fire time. */
  submit: (raw: string) => Promise<string>;
  /** Signs now, for wallets held unsigned. */
  signerFor?: (address: string) => Promise<Wallet> | Wallet;
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gasLimit: number };
  chainId?: number;
  onEvent?: (e: PrepareEvent) => void;
}

/**
 * Send one prepared mint. Deliberately small.
 *
 * When preparation pre-signed, this is one network write and nothing else.
 * It does not re-resolve, re-authenticate, or re-request calldata -- that is
 * the entire point of the split.
 */
export async function firePreparedMint(p: PreparedMint, opts: FireOpts): Promise<PreparedMint> {
  const emit = (state: WalletState, detail?: string) => {
    p.state = state;
    opts.onEvent?.({ at: now(), address: p.address, state, detail });
  };

  if (p.state !== "READY") {
    return p;
  }

  try {
    let raw = p.raw;
    if (!raw) {
      if (!opts.signerFor || !opts.fees || opts.chainId === undefined || !p.tx || p.nonce === undefined) {
        p.failure = { code: "SIGNING_ERROR", detail: "nothing pre-signed and no signer supplied" };
        emit("FAILED", p.failure.detail);
        return p;
      }
      p.timings.t4 = now();
      const wallet = await opts.signerFor(p.address);
      raw = await wallet.signTransaction({
        to: p.tx.to,
        data: p.tx.data,
        value: p.tx.value,
        nonce: p.nonce,
        maxFeePerGas: opts.fees.maxFeePerGas,
        maxPriorityFeePerGas: opts.fees.maxPriorityFeePerGas,
        gasLimit: opts.fees.gasLimit,
        type: 2,
        chainId: opts.chainId,
      });
    } else {
      // Pre-signed: signing took no time here, and saying so honestly is
      // better than leaving the figure looking impossibly small.
      p.timings.t4 = now();
    }

    emit("SUBMITTING");
    p.timings.t5 = now();
    p.txHash = await opts.submit(raw);
    p.timings.t6 = now();
    emit("SUBMITTED", p.txHash);
    return p;
  } catch (err) {
    p.failure = fromDropsError(err);
    emit("FAILED", p.failure.detail);
    return p;
  }
}

/** Latencies worth naming, in ms. Absent where a phase did not happen. */
export interface LatencyReport {
  prepareLatency?: number;
  openingDetectionLatency?: number;
  signingLatency?: number;
  rpcSubmissionLatency?: number;
  totalFireLatency?: number;
}

/**
 * What the timings say.
 *
 * No claim of sub-millisecond anything: these are measured intervals, and the
 * only one worth optimising is totalFireLatency -- the gap between the stage
 * opening and the bytes leaving.
 */
export function latencies(t: Timings): LatencyReport {
  const d = (a?: number, b?: number) => (a !== undefined && b !== undefined ? b - a : undefined);
  return {
    prepareLatency: d(t.t0, t.t2),
    openingDetectionLatency: d(t.t2, t.t3),
    signingLatency: d(t.t4, t.t5),
    rpcSubmissionLatency: d(t.t5, t.t6),
    totalFireLatency: d(t.t3, t.t6),
  };
}

export interface ControllerOpts extends PrepareOpts {
  /**
   * Wallets prepared at once.
   *
   * Bounded rather than Promise.all over the whole list: each wallet is an
   * independent API call, and firing forty at once earns a 429 that costs
   * more than the serialisation saved.
   */
  concurrency?: number;
  /** Attempts for transient failures only. */
  retries?: number;
}

export const DEFAULT_PREPARE_CONCURRENCY = 4;
export const DEFAULT_RETRIES = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Prepares many independently eligible wallets, then fires them.
 *
 * Each wallet is its own minter, its own authorisation, its own nonce and its
 * own transaction. Nothing is combined, shared, or substituted -- there is no
 * such thing as one transaction from several EOAs, and pretending otherwise
 * would produce calldata that reverts.
 */
export class MultiWalletController {
  readonly wallets = new Map<string, PreparedMint>();

  constructor(private readonly opts: ControllerOpts) {}

  /** Prepare every wallet, a few at a time. Returns once all have settled. */
  async prepareAll(addresses: string[]): Promise<PreparedMint[]> {
    const limit = Math.max(1, this.opts.concurrency ?? DEFAULT_PREPARE_CONCURRENCY);
    const attempts = Math.max(1, this.opts.retries ?? DEFAULT_RETRIES);
    for (const a of addresses) this.wallets.set(a.toLowerCase(), newPrepared(a, this.opts.quantity));

    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= addresses.length) return;
        const address = addresses[i];

        let p = await prepareOpenSeaMint(address, this.opts);
        for (let attempt = 1; attempt < attempts; attempt++) {
          if (p.state === "READY" || !p.failure || !RETRYABLE.has(p.failure.code)) break;
          // Backoff only for causes that can change. A deterministic refusal
          // is not retried at all.
          await sleep(400 * attempt * attempt);
          p = await prepareOpenSeaMint(address, this.opts);
        }
        this.wallets.set(address.toLowerCase(), p);
      }
    };

    await Promise.all(Array.from({ length: Math.min(limit, addresses.length) }, worker));
    return addresses.map((a) => this.wallets.get(a.toLowerCase())!);
  }

  get ready(): PreparedMint[] {
    return [...this.wallets.values()].filter((p) => p.state === "READY");
  }

  /**
   * Fire every READY wallet.
   *
   * `openedAt` is stamped on each as t3 so the latency report measures from
   * the moment the stage opened rather than from when this happened to be
   * called.
   */
  async fireAll(fire: Omit<FireOpts, "onEvent">, openedAt = now()): Promise<PreparedMint[]> {
    const ready = this.ready;
    for (const p of ready) p.timings.t3 = openedAt;

    // Submission is one socket write per wallet with nothing shared between
    // them, so they go at once -- this is the moment the whole design exists
    // to keep short.
    return Promise.all(
      ready.map((p) => firePreparedMint(p, { ...fire, onEvent: this.opts.onEvent }))
    );
  }

  /** One line per wallet, for a report that says what is actually ready. */
  summary(): string[] {
    return [...this.wallets.values()].map((p) => {
      const head = `${p.address.slice(0, 10)}… ${p.state}`;
      if (p.failure) return `${head}: ${p.failure.code} — ${p.failure.detail}`;
      if (p.txHash) return `${head}: ${p.txHash}`;
      if (p.state === "READY") return `${head} (×${p.quantity}${p.raw ? ", pre-signed" : ""})`;
      return head;
    });
  }
}
