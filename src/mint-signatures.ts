// What an arbitrary NFT contract's mint function looks like, and how to find
// out which one it has.
//
// THE PROBLEM. Everything else in this repo assumes SeaDrop: one singleton at
// a known address, four known entry points, drop terms readable from a known
// getter. A project that deployed its own contract shares none of that. Its
// mint might be `mint(uint256)`, `allowlistMint(uint256,bytes32[])`,
// `claim(address,uint256,address,uint256,(bytes32[],uint256,uint256,address),bytes)`,
// or something nobody has seen before, and the address alone does not say.
//
// WHAT CAN AND CANNOT BE INFERRED. A deployed contract's runtime bytecode
// contains its dispatcher, and a Solidity dispatcher compares the incoming
// selector against a PUSH4 immediate for every external function it has. So
// the SET OF SELECTORS is recoverable from the chain -- see
// selectorsFromBytecode below. What is NOT recoverable is what those
// selectors MEAN: a selector is a truncated hash, and hashes do not invert.
//
// So this file is a dictionary, not an oracle. It maps selectors this repo can
// name back to signatures it knows how to fill in. A contract whose mint is
// not in here is not a failure to detect -- it is a contract whose ABI has to
// be supplied, and saying so plainly is the only honest answer. See
// `autofillable` below, which is the line between the two.
//
// NOTHING HERE GUESSES. A match means "this contract has a function whose
// selector equals the selector of this signature". That is evidence, not
// proof: two different signatures can collide in four bytes. Which is why
// every candidate this produces is confirmed by simulation (mint-simulate.ts)
// before anything is signed.

import { id } from "ethers";

/**
 * What one argument of a mint function is FOR.
 *
 * This is the whole reason the dictionary exists. Knowing a contract has
 * `allowlistMint(uint256,bytes32[])` is useless without knowing that the
 * uint256 is a quantity and the bytes32[] is a Merkle proof -- with that, the
 * call can be built from things the bot legitimately holds.
 */
export type MintArgKind =
  /** How many to mint. Filled from the operator's requested quantity. */
  | "quantity"
  /** Who receives them. Filled with the minting wallet's own address. */
  | "minter"
  /** A Merkle proof. Filled from the project's published list. */
  | "proof"
  /** A server-issued signature. Filled from the project's authorisation API. */
  | "signature"
  /** This wallet's allowance, as carried by its allow-list entry. */
  | "allowance"
  /** Price per token, where the call takes it explicitly. */
  | "price"
  /** Currency address, for contracts that accept ERC20 as well as native. */
  | "currency"
  /** A nonce or expiry carried alongside a signature. */
  | "nonce"
  /** A token id, for editions and ERC1155-shaped mints. */
  | "tokenId"
  /** Trailing bytes most contracts want empty. */
  | "empty"
  /**
   * Recognised but not derivable -- an instance id, a phase index, a
   * merkle-root selector. The operator has to supply it, and the bot says so
   * rather than putting a zero in and hoping.
   */
  | "operator";

export type MintKind = "public" | "merkle" | "signed" | "token-gated" | "custom";

export interface MintSignature {
  /** Canonical solidity signature, as hashed for the selector. */
  signature: string;
  /** 0x-prefixed 4 bytes. */
  selector: string;
  kind: MintKind;
  /** One entry per top-level argument, in order. */
  args: MintArgKind[];
  /**
   * Whether every argument can be filled from what the bot legitimately has:
   * the quantity, the minter's own address, a proof derived from a published
   * list, a signature issued to that wallet by the project.
   *
   * False means the signature is RECOGNISED but not automatically callable --
   * there is an argument only the operator knows. That is reported as a
   * missing input, never filled with a default.
   */
  autofillable: boolean;
  /** Which project or standard this shape comes from. */
  family: string;
  /** Whether the call is expected to carry value. Informational. */
  payable: boolean;
}

const sig = (
  signature: string,
  kind: MintKind,
  args: MintArgKind[],
  family: string,
  opts: { payable?: boolean } = {}
): MintSignature => ({
  signature,
  selector: id(signature).slice(0, 10),
  kind,
  args,
  // An argument nobody can derive makes the whole call un-fillable, however
  // well the rest of it is understood.
  autofillable: !args.includes("operator"),
  family,
  payable: opts.payable ?? true,
});

/**
 * Mint entry points seen in the wild, most specific first.
 *
 * Order matters when a contract matches several: a contract exposing both
 * `mint(uint256)` and `allowlistMint(uint256,bytes32[])` has a gated stage
 * AND a public one, and the gated one is almost always the reason for being
 * there -- same reasoning as mint-resolve.ts's stage ordering.
 *
 * Argument ORDER varies between projects for the same idea, which is why the
 * same concept appears more than once. `whitelistMint(uint256,bytes32[])` and
 * `whitelistMint(bytes32[],uint256)` are different functions with different
 * selectors, and filling one as if it were the other produces a call that
 * reverts on a decode error.
 */
export const KNOWN_MINTS: readonly MintSignature[] = Object.freeze([
  // ── Merkle-gated ────────────────────────────────────────────────────────
  sig("allowlistMint(uint256,bytes32[])", "merkle", ["quantity", "proof"], "common ERC721A"),
  sig("allowlistMint(bytes32[],uint256)", "merkle", ["proof", "quantity"], "common ERC721A"),
  sig("whitelistMint(uint256,bytes32[])", "merkle", ["quantity", "proof"], "common ERC721A"),
  sig("whitelistMint(bytes32[],uint256)", "merkle", ["proof", "quantity"], "common ERC721A"),
  sig("presaleMint(uint256,bytes32[])", "merkle", ["quantity", "proof"], "common ERC721A"),
  sig("presaleMint(bytes32[],uint256)", "merkle", ["proof", "quantity"], "common ERC721A"),
  sig("mintAllowList(uint256,bytes32[])", "merkle", ["quantity", "proof"], "common ERC721A"),
  sig("mintWhitelist(uint256,bytes32[])", "merkle", ["quantity", "proof"], "common ERC721A"),
  sig("claim(uint256,bytes32[])", "merkle", ["quantity", "proof"], "common"),
  sig("mint(uint256,bytes32[])", "merkle", ["quantity", "proof"], "common"),
  // The three-argument form carries the wallet's own allowance, because the
  // allowance is part of the leaf -- the contract cannot take the caller's
  // word for it, so the list has to supply it and the proof has to cover it.
  sig(
    "allowlistMint(uint256,uint256,bytes32[])",
    "merkle",
    ["quantity", "allowance", "proof"],
    "common ERC721A"
  ),
  sig(
    "whitelistMint(uint256,uint256,bytes32[])",
    "merkle",
    ["quantity", "allowance", "proof"],
    "common ERC721A"
  ),
  sig(
    "presaleMint(uint256,uint256,bytes32[])",
    "merkle",
    ["quantity", "allowance", "proof"],
    "common ERC721A"
  ),
  sig(
    "mintAllowList(address,uint256,uint256,bytes32[])",
    "merkle",
    ["minter", "quantity", "allowance", "proof"],
    "common"
  ),

  // ── Server-signed ───────────────────────────────────────────────────────
  sig("mintSigned(uint256,bytes)", "signed", ["quantity", "signature"], "common"),
  sig("whitelistMint(uint256,bytes)", "signed", ["quantity", "signature"], "common"),
  sig("presaleMint(uint256,bytes)", "signed", ["quantity", "signature"], "common"),
  sig("mint(uint256,bytes)", "signed", ["quantity", "signature"], "common"),
  sig("signatureMint(uint256,bytes)", "signed", ["quantity", "signature"], "common"),
  // A nonce or deadline alongside the signature. Both come from the issuer
  // with the signature and are passed through untouched -- altering either
  // invalidates the signature that covers it.
  sig("mint(uint256,uint256,bytes)", "signed", ["quantity", "nonce", "signature"], "common"),
  sig("mint(address,uint256,uint256,bytes)", "signed", ["minter", "quantity", "nonce", "signature"], "common"),
  sig(
    "whitelistMint(uint256,uint256,bytes)",
    "signed",
    ["quantity", "nonce", "signature"],
    "common"
  ),

  // ── Public ──────────────────────────────────────────────────────────────
  sig("mint(uint256)", "public", ["quantity"], "ERC721A"),
  sig("mint(address,uint256)", "public", ["minter", "quantity"], "ERC721A"),
  sig("publicMint(uint256)", "public", ["quantity"], "common"),
  sig("publicMint(address,uint256)", "public", ["minter", "quantity"], "common"),
  sig("mintPublic(uint256)", "public", ["quantity"], "common"),
  sig("purchase(uint256)", "public", ["quantity"], "common"),
  sig("claim(uint256)", "public", ["quantity"], "common"),
  sig("mintTo(address,uint256)", "public", ["minter", "quantity"], "common"),
  // No argument at all: one per call, and a quantity above 1 means sending
  // the transaction that many times rather than passing a number.
  sig("mint()", "public", [], "common"),

  // ── thirdweb Drop ───────────────────────────────────────────────────────
  //
  // One entry point serves every phase: the active phase decides whether a
  // proof is required, and an empty AllowlistProof means "claim from the open
  // phase". The struct's quantityLimitPerWallet/pricePerToken/currency must
  // match the values the phase was configured with, which is why they come
  // from the project's claim-condition data rather than being invented.
  sig(
    "claim(address,uint256,address,uint256,(bytes32[],uint256,uint256,address),bytes)",
    "custom",
    ["minter", "quantity", "currency", "price", "proof", "empty"],
    "thirdweb Drop"
  ),

  // ── Manifold lazy claim ─────────────────────────────────────────────────
  //
  // Called on Manifold's shared extension contract, not on the collection, and
  // keyed by an instanceId that only the project's claim page knows. Listed so
  // it is NAMED rather than reported as unknown -- but the instance id is not
  // derivable, so it is not autofillable and the operator is told exactly what
  // is missing.
  sig(
    "mint(address,uint256,uint32,bytes32[],address)",
    "merkle",
    ["operator", "operator", "operator", "proof", "minter"],
    "Manifold LazyPayableClaim"
  ),
]);

const BY_SELECTOR = new Map<string, MintSignature[]>();
for (const m of KNOWN_MINTS) {
  const list = BY_SELECTOR.get(m.selector) ?? [];
  list.push(m);
  BY_SELECTOR.set(m.selector, list);
}

/** Every known signature sharing this selector. Usually one; never assumed to be. */
export function mintsForSelector(selector: string): MintSignature[] {
  return BY_SELECTOR.get(selector.toLowerCase()) ?? [];
}

/** The selector for an arbitrary signature, for callers supplying their own ABI. */
export const selectorOf = (signature: string): string => id(signature).slice(0, 10);

/**
 * Every 4-byte PUSH immediate in a contract's runtime bytecode.
 *
 * WHY THIS WORKS. Solidity's dispatcher compares the incoming call's selector
 * against each external function's selector, and those comparisons compile to
 * `PUSH4 <selector> EQ ... JUMPI`. So every externally callable function
 * leaves its selector in the code as a PUSH4 immediate.
 *
 * WHY IT MUST DISASSEMBLE RATHER THAN GREP. A naive scan for the byte 0x63
 * also finds it inside the payload of other PUSH instructions and inside
 * constants -- 0x63 is just the character 'c', so any string literal with a
 * 'c' in it produces a phantom selector. Walking the opcodes and skipping
 * each PUSH's payload is the difference between a usable candidate list and
 * noise.
 *
 * WHAT IT RETURNS IS A SUPERSET. Four-byte constants that are not selectors
 * still appear, and a contract using a jump table or assembly dispatcher may
 * expose fewer. That is fine: this feeds a dictionary lookup, and a phantom
 * that happens to equal a known mint selector is caught by simulation before
 * anything is signed.
 */
export function selectorsFromBytecode(bytecode: string): Set<string> {
  const out = new Set<string>();
  const hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  if (hex.length < 8) return out;

  const bytes = hex.length % 2 === 0 ? hex : hex.slice(0, -1);
  for (let i = 0; i + 1 < bytes.length; ) {
    const op = parseInt(bytes.slice(i, i + 2), 16);
    i += 2;
    if (!Number.isFinite(op)) break;
    // PUSH1 (0x60) through PUSH32 (0x7f) carry their payload inline.
    if (op >= 0x60 && op <= 0x7f) {
      const width = op - 0x5f;
      if (width === 4) {
        const imm = bytes.slice(i, i + 8);
        if (imm.length === 8) out.add(`0x${imm.toLowerCase()}`);
      }
      i += width * 2;
      continue;
    }
    // Everything else is a single byte; the loop's own increment covers it.
  }
  return out;
}

/**
 * Which known mint entry points a contract's bytecode exposes.
 *
 * Sorted so a gated stage outranks a public one, matching the reasoning in
 * mint-resolve.ts: a collection with both almost always has the gated stage as
 * the reason for being there, and minting the public one instead means paying
 * the public price in the public race.
 */
export function detectMints(bytecode: string): MintSignature[] {
  const selectors = selectorsFromBytecode(bytecode);
  const rank: Record<MintKind, number> = {
    merkle: 0,
    signed: 1,
    "token-gated": 2,
    custom: 3,
    public: 4,
  };
  return KNOWN_MINTS.filter((m) => selectors.has(m.selector)).sort(
    (a, b) => rank[a.kind] - rank[b.kind] || a.args.length - b.args.length
  );
}

/**
 * Read-only getters worth trying on an unknown contract.
 *
 * Each is a no-argument view returning one word, so the return only has to be
 * classified -- number, flag, address, hash -- not decoded against an exact
 * width. That matters because the same idea is spelled `uint256 price` on one
 * contract and `uint64 price` on the next, and both come back as one 32-byte
 * word. Insisting on the exact declared type would reject half of them for no
 * gain.
 *
 * Names are grouped by what they MEAN, so the probe can report "price: 0.02"
 * without caring which of six spellings this project chose.
 */
export type ViewKind = "number" | "bool" | "address" | "bytes32";

export interface KnownView {
  signature: string;
  selector: string;
  /** What a value found here means, in this repo's vocabulary. */
  field: ViewField;
  returns: ViewKind;
}

export type ViewField =
  | "totalSupply"
  | "maxSupply"
  | "price"
  | "maxPerWallet"
  | "maxPerTransaction"
  | "paused"
  | "saleActive"
  | "presaleActive"
  | "saleState"
  | "merkleRoot"
  | "signer"
  | "startTime"
  | "endTime";

const view = (signature: string, field: ViewField, returns: ViewKind): KnownView => ({
  signature,
  selector: id(signature).slice(0, 10),
  field,
  returns,
});

/**
 * The getters probed on an unknown contract, in preference order per field.
 *
 * First one that answers wins, so the more specific spelling is listed before
 * the generic one: `publicSaleStartTime()` before `startTime()`, because a
 * contract with both means something narrower by the first.
 */
export const KNOWN_VIEWS: readonly KnownView[] = Object.freeze([
  view("totalSupply()", "totalSupply", "number"),
  view("maxSupply()", "maxSupply", "number"),
  view("MAX_SUPPLY()", "maxSupply", "number"),
  view("collectionSize()", "maxSupply", "number"),
  view("maxTotalSupply()", "maxSupply", "number"),

  view("mintPrice()", "price", "number"),
  view("price()", "price", "number"),
  view("cost()", "price", "number"),
  view("MINT_PRICE()", "price", "number"),
  view("publicPrice()", "price", "number"),
  view("getPrice()", "price", "number"),
  view("PRICE()", "price", "number"),

  view("maxPerWallet()", "maxPerWallet", "number"),
  view("maxMintsPerWallet()", "maxPerWallet", "number"),
  view("maxPerAddress()", "maxPerWallet", "number"),
  view("MAX_PER_WALLET()", "maxPerWallet", "number"),
  view("maxMintAmount()", "maxPerWallet", "number"),
  view("maxPerTx()", "maxPerTransaction", "number"),
  view("maxMintPerTx()", "maxPerTransaction", "number"),

  view("paused()", "paused", "bool"),
  view("saleIsActive()", "saleActive", "bool"),
  view("saleActive()", "saleActive", "bool"),
  view("publicSaleActive()", "saleActive", "bool"),
  view("isPublicSaleActive()", "saleActive", "bool"),
  view("mintingActive()", "saleActive", "bool"),
  view("presaleActive()", "presaleActive", "bool"),
  view("isPresaleActive()", "presaleActive", "bool"),
  view("allowlistActive()", "presaleActive", "bool"),

  // An enum phase, where 0 is conventionally "closed". Read as a number
  // because the meaning of each value is the project's own and cannot be
  // inferred -- reported, not interpreted.
  view("saleState()", "saleState", "number"),
  view("phase()", "saleState", "number"),
  view("currentPhase()", "saleState", "number"),
  view("stage()", "saleState", "number"),

  view("merkleRoot()", "merkleRoot", "bytes32"),
  view("allowlistMerkleRoot()", "merkleRoot", "bytes32"),
  view("whitelistMerkleRoot()", "merkleRoot", "bytes32"),
  view("presaleMerkleRoot()", "merkleRoot", "bytes32"),
  view("root()", "merkleRoot", "bytes32"),

  view("signer()", "signer", "address"),
  view("signerAddress()", "signer", "address"),
  view("mintSigner()", "signer", "address"),

  view("publicSaleStartTime()", "startTime", "number"),
  view("saleStartTime()", "startTime", "number"),
  view("publicSaleStart()", "startTime", "number"),
  view("startTime()", "startTime", "number"),
  view("mintStartTime()", "startTime", "number"),
  view("publicSaleEndTime()", "endTime", "number"),
  view("saleEndTime()", "endTime", "number"),
  view("endTime()", "endTime", "number"),
]);

/** Per-wallet counters, which take an address and so are probed separately. */
export const MINTED_COUNT_VIEWS: readonly string[] = Object.freeze([
  "numberMinted(address)",
  "mintedCount(address)",
  "minted(address)",
  "_numberMinted(address)",
  "balanceOf(address)",
]);
