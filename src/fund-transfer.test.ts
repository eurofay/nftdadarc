import { describe, it, expect, afterEach } from "vitest";
import { parseEther, Transaction } from "ethers";
import { batchTransfer, estimateBatchCost } from "./fund-transfer";
import { startMockRpc, MockRpc } from "./test-support/mock-rpc";

const SOURCE_KEY = "0xad6c4582d7bae64497e12e590deb375c3e5e1827044300f6a9d98f06c6dae4bd";
const TARGET_1 = "0x1111111111111111111111111111111111111111";
const TARGET_2 = "0x2222222222222222222222222222222222222222";

let mock: MockRpc | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

describe("estimateBatchCost", () => {
  it("sums amount plus worst-case gas across every target", () => {
    const cost = estimateBatchCost(3, parseEther("0.01"), 2_000_000_000n);
    // 3 * (0.01 ETH + 21000 * 2 gwei)
    const perTarget = parseEther("0.01") + 21_000n * 2_000_000_000n;
    expect(cost).toBe(perTarget * 3n);
  });

  it("is zero for zero targets", () => {
    expect(estimateBatchCost(0, parseEther("1"), 2_000_000_000n)).toBe(0n);
  });
});

describe("batchTransfer (against a real mock RPC node)", () => {
  it("refuses to send anything when the source can't cover the worst case", async () => {
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getBalance: () => "0x0", // broke
      eth_getTransactionCount: () => "0x0",
    });

    const results = await batchTransfer({
      rpcUrl: mock.url,
      sourceKey: SOURCE_KEY,
      targets: [TARGET_1, TARGET_2],
      amountWei: parseEther("1"),
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFee: 100_000_000n,
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.txHash === null)).toBe(true);
    expect(results.every((r) => r.error?.includes("insufficient"))).toBe(true);
    expect(mock.calls.some((c) => c.method === "eth_sendRawTransaction")).toBe(false);
  });

  it("sends to every target with sequentially incrementing nonces and reports confirmations", async () => {
    const sentNonces: number[] = [];
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_blockNumber: () => "0x64",
      eth_getBalance: () => `0x${parseEther("10").toString(16)}`,
      eth_getTransactionCount: () => "0x5", // starting nonce 5
      eth_sendRawTransaction: (params) => {
        // Decode nonce from the raw tx to prove it incremented per send.
        const parsed = Transaction.from(params[0]);
        sentNonces.push(parsed.nonce);
        return parsed.hash;
      },
      eth_getTransactionReceipt: () => ({
        blockNumber: "0x64",
        transactionIndex: "0x0",
        gasUsed: "0x5208",
        status: "0x1",
      }),
    });

    const results = await batchTransfer({
      rpcUrl: mock.url,
      sourceKey: SOURCE_KEY,
      targets: [TARGET_1, TARGET_2],
      amountWei: parseEther("0.001"),
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFee: 100_000_000n,
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "SUCCESS")).toBe(true);
    expect(results.every((r) => r.txHash !== null)).toBe(true);
    expect(sentNonces).toEqual([5, 6]);
  });

  it("keeps going and reports individual failures rather than aborting the whole batch", async () => {
    let callCount = 0;
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_blockNumber: () => "0x64",
      eth_getBalance: () => `0x${parseEther("10").toString(16)}`,
      eth_getTransactionCount: () => "0x0",
      eth_sendRawTransaction: (params) => {
        callCount++;
        if (callCount === 1) throw new Error("nonce too low");
        return Transaction.from(params[0]).hash;
      },
      eth_getTransactionReceipt: () => ({
        blockNumber: "0x64",
        transactionIndex: "0x0",
        gasUsed: "0x5208",
        status: "0x1",
      }),
    });

    const results = await batchTransfer({
      rpcUrl: mock.url,
      sourceKey: SOURCE_KEY,
      targets: [TARGET_1, TARGET_2],
      amountWei: parseEther("0.001"),
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFee: 100_000_000n,
    });

    expect(results).toHaveLength(2);
    expect(results[0].txHash).toBeNull();
    expect(results[0].error).toContain("nonce too low");
    expect(results[1].status).toBe("SUCCESS");
  });
});
