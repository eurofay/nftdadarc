// Telegram control surface for the mint sniper. Wraps the same tested engine
// the CLI uses (buildLocalMintPlan / localPublicSnipe / runAutoMintWatcher /
// runCopyMintWatcher) — this file is UI and wiring, not mint logic.
//
// Access is restricted to one Telegram user id (TELEGRAM_OWNER_ID) in private
// chat only; every other update is silently ignored.

import { Telegraf, Markup, Context } from "telegraf";
import { message } from "telegraf/filters";
import { isAddress, formatEther, parseEther } from "ethers";
import { generateMnemonic, deriveWallets, isValidMnemonic } from "../hd-wallet";
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
  portfolioWalletsMenu,
  walletHoldingsMenu,
  walletCollectionMenu,
  sellCollectionMenu,
  sellActionConfirmMenu,
  sellMenu,
  sellConfirmMenu,
  activityMenu,
  copyHistoryMenu,
  copyHistoryWalletMenu,
  maskAddress,
} from "./menus";
import { resolveChain, logChunkBlocksFor, blocksForSeconds } from "../chains";
import { resolveRpcsForChain } from "../rpc-resolver";
import { parseNftLink } from "../nft-link";
import { resolveSlug, openseaContractInfo } from "../slug-resolver";
import {
  fetchCollection,
  fetchStats,
  fetchActivity,
  fetchBestCollectionOffer,
  fetchAccountNfts,
  fetchAccountActivity,
  groupByCollection,
  openseaCollectionUrl,
} from "../opensea-market";
import { buildLocalMintPlan } from "../seadrop-public";
import { localPublicSnipe } from "../local-mint";
import { runAutoMintWatcher } from "../auto-mint";
import { runCopyMintWatcher } from "../copy-mint";
import { runActivityWatcher } from "../activity-watcher";
import { batchTransfer, estimateBatchCost } from "../fund-transfer";
import { fetchOnChainHoldings } from "../nft-holdings";
import { MintCardData } from "../mint-card";
import { renderMintCardPng } from "../mint-card-render";
import { acceptOfferViaSdk, acceptOfferWithFallback, createListing, parseListingPrice } from "../opensea-sell";
import { createLogger, withPrefix, LogSink } from "../logger";
import { istTimeToDate, toIST } from "../time-format";
import { renderBatch } from "./format";

interface SessionData {
  step?:
    | "awaiting_wallet_key"
    | "awaiting_seed_count"
    | "awaiting_seed_import"
    | "awaiting_copy_target"
    | "awaiting_fund_amount"
    | "awaiting_sched_link"
    | "awaiting_sched_quantity"
    | "awaiting_sched_custom_time"
    | "awaiting_list_price"
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
  cbTokens?: Record<string, string>;
  cbSeq?: number;
  sellWallet?: string;
  sellSlug?: string;
  sellPriceEth?: number;
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
  outcome: { nftContract: string; quantity: number; minted: { address: string; txHash: string }[] },
  // Supplied by the bot so a confirmed mint also posts its card. Optional so
  // the CLI paths can record without one.
  card?: { bot: Telegraf<BotContext>; chatId: number; source: MintCardData["source"] }
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

  if (card) {
    const data = await buildCard(store, outcome.nftContract, card.source);
    if (data) await sendCard(card.bot, card.chatId, data);
  }
}

// Assembles a mint card for a collection already in the portfolio, pulling
// live market data so a card generated later reflects today's floor rather
// than the one at mint time.
async function buildCard(
  store: TelegramStore,
  nftContract: string,
  source: MintCardData["source"]
): Promise<MintCardData | null> {
  const record = store.listMints().find((m) => m.nftContract.toLowerCase() === nftContract.toLowerCase());
  if (!record) return null;

  const key = process.env.OPENSEA_API_KEY;
  const [info, stats, offer] = await Promise.all([
    record.slug ? fetchCollection(record.slug, key) : Promise.resolve(null),
    record.slug ? fetchStats(record.slug, key) : Promise.resolve(null),
    record.slug ? fetchBestCollectionOffer(record.slug, key) : Promise.resolve(null),
  ]);

  return {
    collection: info?.name || record.name || maskAddress(record.nftContract),
    contract: record.nftContract,
    chain: record.chainKey,
    source,
    minted: record.quantity,
    wallets: record.wallets.length,
    // The store doesn't track spend per collection; these are overwhelmingly
    // free mints, and gas isn't part of the token's cost basis.
    pricePaidEth: 0,
    floorEth: stats?.floorPrice ?? null,
    bestOfferEth: offer?.priceEth ?? null,
    mintedAt: record.firstMintedAt,
    artHref: info?.imageUrl ?? null,
  };
}

// Rendering costs ~1s of CPU and can fail on a bad image; it must never
// interfere with the mint that produced it.
async function sendCard(
  bot: Telegraf<BotContext>,
  chatId: number,
  data: MintCardData,
  caption?: string
): Promise<void> {
  try {
    const png = await renderMintCardPng(data);
    await bot.telegram.sendPhoto(chatId, { source: png }, caption ? { caption } : undefined);
  } catch (err: any) {
    console.error(`Mint card failed for ${data.contract}: ${err?.message ?? err}`);
  }
}

// Batches log lines into one message instead of sending each separately.
//
// A single mint emits a dozen-odd lines; one Telegram message each turned the
// chat into noise. Lines are collected until the burst goes quiet, then sent
// as one structured message. Sends stay serialized so batches arrive in
// order and can't trip Telegram's flood limits.
//
// Each watcher builds its own sink, so their bursts buffer independently and
// concurrent chains never interleave inside one message.
const BATCH_QUIET_MS = 1200; // a mint's lines land well inside this
const BATCH_MAX_LINES = 60; // flush early rather than let a long run grow unbounded

function createTelegramSink(bot: Telegraf<BotContext>, chatId: number): LogSink {
  let buffer: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  let queue: Promise<void> = Promise.resolve();

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const messages = renderBatch(buffer);
    buffer = [];

    queue = queue.then(async () => {
      for (const text of messages) {
        try {
          await bot.telegram.sendMessage(chatId, text);
        } catch {
          // best-effort — a dropped status message shouldn't affect a mint
        }
        await new Promise((r) => setTimeout(r, 350));
      }
    });
  };

  return (text: string) => {
    buffer.push(text);
    if (buffer.length >= BATCH_MAX_LINES) {
      flush();
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, BATCH_QUIET_MS);
    // Don't hold the process open just to deliver a status message.
    if (typeof timer.unref === "function") timer.unref();
  };
}

// Telegram's callback_data limit is 64 bytes; an address plus a slug exceeds
// it. Long payloads are stashed per chat and referenced by a short id, which
// keeps every button well under the cap no matter how long a slug is.
function makeTokenizer(session: SessionData) {
  return (payload: string): string => {
    session.cbTokens ??= {};
    // Reuse an existing id for the same payload so redrawing a menu doesn't
    // grow the registry without bound.
    for (const [id, value] of Object.entries(session.cbTokens)) {
      if (value === payload) return id;
    }
    session.cbSeq = (session.cbSeq ?? 0) + 1;
    const id = session.cbSeq.toString(36);
    session.cbTokens[id] = payload;

    const ids = Object.keys(session.cbTokens);
    if (ids.length > 300) delete session.cbTokens[ids[0]];
    return id;
  };
}

function resolveToken(session: SessionData, id: string): string | undefined {
  return session.cbTokens?.[id];
}

// Splits an "address|slug" payload back apart.
function resolvePair(session: SessionData, id: string): { address: string; slug: string } | null {
  const raw = resolveToken(session, id);
  if (!raw) return null;
  const idx = raw.indexOf("|");
  if (idx < 0) return null;
  return { address: raw.slice(0, idx), slug: raw.slice(idx + 1) };
}

export interface BotDeps {
  token: string;
  ownerId: number;
  store: TelegramStore;
}

export function createBot({ token, ownerId, store }: BotDeps): Telegraf<BotContext> {
  const bot = new Telegraf<BotContext>(token);

  // Without this, a throw inside any handler propagates out through
  // Telegraf's update loop and surfaces as "Failed to start" from the launch
  // promise — which reads like the bot died at boot when it's actually one
  // bad button press. Keep the bot alive and tell the user what broke.
  bot.catch(async (err: any, ctx) => {
    const detail = err?.description || err?.message || String(err);
    console.error(`Handler error on ${ctx.updateType}: ${detail}`);
    try {
      await ctx.reply(`⚠️ That action failed: ${detail}`);
    } catch {
      /* the chat may be unreachable; the log above is the fallback */
    }
  });

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

  // ── Portfolio, sectioned per wallet ──────────────────────────────────
  // Holdings come live from OpenSea rather than the mint store, so this
  // shows everything a wallet actually owns — including NFTs acquired
  // before this bot existed or bought elsewhere. The mint store stays the
  // source for "don't re-mint what we already have".
  bot.action("menu:portfolio", (ctx) => {
    const wallets = store.listWallets();
    if (wallets.length === 0) return ctx.answerCbQuery("Add a wallet first.", { show_alert: true });
    return ctx.editMessageText("🖼 Portfolio — pick a wallet:", portfolioWalletsMenu(wallets));
  });

  bot.action(/^pf:wallet:(.+)$/, async (ctx) => {
    const address = ctx.match[1];
    const wallet = store.listWallets().find((w) => w.address.toLowerCase() === address.toLowerCase());
    if (!wallet) return ctx.answerCbQuery("Unknown wallet.", { show_alert: true });
    await ctx.answerCbQuery("Loading holdings...");

    const settings = store.getSettings();
    const key = process.env.OPENSEA_API_KEY;

    // Chain first — balanceOf is authoritative, free, and works for drops
    // OpenSea has never indexed. OpenSea is then asked only for what it
    // alone knows (slugs/art/floors), and its absence degrades labels
    // rather than emptying the portfolio.
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const known = store
      .listMints()
      .filter((m) => m.chainKey === settings.chainKey)
      .map((m) => m.nftContract);
    const onChain = await fetchOnChainHoldings(urls[0], wallet.address, known, { withNames: true });

    // OpenSea can still surface collections this bot never minted.
    const viaOpenSea = await fetchAccountNfts(settings.chainKey, wallet.address, key);
    const openSeaCollections = groupByCollection(viaOpenSea);

    // Merge, preferring the on-chain count where both know a contract.
    const merged = new Map<string, { slug: string; count: number }>();
    for (const c of openSeaCollections) merged.set(c.contract.toLowerCase(), { slug: c.slug, count: c.count });
    for (const h of onChain) {
      const existing = merged.get(h.contract);
      const record = store.listMints().find((m) => m.nftContract.toLowerCase() === h.contract);
      merged.set(h.contract, {
        slug: existing?.slug ?? record?.slug ?? h.name ?? maskAddress(h.contract),
        count: h.balance,
      });
    }
    const collections = [...merged.values()].sort((a, b) => b.count - a.count);
    const total = collections.reduce((n, c) => n + c.count, 0);

    if (collections.length === 0) {
      // Say which of the two actually came back empty, instead of blaming
      // indexing for what may be a rejected API key or a wallet that in
      // fact holds nothing.
      const openSeaWorks = viaOpenSea.length > 0 || (await fetchStats("osborns", key)) !== null;
      return ctx.reply(
        `${wallet.label} holds nothing on ${settings.chainKey}.\n\n` +
          `Checked ${known.length} known collection(s) on-chain — all zero.` +
          (openSeaWorks ? "" : "\n\n⚠️ OpenSea also rejected the request, so anything minted outside this bot can't be listed. Check OPENSEA_API_KEY."),
        walletHoldingsMenu(wallet.address, [], makeTokenizer(ctx.session))
      );
    }

    const lines = collections
      .slice(0, 20)
      .map((c) => `• ${c.slug} ×${c.count}`)
      .join("\n");
    await ctx.reply(
      `🖼 ${wallet.label} (${maskAddress(wallet.address)}) on ${settings.chainKey}\n` +
        `${total} NFT(s) across ${collections.length} collection(s)` +
        (viaOpenSea.length === 0 && onChain.length > 0 ? "\n(read from chain — OpenSea unavailable)" : "") +
        `\n\n${lines}`,
      walletHoldingsMenu(wallet.address, collections, makeTokenizer(ctx.session))
    );
  });

  bot.action(/^pf:col:(.+)$/, async (ctx) => {
    const pair = resolvePair(ctx.session, ctx.match[1]);
    if (!pair) return ctx.answerCbQuery("That menu expired — reopen Portfolio.", { show_alert: true });
    const { address, slug } = pair;
    await ctx.answerCbQuery("Loading...");
    const key = process.env.OPENSEA_API_KEY;
    const [info, stats] = await Promise.all([fetchCollection(slug, key), fetchStats(slug, key)]);

    const caption =
      `${info?.name || slug}\n\n` +
      (stats
        ? `Floor: ${stats.floorPrice != null ? `${stats.floorPrice} ${stats.floorSymbol}` : "nothing listed"}\n` +
          `Owners: ${stats.owners} · Total sales: ${stats.totalSales}\n` +
          `24h: ${stats.oneDaySales} sales, ${stats.oneDayVolume.toFixed(6)} ${stats.floorSymbol}`
        : "Market data unavailable");

    const kb = walletCollectionMenu(address, slug, makeTokenizer(ctx.session), info?.openseaUrl);
    if (info?.imageUrl) {
      try {
        await ctx.replyWithPhoto(info.imageUrl, { caption, ...kb });
        return;
      } catch {
        /* fall through to text */
      }
    }
    await ctx.reply(caption, kb);
  });

  bot.action(/^pf:wactivity:(.+)$/, async (ctx) => {
    const address = ctx.match[1];
    const wallet = store.listWallets().find((w) => w.address.toLowerCase() === address.toLowerCase());
    await ctx.answerCbQuery("Fetching activity...");

    const events = await fetchAccountActivity(address, process.env.OPENSEA_API_KEY, 20);
    if (events.length === 0) return ctx.reply("No recent activity for this wallet.");

    const sales = events.filter((e) => e.type === "sale");
    const lines = events.slice(0, 15).map((e) => {
      const price = e.priceEth != null ? ` — ${e.priceEth} ETH` : "";
      const token = e.tokenId ? ` #${e.tokenId}` : "";
      return `• ${e.type}${token}${price}  (${toIST(new Date(e.timestamp * 1000))} IST)`;
    });
    await ctx.reply(
      `📈 ${wallet?.label || maskAddress(address)} — last ${events.length} events (${sales.length} sales)\n\n` +
        lines.join("\n")
    );
  });

  bot.action(/^pf:colact:(.+)$/, async (ctx) => {
    const slug = resolveToken(ctx.session, ctx.match[1]);
    if (!slug) return ctx.answerCbQuery("That menu expired — reopen Portfolio.", { show_alert: true });
    await ctx.answerCbQuery("Fetching activity...");
    const events = await fetchActivity(slug, process.env.OPENSEA_API_KEY, 15);
    if (events.length === 0) return ctx.reply("No recent activity for this collection.");
    const lines = events.slice(0, 12).map((e) => {
      const price = e.priceEth != null ? ` — ${e.priceEth} ETH` : "";
      return `• ${e.type}${e.tokenId ? ` #${e.tokenId}` : ""}${price}  (${toIST(new Date(e.timestamp * 1000))} IST)`;
    });
    await ctx.reply(`📈 ${slug}\n\n${lines.join("\n")}`);
  });

  // ── Legacy minted-only view, kept reachable for the mint store ────────
  bot.action("menu:mintlog", async (ctx) => {
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

  // ── Mint cards ───────────────────────────────────────────────────────
  bot.action(/^card:col:(.+)$/, async (ctx) => {
    const pair = resolvePair(ctx.session, ctx.match[1]);
    if (!pair) return ctx.answerCbQuery("That menu expired — reopen Portfolio.", { show_alert: true });

    const record = store
      .listMints()
      .find((m) => m.slug === pair.slug || m.nftContract.toLowerCase() === pair.slug.toLowerCase());
    if (!record) {
      return ctx.answerCbQuery("No mint on record for this collection — cards cover what this bot minted.", {
        show_alert: true,
      });
    }
    await ctx.answerCbQuery("Rendering…");
    const data = await buildCard(store, record.nftContract, "Auto Mint");
    if (!data) return ctx.reply("Couldn't assemble a card for that collection.");
    await sendCard(bot, ctx.chat!.id, data);
  });

  bot.action(/^card:hist:(.+)$/, async (ctx) => {
    const contract = resolveToken(ctx.session, ctx.match[1]);
    if (!contract) return ctx.answerCbQuery("That menu expired — reopen Copy Mint.", { show_alert: true });
    await ctx.answerCbQuery("Rendering…");
    const data = await buildCard(store, contract, "Copy Mint");
    if (!data) return ctx.reply("Couldn't assemble a card for that collection.");
    await sendCard(bot, ctx.chat!.id, data);
  });

  // ── Sell from a specific wallet's holdings ───────────────────────────
  bot.action(/^sell:col:(.+)$/, async (ctx) => {
    const pair = resolvePair(ctx.session, ctx.match[1]);
    if (!pair) return ctx.answerCbQuery("That menu expired — reopen Portfolio.", { show_alert: true });
    const { address, slug } = pair;
    await ctx.answerCbQuery("Checking offers...");
    const key = process.env.OPENSEA_API_KEY;
    const [offer, stats] = await Promise.all([fetchBestCollectionOffer(slug, key), fetchStats(slug, key)]);

    const floorText = stats?.floorPrice != null ? `${stats.floorPrice} ${stats.floorSymbol}` : "nothing listed";
    const offerText = offer
      ? `Best offer: ${offer.priceEth} ETH` +
        (stats?.floorPrice ? ` (${((offer.priceEth / stats.floorPrice) * 100).toFixed(0)}% of floor)` : "")
      : "No collection offers right now";

    await ctx.reply(
      `💵 ${slug}\n\n${offerText}\nFloor: ${floorText}\n\n` +
        "Accept sells to the best standing offer immediately.\n" +
        "List creates a signed listing at your price — no gas, no sale until someone buys.",
      sellCollectionMenu(address, slug, offer !== null, makeTokenizer(ctx.session))
    );
  });

  bot.action(/^sell:ask:(.+)$/, async (ctx) => {
    const pair = resolvePair(ctx.session, ctx.match[1]);
    if (!pair) return ctx.answerCbQuery("That menu expired — reopen Portfolio.", { show_alert: true });
    const { address, slug } = pair;
    const offer = await fetchBestCollectionOffer(slug, process.env.OPENSEA_API_KEY);
    if (!offer) return ctx.answerCbQuery("That offer is gone — refresh.", { show_alert: true });
    await ctx.answerCbQuery();
    return ctx.reply(
      `Sell 1 × ${slug} for ${offer.priceEth} ETH?\n\nThis transfers the NFT out and cannot be undone.`,
      sellActionConfirmMenu("accept", address, slug, makeTokenizer(ctx.session))
    );
  });

  bot.action(/^sell:list:(.+)$/, async (ctx) => {
    const pair = resolvePair(ctx.session, ctx.match[1]);
    if (!pair) return ctx.answerCbQuery("That menu expired — reopen Portfolio.", { show_alert: true });
    const { address, slug } = pair;
    ctx.session.step = "awaiting_list_price";
    ctx.session.sellWallet = address;
    ctx.session.sellSlug = slug;
    const stats = await fetchStats(slug, process.env.OPENSEA_API_KEY);
    await ctx.answerCbQuery();
    return ctx.reply(
      `Listing price in ETH for ${slug}?` +
        (stats?.floorPrice != null ? `\nCurrent floor: ${stats.floorPrice} ${stats.floorSymbol}` : "") +
        `\n\nSend a plain number (e.g. 0.05), or "floor" / "floor*1.2" to price off the floor.`
    );
  });

  bot.action(/^sell:go:([^:]+):(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const pair = resolvePair(ctx.session, ctx.match[2]);
    if (!pair) return ctx.answerCbQuery("That menu expired — reopen Portfolio.", { show_alert: true });
    const { address, slug } = pair;
    await ctx.answerCbQuery(action === "accept" ? "Selling..." : "Listing...");

    const settings = store.getSettings();
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const logger = withPrefix("sell", createLogger(createTelegramSink(bot, ctx.chat!.id)));
    const wallet = store.listWallets().find((w) => w.address.toLowerCase() === address.toLowerCase());
    if (!wallet) return ctx.reply("❌ Unknown wallet.");

    try {
      const walletKey = store.getDecryptedKey(wallet.address);

      if (action === "accept") {
        const result = await acceptOfferWithFallback(
          [
            () =>
              acceptOfferViaSdk({
                rpcUrl: urls[0],
                walletKey,
                chainKey: settings.chainKey,
                slug,
                apiKey: process.env.OPENSEA_API_KEY,
                maxFeePerGas: gweiToWei(settings.maxFeeGwei),
                maxPriorityFee: gweiToWei(settings.priorityGwei),
              }),
          ],
          logger
        );
        return ctx.reply(
          result.ok
            ? `✅ Sold via the ${result.usedPath} path.\n${result.txHash}`
            : `❌ Could not sell:\n${result.attempts.map((a) => `• ${a.path}: ${a.error}`).join("\n")}`
        );
      }

      const priceEth = ctx.session.sellPriceEth;
      if (!priceEth) return ctx.reply("That request expired — start again from Sell / offers.");
      ctx.session.sellPriceEth = undefined;

      const nfts = await fetchAccountNfts(settings.chainKey, wallet.address, process.env.OPENSEA_API_KEY);
      const owned = nfts.find((n) => n.collection === slug);
      if (!owned) return ctx.reply("❌ That wallet no longer holds anything in this collection.");

      const result = await createListing({
        rpcUrl: urls[0],
        walletKey,
        chainKey: settings.chainKey,
        tokenAddress: owned.contract,
        tokenId: owned.identifier,
        priceEth,
        apiKey: process.env.OPENSEA_API_KEY,
        logger,
      });
      return ctx.reply(
        result.ok
          ? `✅ Listed ${slug} #${owned.identifier} at ${priceEth} ETH.${result.orderHash ? `\n${result.orderHash}` : ""}`
          : `❌ Could not list: ${result.error}`
      );
    } catch (err: any) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ── Sell: view the best offer, then accept it via either path ────────
  bot.action(/^pf:sell:(.+)$/, async (ctx) => {
    const record = store.listMints().find((m) => m.nftContract.toLowerCase() === ctx.match[1].toLowerCase());
    if (!record?.slug) {
      return ctx.answerCbQuery("No OpenSea slug for this collection — selling unavailable.", { show_alert: true });
    }
    await ctx.answerCbQuery("Checking offers...");

    const key = process.env.OPENSEA_API_KEY;
    const [offer, stats] = await Promise.all([
      fetchBestCollectionOffer(record.slug, key),
      fetchStats(record.slug, key),
    ]);

    const floorText = stats?.floorPrice != null ? `${stats.floorPrice} ${stats.floorSymbol}` : "nothing listed";
    const body = offer
      ? `💵 ${record.name || record.slug}\n\n` +
        `Best collection offer: ${offer.priceEth} ETH\n` +
        `Floor: ${floorText}` +
        (stats?.floorPrice ? ` (offer is ${((offer.priceEth / stats.floorPrice) * 100).toFixed(0)}% of floor)` : "") +
        `\nHeld: ${record.quantity}\n\n` +
        "Accepting sells ONE token to the best standing offer. You'll be asked to confirm, " +
        "and to approve the transfer contract first if it isn't approved yet."
      : `💵 ${record.name || record.slug}\n\nNo collection offers right now.\nFloor: ${floorText}`;

    await ctx.reply(body, sellMenu(record.nftContract, offer !== null));
  });

  bot.action(/^sell:accept:(.+)$/, async (ctx) => {
    const record = store.listMints().find((m) => m.nftContract.toLowerCase() === ctx.match[1].toLowerCase());
    if (!record?.slug) return ctx.answerCbQuery("Not sellable.", { show_alert: true });
    const offer = await fetchBestCollectionOffer(record.slug, process.env.OPENSEA_API_KEY);
    if (!offer) return ctx.answerCbQuery("That offer is gone — refresh.", { show_alert: true });
    await ctx.answerCbQuery();
    return ctx.reply(
      `Sell 1 × ${record.name || record.slug} for ${offer.priceEth} ETH?\n\n` +
        "This transfers the NFT out of your wallet and cannot be undone.",
      sellConfirmMenu(record.nftContract)
    );
  });

  bot.action(/^sell:confirm:(.+)$/, async (ctx) => {
    const record = store.listMints().find((m) => m.nftContract.toLowerCase() === ctx.match[1].toLowerCase());
    if (!record?.slug) return ctx.answerCbQuery("Not sellable.", { show_alert: true });
    await ctx.answerCbQuery("Selling...");

    const settings = store.getSettings();
    const { urls } = resolveRpcsForChain(record.chainKey);
    const logger = withPrefix("sell", createLogger(createTelegramSink(bot, ctx.chat!.id)));

    // Sell from a wallet that actually minted this collection.
    const seller = store.listWallets().find((w) =>
      record.wallets.some((a) => a.toLowerCase() === w.address.toLowerCase())
    );
    if (!seller) return ctx.reply("❌ None of your current wallets hold this collection.");

    try {
      const walletKey = store.getDecryptedKey(seller.address);
      const result = await acceptOfferWithFallback(
        [
          () =>
            acceptOfferViaSdk({
              rpcUrl: urls[0],
              walletKey,
              chainKey: record.chainKey,
              slug: record.slug!,
              apiKey: process.env.OPENSEA_API_KEY,
              maxFeePerGas: gweiToWei(settings.maxFeeGwei),
              maxPriorityFee: gweiToWei(settings.priorityGwei),
            }),
        ],
        logger
      );

      if (result.ok) {
        await ctx.reply(`✅ Sold via the ${result.usedPath} path.\n${result.txHash}`);
      } else {
        const why = result.attempts.map((a) => `• ${a.path}: ${a.error}`).join("\n");
        await ctx.reply(`❌ Could not sell:\n${why}`);
      }
    } catch (err: any) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  bot.action(/^pf:remove:(.+)$/, (ctx) => {
    store.removeMint(ctx.match[1]);
    const mints = store.listMints();
    if (mints.length === 0) return ctx.editMessageText("Portfolio is empty.", mainMenu());
    return ctx.editMessageText(`🖼 Portfolio — ${mints.length} collection(s)`, portfolioMenu(mints));
  });

  // ── Activity alerts on held collections ──────────────────────────────
  // Collections are taken from what the wallets actually hold, not just what
  // this bot minted — so alerts cover NFTs acquired before or outside it.
  // Falls back to the mint store if the holdings lookup returns nothing.
  async function resolveWatchedCollections(): Promise<{ slug: string; name: string }[]> {
    const settings = store.getSettings();
    const key = process.env.OPENSEA_API_KEY;
    const seen = new Map<string, { slug: string; name: string }>();

    for (const w of store.listWallets()) {
      try {
        const nfts = await fetchAccountNfts(settings.chainKey, w.address, key, 3);
        for (const c of groupByCollection(nfts)) {
          if (!seen.has(c.slug)) seen.set(c.slug, { slug: c.slug, name: c.slug });
        }
      } catch {
        /* one unreadable wallet shouldn't blank the whole watchlist */
      }
    }
    for (const m of store.listMints()) {
      if (m.slug && !seen.has(m.slug)) seen.set(m.slug, { slug: m.slug, name: m.name || m.slug });
    }
    return [...seen.values()];
  }

  async function startActivity(chatId: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (runningActivity) return { ok: true };
    const collections = await resolveWatchedCollections();
    if (collections.length === 0) {
      return { ok: false, reason: "No collections held by your wallets to watch yet." };
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
      const result = await startActivity(ctx.chat!.id);
      if (!result.ok) return ctx.answerCbQuery(result.reason, { show_alert: true });
      await ctx.answerCbQuery("Started.");
    }
    return ctx.editMessageText(
      `🔔 Activity alerts: ${runningActivity ? "🟢 running" : "🔴 stopped"}`,
      activityMenu(runningActivity !== null, store.getSettings())
    );
  });

  // Default-on: starts itself as soon as there's anything to watch. Holdings
  // are fetched asynchronously, so this can't block bot startup — and a
  // failure just leaves alerts off rather than preventing the bot from running.
  //
  // Always reports the outcome. "Always on" that quietly failed to start
  // would be worse than being off, because it looks identical to working.
  if (store.getSettings().activityEnabled) {
    void startActivity(ownerId)
      .then((result) => {
        const text = result.ok
          ? `🔔 Activity alerts running — watching ${runningActivity ? "your holdings" : "nothing"} for sweeps, floor moves and offers.`
          : `🔕 Activity alerts are ON but could not start: ${result.reason}\nThey'll start once that's resolved, or use the menu.`;
        return bot.telegram.sendMessage(ownerId, text);
      })
      .catch((err: any) => {
        console.error(`Activity alerts failed to start: ${err?.message ?? err}`);
        bot.telegram
          .sendMessage(ownerId, `🔕 Activity alerts could not start: ${err?.message ?? err}`)
          .catch(() => {});
      });
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
  bot.action("wallet:seed:new", (ctx) => {
    ctx.session.step = "awaiting_seed_count";
    return ctx.reply(
      "How many wallets should I create from a new seed phrase? (1-50)\n\n" +
        "I'll show the phrase once. It is the ONLY backup — it restores every one of " +
        "these wallets in MetaMask, Rabby or Ledger, and anyone who reads it controls " +
        "all of them. Write it down offline, then delete my message."
    );
  });

  bot.action("wallet:seed:import", (ctx) => {
    ctx.session.step = "awaiting_seed_import";
    return ctx.reply(
      "Send your seed phrase, optionally followed by how many wallets to derive " +
        "(defaults to 5):\n\n" +
        "word1 word2 ... word12 5\n\n" +
        "Your message is deleted the instant I read it — but Telegram is not " +
        "end-to-end encrypted for bots, so only import a phrase you're happy to " +
        "dedicate to this bot."
    );
  });

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
      logChunkBlocks: logChunkBlocksFor(settings.chainKey),
      backfillBlocks: blocksForSeconds(settings.chainKey, settings.copyBackfillHours * 3600),
      onMinted: (o) => recordOutcome(store, settings.chainKey, o, { bot, chatId, source: "Copy Mint" }),
      onAttempt: (a) => {
        store.recordCopyAttempt({
          chainKey: settings.chainKey,
          sourceWallet: a.sourceWallet,
          sourceTxHash: a.sourceTxHash,
          nftContract: a.nftContract,
          quantity: a.quantity,
          outcome: a.outcome,
          reason: a.reason,
          txHashes: a.txHashes,
        });
      },
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

  // ── Copy-mint history ────────────────────────────────────────────────
  bot.action("copy:history", (ctx) => {
    const attempts = store.listCopyAttempts();
    if (attempts.length === 0) {
      return ctx.answerCbQuery(
        "No copy-mint attempts recorded yet. History starts from the first attempt after this update.",
        { show_alert: true }
      );
    }

    // Group by the watched wallet that triggered each copy.
    const byWallet = new Map<string, number>();
    for (const a of attempts) {
      byWallet.set(a.sourceWallet, (byWallet.get(a.sourceWallet) ?? 0) + 1);
    }
    const targets = store.listCopyTargets();
    const wallets = [...byWallet.entries()]
      .map(([address, count]) => ({
        address,
        // Prefer the label from the watchlist; fall back for wallets since removed.
        label: targets.find((t) => t.address.toLowerCase() === address.toLowerCase())?.label ?? maskAddress(address),
        count,
      }))
      .sort((a, b) => b.count - a.count);

    const totals = attempts.reduce(
      (acc, a) => ({ ...acc, [a.outcome]: (acc as any)[a.outcome] + 1 }),
      { success: 0, failed: 0, skipped: 0 } as Record<string, number>
    );

    return ctx.editMessageText(
      `📜 Copy-mint history — ${attempts.length} attempt(s)\n` +
        `✅ ${totals.success} copied · ❌ ${totals.failed} failed · ↷ ${totals.skipped} skipped\n\n` +
        "Pick a watched wallet to see what it led into:",
      copyHistoryMenu(wallets, makeTokenizer(ctx.session))
    );
  });

  bot.action("copy:hist:clear", (ctx) => {
    store.clearCopyHistory();
    return ctx.editMessageText("📜 Copy-mint history cleared.", copyMenu(runningCopy !== null, store.listCopyTargets()));
  });

  bot.action(/^copy:hist:(.+)$/, async (ctx) => {
    const address = resolveToken(ctx.session, ctx.match[1]);
    if (!address) return ctx.answerCbQuery("That menu expired — reopen Copy Mint.", { show_alert: true });

    const attempts = store.listCopyAttempts(address);
    if (attempts.length === 0) return ctx.answerCbQuery("Nothing recorded for that wallet.", { show_alert: true });

    const target = store.listCopyTargets().find((t) => t.address.toLowerCase() === address.toLowerCase());
    const icon = { success: "✅", failed: "❌", skipped: "↷" } as const;

    const lines = attempts.slice(0, 25).map((a) => {
      const when = toIST(new Date(a.at));
      const what = a.name || a.slug || maskAddress(a.nftContract);
      const qty = a.quantity > 0 ? ` ×${a.quantity}` : "";
      const why = a.reason ? ` — ${a.reason}` : "";
      return `${icon[a.outcome]} ${what}${qty}${why}\n    ${when} IST`;
    });

    const totals = attempts.reduce(
      (acc, a) => ({ ...acc, [a.outcome]: (acc as any)[a.outcome] + 1 }),
      { success: 0, failed: 0, skipped: 0 } as Record<string, number>
    );

    await ctx.answerCbQuery();
    return ctx.reply(
      `📜 ${target?.label ?? maskAddress(address)}\n` +
        `${address}\n\n` +
        `✅ ${totals.success} copied · ❌ ${totals.failed} failed · ↷ ${totals.skipped} skipped` +
        (attempts.length > 25 ? `\n(showing the latest 25 of ${attempts.length})` : "") +
        `\n\n${lines.join("\n")}`,
      copyHistoryWalletMenu(
        address,
        // Only successful copies get a card — there's nothing to celebrate
        // about a skip, and de-duped so one collection appears once.
        [
          ...new Map(
            attempts
              .filter((a) => a.outcome === "success")
              .map((a) => [
                a.nftContract.toLowerCase(),
                { nftContract: a.nftContract, label: a.name || a.slug || maskAddress(a.nftContract) },
              ])
          ).values(),
        ],
        makeTokenizer(ctx.session)
      )
    );
  });

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
        logChunkBlocks: logChunkBlocksFor(key),
        onMinted: (o) => recordOutcome(store, key, o, { bot, chatId, source: "Auto Mint" }),
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
    "copyBackfillHours",
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
      const hint = CLEARABLE.has(field)
        ? ' (or "clear" for unlimited)'
        : field === "gasLimit"
          ? ' (or "auto" to size it from the quantity — recommended)'
          : "";
      return ctx.reply(`Send the new value for ${field}${hint}:`);
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
      await recordOutcome(store, settings.chainKey, outcome, {
        bot,
        chatId: ctx.chat!.id,
        source: "Manual Mint",
      });
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
      await recordOutcome(store, settings.chainKey, outcome, {
        bot,
        chatId: ctx.chat!.id,
        source: "Scheduled Mint",
      });
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

    if (step === "awaiting_seed_count") {
      ctx.session.step = undefined;
      const count = parseInt(ctx.message.text.trim(), 10);
      if (!Number.isFinite(count) || count < 1 || count > 50) {
        return ctx.reply("Give me a number between 1 and 50.");
      }

      const phrase = generateMnemonic();
      const derived = deriveWallets(phrase, count);
      const added: string[] = [];
      let dupes = 0;
      for (const w of derived) {
        try {
          store.addWallet(`seed-${w.index}`, w.privateKey);
          added.push(w.address);
        } catch {
          dupes++; // deriving is deterministic, so re-importing hits this
        }
      }

      await ctx.reply(
        `✅ Created ${added.length} wallet(s)${dupes ? ` (${dupes} already existed)` : ""}. ` +
          "They mint on copy signals automatically.\n\n" +
          added.map((a, i) => `${i + 1}. ${a}`).join("\n")
      );
      // The phrase gets its own message so it can be deleted on its own,
      // without taking the address list with it.
      return ctx.reply(
        "🌱 SEED PHRASE — write this down offline, then DELETE this message:\n\n" +
          `${phrase}\n\n` +
          "I do not store it. It is the only way to restore these wallets, and anyone " +
          "who reads it can take everything in them.",
        mainMenu()
      );
    }

    if (step === "awaiting_seed_import") {
      ctx.session.step = undefined;
      const raw = ctx.message.text.trim();
      await ctx.deleteMessage(ctx.message.message_id).catch(() => {});

      // A trailing number is the wallet count; everything before it is the phrase.
      const parts = raw.split(/\s+/);
      const tail = Number(parts[parts.length - 1]);
      const hasCount = Number.isFinite(tail) && tail > 0;
      const count = hasCount ? Math.min(50, Math.floor(tail)) : 5;
      const phrase = (hasCount ? parts.slice(0, -1) : parts).join(" ");

      if (!isValidMnemonic(phrase)) {
        return ctx.reply("❌ That isn't a valid BIP-39 seed phrase. Check for a typo or a missing word.");
      }

      const added: string[] = [];
      let dupes = 0;
      for (const w of deriveWallets(phrase, count)) {
        try {
          store.addWallet(`seed-${w.index}`, w.privateKey);
          added.push(w.address);
        } catch {
          dupes++;
        }
      }
      return ctx.reply(
        `✅ Imported ${added.length} wallet(s)${dupes ? ` (${dupes} already added)` : ""}.\n\n` +
          added.map((a, i) => `${i + 1}. ${a}`).join("\n") +
          "\n\nThey mint on copy signals automatically. Fund them before the next drop.",
        mainMenu()
      );
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

    if (step === "awaiting_list_price") {
      ctx.session.step = undefined;
      const slug = ctx.session.sellSlug;
      const address = ctx.session.sellWallet;
      if (!slug || !address) return ctx.reply("That request expired — start again from Sell / offers.");

      const raw = ctx.message.text.trim().toLowerCase();
      let priceEth: number | null = null;

      // Both pricing bases, per the choice made when this was designed:
      // an absolute figure, or one derived from the live floor.
      const floorExpr = /^floor(?:\s*\*\s*([0-9.]+))?$/.exec(raw);
      if (floorExpr) {
        const stats = await fetchStats(slug, process.env.OPENSEA_API_KEY);
        if (stats?.floorPrice == null) {
          return ctx.reply("That collection has no floor right now — give an absolute ETH amount instead.");
        }
        priceEth = stats.floorPrice * (floorExpr[1] ? Number(floorExpr[1]) : 1);
      } else {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) priceEth = n;
      }

      if (priceEth === null || !Number.isFinite(priceEth) || priceEth <= 0) {
        return ctx.reply('Not a valid price. Send a number like 0.05, or "floor" / "floor*1.2".');
      }

      ctx.session.sellPriceEth = priceEth;
      return ctx.reply(
        `List 1 × ${slug} at ${priceEth} ETH?\n\n` +
          "Listing costs no gas and moves nothing now — it publishes a signed offer to sell. " +
          "You'll be asked to approve the transfer contract if it isn't approved yet.",
        sellActionConfirmMenu("list", address, slug, makeTokenizer(ctx.session))
      );
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

      // "auto" on the gas limit means size it from the quantity being minted,
      // which is stored as 0. A fixed limit both over-reserves for a small
      // mint and runs out of gas on a large one.
      if (field === "gasLimit" && raw.toLowerCase() === "auto") {
        store.updateSettings({ gasLimit: 0 });
        return ctx.reply(
          "✅ Gas limit is now sized automatically from the quantity being minted.",
          settingsMenu(store.getSettings())
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
