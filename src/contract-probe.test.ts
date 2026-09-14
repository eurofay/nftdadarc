import { describe, it, expect, vi, beforeEach } from "vitest";
import { AbiCoder, getAddress } from "ethers";
import { describeProfile, probeContract, readMintedCount } from "./contract-probe";
import { selectorOf, selectorsFromBytecode } from "./mint-signatures";

// The probe's job is to say what a contract IS without being told. Its other
// job, just as important, is to say when it cannot -- a contract whose mint
// shape is unrecognised must come back as exactly that, never as a guess.

const CODER = AbiCoder.defaultAbiCoder();
const CONTRACT = getAddress("0x" + "11".repeat(20));
const ALICE = getAddress("0x" + "aa".repeat(20));
const SIGNER = getAddress("0x" + "5e".repeat(20));

let code = "0x";
let answers: Record<string, string> = {};
let calls: string[] = [];

vi.mock("./rpc-provider", () => ({
  createProvider: () => ({
    getCode: async () => code,
    call: async (tx: { data: string }) => {
      calls.push(tx.data.slice(0, 10));
      const hit = answers[tx.data.slice(0, 10)];
      if (hit === undefined) throw new Error("execution reverted");
      return hit;
    },
  }),
}));

/** Bytecode exposing exactly these functions, as a dispatcher would. */
const codeWith = (...signatures: string[]) =>
  "0x6080604052" + signatures.map((s) => `63${selectorOf(s).slice(2)}14`).join("") + "00";

const uint = (n: bigint | number) => CODER.encode(["uint256"], [n]);
const bool = (b: boolean) => CODER.encode(["bool"], [b]);
const addr = (a: string) => CODER.encode(["address"], [a]);
const b32 = (h: string) => CODER.encode(["bytes32"], [h]);

beforeEach(() => {
  code = "0x";
  answers = {};
  calls = [];
});

describe("an address that is not a mintable contract", () => {
  it("says there is no contract there, rather than probing on", async () => {
    code = "0x";
    const p = await probeContract("http://unused", CONTRACT);
    expect(p.isContract).toBe(false);
    expect(p.notes.join(" ")).toContain("no contract at this address");
    expect(calls).toHaveLength(0);
  });
});

describe("a plain public mint", () => {
  beforeEach(() => {
    code = codeWith("mint(uint256)", "mintPrice()", "maxSupply()", "totalSupply()", "saleIsActive()");
    answers[selectorOf("mintPrice()")] = uint(10_000_000_000_000_000n);
    answers[selectorOf("maxSupply()")] = uint(5000);
    answers[selectorOf("totalSupply()")] = uint(1200);
    answers[selectorOf("saleIsActive()")] = bool(true);
  });

  it("finds the mint and reads the terms from the contract itself", async () => {
    const p = await probeContract("http://unused", CONTRACT);
    expect(p.mints[0].signature).toBe("mint(uint256)");
    expect(p.state.priceWei).toBe(10_000_000_000_000_000n);
    expect(p.state.maxSupply).toBe(5000n);
    expect(p.state.totalSupply).toBe(1200n);
    expect(p.state.saleActive).toBe(true);
  });

  it("says which getter each value came from", async () => {
    // A surprising number is only actionable if it can be traced back to the
    // function that produced it.
    const p = await probeContract("http://unused", CONTRACT);
    expect(p.state.source.price).toBe("mintPrice()");
  });

  it("only calls getters the bytecode proves exist", async () => {
    // The alternative is forty speculative round trips answered by forty
    // ambiguous failures.
    await probeContract("http://unused", CONTRACT);
    expect(calls).toHaveLength(4);
    expect(calls).not.toContain(selectorOf("merkleRoot()"));
  });
});

describe("a gated contract", () => {
  it("reports a Merkle root, and says the proof lives off-chain", async () => {
    code = codeWith("allowlistMint(uint256,bytes32[])", "merkleRoot()");
    answers[selectorOf("merkleRoot()")] = b32("0x" + "ab".repeat(32));
    const p = await probeContract("http://unused", CONTRACT);
    expect(p.state.merkleRoot).toBe("0x" + "ab".repeat(32));
    expect(p.notes.join(" ")).toContain("published off-chain");
  });

  it("treats an unset root as no gate at all", async () => {
    // An all-zero root is an unconfigured stage, not a stage nobody matches.
    code = codeWith("mint(uint256)", "merkleRoot()");
    answers[selectorOf("merkleRoot()")] = b32("0x" + "00".repeat(32));
    const p = await probeContract("http://unused", CONTRACT);
    expect(p.state.merkleRoot).toBeUndefined();
  });

  it("names the signer and says only the project can issue one", async () => {
    code = codeWith("mintSigned(uint256,bytes)", "signer()");
    answers[selectorOf("signer()")] = addr(SIGNER);
    const p = await probeContract("http://unused", CONTRACT);
    expect(p.state.signer).toBe(SIGNER);
    expect(p.notes.join(" ")).toContain("requested, not derived");
  });

  it("prefers the gated entry point over the public one", async () => {
    code = codeWith("mint(uint256)", "whitelistMint(uint256,bytes32[])");
    const p = await probeContract("http://unused", CONTRACT);
    expect(p.mints[0].kind).toBe("merkle");
  });
});

describe("a contract nobody recognises", () => {
  it("says so, and does not invent a mint function", async () => {
    code = codeWith("frobnicate(uint256)", "totalSupply()");
    answers[selectorOf("totalSupply()")] = uint(1);
    const p = await probeContract("http://unused", CONTRACT);
    expect(p.mints).toHaveLength(0);
    expect(p.notes.join(" ")).toContain("ABI and the mint function have to be supplied");
  });
});

describe("getters that exist but refuse to answer", () => {
  it("keeps the rest of the probe rather than failing the whole thing", async () => {
    code = codeWith("mint(uint256)", "mintPrice()", "maxSupply()");
    answers[selectorOf("maxSupply()")] = uint(100);
    // mintPrice() reverts -- an access-gated read, or an unset phase.
    const p = await probeContract("http://unused", CONTRACT);
    expect(p.state.priceWei).toBeUndefined();
    expect(p.state.maxSupply).toBe(100n);
    expect(p.mints[0].signature).toBe("mint(uint256)");
  });

  it("takes the first spelling that answers, not the last", async () => {
    // KNOWN_VIEWS lists the more specific name before the generic one, so a
    // contract with both means something narrower by the first.
    code = codeWith("mint(uint256)", "mintPrice()", "price()");
    answers[selectorOf("mintPrice()")] = uint(5);
    answers[selectorOf("price()")] = uint(999);
    const p = await probeContract("http://unused", CONTRACT);
    expect(p.state.priceWei).toBe(5n);
  });
});

describe("how many this wallet has already minted", () => {
  it("prefers a real mint counter over balanceOf", async () => {
    // balanceOf counts tokens HELD, not tokens minted: a wallet that minted
    // three and sold two reads as one, and a per-wallet cap checked against
    // it would be wrong in the direction that loses money.
    code = codeWith("numberMinted(address)", "balanceOf(address)");
    answers[selectorOf("numberMinted(address)")] = uint(3);
    answers[selectorOf("balanceOf(address)")] = uint(1);
    const got = await readMintedCount(
      "http://unused",
      CONTRACT,
      ALICE,
      selectorsFromBytecode(code)
    );
    expect(got).toEqual({ count: 3, source: "numberMinted(address)" });
  });

  it("falls back to balanceOf and says that is what it used", async () => {
    code = codeWith("balanceOf(address)");
    answers[selectorOf("balanceOf(address)")] = uint(2);
    const got = await readMintedCount("http://unused", CONTRACT, ALICE, selectorsFromBytecode(code));
    expect(got!.source).toBe("balanceOf(address)");
  });

  it("returns null when the contract will not say", async () => {
    code = codeWith("mint(uint256)");
    const got = await readMintedCount("http://unused", CONTRACT, ALICE, selectorsFromBytecode(code));
    expect(got).toBeNull();
  });
});

describe("what the operator is shown", () => {
  it("reports the contract's own opening time, not a drop page's", async () => {
    code = codeWith("mint(uint256)", "publicSaleStartTime()");
    answers[selectorOf("publicSaleStartTime()")] = uint(1_800_000_000);
    const p = await probeContract("http://unused", CONTRACT);
    const text = describeProfile(p);
    expect(text).toContain("from the contract");
    expect(p.state.startTime).toBe(1_800_000_000);
  });

  it("says plainly when nothing was recognised", async () => {
    code = codeWith("frobnicate(uint256)");
    expect(describeProfile(await probeContract("http://unused", CONTRACT))).toContain(
      "not recognised"
    );
  });
});
