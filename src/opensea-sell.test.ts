import { describe, it, expect, vi, afterEach } from "vitest";
import { Interface, ZeroHash } from "ethers";
import {
  acceptOfferWithFallback,
  encodeFulfillment,
  resolveApprovalTarget,
  isApprovedForAll,
  parseListingPrice,
  SellAttempt,
} from "./opensea-sell";
import { clearProviderCache } from "./rpc-provider";
import { startMockRpc, MockRpc } from "./test-support/mock-rpc";

let mock: MockRpc | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  clearProviderCache();
  await mock?.close();
  mock = undefined;
});

const attempt = (over: Partial<SellAttempt>): SellAttempt => ({
  path: "sdk",
  ok: false,
  broadcast: false,
  ...over,
});

describe("acceptOfferWithFallback — the double-sell guard", () => {
  it("returns the first success without running later paths", async () => {
    const second = vi.fn(async () => attempt({ path: "api", ok: true, txHash: "0xb", broadcast: true }));
    const res = await acceptOfferWithFallback([
      async () => attempt({ path: "sdk", ok: true, txHash: "0xa", broadcast: true }),
      second,
    ]);
    expect(res.ok).toBe(true);
    expect(res.usedPath).toBe("sdk");
    expect(res.txHash).toBe("0xa");
    expect(second).not.toHaveBeenCalled();
  });

  it("falls through to the next path when the first failed BEFORE broadcasting", async () => {
    const res = await acceptOfferWithFallback([
      async () => attempt({ path: "sdk", error: "no Chain entry", broadcast: false }),
      async () => attempt({ path: "api", ok: true, txHash: "0xb", broadcast: true }),
    ]);
    expect(res.ok).toBe(true);
    expect(res.usedPath).toBe("api");
    expect(res.attempts).toHaveLength(2);
  });

  it("REFUSES to try another path once anything was broadcast — the whole point", async () => {
    // A failure after broadcast might just be a lost receipt. Retrying could
    // sell the NFT twice, so this must stop even though a path remains.
    const second = vi.fn(async () => attempt({ path: "api", ok: true, txHash: "0xb", broadcast: true }));
    const res = await acceptOfferWithFallback([
      async () => attempt({ path: "sdk", error: "receipt timeout", broadcast: true }),
      second,
    ]);
    expect(res.ok).toBe(false);
    expect(res.txHash).toBeUndefined();
    expect(second).not.toHaveBeenCalled();
  });

  it("reports failure with every attempt recorded when all paths are unavailable", async () => {
    const res = await acceptOfferWithFallback([
      async () => attempt({ path: "sdk", error: "a", broadcast: false }),
      async () => attempt({ path: "api", error: "b", broadcast: false }),
    ]);
    expect(res.ok).toBe(false);
    expect(res.attempts.map((a) => a.error)).toEqual(["a", "b"]);
  });
});

describe("parseListingPrice", () => {
  it("accepts an absolute ETH amount", () => {
    expect(parseListingPrice("0.05", 0.01)).toBe(0.05);
    expect(parseListingPrice("  1.5  ", null)).toBe(1.5);
  });

  it("prices off the live floor", () => {
    expect(parseListingPrice("floor", 0.02)).toBeCloseTo(0.02);
    expect(parseListingPrice("floor*1.2", 0.02)).toBeCloseTo(0.024);
    expect(parseListingPrice("FLOOR * 0.9", 0.02)).toBeCloseTo(0.018);
  });

  it("refuses a floor-relative price when there is no floor", () => {
    // Guessing here would list at an arbitrary number.
    expect(parseListingPrice("floor", null)).toBeNull();
    expect(parseListingPrice("floor*2", 0)).toBeNull();
  });

  it("rejects zero, negative and non-numeric input rather than defaulting", () => {
    expect(parseListingPrice("0", 0.01)).toBeNull();
    expect(parseListingPrice("-1", 0.01)).toBeNull();
    expect(parseListingPrice("cheap", 0.01)).toBeNull();
    expect(parseListingPrice("", 0.01)).toBeNull();
    expect(parseListingPrice("floor*abc", 0.01)).toBeNull();
  });
});

describe("resolveApprovalTarget", () => {
  it("uses Seaport itself when the order carries the zero conduit key", async () => {
    const seaport = "0x0000000000000068F116a894984e2DB1123eB395";
    // No RPC needed — the zero key short-circuits before any lookup.
    expect(await resolveApprovalTarget("http://127.0.0.1:1", seaport, ZeroHash)).toBe(seaport);
    expect(await resolveApprovalTarget("http://127.0.0.1:1", seaport, undefined)).toBe(seaport);
  });

  it("resolves a real conduit key through the ConduitController", async () => {
    const iface = new Interface(["function getConduit(bytes32) view returns (address, bool)"]);
    const conduit = "0x1E0049783F008A0085193E00003D00cd54003c71";
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_call: () => iface.encodeFunctionResult("getConduit", [conduit, true]),
    });
    const got = await resolveApprovalTarget(mock.url, "0x0000000000000068F116a894984e2DB1123eB395", `0x${"11".repeat(32)}`);
    expect(got.toLowerCase()).toBe(conduit.toLowerCase());
  });

  it("falls back to Seaport when the conduit key maps to nothing deployed", async () => {
    // This is the Robinhood case: OpenSea's usual conduit isn't deployed
    // there, and approving a non-existent address grants nothing silently.
    const iface = new Interface(["function getConduit(bytes32) view returns (address, bool)"]);
    const seaport = "0x0000000000000068F116a894984e2DB1123eB395";
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_call: () =>
        iface.encodeFunctionResult("getConduit", ["0x0000000000000000000000000000000000000000", false]),
    });
    expect(await resolveApprovalTarget(mock.url, seaport, `0x${"11".repeat(32)}`)).toBe(seaport);
  });

  it("falls back to Seaport rather than throwing when the lookup call fails", async () => {
    const seaport = "0x0000000000000068F116a894984e2DB1123eB395";
    mock = await startMockRpc({ eth_chainId: () => "0x2105" }); // no eth_call handler
    expect(await resolveApprovalTarget(mock.url, seaport, `0x${"11".repeat(32)}`)).toBe(seaport);
  });
});

describe("isApprovedForAll", () => {
  it("reads the ERC-721 approval flag", async () => {
    const iface = new Interface(["function isApprovedForAll(address,address) view returns (bool)"]);
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_call: () => iface.encodeFunctionResult("isApprovedForAll", [true]),
    });
    expect(await isApprovedForAll(mock.url, "0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333")).toBe(true);
  });

  it("treats an unreadable contract as not approved rather than throwing", async () => {
    mock = await startMockRpc({ eth_chainId: () => "0x2105" });
    expect(await isApprovedForAll(mock.url, "0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333")).toBe(false);
  });
});

describe("encodeFulfillment", () => {
  const params = {
    considerationToken: "0x0000000000000000000000000000000000000000",
    considerationIdentifier: 0,
    considerationAmount: 1000n,
    offerer: "0x1111111111111111111111111111111111111111",
    zone: "0x0000000000000000000000000000000000000000",
    offerToken: "0x2222222222222222222222222222222222222222",
    offerIdentifier: 7n,
    offerAmount: 1n,
    basicOrderType: 0,
    startTime: 1n,
    endTime: 2n,
    zoneHash: ZeroHash,
    salt: 5n,
    offererConduitKey: ZeroHash,
    fulfillerConduitKey: ZeroHash,
    totalOriginalAdditionalRecipients: 0n,
    additionalRecipients: [],
    signature: "0x",
  };

  it("re-encodes OpenSea's decoded parameters into valid calldata", () => {
    const data = encodeFulfillment(
      "fulfillBasicOrder_efficient_6GL6yc((address,uint256,...))",
      { parameters: params }
    );
    expect(data.startsWith("0x")).toBe(true);

    // Decoding it back proves the field mapping is right — OpenSea's own
    // signature has no argument names, so this is the part that could
    // silently scramble values.
    const iface = new Interface([
      "function fulfillBasicOrder_efficient_6GL6yc(tuple(address considerationToken, uint256 considerationIdentifier, uint256 considerationAmount, address offerer, address zone, address offerToken, uint256 offerIdentifier, uint256 offerAmount, uint8 basicOrderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 offererConduitKey, bytes32 fulfillerConduitKey, uint256 totalOriginalAdditionalRecipients, tuple(uint256 amount, address recipient)[] additionalRecipients, bytes signature) parameters) payable returns (bool)",
    ]);
    const decoded = iface.decodeFunctionData("fulfillBasicOrder_efficient_6GL6yc", data);
    expect(decoded[0].offerToken.toLowerCase()).toBe(params.offerToken);
    expect(decoded[0].offerIdentifier).toBe(7n);
    expect(decoded[0].considerationAmount).toBe(1000n);
  });

  it("accepts parameters passed without the wrapper object", () => {
    expect(() => encodeFulfillment("fulfillBasicOrder(...)", params)).not.toThrow();
  });

  it("fails cleanly (pre-broadcast) on a fulfillment function it doesn't cover", () => {
    // Must throw rather than encode something wrong — that failure is what
    // lets the orchestrator fall back to the SDK path safely.
    expect(() => encodeFulfillment("fulfillAdvancedOrder((...))", { parameters: params })).toThrow(
      /unsupported/
    );
  });

  it("fails cleanly when the response carried no parameters", () => {
    expect(() => encodeFulfillment("fulfillBasicOrder(...)", null)).toThrow();
  });
});
