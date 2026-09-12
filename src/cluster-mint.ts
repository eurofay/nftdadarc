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
  enabled: false,
  // Three, not two. Two wallets is the threshold for being TOLD about a
  // cluster, and telling you is free; spending your money on it deserves a
  // higher bar than raising an eyebrow does.
  minWallets: 3,
  // Zero means "free mints only, never ask about a paid one". The safest
  // setting is also the default, and turning the feature on does not by
  // itself authorise any spending at all.
  maxPriceEth: 0,
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
    return { action: "skip", why: `it costs ${opts.priceEth} each and paid auto-mint is not enabled` };
  }
  if (opts.priceEth > s.maxPriceEth) {
    return {
      action: "skip",
      why: `${opts.priceEth} each is over your ${s.maxPriceEth} ceiling`,
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
