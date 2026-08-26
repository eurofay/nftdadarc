import { describe, it, expect } from "vitest";
import { Interface } from "ethers";
import { encodeMintPublic } from "./seadrop-public";

const IFACE = new Interface([
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
]);

const NFT = "0x1111111111111111111111111111111111111111";
const FEE_RECIPIENT = "0x2222222222222222222222222222222222222222";

describe("encodeMintPublic", () => {
  it("encodes calldata that decodes back to the given contract, recipient and quantity", () => {
    const data = encodeMintPublic(NFT, FEE_RECIPIENT, 3);
    const decoded = IFACE.decodeFunctionData("mintPublic", data);
    expect(decoded.nftContract.toLowerCase()).toBe(NFT);
    expect(decoded.feeRecipient.toLowerCase()).toBe(FEE_RECIPIENT);
    expect(decoded.quantity).toBe(3n);
  });

  it("always sets minterIfNotPayer to the zero address", () => {
    const data = encodeMintPublic(NFT, FEE_RECIPIENT, 1);
    const decoded = IFACE.decodeFunctionData("mintPublic", data);
    expect(decoded.minterIfNotPayer).toBe("0x0000000000000000000000000000000000000000");
  });

  it("produces identical calldata for the same inputs regardless of quantity type", () => {
    const a = encodeMintPublic(NFT, FEE_RECIPIENT, 5);
    const b = encodeMintPublic(NFT, FEE_RECIPIENT, 5);
    expect(a).toBe(b);
  });
});
