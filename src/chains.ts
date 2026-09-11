// Chain registry — everything chain-specific lives here so adding a new
// network is a single entry instead of hunting for hardcoded values.
//
// `key` is the identifier used in two places, and they must match:
//   1. the OpenSea REST v2 `chain` field (slug-resolver.ts)
//   2. the `CHAIN` env var (also the wizard's chain-picker default)
//
// OpenSea confirmed support for Robinhood Chain (opensea.io/discover/chain/robinhood),
// so the existing OpenSea-based mint flow works on it unchanged — only the RPC
// (in .env) and the explorer links (resolved here) differ from Base.

export interface ChainProfile {
  key: string;          // OpenSea REST v2 chain id + CHAIN env value
  chainId: number;      // EVM network chain id
  name: string;         // human label
  explorer: string;     // block explorer base URL, NO trailing slash
  nativeSymbol: string;
  // Seconds per block, measured. Used to turn a block count into a span of
  // time: "200 blocks behind" means 40 minutes on Ethereum and 20 seconds on
  // Robinhood, so any tolerance expressed in blocks is really a per-chain
  // constant in disguise.
  blockSeconds: number;
  /**
   * True where a priority fee buys nothing, so paying one is pure waste.
   *
   * On Ethereum a tip is a bid for position in the next block. On a single
   * sequencer with no public mempool there is no auction to bid in: ordering
   * is by arrival at the sequencer, full stop. Measured on Robinhood --
   * eth_maxPriorityFeePerGas answers 0x0, and real mints landing in contested
   * blocks carry a tip of 0 or 1e-8 gwei.
   *
   * The cost of ignoring this is not theoretical. Base fee here sits at
   * ~0.106 gwei, so a 0.05 gwei tip is a 47% surcharge on every transaction
   * in exchange for no advantage whatsoever.
   */
  noPriorityFee?: boolean;
  rpc: {
    alchemyHost?: string; // Alchemy host for this network (docs/reference)
    public: string[];     // public RPC + sequencer endpoints
    // How many blocks this chain's endpoint accepts in one eth_getLogs.
    // Measured, not assumed — it's a property of the endpoint and varies
    // hugely: Alchemy's free tier allows 10 on every chain, while
    // Robinhood's own public RPC serves 10,000 in ~300ms. Overridable per
    // chain with AUTO_LOG_CHUNK_BLOCKS_<CHAIN>.
    logChunkBlocks?: number;
  };
}

export const CHAINS: ChainProfile[] = [
  {
    key: "ethereum",
    chainId: 1,
    name: "Ethereum",
    explorer: "https://etherscan.io",
    nativeSymbol: "ETH",
    blockSeconds: 12.05,
    rpc: {
      alchemyHost: "eth-mainnet.g.alchemy.com",
      // Measured on publicnode, which is the endpoint that actually serves
      // scans. This was 10 -- an Alchemy free-tier number applied to
      // endpoints that are not Alchemy -- and at 12s blocks that is TWO
      // MINUTES of chain per call. A 12-hour backfill is ~3,584 blocks, so
      // 359 sequential round trips: the watcher never caught up, which is
      // why auto-mint on Ethereum never did anything.
      logChunkBlocks: 500,
      public: [
        "https://ethereum-rpc.publicnode.com",
        "https://eth.drpc.org",
        // Answers reads and sends but refuses eth_getLogs entirely, so it is
        // last: useful as a send path, useless for watching.
        "https://1rpc.io/eth",
        // Removed: cloudflare-eth.com reported NO CODE at the SeaDrop
        // singleton, which would fail every mint resolution that landed on
        // it, and eth.merkle.io answers HTML rather than JSON-RPC.
      ],
    },
  },
  {
    key: "base",
    chainId: 8453,
    name: "Base",
    explorer: "https://basescan.org",
    nativeSymbol: "ETH",
    blockSeconds: 2,
    rpc: {
      alchemyHost: "base-mainnet.g.alchemy.com",
      // Measured: both endpoints below serve 2000 in one call. The old 10 was
      // the same borrowed Alchemy limit as Ethereum's.
      logChunkBlocks: 2000,
      public: [
        "https://mainnet.base.org",
        "https://base-rpc.publicnode.com",
        // Send-only (rejects eth_chainId/eth_call) but the fastest inclusion
        // path — planRpcs keeps it for blasting and never reads from it.
        //
        // It survives an endpoint audit only because of this comment: a probe
        // that asks every URL for its chain id concludes this one is broken
        // and drops it, which is exactly what happened once.
        "https://mainnet-sequencer.base.org",
      ],
    },
  },
  {
    key: "robinhood",
    chainId: 4663,
    name: "Robinhood Chain",
    explorer: "https://robinhoodchain.blockscout.com",
    nativeSymbol: "ETH",
    blockSeconds: 0.1,
    noPriorityFee: true,
    rpc: {
      alchemyHost: "robinhood-mainnet.g.alchemy.com",
      // The real limit here is a RESULT cap, not a block span: this endpoint
      // refuses any query matching more than 10,000 logs. Measured against
      // the auto-mint filter (SeaDrop address, all topics):
      //
      //    2,000 blocks ->  1,318 logs   3.3 min of chain
      //   10,000 blocks -> ~2,300 logs  16.7 min
      //   20,000 blocks ->  4,655 logs  33.3 min
      //  100,000 blocks -> refused, "exceeds limit of 10000"
      //
      // 10,000 leaves roughly 4x headroom under the cap, which matters
      // because a busy drop raises log density -- and a refused chunk is
      // skipped rather than retried, so blowing the cap loses sightings
      // silently. At 2,000 a 12-hour backfill took 216 sequential calls.
      logChunkBlocks: 10_000,
      public: [
        "https://rpc.mainnet.chain.robinhood.com",
        "https://sequencer.mainnet.chain.robinhood.com",
      ],
    },
  },
  {
    key: "arbitrum",
    chainId: 42161,
    name: "Arbitrum One",
    explorer: "https://arbiscan.io",
    nativeSymbol: "ETH",
    // Measured over 500 blocks. Nitro produces them on demand, so this is an
    // average rather than a target.
    blockSeconds: 0.25,
    // eth_maxPriorityFeePerGas answers 0. Like Robinhood, this is one
    // sequencer ordering by arrival -- there is no auction, so a tip is money
    // given away. See gas-fit.effectivePriority.
    noPriorityFee: true,
    rpc: {
      alchemyHost: "arb-mainnet.g.alchemy.com",
      // arb1 served 50,000 in one call; held at 10,000 so a fallback endpoint
      // is not asked for a range only the primary can do.
      logChunkBlocks: 10_000,
      public: [
        "https://arb1.arbitrum.io/rpc",
        // publicnode allows only 10 blocks per eth_getLogs here, so it is a
        // send-and-read path rather than a scanning one.
        "https://arbitrum-one-rpc.publicnode.com",
      ],
    },
  },
  {
    key: "avalanche",
    chainId: 43114,
    name: "Avalanche C-Chain",
    explorer: "https://snowtrace.io",
    // The one chain here that is not priced in ETH, which matters for every
    // balance and cost line the bot prints.
    nativeSymbol: "AVAX",
    blockSeconds: 1.06,
    rpc: {
      alchemyHost: "avax-mainnet.g.alchemy.com",
      // publicnode served 50,000 and the official endpoint 2,000; the lower
      // one wins, since either may be chosen.
      logChunkBlocks: 2_000,
      public: [
        "https://avalanche-c-chain-rpc.publicnode.com",
        "https://api.avax.network/ext/bc/C/rpc",
      ],
    },
  },
  {
    key: "ink",
    chainId: 57073,
    name: "Ink",
    explorer: "https://explorer.inkonchain.com",
    nativeSymbol: "ETH",
    blockSeconds: 1,
    rpc: {
      alchemyHost: "ink-mainnet.g.alchemy.com",
      logChunkBlocks: 2_000,
      // The two official endpoints were intermittent under probing -- one
      // answered, then timed out a minute later -- so drpc is listed as a
      // third rather than relying on either.
      public: [
        "https://rpc-qnd.inkonchain.com",
        "https://rpc-gel.inkonchain.com",
        "https://ink.drpc.org",
      ],
    },
  }
];

const DEFAULT_EXPLORER = "https://basescan.org";

// Resolve a chain by its numeric chainId (from the live network) or by its
// string key (the wizard's picker, or CHAIN). Returns undefined for unknown chains.
export function resolveChain(
  idOrKey: string | number | bigint | null | undefined
): ChainProfile | undefined {
  if (idOrKey === null || idOrKey === undefined) return undefined;
  if (typeof idOrKey === "string") {
    const key = idOrKey.trim().toLowerCase();
    return CHAINS.find((c) => c.key === key);
  }
  const id = Number(idOrKey);
  return CHAINS.find((c) => c.chainId === id);
}

// Build a block-explorer tx URL for whatever chain we're on. Accepts either the
// numeric chainId (preferred — it's authoritative) or the chain key. Falls back
// to Basescan for unknown chains so links are never broken silently.
export function explorerTx(
  idOrKey: string | number | bigint | null | undefined,
  txHash: string
): string {
  const profile = resolveChain(idOrKey);
  const base = profile?.explorer ?? DEFAULT_EXPLORER;
  return `${base}/tx/${txHash}`;
}

// Blocks per eth_getLogs for a chain: an explicit per-chain env override
// wins, then the global one, then the chain's measured default, then a
// universally-safe 10.
export function logChunkBlocksFor(chainKey: string, env: NodeJS.ProcessEnv = process.env): number {
  const perChain = Number(env[`AUTO_LOG_CHUNK_BLOCKS_${chainKey.toUpperCase()}`]);
  if (Number.isFinite(perChain) && perChain > 0) return perChain;

  const global = Number(env.AUTO_LOG_CHUNK_BLOCKS);
  if (Number.isFinite(global) && global > 0) return global;

  return resolveChain(chainKey)?.rpc.logChunkBlocks ?? 10;
}

/** Blocks spanning `seconds` of this chain's time, floored at 1. */
export function blocksForSeconds(chainKey: string, seconds: number): number {
  const per = resolveChain(chainKey)?.blockSeconds ?? 12;
  return Math.max(1, Math.round(seconds / per));
}

// How far behind the head a watcher may fall before it gives up on the gap.
// Expressed in TIME, not blocks: the old flat 200 blocks was 40 minutes of
// tolerance on Ethereum but only 20 SECONDS on Robinhood — far less than a
// single RPC timeout, so one slow response silently discarded every sighting
// in the gap.
export function catchupBlocksFor(chainKey: string, env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.COPY_CATCHUP_SECONDS);
  const seconds = Number.isFinite(override) && override > 0 ? override : 600;
  return blocksForSeconds(chainKey, seconds);
}

// On startup a watcher looks BACK over this span before following the head.
// Copy-mint drops observed in practice stay open for days, so a mint seen
// hours ago is usually still mintable — starting at the head throws those
// away for no benefit. 0 disables the backfill.
export function backfillBlocksFor(chainKey: string, env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.COPY_BACKFILL_HOURS);
  const hours = Number.isFinite(override) && override >= 0 ? override : 12;
  if (hours === 0) return 0;
  return blocksForSeconds(chainKey, hours * 3600);
}
