import { describe, it, expect, afterEach, vi } from "vitest";
import { Interface, Transaction, Wallet, keccak256 } from "ethers";
import { runCopyMintWatcher } from "./copy-mint";
import { SEADROP_ADDRESS, decodeMintPublic } from "./seadrop-public";
import { CHAINS } from "./chains";
import { clearProviderCache } from "./rpc-provider";
import { startMockRpc, MockRpc } from "./test-support/mock-rpc";

const EVENT_IFACE = new Interface([
  "event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)",
]);

const CALL_IFACE = new Interface([
  "function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))",
  "function getAllowedFeeRecipients(address nftContract) view returns (address[])",
]);

const SOURCE_KEY = "0xad6c4582d7bae64497e12e590deb375c3e5e1827044300f6a9d98f06c6dae4bd"; // watched wallet
const COPIER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // your wallet
const NFT = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

function mintLog(nftContract: string, minter: string, blockNumber: number) {
  const { data, topics } = EVENT_IFACE.encodeEventLog(EVENT_IFACE.getEvent("SeaDropMint")!, [
    nftContract,
    minter,
    RECIPIENT,
    minter,
    1n,
    0n,
    0n,
    0n,
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
  clearProviderCache();
  await mock?.close();
  mock = undefined;
});

// The drop's real max-per-wallet, used by every test below.
const DROP_MAX_PER_WALLET = 3;

async function setUp(quantityPerWallet: number | undefined) {
  let block = 100;
  const sentQuantities: bigint[] = [];

  mock = await startMockRpc({
    eth_chainId: () => "0x2105",
    eth_blockNumber: () => `0x${(++block).toString(16)}`,
    eth_getLogs: () => [mintLog(NFT, new Wallet(SOURCE_KEY).address, block)],
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

// The watcher used to start at the chain head, so any mint older than its
// own start time was invisible. That looked reasonable until the drops were
// measured: of 28 collections watched wallets minted over 12 hours, 25 were
// still open, with windows from 1 to 365 days. A copy signal stays good for
// as long as the drop does, so the backfill is where most of the value is.
async function setUpBackfill(backfillBlocks: number) {
  const HEAD = 1000;
  const PAST = 900; // 100 blocks before the watcher ever wakes up
  const sentQuantities: bigint[] = [];
  const past = mintLog(NFT, new Wallet(SOURCE_KEY).address, PAST);

  mock = await startMockRpc({
    eth_chainId: () => "0x2105",
    eth_blockNumber: () => `0x${HEAD.toString(16)}`,
    // Honors the requested range, so a scan that never looks back finds nothing.
    eth_getLogs: (params) => {
      const from = parseInt(params[0].fromBlock, 16);
      const to = parseInt(params[0].toBlock, 16);
      return PAST >= from && PAST <= to ? [past] : [];
    },
    eth_call: (params) => {
      const call = CALL_IFACE.parseTransaction({ data: params[0].data })!;
      if (call.name === "getPublicDrop") {
        return CALL_IFACE.encodeFunctionResult("getPublicDrop", [[0n, 1, 0, DROP_MAX_PER_WALLET, 0, false]]);
      }
      return CALL_IFACE.encodeFunctionResult("getAllowedFeeRecipients", [[RECIPIENT]]);
    },
    eth_getTransactionCount: () => "0x0",
    eth_sendRawTransaction: (params) => {
      const decoded = decodeMintPublic(Transaction.from(params[0]).data);
      if (decoded) sentQuantities.push(decoded.quantity);
      return keccak256(params[0]);
    },
    eth_getTransactionReceipt: () => ({ blockNumber: "0x64", transactionIndex: "0x1", gasUsed: "0x5208", status: "0x1" }),
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
    backfillBlocks,
    logChunkBlocks: 500,
  });

  await new Promise((r) => setTimeout(r, 1500));
  process.emit("SIGINT" as any);
  await run;
  logSpy.mockRestore();
  return { sentQuantities };
}

describe("runCopyMintWatcher startup backfill", () => {
  it("copies a mint that happened before it started", { timeout: 15000 }, async () => {
    const { sentQuantities } = await setUpBackfill(200);
    expect(sentQuantities).toEqual([3n]);
  });

  it("ignores history when the backfill is switched off", { timeout: 15000 }, async () => {
    // Documents the old behaviour, and proves the backfill is what changed it.
    const { sentQuantities } = await setUpBackfill(0);
    expect(sentQuantities).toEqual([]);
  });
});

// A node reserves gasLimit x maxFeePerGas upfront whatever the tx ends up
// paying, so a wallet under that can't send at all. Measured on the live
// store: the ceiling was 0.0005 ETH and all three wallets held less, so
// every copy would have failed on funds — once per collection, and the
// backfill above surfaces many collections at once.
async function setUpFunding(balanceWei: bigint) {
  const HEAD = 1000;
  const sentQuantities: bigint[] = [];
  const skips: string[] = [];
  const log = mintLog(NFT, new Wallet(SOURCE_KEY).address, HEAD - 5);

  mock = await startMockRpc({
    eth_chainId: () => "0x2105",
    eth_blockNumber: () => `0x${HEAD.toString(16)}`,
    eth_getBalance: () => `0x${balanceWei.toString(16)}`,
    eth_getLogs: (params) => {
      const from = parseInt(params[0].fromBlock, 16);
      const to = parseInt(params[0].toBlock, 16);
      return HEAD - 5 >= from && HEAD - 5 <= to ? [log] : [];
    },
    eth_call: (params) => {
      const call = CALL_IFACE.parseTransaction({ data: params[0].data })!;
      if (call.name === "getPublicDrop") {
        return CALL_IFACE.encodeFunctionResult("getPublicDrop", [[0n, 1, 0, DROP_MAX_PER_WALLET, 0, false]]);
      }
      return CALL_IFACE.encodeFunctionResult("getAllowedFeeRecipients", [[RECIPIENT]]);
    },
    eth_getTransactionCount: () => "0x0",
    eth_sendRawTransaction: (params) => {
      const decoded = decodeMintPublic(Transaction.from(params[0]).data);
      if (decoded) sentQuantities.push(decoded.quantity);
      return keccak256(params[0]);
    },
    eth_getTransactionReceipt: () => ({ blockNumber: "0x64", transactionIndex: "0x1", gasUsed: "0x5208", status: "0x1" }),
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
    backfillBlocks: 50,
    logChunkBlocks: 500,
    onAttempt: (a) => { if (a.outcome === "skipped" && a.reason) skips.push(a.reason); },
  });

  await new Promise((r) => setTimeout(r, 1500));
  process.emit("SIGINT" as any);
  await run;
  logSpy.mockRestore();
  return { sentQuantities, skips };
}

describe("runCopyMintWatcher affordability pre-flight", () => {
  it("mints when the wallet can cover the upfront gas reservation", { timeout: 15000 }, async () => {
    const { sentQuantities } = await setUpFunding(10n ** 18n); // 1 ETH
    expect(sentQuantities).toEqual([3n]);
  });

  it("skips, with the shortfall named, when it cannot", { timeout: 15000 }, async () => {
    // 0.0001 ETH against a 250k x 2 gwei = 0.0005 ETH reservation.
    const { sentQuantities, skips } = await setUpFunding(10n ** 14n);
    expect(sentQuantities).toEqual([]);
    expect(skips.join(" ")).toContain("0.0005");
  });
});
