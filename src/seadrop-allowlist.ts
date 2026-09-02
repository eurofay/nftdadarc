// Minting a Merkle allow-list stage.
//
// The distinction that matters, because the two look identical on a drop page:
//
//   Merkle allow list  — the contract holds a ROOT. Minting needs a PROOF,
//                        which is a list of hashes. A proof is maths, not
//                        permission: anyone holding the list can compute one.
//                        That is what this file does.
//
//   Signed allow list  — the contract holds a SIGNER ADDRESS. Minting needs a
//                        SIGNATURE from that key. Not derivable from anything;
//                        the signature IS the allow list. Nothing here helps,
//                        and nothing could.
//
// The proof is checked against the on-chain root before any transaction is
// built. A wrong proof reverts with InvalidProof and still costs gas, and in a
// race that is the worst possible moment to discover it.

import { AbiCoder, Interface, concat, getAddress, keccak256 } from "ethers";
import { SEADROP_ADDRESS } from "./seadrop-public";
import { createProvider } from "./rpc-provider";

/** ISeaDrop.MintParams — the stage's terms, hashed into the leaf. */
export interface MintParams {
  mintPrice: bigint;
  maxTotalMintableByWallet: bigint;
  startTime: bigint;
  endTime: bigint;
  dropStageIndex: bigint;
  maxTokenSupplyForStage: bigint;
  feeBps: bigint;
  restrictFeeRecipients: boolean;
}

const MINT_PARAMS_TUPLE =
  "(uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, uint256 feeBps, bool restrictFeeRecipients)";

const IFACE = new Interface([
  `function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, ${MINT_PARAMS_TUPLE} mintParams, bytes32[] proof) payable`,
  "function getAllowListMerkleRoot(address) view returns (bytes32)",
]);

const paramsTuple = (p: MintParams) => [
  p.mintPrice,
  p.maxTotalMintableByWallet,
  p.startTime,
  p.endTime,
  p.dropStageIndex,
  p.maxTokenSupplyForStage,
  p.feeBps,
  p.restrictFeeRecipients,
];

/**
 * The leaf SeaDrop hashes for a given minter: keccak256(abi.encode(minter, mintParams)).
 *
 * The exact encoding matters completely — a leaf off by one field produces a
 * proof that verifies against nothing, and the contract reports only
 * "InvalidProof" without saying why.
 */
export function allowListLeaf(minter: string, params: MintParams): string {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["address", MINT_PARAMS_TUPLE],
    [getAddress(minter), paramsTuple(params)]
  );
  return keccak256(encoded);
}

/**
 * Fold a proof up to a root, hashing each pair in sorted order.
 *
 * SeaDrop verifies with solady's MerkleProofLib, which — like OpenZeppelin's —
 * sorts each pair before hashing, so the proof carries no left/right
 * information. Getting this wrong yields a root that matches nothing.
 */
export function foldProof(leaf: string, proof: string[]): string {
  let computed = leaf;
  for (const sibling of proof) {
    const [a, b] =
      computed.toLowerCase() <= sibling.toLowerCase() ? [computed, sibling] : [sibling, computed];
    computed = keccak256(concat([a, b]));
  }
  return computed;
}

export function verifyProof(leaf: string, proof: string[], root: string): boolean {
  return foldProof(leaf, proof).toLowerCase() === root.toLowerCase();
}

/** The stage's Merkle root as the contract currently holds it. */
export async function fetchAllowListRoot(rpcUrl: string, nftContract: string): Promise<string | null> {
  try {
    const provider = createProvider(rpcUrl);
    const res = await provider.call({
      to: SEADROP_ADDRESS,
      data: IFACE.encodeFunctionData("getAllowListMerkleRoot", [nftContract]),
    });
    const root = IFACE.decodeFunctionResult("getAllowListMerkleRoot", res)[0] as string;
    return root === `0x${"0".repeat(64)}` ? null : root;
  } catch {
    return null;
  }
}

export interface AllowListCheck {
  ok: boolean;
  reason?: string;
  root?: string;
  leaf?: string;
}

/**
 * Whether this wallet's proof actually opens this stage — checked before a
 * transaction exists, so a bad proof costs nothing instead of gas plus the
 * mint.
 */
export async function checkAllowListProof(
  rpcUrl: string,
  nftContract: string,
  minter: string,
  params: MintParams,
  proof: string[]
): Promise<AllowListCheck> {
  const root = await fetchAllowListRoot(rpcUrl, nftContract);
  if (!root) {
    return { ok: false, reason: "This collection has no Merkle allow-list stage configured." };
  }
  const leaf = allowListLeaf(minter, params);
  if (!verifyProof(leaf, proof, root)) {
    return {
      ok: false,
      root,
      leaf,
      reason:
        "That proof doesn't match the stage's on-chain root. Either it's for a different wallet, " +
        "or the stage terms don't match the ones the list was built with. Nothing was sent.",
    };
  }
  return { ok: true, root, leaf };
}

/** Calldata for the mint. Value is price x quantity, as with the public stage. */
export function encodeMintAllowList(
  nftContract: string,
  feeRecipient: string,
  quantity: number,
  params: MintParams,
  proof: string[]
): { to: string; data: string; value: bigint } {
  return {
    to: SEADROP_ADDRESS,
    // minterIfNotPayer is the zero address: the wallet sending is the wallet
    // minting, which is the only shape this bot uses.
    data: IFACE.encodeFunctionData("mintAllowList", [
      getAddress(nftContract),
      getAddress(feeRecipient),
      "0x0000000000000000000000000000000000000000",
      BigInt(quantity),
      paramsTuple(params),
      proof,
    ]),
    value: params.mintPrice * BigInt(quantity),
  };
}

/**
 * Parse the mint params and proof a project publishes.
 *
 * Shapes vary between projects, so field names are accepted in the spellings
 * seen in the wild rather than demanding one exact form.
 */
export function parseAllowListInput(json: string): { params: MintParams; proof: string[] } {
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("That isn't valid JSON.");
  }

  const proof: string[] = raw.proof ?? raw.merkleProof ?? raw.hexProof;
  if (!Array.isArray(proof) || proof.length === 0) {
    throw new Error("No proof array found — expected a `proof` field with the Merkle hashes.");
  }
  for (const node of proof) {
    if (typeof node !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(node)) {
      throw new Error(`Proof entry ${node} isn't a 32-byte hash.`);
    }
  }

  const p = raw.mintParams ?? raw.params ?? raw;
  const need = (...names: string[]): bigint => {
    for (const n of names) {
      if (p[n] !== undefined && p[n] !== null) return BigInt(p[n]);
    }
    throw new Error(`Missing mint param: ${names[0]}`);
  };

  return {
    proof,
    params: {
      mintPrice: need("mintPrice", "price"),
      maxTotalMintableByWallet: need("maxTotalMintableByWallet", "maxMintable", "limit"),
      startTime: need("startTime", "start"),
      endTime: need("endTime", "end"),
      dropStageIndex: need("dropStageIndex", "stageIndex"),
      maxTokenSupplyForStage: need("maxTokenSupplyForStage", "maxSupplyForStage"),
      feeBps: need("feeBps", "fee"),
      restrictFeeRecipients: Boolean(p.restrictFeeRecipients ?? p.restrictFees ?? true),
    },
  };
}
