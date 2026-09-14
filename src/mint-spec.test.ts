import { describe, it, expect } from "vitest";
import { Interface, getAddress } from "ethers";
import {
  MintSpecError,
  NATIVE_TOKEN,
  buildMintCalldata,
  describeSpec,
  missingSpecInputs,
  specFromSignature,
  supportsBatch,
} from "./mint-spec";
import { KNOWN_MINTS } from "./mint-signatures";

// The rule this module exists to enforce: an argument is either derived from
// something legitimately held, or it is reported missing. Filling an unknown
// argument with a zero produces calldata that encodes cleanly, passes every
// local check, and reverts on-chain -- the most expensive way to be wrong.

// Checksummed rather than hand-written: ethers rejects a mixed-case address
// whose checksum does not match, and a hand-typed one almost never does.
const CONTRACT = getAddress("0x" + "11".repeat(20));
const ALICE = getAddress("0x" + "aa".repeat(20));
const BOB = getAddress("0x" + "bb".repeat(20));
const PROOF = ["0x" + "aa".repeat(32), "0x" + "bb".repeat(32)];
const SIG = "0x" + "cd".repeat(65);

const find = (signature: string) => KNOWN_MINTS.find((m) => m.signature === signature)!;

const spec = (signature: string, over: Record<string, unknown> = {}) =>
  specFromSignature(find(signature), {
    chainId: 1,
    contract: CONTRACT,
    quantity: 3,
    priceWei: 10_000_000_000_000_000n,
    ...over,
  });

describe("building calldata for a plain public mint", () => {
  it("encodes the quantity and charges price x quantity", () => {
    const built = buildMintCalldata(spec("mint(uint256)"), { address: ALICE });
    expect(built.to).toBe(CONTRACT);
    expect(built.value).toBe(30_000_000_000_000_000n);
    const decoded = new Interface(["function mint(uint256)"]).decodeFunctionData("mint", built.data);
    expect(decoded[0]).toBe(3n);
  });

  it("puts the minting wallet's OWN address in a receiver argument", () => {
    const a = buildMintCalldata(spec("mint(address,uint256)"), { address: ALICE });
    const b = buildMintCalldata(spec("mint(address,uint256)"), { address: BOB });
    expect(a.data).not.toBe(b.data);
    const iface = new Interface(["function mint(address,uint256)"]);
    expect(iface.decodeFunctionData("mint", a.data)[0]).toBe(ALICE);
    expect(iface.decodeFunctionData("mint", b.data)[0]).toBe(BOB);
  });

  it("sends nothing for a free mint", () => {
    expect(buildMintCalldata(spec("mint(uint256)", { priceWei: 0n }), { address: ALICE }).value).toBe(0n);
  });

  it("honours a flat value where the contract does not charge per token", () => {
    const built = buildMintCalldata(spec("mint(uint256)", { valueOverrideWei: 777n }), {
      address: ALICE,
    });
    expect(built.value).toBe(777n);
  });
});

describe("building a Merkle-gated mint", () => {
  it("carries this wallet's own proof", () => {
    const built = buildMintCalldata(spec("allowlistMint(uint256,bytes32[])"), {
      address: ALICE,
      proof: PROOF,
    });
    const decoded = new Interface([
      "function allowlistMint(uint256,bytes32[])",
    ]).decodeFunctionData("allowlistMint", built.data);
    expect(decoded[0]).toBe(3n);
    expect([...decoded[1]]).toEqual(PROOF);
  });

  it("refuses to build when the wallet has no proof, naming what is missing", () => {
    // The alternative is an empty bytes32[], which encodes fine and reverts
    // with InvalidProof after paying the gas.
    try {
      buildMintCalldata(spec("allowlistMint(uint256,bytes32[])"), { address: ALICE });
      throw new Error("should have refused");
    } catch (err) {
      expect(err).toBeInstanceOf(MintSpecError);
      expect((err as MintSpecError).missing.join(" ")).toContain("Merkle proof");
      expect((err as MintSpecError).message).toContain(ALICE);
    }
  });

  it("respects argument order, so the reversed form is not filled backwards", () => {
    const built = buildMintCalldata(spec("allowlistMint(bytes32[],uint256)"), {
      address: ALICE,
      proof: PROOF,
    });
    const decoded = new Interface([
      "function allowlistMint(bytes32[],uint256)",
    ]).decodeFunctionData("allowlistMint", built.data);
    expect([...decoded[0]]).toEqual(PROOF);
    expect(decoded[1]).toBe(3n);
  });

  it("passes the wallet's stated allowance, not the quantity, when the list has one", () => {
    const built = buildMintCalldata(spec("allowlistMint(uint256,uint256,bytes32[])"), {
      address: ALICE,
      proof: PROOF,
      allowance: 5n,
    });
    const decoded = new Interface([
      "function allowlistMint(uint256,uint256,bytes32[])",
    ]).decodeFunctionData("allowlistMint", built.data);
    expect(decoded[0]).toBe(3n);
    expect(decoded[1]).toBe(5n);
  });
});

describe("building a server-signed mint", () => {
  it("passes the signature through byte for byte", () => {
    // Any alteration invalidates the signature that covers it.
    const built = buildMintCalldata(spec("mintSigned(uint256,bytes)"), {
      address: ALICE,
      signature: SIG,
    });
    const decoded = new Interface([
      "function mintSigned(uint256,bytes)",
    ]).decodeFunctionData("mintSigned", built.data);
    expect(decoded[1]).toBe(SIG);
  });

  it("refuses to build without one rather than sending empty bytes", () => {
    expect(() => buildMintCalldata(spec("mintSigned(uint256,bytes)"), { address: ALICE })).toThrow(
      MintSpecError
    );
  });

  it("refuses when a nonce was issued with the signature but not supplied", () => {
    // A nonce is covered by the signature. Guessing zero produces a mint the
    // contract rejects as an invalid signature.
    try {
      buildMintCalldata(spec("mint(uint256,uint256,bytes)"), { address: ALICE, signature: SIG });
      throw new Error("should have refused");
    } catch (err) {
      expect((err as MintSpecError).missing.join(" ")).toContain("issued with the signature");
    }
  });

  it("builds once the nonce is supplied", () => {
    const built = buildMintCalldata(spec("mint(uint256,uint256,bytes)"), {
      address: ALICE,
      signature: SIG,
      nonce: 99n,
    });
    const decoded = new Interface([
      "function mint(uint256,uint256,bytes)",
    ]).decodeFunctionData("mint", built.data);
    expect(decoded[1]).toBe(99n);
  });
});

describe("thirdweb's claim", () => {
  const TW = "claim(address,uint256,address,uint256,(bytes32[],uint256,uint256,address),bytes)";

  it("fills the AllowlistProof struct with the phase's own terms", () => {
    const built = buildMintCalldata(spec(TW), {
      address: ALICE,
      proof: PROOF,
      allowance: 5n,
    });
    const iface = new Interface([`function ${TW}`]);
    const d = iface.decodeFunctionData("claim", built.data);
    expect(d[0]).toBe(ALICE);
    expect(d[1]).toBe(3n);
    expect(d[2]).toBe(NATIVE_TOKEN);
    expect([...d[4][0]]).toEqual(PROOF);
    // quantityLimitPerWallet and pricePerToken are checked against the active
    // claim condition, so they come from the authorisation, not from us.
    expect(d[4][1]).toBe(5n);
    expect(d[4][2]).toBe(10_000_000_000_000_000n);
  });

  it("claims an open phase with an empty proof rather than refusing", () => {
    // thirdweb's open phase takes an empty AllowlistProof. Demanding a proof
    // here would make every thirdweb public mint unreachable.
    const built = buildMintCalldata(spec(TW), { address: ALICE });
    const d = new Interface([`function ${TW}`]).decodeFunctionData("claim", built.data);
    expect([...d[4][0]]).toEqual([]);
  });
});

describe("arguments nothing can derive", () => {
  const manifold = KNOWN_MINTS.find((m) => m.family.includes("Manifold"))!;

  it("is reported at configure time, not discovered at fire time", () => {
    const s = specFromSignature(manifold, {
      chainId: 1,
      contract: CONTRACT,
      quantity: 1,
      priceWei: 0n,
    });
    const missing = missingSpecInputs(s);
    expect(missing.join(" ")).toContain("only the project knows");
  });

  it("builds once the operator supplies them", () => {
    const s = specFromSignature(manifold, {
      chainId: 1,
      contract: CONTRACT,
      quantity: 1,
      priceWei: 0n,
      operatorArgs: [CONTRACT, 42n, 7],
    });
    expect(missingSpecInputs(s)).toHaveLength(0);
    const built = buildMintCalldata(s, { address: ALICE, proof: PROOF });
    expect(built.data).toMatch(/^0x/);
  });
});

describe("what the operator is told", () => {
  it("says when a contract cannot batch, instead of silently minting one", () => {
    const one = specFromSignature(find("mint()"), {
      chainId: 1,
      contract: CONTRACT,
      quantity: 5,
      priceWei: 0n,
    });
    expect(supportsBatch(one)).toBe(false);
    expect(describeSpec(one)).toContain("no quantity argument");
  });

  it("catches an argument map that does not fit its signature", () => {
    const broken = { ...spec("mint(uint256)"), args: ["quantity", "proof"] as never };
    expect(missingSpecInputs(broken).join(" ")).toContain("takes 1");
    expect(() => buildMintCalldata(broken, { address: ALICE })).toThrow(MintSpecError);
  });

  it("rejects a signature it cannot parse, with a usable message", () => {
    const nonsense = { ...spec("mint(uint256)"), signature: "not a signature" };
    expect(() => missingSpecInputs(nonsense)).toThrow(/solidity function signature/);
  });
});
