import { describe, it, expect, afterEach } from "vitest";
import { Interface } from "ethers";
import { scanPublicDropUpdates } from "./seadrop-events";
import { SEADROP_ADDRESS } from "./seadrop-public";
import { startMockRpc, MockRpc } from "./test-support/mock-rpc";

const IFACE = new Interface([
  "event PublicDropUpdated(address indexed nftContract, tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients) publicDrop)",
]);

const NFT_A = "0x1111111111111111111111111111111111111111";
const NFT_B = "0x2222222222222222222222222222222222222222";

function encodeLog(
  nftContract: string,
  drop: {
    mintPrice: bigint;
    startTime: number;
    endTime: number;
    maxTotalMintableByWallet: number;
    feeBps: number;
    restrictFeeRecipients: boolean;
  },
  blockNumber: number
) {
  const fragment = IFACE.getEvent("PublicDropUpdated")!;
  const { data, topics } = IFACE.encodeEventLog(fragment, [
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
  await mock?.close();
  mock = undefined;
});

describe("scanPublicDropUpdates (against a real mock RPC node)", () => {
  it("decodes a free-mint sighting from a real ABI-encoded log", async () => {
    const log = encodeLog(
      NFT_A,
      { mintPrice: 0n, startTime: 1_700_000_000, endTime: 1_800_000_000, maxTotalMintableByWallet: 5, feeBps: 0, restrictFeeRecipients: false },
      100
    );
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getLogs: () => [log],
    });

    const sightings = await scanPublicDropUpdates(mock.url, 1, 100);
    expect(sightings).toHaveLength(1);
    expect(sightings[0].nftContract.toLowerCase()).toBe(NFT_A);
    expect(sightings[0].drop.mintPrice).toBe(0n);
    expect(sightings[0].drop.maxTotalMintableByWallet).toBe(5);
    expect(sightings[0].blockNumber).toBe(100);
  });

  it("decodes multiple sightings for different collections", async () => {
    const logA = encodeLog(NFT_A, { mintPrice: 0n, startTime: 1, endTime: 0, maxTotalMintableByWallet: 3, feeBps: 0, restrictFeeRecipients: false }, 10);
    const logB = encodeLog(NFT_B, { mintPrice: 1_000_000_000_000_000n, startTime: 1, endTime: 0, maxTotalMintableByWallet: 2, feeBps: 250, restrictFeeRecipients: true }, 11);
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getLogs: () => [logA, logB],
    });

    const sightings = await scanPublicDropUpdates(mock.url, 1, 100);
    expect(sightings.map((s) => s.nftContract.toLowerCase())).toEqual([NFT_A, NFT_B]);
    expect(sightings[1].drop.mintPrice).toBe(1_000_000_000_000_000n);
    expect(sightings[1].drop.restrictFeeRecipients).toBe(true);
  });

  it("returns nothing for an empty range without calling the RPC", async () => {
    mock = await startMockRpc({ eth_getLogs: () => [] });
    expect(await scanPublicDropUpdates(mock.url, 100, 1)).toEqual([]);
    expect(mock.calls).toHaveLength(0);
  });

  it("walks a wide block range in chunks rather than one unbounded call", async () => {
    let seenRanges: { from: string; to: string }[] = [];
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getLogs: (params) => {
        seenRanges.push({ from: params[0].fromBlock, to: params[0].toBlock });
        return [];
      },
    });

    // 5000-block span should be split into multiple <=2000-block chunks.
    await scanPublicDropUpdates(mock.url, 1, 5000);
    expect(seenRanges.length).toBeGreaterThan(1);
    for (const r of seenRanges) {
      const span = parseInt(r.to, 16) - parseInt(r.from, 16) + 1;
      expect(span).toBeLessThanOrEqual(2000);
    }
  });
});
