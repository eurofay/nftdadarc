import { describe, it, expect } from "vitest";
import { concat, keccak256, Wallet } from "ethers";
import {
  allowListLeaf,
  foldProof,
  verifyProof,
  encodeMintAllowList,
  parseAllowListInput,
  MintParams,
} from "./seadrop-allowlist";

const PARAMS: MintParams = {
  mintPrice: 1_000_000_000_000_000n,
  maxTotalMintableByWallet: 3n,
  startTime: 1788065723n,
  endTime: 1805345723n,
  dropStageIndex: 1n,
  maxTokenSupplyForStage: 10_000n,
  feeBps: 1000n,
  restrictFeeRecipients: true,
};

const A = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80").address;
const B = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d").address;

/** Sorted-pair hash, the same rule solady's MerkleProofLib uses. */
const pair = (x: string, y: string) =>
  keccak256(concat(x.toLowerCase() <= y.toLowerCase() ? [x, y] : [y, x]));

describe("allowListLeaf", () => {
  it("is deterministic for the same wallet and terms", () => {
    expect(allowListLeaf(A, PARAMS)).toBe(allowListLeaf(A, PARAMS));
  });

  it("differs per wallet — one wallet's proof can't open another's spot", () => {
    expect(allowListLeaf(A, PARAMS)).not.toBe(allowListLeaf(B, PARAMS));
  });

  it("differs when the stage terms differ, which is why a stale proof fails", () => {
    expect(allowListLeaf(A, PARAMS)).not.toBe(allowListLeaf(A, { ...PARAMS, mintPrice: 1n }));
    expect(allowListLeaf(A, PARAMS)).not.toBe(allowListLeaf(A, { ...PARAMS, dropStageIndex: 2n }));
  });

  it("accepts a lowercase address, checksumming it the way the contract sees it", () => {
    expect(allowListLeaf(A.toLowerCase(), PARAMS)).toBe(allowListLeaf(A, PARAMS));
  });
});

describe("foldProof / verifyProof", () => {
  it("verifies a wallet against a real two-leaf tree", () => {
    const leafA = allowListLeaf(A, PARAMS);
    const leafB = allowListLeaf(B, PARAMS);
    const root = pair(leafA, leafB);

    expect(verifyProof(leafA, [leafB], root)).toBe(true);
    expect(verifyProof(leafB, [leafA], root)).toBe(true);
  });

  it("verifies through a four-leaf tree", () => {
    const leaves = [A, B].map((w) => allowListLeaf(w, PARAMS));
    const other1 = keccak256("0x01");
    const other2 = keccak256("0x02");
    const left = pair(leaves[0], leaves[1]);
    const right = pair(other1, other2);
    const root = pair(left, right);

    // A's proof: its sibling, then the whole right subtree.
    expect(verifyProof(leaves[0], [leaves[1], right], root)).toBe(true);
  });

  it("rejects a proof for the wrong wallet", () => {
    const leafA = allowListLeaf(A, PARAMS);
    const leafB = allowListLeaf(B, PARAMS);
    const root = pair(leafA, leafB);
    // B's leaf with a proof built for a tree it isn't in.
    expect(verifyProof(leafB, [keccak256("0xdead")], root)).toBe(false);
  });

  it("rejects an empty proof against a multi-leaf root", () => {
    const leafA = allowListLeaf(A, PARAMS);
    const root = pair(leafA, allowListLeaf(B, PARAMS));
    expect(verifyProof(leafA, [], root)).toBe(false);
  });

  it("sorts each pair, so proof order carries no left/right information", () => {
    const leaf = keccak256("0xaa");
    const sibling = keccak256("0xbb");
    expect(foldProof(leaf, [sibling])).toBe(pair(leaf, sibling));
    expect(foldProof(sibling, [leaf])).toBe(pair(leaf, sibling));
  });
});

describe("encodeMintAllowList", () => {
  it("targets SeaDrop and charges price x quantity", () => {
    const out = encodeMintAllowList(
      "0xBAEf8D7cA0E739812Cbe4A0b249A270D7D71E489",
      "0x0000a26b00c1F0DF003000390027140000fAa719",
      3,
      PARAMS,
      [keccak256("0x01")]
    );
    expect(out.to.toLowerCase()).toBe("0x00005ea00ac477b1030ce78506496e8c2de24bf5");
    expect(out.value).toBe(PARAMS.mintPrice * 3n);
    expect(out.data.startsWith("0x")).toBe(true);
  });

  it("produces different calldata for different quantities", () => {
    const mk = (q: number) =>
      encodeMintAllowList("0xBAEf8D7cA0E739812Cbe4A0b249A270D7D71E489", "0x0000a26b00c1F0DF003000390027140000fAa719", q, PARAMS, []).data;
    expect(mk(1)).not.toBe(mk(2));
  });
});

describe("parseAllowListInput", () => {
  const full = JSON.stringify({
    proof: [keccak256("0x01"), keccak256("0x02")],
    mintParams: {
      mintPrice: "1000000000000000",
      maxTotalMintableByWallet: 3,
      startTime: 1788065723,
      endTime: 1805345723,
      dropStageIndex: 1,
      maxTokenSupplyForStage: 10000,
      feeBps: 1000,
      restrictFeeRecipients: true,
    },
  });

  it("reads the shape projects publish", () => {
    const { params, proof } = parseAllowListInput(full);
    expect(proof).toHaveLength(2);
    expect(params.mintPrice).toBe(1_000_000_000_000_000n);
    expect(params.maxTotalMintableByWallet).toBe(3n);
  });

  it("accepts the alternative field spellings seen in the wild", () => {
    const { proof, params } = parseAllowListInput(
      JSON.stringify({
        merkleProof: [keccak256("0x01")],
        params: {
          price: 0,
          limit: 2,
          start: 1,
          end: 2,
          stageIndex: 0,
          maxSupplyForStage: 5,
          fee: 500,
        },
      })
    );
    expect(proof).toHaveLength(1);
    expect(params.maxTotalMintableByWallet).toBe(2n);
    expect(params.feeBps).toBe(500n);
  });

  it("refuses junk rather than building a doomed transaction", () => {
    expect(() => parseAllowListInput("nope")).toThrow(/valid JSON/);
    expect(() => parseAllowListInput("{}")).toThrow(/No proof array/);
    expect(() => parseAllowListInput(JSON.stringify({ proof: ["0xnothash"] }))).toThrow(/32-byte hash/);
    expect(() => parseAllowListInput(JSON.stringify({ proof: [keccak256("0x01")] }))).toThrow(/Missing mint param/);
  });
});
