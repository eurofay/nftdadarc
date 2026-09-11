import { describe, it, expect, vi, beforeEach } from "vitest";
import { Wallet } from "ethers";

const buildLocalMintPlan = vi.fn();
const resolveFeeRecipient = vi.fn();
const fetchAllowListRoot = vi.fn();
const findAllowListUri = vi.fn();
const deriveProof = vi.fn();
const readStages = vi.fn();

vi.mock("./seadrop-public", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildLocalMintPlan: (...a: unknown[]) => buildLocalMintPlan(...a),
  resolveFeeRecipient: (...a: unknown[]) => resolveFeeRecipient(...a),
}));
vi.mock("./seadrop-allowlist", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchAllowListRoot: (...a: unknown[]) => fetchAllowListRoot(...a),
}));
vi.mock("./seadrop-stages", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readStages: (...a: unknown[]) => readStages(...a),
}));
vi.mock("./allowlist-fetch", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findAllowListUri: (...a: unknown[]) => findAllowListUri(...a),
  deriveProof: (...a: unknown[]) => deriveProof(...a),
}));

import { resolveMint, planLookup, describeResolved, ResolvedMint } from "./mint-resolve";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const NFT = "0x3333333333333333333333333333333333333333";
const FEE = "0x4444444444444444444444444444444444444444";

const base = {
  rpcUrls: ["http://rpc"],
  chainKey: "robinhood",
  chainId: 4663,
  contract: NFT,
  wallets: [A, B],
  quantity: 2,
};

const PUBLIC_PLAN = {
  to: "0xseadrop",
  data: "0xpublic",
  value: 10n,
  feeRecipient: FEE,
  drop: {
    mintPrice: 5n,
    startTime: 1_700_000_000,
    endTime: 1_700_003_600,
    maxTotalMintableByWallet: 3,
    feeBps: 1000,
    restrictFeeRecipients: true,
  },
};

const PROOF = ["0x" + "aa".repeat(32)];

const PARAMS = {
  mintPrice: 1n,
  maxTotalMintableByWallet: 2n,
  startTime: 1_700_000_000n,
  endTime: 0n,
  dropStageIndex: 1n,
  maxTokenSupplyForStage: 0n,
  feeBps: 1000n,
  restrictFeeRecipients: true,
};

const LIST_JSON = JSON.stringify([
  {
    address: A,
    mintParams: {
      mintPrice: "1",
      maxTotalMintableByWallet: 2,
      startTime: 1700000000,
      endTime: 0,
      dropStageIndex: 1,
      maxTokenSupplyForStage: 0,
      feeBps: 1000,
      restrictFeeRecipients: true,
    },
  },
]);

beforeEach(() => {
  for (const m of [buildLocalMintPlan, resolveFeeRecipient, fetchAllowListRoot, findAllowListUri, deriveProof, readStages]) {
    m.mockReset();
  }
  buildLocalMintPlan.mockResolvedValue(null);
  fetchAllowListRoot.mockResolvedValue(null);
  findAllowListUri.mockResolvedValue(null);
  resolveFeeRecipient.mockResolvedValue({ address: FEE });
  readStages.mockResolvedValue([{ kind: "public", present: true, mintable: true, detail: "" }]);
});

describe("source order", () => {
  it("takes the public stage without touching a list or an API", async () => {
    buildLocalMintPlan.mockResolvedValue(PUBLIC_PLAN);

    const out = (await resolveMint({ ...base }))!;

    expect(out.source).toBe("public");
    expect(out.plans).toHaveLength(2);
    // The cheapest source wins outright: nothing else is even asked.
    expect(fetchAllowListRoot).not.toHaveBeenCalled();
  });

  it("ignores a drop struct that exists but is switched off", async () => {
    // Every field zero is not a stage anyone can mint, and calling it one
    // sends a transaction that cannot succeed.
    buildLocalMintPlan.mockResolvedValue({
      ...PUBLIC_PLAN,
      drop: { ...PUBLIC_PLAN.drop, startTime: 0, endTime: 0, maxTotalMintableByWallet: 0 },
    });
    expect(await resolveMint({ ...base, signerFor: undefined })).toBe(null);
  });

  it("falls to the allow list and gives each wallet its own calldata", async () => {
    fetchAllowListRoot.mockResolvedValue("0xroot");
    findAllowListUri.mockResolvedValue({ uri: "ipfs://list", block: 1 });
    deriveProof.mockImplementation((_e: unknown, wallet: string) =>
      wallet === A ? { proof: PROOF, params: PARAMS, matchesChain: true } : null
    );

    const out = (await resolveMint({ ...base, fetchList: async () => LIST_JSON }))!;

    expect(out.source).toBe("allowlist");
    expect(out.plans.map((p) => p.address)).toEqual([A]);
    expect(out.skipped).toEqual([{ address: B, reason: "not on the allow list" }]);
  });

  it("caps quantity at what the stage allows rather than reverting", async () => {
    fetchAllowListRoot.mockResolvedValue("0xroot");
    findAllowListUri.mockResolvedValue({ uri: "ipfs://list", block: 1 });
    deriveProof.mockReturnValue({ proof: PROOF, params: PARAMS, matchesChain: true });

    const out = (await resolveMint({ ...base, quantity: 99, fetchList: async () => LIST_JSON }))!;

    expect(out.quantity).toBe(2); // maxTotalMintableByWallet
  });

  it("keeps looking when the Merkle list excludes everyone", async () => {
    // This used to stop here. That was wrong: the Merkle list and the signed
    // stage are different gates, and being absent from one says nothing about
    // the other. Stopping meant a wallet holding a signature was told it
    // could not mint.
    readStages.mockResolvedValue([
      { kind: "public", present: false, mintable: false, detail: "" },
      { kind: "allowlist", present: true, mintable: false, detail: "" },
    ]);
    fetchAllowListRoot.mockResolvedValue("0xroot");
    findAllowListUri.mockResolvedValue({ uri: "ipfs://list", block: 1 });
    deriveProof.mockReturnValue(null);
    const signerFor = vi.fn(() => new Wallet("0x" + "1".repeat(64)));

    // Stubbed, or this reaches the real client and the network.
    const made = {
      login: vi.fn(async () => {}),
      mintCalldata: vi.fn(async () => {
        throw new Error("not eligible");
      }),
    };

    await resolveMint({
      ...base,
      signerFor,
      makeClient: () => made as never,
      fetchList: async () => LIST_JSON,
    });

    expect(signerFor).toHaveBeenCalled();
  });
});

describe("which stage gets picked", () => {
  const gated = [
    { kind: "public", present: true, mintable: true, detail: "", startTime: 1_800_000_000 },
    { kind: "allowlist", present: true, mintable: false, detail: "" },
  ];

  it("does NOT hand a whitelisted wallet the public stage", async () => {
    // The bug this exists for. A gated collection nearly always has a public
    // stage configured as well -- later, dearer, and contested by everyone.
    // Trying public first because it is cheapest to RESOLVE meant a wallet
    // that was on the allow list was given public anyway, which threw away
    // the entire reason for being on the list.
    readStages.mockResolvedValue(gated);
    buildLocalMintPlan.mockResolvedValue(PUBLIC_PLAN);
    fetchAllowListRoot.mockResolvedValue("0xroot");
    findAllowListUri.mockResolvedValue({ uri: "ipfs://list", block: 1 });
    deriveProof.mockReturnValue({ proof: PROOF, params: PARAMS, matchesChain: true });

    const out = (await resolveMint({ ...base, fetchList: async () => LIST_JSON }))!;

    expect(out.source).toBe("allowlist");
    expect(out.startTimeMs).toBe(Number(PARAMS.startTime) * 1000);
  });

  it("falls back to public, and says so, when no wallet can use the gated stage", async () => {
    readStages.mockResolvedValue(gated);
    buildLocalMintPlan.mockResolvedValue(PUBLIC_PLAN);
    fetchAllowListRoot.mockResolvedValue("0xroot");
    findAllowListUri.mockResolvedValue({ uri: "ipfs://list", block: 1 });
    deriveProof.mockReturnValue(null);

    const out = (await resolveMint({ ...base, fetchList: async () => LIST_JSON }))!;

    expect(out.source).toBe("public");
    // Never let a public result look like the only stage there was.
    expect(out.notes.join(" ")).toContain("PUBLIC stage");
  });

  it("tries OpenSea when the Merkle list excludes a wallet, since signed stages are separate", async () => {
    readStages.mockResolvedValue([
      { kind: "public", present: false, mintable: false, detail: "" },
      { kind: "signed", present: true, mintable: false, detail: "" },
    ]);
    fetchAllowListRoot.mockResolvedValue("0xroot");
    findAllowListUri.mockResolvedValue({ uri: "ipfs://list", block: 1 });
    deriveProof.mockReturnValue(null);
    const signerFor = vi.fn(() => new Wallet("0x" + "1".repeat(64)));
    const made = {
      login: vi.fn(async () => {}),
      mintCalldata: vi.fn(async () => ({ to: "0xdrop", data: "0xsigned", value: 8n })),
    };

    const out = (await resolveMint({
      ...base,
      signerFor,
      makeClient: () => made as never,
      fetchList: async () => LIST_JSON,
    }))!;

    expect(out.source).toBe("opensea");
    expect(signerFor).toHaveBeenCalled();
  });

  it("takes the public stage first when nothing gated is configured", async () => {
    readStages.mockResolvedValue([{ kind: "public", present: true, mintable: true, detail: "" }]);
    buildLocalMintPlan.mockResolvedValue(PUBLIC_PLAN);

    const out = (await resolveMint({ ...base }))!;

    expect(out.source).toBe("public");
    expect(fetchAllowListRoot).not.toHaveBeenCalled();
  });

  it("honours an explicit ask for the public stage", async () => {
    readStages.mockResolvedValue(gated);
    buildLocalMintPlan.mockResolvedValue(PUBLIC_PLAN);

    const out = (await resolveMint({ ...base, prefer: "public" }))!;

    expect(out.source).toBe("public");
  });
});

describe("the OpenSea fallback", () => {
  const client = (over: Record<string, unknown> = {}) => ({
    login: vi.fn(async () => {}),
    mintCalldata: vi.fn(async () => ({ to: "0xdrop", data: "0xsigned", value: 8n })),
    ...over,
  });

  it("asks per wallet, because the signature names the minter", async () => {
    const made = [client(), client()];
    let i = 0;

    const out = (await resolveMint({
      ...base,
      signerFor: (a) => new Wallet("0x" + "1".repeat(64)),
      makeClient: () => made[i++] as never,
    }))!;

    expect(out.source).toBe("opensea");
    expect(out.plans).toHaveLength(2);
    expect(made[0].login).toHaveBeenCalledTimes(1);
    expect(made[1].login).toHaveBeenCalledTimes(1);
    // Each wallet gets its own bytes, never a shared blob.
    expect(out.plans[0].plan.data).toBe("0xsigned");
  });

  it("skips a wallet OpenSea refuses, and keeps the others", async () => {
    let i = 0;
    const made = [
      client({ mintCalldata: vi.fn(async () => { throw new Error("not eligible"); }) }),
      client(),
    ];

    const out = (await resolveMint({
      ...base,
      signerFor: () => new Wallet("0x" + "1".repeat(64)),
      makeClient: () => made[i++] as never,
    }))!;

    expect(out.plans.map((p) => p.address)).toEqual([B]);
    expect(out.skipped[0].reason).toContain("not eligible");
  });

  it("is never reached without a signer, since SIWE needs one", async () => {
    expect(await resolveMint({ ...base })).toBe(null);
  });
});

describe("planLookup", () => {
  const resolved: ResolvedMint = {
    source: "allowlist",
    contract: NFT,
    startTimeMs: null,
    quantity: 1,
    plans: [{ address: A, plan: PUBLIC_PLAN }],
    skipped: [{ address: B, reason: "not on the allow list" }],
    notes: [],
  };

  it("finds a wallet's plan whatever the case of the address", () => {
    expect(planLookup(resolved)(A.toUpperCase().replace("0X", "0x"))).toBe(PUBLIC_PLAN);
  });

  it("returns null for a skipped wallet rather than another wallet's plan", () => {
    // The whole point: no plan means do not send. Sending anyway is a revert
    // that still costs the fee.
    expect(planLookup(resolved)(B)).toBe(null);
  });
});

describe("describeResolved", () => {
  it("names the stage type and marks every wallet", () => {
    const text = describeResolved(
      {
        source: "opensea",
        contract: NFT,
        startTimeMs: null,
        quantity: 1,
        plans: [{ address: A, plan: PUBLIC_PLAN }],
        skipped: [{ address: B, reason: "not eligible" }],
        notes: ["OpenSea issued calldata for 1 of 2 wallet(s)."],
      },
      (a) => a.slice(0, 6)
    );
    expect(text).toContain("Signed stage (via OpenSea)");
    expect(text).toContain("✅ 0x1111");
    expect(text).toContain("⛔ 0x2222 — not eligible");
  });
});
