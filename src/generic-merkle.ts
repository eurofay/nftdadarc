// Working out how a project built its allow-list tree, by checking against the
// root it already published on-chain.
//
// THE PROBLEM. SeaDrop fixes the leaf encoding: keccak256(abi.encode(minter,
// mintParams)), documented, one shape, done (seadrop-allowlist.ts). A project
// rolling its own picks whatever its script happened to do. The common ones:
//
//   keccak256(abi.encodePacked(address))                 -- by far the most common
//   keccak256(abi.encode(address))                       -- padded to 32 bytes
//   keccak256(abi.encodePacked(address, uint256))        -- address + allowance
//   keccak256(abi.encode(address, uint256))
//   keccak256(bytes.concat(keccak256(abi.encode(...))))  -- OpenZeppelin's
//                                                           StandardMerkleTree
//
// and there is no way to ask a contract which one it used. `merkleRoot()`
// returns 32 bytes with no provenance.
//
// WHY GUESSING IS SAFE HERE, WHEN IT IS NOT SAFE ANYWHERE ELSE IN THIS REPO.
// The answer is checkable. A candidate encoding either reproduces the exact
// root the contract is holding or it does not, and a 32-byte collision does
// not happen by accident. So this is not a guess that gets discovered at fire
// time -- it is a search with an exact oracle, run before anything is signed.
// An encoding that fails to reproduce the root is discarded; if none of them
// reproduce it, that is reported as "this list does not match this contract"
// rather than a proof that would revert.
//
// The pair-hashing above the leaves is sorted, which is what both
// OpenZeppelin's MerkleProof and solady's MerkleProofLib verify against, and
// therefore what essentially every NFT allow list uses.

import { AbiCoder, concat, getAddress, keccak256, solidityPackedKeccak256 } from "ethers";
import { buildMerkleTree } from "./allowlist-fetch";

const CODER = AbiCoder.defaultAbiCoder();

/** One row of a project's published list. */
export interface GenericAllowEntry {
  address: string;
  /** Per-wallet allowance, where the list carries one. */
  allowance?: bigint;
}

export interface LeafEncoding {
  name: string;
  /** Whether this encoding folds the allowance into the leaf. */
  usesAllowance: boolean;
  encode: (entry: GenericAllowEntry) => string;
}

/**
 * Leaf encodings seen on real allow lists, cheapest and most common first.
 *
 * Ordered by how often they turn up rather than alphabetically, because the
 * search below stops at the first that reproduces the root and each candidate
 * costs a full tree build over the whole list.
 */
export const LEAF_ENCODINGS: readonly LeafEncoding[] = Object.freeze([
  {
    name: "keccak256(abi.encodePacked(address))",
    usesAllowance: false,
    encode: (e) => solidityPackedKeccak256(["address"], [getAddress(e.address)]),
  },
  {
    name: "keccak256(abi.encode(address))",
    usesAllowance: false,
    encode: (e) => keccak256(CODER.encode(["address"], [getAddress(e.address)])),
  },
  {
    name: "keccak256(abi.encodePacked(address, uint256))",
    usesAllowance: true,
    encode: (e) =>
      solidityPackedKeccak256(["address", "uint256"], [getAddress(e.address), e.allowance ?? 0n]),
  },
  {
    name: "keccak256(abi.encode(address, uint256))",
    usesAllowance: true,
    encode: (e) => keccak256(CODER.encode(["address", "uint256"], [getAddress(e.address), e.allowance ?? 0n])),
  },
  {
    // OpenZeppelin's StandardMerkleTree hashes twice, specifically so a leaf
    // can never be confused with an internal node of the same tree.
    name: "OpenZeppelin StandardMerkleTree (address)",
    usesAllowance: false,
    encode: (e) => keccak256(keccak256(CODER.encode(["address"], [getAddress(e.address)]))),
  },
  {
    name: "OpenZeppelin StandardMerkleTree (address, uint256)",
    usesAllowance: true,
    encode: (e) =>
      keccak256(keccak256(CODER.encode(["address", "uint256"], [getAddress(e.address), e.allowance ?? 0n]))),
  },
]);

export interface SolvedList {
  encoding: LeafEncoding;
  root: string;
  /** Proof per lowercased address. */
  proofs: Map<string, string[]>;
  /** Allowance per lowercased address, where the list carried one. */
  allowances: Map<string, bigint>;
  entries: number;
}

/**
 * Find the encoding that reproduces this contract's root, and return every
 * proof under it.
 *
 * Returns null when no candidate matches, which means one of: the list is for
 * a different contract, it has been replaced since it was published, or the
 * project used an encoding not listed above. All three are worth saying out
 * loud, and none of them are worth sending a transaction for.
 *
 * Cost is one tree build per candidate over the whole list. A 10,000-entry
 * list builds in well under a second, and the search stops at the first match
 * -- which for most projects is the first candidate.
 */
export function solveAllowList(
  entries: readonly GenericAllowEntry[],
  onChainRoot: string
): SolvedList | null {
  if (entries.length === 0) return null;
  const target = onChainRoot.toLowerCase();

  // An encoding that folds in an allowance cannot be distinguished from one
  // that does not when the list carries no allowances -- both would hash the
  // same rows differently but neither is more likely, so both are tried.
  for (const encoding of LEAF_ENCODINGS) {
    let leaves: string[];
    try {
      leaves = entries.map((e) => encoding.encode(e));
    } catch {
      // A malformed address in the list breaks this encoding but not
      // necessarily the next one.
      continue;
    }
    const { root, proofs } = buildMerkleTree(leaves);
    if (root.toLowerCase() !== target) continue;

    return {
      encoding,
      root,
      proofs: new Map(entries.map((e, i) => [e.address.toLowerCase(), proofs[i]])),
      allowances: new Map(
        entries
          .filter((e) => e.allowance !== undefined)
          .map((e) => [e.address.toLowerCase(), e.allowance!])
      ),
      entries: entries.length,
    };
  }
  return null;
}

/** Fold a proof to a root, sorting each pair -- what both standard libraries do. */
export function foldSorted(leaf: string, proof: readonly string[]): string {
  let computed = leaf;
  for (const sibling of proof) {
    const [a, b] =
      computed.toLowerCase() <= sibling.toLowerCase() ? [computed, sibling] : [sibling, computed];
    computed = keccak256(concat([a, b]));
  }
  return computed;
}

/**
 * Parse a published allow list into rows.
 *
 * Formats vary more here than on SeaDrop, because there is no standard to
 * vary from: a bare array of addresses, an array of objects, an object keyed
 * by address. All three turn up, so all three are read.
 *
 * A row that cannot be read throws rather than being skipped. A missing entry
 * changes every hash above it in the tree, so a silently dropped row produces
 * a root that matches nothing -- and the failure would surface much later as
 * an unexplained "your list does not match this contract".
 */
export function parseGenericAllowList(json: string): GenericAllowEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("That allow list isn't valid JSON.");
  }

  const asEntry = (row: unknown, i: number): GenericAllowEntry => {
    if (typeof row === "string") return { address: getAddress(row.trim()) };
    if (row && typeof row === "object") {
      const r = row as Record<string, unknown>;
      const addr = r.address ?? r.minter ?? r.wallet ?? r.account ?? r.addr;
      if (typeof addr !== "string") throw new Error(`Entry ${i} has no address.`);
      const raw =
        r.allowance ?? r.maxMint ?? r.quantity ?? r.amount ?? r.limit ?? r.maxAmount ?? r.maxQuantity;
      return {
        address: getAddress(addr.trim()),
        allowance: raw === undefined || raw === null ? undefined : BigInt(raw as never),
      };
    }
    throw new Error(`Entry ${i} is neither an address nor an object.`);
  };

  if (Array.isArray(raw)) return raw.map(asEntry);

  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const nested = o.allowList ?? o.allowlist ?? o.entries ?? o.list ?? o.addresses ?? o.wallets;
    if (Array.isArray(nested)) return nested.map(asEntry);

    // An object keyed by address, whose values are allowances. Distinguished
    // from a wrapper object by every key looking like an address.
    const keys = Object.keys(o);
    if (keys.length > 0 && keys.every((k) => /^0x[0-9a-fA-F]{40}$/.test(k.trim()))) {
      return keys.map((k) => {
        const v = o[k];
        return {
          address: getAddress(k.trim()),
          allowance:
            typeof v === "number" || typeof v === "string" ? BigInt(v as never) : undefined,
        };
      });
    }
  }

  throw new Error("Couldn't find a list of addresses in that allow list.");
}
