import { describe, it, expect } from "vitest";
import { CHAINS, resolveChain, logChunkBlocksFor, blocksForSeconds } from "./chains";

// Every value in the registry was measured against the live endpoint, and a
// wrong one fails quietly rather than loudly: a too-small log window makes a
// watcher that never catches up, a missing chain makes a mint that resolves
// to nothing. So the facts get pinned here.

describe("the registry is internally consistent", () => {
  it("has no duplicate keys or chain ids", () => {
    // Two entries with one key means resolveChain picks by declaration order,
    // and the loser is unreachable without any error being raised.
    expect(new Set(CHAINS.map((c) => c.key)).size).toBe(CHAINS.length);
    expect(new Set(CHAINS.map((c) => c.chainId)).size).toBe(CHAINS.length);
  });

  it("gives every chain at least one endpoint and a positive block time", () => {
    for (const c of CHAINS) {
      expect(c.rpc.public.length, `${c.key} has no endpoints`).toBeGreaterThan(0);
      expect(c.blockSeconds, `${c.key} block time`).toBeGreaterThan(0);
      expect(c.rpc.logChunkBlocks ?? 0, `${c.key} log window`).toBeGreaterThan(0);
      expect(c.explorer.endsWith("/"), `${c.key} explorer has a trailing slash`).toBe(false);
    }
  });

  it("uses https everywhere", () => {
    for (const c of CHAINS) {
      for (const url of c.rpc.public) expect(url.startsWith("https://"), url).toBe(true);
    }
  });
});

describe("the chains that were asked for are present", () => {
  it.each([
    ["ethereum", 1, "ETH"],
    ["base", 8453, "ETH"],
    ["arbitrum", 42161, "ETH"],
    ["avalanche", 43114, "AVAX"],
    ["ink", 57073, "ETH"],
    ["robinhood", 4663, "ETH"],
  ])("%s is chain %i paying in %s", (key, id, symbol) => {
    const c = resolveChain(key);
    expect(c?.chainId).toBe(id);
    expect(c?.nativeSymbol).toBe(symbol);
    // The key doubles as OpenSea's REST v2 chain slug, so a typo here breaks
    // collection lookups rather than anything obviously chain-shaped.
    expect(c?.key).toBe(key);
  });

  it("prices Avalanche in AVAX, not ETH", () => {
    // Getting this wrong mislabels every balance, mint price and gas figure
    // the bot prints.
    expect(resolveChain("avalanche")?.nativeSymbol).toBe("AVAX");
    expect(CHAINS.filter((c) => c.nativeSymbol !== "ETH").map((c) => c.key).sort()).toEqual([
      "arc",
      "avalanche",
    ]);
  });

  it("is chain 5042 on Arc, which is what the chain itself answers", () => {
    // Pinned because the published sources disagreed on launch day:
    // ChainList said 1243 and Circle's own docs printed the hex as 0x13AA
    // (5034). eth_chainId on rpc.mainnet.arc.io and arc.drpc.org both answer
    // 0x13b2. A wrong chainId does not fail loudly -- it signs for a
    // different network, so every transaction is simply rejected.
    expect(resolveChain("arc")?.chainId).toBe(5042);
    expect(resolveChain(5042)?.key).toBe("arc");
  });

  it("prices Arc in USDC, which is its actual gas token", () => {
    // Arc's gas is USDC rather than ether, at 18 decimals -- which is the
    // only reason the rest of the repo works here unchanged, since every wei
    // computation and formatEther call is 18-decimal. USDC as an ERC20
    // everywhere else is 6 decimals, and that would have mis-scaled every
    // balance and fee by a factor of a trillion.
    expect(resolveChain("arc")?.nativeSymbol).toBe("USDC");
  });
});

describe("log windows are big enough to keep up", () => {
  it("covers at least ten minutes of chain in one call", () => {
    // The Ethereum failure in one line. logChunkBlocks was 10, which at 12s
    // blocks is two minutes of chain per round trip -- so a watcher doing a
    // 12-hour backfill needed 359 sequential calls and never finished. Any
    // window that cannot cover ten minutes in a single call is that bug.
    for (const c of CHAINS) {
      const tenMinutes = blocksForSeconds(c.key, 600);
      expect(
        c.rpc.logChunkBlocks!,
        `${c.key}: ${c.rpc.logChunkBlocks} blocks is under ten minutes (${tenMinutes})`
      ).toBeGreaterThanOrEqual(tenMinutes);
    }
  });

  it("keeps a backfill to a sane number of round trips", () => {
    for (const c of CHAINS) {
      const halfDay = blocksForSeconds(c.key, 12 * 3600);
      const calls = Math.ceil(halfDay / logChunkBlocksFor(c.key, {}));
      expect(calls, `${c.key} needs ${calls} calls to backfill 12h`).toBeLessThanOrEqual(50);
    }
  });
});

describe("where a tip buys nothing", () => {
  it("is set only on the single-sequencer chains, measured", () => {
    // eth_maxPriorityFeePerGas answers ~0 on all three: one sequencer, no
    // mempool, ordering by arrival. Everywhere else there is a real auction
    // and zeroing the tip would lose position.
    //
    // Arc measured at 0x1 -- one wei -- against a 20 gwei base fee, so a tip
    // sized for Ethereum would be a large surcharge buying no position at all.
    expect(CHAINS.filter((c) => c.noPriorityFee).map((c) => c.key).sort()).toEqual([
      "arbitrum",
      "arc",
      "robinhood",
    ]);
  });

  it("leaves Ethereum's tip alone, because it is a real auction", () => {
    expect(resolveChain("ethereum")?.noPriorityFee).toBeFalsy();
    expect(resolveChain("base")?.noPriorityFee).toBeFalsy();
  });
});

describe("send-only endpoints survive an audit", () => {
  it.each([
    ["base", "https://mainnet-sequencer.base.org"],
    ["robinhood", "https://sequencer.mainnet.chain.robinhood.com"],
  ])("%s keeps %s", (key, url) => {
    // These reject eth_chainId and eth_call, so any probe that identifies an
    // endpoint by asking it questions concludes they are broken and drops
    // them. They are the FASTEST inclusion path on their chains -- the whole
    // point of blasting -- and one was in fact deleted this way once.
    expect(resolveChain(key)?.rpc.public).toContain(url);
  });
});

describe("endpoints known to be broken stay out", () => {
  it.each([
    ["https://cloudflare-eth.com", "reports no code at the SeaDrop singleton"],
    ["https://eth.merkle.io", "answers HTML rather than JSON-RPC"],
  ])("%s is not listed — %s", (url) => {
    for (const c of CHAINS) expect(c.rpc.public).not.toContain(url);
  });
});
