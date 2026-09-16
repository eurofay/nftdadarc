// Finding out whether a token can be SOLD, before buying it.
//
// This is the single most valuable thing in the memecoin path, and it is worth
// being precise about why. A honeypot is not a token that goes down. It is a
// token whose transfer logic lets you buy and then refuses to let you sell --
// the chart looks perfect, every buyer is trapped, and the only exit is the
// deployer's. No amount of chart-reading, holder-counting or deployer-vetting
// detects it. Trying to sell detects it, every time, with certainty.
//
// HOW IT IS DONE WITHOUT SPENDING ANYTHING. eth_call takes a third parameter
// on this chain (measured: Arc supports state overrides) which lets a call run
// against modified state. So a probe address can be given a balance it does
// not have, buy the token, and try to sell it -- all inside a simulation that
// touches no real money and leaves no trace. What comes back is what WOULD
// have happened.
//
// WHAT IT PROVES AND WHAT IT DOES NOT. It proves the token is sellable by this
// address, at this block, under these rules. It does not prove it will be
// sellable later: a deployer can enable a tax, add a blacklist or pull the
// liquidity at any point, and several of those are a single transaction. So
// this is a filter that removes the already-certain losses, not a guarantee --
// and the rug tripwire in position.ts exists precisely because this check
// cannot cover the future.
//
// THE OTHER HALF IS TAX. A token that sells but returns 70% of what the pool
// price implies is not a honeypot, it is a slow one. The round trip measures
// what actually comes back rather than what the contract claims, because
// several tokens expose a taxRate() that has nothing to do with _transfer.

import { AbiCoder, Interface, getAddress, id, keccak256 } from "ethers";
import { createProvider } from "./rpc-provider";
import { DexConfig } from "./dex-registry";

const CODER = AbiCoder.defaultAbiCoder();

/**
 * The address the simulation acts as.
 *
 * Deliberately an address nobody holds the key to and which holds no tokens,
 * so the simulation starts from a clean slate every time and cannot be
 * confused by a real balance. Its funds come entirely from the state override.
 */
export const PROBE_ADDRESS = "0x000000000000000000000000000000000000BEEF";

export const ERC20 = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function owner() view returns (address)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);

export type SafetyVerdict = "SELLABLE" | "HONEYPOT" | "HIGH_TAX" | "NO_LIQUIDITY" | "UNKNOWN";

export interface SafetyReport {
  verdict: SafetyVerdict;
  /** Percentage of value lost across a buy and an immediate sell, 0-100. */
  roundTripLossPct?: number;
  /** Where the sell failed, when it did. */
  sellError?: string;
  /** What the simulation actually managed to do, for a report that can be read. */
  boughtRaw?: bigint;
  returnedRaw?: bigint;
  detail: string;
}

export interface SafetyOpts {
  rpcUrl: string;
  dex: DexConfig;
  token: string;
  feeTier: number;
  /** How much quote asset to test with. Small, but not dust. */
  probeAmountWei?: bigint;
  /** Above this, a token is reported HIGH_TAX rather than SELLABLE. */
  maxLossPct?: number;
}

/** 1 unit of an 18-decimal quote asset -- enough to price, small enough to be typical. */
export const DEFAULT_PROBE_WEI = 10n ** 18n;
/**
 * Round-trip loss above which a token is not worth holding.
 *
 * A Uniswap pool charges its fee twice on a round trip plus price impact, so
 * even a clean token does not return 100%. At the 1% tier that is ~2% of fees
 * before impact, and a thin new pool can add several more. 25% leaves room for
 * that while still catching the 30-50% taxes that are the common trap.
 */
export const DEFAULT_MAX_LOSS_PCT = 25;

/** Uniswap V3 QuoterV2-style, used through a revert so it needs no approval. */
const QUOTER = new Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)",
]);

const POOL = new Interface([
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
]);

/**
 * Simulate a swap directly against the pool pair, both directions.
 *
 * Uses the pool's own quoting rather than a router so it works whatever router
 * the chain settles on, and so a missing router cannot be mistaken for a
 * missing token.
 */
export interface QuoteFn {
  (args: { tokenIn: string; tokenOut: string; amountIn: bigint; fee: number }): Promise<bigint | null>;
}

/**
 * Whether the token can be sold, measured by trying.
 *
 * Buys with the quote asset, then sells everything received straight back. A
 * token that cannot complete the second leg is a honeypot however good the
 * first leg looked -- and the first leg always looks good, which is the point
 * of the design.
 */
export async function checkTokenSafety(
  opts: SafetyOpts,
  quote: QuoteFn
): Promise<SafetyReport> {
  const amountIn = opts.probeAmountWei ?? DEFAULT_PROBE_WEI;
  const maxLoss = opts.maxLossPct ?? DEFAULT_MAX_LOSS_PCT;
  const token = getAddress(opts.token);
  const wrapped = getAddress(opts.dex.wrappedNative);

  // ── Leg one: can it be bought at all? ──────────────────────────────────
  let bought: bigint | null;
  try {
    bought = await quote({ tokenIn: wrapped, tokenOut: token, amountIn, fee: opts.feeTier });
  } catch (err) {
    return {
      verdict: "UNKNOWN",
      detail: `could not simulate a buy: ${(err as Error)?.message ?? err}`,
    };
  }
  if (bought === null || bought === 0n) {
    // No pool, or a pool with nothing in it. Not a honeypot -- just not
    // tradeable yet, which for a launch being watched live is normal for the
    // first few blocks.
    return { verdict: "NO_LIQUIDITY", detail: "the pool returned nothing for a buy -- no liquidity yet" };
  }

  // ── Leg two: the one that matters ──────────────────────────────────────
  let returned: bigint | null;
  try {
    returned = await quote({ tokenIn: token, tokenOut: wrapped, amountIn: bought, fee: opts.feeTier });
  } catch (err) {
    // A revert on the sell leg, with a buy leg that worked, is the signature.
    return {
      verdict: "HONEYPOT",
      boughtRaw: bought,
      sellError: (err as Error)?.message ?? String(err),
      detail: "the buy simulates fine and the sell reverts -- this is a honeypot",
    };
  }
  if (returned === null || returned === 0n) {
    return {
      verdict: "HONEYPOT",
      boughtRaw: bought,
      detail: "selling the tokens straight back returns nothing",
    };
  }

  const lossPct = Number(((amountIn - returned) * 10_000n) / amountIn) / 100;
  const report: SafetyReport = {
    roundTripLossPct: lossPct,
    boughtRaw: bought,
    returnedRaw: returned,
    verdict: "SELLABLE",
    detail: `round trip returns ${(100 - lossPct).toFixed(1)}% -- sellable`,
  };

  if (lossPct > maxLoss) {
    report.verdict = "HIGH_TAX";
    report.detail =
      `a buy and an immediate sell loses ${lossPct.toFixed(1)}%, which is above the ` +
      `${maxLoss}% limit. Fees and impact explain a few points; the rest is tax.`;
  }
  // Negative loss means the round trip returned MORE than it cost, which no
  // honest pool does -- it means the quote is being manipulated or the pool is
  // too thin for the probe size to mean anything.
  if (lossPct < -1) {
    report.verdict = "UNKNOWN";
    report.detail =
      "the round trip returned more than it cost, which no real pool does -- " +
      "the pool is too thin for this probe size to say anything useful";
  }
  return report;
}

/**
 * Where a token keeps its balances, found by trying.
 *
 * Needed because the honeypot check has to give the probe address tokens it
 * does not own, and the only way to do that in a simulation is to overwrite
 * the exact storage slot the balance lives in. Solidity puts a
 * `mapping(address => uint256)` entry at keccak256(abi.encode(key, slot)), so
 * the slot NUMBER is all that has to be discovered -- and it is discovered by
 * overwriting a candidate and asking balanceOf whether it took.
 *
 * Measured on Arc against a live token: slot 0, found on the first try. Most
 * ERC20s land in the first handful; the scan stops at 30 rather than guessing
 * a convention, and a token using a non-standard layout simply returns null
 * instead of being silently mis-simulated.
 */
export async function findBalanceSlot(
  rpcUrl: string,
  token: string,
  maxSlot = 30
): Promise<number | null> {
  const provider = createProvider(rpcUrl);
  // Distinctive enough that a coincidental match is not a concern.
  const magic = "0x" + (10n ** 18n).toString(16).padStart(64, "0");
  const data = ERC20.encodeFunctionData("balanceOf", [PROBE_ADDRESS]);

  for (let slot = 0; slot < maxSlot; slot++) {
    const key = keccak256(CODER.encode(["address", "uint256"], [PROBE_ADDRESS, slot]));
    try {
      const res = await provider.send("eth_call", [
        { to: getAddress(token), data },
        "latest",
        { [getAddress(token)]: { stateDiff: { [key]: magic } } },
      ]);
      if (res && BigInt(res) === BigInt(magic)) return slot;
    } catch {
      // A node that rejects the override shape, or a token whose balanceOf
      // reverts. Either way this slot is not the answer.
    }
  }
  return null;
}

/**
 * Can the probe address move this token AT ALL?
 *
 * The cheapest decisive honeypot test there is, and it needs no router, no
 * quoter and no knowledge of which DEX the token trades on. A sell IS a
 * transfer to the pool, so a token that blocks selling blocks this -- and a
 * token that permits it has, at minimum, no blanket transfer trap.
 *
 * Runs entirely inside eth_call against overridden state: the probe is handed
 * a balance it never had, and nothing is sent, spent or recorded.
 */
export async function canTransfer(
  rpcUrl: string,
  token: string,
  to: string,
  amount: bigint,
  slot: number
): Promise<{ ok: boolean; error?: string }> {
  const provider = createProvider(rpcUrl);
  const key = keccak256(CODER.encode(["address", "uint256"], [PROBE_ADDRESS, slot]));
  const balance = "0x" + (amount * 2n).toString(16).padStart(64, "0");

  try {
    const res = await provider.send("eth_call", [
      {
        from: PROBE_ADDRESS,
        to: getAddress(token),
        data: ERC20.encodeFunctionData("transfer", [getAddress(to), amount]),
      },
      "latest",
      { [getAddress(token)]: { stateDiff: { [key]: balance } } },
    ]);
    // A transfer that returns false rather than reverting is still a refusal,
    // and several traps are written exactly that way.
    if (res && res !== "0x") {
      const [ok] = CODER.decode(["bool"], res);
      if (!ok) return { ok: false, error: "transfer returned false" };
    }
    return { ok: true };
  } catch (err) {
    const e = err as { shortMessage?: string; message?: string };
    return { ok: false, error: e?.shortMessage ?? e?.message ?? "transfer reverted" };
  }
}

/**
 * The honeypot check as it actually runs, with no router required.
 *
 * Deliberately separate from checkTokenSafety above, which measures TAX and
 * needs a quoter. This one answers the binary question -- can it be sold --
 * and answers it on any chain, for any token, using only eth_call.
 */
export async function checkSellable(
  rpcUrl: string,
  token: string,
  pool: string,
  amount = 10n ** 15n
): Promise<SafetyReport> {
  const slot = await findBalanceSlot(rpcUrl, token);
  if (slot === null) {
    return {
      verdict: "UNKNOWN",
      detail:
        "this token does not keep balances anywhere this can find, so a sell could not be " +
        "simulated. Treat it as unchecked rather than as safe.",
    };
  }

  const moved = await canTransfer(rpcUrl, token, pool, amount, slot);
  if (!moved.ok) {
    return {
      verdict: "HONEYPOT",
      sellError: moved.error,
      detail: `tokens cannot be moved to the pool -- ${moved.error}. This is what a honeypot looks like.`,
    };
  }
  return {
    verdict: "SELLABLE",
    detail: "tokens can be moved to the pool, so there is no blanket transfer trap",
  };
}

/** A quoter backed by a deployed QuoterV2, simulated through eth_call. */
export function quoterAt(rpcUrl: string, quoterAddress: string): QuoteFn {
  const provider = createProvider(rpcUrl);
  return async ({ tokenIn, tokenOut, amountIn, fee }) => {
    const data = QUOTER.encodeFunctionData("quoteExactInputSingle", [
      { tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n },
    ]);
    const res = await provider.call({ to: getAddress(quoterAddress), data, from: PROBE_ADDRESS });
    const [amountOut] = QUOTER.decodeFunctionResult("quoteExactInputSingle", res);
    return BigInt(amountOut);
  };
}

export interface LiquidityInfo {
  liquidity: bigint;
  sqrtPriceX96: bigint;
  /** Quote-asset balance sitting in the pool -- the real depth number. */
  quoteReserve?: bigint;
}

/** What is actually in the pool right now. */
export async function readLiquidity(
  rpcUrl: string,
  pool: string,
  quoteToken: string
): Promise<LiquidityInfo | null> {
  try {
    const provider = createProvider(rpcUrl);
    const [liqRes, slotRes, balRes] = await Promise.all([
      provider.call({ to: getAddress(pool), data: POOL.encodeFunctionData("liquidity") }),
      provider.call({ to: getAddress(pool), data: POOL.encodeFunctionData("slot0") }),
      provider
        .call({
          to: getAddress(quoteToken),
          data: ERC20.encodeFunctionData("balanceOf", [getAddress(pool)]),
        })
        .catch(() => null),
    ]);
    return {
      liquidity: BigInt(POOL.decodeFunctionResult("liquidity", liqRes)[0]),
      sqrtPriceX96: BigInt(POOL.decodeFunctionResult("slot0", slotRes)[0]),
      quoteReserve: balRes ? BigInt(CODER.decode(["uint256"], balRes)[0]) : undefined,
    };
  } catch {
    return null;
  }
}

export interface OwnershipInfo {
  owner?: string;
  /** Ownership given up -- the owner is the zero or dead address. */
  renounced: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dEaD";

/**
 * Who can still change this token's rules.
 *
 * Renounced ownership is not safety -- a token can be built to trap sellers
 * with no owner at all -- but a LIVE owner means the rules can change after
 * the safety check passes, which is the gap the tripwire covers.
 */
export async function readOwnership(rpcUrl: string, token: string): Promise<OwnershipInfo> {
  try {
    const provider = createProvider(rpcUrl);
    const res = await provider.call({
      to: getAddress(token),
      data: ERC20.encodeFunctionData("owner"),
    });
    const owner = getAddress(String(ERC20.decodeFunctionResult("owner", res)[0]));
    return {
      owner,
      renounced: owner === ZERO || owner.toLowerCase() === DEAD.toLowerCase(),
    };
  } catch {
    // No owner() at all. Common, and not itself a signal either way.
    return { renounced: false };
  }
}

/** One line for an alert, said the way someone deciding in ten seconds needs it. */
export function describeSafety(r: SafetyReport): string {
  switch (r.verdict) {
    case "HONEYPOT":
      return `🚫 HONEYPOT — ${r.detail}`;
    case "HIGH_TAX":
      return `⚠️ ${r.roundTripLossPct?.toFixed(1)}% round-trip loss — ${r.detail}`;
    case "NO_LIQUIDITY":
      return "⏳ no liquidity yet";
    case "SELLABLE":
      // Only claim a round-trip figure when one was actually measured.
      // checkSellable proves transferability and measures no value at all, and
      // printing "100.0% back" for it would be inventing the most reassuring
      // possible number out of an absent one.
      return r.roundTripLossPct === undefined
        ? `✅ sellable — ${r.detail}`
        : `✅ sellable — ${(100 - r.roundTripLossPct).toFixed(1)}% back on a round trip`;
    default:
      return `❓ ${r.detail}`;
  }
}

export interface TokenInfo {
  address: string;
  name?: string;
  symbol?: string;
  decimals: number;
  totalSupply?: bigint;
}

/**
 * A token's own description of itself.
 *
 * Every field optional except decimals, which defaults to 18: a token that
 * will not say is far more likely to be an 18-decimal token with a missing
 * getter than a 6-decimal one, and guessing wrong here misprices a position
 * by a factor of a trillion. Nothing here is trusted as a safety signal --
 * a name is chosen by whoever deployed it.
 */
export async function readTokenInfo(rpcUrl: string, token: string): Promise<TokenInfo> {
  const provider = createProvider(rpcUrl);
  const addr = getAddress(token);
  const read = async <T>(fn: string, type: string): Promise<T | undefined> => {
    try {
      const res = await provider.call({ to: addr, data: ERC20.encodeFunctionData(fn) });
      if (!res || res === "0x") return undefined;
      return ERC20.decodeFunctionResult(fn, res)[0] as T;
    } catch {
      return undefined;
    }
  };

  const [name, symbol, decimals, totalSupply] = await Promise.all([
    read<string>("name", "string"),
    read<string>("symbol", "string"),
    read<bigint>("decimals", "uint8"),
    read<bigint>("totalSupply", "uint256"),
  ]);

  return {
    address: addr,
    name: name ? String(name) : undefined,
    symbol: symbol ? String(symbol) : undefined,
    decimals: decimals === undefined ? 18 : Number(decimals),
    totalSupply: totalSupply === undefined ? undefined : BigInt(totalSupply),
  };
}
