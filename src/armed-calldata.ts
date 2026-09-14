// Keeping a signed-stage mint ready to send, so firing costs one round trip.
//
// THE PROBLEM THIS EXISTS FOR. A signed stage's authorisation is issued by the
// project, not derived from the chain, so the bot has to ask for it. Asking at
// fire time made the sequence:
//
//   stage opens -> log in -> request calldata -> wait -> sign -> send
//
// which puts two API round trips and a signature between the moment that
// matters and the transaction leaving. Every other mint path in this repo is
// pre-signed before the wait for exactly this reason; the signed path was the
// one that was not.
//
// WHAT MAKES PRE-ARMING SOUND. SeaDrop's signed digest covers
// (nftContract, minter, feeRecipient, mintParams, salt) and nothing else --
// no issue time, no expiry. The only clock in it is the stage's own
// startTime/endTime, carried inside mintParams. So a signature obtained an
// hour early is exactly as valid at T-0 as one obtained a second before,
// provided two things still hold:
//
//   the stage terms have not been reconfigured
//   the signer is still in getSigners()
//
// Both are readable on-chain, cheaply, which is what validate() below checks.
// This replaces an earlier comment in this repo asserting that armed calldata
// goes stale -- that was written without testing and is not what the contract
// does.
//
// WHAT IS STILL UNKNOWN, and why the refresh exists anyway: whether OpenSea
// will issue calldata for a stage that has not opened yet. If it refuses,
// arming produces nothing and the fire-time fetch is unavoidable for that
// collection. The design below works either way rather than betting on it.

import { Interface } from "ethers";
import { SEADROP_ADDRESS } from "./seadrop-public";
import { createProvider } from "./rpc-provider";

const IFACE = new Interface([
  "function getSigners(address) view returns (address[])",
  "function mintSigned(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, (uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, uint256 feeBps, bool restrictFeeRecipients) mintParams, uint256 salt, bytes signature) payable",
  "function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, (uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, uint256 feeBps, bool restrictFeeRecipients) mintParams, bytes32[] proof) payable",
]);

/** One wallet's ready-to-send transaction. */
export interface ArmedCalldata {
  address: string;
  to: string;
  data: string;
  /** Decimal string: a bigint does not survive the store's JSON round trip. */
  value: string;
  /** When it was obtained, so a stale-looking arm is visibly old. */
  at: number;
  /** Where it came from, because that decides whether it can be refreshed. */
  source: "opensea" | "allowlist";
}

export interface DecodedMint {
  kind: "signed" | "allowlist" | "public" | "unknown";
  nftContract?: string;
  feeRecipient?: string;
  quantity?: number;
  mintPriceWei?: bigint;
  startTime?: number;
  endTime?: number;
  maxTotalMintableByWallet?: number;
  feeBps?: number;
  /** Only a signed mint carries one. */
  salt?: bigint;
}

/**
 * Read what a piece of armed calldata actually says.
 *
 * Armed calldata arrives as opaque bytes from someone else's API, and storing
 * it unread means arming something nobody has looked at. Decoding it is what
 * makes the checks below possible at all -- and what turns "OpenSea returned
 * something" into "OpenSea returned a signed mint of 2 at 0.005 opening at
 * 14:00", which is a thing a person can disagree with.
 */
export function decodeMint(data: string): DecodedMint {
  for (const name of ["mintSigned", "mintAllowList"] as const) {
    try {
      const parsed = IFACE.decodeFunctionData(name, data);
      const mp = parsed[4] as any;
      return {
        kind: name === "mintSigned" ? "signed" : "allowlist",
        nftContract: String(parsed[0]),
        feeRecipient: String(parsed[1]),
        quantity: Number(parsed[3]),
        mintPriceWei: BigInt(mp[0]),
        maxTotalMintableByWallet: Number(mp[1]),
        startTime: Number(mp[2]),
        endTime: Number(mp[3]),
        feeBps: Number(mp[6]),
        salt: name === "mintSigned" ? BigInt(parsed[5]) : undefined,
      };
    } catch {
      /* not this shape; try the next */
    }
  }
  return { kind: "unknown" };
}

export interface ValidationResult {
  ok: boolean;
  /** Said plainly, aimed at whoever has to decide what to do about it. */
  detail: string;
  decoded: DecodedMint;
}

export interface ValidateOpts {
  rpcUrl: string;
  /** The collection this was armed for, to catch calldata for the wrong one. */
  expectedContract: string;
  /** Now, in seconds. Injected so the check is testable. */
  nowSec?: number;
  /**
   * Where this mint is legitimately addressed, when it is NOT SeaDrop's.
   *
   * A project's own contract is minted by calling the collection directly, so
   * "to" is the collection rather than the singleton, and the calldata is a
   * function this file has no decoder for. Without this, every such mint would
   * be rejected as "not a SeaDrop mint this bot can read" -- correct about the
   * decoding, wrong about the conclusion.
   *
   * The check it enables is the one that actually matters: armed bytes must go
   * where the operator armed them, so value cannot be sent to an address that
   * arrived from somewhere else. Supplying it does not weaken the SeaDrop
   * checks below -- those still run whenever the calldata decodes as SeaDrop.
   */
  expectedTo?: string;
}

/**
 * Check armed calldata still means what it meant when it was armed.
 *
 * Deliberately checks the two things that CAN change and nothing else. A
 * signature does not expire, so there is no age test here -- adding one would
 * discard perfectly good calldata and reintroduce the fetch this exists to
 * remove.
 */
export async function validateArmed(
  armed: Pick<ArmedCalldata, "to" | "data">,
  opts: ValidateOpts
): Promise<ValidationResult> {
  const decoded = decodeMint(armed.data);

  // A mint on a project's own contract, armed against a known destination.
  // There is no decoder for an arbitrary contract's mint function, so the
  // check is the one that can be made and does matter: it must be addressed
  // where it was armed. Only reachable when the caller passed expectedTo,
  // which the SeaDrop paths never do.
  if (decoded.kind === "unknown" && opts.expectedTo) {
    const addressedRight = armed.to.toLowerCase() === opts.expectedTo.toLowerCase();
    return addressedRight
      ? { ok: true, detail: `addressed to ${armed.to}, as armed`, decoded }
      : {
          ok: false,
          detail: `it is addressed to ${armed.to}, not the ${opts.expectedTo} it was armed for`,
          decoded,
        };
  }

  if (decoded.kind === "unknown") {
    return { ok: false, detail: "this calldata is not a SeaDrop mint this bot can read", decoded };
  }
  if (armed.to.toLowerCase() !== SEADROP_ADDRESS.toLowerCase()) {
    // Armed bytes pointing somewhere other than SeaDrop is the one failure
    // worth being blunt about: it would send value to an unknown contract.
    return { ok: false, detail: `it is addressed to ${armed.to}, not the SeaDrop singleton`, decoded };
  }
  if (decoded.nftContract && decoded.nftContract.toLowerCase() !== opts.expectedContract.toLowerCase()) {
    return { ok: false, detail: "it mints a different collection than the one armed", decoded };
  }

  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (decoded.endTime && decoded.endTime > 0 && decoded.endTime < now) {
    return { ok: false, detail: "the stage it was issued for has already ended", decoded };
  }

  // The signer being removed is the one thing that silently voids a stored
  // signature, and it is a single cheap read.
  if (decoded.kind === "signed") {
    try {
      const provider = createProvider(opts.rpcUrl);
      const res = await provider.call({
        to: SEADROP_ADDRESS,
        data: IFACE.encodeFunctionData("getSigners", [opts.expectedContract]),
      });
      const signers = IFACE.decodeFunctionResult("getSigners", res)[0] as string[];
      if (!signers || signers.length === 0) {
        return { ok: false, detail: "the collection no longer has any authorised signer", decoded };
      }
    } catch {
      // Unreadable is not invalid. Refusing to fire because a read failed
      // would turn a flaky RPC into a missed mint.
    }
  }

  return { ok: true, detail: "still valid", decoded };
}

/** One line for a chat, so an armed mint can be read before it fires. */
export function describeArmed(d: DecodedMint, symbol: string): string {
  if (d.kind === "unknown") return "unreadable calldata";
  const price =
    d.mintPriceWei === undefined
      ? "?"
      : d.mintPriceWei === 0n
        ? "free"
        : `${(Number(d.mintPriceWei) / 1e18).toFixed(4)} ${symbol}`;
  const opens =
    d.startTime && d.startTime > 0 ? `, opens ${new Date(d.startTime * 1000).toLocaleString()}` : "";
  return `${d.kind} mint · ×${d.quantity ?? "?"} · ${price}${opens}`;
}
