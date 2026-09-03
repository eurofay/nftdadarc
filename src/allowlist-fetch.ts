// Fetching a project's allow list and computing your own proof.
//
// A proof is not a credential — it is a short path of hashes showing your
// address sits in a published list. Anyone holding the list can build one,
// which is why this needs nobody's permission and no private API.
//
// SeaDrop puts a pointer to that list on-chain: updateAllowList emits
// AllowListUpdated carrying an allowListURI. So the whole chain is derivable:
//
//   contract -> AllowListUpdated event -> allowListURI -> list -> your proof
//
// The result is self-checking. The tree built here must reproduce the root the
// contract already stores; when it doesn't, either the list has moved on or
// the leaf encoding is wrong, and saying so beats handing over a proof that
// reverts at the worst possible moment.

import { keccak256, concat, getAddress } from "ethers";
import { createProvider } from "./rpc-provider";
import { SEADROP_ADDRESS } from "./seadrop-public";
import { allowListLeaf, MintParams } from "./seadrop-allowlist";

/** keccak256("AllowListUpdated(address,bytes32,bytes32,string[],string)") */
export const ALLOWLIST_UPDATED_TOPIC =
  "0xefcd7e019bc8b47d27881fd59e2619280ca5894f285950f10ab049870652efa5";

const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

export function normalizeUri(uri: string): string {
  if (uri.startsWith("ipfs://")) {
    return IPFS_GATEWAY + uri.slice("ipfs://".length).replace(/^ipfs\//, "");
  }
  return uri;
}

/**
 * Pull allowListURI out of the event's non-indexed data.
 *
 * The payload is (string[] publicKeyURI, string allowListURI). Both are
 * dynamic, so the head holds two offsets and the bodies follow.
 */
export function decodeAllowListUri(data: string): string | null {
  try {
    const body = data.startsWith("0x") ? data.slice(2) : data;
    const word = (i: number) => body.slice(i * 64, (i + 1) * 64);
    // Second head word is the offset to allowListURI, in bytes from the start.
    const offset = parseInt(word(1), 16) * 2;
    if (!Number.isFinite(offset) || offset <= 0 || offset >= body.length) return null;
    const length = parseInt(body.slice(offset, offset + 64), 16);
    if (!Number.isFinite(length) || length === 0) return null;
    const hex = body.slice(offset + 64, offset + 64 + length * 2);
    const uri = Buffer.from(hex, "hex").toString("utf8");
    return uri.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The allowListURI from the most recent AllowListUpdated for this collection.
 *
 * Scanned newest-first: a list can be replaced, and only the latest one
 * matches the root the contract holds now.
 */
export async function findAllowListUri(
  rpcUrl: string,
  nftContract: string,
  opts: { chunkBlocks?: number; maxBlocks?: number } = {}
): Promise<{ uri: string; block: number } | null> {
  const provider = createProvider(rpcUrl);
  const chunk = opts.chunkBlocks ?? 10_000;
  const maxBlocks = opts.maxBlocks ?? 2_000_000;
  const head = await provider.getBlockNumber();
  const floor = Math.max(0, head - maxBlocks);

  const nftTopic = `0x${"0".repeat(24)}${getAddress(nftContract).slice(2).toLowerCase()}`;

  for (let to = head; to > floor; to -= chunk) {
    const from = Math.max(floor, to - chunk + 1);
    let logs;
    try {
      logs = await provider.getLogs({
        address: SEADROP_ADDRESS,
        topics: [ALLOWLIST_UPDATED_TOPIC, nftTopic],
        fromBlock: from,
        toBlock: to,
      });
    } catch {
      continue; // a chunk this endpoint refused; keep walking back
    }
    if (logs.length === 0) continue;

    const log = logs[logs.length - 1];
    const uri = decodeAllowListUri(log.data);
    if (uri) return { uri, block: log.blockNumber };
  }
  return null;
}

export interface AllowListEntry {
  minter: string;
  params: MintParams;
}

/**
 * Parse a published allow list.
 *
 * Formats vary — an array, or wrapped under a key, with the address field
 * spelled several ways. An unparseable row throws rather than being skipped:
 * a missing entry changes the root, and the failure would surface later as an
 * unexplained invalid proof.
 */
export function parseAllowList(json: string): AllowListEntry[] {
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("The published allow list isn't valid JSON.");
  }
  const rows: any[] = Array.isArray(raw)
    ? raw
    : raw.allowList ?? raw.entries ?? raw.leaves ?? raw.list;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Couldn't find a list of entries in the published allow list.");
  }

  return rows.map((row, i) => {
    const minter = row.minter ?? row.address ?? row.wallet ?? row.account;
    if (typeof minter !== "string") throw new Error(`Entry ${i} has no address.`);
    const p = row.mintParams ?? row.params ?? row;
    const num = (...names: string[]): bigint => {
      for (const n of names) {
        if (p[n] !== undefined && p[n] !== null) return BigInt(p[n]);
      }
      throw new Error(`Entry ${i} is missing ${names[0]}.`);
    };
    return {
      minter: getAddress(minter),
      params: {
        mintPrice: num("mintPrice", "price"),
        maxTotalMintableByWallet: num("maxTotalMintableByWallet", "maxMintable", "limit"),
        startTime: num("startTime", "start"),
        endTime: num("endTime", "end"),
        dropStageIndex: num("dropStageIndex", "stageIndex"),
        maxTokenSupplyForStage: num("maxTokenSupplyForStage", "maxSupplyForStage"),
        feeBps: num("feeBps", "fee"),
        restrictFeeRecipients: Boolean(p.restrictFeeRecipients ?? p.restrictFees ?? true),
      },
    };
  });
}

const hashPair = (a: string, b: string): string =>
  keccak256(concat(a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a]));

/**
 * Build the tree and return the root plus a proof for every leaf.
 *
 * Pairs are sorted before hashing, matching solady's MerkleProofLib, which is
 * what SeaDrop verifies against. An odd node is promoted unchanged.
 */
export function buildMerkleTree(leaves: string[]): { root: string; proofs: string[][] } {
  if (leaves.length === 0) throw new Error("An allow list with no entries has no root.");
  if (leaves.length === 1) return { root: leaves[0], proofs: [[]] };

  const proofs: string[][] = leaves.map(() => []);
  let indices: number[][] = leaves.map((_, i) => [i]);
  let level = [...leaves];

  while (level.length > 1) {
    const next: string[] = [];
    const nextIndices: number[][] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        next.push(level[i]);
        nextIndices.push(indices[i]);
        continue;
      }
      // Every original leaf under the left node gains the right node as a
      // sibling, and vice versa — that is exactly what a proof is.
      for (const original of indices[i]) proofs[original].push(level[i + 1]);
      for (const original of indices[i + 1]) proofs[original].push(level[i]);
      next.push(hashPair(level[i], level[i + 1]));
      nextIndices.push([...indices[i], ...indices[i + 1]]);
    }
    level = next;
    indices = nextIndices;
  }
  return { root: level[0], proofs };
}

export interface DerivedProof {
  proof: string[];
  params: MintParams;
  computedRoot: string;
  matchesChain: boolean;
}

/**
 * The proof for one wallet, checked against the root the contract holds.
 *
 * matchesChain is the safety net. If the tree doesn't reproduce the on-chain
 * root then the proof would revert, and it is far better to say so than to
 * spend gas discovering it during a race.
 */
export function deriveProof(
  entries: AllowListEntry[],
  wallet: string,
  onChainRoot: string
): DerivedProof | null {
  const target = getAddress(wallet);
  const leaves = entries.map((e) => allowListLeaf(e.minter, e.params));
  const { root, proofs } = buildMerkleTree(leaves);

  const index = entries.findIndex((e) => e.minter === target);
  if (index === -1) return null;

  return {
    proof: proofs[index],
    params: entries[index].params,
    computedRoot: root,
    matchesChain: root.toLowerCase() === onChainRoot.toLowerCase(),
  };
}

/** Fetch a published list, following ipfs:// through a public gateway. */
export async function fetchAllowList(uri: string, timeoutMs = 15_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(normalizeUri(uri), { signal: controller.signal });
    if (!res.ok) throw new Error(`the list URI returned HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
