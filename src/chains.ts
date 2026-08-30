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
    blockSeconds: 12.12,
    rpc: {
      alchemyHost: "eth-mainnet.g.alchemy.com",
      logChunkBlocks: 10,
      public: [
        "https://ethereum-rpc.publicnode.com",
        "https://eth.merkle.io",
        "https://cloudflare-eth.com",
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
      logChunkBlocks: 10,
      public: [
        "https://mainnet.base.org",
        "https://base-rpc.publicnode.com",
        // Send-only (rejects eth_chainId/eth_call) but the fastest inclusion
        // path — planRpcs keeps it for blasting and never reads from it.
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
    rpc: {
      alchemyHost: "robinhood-mainnet.g.alchemy.com",
      // Measured: the public endpoint below returns a 10,000-block range in
      // ~300ms. 2000 keeps a wide margin while still covering ~200s of this
      // chain's ~10 blocks/second in a single call.
      logChunkBlocks: 2000,
      public: [
        "https://rpc.mainnet.chain.robinhood.com",
        "https://sequencer.mainnet.chain.robinhood.com",
      ],
    },
  },
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
