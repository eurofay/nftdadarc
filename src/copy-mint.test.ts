import { describe, it, expect, afterEach } from "vitest";
import { Interface, Wallet, getAddress, zeroPadValue } from "ethers";
import { scanWatchedMints } from "./copy-mint";
import { scanSeaDropMints } from "./seadrop-events";
import { SEADROP_ADDRESS } from "./seadrop-public";
import { clearProviderCache } from "./rpc-provider";
import { startMockRpc, MockRpc } from "./test-support/mock-rpc";

const IFACE = new Interface([
  "event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)",
]);

const WATCHED = new Wallet("0xad6c4582d7bae64497e12e590deb375c3e5e1827044300f6a9d98f06c6dae4bd").address;
const OTHER = new Wallet("0xed2d4e86c549055cc9ac40a86cfa836773d4c82aa71d1ec5503011707b90dfb0").address;
const NFT = "0x1111111111111111111111111111111111111111";
const NFT_2 = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

function mintLog(nftContract: string, minter: string, blockNumber: number) {
  const { data, topics } = IFACE.encodeEventLog(IFACE.getEvent("SeaDropMint")!, [
    nftContract,
    minter,
    RECIPIENT,
    minter, // payer
    1n, // quantityMinted
    0n, // unitMintPrice
    0n, // feeBps
    0n, // dropStageIndex
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

// Mimics a real node: honors the block range AND the indexed-topic filter,
// so these tests actually prove the server-side filtering is right rather
// than filtering client-side after the fact.
function serveLogs(all: ReturnType<typeof mintLog>[]) {
  return (params: any[]) => {
    const { fromBlock, toBlock, topics } = params[0];
    const from = parseInt(fromBlock, 16);
    const to = parseInt(toBlock, 16);
    return all.filter((log) => {
      const bn = parseInt(log.blockNumber, 16);
      if (bn < from || bn > to) return false;
      return (topics as (string | string[] | null)[]).every((want, i) => {
        if (want === null || want === undefined) return true;
        const got = log.topics[i];
        return Array.isArray(want) ? want.includes(got) : want === got;
      });
    });
  };
}

let mock: MockRpc | undefined;

afterEach(async () => {
  clearProviderCache();
  await mock?.close();
  mock = undefined;
});

describe("scanWatchedMints (against a real mock RPC node)", () => {
  it("finds a mint made by a watched wallet", async () => {
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getLogs: serveLogs([mintLog(NFT, WATCHED, 100)]),
    });

    const found = await scanWatchedMints(mock.url, 100, 100, [WATCHED]);
    expect(found).toHaveLength(1);
    expect(found[0].from.toLowerCase()).toBe(WATCHED.toLowerCase());
    expect(found[0].nftContract.toLowerCase()).toBe(NFT);
    expect(found[0].blockNumber).toBe(100);
  });

  it("ignores a mint by a wallet that isn't on the watchlist", async () => {
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getLogs: serveLogs([mintLog(NFT, OTHER, 100)]),
    });

    const found = await scanWatchedMints(mock.url, 100, 100, [WATCHED]);
    expect(found).toHaveLength(0);
  });

  it("filters by minter server-side via the indexed topic, not after the fact", async () => {
    let sentTopics: any;
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getLogs: (params) => {
        sentTopics = params[0].topics;
        return [];
      },
    });

    await scanWatchedMints(mock.url, 100, 100, [WATCHED, OTHER]);
    // [SeaDropMint topic, any nftContract, (WATCHED OR OTHER)] — ethers
    // normalizes the OR-set's order, so compare as a set.
    expect(sentTopics[1]).toBeNull();
    expect([...sentTopics[2]].sort()).toEqual(
      [zeroPadValue(getAddress(WATCHED), 32), zeroPadValue(getAddress(OTHER), 32)].sort()
    );
  });

  it("only queries the shared SeaDrop contract's logs", async () => {
    let sentAddress: string | undefined;
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getLogs: (params) => {
        sentAddress = params[0].address;
        return [];
      },
    });

    await scanWatchedMints(mock.url, 100, 100, [WATCHED]);
    expect(sentAddress!.toLowerCase()).toBe(SEADROP_ADDRESS.toLowerCase());
  });

  it("covers every block in the range, not just the first chunk", async () => {
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getLogs: serveLogs([mintLog(NFT, WATCHED, 100), mintLog(NFT_2, WATCHED, 145)]),
    });

    // Spans 46 blocks — more than the default 10-block chunk.
    const found = await scanWatchedMints(mock.url, 100, 145, [WATCHED]);
    expect(found.map((f) => f.nftContract.toLowerCase())).toEqual([NFT, NFT_2]);
  });

  it("returns nothing for an empty range or empty watchlist, without calling the RPC", async () => {
    mock = await startMockRpc({ eth_getLogs: () => [] });
    expect(await scanWatchedMints(mock.url, 100, 1, [WATCHED])).toEqual([]);
    expect(await scanWatchedMints(mock.url, 1, 100, [])).toEqual([]);
    expect(mock.calls).toHaveLength(0);
  });
});

// Measured on Robinhood's public node with 19 watched wallets: 5 back-to-back
// eth_getLogs succeed, 15 do not. A 12-hour backfill is 44 calls, and before
// the retry below one throttled call threw away every chunk already fetched —
// the full scan failed every single time it was attempted.
describe("scanSeaDropMints resilience to a throttling node", () => {
  it("retries a throttled chunk instead of losing the whole scan", async () => {
    let calls = 0;
    const log = mintLog(NFT, WATCHED, 105);
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getLogs: (params) => {
        calls++;
        // Fail the first attempt the way a rate-limited node does.
        if (calls === 1) throw new Error("log query timed out");
        return serveLogs([log])(params);
      },
    });

    // chunkDelayMs is deliberately tiny; the retry must still outlast ethers'
    // ~250ms request cache on its own, or it would replay a cached failure.
    const found = await scanSeaDropMints(mock.url, 100, 110, [WATCHED], 50, {
      chunkDelayMs: 1,
      retriesPerChunk: 3,
    });

    expect(calls).toBeGreaterThan(1); // it really did retry
    expect(found.map((f) => f.nftContract)).toContain(NFT);
  });

  it("gives up once the retries are spent, rather than looping forever", async () => {
    let calls = 0;
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getLogs: () => {
        calls++;
        throw new Error("log query timed out");
      },
    });

    await expect(
      scanSeaDropMints(mock.url, 100, 110, [WATCHED], 50, { chunkDelayMs: 1, retriesPerChunk: 2 })
    ).rejects.toThrow();
    expect(calls).toBe(2);
  });
});
