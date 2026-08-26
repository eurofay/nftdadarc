import { describe, it, expect, afterEach, vi } from "vitest";
import { Interface, Transaction, Wallet, keccak256 } from "ethers";
import { runCopyMintWatcher } from "./copy-mint";
import { SEADROP_ADDRESS, decodeMintPublic, encodeMintPublic } from "./seadrop-public";
import { CHAINS } from "./chains";
import { startMockRpc, MockRpc } from "./test-support/mock-rpc";

const CALL_IFACE = new Interface([
  "function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))",
  "function getAllowedFeeRecipients(address nftContract) view returns (address[])",
]);

const SOURCE_KEY = "0xad6c4582d7bae64497e12e590deb375c3e5e1827044300f6a9d98f06c6dae4bd"; // watched wallet
const COPIER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // your wallet
const NFT = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

async function signedMintTxRpcShape(nftContract: string) {
  const wallet = new Wallet(SOURCE_KEY);
  const raw = await wallet.signTransaction({
    to: SEADROP_ADDRESS,
    data: encodeMintPublic(nftContract, RECIPIENT, 1),
    value: 0n,
    nonce: 0,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
    gasLimit: 250_000n,
    type: 2,
    chainId: 8453n,
  });
  const parsed = Transaction.from(raw);
  return {
    hash: parsed.hash,
    from: parsed.from,
    to: parsed.to,
    input: parsed.data,
    nonce: "0x0",
    gas: `0x${parsed.gasLimit.toString(16)}`,
    value: "0x0",
    type: "0x2",
    chainId: "0x2105",
    maxFeePerGas: `0x${(parsed.maxFeePerGas ?? 0n).toString(16)}`,
    maxPriorityFeePerGas: `0x${(parsed.maxPriorityFeePerGas ?? 0n).toString(16)}`,
    accessList: [],
    v: `0x${parsed.signature!.v.toString(16)}`,
    r: parsed.signature!.r,
    s: parsed.signature!.s,
  };
}

function blockShape(number: number, transactions: any[]) {
  return {
    number: `0x${number.toString(16)}`,
    hash: `0x${number.toString(16).padStart(64, "0")}`,
    parentHash: `0x${"0".repeat(64)}`,
    timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
    nonce: "0x0000000000000000",
    difficulty: "0x0",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    miner: "0x0000000000000000000000000000000000000000",
    extraData: "0x",
    baseFeePerGas: "0x0",
    transactions,
  };
}

let mock: MockRpc | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await mock?.close();
  mock = undefined;
});

// The drop's real max-per-wallet, used by every test below.
const DROP_MAX_PER_WALLET = 3;

async function setUp(quantityPerWallet: number | undefined) {
  const tx = await signedMintTxRpcShape(NFT);
  let block = 100;
  const sentQuantities: bigint[] = [];

  mock = await startMockRpc({
    eth_chainId: () => "0x2105",
    eth_blockNumber: () => `0x${(++block).toString(16)}`,
    eth_getBlockByNumber: () => blockShape(block, [tx]),
    eth_call: (params) => {
      const call = CALL_IFACE.parseTransaction({ data: params[0].data })!;
      if (call.name === "getPublicDrop") {
        return CALL_IFACE.encodeFunctionResult("getPublicDrop", [
          [0n, 1, 0, DROP_MAX_PER_WALLET, 0, false],
        ]);
      }
      return CALL_IFACE.encodeFunctionResult("getAllowedFeeRecipients", [[RECIPIENT]]);
    },
    eth_getTransactionCount: () => "0x0",
    eth_sendRawTransaction: (params) => {
      const decoded = decodeMintPublic(Transaction.from(params[0]).data);
      if (decoded) sentQuantities.push(decoded.quantity);
      return keccak256(params[0]);
    },
    eth_getTransactionReceipt: () => ({
      blockNumber: "0x64",
      transactionIndex: "0x1",
      gasUsed: "0x5208",
      status: "0x1",
    }),
  });

  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const run = runCopyMintWatcher({
    chain: CHAINS.find((c) => c.key === "base")!,
    rpcUrls: [mock.url],
    walletKeys: [COPIER_KEY],
    watchTargets: [new Wallet(SOURCE_KEY).address],
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFee: 100_000_000n,
    gasLimit: 250_000,
    pollIntervalMs: 30,
    maxPriceEth: 1,
    quantityPerWallet,
  });

  // Needs enough ticks to clear the 2-block reorg-safety margin the watcher
  // now applies before it'll even attempt its first scan.
  await new Promise((r) => setTimeout(r, 1500));
  process.emit("SIGINT" as any);
  await run;
  logSpy.mockRestore();

  return { sentQuantities };
}

describe("runCopyMintWatcher quantity cap (regression: was quantityPerWallet ?? max, now Math.min)", () => {
  it("fills in the drop's smaller max when your chosen cap is higher", { timeout: 15000 }, async () => {
    const { sentQuantities } = await setUp(10); // chose 10, drop only allows 3
    expect(sentQuantities).toEqual([3n]);
  });

  it("respects your smaller cap when it's under the drop's max", { timeout: 15000 }, async () => {
    const { sentQuantities } = await setUp(2); // chose 2, drop allows 3
    expect(sentQuantities).toEqual([2n]);
  });

  it("uses the drop's true max when no cap is set at all", { timeout: 15000 }, async () => {
    const { sentQuantities } = await setUp(undefined);
    expect(sentQuantities).toEqual([3n]);
  });
});
