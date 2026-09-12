// What a watched wallet just did, and whether it is worth waking you for.
//
// WHAT IS OBSERVABLE, AND WHAT IS NOT. Worth stating up front because the
// obvious wish list does not survive contact with the chain:
//
//   mint             SeaDropMint, minter indexed. Free to watch.
//   buy              OrderFulfilled, they are on the paying side.
//   sell (listed)    OrderFulfilled, they offered the NFT.
//   sell (bid taken) OrderFulfilled, someone took their standing offer.
//   transfer in/out  ERC-721 Transfer. Catches airdrops and wallet shuffling.
//
//   listing created  NOT OBSERVABLE. A Seaport listing is a signed message
//                    held by the marketplace; nothing touches the chain until
//                    someone fills it.
//   offer made       NOT OBSERVABLE, same reason.
//
// OpenSea's REST v2 would have both, and on this chain it answers 401 to the
// key and 405 to the order endpoints, so there is no second source either.
// Rather than half-build something that silently misses most listings, this
// covers what settles and says plainly that it does.
//
// THE SIGNAL WORTH MORE THAN ANY SINGLE EVENT is several watched wallets
// landing on the same collection at once. One good minter is an opinion; four
// inside ten minutes is the thing you actually wanted to be told.

export type ActivityKind = "mint" | "buy" | "sell" | "sell-offer" | "in" | "out";

export interface Activity {
  kind: ActivityKind;
  wallet: string;
  contract: string;
  tokenId?: string;
  /** Wei, when money moved. A mint at zero is still a zero, not unknown. */
  valueWei?: bigint;
  quantity?: number;
  blockNumber: number;
  txHash: string;
}

/** Whether this one is worth a notification on its own. */
export function isNoteworthy(a: Activity): boolean {
  // A transfer in is usually the other leg of something already reported, or
  // an airdrop nobody asked for. Out is worth knowing — it may be a wallet
  // moving inventory before selling it somewhere this cannot see.
  return a.kind !== "in";
}

export const KIND_LABEL: Record<ActivityKind, string> = {
  mint: "🌱 minted",
  buy: "🛒 bought",
  sell: "💸 sold",
  "sell-offer": "🤝 accepted an offer",
  in: "📥 received",
  out: "📤 sent out",
};

/**
 * How long two wallets can be apart and still count as acting together.
 *
 * Ten minutes. Long enough that a drop being worked through by several
 * wallets reads as one event, short enough that two unrelated mints hours
 * apart never do.
 */
export const CLUSTER_WINDOW_MS = 10 * 60 * 1000;

/** The number of distinct wallets that turns a data point into a signal. */
export const CLUSTER_MIN_WALLETS = 2;

export interface Cluster {
  contract: string;
  kind: ActivityKind;
  wallets: string[];
  firstAt: number;
  lastAt: number;
  totalValueWei: bigint;
}

interface Seen {
  wallet: string;
  at: number;
  valueWei: bigint;
}

/**
 * Notices when several watched wallets converge on one collection.
 *
 * Keyed by collection AND kind, because four wallets minting something is a
 * completely different message from four wallets dumping it, and merging the
 * two would produce a cluster that means nothing.
 */
export class ClusterTracker {
  private readonly seen = new Map<string, Seen[]>();
  private readonly announced = new Set<string>();

  private key(contract: string, kind: ActivityKind): string {
    // Both ways of selling are one behaviour as far as a cluster goes.
    const family = kind === "sell-offer" ? "sell" : kind;
    return `${family}:${contract.toLowerCase()}`;
  }

  /**
   * Record an activity and return a cluster if this one completed it.
   *
   * Returns null for the second and later alerts about the SAME cluster: the
   * point is to tell you once that something is happening, not once per
   * wallet joining in. A cluster that grows past the threshold again with new
   * wallets re-announces, because five is news when you were told about two.
   */
  note(a: Activity, now = Date.now()): Cluster | null {
    const k = this.key(a.contract, a.kind);
    const list = (this.seen.get(k) ?? []).filter((s) => now - s.at <= CLUSTER_WINDOW_MS);
    // One wallet minting five times is one wallet, not a crowd.
    const already = list.find((s) => s.wallet.toLowerCase() === a.wallet.toLowerCase());
    if (already) {
      already.at = now;
      already.valueWei += a.valueWei ?? 0n;
    } else {
      list.push({ wallet: a.wallet, at: now, valueWei: a.valueWei ?? 0n });
    }
    this.seen.set(k, list);

    const wallets = list.map((s) => s.wallet);
    if (wallets.length < CLUSTER_MIN_WALLETS) return null;

    // Announce at each new size, so 2 then 4 both get through and 2 twice
    // does not.
    const stamp = `${k}:${wallets.length}`;
    if (this.announced.has(stamp)) return null;
    this.announced.add(stamp);

    return {
      contract: a.contract,
      kind: a.kind,
      wallets,
      firstAt: Math.min(...list.map((s) => s.at)),
      lastAt: Math.max(...list.map((s) => s.at)),
      totalValueWei: list.reduce((sum, s) => sum + s.valueWei, 0n),
    };
  }

  /** Drop what has aged out, so a long run does not grow without bound. */
  prune(now = Date.now()): void {
    for (const [k, list] of this.seen) {
      const live = list.filter((s) => now - s.at <= CLUSTER_WINDOW_MS);
      if (live.length === 0) {
        this.seen.delete(k);
        // The announcement guard goes with it, so the same collection can
        // cluster again tomorrow.
        for (const stamp of [...this.announced]) if (stamp.startsWith(`${k}:`)) this.announced.delete(stamp);
      } else {
        this.seen.set(k, live);
      }
    }
  }

  get size(): number {
    return this.seen.size;
  }
}

const WEI = 1e18;

export function describeActivity(a: Activity, label: string, name: string, symbol: string): string {
  const parts = [`${KIND_LABEL[a.kind]}`];
  if (a.quantity && a.quantity > 1) parts.push(`×${a.quantity}`);
  const value =
    a.valueWei === undefined
      ? ""
      : a.valueWei === 0n
        ? " · free"
        : ` · ${(Number(a.valueWei) / WEI).toFixed(4)} ${symbol}`;
  return `${label} ${parts.join(" ")} *${name}*${value}`;
}

export function describeCluster(c: Cluster, name: string, symbol: string, mask: (a: string) => string): string {
  const verb = c.kind === "mint" ? "minting" : c.kind === "buy" ? "buying" : "selling";
  const spend =
    c.totalValueWei > 0n ? ` for ${(Number(c.totalValueWei) / WEI).toFixed(4)} ${symbol} between them` : "";
  return (
    `🔥 *${c.wallets.length} smart wallets ${verb} ${name}*${spend}\n\n` +
    c.wallets.map((w) => `  ${mask(w)}`).join("\n")
  );
}
