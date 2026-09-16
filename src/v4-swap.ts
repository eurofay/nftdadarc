// Buying a token on Uniswap V4, as Arc actually does it.
//
// HOW THE ENCODING WAS ESTABLISHED, because this is the one place in the
// memecoin path where a mistake spends real money. The shape here was not
// taken from documentation. It was read off a swap that succeeded on Arc,
// decoded word by word, re-encoded by the functions below, and byte-compared
// against the original calldata until it matched exactly. Then a buy built
// the same way was simulated against live state and came back OK.
//
// That process corrected two things a reasonable guess would have got wrong:
//
//   1. The router is V4, not V3. A V3 Universal Router buy -- the obvious
//      thing to write -- reverts on Arc at every fee tier.
//   2. ExactInputSingleParams carries sqrtPriceLimitX96 between
//      amountOutMinimum and hookData. Without it every field after the
//      poolKey lands one slot out, and the call reverts with nothing useful
//      to say about why.
//
// WHY A POOL CANNOT BE LOOKED UP BY ADDRESS. V4 pools are not contracts --
// they are entries inside one PoolManager singleton, identified by the hash
// of their PoolKey. So the key itself (both currencies, fee, tickSpacing and
// the hook) has to come from the Initialize event, and the hook matters: on
// Arc every launchpad pool has its own, and a swap naming the wrong one is a
// swap against a different pool.
//
// APPROVALS. The Universal Router pulls the input token through Permit2,
// which means two approvals before a first buy -- the ERC20 to Permit2, then
// Permit2 to the router. They are one-time per wallet per token, and
// buildApprovals below returns exactly the ones that are missing.

import { AbiCoder, Interface, concat, getAddress, id, keccak256, toBeHex, zeroPadValue } from "ethers";
import { createProvider } from "./rpc-provider";
import { DexConfig } from "./dex-registry";

const CODER = AbiCoder.defaultAbiCoder();

/** keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)") */
export const INITIALIZE_TOPIC = id(
  "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"
);

/** Universal Router command for a V4 swap. */
export const V4_SWAP = "0x10";
/** SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL -- the three actions a buy needs. */
export const BUY_ACTIONS = "0x060c0f";

const POOL_KEY = "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
/**
 * IV4Router.ExactInputSingleParams.
 *
 * sqrtPriceLimitX96 is the field that is easy to omit and fatal to omit --
 * confirmed present by byte-matching a real swap.
 */
const EXACT_IN_SINGLE =
  `(${POOL_KEY} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint160 sqrtPriceLimitX96,bytes hookData)`;

const ROUTER = new Interface(["function execute(bytes commands,bytes[] inputs,uint256 deadline) payable"]);
const ERC20 = new Interface([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
]);
const PERMIT2 = new Interface([
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
  "function allowance(address,address,address) view returns (uint160,uint48,uint48)",
]);

export interface PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

export interface V4Pool {
  key: PoolKey;
  /** Hash of the key -- how the PoolManager names it. */
  poolId: string;
  /** The side that is not the quote asset. */
  token: string;
  /** True when buying the token means swapping currency0 for currency1. */
  buyIsZeroForOne: boolean;
  block: number;
}

/** Decode one Initialize log into a pool, or null if it is not one we can trade. */
export function decodeInitialize(
  log: { topics: readonly string[]; data: string; blockNumber: string | number },
  wrappedNative: string
): V4Pool | null {
  try {
    if (log.topics[0] !== INITIALIZE_TOPIC) return null;
    const currency0 = getAddress("0x" + log.topics[2].slice(26));
    const currency1 = getAddress("0x" + log.topics[3].slice(26));
    const wrapped = getAddress(wrappedNative);

    // A pool between two assets we cannot price in the quote asset is not
    // something this can buy into.
    if (currency0 !== wrapped && currency1 !== wrapped) return null;

    const [fee, tickSpacing, hooks] = CODER.decode(
      ["uint24", "int24", "address", "uint160", "int24"],
      log.data
    );

    const key: PoolKey = {
      currency0,
      currency1,
      fee: Number(fee),
      tickSpacing: Number(tickSpacing),
      hooks: getAddress(String(hooks)),
    };
    return {
      key,
      poolId: log.topics[1],
      token: currency0 === wrapped ? currency1 : currency0,
      // Spending the quote asset means swapping whichever side it sits on.
      buyIsZeroForOne: currency0 === wrapped,
      block: typeof log.blockNumber === "string" ? parseInt(log.blockNumber, 16) : log.blockNumber,
    };
  } catch {
    return null;
  }
}

/**
 * Find the V4 pool for a token by asking the PoolManager what it initialized.
 *
 * Searches backwards from the head in chunks, newest first, because a token
 * that was just launched is the case this exists for and a full-history scan
 * to find it would be the slowest possible way.
 */
export async function findV4Pool(
  rpcUrl: string,
  dex: DexConfig,
  token: string,
  opts: { chunkBlocks?: number; maxBlocks?: number } = {}
): Promise<V4Pool | null> {
  if (!dex.v4PoolManager) return null;
  const provider = createProvider(rpcUrl);
  const target = getAddress(token);
  const wrapped = getAddress(dex.wrappedNative);
  const head = await provider.getBlockNumber();
  const chunk = opts.chunkBlocks ?? 5_000;
  const floor = Math.max(0, head - (opts.maxBlocks ?? 500_000));

  // The token is indexed as currency0 or currency1, so the node can answer
  // both without scanning -- two narrow filters beat one broad one.
  const found: V4Pool[] = [];
  for (let to = head; to > floor; to -= chunk) {
    const from = Math.max(floor, to - chunk + 1);
    for (const topics of [
      [INITIALIZE_TOPIC, null, zeroPadValue(target, 32), zeroPadValue(wrapped, 32)],
      [INITIALIZE_TOPIC, null, zeroPadValue(wrapped, 32), zeroPadValue(target, 32)],
    ]) {
      try {
        const logs = await provider.getLogs({
          address: getAddress(dex.v4PoolManager),
          fromBlock: from,
          toBlock: to,
          topics: topics as never,
        });
        for (const log of logs) {
          const pool = decodeInitialize(log as never, wrapped);
          if (pool) found.push(pool);
        }
      } catch {
        // A range this endpoint refused; keep walking back.
      }
    }
    // Newest first, and stop as soon as this chunk produced anything -- a
    // token that just launched is the case this exists for.
    if (found.length > 0) break;
  }
  if (found.length === 0) return null;
  return found.sort((a, b) => b.block - a.block)[0];
}

/**
 * Every V4 pool this token has, newest first.
 *
 * A token can be initialized in several pools -- different fee, different
 * hook, and usually only one of them holds the money. Returning all of them
 * lets the caller pick by what actually trades rather than by what was
 * created most recently, which is what pickTradeablePool does.
 */
export async function findV4Pools(
  rpcUrl: string,
  dex: DexConfig,
  token: string,
  opts: { chunkBlocks?: number; maxBlocks?: number } = {}
): Promise<V4Pool[]> {
  if (!dex.v4PoolManager) return [];
  const provider = createProvider(rpcUrl);
  const target = getAddress(token);
  const wrapped = getAddress(dex.wrappedNative);
  const head = await provider.getBlockNumber();
  const chunk = opts.chunkBlocks ?? 5_000;
  const floor = Math.max(0, head - (opts.maxBlocks ?? 500_000));
  const found: V4Pool[] = [];

  for (let to = head; to > floor; to -= chunk) {
    const from = Math.max(floor, to - chunk + 1);
    for (const topics of [
      [INITIALIZE_TOPIC, null, zeroPadValue(target, 32), zeroPadValue(wrapped, 32)],
      [INITIALIZE_TOPIC, null, zeroPadValue(wrapped, 32), zeroPadValue(target, 32)],
    ]) {
      try {
        const logs = await provider.getLogs({
          address: getAddress(dex.v4PoolManager),
          fromBlock: from,
          toBlock: to,
          topics: topics as never,
        });
        for (const log of logs) {
          const pool = decodeInitialize(log as never, wrapped);
          if (pool) found.push(pool);
        }
      } catch {
        /* range refused; keep walking */
      }
    }
    if (found.length > 0) break;
  }
  return found.sort((a, b) => b.block - a.block);
}

/**
 * The pool a buy should actually go through.
 *
 * Decided by simulating a small buy in each candidate and taking the first
 * that succeeds, rather than by picking the newest or the one with the
 * friendliest-looking fee. A pool that was initialized and never funded looks
 * identical to a real one from its Initialize event, and only trying tells
 * them apart.
 */
export async function pickTradeablePool(
  rpcUrl: string,
  dex: DexConfig,
  buyer: string,
  candidates: readonly V4Pool[],
  probeAmount: bigint
): Promise<V4Pool | null> {
  for (const pool of candidates) {
    const sim = await simulateBuy(rpcUrl, dex, pool, buyer, probeAmount);
    if (sim.ok) return pool;
  }
  return null;
}

const POOL_KEY_TUPLE = [POOL_KEY];

/**
 * How the PoolManager names a pool: keccak256 of the encoded key.
 *
 * Verified against a live pool -- the id computed here equals the one the
 * chain emitted in that pool's own Swap event.
 */
export function poolIdFor(key: PoolKey): string {
  return keccak256(
    CODER.encode(POOL_KEY_TUPLE, [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]])
  );
}

const STATE = new Interface(["function extsload(bytes32) view returns (bytes32)"]);

/**
 * V4 keeps every pool in one mapping, at storage slot 6.
 *
 * Confirmed by reading: slot 6 returns a sane sqrtPriceX96 and tick for a live
 * pool, while 5 and 7 return zero. There is no getter for this -- the
 * PoolManager exposes raw storage through extsload and expects callers to know
 * the layout.
 */
export const POOLS_SLOT = 6;

export interface PoolState {
  sqrtPriceX96: bigint;
  tick: number;
  /** Zero when the pool was initialized but never funded. */
  liquidity: bigint;
}

/** Current price and depth, or null when it cannot be read. */
export async function readPoolState(
  rpcUrl: string,
  dex: DexConfig,
  poolId: string
): Promise<PoolState | null> {
  if (!dex.v4PoolManager) return null;
  try {
    const provider = createProvider(rpcUrl);
    const base = keccak256(CODER.encode(["bytes32", "uint256"], [poolId, POOLS_SLOT]));
    const read = async (slot: string): Promise<bigint> => {
      const res = await provider.call({
        to: getAddress(dex.v4PoolManager!),
        data: STATE.encodeFunctionData("extsload", [slot]),
      });
      return BigInt(STATE.decodeFunctionResult("extsload", res)[0]);
    };

    const slot0 = await read(base);
    // slot0 packs sqrtPriceX96 | tick | protocolFee | lpFee. Liquidity sits
    // three words further on, after the two fee-growth accumulators.
    const liquiditySlot = "0x" + (BigInt(base) + 3n).toString(16).padStart(64, "0");
    const liquidity = await read(liquiditySlot).catch(() => 0n);

    const sqrtPriceX96 = slot0 & ((1n << 160n) - 1n);
    if (sqrtPriceX96 === 0n) return null;
    // tick is a signed 24-bit field.
    const raw = Number((slot0 >> 160n) & 0xffffffn);
    return {
      sqrtPriceX96,
      tick: raw >= 0x800000 ? raw - 0x1000000 : raw,
      liquidity: liquidity & ((1n << 128n) - 1n),
    };
  } catch {
    return null;
  }
}

const Q192 = 1n << 192n;

/**
 * What an amount of the token is worth in the quote asset, at pool price.
 *
 * sqrtPriceX96 encodes currency1 per currency0, so which way to divide depends
 * on which side the token sits -- and getting that backwards produces a number
 * that is wrong by the square of the price, which on a new token is wrong by
 * orders of magnitude in the direction that looks like a win.
 *
 * This is a MID price: it ignores fees and its own impact, so it is right for
 * deciding whether a ladder rung has been reached and wrong for promising what
 * a sale will return. The sale itself is what establishes that.
 */
export function quoteValueOf(pool: V4Pool, sqrtPriceX96: bigint, tokenAmount: bigint): bigint {
  if (sqrtPriceX96 === 0n || tokenAmount === 0n) return 0n;
  const p = sqrtPriceX96 * sqrtPriceX96;
  // buyIsZeroForOne means the quote asset is currency0, so the token is
  // currency1 and one token is worth 1/price of the quote.
  return pool.buyIsZeroForOne ? (tokenAmount * Q192) / p : (tokenAmount * p) / Q192;
}

export interface BuildSwapOpts {
  pool: V4Pool;
  /** Quote-asset amount to spend, in the quote token's own decimals. */
  amountIn: bigint;
  /** Floor on what comes back. Never leave this at zero on a real send. */
  amountOutMinimum: bigint;
  /** Seconds from now. */
  deadlineSeconds?: number;
  /** Set for a sell: spends the token and receives the quote asset. */
  sell?: boolean;
}

export interface SwapCall {
  to: string;
  data: string;
  value: bigint;
}

/**
 * Calldata for a V4 swap through the Universal Router.
 *
 * Verified by construction: fed the parameters of a real Arc swap, this
 * produces that swap's exact calldata, byte for byte.
 */
export function buildV4Swap(dex: DexConfig, opts: BuildSwapOpts): SwapCall {
  if (!dex.universalRouter) throw new Error(`no Universal Router configured for ${dex.chainKey}`);
  const { pool } = opts;

  // Buying spends the quote asset; selling spends the token. Which direction
  // that is depends on which side of the pool the quote asset sits.
  const zeroForOne = opts.sell ? !pool.buyIsZeroForOne : pool.buyIsZeroForOne;
  const inputCurrency = zeroForOne ? pool.key.currency0 : pool.key.currency1;
  const outputCurrency = zeroForOne ? pool.key.currency1 : pool.key.currency0;

  const swapParams = CODER.encode(
    [EXACT_IN_SINGLE],
    [
      [
        [pool.key.currency0, pool.key.currency1, pool.key.fee, pool.key.tickSpacing, pool.key.hooks],
        zeroForOne,
        opts.amountIn,
        opts.amountOutMinimum,
        // Zero means "no limit": the amountOutMinimum above is what actually
        // bounds the price, and it is the bound a caller can reason about.
        0n,
        "0x",
      ],
    ]
  );

  // SETTLE_ALL names what is paid in and caps it; TAKE_ALL names what comes
  // back and floors it. Getting these two the wrong way round pays the wrong
  // currency, so they are derived from the direction rather than passed in.
  const settle = CODER.encode(["address", "uint256"], [inputCurrency, opts.amountIn]);
  const take = CODER.encode(["address", "uint256"], [outputCurrency, opts.amountOutMinimum]);

  const inputs = [CODER.encode(["bytes", "bytes[]"], [BUY_ACTIONS, [swapParams, settle, take]])];
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts.deadlineSeconds ?? 300));

  return {
    to: getAddress(dex.universalRouter),
    data: ROUTER.encodeFunctionData("execute", [V4_SWAP, inputs, deadline]),
    // The input is pulled through Permit2, never sent as value -- even for
    // the native-mirrored quote asset, which is an ERC20 as far as the pool
    // is concerned.
    value: 0n,
  };
}

/** A slippage floor. Basis points off the quoted output. */
export function minOutFor(quoted: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.floor(slippageBps))));
  return (quoted * (10_000n - bps)) / 10_000n;
}

export interface ApprovalCall extends SwapCall {
  /** What this approval is for, so a confirmation prompt can say. */
  reason: string;
}

export const MAX_UINT160 = (1n << 160n) - 1n;
export const MAX_UINT256 = (1n << 256n) - 1n;
/** Permit2 expirations are uint48. This is its maximum -- effectively never. */
export const MAX_UINT48 = (1n << 48n) - 1n;

/**
 * The approvals this wallet still needs before it can buy.
 *
 * Returns an empty list when both are already in place, which is the normal
 * case after the first buy. Two are needed because the Universal Router does
 * not pull tokens itself: the ERC20 is approved to Permit2, and Permit2 is
 * approved to the router.
 */
export async function buildApprovals(
  rpcUrl: string,
  dex: DexConfig,
  owner: string,
  tokenIn: string,
  amount: bigint
): Promise<ApprovalCall[]> {
  if (!dex.permit2 || !dex.universalRouter) return [];
  const provider = createProvider(rpcUrl);
  const out: ApprovalCall[] = [];
  const token = getAddress(tokenIn);
  const permit2 = getAddress(dex.permit2);
  const router = getAddress(dex.universalRouter);

  let ercAllowance = 0n;
  try {
    const res = await provider.call({
      to: token,
      data: ERC20.encodeFunctionData("allowance", [getAddress(owner), permit2]),
    });
    ercAllowance = BigInt(ERC20.decodeFunctionResult("allowance", res)[0]);
  } catch {
    // Unreadable is treated as absent: a redundant approval costs one
    // transaction, a missing one costs the buy.
  }
  if (ercAllowance < amount) {
    out.push({
      to: token,
      data: ERC20.encodeFunctionData("approve", [permit2, MAX_UINT256]),
      value: 0n,
      reason: "approve the token to Permit2 (one-time)",
    });
  }

  let permitAmount = 0n;
  let permitExpiry = 0n;
  try {
    const res = await provider.call({
      to: permit2,
      data: PERMIT2.encodeFunctionData("allowance", [getAddress(owner), token, router]),
    });
    const decoded = PERMIT2.decodeFunctionResult("allowance", res);
    permitAmount = BigInt(decoded[0]);
    permitExpiry = BigInt(decoded[1]);
  } catch {
    /* treat as absent */
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (permitAmount < amount || permitExpiry <= now) {
    out.push({
      to: permit2,
      data: PERMIT2.encodeFunctionData("approve", [token, router, MAX_UINT160, MAX_UINT48]),
      value: 0n,
      reason: "approve Permit2 to the router (one-time)",
    });
  }
  return out;
}

/**
 * Simulate a buy as if the approvals were already in place.
 *
 * The point is to test the SWAP before spending anything on approvals: a
 * token that cannot be bought should not cost two approval transactions to
 * find that out. The approvals are fabricated in the simulation the same way
 * the honeypot check fabricates a balance -- by overriding state, which
 * changes nothing on-chain.
 */
export async function simulateBuy(
  rpcUrl: string,
  dex: DexConfig,
  pool: V4Pool,
  buyer: string,
  amountIn: bigint
): Promise<{ ok: boolean; error?: string }> {
  if (!dex.permit2 || !dex.universalRouter || dex.wrappedAllowanceSlot === undefined) {
    return { ok: false, error: "this chain has no router configured" };
  }
  const provider = createProvider(rpcUrl);
  const owner = getAddress(buyer);
  const wrapped = getAddress(dex.wrappedNative);
  const permit2 = getAddress(dex.permit2);
  const router = getAddress(dex.universalRouter);

  const ercSlot = keccak256(
    concat([
      zeroPadValue(permit2, 32),
      keccak256(concat([zeroPadValue(owner, 32), zeroPadValue(toBeHex(dex.wrappedAllowanceSlot), 32)])),
    ])
  );
  // Permit2's allowance mapping lives at slot 1, packed as
  // nonce(48) | expiration(48) | amount(160) in a single word.
  const permitSlot = keccak256(
    concat([
      zeroPadValue(router, 32),
      keccak256(
        concat([
          zeroPadValue(wrapped, 32),
          keccak256(concat([zeroPadValue(owner, 32), zeroPadValue(toBeHex(1), 32)])),
        ])
      ),
    ])
  );
  const packed =
    "0x" + "000000000000" + MAX_UINT48.toString(16).padStart(12, "0") + MAX_UINT160.toString(16).padStart(40, "0");

  const call = buildV4Swap(dex, { pool, amountIn, amountOutMinimum: 0n });
  try {
    await provider.send("eth_call", [
      { from: owner, to: call.to, data: call.data },
      "latest",
      {
        // The balance matters as much as the approvals, and leaving it out
        // produces TRANSFER_FROM_FAILED -- which reads like a broken approval
        // and is really an empty wallet. On Arc the wrapped quote asset
        // mirrors the native balance, so funding the native side funds both.
        [owner]: { balance: "0x" + (10_000n * 10n ** 18n).toString(16) },
        [wrapped]: { stateDiff: { [ercSlot]: "0x" + MAX_UINT256.toString(16) } },
        [permit2]: { stateDiff: { [permitSlot]: packed } },
      },
    ]);
    return { ok: true };
  } catch (err) {
    const e = err as { shortMessage?: string; message?: string };
    return { ok: false, error: e?.shortMessage ?? e?.message ?? "reverted" };
  }
}
