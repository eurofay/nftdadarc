import { describe, it, expect, afterEach } from "vitest";
import { Transaction, Wallet } from "ethers";
import { scanWatchedMints } from "./copy-mint";
import { SEADROP_ADDRESS, encodeMintPublic } from "./seadrop-public";
import { startMockRpc, MockRpc } from "./test-support/mock-rpc";

const SOURCE_KEY = "0xad6c4582d7bae64497e12e590deb375c3e5e1827044300f6a9d98f06c6dae4bd";
const OTHER_KEY = "0xed2d4e86c549055cc9ac40a86cfa836773d4c82aa71d1ec5503011707b90dfb0";
const NFT = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

// Builds a genuinely signed transaction and returns it in the shape
// eth_getBlockByNumber(_, true) returns it, so ethers' strict response
// formatter (which validates the signature) accepts it like a real node would.
async function signedRpcTx(fromKey: string, to: string, data: string, nonce: number) {
  const wallet = new Wallet(fromKey);
  const raw = await wallet.signTransaction({
    to,
    data,
    value: 0n,
    nonce,
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
    nonce: `0x${parsed.nonce.toString(16)}`,
    gas: `0x${parsed.gasLimit.toString(16)}`,
    value: "0x0",
    type: "0x2",
    chainId: `0x${(8453).toString(16)}`,
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
  await mock?.close();
  mock = undefined;
});

describe("scanWatchedMints (against a real mock RPC node)", () => {
  it("finds a real mintPublic call from a watched wallet", async () => {
    const source = new Wallet(SOURCE_KEY);
    const tx = await signedRpcTx(SOURCE_KEY, SEADROP_ADDRESS, encodeMintPublic(NFT, RECIPIENT, 2), 0);

    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getBlockByNumber: () => blockShape(100, [tx]),
    });

    const found = await scanWatchedMints(mock.url, 100, 100, [source.address]);
    expect(found).toHaveLength(1);
    expect(found[0].from.toLowerCase()).toBe(source.address.toLowerCase());
    expect(found[0].nftContract.toLowerCase()).toBe(NFT);
    expect(found[0].txHash).toBe(tx.hash);
  });

  it("ignores a mintPublic call from a wallet that isn't on the watchlist", async () => {
    const source = new Wallet(SOURCE_KEY);
    const tx = await signedRpcTx(OTHER_KEY, SEADROP_ADDRESS, encodeMintPublic(NFT, RECIPIENT, 2), 0);

    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getBlockByNumber: () => blockShape(100, [tx]),
    });

    // Watching `source`, but the tx is signed by OTHER_KEY.
    const found = await scanWatchedMints(mock.url, 100, 100, [source.address]);
    expect(found).toHaveLength(0);
  });

  it("ignores a call to a contract other than the SeaDrop singleton", async () => {
    const source = new Wallet(SOURCE_KEY);
    const tx = await signedRpcTx(SOURCE_KEY, NFT /* not SEADROP_ADDRESS */, encodeMintPublic(NFT, RECIPIENT, 2), 0);

    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getBlockByNumber: () => blockShape(100, [tx]),
    });

    const found = await scanWatchedMints(mock.url, 100, 100, [source.address]);
    expect(found).toHaveLength(0);
  });

  it("returns nothing for an empty range or empty watchlist without calling the RPC", async () => {
    mock = await startMockRpc({ eth_getBlockByNumber: () => blockShape(1, []) });
    expect(await scanWatchedMints(mock.url, 100, 1, ["0x1111111111111111111111111111111111111111"])).toEqual([]);
    expect(await scanWatchedMints(mock.url, 1, 100, [])).toEqual([]);
    expect(mock.calls).toHaveLength(0);
  });

  it("scans every block in the range, not just the first", async () => {
    const source = new Wallet(SOURCE_KEY);
    const tx1 = await signedRpcTx(SOURCE_KEY, SEADROP_ADDRESS, encodeMintPublic(NFT, RECIPIENT, 1), 0);
    const nft2 = "0x2222222222222222222222222222222222222222";
    const tx2 = await signedRpcTx(SOURCE_KEY, SEADROP_ADDRESS, encodeMintPublic(nft2, RECIPIENT, 1), 1);

    const blocks: Record<number, any> = { 100: blockShape(100, [tx1]), 101: blockShape(101, [tx2]) };

    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_getBlockByNumber: (params) => {
        const n = parseInt(params[0], 16);
        return blocks[n] ?? blockShape(n, []);
      },
    });

    const found = await scanWatchedMints(mock.url, 100, 101, [source.address]);
    expect(found.map((f) => f.nftContract.toLowerCase())).toEqual([NFT, nft2]);
  });
});
