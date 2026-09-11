import { describe, it, expect } from "vitest";
import { proofForWallet, ScheduledMint } from "./telegram/store";
import { allowListLeaf, MintParams, verifyProof, foldProof } from "./seadrop-allowlist";

const PARAMS: MintParams = {
  mintPrice: 0n,
  maxTotalMintableByWallet: 2n,
  startTime: 0n,
  endTime: 0n,
  dropStageIndex: 1n,
  maxTokenSupplyForStage: 0n,
  feeBps: 1000n,
  restrictFeeRecipients: true,
};

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

const record = (over: Partial<ScheduledMint>): ScheduledMint => ({
  id: "r1",
  chainKey: "robinhood",
  nftContract: "0x3333333333333333333333333333333333333333",
  quantity: 1,
  wallets: [A],
  targetStartMs: Date.now() + 60_000,
  createdAt: Date.now(),
  status: "pending",
  ...over,
});

describe("a Merkle leaf is bound to one address", () => {
  it("differs per minter, which is why one proof cannot serve many wallets", () => {
    // The reason all of this exists. If these were equal, a shared proof
    // would be fine and none of the per-wallet plumbing would be needed.
    expect(allowListLeaf(A, PARAMS)).not.toBe(allowListLeaf(B, PARAMS));
  });

  it("a sibling proof built for A does not verify for B", () => {
    const root = foldProof(allowListLeaf(A, PARAMS), [allowListLeaf(B, PARAMS)]);
    expect(verifyProof(allowListLeaf(A, PARAMS), [allowListLeaf(B, PARAMS)], root)).toBe(true);
    // B presenting A's proof: this is exactly the InvalidProof revert that
    // used to cost a fee per extra wallet.
    expect(verifyProof(allowListLeaf(B, PARAMS), [allowListLeaf(B, PARAMS)], root)).toBe(false);
  });
});

describe("proofForWallet", () => {
  it("gives each wallet its own proof", () => {
    const r = record({
      wallets: [A, B],
      allowlist: { proofs: { [A.toLowerCase()]: ["0xaa"], [B.toLowerCase()]: ["0xbb"] }, params: "{}" },
    });
    expect(proofForWallet(r, A)).toEqual(["0xaa"]);
    expect(proofForWallet(r, B)).toEqual(["0xbb"]);
  });

  it("is case-insensitive about the address", () => {
    const r = record({ allowlist: { proofs: { [A.toLowerCase()]: ["0xaa"] }, params: "{}" } });
    expect(proofForWallet(r, A.toUpperCase().replace("0X", "0x"))).toEqual(["0xaa"]);
  });

  it("returns null for a wallet with no proof, rather than lending it another's", () => {
    const r = record({
      wallets: [A, B],
      allowlist: { proofs: { [A.toLowerCase()]: ["0xaa"] }, params: "{}" },
    });
    expect(proofForWallet(r, B)).toBe(null);
  });

  it("still fires a legacy single-wallet record", () => {
    const r = record({ wallets: [A], allowlist: { proof: ["0xaa"], params: "{}" } });
    expect(proofForWallet(r, A)).toEqual(["0xaa"]);
  });

  it("refuses to guess whose proof a legacy multi-wallet record holds", () => {
    // An old record listing two wallets and one proof is ambiguous. Declining
    // costs a mint; guessing costs a mint AND the gas for a revert.
    const r = record({ wallets: [A, B], allowlist: { proof: ["0xaa"], params: "{}" } });
    expect(proofForWallet(r, A)).toBe(null);
    expect(proofForWallet(r, B)).toBe(null);
  });

  it("returns null when the record is not an allow-list mint at all", () => {
    expect(proofForWallet(record({}), A)).toBe(null);
  });
});
