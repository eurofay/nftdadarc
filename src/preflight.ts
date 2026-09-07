// Simulating a mint before spending gas on it.
//
// eth_call runs the transaction against current state and returns without
// touching a block. It costs nothing, and this chain's read endpoints return
// the revert selector rather than a bare "execution reverted" — measured, and
// the reason this module is worth having at all.
//
// The useful consequence is for allow-list mints armed in advance. Simulate
// one hours before the stage opens and the revert distinguishes two things
// that matter enormously and otherwise look identical at fire time:
//
//   NotActive     -> the proof is accepted, the stage has simply not opened.
//                    This is what a correctly armed mint looks like early.
//   InvalidProof  -> the proof is wrong. You now know hours in advance,
//                    instead of at the only moment you cannot fix it.
//
// WHERE THIS MUST NOT GO: the critical path of a contested mint. A simulation
// is a round trip, and spending one before sending means arriving a round trip
// later — which is the whole thing the early-fire work exists to avoid. This
// belongs at arming time and on paths that are not racing anyone.

import { Interface } from "ethers";

/**
 * SeaDrop's custom errors, by selector.
 *
 * A revert on this contract is four bytes of keccak, so without a table it
 * reads as noise. Each entry says what to do about it, because "0x09bde339"
 * and "InvalidProof" are equally useless to someone trying to fix a mint.
 */
export const SEADROP_ERRORS: Record<string, { name: string; meaning: string; armedOk?: boolean }> = {
  "0x13da22f2": {
    name: "NotActive",
    meaning: "the stage is not open yet — everything else about this mint checks out",
    // The one revert that is good news when you are testing in advance.
    armedOk: true,
  },
  "0x09bde339": {
    name: "InvalidProof",
    meaning: "this wallet's Merkle proof was rejected — it is not on the list, or the proof is for a different root",
  },
  "0x0d35e921": {
    name: "IncorrectPayment",
    meaning: "the value sent does not match the stage price",
  },
  "0xedc01273": {
    name: "MintQuantityExceedsMaxMintedPerWallet",
    meaning: "this wallet has already had its allowance from this stage",
  },
  "0xe12d2314": {
    name: "MintQuantityExceedsMaxSupply",
    meaning: "the collection is sold out",
  },
  "0x198441cb": { name: "MintQuantityCannotBeZero", meaning: "quantity was zero" },
  "0x5b8ac2a5": { name: "FeeRecipientNotAllowed", meaning: "the fee recipient is not one this drop accepts" },
  "0x4be6321b": { name: "PayerNotAllowed", meaning: "this wallet may not pay on another wallet's behalf" },
  "0x2a63e33b": { name: "SignerNotPresent", meaning: "the stage needs a signature this mint does not carry" },
};

export interface Preflight {
  /** The simulation returned without reverting: this mint would go through. */
  wouldSucceed: boolean;
  /**
   * True when the only thing stopping it is the clock.
   *
   * For a mint armed in advance this is the passing result — everything is
   * correct and it is simply early.
   */
  onlyTooEarly: boolean;
  selector: string | null;
  errorName: string | null;
  /** One sentence, aimed at whoever has to fix it. */
  detail: string;
}

/** Pull the revert selector out of whatever shape the node returned it in. */
export function revertSelector(err: unknown): string | null {
  const e = err as any;
  const raw =
    (typeof e?.data === "string" && e.data) ||
    (typeof e?.info?.error?.data === "string" && e.info.error.data) ||
    (typeof e?.error?.data === "string" && e.error.data) ||
    null;
  if (!raw || !raw.startsWith("0x") || raw.length < 10) return null;
  return raw.slice(0, 10).toLowerCase();
}

/** Turn a revert into something worth reading. */
export function explainRevert(selector: string | null, fallback = "reverted for an unrecognised reason"): Preflight {
  if (!selector) {
    return { wouldSucceed: false, onlyTooEarly: false, selector: null, errorName: null, detail: fallback };
  }
  const known = SEADROP_ERRORS[selector];
  if (!known) {
    return {
      wouldSucceed: false,
      onlyTooEarly: false,
      selector,
      errorName: null,
      detail: `reverted with ${selector}, which is not a SeaDrop error this knows`,
    };
  }
  return {
    wouldSucceed: false,
    onlyTooEarly: known.armedOk === true,
    selector,
    errorName: known.name,
    detail: known.meaning,
  };
}

export interface SimulateOpts {
  rpcUrl: string;
  from: string;
  to: string;
  data: string;
  value: bigint;
  timeoutMs?: number;
}

/**
 * Run the mint without sending it.
 *
 * Uses raw JSON-RPC rather than a provider because the revert data is the
 * whole point, and ethers normalises some of it away into "missing revert
 * data" — measured against this chain.
 */
export async function simulateMint(opts: SimulateOpts): Promise<Preflight> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(opts.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [
          { from: opts.from, to: opts.to, data: opts.data, value: "0x" + opts.value.toString(16) },
          "latest",
        ],
      }),
    });
    const json = (await res.json()) as any;
    if (!json.error) {
      return {
        wouldSucceed: true,
        onlyTooEarly: false,
        selector: null,
        errorName: null,
        detail: "this mint would go through",
      };
    }
    // A node that refuses on balance never reached the contract, so the
    // answer says nothing about whether the mint itself is sound.
    const message = String(json.error.message ?? "");
    if (/insufficient funds/i.test(message)) {
      return {
        wouldSucceed: false,
        onlyTooEarly: false,
        selector: null,
        errorName: "InsufficientFunds",
        detail: "this wallet cannot cover the mint plus gas, so the mint itself was never tested",
      };
    }
    return explainRevert(revertSelector(json.error), message.slice(0, 120) || "reverted");
  } catch (err: any) {
    return {
      wouldSucceed: false,
      onlyTooEarly: false,
      selector: null,
      errorName: null,
      detail: `could not simulate — ${err?.name === "AbortError" ? "timed out" : err?.message ?? err}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** One line for a log or a chat message. */
export function describePreflight(p: Preflight, walletLabel: string): string {
  if (p.wouldSucceed) return `✅ ${walletLabel} — would mint`;
  if (p.onlyTooEarly) return `🕓 ${walletLabel} — armed correctly, ${p.detail}`;
  return `❌ ${walletLabel} — ${p.detail}`;
}

/** Selector for a custom error signature, for building the table above. */
export function selectorFor(signature: string): string {
  return new Interface([`error ${signature}`]).getError(signature.split("(")[0])!.selector;
}
