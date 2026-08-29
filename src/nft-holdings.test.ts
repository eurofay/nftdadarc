import { describe, it, expect, afterEach } from "vitest";
import { Interface } from "ethers";
import { fetchOnChainHoldings } from "./nft-holdings";
import { clearProviderCache } from "./rpc-provider";
import { startMockRpc, MockRpc } from "./test-support/mock-rpc";

const IFACE = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function name() view returns (string)",
]);

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const WALLET = "0xE607f2b18daE93e1f5D4c5a5C71b1d1070823ba0";

let mock: MockRpc | undefined;
afterEach(async () => {
  clearProviderCache();
  await mock?.close();
  mock = undefined;
});

// Serves per-contract balances, mimicking a real node dispatching by `to`.
function serveBalances(balances: Record<string, number>, names: Record<string, string> = {}) {
  return (params: any[]) => {
    const to = String(params[0].to).toLowerCase();
    const data = params[0].data as string;
    const fn = IFACE.parseTransaction({ data });
    if (fn?.name === "name") {
      if (!(to in names)) throw new Error("no name()");
      return IFACE.encodeFunctionResult("name", [names[to]]);
    }
    return IFACE.encodeFunctionResult("balanceOf", [BigInt(balances[to] ?? 0)]);
  };
}

describe("fetchOnChainHoldings", () => {
  it("returns only the collections actually held", async () => {
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_call: serveBalances({ [A]: 33, [B]: 0, [C]: 10 }),
    });
    const held = await fetchOnChainHoldings(mock.url, WALLET, [A, B, C]);
    expect(held.map((h) => h.contract)).toEqual([A, C]); // sorted by balance desc
    expect(held[0].balance).toBe(33);
  });

  it("finds holdings even when OpenSea knows nothing — the whole point", async () => {
    // No OpenSea involvement at all; balanceOf is authoritative.
    mock = await startMockRpc({ eth_chainId: () => "0x2105", eth_call: serveBalances({ [A]: 5 }) });
    const held = await fetchOnChainHoldings(mock.url, WALLET, [A]);
    expect(held).toHaveLength(1);
    expect(held[0].balance).toBe(5);
  });

  it("reads names when asked, and tolerates contracts without name()", async () => {
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_call: serveBalances({ [A]: 1, [B]: 2 }, { [A]: "DuckHood" }),
    });
    const held = await fetchOnChainHoldings(mock.url, WALLET, [A, B], { withNames: true });
    expect(held.find((h) => h.contract === A)!.name).toBe("DuckHood");
    // B has no name() — still reported, just unnamed.
    expect(held.find((h) => h.contract === B)!.name).toBeUndefined();
  });

  it("skips an unreadable contract instead of reporting it as zero", async () => {
    mock = await startMockRpc({
      eth_chainId: () => "0x2105",
      eth_call: (params) => {
        if (String(params[0].to).toLowerCase() === B) throw new Error("execution reverted");
        return IFACE.encodeFunctionResult("balanceOf", [7n]);
      },
    });
    const held = await fetchOnChainHoldings(mock.url, WALLET, [A, B]);
    expect(held.map((h) => h.contract)).toEqual([A]);
  });

  it("deduplicates and is case-insensitive about contract addresses", async () => {
    mock = await startMockRpc({ eth_chainId: () => "0x2105", eth_call: serveBalances({ [A]: 4 }) });
    const held = await fetchOnChainHoldings(mock.url, WALLET, [A, A.toUpperCase(), A]);
    expect(held).toHaveLength(1);
  });

  it("makes no calls for an empty contract list", async () => {
    mock = await startMockRpc({ eth_call: () => "0x" });
    expect(await fetchOnChainHoldings(mock.url, WALLET, [])).toEqual([]);
    expect(mock.calls).toHaveLength(0);
  });
});
