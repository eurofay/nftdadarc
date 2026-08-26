import { describe, it, expect, afterEach, vi } from "vitest";
import { Interface, keccak256 } from "ethers";
import { runAutoMintWatcher } from "./auto-mint";
import { SEADROP_ADDRESS } from "./seadrop-public";
import { CHAINS } from "./chains";
import { startMockRpc, MockRpc } from "./test-support/mock-rpc";

const EVENTS_IFACE = new Interface([
  "event PublicDropUpdated(address indexed nftContract, tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients) publicDrop)",
]);
const CALL_IFACE = new Interface([
  "function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))",
  "function getAllowedFeeRecipients(address nftContract) view returns (address[])",
]);

const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const NFT = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

const LIVE_FREE_DROP = {
  mintPrice: 0n,
  startTime: 1, // already open
  endTime: 0, // no end
  maxTotalMintableByWallet: 3,
  feeBps: 0,
  restrictFeeRecipients: false,
};

function eventLog(nftContract: string, drop = LIVE_FREE_DROP, blockNumber = 50) {
  const fragment = EVENTS_IFACE.getEvent("PublicDropUpdated")!;
  const { data, topics } = EVENTS_IFACE.encodeEventLog(fragment, [
    nftContract,
    [drop.mintPrice, drop.startTime, drop.endTime, drop.maxTotalMintableByWallet, drop.feeBps, drop.restrictFeeRecipients],
  ]);
  return {
    address: SEADROP_ADDRESS,
    topics,
    data,
    blockNumber: `0x${blockNumber.toString(16)}`,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    transactionIndex: "0x0",
    blockHash: `0x${"a".repeat(64)}`,
    logIndex: "0x0",
    removed: false,
  };
}

let mock: MockRpc | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await mock?.close();
  mock = undefined;
});

describe("runAutoMintWatcher (against a real mock RPC node)", () => {
  it("detects a live free drop from an on-chain event and auto-fires the max mint per wallet", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let block = 100;
    const log = eventLog(NFT);

    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_blockNumber: () => `0x${(++block).toString(16)}`, // advances every call, forcing a scan each tick
      eth_getLogs: () => [log],
      eth_call: (params) => {
        const call = CALL_IFACE.parseTransaction({ data: params[0].data })!;
        if (call.name === "getPublicDrop") {
          const d = LIVE_FREE_DROP;
          return CALL_IFACE.encodeFunctionResult("getPublicDrop", [
            [d.mintPrice, d.startTime, d.endTime, d.maxTotalMintableByWallet, d.feeBps, d.restrictFeeRecipients],
          ]);
        }
        return CALL_IFACE.encodeFunctionResult("getAllowedFeeRecipients", [[RECIPIENT]]);
      },
      eth_getTransactionCount: () => "0x0",
      eth_sendRawTransaction: (params) => keccak256(params[0]),
      eth_getTransactionReceipt: () => ({
        blockNumber: "0x64",
        transactionIndex: "0x1",
        gasUsed: "0x5208",
        status: "0x1",
      }),
    });

    const run = runAutoMintWatcher({
      chain: CHAINS.find((c) => c.key === "base")!,
      rpcUrls: [mock.url],
      walletKeys: [TEST_KEY],
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFee: 100_000_000n,
      gasLimit: 250_000,
      pollIntervalMs: 20,
      maxMintsPerRun: 1, // stop itself once it fires once — no SIGINT needed
    });

    await run;

    const text = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(text).toContain("LIVE FREE MINT");
    expect(text).toContain("Reached AUTO_MAX_MINTS_PER_RUN");
    expect(mock.calls.some((c) => c.method === "eth_sendRawTransaction")).toBe(true);
  });

  it("never fires on a drop whose price is non-zero", { timeout: 15000 }, async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let block = 100;
    const paidDrop = { ...LIVE_FREE_DROP, mintPrice: 1_000_000_000_000_000n };
    const log = eventLog(NFT, paidDrop);

    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_blockNumber: () => `0x${(++block).toString(16)}`,
      eth_getLogs: () => [log],
    });

    let stopped = false;
    const run = runAutoMintWatcher({
      chain: CHAINS.find((c) => c.key === "base")!,
      rpcUrls: [mock.url],
      walletKeys: [TEST_KEY],
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFee: 100_000_000n,
      gasLimit: 250_000,
      pollIntervalMs: 60,
    }).then(() => {
      stopped = true;
    });

    await new Promise((r) => setTimeout(r, 200));
    process.emit("SIGINT" as any);
    await run;

    expect(stopped).toBe(true);
    expect(mock.calls.some((c) => c.method === "eth_sendRawTransaction")).toBe(false);
    const text = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(text).toContain("Stopped. Auto-fired 0 collection(s)");
  });

  it("stops the poll loop for good on SIGINT instead of only ending the awaited promise", { timeout: 15000 }, async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let block = 100;

    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_blockNumber: () => `0x${(++block).toString(16)}`,
      eth_getLogs: () => [],
    });

    const run = runAutoMintWatcher({
      chain: CHAINS.find((c) => c.key === "base")!,
      rpcUrls: [mock.url],
      walletKeys: [TEST_KEY],
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFee: 100_000_000n,
      gasLimit: 250_000,
      pollIntervalMs: 60, // deliberately not too tight — fewer real HTTP round trips = less flake under parallel test load
    });

    await new Promise((r) => setTimeout(r, 90));
    process.emit("SIGINT" as any);
    await run;

    const callsAtStop = mock.calls.length;
    // Give a would-be leaked loop several more poll intervals to prove it's
    // actually dead, not just that the awaited promise resolved.
    await new Promise((r) => setTimeout(r, 300));
    expect(mock.calls.length).toBe(callsAtStop);
  });
});
