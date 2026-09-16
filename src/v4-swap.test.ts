import { describe, it, expect } from "vitest";
import { AbiCoder, getAddress, zeroPadValue } from "ethers";
import {
  BUY_ACTIONS,
  INITIALIZE_TOPIC,
  MAX_UINT48,
  V4_SWAP,
  V4Pool,
  buildV4Swap,
  decodeInitialize,
  minOutFor,
} from "./v4-swap";
import { dexFor } from "./dex-registry";

const CODER = AbiCoder.defaultAbiCoder();
const ARC = dexFor("arc")!;
const WRAPPED = getAddress(ARC.wrappedNative);
const MEME = getAddress("0x44B453D355835Ce1269fc11D3FA4161c0DcC0087");
const HOOK = getAddress("0xca55CDde6578F6f8113dd339520E13418Abc2acC");

const pool: V4Pool = {
  key: { currency0: WRAPPED, currency1: MEME, fee: 0, tickSpacing: 200, hooks: HOOK },
  poolId: "0x" + "ab".repeat(32),
  token: MEME,
  buyIsZeroForOne: true,
  block: 100,
};

// The calldata of a swap that really happened on Arc, block 21112000-ish.
// Everything in this file exists to keep the encoder producing exactly this.
const REAL_INPUTS = (() => {
  const TYPE =
    "((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint160 sqrtPriceLimitX96,bytes hookData)";
  const amountIn = 0xe9705cd8cdf0bcc9019n;
  const minOut = 0x15db0d17n;
  return CODER.encode(
    ["bytes", "bytes[]"],
    [
      "0x060c0f",
      [
        CODER.encode([TYPE], [[[WRAPPED, MEME, 0, 200, HOOK], false, amountIn, minOut, 0n, "0x"]]),
        CODER.encode(["address", "uint256"], [MEME, amountIn]),
        CODER.encode(["address", "uint256"], [WRAPPED, minOut]),
      ],
    ]
  );
})();

describe("the encoding, pinned against a swap that really worked", () => {
  it("reproduces a real Arc sell byte for byte", () => {
    // This is the whole guarantee. The shape was not taken from docs -- it
    // was read off a successful transaction, re-encoded, and byte-compared.
    // If this test fails, the encoder has drifted from what the chain accepts
    // and every buy built from it will revert.
    const call = buildV4Swap(ARC, {
      pool,
      amountIn: 0xe9705cd8cdf0bcc9019n,
      amountOutMinimum: 0x15db0d17n,
      sell: true,
    });
    const [, inputs] = CODER.decode(["bytes", "bytes[]", "uint256"], "0x" + call.data.slice(10));
    expect(inputs[0]).toBe(REAL_INPUTS);
  });

  it("carries sqrtPriceLimitX96, the field that is fatal to omit", () => {
    // Without it every field after the poolKey lands one slot out and the
    // call reverts with nothing useful to say. Counted here so a "tidy-up"
    // that drops it fails loudly.
    const call = buildV4Swap(ARC, { pool, amountIn: 1n, amountOutMinimum: 0n });
    const [, inputs] = CODER.decode(["bytes", "bytes[]", "uint256"], "0x" + call.data.slice(10));
    const [, params] = CODER.decode(["bytes", "bytes[]"], inputs[0]);
    // offset + 5 poolKey + zeroForOne + amountIn + minOut + sqrtLimit +
    // hookData offset + hookData length = 12 words.
    expect((params[0].length - 2) / 64).toBe(12);
  });

  it("uses the V4 command and the three-action sequence", () => {
    const call = buildV4Swap(ARC, { pool, amountIn: 1n, amountOutMinimum: 0n });
    const [commands, inputs] = CODER.decode(["bytes", "bytes[]", "uint256"], "0x" + call.data.slice(10));
    expect(commands).toBe(V4_SWAP);
    expect(CODER.decode(["bytes", "bytes[]"], inputs[0])[0]).toBe(BUY_ACTIONS);
  });

  it("never sends value -- the input is pulled through Permit2", () => {
    // Even though the quote asset mirrors the native balance, the pool sees
    // an ERC20. Attaching value would send money the router does not take.
    expect(buildV4Swap(ARC, { pool, amountIn: 10n ** 6n, amountOutMinimum: 0n }).value).toBe(0n);
  });
});

describe("which way round the swap goes", () => {
  it("buys by spending the quote asset and settling it", () => {
    const call = buildV4Swap(ARC, { pool, amountIn: 1_000_000n, amountOutMinimum: 5n });
    const [, inputs] = CODER.decode(["bytes", "bytes[]", "uint256"], "0x" + call.data.slice(10));
    const [, params] = CODER.decode(["bytes", "bytes[]"], inputs[0]);
    // SETTLE_ALL names what is paid IN, TAKE_ALL what comes back. Swapping
    // these pays the wrong currency, so they are derived, never passed in.
    expect(CODER.decode(["address", "uint256"], params[1])[0]).toBe(WRAPPED);
    expect(CODER.decode(["address", "uint256"], params[2])[0]).toBe(MEME);
  });

  it("sells by spending the token instead", () => {
    const call = buildV4Swap(ARC, { pool, amountIn: 5n, amountOutMinimum: 1n, sell: true });
    const [, inputs] = CODER.decode(["bytes", "bytes[]", "uint256"], "0x" + call.data.slice(10));
    const [, params] = CODER.decode(["bytes", "bytes[]"], inputs[0]);
    expect(CODER.decode(["address", "uint256"], params[1])[0]).toBe(MEME);
    expect(CODER.decode(["address", "uint256"], params[2])[0]).toBe(WRAPPED);
  });

  it("follows the pool's own currency ordering, not the argument order", () => {
    // V4 sorts currencies by address, so the quote asset is currency0 for
    // some tokens and currency1 for others. Assuming one of them buys the
    // wrong direction on half the pools.
    const flipped: V4Pool = {
      ...pool,
      key: { ...pool.key, currency0: MEME, currency1: WRAPPED },
      buyIsZeroForOne: false,
    };
    const call = buildV4Swap(ARC, { pool: flipped, amountIn: 1n, amountOutMinimum: 0n });
    const [, inputs] = CODER.decode(["bytes", "bytes[]", "uint256"], "0x" + call.data.slice(10));
    const [, params] = CODER.decode(["bytes", "bytes[]"], inputs[0]);
    expect(CODER.decode(["address", "uint256"], params[1])[0]).toBe(WRAPPED);
  });
});

describe("reading a pool out of an Initialize event", () => {
  const log = (c0: string, c1: string, fee = 10_000, tickSpacing = 200) => ({
    topics: [INITIALIZE_TOPIC, "0x" + "cd".repeat(32), zeroPadValue(c0, 32), zeroPadValue(c1, 32)],
    data: CODER.decode ? CODER.encode(["uint24", "int24", "address", "uint160", "int24"], [fee, tickSpacing, HOOK, 1n, 0]) : "0x",
    blockNumber: "0x64",
  });

  it("keeps the hook, which identifies the pool as much as the fee does", () => {
    // Every launchpad pool on Arc has its own hook. A swap naming the wrong
    // one is a swap against a different pool.
    const p = decodeInitialize(log(WRAPPED, MEME), WRAPPED)!;
    expect(p.key.hooks).toBe(HOOK);
    expect(p.key.fee).toBe(10_000);
    expect(p.key.tickSpacing).toBe(200);
    expect(p.token).toBe(MEME);
    expect(p.buyIsZeroForOne).toBe(true);
  });

  it("works when the quote asset sorts second", () => {
    const p = decodeInitialize(log(MEME, WRAPPED), WRAPPED)!;
    expect(p.token).toBe(MEME);
    expect(p.buyIsZeroForOne).toBe(false);
  });

  it("ignores a pool with no quote asset in it", () => {
    const other = getAddress("0x" + "99".repeat(20));
    expect(decodeInitialize(log(MEME, other), WRAPPED)).toBeNull();
  });

  it("returns null on malformed data rather than throwing", () => {
    const bad = { ...log(WRAPPED, MEME), data: "0x00" };
    expect(decodeInitialize(bad, WRAPPED)).toBeNull();
  });
});

describe("slippage", () => {
  it("takes basis points off the quote", () => {
    expect(minOutFor(1_000n, 300)).toBe(970n);
    expect(minOutFor(1_000n, 0)).toBe(1_000n);
  });

  it("clamps rather than producing a negative floor", () => {
    // 100% slippage is a floor of zero, not a revert and not a wrap-around.
    expect(minOutFor(1_000n, 10_000)).toBe(0n);
    expect(minOutFor(1_000n, 99_999)).toBe(0n);
    expect(minOutFor(1_000n, -5)).toBe(1_000n);
  });
});

describe("the Arc addresses this depends on", () => {
  it("knows the PoolManager, Permit2 and the router", () => {
    // Without all three there is no buy path at all, and a missing one should
    // fail here rather than at the moment someone presses Buy.
    expect(ARC.v4PoolManager).toBeTruthy();
    expect(ARC.permit2).toBeTruthy();
    expect(ARC.universalRouter).toBeTruthy();
    expect(ARC.wrappedAllowanceSlot).toBe(10);
  });

  it("uses Permit2's real uint48 maximum for the expiry", () => {
    expect(MAX_UINT48).toBe(281_474_976_710_655n);
  });
});
