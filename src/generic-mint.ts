// Preparing and firing a mint on a contract that is not SeaDrop and not
// OpenSea's.
//
// The same split as mint-prepare.ts, for the same reason: everything that can
// legitimately happen before the stage opens happens before the stage opens,
// and the only thing left at T-0 is writing bytes to a socket.
//
//   CONFIGURE   a MintSpec (mint-spec.ts), detected or supplied
//   READ        the contract's own stage state (contract-probe.ts)
//   RESOLVE     this wallet's authorisation (mint-authorization.ts)
//   BUILD       calldata for THIS wallet (mint-spec.ts)
//   SIMULATE    eth_call, from this wallet, with this value (mint-simulate.ts)
//   NONCE       this wallet's own, never a shared counter
//   SIGN        ahead of the open, where a signer is available
//   HOLD        READY
//      ...
//   OPEN        submit
//
// WHY SIMULATION DOES NOT BLOCK ARMING AN UNOPENED STAGE. Simulating a mint an
// hour before it opens reverts with "not started" -- which is the contract
// working correctly, not a fault in the transaction. Treating that as a
// preparation failure would make preparing ahead impossible, which is the
// entire point. So a timing revert leaves the wallet READY with the reason
// recorded; every other revert fails it, because every other revert means the
// transaction is wrong rather than early.
//
// WHAT THIS SHARES WITH THE SEADROP PATH. The state machine, the failure
// vocabulary, the retry policy, the timing telemetry and the firing function
// are all mint-prepare.ts's -- imported, not copied. A mint is a mint once the
// calldata exists; only the route to the calldata differs.

import { Wallet, formatEther } from "ethers";
import {
  FailureCode,
  FireOpts,
  PrepareEvent,
  PreparedMint,
  RETRYABLE,
  WalletState,
  latencies,
  newPrepared,
  prepareMany,
} from "./mint-prepare";
import { MintSpec, MintSpecError, WalletAuthorization, buildMintCalldata, describeSpec, supportsBatch } from "./mint-spec";
import { AuthorizationError } from "./mint-authorization";
import { isTimingFailure, simulateMint } from "./mint-simulate";

export interface GenericPrepareOpts {
  spec: MintSpec;
  rpcUrl: string;
  /**
   * This wallet's own authorisation, or null when the stage needs none.
   *
   * A callback so this module never reaches into a key store or an API client
   * itself, and so a public mint can simply not supply one.
   */
  authFor?: (address: string) => Promise<WalletAuthorization | null>;
  /** This wallet's nonce. Read per wallet -- see the note in mint-prepare.ts. */
  nonceFor: (address: string) => Promise<number>;
  /** Pre-signs before the open. Omit to hold unsigned. */
  signerFor?: (address: string) => Promise<Wallet> | Wallet;
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gasLimit: number };
  /** On by default. Off only for a caller that has already simulated. */
  simulate?: boolean;
  /** Ask the node to size the gas limit instead of using the fitted model. */
  estimateGas?: boolean;
  /** This wallet's balance, to catch an underfunded wallet before signing. */
  balanceFor?: (address: string) => Promise<bigint | null>;
  onEvent?: (e: PrepareEvent) => void;
  concurrency?: number;
  retries?: number;
}

const now = () => Date.now();

/** Map a preparation-time exception onto the shared failure vocabulary. */
export function classifyPrepareError(err: unknown): { code: FailureCode; detail: string } {
  if (err instanceof MintSpecError) {
    return { code: "INVALID_TRANSACTION", detail: err.message };
  }
  if (err instanceof AuthorizationError) {
    const map: Record<string, FailureCode> = {
      NOT_ELIGIBLE: "NOT_ELIGIBLE",
      UNAUTHORIZED: "API_ERROR",
      RATE_LIMITED: "API_ERROR",
      NOT_OPEN: "DROP_NOT_STARTED",
      BAD_RESPONSE: "API_ERROR",
      NETWORK: "API_ERROR",
    };
    return { code: map[err.code] ?? "API_ERROR", detail: err.message };
  }
  const msg = (err as Error)?.message ?? String(err);
  if (/insufficient funds|insufficient balance/i.test(msg)) {
    return { code: "INSUFFICIENT_BALANCE", detail: msg };
  }
  if (/nonce/i.test(msg)) return { code: "NONCE_ERROR", detail: msg };
  return { code: "RPC_ERROR", detail: msg };
}

/**
 * Everything for one wallet that can happen before the stage opens.
 *
 * Never throws. One wallet's refusal must not stop the others being prepared,
 * and on a forty-wallet run the difference between an exception and a recorded
 * failure is thirty-nine mints.
 */
export async function prepareGenericMint(
  address: string,
  opts: GenericPrepareOpts
): Promise<PreparedMint> {
  const p = newPrepared(address, opts.spec.quantity);
  const emit = (state: WalletState, detail?: string) => {
    p.state = state;
    opts.onEvent?.({ at: now(), address, state, detail });
  };

  p.timings.t0 = now();
  emit("PREPARING");

  // A local copy. Writing a measured gas limit back into opts would leak this
  // wallet's estimate into every other wallet sharing the controller's
  // options -- they are prepared concurrently against one object.
  let fees = opts.fees ? { ...opts.fees } : undefined;

  try {
    // ── AUTHORISE ────────────────────────────────────────────────────────
    // Issued to this address, used for this address. A proof or signature is
    // bound to the minter named in it; lending one to another wallet is not a
    // shortcut, it is a transaction the contract rejects.
    let auth: WalletAuthorization = { address };
    if (opts.authFor) {
      const got = await opts.authFor(address);
      if (got) {
        if (got.address.toLowerCase() !== address.toLowerCase()) {
          p.failure = {
            code: "INVALID_AUTHORIZATION",
            detail: `the authorisation returned is for ${got.address}, not ${address}`,
          };
          emit("FAILED", p.failure.detail);
          return p;
        }
        auth = got;
      } else if (opts.spec.kind === "merkle" || opts.spec.kind === "signed") {
        p.failure = {
          code: "NOT_ELIGIBLE",
          detail: "no proof or signature is available for this wallet on this stage",
        };
        emit("INELIGIBLE", p.failure.detail);
        return p;
      }
    }

    // ── BUILD ────────────────────────────────────────────────────────────
    const built = buildMintCalldata(opts.spec, auth);
    p.tx = { to: built.to, data: built.data, value: built.value };
    p.summary = describeSpec(opts.spec);
    p.timings.t1 = now();

    // ── AFFORD ───────────────────────────────────────────────────────────
    // A node reserves gasLimit x maxFeePerGas plus the value before it will
    // accept the transaction at all, so an underfunded wallet is refused by
    // the protocol before the mint is ever attempted. Better known now.
    if (opts.balanceFor && fees) {
      const balance = await opts.balanceFor(address).catch(() => null);
      if (balance !== null) {
        const required = BigInt(fees.gasLimit) * fees.maxFeePerGas + built.value;
        if (balance < required) {
          p.failure = {
            code: "INSUFFICIENT_BALANCE",
            detail: `holds ${formatEther(balance)} but needs ${formatEther(required)} to send this`,
          };
          emit("FAILED", p.failure.detail);
          return p;
        }
      }
    }

    // ── SIMULATE ─────────────────────────────────────────────────────────
    if (opts.simulate !== false) {
      const sim = await simulateMint({
        rpcUrl: opts.rpcUrl,
        from: address,
        to: built.to,
        data: built.data,
        value: built.value,
        estimateGas: opts.estimateGas,
      });
      if (!sim.ok && sim.failure) {
        if (!isTimingFailure(sim.failure.code)) {
          // Wrong, not early. Every other revert means this transaction would
          // burn gas for nothing whenever it were sent.
          p.failure = { code: sim.failure.code, detail: sim.failure.detail };
          emit(RETRYABLE.has(sim.failure.code) ? "FAILED" : "INELIGIBLE", sim.failure.detail);
          return p;
        }
        // Early is expected an hour before the open, and is the one revert
        // that says the transaction is RIGHT -- it is the stage that is not
        // ready yet.
        p.summary = `${p.summary} (simulates as "${sim.failure.detail}" -- the stage is not open yet)`;
      }
      if (sim.gasEstimate) {
        // Measured beats modelled where the node was willing to measure. The
        // margin covers the state moving between now and the open.
        p.gasLimit = Math.ceil(sim.gasEstimate * 1.25);
        if (fees) fees = { ...fees, gasLimit: p.gasLimit };
      }
    }
    p.timings.t2 = now();

    // ── NONCE ────────────────────────────────────────────────────────────
    p.nonce = await opts.nonceFor(address);

    // ── SIGN ─────────────────────────────────────────────────────────────
    p.gasLimit ??= fees?.gasLimit;

    if (opts.signerFor && fees) {
      const wallet = await opts.signerFor(address);
      if (wallet.address.toLowerCase() !== address.toLowerCase()) {
        p.failure = {
          code: "INVALID_AUTHORIZATION",
          detail: "the signer supplied is not the wallet this was prepared for",
        };
        emit("FAILED", p.failure.detail);
        return p;
      }
      p.raw = await wallet.signTransaction({
        to: built.to,
        data: built.data,
        value: built.value,
        nonce: p.nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        gasLimit: fees.gasLimit,
        type: 2,
        chainId: opts.spec.chainId,
      });
    }

    emit("READY");
    return p;
  } catch (err) {
    p.failure = classifyPrepareError(err);
    emit(RETRYABLE.has(p.failure.code) ? "FAILED" : "INELIGIBLE", p.failure.detail);
    return p;
  }
}

/**
 * Many independently eligible wallets on a project's own contract.
 *
 * Each wallet is its own minter with its own authorisation, its own nonce, its
 * own value and its own transaction. There is no such thing as one EVM
 * transaction from several EOAs, so "bundling" here means firing independent
 * transactions from one moment -- not combining them, which is not a thing
 * that exists.
 */
export class GenericMintController {
  readonly wallets = new Map<string, PreparedMint>();

  constructor(private readonly opts: GenericPrepareOpts) {}

  async prepareAll(addresses: string[]): Promise<PreparedMint[]> {
    for (const a of addresses) this.wallets.set(a.toLowerCase(), newPrepared(a, this.opts.spec.quantity));
    const out = await prepareMany(
      addresses,
      this.opts.concurrency,
      this.opts.retries,
      (a) => prepareGenericMint(a, this.opts)
    );
    for (const p of out) this.wallets.set(p.address.toLowerCase(), p);
    return out;
  }

  get ready(): PreparedMint[] {
    return [...this.wallets.values()].filter((p) => p.state === "READY");
  }

  /**
   * Fire every READY wallet from one opening moment.
   *
   * `openedAt` is stamped as t3 on each, so the latency report measures from
   * when the stage opened rather than from when this happened to be called.
   */
  async fireAll(fire: Omit<FireOpts, "onEvent">, openedAt = now()): Promise<PreparedMint[]> {
    const { firePreparedMint } = await import("./mint-prepare");
    const ready = this.ready;
    for (const p of ready) p.timings.t3 = openedAt;
    return Promise.all(ready.map((p) => firePreparedMint(p, { ...fire, onEvent: this.opts.onEvent })));
  }

  /** One line per wallet, naming the state and the cause. */
  summary(): string[] {
    return [...this.wallets.values()].map((p) => {
      const head = `${p.address.slice(0, 10)}… ${p.state}`;
      if (p.failure) return `${head}: ${p.failure.code} — ${p.failure.detail}`;
      if (p.txHash) return `${head}: ${p.txHash}`;
      if (p.state === "READY") {
        return `${head} (×${p.quantity}${p.raw ? ", pre-signed" : ""})${p.summary ? ` — ${p.summary}` : ""}`;
      }
      return head;
    });
  }

  /** Measured latencies for whichever wallet got furthest. Never estimated. */
  report(): string[] {
    const lines: string[] = [];
    for (const p of this.wallets.values()) {
      const l = latencies(p.timings);
      const bits: string[] = [];
      if (l.prepareLatency !== undefined) bits.push(`prepare ${l.prepareLatency}ms`);
      if (l.signingLatency !== undefined) bits.push(`sign ${l.signingLatency}ms`);
      if (l.rpcSubmissionLatency !== undefined) bits.push(`submit ${l.rpcSubmissionLatency}ms`);
      if (l.totalFireLatency !== undefined) bits.push(`open→hash ${l.totalFireLatency}ms`);
      if (bits.length > 0) lines.push(`${p.address.slice(0, 10)}… ${bits.join(" · ")}`);
    }
    return lines;
  }
}

/**
 * What a dry run should print: what would be sent, and whether it would work.
 *
 * Deliberately never signs and never broadcasts -- the caller builds the
 * controller without a signerFor and reads this.
 */
export function describeDryRun(spec: MintSpec, prepared: PreparedMint[], symbol = "ETH"): string {
  const lines = [describeSpec(spec, symbol)];
  if (!supportsBatch(spec) && spec.quantity > 1) {
    lines.push(
      `This contract takes no quantity argument, so ${spec.quantity} means ${spec.quantity} separate ` +
        "transactions from each wallet, not one."
    );
  }
  lines.push("");
  for (const p of prepared) {
    if (p.state === "READY") {
      const value = p.tx ? `${formatEther(p.tx.value)} ${symbol}` : "?";
      lines.push(`  READY  ${p.address} — sends ${value}${p.raw ? " (pre-signed)" : ""}`);
    } else {
      lines.push(`  ${p.state.padEnd(6)} ${p.address} — ${p.failure?.code ?? ""} ${p.failure?.detail ?? ""}`.trimEnd());
    }
  }
  const ready = prepared.filter((p) => p.state === "READY").length;
  lines.push("", `${ready} of ${prepared.length} wallet(s) would send. Nothing was signed or broadcast.`);
  return lines.join("\n");
}
