// Reading an unknown mint contract: what it can do, and what state it is in.
//
// This is the "GENERIC STAGE READER" half of a non-SeaDrop mint. SeaDrop puts
// every drop's terms behind one known getter on one known singleton, so
// seadrop-stages.ts can simply ask. A project's own contract answers to
// whatever names its author chose, and there is no registry of those names.
//
// So this probes. It pulls the runtime bytecode once, recovers the selector
// set from it (mint-signatures.ts), and then calls only the getters the
// contract actually has. That ordering is the whole trick: calling forty
// speculative getters over the network costs forty round trips and produces
// forty ambiguous failures, whereas one eth_getCode says which of the forty
// exist before a single one is called.
//
// WHAT IT REFUSES TO DO. It does not infer a mint function from a name, fill
// an argument it cannot derive, or treat a missing getter as a zero. A
// contract whose mint shape is not recognised comes back as exactly that,
// with the selector list attached so the operator can supply the ABI. Guessing
// here would produce a transaction that reverts at the only moment that
// matters, which is strictly worse than saying "I need the ABI" an hour early.
//
// FRONTEND COUNTDOWNS ARE NOT AUTHORITATIVE. Where the contract exposes its
// own start time, that is what is read and that is what is waited on. A drop
// page saying 14:00 and a contract saying 14:05 disagree, and only one of them
// rejects transactions.

import { AbiCoder, Interface, getAddress } from "ethers";
import { createProvider } from "./rpc-provider";
import {
  KNOWN_VIEWS,
  MINTED_COUNT_VIEWS,
  MintSignature,
  ViewField,
  detectMints,
  selectorOf,
  selectorsFromBytecode,
} from "./mint-signatures";

const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

export interface ContractProfile {
  address: string;
  /** False when the address holds no code -- an EOA, or nothing at all. */
  isContract: boolean;
  /** Every 4-byte constant in the runtime code. A superset of its selectors. */
  selectors: Set<string>;
  /** Known mint entry points this contract exposes, gated stages first. */
  mints: MintSignature[];
  /** State read from the getters it actually has. */
  state: ContractState;
  /** Said plainly, for an operator deciding what to do next. */
  notes: string[];
}

export interface ContractState {
  totalSupply?: bigint;
  maxSupply?: bigint;
  priceWei?: bigint;
  maxPerWallet?: number;
  maxPerTransaction?: number;
  paused?: boolean;
  saleActive?: boolean;
  presaleActive?: boolean;
  /** An enum the project defines. Reported as read; never interpreted. */
  saleState?: number;
  merkleRoot?: string;
  signer?: string;
  startTime?: number;
  endTime?: number;
  /** Which getter each value came from, so a surprising number can be traced. */
  source: Partial<Record<ViewField, string>>;
}

/** Runtime bytecode, or null when the node would not answer. */
export async function fetchBytecode(rpcUrl: string, address: string): Promise<string | null> {
  try {
    const provider = createProvider(rpcUrl);
    return await provider.getCode(getAddress(address));
  } catch {
    return null;
  }
}

const CODER = AbiCoder.defaultAbiCoder();

/**
 * Decode a one-word return without insisting on the declared width.
 *
 * `uint64 price` and `uint256 price` are the same 32 bytes on the wire, and a
 * probe that demanded the exact type would reject the first for no reason.
 * Returns undefined rather than throwing on anything that is not one word,
 * because a contract answering something unexpected is a reason to skip that
 * getter, not to abandon the probe.
 */
function decodeWord(kind: "number" | "bool" | "address" | "bytes32", raw: string): unknown {
  try {
    if (!raw || raw === "0x") return undefined;
    switch (kind) {
      case "number":
        return BigInt(CODER.decode(["uint256"], raw)[0]);
      case "bool":
        return Boolean(CODER.decode(["bool"], raw)[0]);
      case "address":
        return String(CODER.decode(["address"], raw)[0]);
      case "bytes32":
        return String(CODER.decode(["bytes32"], raw)[0]);
    }
  } catch {
    return undefined;
  }
}

/**
 * How many getters to call at once.
 *
 * These are independent eth_calls against one node, so serialising them would
 * make the probe take as long as the sum rather than the slowest. Bounded
 * because a public endpoint answering twenty simultaneous calls from one
 * client starts rate-limiting, and a 429 costs more than the concurrency
 * saved -- the same reasoning as mint-resolve's OPENSEA_CONCURRENCY.
 */
export const PROBE_CONCURRENCY = 6;

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Everything about this contract that can be read without permission.
 *
 * One eth_getCode, then one eth_call per getter the code proves exists. A
 * contract with none of the known getters costs exactly one round trip to
 * find that out.
 */
export async function probeContract(
  rpcUrl: string,
  address: string,
  opts: { bytecode?: string } = {}
): Promise<ContractProfile> {
  const addr = getAddress(address);
  const code = opts.bytecode ?? (await fetchBytecode(rpcUrl, addr));
  const notes: string[] = [];

  if (code === null) {
    return {
      address: addr,
      isContract: false,
      selectors: new Set(),
      mints: [],
      state: { source: {} },
      notes: ["Could not read this address's code -- the RPC endpoint did not answer."],
    };
  }
  if (code === "0x" || code.length <= 2) {
    return {
      address: addr,
      isContract: false,
      selectors: new Set(),
      mints: [],
      state: { source: {} },
      notes: ["There is no contract at this address on this chain. Check the address and the chain."],
    };
  }

  const selectors = selectorsFromBytecode(code);
  const mints = detectMints(code);

  // Only the getters the bytecode proves are there. Probing the rest would be
  // dozens of round trips to be told "no" in a way indistinguishable from a
  // node having a bad moment.
  const present = KNOWN_VIEWS.filter((v) => selectors.has(v.selector));
  const provider = createProvider(rpcUrl);

  const results = await mapLimited(present, PROBE_CONCURRENCY, async (v) => {
    try {
      const raw = await provider.call({ to: addr, data: v.selector });
      return { v, value: decodeWord(v.returns, raw) };
    } catch {
      // A getter that exists but reverts (an unset phase, an access-gated
      // read) is a fact about this contract, not a probe failure.
      return { v, value: undefined };
    }
  });

  const state: ContractState = { source: {} };
  for (const { v, value } of results) {
    if (value === undefined) continue;
    // First spelling that answered wins -- KNOWN_VIEWS lists the more
    // specific name before the generic one for exactly this.
    if (state.source[v.field] !== undefined) continue;
    state.source[v.field] = v.signature;
    switch (v.field) {
      case "totalSupply":
        state.totalSupply = value as bigint;
        break;
      case "maxSupply":
        state.maxSupply = value as bigint;
        break;
      case "price":
        state.priceWei = value as bigint;
        break;
      case "maxPerWallet":
        state.maxPerWallet = Number(value as bigint);
        break;
      case "maxPerTransaction":
        state.maxPerTransaction = Number(value as bigint);
        break;
      case "paused":
        state.paused = value as boolean;
        break;
      case "saleActive":
        state.saleActive = value as boolean;
        break;
      case "presaleActive":
        state.presaleActive = value as boolean;
        break;
      case "saleState":
        state.saleState = Number(value as bigint);
        break;
      case "merkleRoot":
        state.merkleRoot = value === ZERO_BYTES32 ? undefined : (value as string);
        if (state.merkleRoot === undefined) delete state.source.merkleRoot;
        break;
      case "signer":
        state.signer = value === ZERO_ADDRESS ? undefined : (value as string);
        if (state.signer === undefined) delete state.source.signer;
        break;
      case "startTime":
        state.startTime = Number(value as bigint);
        break;
      case "endTime":
        state.endTime = Number(value as bigint);
        break;
    }
  }

  if (mints.length === 0) {
    notes.push(
      "None of this contract's functions match a mint shape this bot knows. " +
        "It can still be minted, but the ABI and the mint function have to be supplied -- " +
        "nothing here can infer them from the address."
    );
  }
  if (state.merkleRoot) {
    notes.push(
      "A Merkle root is set on-chain, so there is a list-gated stage. The proof itself is " +
        "published off-chain by the project -- the chain only holds the root."
    );
  }
  if (state.signer) {
    notes.push(
      `Mints are authorised by a signature from ${state.signer}. Only the project's server can ` +
        "issue one; it has to be requested, not derived."
    );
  }
  if (state.paused === true) {
    notes.push("The contract reports itself paused right now.");
  }

  return { address: addr, isContract: true, selectors, mints, state, notes };
}

/**
 * How many this wallet has already minted, where the contract will say.
 *
 * balanceOf is deliberately LAST in MINTED_COUNT_VIEWS and is the weakest
 * answer of the set: it counts tokens held, not tokens minted, so a wallet
 * that minted three and sold two reads as one. Where a contract exposes a real
 * mint counter that is used instead, and the caller is told which it got --
 * because "you have 1" and "you minted 1" bound a per-wallet cap differently.
 */
export async function readMintedCount(
  rpcUrl: string,
  address: string,
  wallet: string,
  selectors: Set<string>
): Promise<{ count: number; source: string } | null> {
  const provider = createProvider(rpcUrl);
  for (const signature of MINTED_COUNT_VIEWS) {
    const sel = selectorOf(signature);
    if (!selectors.has(sel)) continue;
    try {
      const iface = new Interface([`function ${signature} view returns (uint256)`]);
      const raw = await provider.call({
        to: getAddress(address),
        data: iface.encodeFunctionData(signature.slice(0, signature.indexOf("(")), [getAddress(wallet)]),
      });
      const value = decodeWord("number", raw);
      if (value === undefined) continue;
      return { count: Number(value as bigint), source: signature };
    } catch {
      continue;
    }
  }
  return null;
}

/** What the probe found, for a chat message or a dry run. */
export function describeProfile(p: ContractProfile, symbol = "ETH"): string {
  if (!p.isContract) return p.notes.join("\n");
  const lines: string[] = [];
  const s = p.state;

  lines.push(
    p.mints.length > 0
      ? `Mint entry points found: ${p.mints.map((m) => m.signature).join(", ")}`
      : "Mint entry point: not recognised"
  );

  const bits: string[] = [];
  if (s.priceWei !== undefined) {
    bits.push(s.priceWei === 0n ? "free" : `${Number(s.priceWei) / 1e18} ${symbol}`);
  }
  if (s.maxPerWallet !== undefined) bits.push(`max ${s.maxPerWallet}/wallet`);
  if (s.maxPerTransaction !== undefined) bits.push(`max ${s.maxPerTransaction}/tx`);
  if (s.totalSupply !== undefined && s.maxSupply !== undefined) {
    bits.push(`${s.totalSupply}/${s.maxSupply} minted`);
  }
  if (bits.length > 0) lines.push(bits.join(" · "));

  const flags: string[] = [];
  if (s.paused !== undefined) flags.push(s.paused ? "paused" : "not paused");
  if (s.saleActive !== undefined) flags.push(s.saleActive ? "public sale live" : "public sale closed");
  if (s.presaleActive !== undefined) flags.push(s.presaleActive ? "presale live" : "presale closed");
  if (s.saleState !== undefined) flags.push(`saleState=${s.saleState}`);
  if (flags.length > 0) lines.push(flags.join(" · "));

  if (s.startTime) lines.push(`Opens ${new Date(s.startTime * 1000).toISOString()} (from the contract)`);
  if (s.endTime) lines.push(`Ends ${new Date(s.endTime * 1000).toISOString()} (from the contract)`);

  lines.push(...p.notes);
  return lines.join("\n");
}
