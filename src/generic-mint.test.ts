import { describe, it, expect, vi, beforeEach } from "vitest";
import { AbiCoder, Interface, Wallet, getAddress, id } from "ethers";
import { GenericMintController, describeDryRun, prepareGenericMint } from "./generic-mint";
import { firePreparedMint, latencies } from "./mint-prepare";
import { MintSpec, specFromSignature } from "./mint-spec";
import { KNOWN_MINTS } from "./mint-signatures";

// The split this file exists for: everything that can legitimately happen
// before the stage opens happens before it, and firing is one socket write.

const CODER = AbiCoder.defaultAbiCoder();
const CONTRACT = getAddress("0x" + "11".repeat(20));
const PROOF = ["0x" + "aa".repeat(32)];

const wallets = ["0x" + "1".repeat(64), "0x" + "2".repeat(64), "0x" + "3".repeat(64)].map(
  (k) => new Wallet(k)
);

// What the fake node does. Tests set this; nothing else touches the network.
let callBehaviour: (tx: { from: string; data: string; value: bigint }) => string = () => "0x";

vi.mock("./rpc-provider", () => ({
  createProvider: () => ({
    call: async (tx: { from: string; data: string; value: bigint }) => callBehaviour(tx),
    estimateGas: async () => 120_000n,
  }),
}));

const revertWith = (message: string) => {
  const err: Error & { data?: string } = new Error("execution reverted");
  err.data = "0x08c379a0" + CODER.encode(["string"], [message]).slice(2);
  throw err;
};

const find = (signature: string) => KNOWN_MINTS.find((m) => m.signature === signature)!;
const publicSpec = (over: Partial<MintSpec> = {}): MintSpec => ({
  ...specFromSignature(find("mint(uint256)"), {
    chainId: 1,
    contract: CONTRACT,
    quantity: 2,
    priceWei: 1_000_000_000_000_000n,
  }),
  ...over,
});
const merkleSpec = () =>
  specFromSignature(find("allowlistMint(uint256,bytes32[])"), {
    chainId: 1,
    contract: CONTRACT,
    quantity: 2,
    priceWei: 0n,
  });

const FEES = { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 0n, gasLimit: 200_000 };
const base = (over: Record<string, unknown> = {}) => ({
  spec: publicSpec(),
  rpcUrl: "http://unused",
  nonceFor: async () => 7,
  ...over,
});

beforeEach(() => {
  callBehaviour = () => "0x";
});

describe("preparing one wallet before the open", () => {
  it("ends READY holding a transaction it has simulated", async () => {
    const p = await prepareGenericMint(wallets[0].address, base() as never);
    expect(p.state).toBe("READY");
    expect(p.tx?.to).toBe(CONTRACT);
    expect(p.tx?.value).toBe(2_000_000_000_000_000n);
    expect(p.timings.t2).toBeDefined();
  });

  it("pre-signs when given a signer, so firing is one write", async () => {
    const p = await prepareGenericMint(
      wallets[0].address,
      base({ signerFor: () => wallets[0], fees: { ...FEES } }) as never
    );
    expect(p.raw).toMatch(/^0x/);
  });

  it("simulates AS the wallet, because a mint checks msg.sender", async () => {
    const seen: string[] = [];
    callBehaviour = (tx) => {
      seen.push(tx.from);
      return "0x";
    };
    await prepareGenericMint(wallets[1].address, base() as never);
    expect(seen).toEqual([wallets[1].address]);
  });

  it("reads each wallet's OWN nonce", async () => {
    // A shared counter puts two transactions on one number and loses one.
    const opts = base({
      nonceFor: async (a: string) => (a === wallets[1].address ? 3 : 9),
    });
    const a = await prepareGenericMint(wallets[0].address, opts as never);
    const b = await prepareGenericMint(wallets[1].address, opts as never);
    expect(a.nonce).toBe(9);
    expect(b.nonce).toBe(3);
  });

  it("never throws, so one wallet's failure cannot stop the rest", async () => {
    const p = await prepareGenericMint(
      wallets[0].address,
      base({
        nonceFor: async () => {
          throw new Error("rpc down");
        },
      }) as never
    );
    expect(p.state).not.toBe("READY");
    expect(p.failure?.code).toBe("RPC_ERROR");
  });
});

describe("what simulation is allowed to veto", () => {
  it("stays READY when the only problem is that the stage has not opened", async () => {
    // The whole design rests on this. Simulating an hour early SHOULD revert
    // with "not started"; treating that as a preparation failure would make
    // preparing ahead impossible, which is the entire point.
    callBehaviour = () => revertWith("Sale not started");
    const p = await prepareGenericMint(wallets[0].address, base() as never);
    expect(p.state).toBe("READY");
    expect(p.summary).toContain("not open yet");
  });

  it("refuses a wallet whose proof the contract rejects", async () => {
    callBehaviour = () => revertWith("Invalid merkle proof");
    const p = await prepareGenericMint(
      wallets[0].address,
      base({
        spec: merkleSpec(),
        authFor: async (a: string) => ({ address: a, proof: PROOF }),
      }) as never
    );
    expect(p.state).toBe("INELIGIBLE");
    expect(p.failure?.code).toBe("NOT_ELIGIBLE");
  });

  it("refuses a sold-out mint rather than arming it", async () => {
    callBehaviour = () => revertWith("Sold out");
    const p = await prepareGenericMint(wallets[0].address, base() as never);
    expect(p.failure?.code).toBe("SUPPLY_EXHAUSTED");
  });

  it("can be switched off for a caller that has already simulated", async () => {
    callBehaviour = () => revertWith("Sold out");
    const p = await prepareGenericMint(wallets[0].address, base({ simulate: false }) as never);
    expect(p.state).toBe("READY");
  });

  it("uses the node's gas estimate when one is offered", async () => {
    const p = await prepareGenericMint(
      wallets[0].address,
      base({ estimateGas: true, fees: { ...FEES }, signerFor: () => wallets[0] }) as never
    );
    // 120,000 measured, plus margin for the state moving before the open.
    expect(p.gasLimit).toBe(150_000);
  });

  it("does not leak one wallet's estimate into the others", async () => {
    // Every wallet on a controller shares one options object. Writing a
    // measured limit back into it would size wallet B's transaction from
    // wallet A's simulation.
    const fees = { ...FEES };
    const c = new GenericMintController(
      base({ estimateGas: true, fees, concurrency: 3 }) as never
    );
    await c.prepareAll(wallets.map((w) => w.address));
    expect(fees.gasLimit).toBe(200_000);
    for (const p of c.ready) expect(p.gasLimit).toBe(150_000);
  });
});

describe("authorisation is never borrowed", () => {
  it("refuses an authorisation issued to a different wallet", async () => {
    const p = await prepareGenericMint(
      wallets[0].address,
      base({
        spec: merkleSpec(),
        authFor: async () => ({ address: wallets[1].address, proof: PROOF }),
      }) as never
    );
    expect(p.state).toBe("FAILED");
    expect(p.failure?.code).toBe("INVALID_AUTHORIZATION");
  });

  it("refuses to sign with a wallet the mint was not prepared for", async () => {
    const p = await prepareGenericMint(
      wallets[0].address,
      base({ signerFor: () => wallets[1], fees: { ...FEES } }) as never
    );
    expect(p.failure?.code).toBe("INVALID_AUTHORIZATION");
  });

  it("marks a gated wallet with no proof ineligible, not ready", async () => {
    const p = await prepareGenericMint(
      wallets[0].address,
      base({ spec: merkleSpec(), authFor: async () => null }) as never
    );
    expect(p.state).toBe("INELIGIBLE");
    expect(p.failure?.code).toBe("NOT_ELIGIBLE");
  });

  it("lets a public mint through with no authorisation at all", async () => {
    const p = await prepareGenericMint(
      wallets[0].address,
      base({ authFor: async () => null }) as never
    );
    expect(p.state).toBe("READY");
  });
});

describe("money checks that happen before signing", () => {
  it("refuses a wallet that cannot cover the value plus the reservation", async () => {
    // A node reserves gasLimit x maxFeePerGas plus the value before it will
    // accept the transaction at all, so this is refused by the protocol long
    // before the mint is attempted. Better known now than at T-0.
    const p = await prepareGenericMint(
      wallets[0].address,
      base({ fees: { ...FEES }, balanceFor: async () => 1n }) as never
    );
    expect(p.state).toBe("FAILED");
    expect(p.failure?.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("lets a funded wallet through", async () => {
    const p = await prepareGenericMint(
      wallets[0].address,
      base({ fees: { ...FEES }, balanceFor: async () => 10n ** 18n }) as never
    );
    expect(p.state).toBe("READY");
  });
});

describe("many wallets, each on its own everything", () => {
  it("prepares them concurrently and keeps them separate", async () => {
    const c = new GenericMintController(base({ concurrency: 3 }) as never);
    const out = await c.prepareAll(wallets.map((w) => w.address));
    expect(out).toHaveLength(3);
    expect(c.ready).toHaveLength(3);
    expect(new Set(out.map((p) => p.address)).size).toBe(3);
  });

  it("returns results in the order the wallets were given", async () => {
    const c = new GenericMintController(base({ concurrency: 3 }) as never);
    const addresses = wallets.map((w) => w.address);
    const out = await c.prepareAll(addresses);
    expect(out.map((p) => p.address)).toEqual(addresses);
  });

  it("fires every ready wallet from one opening moment", async () => {
    const c = new GenericMintController(
      base({
        concurrency: 3,
        signerFor: (a: string) => wallets.find((w) => w.address === a)!,
        fees: { ...FEES },
      }) as never
    );
    await c.prepareAll(wallets.map((w) => w.address));
    const submit = vi.fn(async () => "0x" + "ab".repeat(32));
    const fired = await c.fireAll({ submit }, 1_000_000);

    expect(submit).toHaveBeenCalledTimes(3);
    // Four separate transactions from four EOAs -- there is no such thing as
    // one EVM transaction from several, and pretending otherwise would
    // produce calldata that reverts.
    expect(new Set((submit.mock.calls as unknown as string[][]).map((c) => c[0])).size).toBe(3);
    for (const p of fired) expect(p.timings.t3).toBe(1_000_000);
  });

  it("keeps a failed wallet out of the firing set", async () => {
    let first = true;
    callBehaviour = () => {
      if (first) {
        first = false;
        return revertWith("Sold out");
      }
      return "0x";
    };
    const c = new GenericMintController(base({ concurrency: 1, retries: 1 }) as never);
    await c.prepareAll(wallets.map((w) => w.address));
    expect(c.ready).toHaveLength(2);
    expect(c.summary().join("\n")).toContain("SUPPLY_EXHAUSTED");
  });

  it("measures latency rather than claiming it", async () => {
    const c = new GenericMintController(
      base({ signerFor: () => wallets[0], fees: { ...FEES } }) as never
    );
    await c.prepareAll([wallets[0].address]);
    await c.fireAll({ submit: async () => "0xhash" }, Date.now());
    const l = latencies([...c.wallets.values()][0].timings);
    expect(l.totalFireLatency).toBeGreaterThanOrEqual(0);
    expect(c.report()[0]).toContain("open→hash");
  });
});

describe("firing does no preparation", () => {
  it("submits pre-signed bytes and nothing else", async () => {
    const p = await prepareGenericMint(
      wallets[0].address,
      base({ signerFor: () => wallets[0], fees: { ...FEES } }) as never
    );
    const submit = vi.fn(async () => "0xhash");
    const out = await firePreparedMint(p, { submit });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toBe(p.raw);
    expect(out.state).toBe("SUBMITTED");
  });

  it("will not fire a wallet that never became READY", async () => {
    callBehaviour = () => revertWith("Sold out");
    const p = await prepareGenericMint(wallets[0].address, base() as never);
    const submit = vi.fn(async () => "0xhash");
    await firePreparedMint(p, { submit });
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("the dry run", () => {
  it("reports what would be sent and signs nothing", async () => {
    const c = new GenericMintController(base({ concurrency: 3 }) as never);
    const out = await c.prepareAll(wallets.map((w) => w.address));
    const text = describeDryRun(publicSpec(), out);

    expect(text).toContain("3 of 3 wallet(s) would send");
    expect(text).toContain("Nothing was signed or broadcast");
    for (const p of out) expect(p.raw).toBeUndefined();
  });

  it("warns when a quantity above one means several transactions", async () => {
    const one = specFromSignature(find("mint()"), {
      chainId: 1,
      contract: CONTRACT,
      quantity: 5,
      priceWei: 0n,
    });
    expect(describeDryRun(one, [])).toContain("5 separate");
  });
});
