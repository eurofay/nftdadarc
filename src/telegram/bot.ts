// Telegram control surface for the mint sniper. Wraps the same tested engine
// the CLI uses (buildLocalMintPlan / localPublicSnipe / runAutoMintWatcher /
// runCopyMintWatcher) — this file is UI and wiring, not mint logic.
//
// Access is restricted to one Telegram user id (TELEGRAM_OWNER_ID) in private
// chat only; every other update is silently ignored.

import { Telegraf, Markup, Context } from "telegraf";
import { message } from "telegraf/filters";
import { isAddress, formatEther, parseEther } from "ethers";
import { createProvider } from "../rpc-provider";
import { TelegramStore, WalletRecord } from "./store";
import {
  mainMenu,
  walletsMenu,
  walletDetailMenu,
  copyMenu,
  autoMenu,
  settingsMenu,
  chainPickerMenu,
  autoChainsMenu,
  fundSourceMenu,
  fundTargetsMenu,
  fundConfirmMenu,
  schedWalletsMenu,
  schedTimingMenu,
  schedConfirmMenu,
  portfolioMenu,
  portfolioItemMenu,
  activityMenu,
  maskAddress,
} from "./menus";
import { resolveChain } from "../chains";
import { resolveRpcsForChain } from "../rpc-resolver";
import { parseNftLink } from "../nft-link";
import { resolveSlug, openseaContractInfo } from "../slug-resolver";
import {
  fetchCollection,
  fetchStats,
  fetchActivity,
  openseaCollectionUrl,
} from "../opensea-market";
import { buildLocalMintPlan } from "../seadrop-public";
import { localPublicSnipe } from "../local-mint";
import { runAutoMintWatcher } from "../auto-mint";
import { runCopyMintWatcher } from "../copy-mint";
import { runActivityWatcher } from "../activity-watcher";
import { batchTransfer, estimateBatchCost } from "../fund-transfer";
import { createLogger, withPrefix, LogSink } from "../logger";
import { istTimeToDate, toIST } from "../time-format";

interface SessionData {
  step?:
    | "awaiting_wallet_key"
    | "awaiting_copy_target"
    | "awaiting_fund_amount"
    | "awaiting_sched_link"
    | "awaiting_sched_quantity"
    | "awaiting_sched_custom_time"
    | `awaiting_setting:${string}`;
  fundSource?: string;
  fundTargets?: string[]; // lowercased addresses
  fundAmountWei?: string; // bigint as string — kept out of the type so session stays plain-JSON-shaped
  schedContract?: string;
  schedWallets?: string[]; // lowercased addresses
  schedQuantity?: number;
  schedDropMax?: number;
  schedStartTime?: number; // on-chain drop start, unix seconds
  schedTargetStartMs?: number | "now"; // chosen fire time, pending confirmation
}
interface BotContext extends Context {
  session: SessionData;
}

interface RunningWatcher {
  stopSignal: { stopped: boolean };
  promise: Promise<void>;
}

function gweiToWei(gwei: number): bigint {
  return BigInt(Math.round(gwei * 1e9));
}

// Shared by /mint and Scheduled Mint: turn whatever the user pasted (a raw
// 0x address, an OpenSea link, or a bare slug) into a contract address.
async function resolveMintTarget(link: string, chainKey: string): Promise<string> {
  const parsed = parseNftLink(link);
  if (parsed.kind === "address") return parsed.value;
  const info = await resolveSlug(parsed.value, process.env.OPENSEA_API_KEY, chainKey);
  return info.contractAddress;
}

// Matches a comma-separated list of wallet labels/addresses against the
// stored wallets — exact address match, or case-insensitive label match.
// Used by /mint's optional wallet filter for a fast, no-menu-tapping fire.
export function matchWallets(wallets: WalletRecord[], filter: string): WalletRecord[] {
  const tokens = filter.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const matched: WalletRecord[] = [];
  for (const token of tokens) {
    const hit = wallets.find(
      (w) => w.address.toLowerCase() === token || w.label.toLowerCase() === token
    );
    if (!hit) throw new Error(`No wallet matches "${token}" — check Wallets for exact labels.`);
    if (!matched.includes(hit)) matched.push(hit);
  }
  return matched;
}

// A node reserves gasLimit × maxFee + the mint's own value upfront and
// rejects the tx outright if a wallet falls short — regardless of the far
// smaller amount actually spent. Same formula the CLI wizard already uses.
export function checkAffordability(
  balanceWei: bigint | null,
  gasLimit: number,
  maxFeePerGas: bigint,
  mintValueWei: bigint
): { requiredWei: bigint; affordable: boolean | null } {
  const requiredWei = BigInt(gasLimit) * maxFeePerGas + mintValueWei;
  return { requiredWei, affordable: balanceWei === null ? null : balanceWei >= requiredWei };
}

// Shared by /mint's --dry flag and Scheduled Mint's Dry Run button: resolves
// balances and affordability for the selected wallets without ever signing
// or broadcasting anything.
async function previewMint(
  rpcUrl: string,
  symbol: string,
  wallets: WalletRecord[],
  gasLimit: number,
  maxFeePerGas: bigint,
  mintValueWei: bigint
): Promise<string> {
  const provider = createProvider(rpcUrl);
  const lines = await Promise.all(
    wallets.map(async (w) => {
      const balance = await provider.getBalance(w.address).catch(() => null);
      const { requiredWei, affordable } = checkAffordability(balance, gasLimit, maxFeePerGas, mintValueWei);
      const balStr = balance === null ? "balance unavailable" : `${formatEther(balance)} ${symbol}`;
      const mark = affordable === null ? "?" : affordable ? "✓" : `✗ needs ${formatEther(requiredWei)} ${symbol}`;
      return `  ${w.label}: ${balStr} ${mark}`;
    })
  );
  return lines.join("\n");
}

// Records a confirmed mint into the portfolio, enriching it with OpenSea's
// slug/name when that lookup succeeds. Deliberately swallows every failure:
// portfolio bookkeeping is decoration, and must never turn into an error on
// a mint that actually succeeded.
async function recordOutcome(
  store: TelegramStore,
  chainKey: string,
  outcome: { nftContract: string; quantity: number; minted: { address: string; txHash: string }[] }
): Promise<void> {
  if (outcome.minted.length === 0) return;
  try {
    const info = await openseaContractInfo(chainKey, outcome.nftContract, process.env.OPENSEA_API_KEY);
    store.recordMint({
      chainKey,
      nftContract: outcome.nftContract,
      // One record per wallet that actually received tokens.
      quantity: outcome.quantity * outcome.minted.length,
      wallets: outcome.minted.map((m) => m.address),
      txHash: outcome.minted[0].txHash,
      slug: info?.slug,
      name: info?.name,
    });
  } catch {
    // ignore — never let bookkeeping surface as a mint failure
  }
}

// Serializes sends to one chat with a small gap between them, so a burst of
// headline events (a mint firing, then its result) can't trip Telegram's
// flood limits the way blasting every line unthrottled would.
function createTelegramSink(bot: Telegraf<BotContext>, chatId: number): LogSink {
  let queue: Promise<void> = Promise.resolve();
  return (text: string) => {
    queue = queue.then(async () => {
      try {
        await bot.telegram.sendMessage(chatId, text.trim() || "(empty)");
      } catch {
        // best-effort — a dropped status line shouldn't crash the mint attempt
      }
      await new Promise((r) => setTimeout(r, 350));
    });
  };
}

export interface BotDeps {
  token: string;
  ownerId: number;
  store: TelegramStore;
}

export function createBot({ token, ownerId, store }: BotDeps): Telegraf<BotContext> {
  const bot = new Telegraf<BotContext>(token);

  const sessions = new Map<number, SessionData>();
  bot.use((ctx, next) => {
    const chatId = ctx.chat?.id;
    ctx.session = (chatId && sessions.get(chatId)) || {};
    if (chatId) sessions.set(chatId, ctx.session);
    return next();
  });

  // ── Access control: this owner, this private chat, nobody else ─────────
  bot.use((ctx, next) => {
    if (ctx.chat?.type !== "private" || ctx.from?.id !== ownerId) return;
    return next();
  });

  const runningAuto = new Map<string, RunningWatcher>(); // keyed by chain key — one watcher per chain
  let runningCopy: RunningWatcher | null = null;
  let runningActivity: RunningWatcher | null = null;

  // ── Menu navigation ──────────────────────────────────────────────────
  bot.start((ctx) => ctx.reply("NFT Public Mint Sniper — choose an action:", mainMenu()));
  bot.action("menu:main", (ctx) => ctx.editMessageText("Choose an action:", mainMenu()));

  bot.action("menu:wallets", (ctx) =>
    ctx.editMessageText("Wallets — tap one to manage it. [🎯 Auto] [👀 Copy]:", walletsMenu(store.listWallets()))
  );

  bot.action("menu:settings", (ctx) =>
    ctx.editMessageText("Settings (tap to change):", settingsMenu(store.getSettings()))
  );

  bot.action("menu:auto", (ctx) =>
    ctx.editMessageText(
      `Auto free-mint watcher: ${runningAuto.size > 0 ? `🟢 running on ${[...runningAuto.keys()].join(", ")}` : "🔴 stopped"}\n` +
        `Wallets enabled: ${store.listWalletsFor("auto").length}/${store.listWallets().length} (toggle per wallet in Wallets)\n` +
        "Detects any SeaDrop drop going live at price 0 and mints the max per wallet — no confirmation. " +
        "Runs on one or more chains at once — set which ones in Settings → Auto-mint chains.",
      autoMenu(runningAuto.size > 0)
    )
  );

  bot.action("menu:copy", (ctx) =>
    ctx.editMessageText(
      `Copy-mint watcher: ${runningCopy ? "🟢 running" : "🔴 stopped"}\n` +
        `Wallets enabled: ${store.listWalletsFor("copy").length}/${store.listWallets().length} (toggle per wallet in Wallets)\n` +
        "Copies any mintPublic call from a watched wallet, using your own wallets.",
      copyMenu(runningCopy !== null, store.listCopyTargets())
    )
  );

  bot.action("menu:fund", (ctx) => {
    const wallets = store.listWallets();
    if (wallets.length < 2) {
      return ctx.answerCbQuery("Add at least two wallets first — one to send from, one to receive.", {
        show_alert: true,
      });
    }
    ctx.session.fundSource = undefined;
    ctx.session.fundTargets = undefined;
    return ctx.editMessageText("Send FROM which wallet?", fundSourceMenu(wallets));
  });

  // ── Portfolio: what's been minted, with art, floor and links ─────────
  bot.action("menu:portfolio", async (ctx) => {
    const mints = store.listMints();
    if (mints.length === 0) {
      return ctx.answerCbQuery("Nothing minted yet — it fills in automatically as mints land.", {
        show_alert: true,
      });
    }
    await ctx.answerCbQuery("Fetching floors...");

    const key = process.env.OPENSEA_API_KEY;
    // Sequential on purpose: OpenSea rate-limits, and a portfolio refresh is
    // not worth risking a 429 that also breaks the slug lookups the mint
    // path uses for labelling.
    const lines: string[] = [];
    for (const m of mints.slice(0, 20)) {
      const stats = m.slug ? await fetchStats(m.slug, key) : null;
      const floor =
        stats?.floorPrice != null
          ? `floor ${stats.floorPrice} ${stats.floorSymbol}`
          : stats
            ? "nothing listed"
            : "floor n/a";
      const day = stats ? ` · 24h ${stats.oneDaySales} sales` : "";
      lines.push(`• ${m.name || maskAddress(m.nftContract)} ×${m.quantity} — ${floor}${day}`);
    }

    await ctx.editMessageText(
      `🖼 Portfolio — ${mints.length} collection(s)\n\n${lines.join("\n")}\n\nTap one for art, links and activity.`,
      portfolioMenu(mints)
    );
  });

  bot.action(/^pf:view:(.+)$/, async (ctx) => {
    const record = store.listMints().find((m) => m.nftContract.toLowerCase() === ctx.match[1].toLowerCase());
    if (!record) return ctx.answerCbQuery("No longer in your portfolio.", { show_alert: true });
    await ctx.answerCbQuery();

    const key = process.env.OPENSEA_API_KEY;
    const [info, stats] = await Promise.all([
      record.slug ? fetchCollection(record.slug, key) : Promise.resolve(null),
      record.slug ? fetchStats(record.slug, key) : Promise.resolve(null),
    ]);

    const chain = resolveChain(record.chainKey);
    const caption =
      `${info?.name || record.name || "Unknown collection"}\n` +
      `${record.nftContract}\n\n` +
      `Held: ${record.quantity} across ${record.wallets.length} wallet(s)\n` +
      (stats
        ? `Floor: ${stats.floorPrice != null ? `${stats.floorPrice} ${stats.floorSymbol}` : "nothing listed"}\n` +
          `Owners: ${stats.owners} · Total sales: ${stats.totalSales}\n` +
          `24h: ${stats.oneDaySales} sales, ${stats.oneDayVolume.toFixed(6)} ${stats.floorSymbol}`
        : "Market data unavailable (collection may not be indexed by OpenSea)") +
      `\n\nMinted: ${toIST(new Date(record.firstMintedAt))} IST` +
      (chain ? `\nChain: ${chain.name}` : "");

    const url = record.slug ? openseaCollectionUrl(record.slug) : undefined;
    const keyboard = portfolioItemMenu(record, url);

    // Art if OpenSea has it; otherwise the same detail as plain text rather
    // than failing the whole view over a missing image.
    if (info?.imageUrl) {
      try {
        await ctx.replyWithPhoto(info.imageUrl, { caption, ...keyboard });
        return;
      } catch {
        /* fall through to text */
      }
    }
    await ctx.reply(caption, keyboard);
  });

  bot.action(/^pf:activity:(.+)$/, async (ctx) => {
    const record = store.listMints().find((m) => m.nftContract.toLowerCase() === ctx.match[1].toLowerCase());
    if (!record?.slug) {
      return ctx.answerCbQuery("No OpenSea slug for this collection — activity unavailable.", { show_alert: true });
    }
    await ctx.answerCbQuery("Fetching activity...");

    const events = await fetchActivity(record.slug, process.env.OPENSEA_API_KEY, 15);
    if (events.length === 0) return ctx.reply("No recent activity reported for this collection.");

    const lines = events.slice(0, 12).map((e) => {
      const when = toIST(new Date(e.timestamp * 1000));
      const price = e.priceEth != null ? ` — ${e.priceEth} ETH` : "";
      const token = e.tokenId ? ` #${e.tokenId}` : "";
      return `• ${e.type}${token}${price}  (${when} IST)`;
    });
    const sales = events.filter((e) => e.type === "sale").length;
    await ctx.reply(
      `📈 ${record.name || record.slug} — last ${events.length} events (${sales} sales)\n\n${lines.join("\n")}`
    );
  });

  bot.action(/^pf:remove:(.+)$/, (ctx) => {
    store.removeMint(ctx.match[1]);
    const mints = store.listMints();
    if (mints.length === 0) return ctx.editMessageText("Portfolio is empty.", mainMenu());
    return ctx.editMessageText(`🖼 Portfolio — ${mints.length} collection(s)`, portfolioMenu(mints));
  });

  // ── Activity alerts on held collections ──────────────────────────────
  function startActivity(chatId: number): { ok: true } | { ok: false; reason: string } {
    if (runningActivity) return { ok: true };
    const collections = store
      .listMints()
      .filter((m) => m.slug)
      .map((m) => ({ slug: m.slug!, name: m.name || m.slug! }));
    if (collections.length === 0) {
      return { ok: false, reason: "No portfolio collections with an OpenSea slug to watch yet." };
    }

    const settings = store.getSettings();
    const stopSignal = { stopped: false };
    const logger = withPrefix("activity", createLogger(createTelegramSink(bot, chatId)));
    const promise = runActivityWatcher({
      collections,
      apiKey: process.env.OPENSEA_API_KEY,
      pollIntervalMs: 120_000, // OpenSea, not an RPC — a couple of minutes is plenty and stays well inside its limits
      sweepSalesThreshold: settings.activitySweepSales,
      floorMovePct: settings.activityFloorMovePct,
      offerVsFloorPct: settings.activityOfferVsFloorPct,
      logger,
      stopSignal,
    }).catch((err) => logger.errorBold(`Activity watcher crashed: ${err.message}`));
    runningActivity = { stopSignal, promise };
    store.updateSettings({ activityEnabled: true });
    return { ok: true };
  }

  function stopActivity(): void {
    if (!runningActivity) return;
    runningActivity.stopSignal.stopped = true;
    runningActivity = null;
    store.updateSettings({ activityEnabled: false });
  }

  bot.action("menu:activity", (ctx) => {
    const tracked = store.listMints().filter((m) => m.slug).length;
    return ctx.editMessageText(
      `🔔 Activity alerts: ${runningActivity ? "🟢 running" : "🔴 stopped"}
` +
        `Watching ${tracked} portfolio collection(s) for sweeps, floor moves and offers.
` +
        "Alerts arrive here automatically; nothing is ever bought or sold.",
      activityMenu(runningActivity !== null, store.getSettings())
    );
  });

  bot.action("activity:toggle", async (ctx) => {
    if (runningActivity) {
      stopActivity();
      await ctx.answerCbQuery("Stopping...");
    } else {
      const result = startActivity(ctx.chat!.id);
      if (!result.ok) return ctx.answerCbQuery(result.reason, { show_alert: true });
      await ctx.answerCbQuery("Started.");
    }
    return ctx.editMessageText(
      `🔔 Activity alerts: ${runningActivity ? "🟢 running" : "🔴 stopped"}`,
      activityMenu(runningActivity !== null, store.getSettings())
    );
  });

  if (store.getSettings().activityEnabled) {
    try {
      const result = startActivity(ownerId);
      if (!result.ok) store.updateSettings({ activityEnabled: false });
    } catch {
      store.updateSettings({ activityEnabled: false });
    }
  }

  bot.action("menu:status", async (ctx) => {
    const settings = store.getSettings();
    const wallets = store.listWallets();
    const chain = resolveChain(settings.chainKey);
    let balances = "";
    if (chain && wallets.length > 0) {
      try {
        const { urls } = resolveRpcsForChain(settings.chainKey);
        const provider = createProvider(urls[0]);
        const results = await Promise.all(
          wallets.map(async (w) => {
            const bal = await provider.getBalance(w.address).catch(() => null);
            return `  ${w.label}: ${bal !== null ? `${formatEther(bal)} ${chain.nativeSymbol}` : "?"}`;
          })
        );
        balances = "\n" + results.join("\n");
      } catch {
        balances = "\n  (balance lookup failed)";
      }
    }
    await ctx.editMessageText(
      `Chain: ${settings.chainKey}\n` +
        `Wallets: ${wallets.length}${balances}\n` +
        `Auto mint: ${runningAuto.size > 0 ? `running on ${[...runningAuto.keys()].join(", ")}` : "stopped"}\n` +
        `Copy mint: ${runningCopy ? "running" : "stopped"} (watching ${store.listCopyTargets().length})
` +
        `Portfolio: ${store.listMints().length} collection(s)
` +
        `Activity alerts: ${runningActivity ? "running" : "stopped"}`,
      mainMenu()
    );
  });

  // ── Wallets ──────────────────────────────────────────────────────────
  bot.action("wallet:add", (ctx) => {
    ctx.session.step = "awaiting_wallet_key";
    return ctx.reply(
      "⚠️ Paste the private key for the wallet you want to add.\n\n" +
        "This message is deleted the instant I read it, but Telegram is not end-to-end " +
        "encrypted for bots — only paste a key you're using *just* for this bot, funded " +
        "with only what you're willing to risk.",
      { parse_mode: "Markdown" }
    );
  });

  bot.action(/^wallet:remove:(.+)$/, (ctx) => {
    const address = ctx.match[1];
    store.removeWallet(address);
    return ctx.editMessageText("Wallets — tap one to manage it. [🎯 Auto] [👀 Copy]:", walletsMenu(store.listWallets()));
  });

  bot.action(/^wallet:manage:(.+)$/, (ctx) => {
    const wallet = store.listWallets().find((w) => w.address.toLowerCase() === ctx.match[1].toLowerCase());
    if (!wallet) return ctx.answerCbQuery("That wallet no longer exists.", { show_alert: true });
    return ctx.editMessageText(`${wallet.label} (${maskAddress(wallet.address)})`, walletDetailMenu(wallet));
  });

  bot.action(/^wallet:toggle:(auto|copy):(.+)$/, (ctx) => {
    const feature = ctx.match[1] as "auto" | "copy";
    const address = ctx.match[2];
    try {
      const wallet = store.listWallets().find((w) => w.address.toLowerCase() === address.toLowerCase());
      if (!wallet) return ctx.answerCbQuery("That wallet no longer exists.", { show_alert: true });
      const currentlyOn = feature === "auto" ? wallet.includeInAutoMint !== false : wallet.includeInCopyMint !== false;
      const updated = store.setWalletInclusion(address, feature, !currentlyOn);
      return ctx.editMessageText(`${updated.label} (${maskAddress(updated.address)})`, walletDetailMenu(updated));
    } catch (err: any) {
      return ctx.answerCbQuery(err.message, { show_alert: true });
    }
  });

  // ── Copy-mint watchlist ──────────────────────────────────────────────
  bot.action("copy:add", (ctx) => {
    ctx.session.step = "awaiting_copy_target";
    return ctx.reply("Send the wallet address to watch (optionally followed by a label, e.g. `0xabc... whale`).", {
      parse_mode: "Markdown",
    });
  });

  bot.action(/^copy:remove:(.+)$/, (ctx) => {
    const address = ctx.match[1];
    store.removeCopyTarget(address);
    return ctx.editMessageText("Copy-mint watchlist:", copyMenu(runningCopy !== null, store.listCopyTargets()));
  });

  // Pulled out of the toggle action so start-up can resume it too, without a
  // tap, whenever settings.copyMintEnabled says it was left running — same
  // pattern as Auto Mint's startAuto/stopAuto below.
  function startCopy(chatId: number): { ok: true } | { ok: false; reason: string } {
    if (runningCopy) return { ok: true }; // already running
    const targets = store.listCopyTargets();
    const wallets = store.listWalletsFor("copy");
    if (targets.length === 0) return { ok: false, reason: "Add a wallet to watch first." };
    if (wallets.length === 0) {
      return { ok: false, reason: "No wallets enabled for Copy Mint — enable at least one in Wallets." };
    }

    const settings = store.getSettings();
    const chain = resolveChain(settings.chainKey)!;
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const stopSignal = { stopped: false };
    // Prefixed like the auto-mint watchers are. Without this, copy-mint's
    // output is the only unlabelled stream in the log and gets lost among
    // the [chain]-tagged auto-mint lines running alongside it.
    const logger = withPrefix(`copy:${settings.chainKey}`, createLogger(createTelegramSink(bot, chatId)));
    const promise = runCopyMintWatcher({
      chain,
      rpcUrls: urls,
      walletKeys: wallets.map((w) => store.getDecryptedKey(w.address)),
      watchTargets: targets.map((t) => t.address),
      maxFeePerGas: gweiToWei(settings.maxFeeGwei),
      maxPriorityFee: gweiToWei(settings.priorityGwei),
      gasLimit: settings.gasLimit,
      pollIntervalMs: 4000,
      maxPriceEth: settings.copyMintMaxPriceEth,
      quantityPerWallet: settings.copyMintMaxQuantity,
      logChunkBlocks: process.env.AUTO_LOG_CHUNK_BLOCKS ? parseInt(process.env.AUTO_LOG_CHUNK_BLOCKS, 10) : undefined,
      onMinted: (o) => recordOutcome(store, settings.chainKey, o),
      alreadyMinted: (c) => store.listMints().some((m) => m.nftContract.toLowerCase() === c.toLowerCase()),
      logger,
      stopSignal,
    }).catch((err) => logger.errorBold(`Copy-mint watcher crashed: ${err.message}`));
    runningCopy = { stopSignal, promise };
    store.updateSettings({ copyMintEnabled: true });
    return { ok: true };
  }

  function stopCopy(): void {
    if (!runningCopy) return;
    runningCopy.stopSignal.stopped = true;
    runningCopy = null;
    store.updateSettings({ copyMintEnabled: false });
  }

  bot.action("copy:toggle", async (ctx) => {
    if (runningCopy) {
      stopCopy();
      await ctx.answerCbQuery("Stopping...");
    } else {
      const result = startCopy(ctx.chat!.id);
      if (!result.ok) return ctx.answerCbQuery(result.reason, { show_alert: true });
      await ctx.answerCbQuery("Started.");
    }
    return ctx.editMessageText(
      `Copy-mint watcher: ${runningCopy ? "🟢 running" : "🔴 stopped"}`,
      copyMenu(runningCopy !== null, store.listCopyTargets())
    );
  });

  // Resume automatically on every bot start if it was left "on" — same
  // reasoning as Auto Mint: a restart shouldn't silently turn this off
  // until someone notices and taps the button again. Never let this stop
  // the bot itself from starting.
  if (store.getSettings().copyMintEnabled) {
    try {
      const result = startCopy(ownerId);
      if (result.ok) {
        bot.telegram.sendMessage(ownerId, "🟢 Copy-mint watcher resumed (was on before restart).").catch(() => {});
      } else {
        store.updateSettings({ copyMintEnabled: false });
      }
    } catch (err: any) {
      store.updateSettings({ copyMintEnabled: false });
      console.error(`Could not resume copy-mint on startup: ${err.message}`);
    }
  }

  // ── Auto free-mint watcher ───────────────────────────────────────────
  // Pulled out of the toggle action so start-up can resume it too, without
  // a tap, whenever settings.autoEnabled says it was left running. Runs one
  // runAutoMintWatcher per chain in settings.autoChainKeys (or just
  // chainKey if that list is empty), each independently start/stoppable —
  // same "one watcher per chain, prefixed logger" shape as the CLI's
  // comma-separated AUTO_CHAIN.
  function startAuto(chatId: number): { ok: true } | { ok: false; reason: string } {
    const wallets = store.listWalletsFor("auto");
    if (wallets.length === 0) {
      return { ok: false, reason: "No wallets enabled for Auto Mint — enable at least one in Wallets." };
    }

    const settings = store.getSettings();
    const chainKeys = settings.autoChainKeys?.length ? settings.autoChainKeys : [settings.chainKey];

    for (const key of chainKeys) {
      if (runningAuto.has(key)) continue; // already running on this chain
      const chain = resolveChain(key);
      if (!chain) continue; // shouldn't happen — chosen from CHAINS via buttons

      const { urls } = resolveRpcsForChain(key);
      const stopSignal = { stopped: false };
      const logger = withPrefix(key, createLogger(createTelegramSink(bot, chatId)));
      const promise = runAutoMintWatcher({
        chain,
        rpcUrls: urls,
        walletKeys: wallets.map((w) => store.getDecryptedKey(w.address)),
        maxFeePerGas: gweiToWei(settings.maxFeeGwei),
        maxPriorityFee: gweiToWei(settings.priorityGwei),
        gasLimit: settings.gasLimit,
        pollIntervalMs: 4000,
        maxQuantityPerWallet: settings.autoMaxQuantity,
        openseaApiKey: process.env.OPENSEA_API_KEY,
        logChunkBlocks: process.env.AUTO_LOG_CHUNK_BLOCKS ? parseInt(process.env.AUTO_LOG_CHUNK_BLOCKS, 10) : undefined,
        onMinted: (o) => recordOutcome(store, key, o),
        alreadyMinted: (c) => store.listMints().some((m) => m.nftContract.toLowerCase() === c.toLowerCase()),
        logger,
        stopSignal,
      }).catch((err) => logger.errorBold(`Auto-mint watcher crashed: ${err.message}`));
      runningAuto.set(key, { stopSignal, promise });
    }
    store.updateSettings({ autoEnabled: true });
    return { ok: true };
  }

  function stopAuto(): void {
    for (const watcher of runningAuto.values()) watcher.stopSignal.stopped = true;
    runningAuto.clear();
    store.updateSettings({ autoEnabled: false });
  }

  bot.action("auto:toggle", async (ctx) => {
    if (runningAuto.size > 0) {
      stopAuto();
      await ctx.answerCbQuery("Stopping...");
    } else {
      const result = startAuto(ctx.chat!.id);
      if (!result.ok) return ctx.answerCbQuery(result.reason, { show_alert: true });
      await ctx.answerCbQuery("Started.");
    }
    return ctx.editMessageText(
      `Auto free-mint watcher: ${runningAuto.size > 0 ? `🟢 running on ${[...runningAuto.keys()].join(", ")}` : "🔴 stopped"}`,
      autoMenu(runningAuto.size > 0)
    );
  });

  // Resume automatically on every bot start if it was left "on" — so a
  // restart (redeploy, crash-and-relaunch, reboot) doesn't silently turn
  // auto-mint off until someone notices and taps the button again. Never
  // let this stop the bot itself from starting — worst case, auto-mint
  // just stays off and the owner can turn it back on from the menu.
  if (store.getSettings().autoEnabled) {
    try {
      const result = startAuto(ownerId);
      if (result.ok) {
        bot.telegram
          .sendMessage(ownerId, `🟢 Auto free-mint watcher resumed on ${[...runningAuto.keys()].join(", ")} (was on before restart).`)
          .catch(() => {});
      } else {
        store.updateSettings({ autoEnabled: false });
      }
    } catch (err: any) {
      store.updateSettings({ autoEnabled: false });
      console.error(`Could not resume auto-mint on startup: ${err.message}`);
    }
  }

  // ── Fund wallets: send native currency from one wallet to several ─────
  bot.action(/^fund:source:(.+)$/, (ctx) => {
    const source = ctx.match[1];
    ctx.session.fundSource = source;
    ctx.session.fundTargets = [];
    const candidates = store.listWallets().filter((w) => w.address.toLowerCase() !== source.toLowerCase());
    return ctx.editMessageText("Send TO which wallet(s)? Tap to select, then Done.", fundTargetsMenu(candidates, new Set()));
  });

  bot.action(/^fund:target:toggle:(.+)$/, (ctx) => {
    const address = ctx.match[1].toLowerCase();
    const targets = new Set(ctx.session.fundTargets ?? []);
    if (targets.has(address)) targets.delete(address);
    else targets.add(address);
    ctx.session.fundTargets = [...targets];

    const candidates = store
      .listWallets()
      .filter((w) => w.address.toLowerCase() !== (ctx.session.fundSource ?? "").toLowerCase());
    return ctx.editMessageText("Send TO which wallet(s)? Tap to select, then Done.", fundTargetsMenu(candidates, targets));
  });

  bot.action("fund:targets:done", (ctx) => {
    if (!ctx.session.fundTargets || ctx.session.fundTargets.length === 0) {
      return ctx.answerCbQuery("Select at least one wallet.", { show_alert: true });
    }
    const settings = store.getSettings();
    const chain = resolveChain(settings.chainKey)!;
    ctx.session.step = "awaiting_fund_amount";
    return ctx.reply(`How much ${chain.nativeSymbol} to send to EACH of the ${ctx.session.fundTargets.length} selected wallet(s)?`);
  });

  bot.action("fund:cancel", (ctx) => {
    ctx.session.step = undefined;
    ctx.session.fundSource = undefined;
    ctx.session.fundTargets = undefined;
    ctx.session.fundAmountWei = undefined;
    return ctx.editMessageText("Cancelled.", mainMenu());
  });

  bot.action("fund:confirm", async (ctx) => {
    const { fundSource, fundTargets, fundAmountWei } = ctx.session;
    if (!fundSource || !fundTargets?.length || !fundAmountWei) {
      return ctx.answerCbQuery("That request expired — start over from Fund Wallets.", { show_alert: true });
    }
    ctx.session.step = undefined;
    ctx.session.fundSource = undefined;
    ctx.session.fundTargets = undefined;
    ctx.session.fundAmountWei = undefined;
    await ctx.answerCbQuery("Sending...");
    await ctx.editMessageText("Sending — status below.");

    const settings = store.getSettings();
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const logger = createLogger(createTelegramSink(bot, ctx.chat!.id));
    try {
      await batchTransfer({
        rpcUrl: urls[0],
        sourceKey: store.getDecryptedKey(fundSource),
        targets: fundTargets,
        amountWei: BigInt(fundAmountWei),
        maxFeePerGas: gweiToWei(settings.maxFeeGwei),
        maxPriorityFee: gweiToWei(settings.priorityGwei),
        logger,
      });
    } catch (err: any) {
      logger.errorBold(`Batch transfer failed: ${err.message}`);
    }
  });

  // ── Settings ─────────────────────────────────────────────────────────
  bot.action("setting:chain", (ctx) => ctx.editMessageText("Pick a chain:", chainPickerMenu()));
  bot.action(/^setting:chain:(.+)$/, (ctx) => {
    store.updateSettings({ chainKey: ctx.match[1] });
    return ctx.editMessageText("Settings:", settingsMenu(store.getSettings()));
  });

  bot.action("setting:autoChains", (ctx) =>
    ctx.editMessageText(
      "Which chain(s) should Auto Mint watch? Select none to just use the default Chain above.",
      autoChainsMenu(new Set(store.getSettings().autoChainKeys ?? []))
    )
  );
  bot.action(/^setting:autoChains:toggle:(.+)$/, (ctx) => {
    const key = ctx.match[1];
    const selected = new Set(store.getSettings().autoChainKeys ?? []);
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    store.updateSettings({ autoChainKeys: selected.size > 0 ? [...selected] : undefined });
    return ctx.editMessageText(
      "Which chain(s) should Auto Mint watch? Select none to just use the default Chain above.",
      autoChainsMenu(selected)
    );
  });

  const NUMERIC_SETTINGS = [
    "maxFeeGwei",
    "priorityGwei",
    "gasLimit",
    "autoMaxQuantity",
    "copyMintMaxPriceEth",
    "copyMintMaxQuantity",
    "activitySweepSales",
    "activityFloorMovePct",
    "activityOfferVsFloorPct",
  ] as const;
  // Both quantity caps are optional — clearable back to "unlimited" (the
  // drop's own true max-per-wallet) rather than needing some magic number.
  const CLEARABLE = new Set(["autoMaxQuantity", "copyMintMaxQuantity"]);
  for (const field of NUMERIC_SETTINGS) {
    bot.action(`setting:${field}`, (ctx) => {
      ctx.session.step = `awaiting_setting:${field}`;
      return ctx.reply(`Send the new value for ${field}${CLEARABLE.has(field) ? " (or \"clear\" for unlimited)" : ""}:`);
    });
  }

  // ── Manual one-off mint ──────────────────────────────────────────────
  // /mint <link> <quantity> [wallet labels/addresses, comma-separated]
  // The wallet filter is what makes this the fast path for "already live,
  // fire now with this one wallet" — one message, no menu taps, no
  // confirmation, so it's the fastest thing this bot can do for a
  // genuinely contested public stage.
  bot.command("mint", async (ctx) => {
    const rawArgs = ctx.message.text.split(/\s+/).slice(1);
    const dryRun = rawArgs.includes("--dry");
    const args = rawArgs.filter((a) => a !== "--dry");
    const [link, qtyRaw, walletFilter] = args;
    const requestedQuantity = parseInt(qtyRaw ?? "1", 10);
    if (!link || !Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
      return ctx.reply("Usage: /mint <contract address, OpenSea link, or slug> <quantity> [wallet label(s)] [--dry]");
    }

    const allWallets = store.listWallets();
    const settings = store.getSettings();
    if (allWallets.length === 0) return ctx.reply("Add a wallet first.");

    let wallets: WalletRecord[];
    try {
      wallets = walletFilter ? matchWallets(allWallets, walletFilter) : allWallets;
    } catch (err: any) {
      return ctx.reply(`❌ ${err.message}`);
    }

    const logger = createLogger(createTelegramSink(bot, ctx.chat!.id));
    try {
      const contract = await resolveMintTarget(link, settings.chainKey);
      const { urls } = resolveRpcsForChain(settings.chainKey);

      const preview = await buildLocalMintPlan(urls[0], contract, 1);
      if (!preview) return ctx.reply("No public drop found for that contract on the configured chain.");
      const dropMax = preview.drop.maxTotalMintableByWallet;
      const quantity = dropMax > 0 ? Math.min(dropMax, requestedQuantity) : requestedQuantity;
      if (quantity < requestedQuantity) {
        await ctx.reply(`Capped to ${quantity}/wallet — this drop's real max is ${dropMax}.`);
      }

      const plan = await buildLocalMintPlan(urls[0], contract, quantity);
      if (!plan) return ctx.reply("No public drop found for that contract on the configured chain.");

      if (dryRun) {
        const chain = resolveChain(settings.chainKey)!;
        const perWallet = await previewMint(
          urls[0],
          chain.nativeSymbol,
          wallets,
          settings.gasLimit,
          gweiToWei(settings.maxFeeGwei),
          plan.value
        );
        return ctx.reply(
          `🧪 DRY RUN — nothing was signed or sent.\n` +
            `${contract}\n` +
            `Price: ${formatEther(plan.drop.mintPrice)} × ${quantity} = ${formatEther(plan.value)} ${chain.nativeSymbol} per wallet\n\n` +
            perWallet
        );
      }

      const outcome = await localPublicSnipe({
        nftContract: contract,
        quantity,
        walletKeys: wallets.map((w) => store.getDecryptedKey(w.address)),
        rpcUrls: urls,
        maxFeePerGas: gweiToWei(settings.maxFeeGwei),
        maxPriorityFee: gweiToWei(settings.priorityGwei),
        gasLimit: settings.gasLimit,
        targetStart: null,
        plan,
        logger,
      });
      await recordOutcome(store, settings.chainKey, outcome);
    } catch (err: any) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── Scheduled mint: pick a target, wallets, quantity and a fire time ──
  function resetSchedSession(ctx: BotContext): void {
    ctx.session.step = undefined;
    ctx.session.schedContract = undefined;
    ctx.session.schedWallets = undefined;
    ctx.session.schedQuantity = undefined;
    ctx.session.schedDropMax = undefined;
    ctx.session.schedStartTime = undefined;
    ctx.session.schedTargetStartMs = undefined;
  }

  bot.action("menu:sched", (ctx) => {
    const wallets = store.listWallets();
    if (wallets.length === 0) return ctx.answerCbQuery("Add a wallet first.", { show_alert: true });
    resetSchedSession(ctx);
    ctx.session.step = "awaiting_sched_link";
    return ctx.reply("Paste the contract address, OpenSea link, or slug.");
  });

  bot.action(/^sched:wallet:toggle:(.+)$/, (ctx) => {
    const address = ctx.match[1].toLowerCase();
    const selected = new Set(ctx.session.schedWallets ?? []);
    if (selected.has(address)) selected.delete(address);
    else selected.add(address);
    ctx.session.schedWallets = [...selected];
    return ctx.editMessageText("Mint FROM which wallet(s)? Tap to select, then Done.", schedWalletsMenu(store.listWallets(), selected));
  });

  bot.action("sched:wallets:done", (ctx) => {
    if (!ctx.session.schedWallets || ctx.session.schedWallets.length === 0) {
      return ctx.answerCbQuery("Select at least one wallet.", { show_alert: true });
    }
    ctx.session.step = "awaiting_sched_quantity";
    const max = ctx.session.schedDropMax ?? 0;
    return ctx.reply(`How many per wallet? (drop's real max is ${max > 0 ? max : "unspecified"} — you'll never exceed it)`);
  });

  bot.action("sched:cancel", (ctx) => {
    resetSchedSession(ctx);
    return ctx.editMessageText("Cancelled.", mainMenu());
  });

  async function fireScheduled(ctx: BotContext, targetStart: Date | null): Promise<void> {
    const { schedContract, schedWallets, schedQuantity } = ctx.session;
    if (!schedContract || !schedWallets?.length || !schedQuantity) {
      await ctx.answerCbQuery("That request expired — start over from Scheduled Mint.", { show_alert: true });
      return;
    }
    resetSchedSession(ctx);
    await ctx.answerCbQuery(targetStart ? "Scheduled." : "Firing...");
    await ctx.editMessageText(
      targetStart ? `Scheduled for ${toIST(targetStart)} IST — status below when it fires.` : "Firing — status below."
    );

    const settings = store.getSettings();
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const logger = createLogger(createTelegramSink(bot, ctx.chat!.id));
    try {
      const plan = await buildLocalMintPlan(urls[0], schedContract, schedQuantity);
      if (!plan) {
        logger.errorBold("Drop is no longer resolvable on-chain — nothing fired.");
        return;
      }
      // localPublicSnipe itself waits for targetStart internally (same
      // engine the CLI's "wait for stage" uses) — awaiting it here just
      // means this promise resolves whenever it eventually fires, which
      // can be a long time from now. That's fine: Node doesn't block on a
      // pending await, so the bot keeps handling everything else meanwhile.
      const outcome = await localPublicSnipe({
        nftContract: schedContract,
        quantity: schedQuantity,
        walletKeys: schedWallets.map((addr) => store.getDecryptedKey(addr)),
        rpcUrls: urls,
        maxFeePerGas: gweiToWei(settings.maxFeeGwei),
        maxPriorityFee: gweiToWei(settings.priorityGwei),
        gasLimit: settings.gasLimit,
        targetStart,
        plan,
        logger,
      });
      await recordOutcome(store, settings.chainKey, outcome);
    } catch (err: any) {
      logger.errorBold(`Scheduled mint failed: ${err.message}`);
    }
  }

  // Picking a time doesn't fire anything yet — it stages the choice and
  // shows a confirm step, same "always confirm before a deliberate one-off
  // action" rule Fund Wallets follows. A scheduled fire might not happen
  // for hours, so getting one detail wrong here is expensive to not catch.
  function confirmSummary(ctx: BotContext): string {
    const { schedContract, schedWallets, schedQuantity, schedTargetStartMs } = ctx.session;
    const walletCount = schedWallets?.length ?? 0;
    const when =
      schedTargetStartMs === "now"
        ? "now"
        : schedTargetStartMs
          ? `${toIST(new Date(schedTargetStartMs))} IST`
          : "?";
    return (
      `Mint ${schedQuantity}/wallet from ${schedContract} using ${walletCount} wallet(s)?\n` +
      `Fires: ${when}`
    );
  }

  bot.action("sched:timing:now", (ctx) => {
    ctx.session.schedTargetStartMs = "now";
    return ctx.editMessageText(confirmSummary(ctx), schedConfirmMenu());
  });
  bot.action("sched:timing:wait", (ctx) => {
    const startTime = ctx.session.schedStartTime;
    if (!startTime) return ctx.answerCbQuery("That request expired — start over.", { show_alert: true });
    ctx.session.schedTargetStartMs = startTime * 1000;
    return ctx.editMessageText(confirmSummary(ctx), schedConfirmMenu());
  });
  bot.action("sched:timing:custom", (ctx) => {
    ctx.session.step = "awaiting_sched_custom_time";
    return ctx.reply("Send the time (HH:MM, 24-hour IST, today):");
  });

  bot.action("sched:confirm", (ctx) => {
    const at = ctx.session.schedTargetStartMs;
    if (!at) return ctx.answerCbQuery("That request expired — start over from Scheduled Mint.", { show_alert: true });
    return fireScheduled(ctx, at === "now" ? null : new Date(at));
  });

  // Validates everything (drop still resolvable, wallet balances) without
  // ever signing or broadcasting — session stays intact, so Confirm/Cancel
  // still work exactly as before right after.
  bot.action("sched:dryrun", async (ctx) => {
    const { schedContract, schedWallets, schedQuantity } = ctx.session;
    if (!schedContract || !schedWallets?.length || !schedQuantity) {
      return ctx.answerCbQuery("That request expired — start over from Scheduled Mint.", { show_alert: true });
    }
    await ctx.answerCbQuery("Checking...");
    const settings = store.getSettings();
    const chain = resolveChain(settings.chainKey)!;
    const { urls } = resolveRpcsForChain(settings.chainKey);
    try {
      const plan = await buildLocalMintPlan(urls[0], schedContract, schedQuantity);
      if (!plan) return ctx.reply("🧪 DRY RUN: drop is not currently resolvable on-chain — a real fire would fail.");

      const wallets = store.listWallets().filter((w) => schedWallets.includes(w.address.toLowerCase()));
      const perWallet = await previewMint(
        urls[0],
        chain.nativeSymbol,
        wallets,
        settings.gasLimit,
        gweiToWei(settings.maxFeeGwei),
        plan.value
      );
      await ctx.reply(
        `🧪 DRY RUN — nothing was signed or sent.\n` +
          `${schedContract}\n` +
          `Price: ${formatEther(plan.drop.mintPrice)} × ${schedQuantity} = ${formatEther(plan.value)} ${chain.nativeSymbol} per wallet\n\n` +
          perWallet
      );
    } catch (err: any) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── Text handler: services whatever multi-step flow is in progress ───
  bot.on(message("text"), async (ctx) => {
    const step = ctx.session.step;
    if (!step) return; // not mid-flow — ignore free text rather than guess intent

    if (step === "awaiting_wallet_key") {
      const key = ctx.message.text.trim();
      await ctx.deleteMessage(ctx.message.message_id).catch(() => {});
      ctx.session.step = undefined;
      try {
        const record = store.addWallet("", key);
        await ctx.reply(`✅ Added ${maskAddress(record.address)} (label: ${record.label}).`, mainMenu());
      } catch (err: any) {
        await ctx.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (step === "awaiting_copy_target") {
      ctx.session.step = undefined;
      const [address, ...labelParts] = ctx.message.text.trim().split(/\s+/);
      if (!isAddress(address)) return ctx.reply("That doesn't look like a valid address.");
      try {
        const target = store.addCopyTarget(labelParts.join(" "), address);
        await ctx.reply(`✅ Watching ${target.label} (${maskAddress(target.address)}).`);
      } catch (err: any) {
        await ctx.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (step === "awaiting_sched_link") {
      ctx.session.step = undefined;
      const link = ctx.message.text.trim();
      const settings = store.getSettings();
      try {
        const contract = await resolveMintTarget(link, settings.chainKey);
        const { urls } = resolveRpcsForChain(settings.chainKey);
        const preview = await buildLocalMintPlan(urls[0], contract, 1);
        if (!preview) return ctx.reply("No public drop found for that contract on the configured chain.");

        ctx.session.schedContract = contract;
        ctx.session.schedDropMax = preview.drop.maxTotalMintableByWallet;
        ctx.session.schedStartTime = preview.drop.startTime;

        const live = preview.drop.startTime * 1000 <= Date.now();
        await ctx.reply(
          `${contract}\n` +
            `Price: ${formatEther(preview.drop.mintPrice)} ${resolveChain(settings.chainKey)!.nativeSymbol}\n` +
            `Max per wallet: ${preview.drop.maxTotalMintableByWallet || "unspecified"}\n` +
            `Stage: ${live ? "already live" : `opens ${toIST(new Date(preview.drop.startTime * 1000))} IST`}`
        );
        await ctx.reply("Mint FROM which wallet(s)? Tap to select, then Done.", schedWalletsMenu(store.listWallets(), new Set()));
      } catch (err: any) {
        await ctx.reply(`❌ ${err.message}`);
      }
      return;
    }

    if (step === "awaiting_sched_quantity") {
      ctx.session.step = undefined;
      const requested = parseInt(ctx.message.text.trim(), 10);
      if (!Number.isFinite(requested) || requested <= 0) return ctx.reply("That's not a valid quantity.");
      const dropMax = ctx.session.schedDropMax ?? 0;
      const quantity = dropMax > 0 ? Math.min(dropMax, requested) : requested;
      ctx.session.schedQuantity = quantity;
      if (quantity < requested) await ctx.reply(`Capped to ${quantity}/wallet — this drop's real max is ${dropMax}.`);

      const startsInFuture = (ctx.session.schedStartTime ?? 0) * 1000 > Date.now();
      return ctx.reply("When should it fire?", schedTimingMenu(startsInFuture));
    }

    if (step === "awaiting_sched_custom_time") {
      ctx.session.step = undefined;
      let targetStart: Date;
      try {
        targetStart = istTimeToDate(ctx.message.text.trim());
      } catch (err: any) {
        return ctx.reply(`❌ ${err.message}`);
      }
      const startTime = ctx.session.schedStartTime ?? 0;
      if (targetStart.getTime() < startTime * 1000) {
        await ctx.reply(`⚠️ That's before the stage opens (${toIST(new Date(startTime * 1000))} IST) — it will revert if fired that early.`);
      }
      ctx.session.schedTargetStartMs = targetStart.getTime();
      return ctx.reply(confirmSummary(ctx), schedConfirmMenu());
    }

    if (step === "awaiting_fund_amount") {
      ctx.session.step = undefined;
      const targets = ctx.session.fundTargets ?? [];
      const source = ctx.session.fundSource;
      if (!source || targets.length === 0) return ctx.reply("That request expired — start over from Fund Wallets.");

      let amountWei: bigint;
      try {
        amountWei = parseEther(ctx.message.text.trim());
        if (amountWei <= 0n) throw new Error("must be greater than 0");
      } catch {
        return ctx.reply("That's not a valid amount. Send a plain number, e.g. 0.01");
      }
      ctx.session.fundAmountWei = amountWei.toString();

      const settings = store.getSettings();
      const chain = resolveChain(settings.chainKey)!;
      const worstCase = estimateBatchCost(targets.length, amountWei, gweiToWei(settings.maxFeeGwei));
      const sourceLabel = store.listWallets().find((w) => w.address.toLowerCase() === source.toLowerCase())?.label ?? source;
      return ctx.reply(
        `Send ${formatEther(amountWei)} ${chain.nativeSymbol} from ${sourceLabel} to ${targets.length} wallet(s)?\n` +
          `Worst-case total (including gas): ${formatEther(worstCase)} ${chain.nativeSymbol}`,
        fundConfirmMenu()
      );
    }

    if (step.startsWith("awaiting_setting:")) {
      const field = step.slice("awaiting_setting:".length) as (typeof NUMERIC_SETTINGS)[number];
      ctx.session.step = undefined;
      const raw = ctx.message.text.trim();

      if (CLEARABLE.has(field) && raw.toLowerCase() === "clear") {
        store.updateSettings({ [field]: undefined } as any);
        return ctx.reply(
          field === "autoMaxQuantity"
            ? "Cleared — auto mint will use each drop's true max per wallet."
            : "Cleared — copy mint will use each drop's true max per wallet."
        );
      }

      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) return ctx.reply("That's not a valid number.");
      store.updateSettings({ [field]: value } as any);
      return ctx.reply(`✅ ${field} set to ${value}.`, settingsMenu(store.getSettings()));
    }
  });

  return bot;
}
