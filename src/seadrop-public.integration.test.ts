import { describe, it, expect, afterEach } from "vitest";
import { Interface } from "ethers";
import { buildLocalMintPlan, fetchPublicDrop, resolveFeeRecipient } from "./seadrop-public";
import { startMockRpc, MockRpc } from "./test-support/mock-rpc";

// Mirrors the real SeaDrop ABI used in seadrop-public.ts, kept local so this
// test encodes results the same way the real contract would.
const IFACE = new Interface([
  "function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))",
  "function getAllowedFeeRecipients(address nftContract) view returns (address[])",
]);

const NFT = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

function decodeCall(data: string) {
  return IFACE.parseTransaction({ data })!;
}

function dropResult(fields: {
  mintPrice?: bigint;
  startTime?: number;
  endTime?: number;
  maxTotalMintableByWallet?: number;
  feeBps?: number;
  restrictFeeRecipients?: boolean;
}) {
  const d = {
    mintPrice: fields.mintPrice ?? 0n,
    startTime: fields.startTime ?? 0,
    endTime: fields.endTime ?? 0,
    maxTotalMintableByWallet: fields.maxTotalMintableByWallet ?? 0,
    feeBps: fields.feeBps ?? 0,
    restrictFeeRecipients: fields.restrictFeeRecipients ?? false,
  };
  return IFACE.encodeFunctionResult("getPublicDrop", [
    [d.mintPrice, d.startTime, d.endTime, d.maxTotalMintableByWallet, d.feeBps, d.restrictFeeRecipients],
  ]);
}

function recipientsResult(addresses: string[]) {
  return IFACE.encodeFunctionResult("getAllowedFeeRecipients", [addresses]);
}

let mock: MockRpc | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

describe("fetchPublicDrop (against a real mock RPC node)", () => {
  it("parses a live public drop from the chain", async () => {
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_call: (params) => {
        const call = decodeCall(params[0].data);
        if (call.name === "getPublicDrop") {
          return dropResult({
            mintPrice: 1_000_000_000_000_000n, // 0.001 ETH
            startTime: 1_700_000_000,
            endTime: 1_800_000_000,
            maxTotalMintableByWallet: 3,
            feeBps: 250,
            restrictFeeRecipients: false,
          });
        }
        throw new Error(`unexpected call: ${call.name}`);
      },
    });

    const drop = await fetchPublicDrop(mock.url, NFT);
    expect(drop).toEqual({
      mintPrice: 1_000_000_000_000_000n,
      startTime: 1_700_000_000,
      endTime: 1_800_000_000,
      maxTotalMintableByWallet: 3,
      feeBps: 250,
      restrictFeeRecipients: false,
    });
  });

  it("treats an all-zero response as no public drop configured", async () => {
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_call: () => dropResult({}),
    });

    expect(await fetchPublicDrop(mock.url, NFT)).toBeNull();
  });
});

describe("resolveFeeRecipient (against a real mock RPC node)", () => {
  it("uses the on-chain allowed recipient when the list is non-empty", async () => {
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_call: (params) => {
        const call = decodeCall(params[0].data);
        if (call.name === "getAllowedFeeRecipients") return recipientsResult([RECIPIENT]);
        throw new Error(`unexpected call: ${call.name}`);
      },
    });

    const fee = await resolveFeeRecipient(mock.url, NFT, false);
    expect(fee?.address).toBe(RECIPIENT);
    expect(fee?.source).toMatch(/allowed fee recipient/);
  });

  it("returns null when the drop restricts recipients and none are allowed", async () => {
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_call: (params) => {
        const call = decodeCall(params[0].data);
        if (call.name === "getAllowedFeeRecipients") return recipientsResult([]);
        throw new Error(`unexpected call: ${call.name}`);
      },
    });

    expect(await resolveFeeRecipient(mock.url, NFT, true)).toBeNull();
  });

  it("falls back to the OpenSea default when unrestricted and nothing is listed", async () => {
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_call: (params) => {
        const call = decodeCall(params[0].data);
        if (call.name === "getAllowedFeeRecipients") return recipientsResult([]);
        throw new Error(`unexpected call: ${call.name}`);
      },
    });

    const fee = await resolveFeeRecipient(mock.url, NFT, false);
    expect(fee?.source).toMatch(/OpenSea default/);
  });
});

describe("buildLocalMintPlan (against a real mock RPC node)", () => {
  it("assembles a full mint plan from on-chain drop + fee recipient", async () => {
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_call: (params) => {
        const call = decodeCall(params[0].data);
        if (call.name === "getPublicDrop") {
          return dropResult({ mintPrice: 2_000_000_000_000_000n, startTime: 1, endTime: 2_000_000_000 });
        }
        if (call.name === "getAllowedFeeRecipients") return recipientsResult([RECIPIENT]);
        throw new Error(`unexpected call: ${call.name}`);
      },
    });

    const plan = await buildLocalMintPlan(mock.url, NFT, 3);
    expect(plan).not.toBeNull();
    expect(plan!.value).toBe(6_000_000_000_000_000n); // price × quantity
    expect(plan!.feeRecipient).toBe(RECIPIENT);
    expect(plan!.data.startsWith("0x")).toBe(true);
  });

  it("returns null when there is no public drop for the contract", async () => {
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_call: () => dropResult({}),
    });

    expect(await buildLocalMintPlan(mock.url, NFT, 1)).toBeNull();
  });
});
