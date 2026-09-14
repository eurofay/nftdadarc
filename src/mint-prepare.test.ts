import { describe, it, expect, vi } from "vitest";
import { Wallet, Interface } from "ethers";
import {
  prepareOpenSeaMint,
  firePreparedMint,
  MultiWalletController,
  latencies,
  RETRYABLE,
  fromDropsError,
  newPrepared,
  PrepareOpts,
} from "./mint-prepare";
import { DropsError, classifyDropsError } from "./opensea-drops";
import { SEADROP_ADDRESS } from "./seadrop-public";

const MP = "(uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)";
const IF = new Interface([`function mintAllowList(address,address,address,uint256,${MP},bytes32[]) payable`]);
const NFT = "0x1111111111111111111111111111111111111111";
const NOW = Math.floor(Date.now() / 1000);
const CALLDATA = IF.encodeFunctionData("mintAllowList", [
  NFT,
  "0x3333333333333333333333333333333333333333",
  "0x" + "0".repeat(40),
  1,
  [0n, 3, NOW - 60, NOW + 7200, 1, 0, 1000, true],
  ["0x" + "aa".repeat(32)],
]);

const wallets = ["0x" + "1".repeat(64), "0x" + "2".repeat(64), "0x" + "3".repeat(64)].map(
  (k) => new Wallet(k)
);

const base = (over: Partial<PrepareOpts> = {}): PrepareOpts => ({
  slug: "vessels",
  quantity: 1,
  chainId: 4663,
  rpcUrl: "http://unused",
  expectedContract: NFT,
  nonceFor: async () => 7,
  skipEligibility: true,
  ...over,
});

const FEES = { maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, gasLimit: 200000 };

// Stub the transport at the module boundary, so the split is tested without
// depending on Drops entitlement the key does not currently have.
vi.mock("./opensea-drops", async (orig) => {
  const real = await orig<Record<string, any>>();
  return {
    ...real,
    buildDropMintTransaction: vi.fn(async () => ({ to: SEADROP_ADDRESS, data: CALLDATA, value: 0n })),
    checkDropEligibility: vi.fn(async () => ({ eligible: true })),
  };
});

describe("preparation happens before the open", () => {
  it("ends READY holding a validated transaction", async () => {
    const p = await prepareOpenSeaMint(wallets[0].address, base());
    expect(p.state).toBe("READY");
    expect(p.tx?.to).toBe(SEADROP_ADDRESS);
    expect(p.decoded?.kind).toBe("allowlist");
    expect(p.timings.t2).toBeDefined();
  });

  it("pre-signs when given a signer, so firing is one write", async () => {
    const p = await prepareOpenSeaMint(
      wallets[0].address,
      base({ signerFor: () => wallets[0], fees: FEES })
    );
    expect(p.raw).toMatch(/^0x/);
  });

  it("reads each wallet's OWN nonce", async () => {
    // A shared counter puts two transactions on one number and loses one.
    const seen: string[] = [];
    const opts = base({
      nonceFor: async (a) => {
        seen.push(a);
        return a === wallets[1].address ? 3 : 9;
      },
    });
    const a = await prepareOpenSeaMint(wallets[0].address, opts);
    const b = await prepareOpenSeaMint(wallets[1].address, opts);
    expect(a.nonce).toBe(9);
    expect(b.nonce).toBe(3);
    expect(seen).toEqual([wallets[0].address, wallets[1].address]);
  });

  it("refuses to sign for a wallet the authorisation was not issued to", async () => {
    // The minter is named in the request. A different signer produces a
    // transaction the contract rejects.
    const p = await prepareOpenSeaMint(
      wallets[0].address,
      base({ signerFor: () => wallets[1], fees: FEES })
    );
    expect(p.state).toBe("FAILED");
    expect(p.failure?.code).toBe("INVALID_AUTHORIZATION");
  });

  it("never throws, so one wallet's refusal cannot stop the rest", async () => {
    const p = await prepareOpenSeaMint(
      wallets[0].address,
      base({
        nonceFor: async () => {
          throw new Error("rpc down");
        },
      })
    );
    expect(p.state).not.toBe("READY");
    expect(p.failure).toBeDefined();
  });
});

describe("firing does no preparation", () => {
  it("submits pre-signed bytes and nothing else", async () => {
    const p = await prepareOpenSeaMint(
      wallets[0].address,
      base({ signerFor: () => wallets[0], fees: FEES })
    );
    const submit = vi.fn(async () => "0xhash");
    const out = await firePreparedMint(p, { submit });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(out.state).toBe("SUBMITTED");
    expect(out.txHash).toBe("0xhash");
  });

  it("will not fire a wallet that never became READY", async () => {
    const submit = vi.fn(async () => "0xhash");
    await firePreparedMint(newPrepared(wallets[0].address, 1), { submit });
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("retry policy", () => {
  it("retries only what can change", () => {
    for (const c of ["RPC_ERROR", "API_ERROR", "NONCE_ERROR"] as const) {
      expect(RETRYABLE.has(c), c).toBe(true);
    }
    for (const c of [
      "NOT_ELIGIBLE",
      "WALLET_LIMIT_EXCEEDED",
      "SUPPLY_EXHAUSTED",
      "DROP_ENDED",
      "INVALID_AUTHORIZATION",
      "INSUFFICIENT_BALANCE",
    ] as const) {
      expect(RETRYABLE.has(c), c).toBe(false);
    }
  });

  it("names the cause rather than saying the mint failed", () => {
    expect(fromDropsError(new DropsError("x", "SUPPLY_EXHAUSTED", false)).code).toBe("SUPPLY_EXHAUSTED");
    expect(fromDropsError(new Error("insufficient funds for gas")).code).toBe("INSUFFICIENT_BALANCE");
  });

  it("reads a 401 as an invalid key, not as Drops needing special access", () => {
    // Measured with and without the key: every endpoint that answers 200 does
    // so with NO key at all, and every endpoint that checks one rejects this
    // key -- /chain/{c}/account/{a}/nfts as well as /drops. So the key is
    // invalid everywhere, and pointing someone at "request Drops access"
    // would send them somewhere that does not exist.
    const e = classifyDropsError(401, '{"errors":["Invalid API key"]}');
    expect(e.code).toBe("INVALID_KEY");
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("every endpoint that checks one");
  });

  it("distinguishes no key at all from a rejected one", () => {
    const e = classifyDropsError(401, '{"errors":["Missing an API Key, which is required"]}');
    expect(e.message).toContain("No OpenSea API key is set");
  });

  it("treats 429 and 5xx as worth another go", () => {
    expect(classifyDropsError(429, "").retryable).toBe(true);
    expect(classifyDropsError(503, "").retryable).toBe(true);
  });
});

describe("many wallets, each on its own authorisation", () => {
  it("prepares them concurrently and keeps them separate", async () => {
    const c = new MultiWalletController(base({ concurrency: 3 }));
    const out = await c.prepareAll(wallets.map((w) => w.address));
    expect(out).toHaveLength(3);
    expect(c.ready).toHaveLength(3);
    expect(new Set(out.map((p) => p.address)).size).toBe(3);
  });

  it("fires every ready wallet from one opening moment", async () => {
    const c = new MultiWalletController(
      base({
        concurrency: 3,
        signerFor: (a) => wallets.find((w) => w.address === a)!,
        fees: FEES,
      })
    );
    await c.prepareAll(wallets.map((w) => w.address));
    const submit = vi.fn(async () => "0x" + Math.random().toString(16).slice(2));
    const fired = await c.fireAll({ submit }, 1_000_000);
    expect(fired).toHaveLength(3);
    expect(submit).toHaveBeenCalledTimes(3);
    // Measured from the open, not from when each happened to run.
    for (const p of fired) expect(p.timings.t3).toBe(1_000_000);
  });

  it("says which wallet is in which state", async () => {
    const c = new MultiWalletController(base());
    await c.prepareAll([wallets[0].address]);
    expect(c.summary()[0]).toContain("READY");
  });
});

describe("latency reporting", () => {
  it("measures intervals and claims nothing it did not measure", () => {
    const r = latencies({ t0: 0, t1: 40, t2: 50, t3: 1000, t4: 1001, t5: 1002, t6: 1020 });
    expect(r.prepareLatency).toBe(50);
    expect(r.signingLatency).toBe(1);
    expect(r.rpcSubmissionLatency).toBe(18);
    expect(r.totalFireLatency).toBe(20);
  });

  it("leaves a phase that did not happen undefined rather than zero", () => {
    expect(latencies({ t0: 0 }).totalFireLatency).toBeUndefined();
  });
});
