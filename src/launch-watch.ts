// Seeing a token the moment its pool exists.
//
// A memecoin becomes tradeable at exactly one instant: when a pool is created
// and funded. Before that there is nothing to buy; after that everyone can see
// it. So the whole of "early" is the gap between the pool appearing on-chain
// and you knowing about it, and that gap is the only thing this file is for.
//
// WHAT THIS IS NOT. It is not front-running. Arc has no public mempool at all
// -- txpool_status answers "method not supported" and the pending block is
// unavailable -- so there is no pending transaction to get ahead of, and the
// sequencer orders by arrival rather than by fee. This watches events that
// have already been mined and are public to everyone at the same moment.
// Being fast to a public event is competing; there is nobody on the other side
// of it being made worse off.
//
// POLLING, NOT SUBSCRIBING. A websocket would be a block or two faster but
// dies silently and takes the watcher with it -- that failure mode has already
// cost this repo a whole bot (see the drop-radar crash). Arc's blocks are
// ~0.5s, so a 2s poll is at worst four blocks behind, which against a
// launch-every-18-seconds cadence is not the binding constraint. The binding
// constraint is how long the safety checks take, which is why they run
// concurrently rather than in the alert path.

import { AbiCoder, Interface, getAddress, id } from "ethers";
import { createProvider } from "./rpc-provider";
import { DexConfig } from "./dex-registry";
import { logChunkBlocksFor } from "./chains";

const CODER = AbiCoder.defaultAbiCoder();

/** keccak256("PoolCreated(address,address,uint24,int24,address)") */
export const POOL_CREATED_TOPIC = id("PoolCreated(address,address,uint24,int24,address)");
/** keccak256("PairCreated(address,address,address,uint256)") */
export const PAIR_CREATED_TOPIC = id("PairCreated(address,address,address,uint256)");

export interface LaunchSighting {
  /** The new token -- whichever side of the pair is not the quote asset. */
  token: string;
  /** What it trades against. */
  quote: string;
  /** The pool or pair contract. */
  pool: string;
  /** V3 fee tier in hundredths of a bip; undefined for a V2 pair. */
  feeTier?: number;
  venue: "v3" | "v2";
  block: number;
  txHash: string;
  /** Wall-clock when this was SEEN, which is not when it was mined. */
  seenAt: number;
}

/**
 * Decode one factory log into a sighting, or null.
 *
 * Returns null rather than throwing for anything unexpected: a watcher reads
 * logs from contracts it does not control, and one malformed entry must not
 * stop the poll that would have found the next launch.
 */
export function decodeLaunch(
  log: { address: string; topics: readonly string[]; data: string; blockNumber: string | number; transactionHash: string },
  dex: DexConfig,
  seenAt = Date.now()
): LaunchSighting | null {
  try {
    const topic = log.topics[0];
    const isV3 = topic === POOL_CREATED_TOPIC;
    const isV2 = topic === PAIR_CREATED_TOPIC;
    if (!isV3 && !isV2) return null;

    const token0 = getAddress("0x" + log.topics[1].slice(26));
    const token1 = getAddress("0x" + log.topics[2].slice(26));
    const wrapped = getAddress(dex.wrappedNative);

    // The interesting side is whichever one is not the quote asset. A pool
    // between two known assets is not a launch, and a pool between two
    // unknowns cannot be priced against anything, so both are skipped.
    let token: string;
    if (token0 === wrapped) token = token1;
    else if (token1 === wrapped) token = token0;
    else return null;

    let pool: string;
    let feeTier: number | undefined;
    if (isV3) {
      // PoolCreated indexes token0, token1 and fee; tickSpacing and pool are
      // in the data.
      feeTier = Number(BigInt(log.topics[3]));
      const [, poolAddr] = CODER.decode(["int24", "address"], log.data);
      pool = getAddress(String(poolAddr));
    } else {
      const [pairAddr] = CODER.decode(["address", "uint256"], log.data);
      pool = getAddress(String(pairAddr));
    }

    return {
      token,
      quote: wrapped,
      pool,
      feeTier,
      venue: isV3 ? "v3" : "v2",
      block: typeof log.blockNumber === "string" ? parseInt(log.blockNumber, 16) : log.blockNumber,
      txHash: log.transactionHash,
      seenAt,
    };
  } catch {
    return null;
  }
}

export interface WatchOpts {
  rpcUrl: string;
  dex: DexConfig;
  /** Milliseconds between polls. */
  pollMs?: number;
  /**
   * Start this many blocks back on the first poll.
   *
   * Deliberately small and deliberately not zero: a few blocks of overlap
   * covers a restart landing mid-block, while a large backfill would fire
   * alerts for launches that are already minutes old and already traded.
   */
  backfillBlocks?: number;
  onLaunch: (sighting: LaunchSighting) => void;
  onError?: (err: Error) => void;
}

export const DEFAULT_POLL_MS = 2_000;
export const DEFAULT_BACKFILL_BLOCKS = 20;

/**
 * Poll the configured factories for new pools until stopped.
 *
 * Returns a stop function. Never throws out of the loop: an RPC hiccup must
 * cost one poll, not the watcher -- an unhandled rejection here would take the
 * whole bot process down with it, which is exactly how bot 3 died.
 */
export function watchLaunches(opts: WatchOpts): () => void {
  const provider = createProvider(opts.rpcUrl);
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const chunk = logChunkBlocksFor(opts.dex.chainKey);
  const factories = [...opts.dex.v3Factories, ...opts.dex.v2Factories].map((f) => f.toLowerCase());

  let stopped = false;
  let cursor: number | null = null;
  // A pool can be reported twice across an overlapping window, and alerting
  // twice for one launch is worse than a missed poll -- it looks like two
  // opportunities.
  const seen = new Set<string>();

  const tick = async (): Promise<void> => {
    const head = await provider.getBlockNumber();
    if (cursor === null) {
      cursor = Math.max(0, head - (opts.backfillBlocks ?? DEFAULT_BACKFILL_BLOCKS));
    }
    if (head < cursor) return;

    // Bounded so a long stall cannot ask for a range the node refuses; the
    // next tick picks up where this one stopped.
    const to = Math.min(head, cursor + chunk - 1);
    const logs = await provider.getLogs({
      fromBlock: cursor,
      toBlock: to,
      topics: [[POOL_CREATED_TOPIC, PAIR_CREATED_TOPIC]],
    });

    for (const log of logs) {
      if (!factories.includes(log.address.toLowerCase())) continue;
      const sighting = decodeLaunch(log as never, opts.dex);
      if (!sighting) continue;
      const key = sighting.pool.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // The callback is the caller's problem, but a throw from it must not
      // end the poll loop or skip the launches after it in this batch.
      try {
        opts.onLaunch(sighting);
      } catch (err) {
        opts.onError?.(err as Error);
      }
    }
    cursor = to + 1;
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await tick();
      } catch (err) {
        opts.onError?.(err as Error);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };

  // Started detached, but every throw inside is already caught above -- this
  // must never become an unhandled rejection.
  void loop();
  return () => {
    stopped = true;
  };
}

const PAIR_IFACE = new Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

/**
 * Which side of an existing pool is the tradeable token.
 *
 * Used when a token is pasted rather than spotted, so the same pipeline can
 * price and check it.
 */
export async function tokenSideOf(
  rpcUrl: string,
  pool: string,
  wrappedNative: string
): Promise<{ token: string; quote: string } | null> {
  try {
    const provider = createProvider(rpcUrl);
    const read = async (fn: "token0" | "token1") => {
      const res = await provider.call({ to: getAddress(pool), data: PAIR_IFACE.encodeFunctionData(fn) });
      return getAddress(String(PAIR_IFACE.decodeFunctionResult(fn, res)[0]));
    };
    const [t0, t1] = await Promise.all([read("token0"), read("token1")]);
    const wrapped = getAddress(wrappedNative);
    if (t0 === wrapped) return { token: t1, quote: t0 };
    if (t1 === wrapped) return { token: t0, quote: t1 };
    return null;
  } catch {
    return null;
  }
}

const FACTORY = new Interface([
  "function getPool(address,address,uint24) view returns (address)",
  "function getPair(address,address) view returns (address)",
]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface FoundPool {
  pool: string;
  feeTier?: number;
  venue: "v3" | "v2";
}

/**
 * The pool a pasted TOKEN trades in.
 *
 * Needed because a person pastes a contract address, not a pool address, and
 * the sell test has to have somewhere to simulate selling TO. Asks each
 * configured factory for that token paired against the quote asset, across
 * the fee tiers in the order most likely to hold the liquidity.
 *
 * Returns the first pool that EXISTS, which is not necessarily the deepest --
 * a token can have pools at several tiers with the real money in one of them.
 * That is enough for a sell test, which only needs a legitimate destination;
 * depth is read separately and reported on its own.
 */
export async function findPoolForToken(
  rpcUrl: string,
  dex: DexConfig,
  token: string
): Promise<FoundPool | null> {
  const provider = createProvider(rpcUrl);
  const a = getAddress(token);
  const b = getAddress(dex.wrappedNative);

  for (const factory of dex.v3Factories) {
    for (const fee of dex.feeTiers) {
      try {
        const res = await provider.call({
          to: getAddress(factory),
          data: FACTORY.encodeFunctionData("getPool", [a, b, fee]),
        });
        const pool = getAddress(String(FACTORY.decodeFunctionResult("getPool", res)[0]));
        if (pool !== ZERO_ADDRESS) return { pool, feeTier: fee, venue: "v3" };
      } catch {
        // This tier does not exist on this factory, which is the normal case
        // for most tiers on most tokens.
      }
    }
  }

  for (const factory of dex.v2Factories) {
    try {
      const res = await provider.call({
        to: getAddress(factory),
        data: FACTORY.encodeFunctionData("getPair", [a, b]),
      });
      const pool = getAddress(String(FACTORY.decodeFunctionResult("getPair", res)[0]));
      if (pool !== ZERO_ADDRESS) return { pool, venue: "v2" };
    } catch {
      /* no pair here */
    }
  }
  return null;
}
