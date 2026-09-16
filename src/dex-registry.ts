// Where trading actually happens on each chain.
//
// EVERY ADDRESS HERE WAS MEASURED, not looked up, and on Arc that mattered
// immediately. Uniswap's canonical V3 factory address
// (0x1F98431c8aD98523631AE4a59f267346ea31F984) IS deployed on Arc -- it
// answers eth_getCode -- but it has emitted zero PoolCreated events. The
// factory that real launches use is a different address entirely. A watcher
// pointed at the canonical one would have sat silent forever while a token
// launched every eighteen seconds somewhere else, and nothing about that
// failure would have looked like a failure.
//
// So the rule for this file: an address earns its place by being observed
// emitting the events we intend to watch, on the chain we intend to watch it
// on. Not by being the address that is usually right.

export interface DexConfig {
  chainKey: string;
  /**
   * The wrapped native token every pair quotes against.
   *
   * On Arc the gas token is USDC, and its wrapped form sits at a vanity
   * address. Every pool observed in a 7-minute sample had this as one side,
   * which is what makes "the other token" an unambiguous way to name the
   * thing that just launched.
   */
  wrappedNative: string;
  /** Symbol to print for the quote side. */
  quoteSymbol: string;
  /** Decimals of the quote token, for sizing and price maths. */
  quoteDecimals: number;
  /** Uniswap-V3-style factories, by observed PoolCreated traffic. */
  v3Factories: string[];
  /** Uniswap-V2-style factories, by observed PairCreated traffic. */
  v2Factories: string[];
  /** Universal Router, used for execution. */
  universalRouter?: string;
  /** Fee tiers worth checking when pricing a token, most liquid first. */
  feeTiers: number[];
}

export const DEXES: readonly DexConfig[] = Object.freeze([
  {
    chainKey: "arc",
    // symbol() answers "USDC". Arc's gas token is USDC at 18 decimals, and
    // this is its wrapped ERC20 form -- the address every observed pool
    // quotes against.
    wrappedNative: "0x3600000000000000000000000000000000000000",
    quoteSymbol: "USDC",
    // 6, and this is NOT the same as the chain's native decimals.
    //
    // Arc splits them, which is the nastiest detail on this chain. The NATIVE
    // gas token is USDC at 18 decimals -- chains.ts is right about that, and
    // every wei computation and formatEther call depends on it. The WRAPPED
    // ERC20 at this address reports decimals() == 6, the ordinary USDC
    // convention.
    //
    // Measured on a live pool, which is the only reason this is right: the
    // pool's native balance read 415,667.714023 at 18 decimals while
    // balanceOf on the wrapped token returned 415667714023 -- the same
    // number, six places over. Taking the native figure for both prints a
    // pool holding 0.0000004 USDC when it holds 415,667, and the error runs
    // in the direction that makes a real pool look empty and a dust pool look
    // enormous.
    quoteDecimals: 6,
    // Measured: 138 PoolCreated in 5,000 blocks (~42 minutes), every one
    // pairing a new token against wrapped USDC. That is roughly one launch
    // every eighteen seconds.
    v3Factories: ["0xf0db7b58379503491d857dB50AC9ece64c653918"],
    // Present and used, but quiet: 343 swaps across 19 pairs in the same
    // window and zero PairCreated. Watched anyway -- it costs one filtered
    // call per poll and a launch venue going quiet is not the same as it
    // being gone.
    v2Factories: ["0x942Bd5BFdc5317C5507e326f8EB4BB6058AB5C10"],
    // 34 execute() calls in 40 blocks. Observed routing through V4
    // (command 0x10) as well as V3, so it is the one contract that can reach
    // both venues.
    universalRouter: "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1",
    feeTiers: [10_000, 3_000, 500, 100],
  },
]);

export const dexFor = (chainKey: string): DexConfig | undefined =>
  DEXES.find((d) => d.chainKey === chainKey.toLowerCase());

/** Whether this chain has any trading venue configured at all. */
export const hasDex = (chainKey: string): boolean => dexFor(chainKey) !== undefined;
