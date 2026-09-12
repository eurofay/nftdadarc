// Deciding whether a crowd of smart wallets is worth following into a mint.
//
// This is the first thing in the alerts bot that can spend, and the bot was
// built read-only on purpose, so the line is drawn precisely rather than
// loosened generally:
//
//   FREE     may fire on its own. The whole cost is gas -- measured at
//            ~0.000011 ETH on this chain -- and the thing being raced is a
//            few seconds of other people noticing the same cluster.
//   PAID     never fires on its own. Not once, not under a cap, not "if it
//            is only a little". It asks, every time, with the total spend
//            spelled out, and a tap that expires.
//
// The asymmetry is deliberate. Getting a free mint wrong costs a fraction of
// a cent and a slot in a wallet. Getting a paid one wrong costs whatever the
// stage charges, times the wallets, times however many times the rule fires
// while nobody is looking.
//
// Everything below is a pure decision. Nothing here signs, sends, or reads a
// key -- it returns what SHOULD happen and the caller does it.

export type ClusterDecision =
  | { action: "fire"; quantity: number; wallets: string[]; why: string }
  | { action: "ask"; quantity: number; wallets: string[]; totalCostEth: number; why: string }
  | { action: "skip"; why: string };

export interface ClusterMintSettings {
  /** Off until deliberately turned on. */
  enabled: boolean;
  /** Wallets that must converge before this triggers at all. */
  minWallets: number;
  /** Per-item price above which it will not even ask. 0 means never ask. */
  maxPriceEth: number;
  /** How many of your wallets to use. */
  maxWallets: number;
  quantityPerWallet: number;
  /** A ceiling on how often this can fire in a day, whatever the price. */
  maxPerDay: number;
}

export const DEFAULT_CLUSTER_MINT: ClusterMintSettings = {
  // On. Watching a crowd form and then doing nothing about it is the one
  // outcome nobody wants from this, and the FREE case costs a fraction of a
  // cent. The paid case is still gated behind a tap, which is what makes
  // being on by default reasonable rather than reckless.
  enabled: true,
  // Three, not two. Two wallets is the threshold for being TOLD about a
  // cluster, and telling you is free; spending deserves a higher bar.
  minWallets: 3,
  /**
   * The most a single item may cost and still be worth ASKING about.
   *
   * Not an on/off switch -- a paid mint always asks, never fires. This is the
   * point above which asking stops being useful: waking you at 3am to confirm
   * something absurd is its own kind of failure, and a cluster on a 2 ETH
   * mint is a decision to make awake, at a screen, not from a notification.
   *
   * 0.1 is generous against what this chain actually charges -- observed
   * mints run from free to about 0.15 -- so in practice nearly everything
   * asks. Above it, the bot still SAYS so and hands you the address; it just
   * does not put a spend button next to it.
   */
  maxPriceEth: 0.1,
  maxWallets: 3,
  quantityPerWallet: 1,
  maxPerDay: 10,
};

export interface DecideOpts {
  settings: ClusterMintSettings;
  /** Distinct smart wallets seen on this collection. */
  clusterWallets: number;
  /** What the cluster was doing. Only minting is worth following. */
  kind: string;
  /** Per-item price of the stage, in ETH. Null when it could not be read. */
  priceEth: number | null;
  /** Your wallets that could actually mint it right now. */
  eligible: string[];
  /** Max the stage allows per wallet. */
  maxPerWallet: number;
  /** How many times this has already fired today. */
  firedToday: number;
  /** True when you already hold some of this collection. */
  alreadyHold?: boolean;
}

export function decideClusterMint(opts: DecideOpts): ClusterDecision {
  const s = opts.settings;
  if (!s.enabled) return { action: "skip", why: "auto-mint on clusters is off" };

  // Buying and selling are not mints. Following a crowd OUT of a position by
  // minting into it is exactly backwards.
  if (opts.kind !== "mint") return { action: "skip", why: `cluster was ${opts.kind}, not minting` };

  if (opts.clusterWallets < s.minWallets) {
    return { action: "skip", why: `${opts.clusterWallets} wallets, threshold is ${s.minWallets}` };
  }
  if (opts.alreadyHold) return { action: "skip", why: "you already hold this collection" };
  if (opts.eligible.length === 0) return { action: "skip", why: "no wallet of yours can mint it" };
  if (opts.firedToday >= s.maxPerDay) {
    return { action: "skip", why: `already fired ${opts.firedToday} time(s) today` };
  }

  // An unreadable price is not a free one. Treating it as free is how a rule
  // meant for free mints spends money.
  if (opts.priceEth === null) {
    return { action: "skip", why: "could not read the stage price, so it is not safe to assume free" };
  }

  const wallets = opts.eligible.slice(0, Math.max(1, s.maxWallets));
  const quantity = Math.max(1, Math.min(s.quantityPerWallet, opts.maxPerWallet || s.quantityPerWallet));

  if (opts.priceEth === 0) {
    return {
      action: "fire",
      quantity,
      wallets,
      why: `${opts.clusterWallets} smart wallets minting it, and it is free`,
    };
  }

  // Paid from here down. It can only ever ask.
  if (s.maxPriceEth <= 0) {
    // Someone has deliberately set the ceiling to zero, which means free only.
    return { action: "skip", why: `it costs ${opts.priceEth} each and you have set free mints only` };
  }
  if (opts.priceEth > s.maxPriceEth) {
    return {
      action: "skip",
      // Named as "too big to ask about" rather than "blocked", because the
      // address comes with it and minting it by hand is one tap away.
      why: `${opts.priceEth} each is above the ${s.maxPriceEth} you want to be asked about — mint it by hand if you want it`,
    };
  }

  return {
    action: "ask",
    quantity,
    wallets,
    totalCostEth: opts.priceEth * quantity * wallets.length,
    why: `${opts.clusterWallets} smart wallets minting it`,
  };
}

/** What to say when asking. The total is the number that decides it. */
export function describeAsk(
  d: Extract<ClusterDecision, { action: "ask" }>,
  name: string,
  symbol: string,
  priceEth: number
): string {
  return (
    `⚠️ *Paid mint — ${name}*\n\n` +
    `${d.why}.\n\n` +
    `${priceEth} ${symbol} each × ${d.quantity} × ${d.wallets.length} wallet(s)\n` +
    `*Total ${d.totalCostEth.toFixed(4)} ${symbol}* plus gas.\n\n` +
    "_This will not fire on its own. Nothing happens unless you tap._"
  );
}

/**
 * How long a confirmation stays good for.
 *
 * Two minutes. A mint worth following is worth following now, and a button
 * that still works twenty minutes later is one you tap having forgotten what
 * it was for -- by which time the cluster is old news and the price may not
 * be what the message said.
 */
export const ASK_TTL_MS = 2 * 60 * 1000;
