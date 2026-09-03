import { describe, it, expect } from "vitest";
import { AbiCoder, concat, keccak256, Wallet } from "ethers";
import {
  buildMerkleTree,
  deriveProof,
  decodeAllowListUri,
  normalizeUri,
  parseAllowList,
  AllowListEntry,
} from "./allowlist-fetch";
import { allowListLeaf, verifyProof, MintParams } from "./seadrop-allowlist";

const PARAMS: MintParams = {
  mintPrice: 0n,
  maxTotalMintableByWallet: 2n,
  startTime: 1788065723n,
  endTime: 1805345723n,
  dropStageIndex: 1n,
  maxTokenSupplyForStage: 10_000n,
  feeBps: 1000n,
  restrictFeeRecipients: true,
};

const wallets = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
].map((k) => new Wallet(k).address);

const entries: AllowListEntry[] = wallets.map((minter) => ({ minter, params: PARAMS }));

describe("buildMerkleTree", () => {
  it("produces a proof that verifies for every leaf", () => {
    const leaves = entries.map((e) => allowListLeaf(e.minter, e.params));
    const { root, proofs } = buildMerkleTree(leaves);
    // Five leaves exercises the odd-node promotion at two levels.
    leaves.forEach((leaf, i) => {
      expect(verifyProof(leaf, proofs[i], root)).toBe(true);
    });
  });

  it("gives a single-entry list an empty proof and itself as root", () => {
    const leaf = allowListLeaf(wallets[0], PARAMS);
    const { root, proofs } = buildMerkleTree([leaf]);
    expect(root).toBe(leaf);
    expect(proofs[0]).toEqual([]);
    expect(verifyProof(leaf, [], root)).toBe(true);
  });

  it("handles an even list too", () => {
    const leaves = entries.slice(0, 4).map((e) => allowListLeaf(e.minter, e.params));
    const { root, proofs } = buildMerkleTree(leaves);
    leaves.forEach((leaf, i) => expect(verifyProof(leaf, proofs[i], root)).toBe(true));
  });

  it("refuses an empty list rather than inventing a root", () => {
    expect(() => buildMerkleTree([])).toThrow(/no entries/);
  });

  it("changes root when any entry changes — a stale list can't pass", () => {
    const a = buildMerkleTree(entries.map((e) => allowListLeaf(e.minter, e.params))).root;
    const changed = [...entries];
    changed[2] = { ...changed[2], params: { ...PARAMS, maxTotalMintableByWallet: 5n } };
    const b = buildMerkleTree(changed.map((e) => allowListLeaf(e.minter, e.params))).root;
    expect(a).not.toBe(b);
  });
});

describe("deriveProof", () => {
  it("finds a wallet's proof and confirms it against the on-chain root", () => {
    const root = buildMerkleTree(entries.map((e) => allowListLeaf(e.minter, e.params))).root;
    const derived = deriveProof(entries, wallets[3], root);
    expect(derived).not.toBeNull();
    expect(derived!.matchesChain).toBe(true);
    expect(verifyProof(allowListLeaf(wallets[3], PARAMS), derived!.proof, root)).toBe(true);
  });

  it("returns null for a wallet that isn't on the list", () => {
    const root = buildMerkleTree(entries.map((e) => allowListLeaf(e.minter, e.params))).root;
    const stranger = new Wallet("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba").address;
    expect(deriveProof(entries, stranger, root)).toBeNull();
  });

  it("flags a mismatch instead of returning a proof that would revert", () => {
    // The list moved on, or the leaf encoding is wrong. Either way the proof
    // is worthless and the caller must not spend gas on it.
    const derived = deriveProof(entries, wallets[0], keccak256("0xdeadbeef"));
    expect(derived).not.toBeNull();
    expect(derived!.matchesChain).toBe(false);
  });

  it("matches on a lowercase address", () => {
    const root = buildMerkleTree(entries.map((e) => allowListLeaf(e.minter, e.params))).root;
    expect(deriveProof(entries, wallets[1].toLowerCase(), root)).not.toBeNull();
  });
});

describe("decodeAllowListUri", () => {
  it("reads the URI out of a real event payload", () => {
    // (string[] publicKeyURI, string allowListURI) — exactly what SeaDrop emits.
    const data = AbiCoder.defaultAbiCoder().encode(
      ["string[]", "string"],
      [["https://keys.example/pk"], "ipfs://bafyExampleCid/allowlist.json"]
    );
    expect(decodeAllowListUri(data)).toBe("ipfs://bafyExampleCid/allowlist.json");
  });

  it("reads it when the publicKeyURI array is empty", () => {
    const data = AbiCoder.defaultAbiCoder().encode(["string[]", "string"], [[], "https://x.example/l.json"]);
    expect(decodeAllowListUri(data)).toBe("https://x.example/l.json");
  });

  it("returns null when the URI is empty, rather than an empty string", () => {
    const data = AbiCoder.defaultAbiCoder().encode(["string[]", "string"], [[], ""]);
    expect(decodeAllowListUri(data)).toBeNull();
  });

  it("survives malformed data", () => {
    expect(decodeAllowListUri("0x")).toBeNull();
    expect(decodeAllowListUri("0xdeadbeef")).toBeNull();
  });
});

describe("normalizeUri", () => {
  it("routes ipfs:// through a gateway, since fetch can't speak it", () => {
    expect(normalizeUri("ipfs://bafyCid/list.json")).toBe("https://ipfs.io/ipfs/bafyCid/list.json");
    expect(normalizeUri("ipfs://ipfs/bafyCid")).toBe("https://ipfs.io/ipfs/bafyCid");
  });

  it("leaves http(s) alone", () => {
    expect(normalizeUri("https://x.example/l.json")).toBe("https://x.example/l.json");
  });
});

describe("parseAllowList", () => {
  const row = (address: string) => ({
    address,
    mintParams: {
      mintPrice: "0",
      maxTotalMintableByWallet: 2,
      startTime: 1788065723,
      endTime: 1805345723,
      dropStageIndex: 1,
      maxTokenSupplyForStage: 10000,
      feeBps: 1000,
      restrictFeeRecipients: true,
    },
  });

  it("reads a bare array", () => {
    const out = parseAllowList(JSON.stringify(wallets.map(row)));
    expect(out).toHaveLength(5);
    expect(out[0].params.maxTotalMintableByWallet).toBe(2n);
  });

  it("reads a wrapped list", () => {
    expect(parseAllowList(JSON.stringify({ allowList: wallets.map(row) }))).toHaveLength(5);
  });

  it("throws on a row it can't read, rather than dropping it", () => {
    // A skipped entry changes the root, and the failure would surface much
    // later as an unexplained invalid proof.
    const rows: any[] = wallets.map(row);
    delete rows[2].address;
    expect(() => parseAllowList(JSON.stringify(rows))).toThrow(/Entry 2 has no address/);
  });

  it("names the missing field when params are incomplete", () => {
    const rows: any[] = wallets.map(row);
    delete rows[1].mintParams.feeBps;
    expect(() => parseAllowList(JSON.stringify(rows))).toThrow(/missing feeBps/);
  });

  it("rejects junk", () => {
    expect(() => parseAllowList("nope")).toThrow(/valid JSON/);
    expect(() => parseAllowList("{}")).toThrow(/Couldn't find a list/);
  });
});
