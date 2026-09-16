import { describe, it, expect } from "vitest";
import { AbiCoder, getAddress, id, zeroPadValue } from "ethers";
import { POOL_CREATED_TOPIC, PAIR_CREATED_TOPIC, decodeLaunch } from "./launch-watch";
import { dexFor, hasDex, DEXES } from "./dex-registry";
import { describeSafety, SafetyReport } from "./token-safety";

const CODER = AbiCoder.defaultAbiCoder();
const ARC = dexFor("arc")!;
const WRAPPED = getAddress(ARC.wrappedNative);
const MEME = getAddress("0x" + "77".repeat(20));
const OTHER = getAddress("0x" + "88".repeat(20));
const POOL = getAddress("0x" + "99".repeat(20));

const v3Log = (token0: string, token1: string, fee = 10_000) => ({
  address: ARC.v3Factories[0],
  topics: [POOL_CREATED_TOPIC, zeroPadValue(token0, 32), zeroPadValue(token1, 32), CODER.encode(["uint256"], [fee])],
  data: CODER.encode(["int24", "address"], [200, POOL]),
  blockNumber: "0x10",
  transactionHash: "0xabc",
});

const v2Log = (token0: string, token1: string) => ({
  address: ARC.v2Factories[0],
  topics: [PAIR_CREATED_TOPIC, zeroPadValue(token0, 32), zeroPadValue(token1, 32)],
  data: CODER.encode(["address", "uint256"], [POOL, 1]),
  blockNumber: "0x11",
  transactionHash: "0xdef",
});

describe("spotting a launch", () => {
  it("names the new token as whichever side is not the quote asset", () => {
    expect(decodeLaunch(v3Log(WRAPPED, MEME), ARC)!.token).toBe(MEME);
    // Token ordering in a pool is by address, so the interesting side lands
    // on either end depending on the address it was deployed to.
    expect(decodeLaunch(v3Log(MEME, WRAPPED), ARC)!.token).toBe(MEME);
  });

  it("carries the pool, fee tier and venue", () => {
    const s = decodeLaunch(v3Log(WRAPPED, MEME, 3_000), ARC)!;
    expect(s.pool).toBe(POOL);
    expect(s.feeTier).toBe(3_000);
    expect(s.venue).toBe("v3");
    expect(s.quote).toBe(WRAPPED);
    expect(s.block).toBe(16);
  });

  it("reads a V2 pair, which carries no fee tier", () => {
    const s = decodeLaunch(v2Log(WRAPPED, MEME), ARC)!;
    expect(s.venue).toBe("v2");
    expect(s.feeTier).toBeUndefined();
    expect(s.token).toBe(MEME);
  });

  it("ignores a pool between two tokens it cannot price", () => {
    // Neither side is the quote asset, so there is no denominator -- and a
    // pool like this is not a launch anyone can buy into with USDC.
    expect(decodeLaunch(v3Log(MEME, OTHER), ARC)).toBeNull();
  });

  it("ignores an unrelated event rather than throwing", () => {
    const junk = { ...v3Log(WRAPPED, MEME), topics: [id("Transfer(address,address,uint256)")] };
    expect(decodeLaunch(junk, ARC)).toBeNull();
  });

  it("survives a malformed log instead of stopping the watcher", () => {
    // A watcher reads logs from contracts it does not control. One bad entry
    // must not end the poll that would have found the next launch.
    const broken = { ...v3Log(WRAPPED, MEME), data: "0x00" };
    expect(decodeLaunch(broken, ARC)).toBeNull();
    expect(decodeLaunch({ ...v3Log(WRAPPED, MEME), topics: [] } as never, ARC)).toBeNull();
  });
});

describe("the Arc trading venue, as measured", () => {
  it("does not use Uniswap's canonical factory address", () => {
    // It IS deployed on Arc and has emitted zero PoolCreated. A watcher
    // pointed there sits silent forever while a token launches every
    // eighteen seconds somewhere else -- and silence looks exactly like a
    // quiet market.
    const canonical = "0x1F98431c8aD98523631AE4a59f267346ea31F984".toLowerCase();
    expect(ARC.v3Factories.map((f) => f.toLowerCase())).not.toContain(canonical);
  });

  it("quotes against wrapped USDC at 18 decimals", () => {
    // Arc's gas token is USDC. As an ERC20 everywhere else USDC is 6
    // decimals, and using that here misprices every position by a factor of
    // a trillion -- in the direction that looks like a win.
    expect(ARC.quoteDecimals).toBe(18);
    expect(ARC.quoteSymbol).toBe("USDC");
  });

  it("only claims chains that were actually measured", () => {
    expect(hasDex("arc")).toBe(true);
    expect(hasDex("ethereum")).toBe(false);
    expect(DEXES.every((d) => d.v3Factories.length + d.v2Factories.length > 0)).toBe(true);
  });
});

describe("saying what a safety check found", () => {
  const report = (over: Partial<SafetyReport>): SafetyReport =>
    ({ verdict: "SELLABLE", detail: "d", ...over }) as SafetyReport;

  it("never invents a round-trip figure it did not measure", () => {
    // checkSellable proves transferability and measures no value at all.
    // Printing "100.0% back" for it would turn an absent number into the most
    // reassuring possible one.
    const text = describeSafety(report({ detail: "tokens can be moved to the pool" }));
    expect(text).not.toContain("100.0%");
    expect(text).toContain("tokens can be moved");
  });

  it("reports a measured round trip when there is one", () => {
    expect(describeSafety(report({ roundTripLossPct: 4 }))).toContain("96.0% back");
  });

  it("leads with the verdict, because it is read in seconds", () => {
    expect(describeSafety(report({ verdict: "HONEYPOT", detail: "x" }))).toMatch(/^🚫 HONEYPOT/);
    expect(describeSafety(report({ verdict: "NO_LIQUIDITY" }))).toContain("no liquidity");
    expect(describeSafety(report({ verdict: "UNKNOWN", detail: "unchecked" }))).toContain("unchecked");
  });

  it("does not call a high-tax token safe", () => {
    const text = describeSafety(report({ verdict: "HIGH_TAX", roundTripLossPct: 40, detail: "tax" }));
    expect(text).toContain("40.0%");
    expect(text).not.toContain("✅");
  });
});
