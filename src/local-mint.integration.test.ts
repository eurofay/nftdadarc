import { describe, it, expect, afterEach, vi } from "vitest";
import { keccak256 } from "ethers";
import { localPublicSnipe, LocalSnipeOpts } from "./local-mint";
import { encodeMintPublic, SEADROP_ADDRESS, LocalMintPlan } from "./seadrop-public";
import { startMockRpc, MockRpc } from "./test-support/mock-rpc";

// A well-known, publicly documented test-only private key (Hardhat's default
// account #0). No real funds are ever associated with it.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const NFT = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

function basePlan(): LocalMintPlan {
  return {
    to: SEADROP_ADDRESS,
    data: encodeMintPublic(NFT, RECIPIENT, 1),
    value: 0n,
    drop: {
      mintPrice: 0n,
      startTime: 0,
      endTime: 9_999_999_999,
      maxTotalMintableByWallet: 0,
      feeBps: 0,
      restrictFeeRecipients: false,
    },
    feeRecipient: RECIPIENT,
  };
}

function baseOpts(rpcUrl: string, plan: LocalMintPlan): LocalSnipeOpts {
  return {
    nftContract: NFT,
    quantity: 1,
    walletKeys: [TEST_KEY],
    rpcUrls: [rpcUrl],
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFee: 100_000_000n,
    gasLimit: 250_000,
    targetStart: null, // fire immediately — skip the countdown wait
    plan,
  };
}

let mock: MockRpc | undefined;
let logs: string[];

function captureLogs() {
  logs = [];
  return vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
    logs.push(args.join(" "));
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await mock?.close();
  mock = undefined;
});

describe("localPublicSnipe (against a real mock RPC node)", () => {
  it("signs, broadcasts, and reports a successful mint", async () => {
    const logSpy = captureLogs();

    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getTransactionCount: () => "0x0",
      eth_sendRawTransaction: (params) => keccak256(params[0]),
      eth_getTransactionReceipt: () => ({
        blockNumber: "0x64",
        transactionIndex: "0x1",
        gasUsed: "0x5208",
        status: "0x1",
      }),
    });

    await localPublicSnipe(baseOpts(mock.url, basePlan()));

    const text = logs.join("\n");
    expect(text).toContain("tx(s) signed and serialised");
    expect(text).toContain("DISPATCHED 1 tx(s)");
    expect(text).toContain("LOCAL PUBLIC MINT COMPLETE");
    expect(text).not.toContain("REJECTED");

    const sent = mock.calls.filter((c) => c.method === "eth_sendRawTransaction");
    // One dummy warm-up call plus one real signed transaction.
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(mock.calls.some((c) => c.method === "eth_getTransactionReceipt")).toBe(true);

    logSpy.mockRestore();
  });

  it("reports every wallet as rejected when no RPC accepts the transaction", async () => {
    const logSpy = captureLogs();

    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getTransactionCount: () => "0x0",
      eth_sendRawTransaction: () => {
        throw new Error("nonce too low");
      },
    });

    await localPublicSnipe(baseOpts(mock.url, basePlan()));

    const text = logs.join("\n");
    expect(text).toContain("REJECTED by every RPC");
    expect(text).toContain("NOTHING WAS BROADCAST");
    expect(mock.calls.some((c) => c.method === "eth_getTransactionReceipt")).toBe(false);

    logSpy.mockRestore();
  });

  it("blasts to every configured RPC endpoint, not just the first", async () => {
    const logSpy = captureLogs();

    const mockA = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getTransactionCount: () => "0x0",
      eth_sendRawTransaction: (params) => keccak256(params[0]),
      eth_getTransactionReceipt: () => ({
        blockNumber: "0x64",
        transactionIndex: "0x1",
        gasUsed: "0x5208",
        status: "0x1",
      }),
    });
    const mockB = await startMockRpc({
      eth_sendRawTransaction: (params) => keccak256(params[0]),
    });

    try {
      const opts = baseOpts(mockA.url, basePlan());
      opts.rpcUrls = [mockA.url, mockB.url];
      await localPublicSnipe(opts);

      expect(mockA.calls.some((c) => c.method === "eth_sendRawTransaction")).toBe(true);
      expect(mockB.calls.some((c) => c.method === "eth_sendRawTransaction")).toBe(true);
    } finally {
      await mockA.close();
      await mockB.close();
      logSpy.mockRestore();
    }
  });
});
