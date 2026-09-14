import { describe, it, expect, vi, beforeEach } from "vitest";
import { AbiCoder, Interface, getAddress } from "ethers";

// The generic route is ADDITIVE. It runs last, only when every SeaDrop and
// OpenSea route has come back with nothing -- so a SeaDrop collection must
// keep resolving exactly as it did before. These pin both halves: the new
// answer for contracts that had none, and the absence of change for the ones
// that already worked.

const buildLocalMintPlan = vi.fn();
const fetchAllowListRoot = vi.fn();
const readStages = vi.fn();

vi.mock("./seadrop-public", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildLocalMintPlan: (...a: unknown[]) => buildLocalMintPlan(...a),
}));
vi.mock("./seadrop-allowlist", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchAllowListRoot: (...a: unknown[]) => fetchAllowListRoot(...a),
}));
vi.mock("./seadrop-stages", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readStages: (...a: unknown[]) => readStages(...a),
}));

let code = "0x";
let answers: Record<string, string> = {};
vi.mock("./rpc-provider", () => ({
  createProvider: () => ({
    getCode: async () => code,
    call: async (tx: { data: string }) => {
      const hit = answers[tx.data.slice(0, 10)];
      if (hit === undefined) throw new Error("execution reverted");
      return hit;
    },
  }),
}));

import { resolveMint, describeResolved } from "./mint-resolve";
import { selectorOf } from "./mint-signatures";
import { buildMerkleTree } from "./allowlist-fetch";
import { LEAF_ENCODINGS } from "./generic-merkle";

const CODER = AbiCoder.defaultAbiCoder();
const A = getAddress("0x" + "11".repeat(20));
const B = getAddress("0x" + "22".repeat(20));
const NFT = getAddress("0x" + "33".repeat(20));

const codeWith = (...signatures: string[]) =>
  "0x6080604052" + signatures.map((s) => `63${selectorOf(s).slice(2)}14`).join("") + "00";

const base = {
  rpcUrls: ["http://rpc"],
  chainKey: "robinhood",
  chainId: 4663,
  contract: NFT,
  wallets: [A, B],
  quantity: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  code = "0x";
  answers = {};
  // No SeaDrop anything, which is the case this whole route exists for.
  readStages.mockResolvedValue([]);
  buildLocalMintPlan.mockResolvedValue(null);
  fetchAllowListRoot.mockResolvedValue(null);
});

describe("a project's own public mint", () => {
  beforeEach(() => {
    code = codeWith("mint(uint256)", "mintPrice()", "maxPerWallet()");
    answers[selectorOf("mintPrice()")] = CODER.encode(["uint256"], [1_000_000_000_000_000n]);
    answers[selectorOf("maxPerWallet()")] = CODER.encode(["uint256"], [5]);
  });

  it("resolves with no configuration at all", async () => {
    // Nothing supplied: the function comes from the bytecode, the price and
    // cap from the contract's own getters.
    const out = (await resolveMint(base))!;
    expect(out.source).toBe("generic");
    expect(out.plans).toHaveLength(2);
    expect(out.notes.join(" ")).toContain("mint(uint256)");
  });

  it("builds the same calldata for every wallet, and charges per token", async () => {
    const out = (await resolveMint(base))!;
    expect(out.plans[0].plan.to).toBe(NFT);
    expect(out.plans[0].plan.value).toBe(2_000_000_000_000_000n);
    expect(out.plans[0].plan.data).toBe(out.plans[1].plan.data);
    const decoded = new Interface(["function mint(uint256)"]).decodeFunctionData(
      "mint",
      out.plans[0].plan.data
    );
    expect(decoded[0]).toBe(2n);
  });

  it("honours a per-wallet cap lower than the requested quantity", async () => {
    answers[selectorOf("maxPerWallet()")] = CODER.encode(["uint256"], [1]);
    const out = (await resolveMint(base))!;
    // Asking for more than the cap is a revert, so the cap wins.
    expect(out.quantity).toBe(1);
  });
});

describe("a project's own Merkle stage", () => {
  const entries = [{ address: A }, { address: B }];
  const encoding = LEAF_ENCODINGS[0];
  const root = buildMerkleTree(entries.map((e) => encoding.encode(e))).root;

  beforeEach(() => {
    code = codeWith("allowlistMint(uint256,bytes32[])", "merkleRoot()");
    answers[selectorOf("merkleRoot()")] = CODER.encode(["bytes32"], [root]);
  });

  it("asks for the list rather than pretending it can find one", async () => {
    // SeaDrop puts a pointer to its list on-chain. A project's own contract
    // holds the root and nothing else -- there is no standard event and no
    // way to discover where it was published.
    const out = (await resolveMint(base))!;
    expect(out.plans).toHaveLength(0);
    expect(out.notes.join(" ")).toContain("list the project published");
  });

  it("derives each wallet's own proof once the list is supplied", async () => {
    const out = (await resolveMint({
      ...base,
      generic: { listJson: JSON.stringify([A, B]) },
    }))!;
    expect(out.plans).toHaveLength(2);
    expect(out.notes.join(" ")).toContain("matched the on-chain root");
    // Bound to one address each: the same bytes from another wallet is an
    // InvalidProof revert that still pays the gas.
    expect(out.plans[0].plan.data).not.toBe(out.plans[1].plan.data);
  });

  it("refuses a list that does not reproduce the on-chain root", async () => {
    const out = (await resolveMint({
      ...base,
      generic: { listJson: JSON.stringify([A, getAddress("0x" + "99".repeat(20))]) },
    }))!;
    expect(out.plans).toHaveLength(0);
    expect(out.notes.join(" ")).toContain("does not reproduce");
  });

  it("leaves a wallet that is not on the list out, rather than lending it a proof", async () => {
    const onlyA = [{ address: A }];
    answers[selectorOf("merkleRoot()")] = CODER.encode(
      ["bytes32"],
      [buildMerkleTree(onlyA.map((e) => encoding.encode(e))).root]
    );
    const out = (await resolveMint({ ...base, generic: { listJson: JSON.stringify([A]) } }))!;
    expect(out.plans.map((p) => p.address)).toEqual([A]);
    expect(out.skipped[0].address).toBe(B);
    expect(out.skipped[0].reason).toContain("not on the project's allow list");
  });
});

describe("a project's own signed stage", () => {
  beforeEach(() => {
    code = codeWith("mintSigned(uint256,bytes)", "signer()");
    answers[selectorOf("signer()")] = CODER.encode(["address"], [getAddress("0x" + "5e".repeat(20))]);
  });

  it("names the signer and refuses to fabricate a signature", async () => {
    const out = (await resolveMint(base))!;
    expect(out.plans).toHaveLength(0);
    const notes = out.notes.join(" ");
    expect(notes).toContain("will not fabricate");
    expect(notes.toLowerCase()).toContain("5e5e");
  });
});

describe("a contract nobody can read", () => {
  it("says what it needs instead of returning nothing", async () => {
    code = codeWith("frobnicate(uint256)");
    const out = (await resolveMint(base))!;
    expect(out.notes.join(" ")).toContain("Supply the signature");
  });

  it("accepts an operator-supplied function and argument map", async () => {
    code = codeWith("frobnicate(uint256)");
    const out = (await resolveMint({
      ...base,
      generic: { signature: "frobnicate(uint256)", args: ["quantity"], priceWei: 0n },
    }))!;
    expect(out.plans).toHaveLength(2);
    expect(out.plans[0].plan.data.slice(0, 10)).toBe(selectorOf("frobnicate(uint256)"));
  });

  it("refuses a supplied signature with no argument map", async () => {
    // Types are not meanings. mint(uint256,uint256) could be (quantity,
    // tokenId) or (tokenId, quantity), and the two are different mints.
    code = codeWith("frobnicate(uint256,uint256)");
    const out = (await resolveMint({
      ...base,
      generic: { signature: "frobnicate(uint256,uint256)" },
    }))!;
    expect(out.plans).toHaveLength(0);
  });

  it("returns nothing at all for an address with no code", async () => {
    code = "0x";
    expect(await resolveMint(base)).toBeNull();
  });
});

describe("the SeaDrop path is untouched", () => {
  it("still takes the SeaDrop public stage when there is one", async () => {
    // The generic route runs last. A SeaDrop collection must never reach it.
    code = codeWith("mint(uint256)");
    buildLocalMintPlan.mockResolvedValue({
      to: "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5",
      data: "0xabcdef",
      value: 5n,
      feeRecipient: "0x" + "44".repeat(20),
      drop: {
        mintPrice: 5n,
        startTime: 1_800_000_000,
        endTime: 1_900_000_000,
        maxTotalMintableByWallet: 3,
        feeBps: 500,
        restrictFeeRecipients: true,
      },
    });
    const out = (await resolveMint(base))!;
    expect(out.source).toBe("public");
    expect(out.plans[0].plan.data).toBe("0xabcdef");
  });
});

describe("what the operator reads", () => {
  it("labels the generic route as the project's own contract", async () => {
    code = codeWith("mint(uint256)");
    const out = (await resolveMint(base))!;
    expect(describeResolved(out, (a) => a.slice(0, 6))).toContain("Project's own contract");
  });
});
