// Asking the node what would happen, before paying to find out.
//
// A mint that reverts still costs the gas it burned getting there. In a race
// that is the worst possible moment to discover a wrong proof, a closed stage,
// or a value one wei short -- the transaction is gone, the money is gone, and
// the drop is gone. An eth_call with the exact same from/to/data/value runs the
// contract against current state and returns the revert instead of charging
// for it.
//
// WHAT A PASS DOES AND DOES NOT MEAN. It means: against the state of the chain
// as of the block it ran on, this transaction succeeds. It does NOT mean the
// transaction will succeed later. Supply runs out, stages close, the project
// pauses the contract, another 4,000 people mint in the block before yours.
// Simulation removes the failures that were already certain; it cannot remove
// the ones that depend on what happens next. Nothing in this repo reports a
// simulated mint as a guaranteed one.
//
// THE OTHER HALF: a mint that is SUPPOSED to fail right now. Simulating a
// stage that opens in an hour reverts with "not started", which is the correct
// answer and not a reason to refuse to arm. classifyRevert separates "wrong"
// from "not yet" so the caller can treat them differently -- see
// isTimingFailure.

import { AbiCoder, getAddress, id } from "ethers";
import { createProvider } from "./rpc-provider";
import { FailureCode } from "./mint-prepare";

const CODER = AbiCoder.defaultAbiCoder();

/** Solidity's `revert("...")`. */
const ERROR_STRING = "0x08c379a0";
/** Solidity's `assert` / arithmetic failures. */
const PANIC = "0x4e487b71";

/**
 * Custom errors common to NFT mints, by name.
 *
 * A custom error arrives as four bytes with no text, so the only way to read
 * one is to have hashed the name in advance. These are the names that recur
 * across ERC721A-derived contracts; anything not here is reported as an
 * unrecognised selector rather than guessed at.
 */
const CUSTOM_ERRORS: Record<string, FailureCode> = {};
const named = (signature: string, code: FailureCode) => {
  CUSTOM_ERRORS[id(signature).slice(0, 10)] = code;
};

named("InvalidProof()", "NOT_ELIGIBLE");
named("NotAllowlisted()", "NOT_ELIGIBLE");
named("NotWhitelisted()", "NOT_ELIGIBLE");
named("InvalidSignature()", "INVALID_AUTHORIZATION");
named("SignatureAlreadyUsed()", "INVALID_AUTHORIZATION");
named("SignatureExpired()", "INVALID_AUTHORIZATION");
named("InvalidSigner()", "INVALID_AUTHORIZATION");
named("SaleNotStarted()", "DROP_NOT_STARTED");
named("SaleNotActive()", "STAGE_NOT_ACTIVE");
named("MintNotActive()", "STAGE_NOT_ACTIVE");
named("NotLive()", "STAGE_NOT_ACTIVE");
named("SaleEnded()", "DROP_ENDED");
named("SoldOut()", "SUPPLY_EXHAUSTED");
named("MaxSupplyExceeded()", "SUPPLY_EXHAUSTED");
named("ExceedsMaxSupply()", "SUPPLY_EXHAUSTED");
named("MintedOut()", "SUPPLY_EXHAUSTED");
named("ExceedsMaxPerWallet()", "WALLET_LIMIT_EXCEEDED");
named("MaxPerWalletExceeded()", "WALLET_LIMIT_EXCEEDED");
named("ExceedsWalletLimit()", "WALLET_LIMIT_EXCEEDED");
named("InsufficientPayment()", "INSUFFICIENT_BALANCE");
named("WrongPrice()", "INSUFFICIENT_BALANCE");
named("IncorrectPayment()", "INSUFFICIENT_BALANCE");
named("EnforcedPause()", "STAGE_NOT_ACTIVE");

/** Revert strings, matched case-insensitively as fragments. */
const STRING_PATTERNS: [RegExp, FailureCode][] = [
  [/not started|not yet|too early|hasn'?t started|not begun/i, "DROP_NOT_STARTED"],
  [/ended|finished|is over|closed/i, "DROP_ENDED"],
  [/paus|not active|not live|sale is not|inactive/i, "STAGE_NOT_ACTIVE"],
  [/sold ?out|max supply|exceeds supply|supply exceeded|no more/i, "SUPPLY_EXHAUSTED"],
  [/per wallet|per address|already minted|max mint|exceeds? (your )?(limit|allowance)/i, "WALLET_LIMIT_EXCEEDED"],
  [/proof|not on the list|allow ?list|white ?list|not eligible/i, "NOT_ELIGIBLE"],
  [/signature|signer|unauthori[sz]ed voucher/i, "INVALID_AUTHORIZATION"],
  [/insufficient|value sent|incorrect (amount|price|payment)|wrong price|not enough eth/i, "INSUFFICIENT_BALANCE"],
];

export interface RevertInfo {
  code: FailureCode;
  /** What the contract actually said, for a report that can be acted on. */
  detail: string;
  /** The raw selector, when it was a custom error nobody could name. */
  selector?: string;
}

/** Decode revert data into a cause, without inventing one. */
export function classifyRevert(data: string | null | undefined, fallback = ""): RevertInfo {
  if (data && data.length >= 10) {
    const selector = data.slice(0, 10).toLowerCase();

    if (selector === ERROR_STRING) {
      let message = "";
      try {
        message = String(CODER.decode(["string"], `0x${data.slice(10)}`)[0]);
      } catch {
        message = "";
      }
      return { code: matchString(message) ?? "UNKNOWN_REVERT", detail: message || "reverted" };
    }

    if (selector === PANIC) {
      let n = 0n;
      try {
        n = BigInt(CODER.decode(["uint256"], `0x${data.slice(10)}`)[0]);
      } catch {
        /* leave 0 */
      }
      return {
        code: "UNKNOWN_REVERT",
        detail: `the contract hit a solidity panic (0x${n.toString(16)}) -- usually an overflow or a bad index`,
      };
    }

    const known = CUSTOM_ERRORS[selector];
    if (known) {
      const name = Object.keys(CUSTOM_ERRORS).find((k) => k === selector);
      return { code: known, detail: describeCode(known), selector: name };
    }

    return {
      code: "UNKNOWN_REVERT",
      // Naming the selector is genuinely useful: it can be looked up, and it
      // is the difference between "it failed" and something to search for.
      detail: `reverted with an unrecognised custom error (${selector})`,
      selector,
    };
  }

  const matched = matchString(fallback);
  return { code: matched ?? "UNKNOWN_REVERT", detail: fallback || "reverted with no reason given" };
}

function matchString(message: string): FailureCode | null {
  for (const [pattern, code] of STRING_PATTERNS) {
    if (pattern.test(message)) return code;
  }
  return null;
}

function describeCode(code: FailureCode): string {
  const text: Partial<Record<FailureCode, string>> = {
    NOT_ELIGIBLE: "this wallet is not on the list for this stage",
    INVALID_AUTHORIZATION: "the signature was rejected",
    DROP_NOT_STARTED: "the stage has not opened yet",
    STAGE_NOT_ACTIVE: "the stage is not active",
    DROP_ENDED: "the stage has ended",
    SUPPLY_EXHAUSTED: "there is nothing left to mint",
    WALLET_LIMIT_EXCEEDED: "this wallet is at its limit",
    INSUFFICIENT_BALANCE: "the value sent does not match the price",
  };
  return text[code] ?? "reverted";
}

/**
 * Failures that mean "not yet" rather than "not ever".
 *
 * A stage that has not opened SHOULD reject a mint; that is the contract doing
 * its job. Arming is refused on everything else and allowed on these, because
 * refusing to arm an unopened stage would make the whole prepare-ahead design
 * impossible -- which is the thing it exists for.
 */
export function isTimingFailure(code: FailureCode): boolean {
  return code === "DROP_NOT_STARTED" || code === "STAGE_NOT_ACTIVE";
}

export interface SimulationResult {
  ok: boolean;
  failure?: RevertInfo;
  /** Gas the node estimated, where it was willing to say. */
  gasEstimate?: number;
}

export interface SimulateOpts {
  rpcUrl: string;
  from: string;
  to: string;
  data: string;
  value: bigint;
  /** Also ask for an estimate, when a measured limit is wanted. */
  estimateGas?: boolean;
}

/**
 * Run this exact transaction against current state without sending it.
 *
 * `from` matters and is not optional: a mint checks msg.sender against a proof,
 * a signature, a per-wallet counter. Simulating from the zero address answers
 * a question nobody asked.
 */
export async function simulateMint(opts: SimulateOpts): Promise<SimulationResult> {
  const provider = createProvider(opts.rpcUrl);
  const tx = {
    from: getAddress(opts.from),
    to: getAddress(opts.to),
    data: opts.data,
    value: opts.value,
  };

  try {
    await provider.call(tx);
  } catch (err) {
    const e = err as { data?: string; info?: { error?: { data?: string; message?: string } }; shortMessage?: string; message?: string };
    const data = e?.data ?? e?.info?.error?.data;
    const text = e?.shortMessage ?? e?.info?.error?.message ?? e?.message ?? "";
    return { ok: false, failure: classifyRevert(data, text) };
  }

  if (!opts.estimateGas) return { ok: true };

  try {
    const estimate = await provider.estimateGas(tx);
    return { ok: true, gasEstimate: Number(estimate) };
  } catch {
    // The call succeeded, so the transaction is sound; a node declining to
    // estimate is a node problem, and falling back to the fitted model in
    // gas.ts is strictly better than refusing the mint over it.
    return { ok: true };
  }
}
