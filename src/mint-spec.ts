// Turning "this contract, this function, this wallet" into calldata.
//
// The configuration object the rest of the generic path is built around, plus
// the one function that fills it in. Kept separate from the probe because a
// spec can also come from an operator who simply KNOWS what to call -- pasting
// an ABI and a function name has to work exactly as well as detection, since
// detection is only ever a shortcut for contracts this repo happens to have
// seen before.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: an argument is either derived from
// something the bot legitimately holds, or it is reported missing. There is no
// third branch. Filling an unknown argument with a zero produces calldata that
// encodes cleanly, passes every local check, and reverts on-chain -- the most
// expensive possible way to be wrong, because it is only discovered in the
// race it was supposed to win.
//
// WHAT COUNTS AS LEGITIMATELY HELD:
//   quantity   the operator asked for it
//   minter     the wallet's own address, which it will sign with
//   proof      derived from the project's PUBLISHED list (maths over public
//              data -- see seadrop-allowlist.ts for the same argument)
//   signature  issued to THIS wallet by the project's own authorisation
//              endpoint, passed through byte-for-byte
//   allowance  carried by this wallet's own allow-list entry
//
// and nothing else. A signature is never constructed here, a proof is never
// invented, and one wallet's authorisation is never used for another.

import { Interface, ParamType, getAddress } from "ethers";
import { MintArgKind, MintKind, MintSignature } from "./mint-signatures";

/**
 * thirdweb's sentinel for "paid in the chain's native coin".
 *
 * Their claim() takes a currency address explicitly, and this value is what it
 * expects for ETH. Passing the zero address instead is a revert.
 */
export const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/**
 * Everything needed to build one collection's mint, independent of wallet.
 *
 * Deliberately carries the signature as a STRING rather than a parsed shape,
 * so a spec survives the Telegram store's JSON round trip and can be re-parsed
 * at fire time from exactly what was armed.
 */
export interface MintSpec {
  chainId: number;
  contract: string;
  /** Canonical solidity signature of the function to call. */
  signature: string;
  /** What each top-level argument means, in order. Same length as the inputs. */
  args: MintArgKind[];
  kind: MintKind;
  /** Price per token, in wei. Zero for a free mint. */
  priceWei: bigint;
  /** How many to mint per wallet, per transaction. */
  quantity: number;
  /**
   * Values for arguments nothing can derive -- an instance id, a phase index.
   * Consumed in the order the "operator" args appear.
   */
  operatorArgs?: readonly unknown[];
  /** For contracts taking a currency explicitly. Defaults to native. */
  currency?: string;
  /** For edition/1155-shaped mints that name a token. */
  tokenId?: bigint;
  /**
   * Value to send, when the contract does not charge price x quantity.
   *
   * Some contracts take a flat fee, or fold a platform fee into the call. An
   * explicit override is honoured exactly; otherwise the value is computed.
   */
  valueOverrideWei?: bigint;
}

/** One wallet's own authorisation. Never shared, never substituted. */
export interface WalletAuthorization {
  address: string;
  /** Merkle proof for THIS address. */
  proof?: readonly string[];
  /** Server-issued signature for THIS address, passed through untouched. */
  signature?: string;
  /** This wallet's allowance, as the allow-list entry states it. */
  allowance?: bigint;
  /** A nonce or deadline issued with the signature. */
  nonce?: bigint;
  /** A price the authorisation itself fixes, overriding the spec's. */
  priceWei?: bigint;
  /** Where this came from, so a report can say. */
  source?: string;
}

export interface BuiltMint {
  to: string;
  data: string;
  value: bigint;
}

export class MintSpecError extends Error {
  constructor(
    message: string,
    /** Which arguments could not be filled, named for the operator. */
    readonly missing: string[] = []
  ) {
    super(message);
    this.name = "MintSpecError";
  }
}

/** A spec from a detected signature, with the terms read off the chain. */
export function specFromSignature(
  m: MintSignature,
  opts: {
    chainId: number;
    contract: string;
    quantity: number;
    priceWei: bigint;
    operatorArgs?: readonly unknown[];
    currency?: string;
    tokenId?: bigint;
    valueOverrideWei?: bigint;
  }
): MintSpec {
  return {
    chainId: opts.chainId,
    contract: getAddress(opts.contract),
    signature: m.signature,
    args: [...m.args],
    kind: m.kind,
    priceWei: opts.priceWei,
    quantity: opts.quantity,
    operatorArgs: opts.operatorArgs,
    currency: opts.currency,
    tokenId: opts.tokenId,
    valueOverrideWei: opts.valueOverrideWei,
  };
}

const fnName = (signature: string): string => signature.slice(0, signature.indexOf("("));

/** The parsed inputs of a spec's signature, or a clear error about why not. */
export function inputsOf(signature: string): readonly ParamType[] {
  try {
    const iface = new Interface([`function ${signature} payable`]);
    return iface.getFunction(fnName(signature))!.inputs;
  } catch {
    throw new MintSpecError(
      `"${signature}" is not a solidity function signature this can parse. ` +
        "Expected something like mint(uint256) or allowlistMint(uint256,bytes32[])."
    );
  }
}

/**
 * What this spec still needs before any wallet can mint with it.
 *
 * Run at CONFIGURE time rather than at fire time, so a missing instance id is
 * a message an hour early instead of a revert during the race.
 */
export function missingSpecInputs(spec: MintSpec): string[] {
  const missing: string[] = [];
  const inputs = inputsOf(spec.signature);
  if (inputs.length !== spec.args.length) {
    missing.push(
      `the argument map has ${spec.args.length} entries but ${spec.signature} takes ${inputs.length}`
    );
  }
  const operatorCount = spec.args.filter((a) => a === "operator").length;
  const supplied = spec.operatorArgs?.length ?? 0;
  if (operatorCount > supplied) {
    missing.push(
      `${operatorCount - supplied} argument(s) only the project knows (${inputs
        .filter((_, i) => spec.args[i] === "operator")
        .map((p) => p.name || p.type)
        .join(", ")})`
    );
  }
  return missing;
}

/**
 * Calldata for one wallet, from the spec and that wallet's own authorisation.
 *
 * Throws MintSpecError naming exactly what is missing rather than encoding a
 * placeholder. That is the difference between "this wallet has no signature
 * yet" -- actionable, an hour out -- and an InvalidSignature revert that still
 * pays the gas.
 */
export function buildMintCalldata(spec: MintSpec, auth: WalletAuthorization): BuiltMint {
  const inputs = inputsOf(spec.signature);
  if (inputs.length !== spec.args.length) {
    throw new MintSpecError(
      `the argument map has ${spec.args.length} entries but ${spec.signature} takes ${inputs.length}`
    );
  }

  const minter = getAddress(auth.address);
  const quantity = BigInt(spec.quantity);
  const perToken = auth.priceWei ?? spec.priceWei;
  const missing: string[] = [];
  let operatorNext = 0;

  const values = inputs.map((param, i) => {
    const kind: MintArgKind = spec.args[i];
    const label = param.name || `arg${i}`;

    switch (kind) {
      case "quantity":
        return quantity;

      case "minter":
        return minter;

      case "proof": {
        // thirdweb wraps the proof in a struct that also restates the phase's
        // own limits. Those numbers are not ours to choose: the contract
        // checks them against the active claim condition, so they come from
        // the authorisation (or fall back to this wallet's allowance and the
        // price already read from the chain).
        if (param.baseType === "tuple") {
          return [
            auth.proof ?? [],
            auth.allowance ?? quantity,
            perToken,
            spec.currency ?? NATIVE_TOKEN,
          ];
        }
        if (!auth.proof) {
          missing.push(`${label} (a Merkle proof for ${minter})`);
          return [];
        }
        return [...auth.proof];
      }

      case "signature":
        if (!auth.signature) {
          missing.push(`${label} (a signature issued to ${minter} by the project)`);
          return "0x";
        }
        // Passed through byte-for-byte. Anything else invalidates it.
        return auth.signature;

      case "allowance":
        // Falling back to the quantity is safe in the only direction that
        // matters: a contract checking the allowance against a proof rejects
        // a wrong value outright rather than silently over-minting.
        return auth.allowance ?? quantity;

      case "price":
        return perToken;

      case "currency":
        return getAddress(spec.currency ?? NATIVE_TOKEN);

      case "nonce":
        if (auth.nonce === undefined) {
          missing.push(`${label} (issued with the signature)`);
          return 0n;
        }
        return auth.nonce;

      case "tokenId":
        if (spec.tokenId === undefined) {
          missing.push(`${label} (which token this mints)`);
          return 0n;
        }
        return spec.tokenId;

      case "empty":
        return "0x";

      case "operator": {
        const supplied = spec.operatorArgs?.[operatorNext++];
        if (supplied === undefined) {
          missing.push(`${label} (${param.type} -- only the project knows this)`);
          return 0;
        }
        return supplied;
      }
    }
  });

  if (missing.length > 0) {
    throw new MintSpecError(
      `Cannot build this mint for ${minter} -- missing: ${missing.join("; ")}.`,
      missing
    );
  }

  const iface = new Interface([`function ${spec.signature} payable`]);
  return {
    to: getAddress(spec.contract),
    data: iface.encodeFunctionData(fnName(spec.signature), values),
    value: spec.valueOverrideWei ?? perToken * quantity,
  };
}

/**
 * Whether this contract can mint more than one per transaction.
 *
 * A quantity argument is the evidence. Without one, `mint()` mints exactly one
 * however the operator configured it, and asking for five means five
 * transactions -- five nonces, five fees. Said out loud rather than silently
 * minting one and reporting five.
 */
export function supportsBatch(spec: MintSpec): boolean {
  return spec.args.includes("quantity");
}

/** One line describing what a spec will actually send. */
export function describeSpec(spec: MintSpec, symbol = "ETH"): string {
  const price =
    spec.priceWei === 0n ? "free" : `${Number(spec.priceWei) / 1e18} ${symbol} each`;
  const batch = supportsBatch(spec)
    ? `x${spec.quantity}`
    : `x1 per transaction (this contract takes no quantity argument)`;
  return `${spec.kind} mint via ${spec.signature} -- ${batch}, ${price}`;
}
