// Finding wallets worth copying, from the chain rather than from rumour.
//
// Copy Mint follows wallets you add by hand, which means it can only be as
// good as who you already happen to know. But every mint on this chain is a
// SeaDropMint log, and Robinhood produces roughly 5,853 of them in eighteen
// minutes -- a sample large enough to tell a habitual early minter from
// someone who got lucky once.
//
// WHAT THIS DOES NOT CLAIM. It is not realised profit. Knowing that would
// need the resale price of every token, which lives on a marketplace and not
// on the chain, and inventing it from mint price alone would be a number that
// looks authoritative and means nothing. What this measures is three things
// that ARE fully on-chain, and that a good minter has and a bad one does not:
//
//   earliness  how close to the front of a drop they land, as a share of
//              that drop's observed mints. Being first is the whole game on a
//              sequencer that orders by arrival.
//   breadth    how many distinct collections. One collection is one result;
//              twelve is a method.
//   conviction how many wallets they run in parallel is invisible, but how
//              consistently they take the full per-wallet allowance is not.
//
// A wallet that is early, across many drops, repeatedly, is worth following
// whatever it later did with the tokens.

export interface MintRecord {
  nftContract: string;
  minter: string;
  blockNumber: number;
  /** Position within the block, so two mints in one block still order. */
  logIndex: number;
  txHash: string;
  /** How many this transaction took. */
  quantity: number;
  /**
   * What each one cost, from the event itself.
   *
   * This is the real figure, not the stage's advertised price: it is what the
   * contract recorded being charged. It makes a wallet's actual spend
   * knowable without asking any marketplace.
   */
  unitPriceWei: bigint;
}

export interface MinterStats {
  address: string;
  mints: number;
  collections: number;
  /** 0..1, averaged over drops: 1.0 means always first in, 0 means always last. */
  earliness: number;
  /** Drops where they were in the first tenth of observed minters. */
  frontRuns: number;
  /** The most recent block they minted in, for "active 4 minutes ago". */
  lastBlock: number;
}

export interface RankedMinter extends MinterStats {
  score: number;
}

/**
 * Rank every minter seen in a window.
 *
 * Earliness is measured per drop and then averaged, so a wallet that was
 * first into three quiet drops is not beaten by one that was 400th into a
 * busy one. Ranking on raw mint count would find the biggest spender, which
 * is not the same question.
 */
export function rankMinters(records: MintRecord[]): RankedMinter[] {
  // Order within each collection, so "how early" has a meaning.
  const byCollection = new Map<string, MintRecord[]>();
  for (const r of records) {
    const k = r.nftContract.toLowerCase();
    const list = byCollection.get(k);
    if (list) list.push(r);
    else byCollection.set(k, [r]);
  }

  interface Acc {
    mints: number;
    collections: Set<string>;
    earlinessSum: number;
    earlinessCount: number;
    frontRuns: number;
    lastBlock: number;
  }
  const acc = new Map<string, Acc>();
  const get = (address: string): Acc => {
    const k = address.toLowerCase();
    let a = acc.get(k);
    if (!a) {
      a = { mints: 0, collections: new Set(), earlinessSum: 0, earlinessCount: 0, frontRuns: 0, lastBlock: 0 };
      acc.set(k, a);
    }
    return a;
  };

  for (const [collection, list] of byCollection) {
    list.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

    // A drop with one observed mint carries no information about who was
    // early -- everyone is both first and last -- so it counts for breadth
    // and activity but not for the earliness average.
    const rankable = list.length > 1;
    const seenHere = new Set<string>();

    list.forEach((r, i) => {
      const a = get(r.minter);
      a.mints++;
      a.collections.add(collection);
      a.lastBlock = Math.max(a.lastBlock, r.blockNumber);

      // Only a wallet's FIRST mint in a collection says how early it was;
      // the rest are the same arrival counted again.
      const k = r.minter.toLowerCase();
      if (seenHere.has(k) || !rankable) return;
      seenHere.add(k);

      const share = 1 - i / (list.length - 1);
      a.earlinessSum += share;
      a.earlinessCount++;
      if (i < Math.max(1, Math.ceil(list.length / 10))) a.frontRuns++;
    });
  }

  const out: RankedMinter[] = [];
  for (const [address, a] of acc) {
    const stats: MinterStats = {
      address,
      mints: a.mints,
      collections: a.collections.size,
      earliness: a.earlinessCount > 0 ? a.earlinessSum / a.earlinessCount : 0,
      frontRuns: a.frontRuns,
      lastBlock: a.lastBlock,
    };
    out.push({ ...stats, score: score(stats) });
  }
  return out.sort((a, b) => b.score - a.score || b.mints - a.mints);
}

/**
 * One number to sort by.
 *
 * Breadth is the square root rather than the count: the difference between
 * one collection and four is enormous, between forty and fifty almost
 * nothing, and a linear term would put a bot that sweeps every drop
 * indiscriminately above a wallet that picks well and wins.
 *
 * Earliness is squared, because the distribution of what it is worth is not
 * flat -- landing at the very front of a drop is worth far more than twice
 * being halfway down it.
 */
export function score(s: MinterStats): number {
  if (s.collections < MIN_COLLECTIONS) return 0;
  return Math.sqrt(s.collections) * (0.25 + s.earliness * s.earliness) * (1 + s.frontRuns * 0.15);
}

/**
 * Below this, there is no track record to speak of.
 *
 * A wallet in a single drop is indistinguishable from someone who clicked a
 * link once, and recommending it as a copy target would be recommending
 * noise with a number attached.
 */
export const MIN_COLLECTIONS = 2;

export interface ScoutOpts {
  /** How many to return. A copy list of fifty is not a list, it is the chain. */
  limit?: number;
  /** Wallets to leave out — your own, and anyone already watched. */
  exclude?: string[];
}

export function scout(records: MintRecord[], opts: ScoutOpts = {}): RankedMinter[] {
  const skip = new Set((opts.exclude ?? []).map((a) => a.toLowerCase()));
  return rankMinters(records)
    .filter((m) => m.score > 0 && !skip.has(m.address.toLowerCase()))
    .slice(0, opts.limit ?? 10);
}

/** A one-line reason, so a recommendation is never just a number. */
export function why(m: RankedMinter): string {
  const pct = Math.round(m.earliness * 100);
  const parts = [`${m.mints} mints across ${m.collections} collections`];
  if (m.frontRuns > 0) parts.push(`first tenth into ${m.frontRuns}`);
  parts.push(`${pct}% earliness`);
  return parts.join(" · ");
}
