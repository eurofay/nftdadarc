// Telegram control surface for the mint sniper. Wraps the same tested engine
// the CLI uses (buildLocalMintPlan / localPublicSnipe / runAutoMintWatcher /
// runCopyMintWatcher) — this file is UI and wiring, not mint logic.
//
// Access is restricted to one Telegram user id (TELEGRAM_OWNER_ID) in private
// chat only; every other update is silently ignored.

import { Telegraf, Markup, Context, Telegram } from "telegraf";
import { message } from "telegraf/filters";
import { isAddress, formatEther, parseEther, Wallet } from "ethers";
import { generateMnemonic, deriveWallets, isValidMnemonic } from "../hd-wallet";
import { createProvider, describeRpcError } from "../rpc-provider";
import { TelegramStore, WalletRecord, ScheduledMint, BotSettings } from "./store";
import { UserStores } from "./user-stores";
import { ask, BotSnapshot } from "./agent";
import { AccessControl } from "./access-control";
import {
  mainMenu,
  seedsMenu,
  seedDetailMenu,
  adminMenu,
  adminRevokeConfirmMenu,
  restoreConfirmMenu,
  allowlistConfirmMenu,
  fcfsMenu,
  fcfsArmMenu,
  fcfsViewMenu,
  quickWalletsMenu,
  quickConfirmMenu,
  osMintStagesMenu,
  adminInvitesMenu,
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
  consolidateSourcesMenu,
  consolidateDestMenu,
  consolidateConfirmMenu,
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
import { resolveSlug, openseaContractInfo, lookupContract, isLookupFailure } from "../slug-resolver";
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
import { resolveFeeRecipient, buildLocalMintPlan, LocalMintPlan } from "../seadrop-public";
import { localPublicSnipe } from "../local-mint";
import { runAutoMintWatcher } from "../auto-mint";
import { runCopyMintWatcher } from "../copy-mint";
import { runActivityWatcher } from "../activity-watcher";
import { batchTransfer, estimateBatchCost } from "../fund-transfer";
import {
  ScanResult,
  scanHoldings,
  holders,
  buildPlan,
  consolidate,
  estimateConsolidationCost,
  summarise as summariseConsolidation,
} from "../nft-consolidate";
import { fetchOnChainHoldings } from "../nft-holdings";
import { MintCardData } from "../mint-card";
import { gasLimitForQuantity, upfrontReservation } from "../gas";
import { raceRead, raceReadOrNull, readableRpcs, tryInOrder } from "../fast-read";
import { readStages, describeStages, checkEligibility, describeEligibility } from "../seadrop-stages";
import { openSeaAuthFailure } from "../opensea-market";
import { stageWindow, assessWallet } from "../mint-readiness";
import { resolveMaxFee, marketFee } from "../gas-fit";
import { OpenSeaMintClient, OpenSeaMintError } from "../opensea-mint";
import {
  fetchAllowListRoot,
  checkAllowListProof,
  parseAllowListInput,
  encodeMintAllowList,
  MintParams,
} from "../seadrop-allowlist";
import { findAllowListUri, fetchAllowList, parseAllowList, deriveProof } from "../allowlist-fetch";
import { renderMintCardPng, renderPnlCardPng } from "../mint-card-render";
import { computePnl, renderPnl, PnlReport } from "../pnl";
import { registerWalletFilter } from "./wallet-filter-flow";
import { acceptOfferViaSdk, acceptOfferWithFallback, createListing, parseListingPrice } from "../opensea-sell";
import { createLogger, withPrefix, LogSink } from "../logger";
import { istTimeToDate, toIST } from "../time-format";
import { renderBatch, chunkMessage } from "./format";
import { measureLatency, renderLatency, probeCapability } from "../rpc-latency";

interface SessionData {
  step?:
    | "awaiting_wallet_key"
    | "awaiting_seed_count"
    | "awaiting_seed_import"
    | "awaiting_restore_file"
    | "awaiting_allowlist_json"
    | "awaiting_quick_target"
    | "awaiting_quick_quantity"
    | "awaiting_osmint_target"
    | "awaiting_agent_question"
    | "awaiting_copy_target"
    | "awaiting_fund_amount"
    | "awaiting_consolidate_contract"
    | "awaiting_pnl_contract"
    | "awaiting_find_contract"
    | "awaiting_wallet_label"
    | "awaiting_copy_label"
    | "awaiting_sched_link"
    | "awaiting_sched_quantity"
    | "awaiting_sched_custom_time"
    | "awaiting_list_price"
    | `awaiting_setting:${string}`;
  fundSource?: string;
  fundTargets?: string[]; // lowercased addresses
  fundAmountWei?: string; // bigint as string — kept out of the type so session stays plain-JSON-shaped
  consolidate?: {
    contract: string;
    /** The scan, held across source picking, destination picking and confirm. */
    found?: { owner: string; label: string; tokenIds: string[] }[];
    selected?: string[]; // lowercased owner addresses
    destination?: string;
  };
  schedContract?: string;
  schedWallets?: string[]; // lowercased addresses
  schedQuantity?: number;
  schedDropMax?: number;
  schedStartTime?: number; // on-chain drop start, unix seconds
  schedTargetStartMs?: number | "now"; // chosen fire time, pending confirmation
  cbTokens?: Record<string, string>;
  cbSeq?: number;
  renameWallet?: string;
  renameCopyTarget?: string;
  sellWallet?: string;
  sellSlug?: string;
  sellPriceEth?: number;
  pendingRestore?: string;
  allowlistContract?: string;
  osmint?: {
    contract: string;
    slug: string;
    name?: string;
    rows: { wallet: string; label: string; stageType: string; canMint: number; reason?: string }[];
  };
  quick?: {
    contract: string;
    name?: string;
    slug?: string;
    priceWei: string;
    maxPerWallet: number;
    ready: { address: string; label: string; canMint: number; reason?: string }[];
    chosen: string[];
    quantity?: number;
  };
  allowlistReady?: { contract: string; wallets: string[]; params: string; proof: string[]; quantity: number }; // snapshot JSON held between upload and confirm
}
interface BotContext extends Context {
  session: SessionData;
  /** This user's store, resolved per update. Never shared between users. */
  store: TelegramStore;
}

interface RunningWatcher {
  stopSignal: { stopped: boolean };
  promise: Promise<void>;
}

// Telegram rate-limits edits to a message. A walk finishes a batch roughly
// twice a second, and editing that often would trip the limit long before the
// scan did. Slow enough to stay well inside it, quick enough to look alive.
const PROGRESS_EDIT_MS = 4_000;

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

// Takes any object carrying a Telegram client rather than the Telegraf
// instance itself, so the optional alerts bot can drive the same sink without
// a second copy of the batching logic.
function createTelegramSink(bot: { telegram: Telegram }, chatId: number): LogSink {
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

/**
 * Which store, if any, an update may touch.
 *
 * Extracted from the middleware so the rule can be tested directly: this is
 * the boundary that keeps one user out of another's wallets, and it is worth
 * far more coverage than mocking Telegraf's update plumbing would buy.
 */
export function resolveAccess(
  chatType: string | undefined,
  userId: number | undefined,
  stores: UserStores
): { allowed: false; reason: string } | { allowed: true; store: TelegramStore } {
  // Group chats are refused outright: everyone in one would otherwise share
  // whichever member's store resolved first.
  if (chatType !== "private") return { allowed: false, reason: "not a private chat" };
  if (!userId) return { allowed: false, reason: "no user id on the update" };
  try {
    return { allowed: true, store: stores.for(userId) };
  } catch {
    return { allowed: false, reason: "unusable user id" };
  }
}

// Shown to someone who has never been through the door. Says what the bot
// does, and what they're taking on by putting a key into it, BEFORE asking
// for anything — nobody should hand over a wallet to a bot that hasn't
// explained itself.
export const INTRO_MESSAGE = [
  "*Snake Minter*",
  "",
  "It watches wallets that mint NFTs, and mints the same drop with your wallets, seconds later — automatically, while you're asleep.",
  "",
  "*What it does*",
  "• Follows any wallets you choose and copies their mints",
  "• Mints the maximum each drop allows per wallet",
  "• Sizes gas from the real cost, so nothing is wasted",
  "• Sends you a card for every mint, with floor price and offers",
  "• Lets you list or accept offers on what you minted",
  "",
  "*Before you start*",
  "Your wallets are yours alone — nobody else using this bot can see them. But you add a wallet by pasting its private key into this chat, and Telegram is not end-to-end encrypted for bots. I delete the message immediately; it still passed through Telegram's servers.",
  "",
  "So: use a wallet made *for this bot*, funded with only what you'd shrug off losing. Never your main wallet.",
].join("\n");

export interface BotDeps {
  token: string;
  /** Retains admin powers; everyone else gets their own isolated store. */
  ownerId: number;
  stores: UserStores;
  access: AccessControl;
  /**
   * Optional second bot that activity alerts are sent through instead.
   *
   * Same store, same watcher, different chat -- a feed of sale and floor
   * alerts in the same thread as the menus buries the menus.
   */
  alerts?: { telegram: Telegram; username?: string } | null;
}

export function createBot({ token, ownerId, stores, access, alerts }: BotDeps): Telegraf<BotContext> {
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

  // Telegram rejects an edit whose text AND markup are byte-identical to what
  // is already on screen, with "message is not modified". That is a normal
  // thing to do — tapping Back to a menu already shown, or a toggle that
  // re-renders the same state — and it surfaced to the user as a scary
  // "That action failed" from bot.catch. Swallow exactly that one error and
  // let every other edit failure through.
  bot.use((ctx, next) => {
    const original = ctx.editMessageText.bind(ctx);
    ctx.editMessageText = (async (...args: Parameters<typeof original>) => {
      try {
        return await original(...args);
      } catch (err: any) {
        if (String(err?.description ?? err?.message ?? "").includes("message is not modified")) {
          // Nothing changed, so there is nothing to report — the screen
          // already shows what the user asked for.
          return true as any;
        }
        throw err;
      }
    }) as typeof ctx.editMessageText;
    return next();
  });

  // ── Access control and store binding ──────────────────────────────────
  // Private chats only, and every update is bound to the sender's OWN store
  // before any handler runs. Handlers reach data exclusively through
  // ctx.store, so there is no shared store object one user could read
  // another user's wallets out of.
  bot.use((ctx, next) => {
    const resolved = resolveAccess(ctx.chat?.type, ctx.from?.id, stores);
    if (!resolved.allowed) return;
    ctx.store = resolved.store;
    return next();
  });

  // ── The invite gate ───────────────────────────────────────────────────
  // Anyone can find this bot, so the bot is the door. The owner is never
  // gated: a bot holding real keys must not be lockable by its own door.
  bot.use(async (ctx, next) => {
    const userId = ctx.from!.id;
    if (userId === ownerId) return next();
    if (access.hasAccess(userId)) return next();

    if (!access.isConfigured()) {
      return ctx.reply("This bot isn't open yet — the owner hasn't issued any invites.");
    }

    const text = (ctx.message as any)?.text?.trim();

    // No code yet: explain what this is before asking them for anything.
    if (!text || text === "/start") {
      await ctx.reply(INTRO_MESSAGE, { parse_mode: "Markdown" });
      return ctx.reply("🎟 Send your invite code to continue.");
    }

    // A code is a bearer token — don't leave it sitting in the chat.
    await ctx.deleteMessage(ctx.message!.message_id).catch(() => {});

    const result = access.redeem(userId, text);
    if (!result.ok) {
      if (result.reason === "locked") {
        return ctx.reply(`Too many attempts. Try again in ${Math.ceil((result.waitMs ?? 0) / 60000)} minute(s).`);
      }
      if (result.reason === "already-used") {
        return ctx.reply("That code has already been used by someone else. Ask the owner for your own.");
      }
      if (result.reason === "revoked") {
        return ctx.reply("That code has been revoked. Ask the owner for a new one.");
      }
      const locked = access.recordFailure(userId);
      return ctx.reply(
        locked > 0
          ? `❌ Invalid code. Locked for ${Math.ceil(locked / 60000)} minute(s).`
          : "❌ Invalid code."
      );
    }

    return ctx.reply(
      "✅ You're in.\n\n" +
        "Start by adding a wallet, then choose wallets to copy. Nothing mints until you turn Copy Mint on.",
      menuFor(ctx)
    );
  });

  // Watchers are per user: each person's wallets mint on their own signals,
  // so one user stopping a watcher must never stop anyone else's.
  const runningAutoByUser = new Map<number, Map<string, RunningWatcher>>();
  const runningCopy = new Map<number, RunningWatcher>();
  const runningActivity = new Map<number, RunningWatcher>();
  // Resolved once for the boot-time "always on" restarts below, which run
  // outside any update and so have no ctx to hang a store off.
  const ownerStore = stores.for(ownerId);
  // The admin row exists only for the owner; nobody else learns it's there.
  const menuFor = (ctx: BotContext) => mainMenu(ctx.from?.id === ownerId);

  const runningAutoFor = (userId: number): Map<string, RunningWatcher> => {
    let m = runningAutoByUser.get(userId);
    if (!m) runningAutoByUser.set(userId, (m = new Map()));
    return m;
  };

  // ── Menu navigation ──────────────────────────────────────────────────
  bot.start((ctx) => ctx.reply("NFT Public Mint Sniper — choose an action:", menuFor(ctx)));
  bot.action("menu:main", (ctx) => ctx.editMessageText("Choose an action:", menuFor(ctx)));

  bot.action("menu:wallets", (ctx) =>
    ctx.editMessageText("Wallets — tap one to manage it. [🎯 Auto] [👀 Copy]:", walletsMenu(ctx.store.listWallets()))
  );

  bot.action("menu:settings", (ctx) =>
    ctx.editMessageText("Settings (tap to change):", settingsMenu(ctx.store.getSettings()))
  );

  bot.action("menu:auto", (ctx) =>
    ctx.editMessageText(
      `Auto free-mint watcher: ${runningAutoFor(ctx.from!.id).size > 0 ? `🟢 running on ${[...runningAutoFor(ctx.from!.id).keys()].join(", ")}` : "🔴 stopped"}\n` +
        `Wallets enabled: ${ctx.store.listWalletsFor("auto").length}/${ctx.store.listWallets().length} (toggle per wallet in Wallets)\n` +
        "Detects any SeaDrop drop going live at price 0 and mints the max per wallet — no confirmation. " +
        "Runs on one or more chains at once — set which ones in Settings → Auto-mint chains.",
      autoMenu(runningAutoFor(ctx.from!.id).size > 0)
    )
  );

  bot.action("menu:copy", (ctx) =>
    ctx.editMessageText(
      `Copy-mint watcher: ${runningCopy.has(ctx.from!.id) ? "🟢 running" : "🔴 stopped"}\n` +
        `Wallets enabled: ${ctx.store.listWalletsFor("copy").length}/${ctx.store.listWallets().length} (toggle per wallet in Wallets)\n` +
        "Copies any mintPublic call from a watched wallet, using your own wallets.",
      copyMenu(runningCopy.has(ctx.from!.id), ctx.store.listCopyTargets())
    )
  );

  bot.action("menu:fund", (ctx) => {
    const wallets = ctx.store.listWallets();
    if (wallets.length < 2) {
      return ctx.answerCbQuery("Add at least two wallets first — one to send from, one to receive.", {
        show_alert: true,
      });
    }
    ctx.session.fundSource = undefined;
    ctx.session.fundTargets = undefined;
    return ctx.editMessageText("Send FROM which wallet?", fundSourceMenu(wallets));
  });

  // The wallet filter lives on the companion bot when there is one, since a
  // filter run is a stream of progress edits and a CSV — exactly the traffic
  // that buries a menu. With no companion configured it mounts here instead:
  // a feature that disappears unless you set an optional environment variable
  // is worse than one in a slightly noisy thread.
  if (alerts) {
    bot.action("menu:filter", (ctx) => {
      // A tappable link, not an instruction to go and find the other chat.
      // ?start=filter lands on "upload your file" rather than a welcome.
      const link = alerts.username
        ? Markup.inlineKeyboard([
            [Markup.button.url("🧮 Open Wallet Filter", `https://t.me/${alerts.username}?start=filter`)],
            [Markup.button.callback("⬅ Back", "menu:main")],
          ])
        : mainMenu(ctx.from?.id === ownerId);
      return ctx.editMessageText(
        "🧮 *Wallet filter*\n\n" +
          "It lives on your alerts bot — a filter run is a long stream of progress and a CSV at " +
          "the end, which would bury these menus.\n\n" +
          (alerts.username
            ? "Tap below to open it there."
            : "Open that bot and send /filter. (I couldn't read its username to link it directly.)"),
        { parse_mode: "Markdown", ...link }
      );
    });
  } else {
    registerWalletFilter(bot, { ownerId, stores });
  }

  // ── P&L ──────────────────────────────────────────────────────────────
  // One collection, every wallet, one number. Minting across nine wallets
  // means nine separate answers to "did that work out", and adding them up
  // by hand is how a losing position goes unnoticed.
  bot.action("menu:pnl", (ctx) => {
    if (ctx.store.listWallets().length === 0) {
      return ctx.answerCbQuery("Add a wallet first.", { show_alert: true });
    }
    ctx.session.step = "awaiting_pnl_contract";
    return ctx.editMessageText(
      "📊 *P&L for a collection*\n\n" +
        "Send the contract address or OpenSea link.\n\n" +
        "I'll count what every wallet holds on-chain, price it against the floor and the " +
        "best standing offer, and show what it cost against what it's worth.",
      { parse_mode: "Markdown" }
    );
  });

  // ── Find an NFT ──────────────────────────────────────────────────────
  // Paste a contract, get straight to the actions for it.
  //
  // Everything the answer needs already exists: scanHoldings reads the chain,
  // and the sell/list handlers below are keyed by (wallet, slug). So this is
  // mostly a lookup that hands off, rather than a second copy of either.
  bot.action("menu:find", (ctx) => {
    if (ctx.store.listWallets().length === 0) {
      return ctx.answerCbQuery("Add a wallet first.", { show_alert: true });
    }
    ctx.session.step = "awaiting_find_contract";
    return ctx.editMessageText(
      "🔎 *Find an NFT you hold*\n\n" +
        "Paste the contract address or OpenSea link.\n\n" +
        "I'll find which of your wallets hold it, then show the floor, any standing offer, " +
        "and what you can do about it.",
      { parse_mode: "Markdown" }
    );
  });

  // ── Consolidate ──────────────────────────────────────────────────────
  // Minting from many wallets is the point; owning from many wallets is not.
  // Paste a contract, see which of your wallets hold it, pick the ones to
  // empty and the one to fill. Holdings are read straight off the chain, so
  // this works on collections no marketplace has indexed yet.
  bot.action("menu:consolidate", (ctx) => {
    const wallets = ctx.store.listWallets();
    if (wallets.length < 2) {
      return ctx.answerCbQuery("Add at least two wallets first — one to gather from, one to gather into.", {
        show_alert: true,
      });
    }
    ctx.session.consolidate = undefined;
    ctx.session.step = "awaiting_consolidate_contract";
    return ctx.editMessageText(
      "📦 *Consolidate a collection*\n\n" +
        "Send the contract address or OpenSea link of the collection you want swept up.\n\n" +
        `I'll check all ${wallets.length} of your wallets, show you which ones hold it, ` +
        "and let you pick what to move and where.",
      { parse_mode: "Markdown" }
    );
  });

  /** The source picker, redrawn after every toggle. */
  function consolidateSourcesView(ctx: BotContext) {
    const pending = ctx.session.consolidate!;
    const selected = new Set(pending.selected ?? []);
    const rows = (pending.found ?? []).map((h) => ({
      address: h.owner,
      label: h.label,
      count: h.tokenIds.length,
    }));
    const total = rows.filter((r) => selected.has(r.address.toLowerCase())).reduce((s, r) => s + r.count, 0);
    const text =
      `📦 Found *${rows.reduce((s, r) => s + r.count, 0)}* NFT(s) across *${rows.length}* wallet(s).\n\n` +
      "Tap to choose which wallets to sweep, then Done." +
      (total === 0 ? "\n\n_Nothing selected yet._" : "");
    return { text, keyboard: consolidateSourcesMenu(rows, selected) };
  }

  bot.action(/^consol:src:toggle:(.+)$/, (ctx) => {
    const pending = ctx.session.consolidate;
    if (!pending?.found) {
      return ctx.answerCbQuery("That request expired — start over from Consolidate.", { show_alert: true });
    }
    const address = ctx.match[1].toLowerCase();
    const selected = new Set(pending.selected ?? []);
    if (selected.has(address)) selected.delete(address);
    else selected.add(address);
    pending.selected = [...selected];
    const view = consolidateSourcesView(ctx);
    return ctx.editMessageText(view.text, { parse_mode: "Markdown", ...view.keyboard });
  });

  bot.action("consol:src:all", (ctx) => {
    const pending = ctx.session.consolidate;
    if (!pending?.found) {
      return ctx.answerCbQuery("That request expired — start over from Consolidate.", { show_alert: true });
    }
    const all = pending.found.map((h) => h.owner.toLowerCase());
    // Toggles both ways, so the same button clears a full selection.
    pending.selected = (pending.selected?.length ?? 0) === all.length ? [] : all;
    const view = consolidateSourcesView(ctx);
    return ctx.editMessageText(view.text, { parse_mode: "Markdown", ...view.keyboard });
  });

  bot.action("consol:src:done", (ctx) => {
    const pending = ctx.session.consolidate;
    if (!pending?.found) {
      return ctx.answerCbQuery("That request expired — start over from Consolidate.", { show_alert: true });
    }
    if (!pending.selected?.length) {
      return ctx.answerCbQuery("Select at least one wallet to sweep from.", { show_alert: true });
    }
    return ctx.editMessageText(
      "Sweep them into which wallet?\n\n" +
        "Picking one of the selected wallets is fine — it keeps what it already holds.",
      consolidateDestMenu(ctx.store.listWallets())
    );
  });

  bot.action(/^consol:dest:(.+)$/, async (ctx) => {
    const pending = ctx.session.consolidate;
    if (!pending?.found || !pending.selected?.length) {
      return ctx.answerCbQuery("That request expired — start over from Consolidate.", { show_alert: true });
    }
    const destination = ctx.match[1];
    pending.destination = destination;
    await ctx.answerCbQuery();

    const settings = ctx.store.getSettings();
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const plan = buildPlan(
      {
        contract: pending.contract,
        tokens: pending.found.flatMap((h) => h.tokenIds.map((id) => ({ owner: h.owner, tokenId: BigInt(id) }))),
        skipped: [],
      },
      pending.selected,
      destination
    );

    const labelFor = (addr: string) =>
      ctx.store.listWallets().find((w) => w.address.toLowerCase() === addr.toLowerCase())?.label ?? maskAddress(addr);

    if (plan.tokens.length === 0) {
      ctx.session.consolidate = undefined;
      return ctx.editMessageText(
        `Nothing to move — ${labelFor(destination)} was the only wallet selected, and it already holds them.`,
        mainMenu(ctx.from?.id === ownerId)
      );
    }

    const ceiling = await resolveFeeCeiling(settings, urls);
    const worstCase = estimateConsolidationCost(plan.tokens.length, ceiling);
    const chain = resolveChain(settings.chainKey)!;
    const bySender = new Map<string, number>();
    for (const t of plan.tokens) bySender.set(t.owner, (bySender.get(t.owner) ?? 0) + 1);

    const lines = [
      `Move *${plan.tokens.length}* NFT(s) into *${labelFor(destination)}*?`,
      "",
      ...[...bySender].map(([owner, count]) => `• ${labelFor(owner)} → ${count}`),
      "",
      `Worst-case gas across all of them: ${formatEther(worstCase)} ${chain.nativeSymbol}, paid by each sending wallet.`,
    ];

    return ctx.editMessageText(lines.join("\n"), {
      parse_mode: "Markdown",
      ...consolidateConfirmMenu(),
    });
  });

  bot.action("consol:cancel", (ctx) => {
    ctx.session.consolidate = undefined;
    ctx.session.step = undefined;
    return ctx.editMessageText("Cancelled. Nothing was moved.", mainMenu(ctx.from?.id === ownerId));
  });

  bot.action("consol:confirm", async (ctx) => {
    const pending = ctx.session.consolidate;
    if (!pending?.found || !pending.selected?.length || !pending.destination) {
      return ctx.answerCbQuery("That request expired — start over from Consolidate.", { show_alert: true });
    }
    const destination = pending.destination;
    // Built from the same scan the preview was built from, so what runs is
    // what was confirmed — no second read of the chain in between.
    const plan = buildPlan(
      {
        contract: pending.contract,
        tokens: pending.found.flatMap((h) => h.tokenIds.map((id) => ({ owner: h.owner, tokenId: BigInt(id) }))),
        skipped: [],
      },
      pending.selected,
      destination
    );
    ctx.session.consolidate = undefined;
    ctx.session.step = undefined;
    await ctx.answerCbQuery("Moving…");
    await ctx.editMessageText("Moving — status below.");

    const settings = ctx.store.getSettings();
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const logger = createLogger(createTelegramSink(bot, ctx.chat!.id));
    const store = ctx.store;

    try {
      const results = await consolidate({
        rpcUrl: urls[0],
        plan,
        keyFor: (owner) => store.getDecryptedKey(owner),
        maxFeePerGas: await resolveFeeCeiling(settings, urls),
        maxPriorityFee: gweiToWei(settings.priorityGwei),
        logger,
      });
      await ctx.reply(summariseConsolidation(results, destination), mainMenu(ctx.from?.id === ownerId));
    } catch (err: any) {
      logger.errorBold(`Consolidation failed: ${err?.message ?? err}`);
    }
  });

  // ── Portfolio, sectioned per wallet ──────────────────────────────────
  // Holdings come live from OpenSea rather than the mint store, so this
  // shows everything a wallet actually owns — including NFTs acquired
  // before this bot existed or bought elsewhere. The mint store stays the
  // source for "don't re-mint what we already have".
  bot.action("menu:portfolio", (ctx) => {
    const wallets = ctx.store.listWallets();
    if (wallets.length === 0) return ctx.answerCbQuery("Add a wallet first.", { show_alert: true });
    return ctx.editMessageText("🖼 Portfolio — pick a wallet:", portfolioWalletsMenu(wallets));
  });

  bot.action(/^pf:wallet:(.+)$/, async (ctx) => {
    const address = ctx.match[1];
    const wallet = ctx.store.listWallets().find((w) => w.address.toLowerCase() === address.toLowerCase());
    if (!wallet) return ctx.answerCbQuery("Unknown wallet.", { show_alert: true });
    await ctx.answerCbQuery("Loading holdings...");

    const settings = ctx.store.getSettings();
    const key = process.env.OPENSEA_API_KEY;

    // Chain first — balanceOf is authoritative, free, and works for drops
    // OpenSea has never indexed. OpenSea is then asked only for what it
    // alone knows (slugs/art/floors), and its absence degrades labels
    // rather than emptying the portfolio.
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const known = ctx.store
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
      const record = ctx.store.listMints().find((m) => m.nftContract.toLowerCase() === h.contract);
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
    const wallet = ctx.store.listWallets().find((w) => w.address.toLowerCase() === address.toLowerCase());
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
    const mints = ctx.store.listMints();
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
    const record = ctx.store.listMints().find((m) => m.nftContract.toLowerCase() === ctx.match[1].toLowerCase());
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
    const record = ctx.store.listMints().find((m) => m.nftContract.toLowerCase() === ctx.match[1].toLowerCase());
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

    const record = ctx.store
      .listMints()
      .find((m) => m.slug === pair.slug || m.nftContract.toLowerCase() === pair.slug.toLowerCase());
    if (!record) {
      return ctx.answerCbQuery("No mint on record for this collection — cards cover what this bot minted.", {
        show_alert: true,
      });
    }
    await ctx.answerCbQuery("Rendering…");
    const data = await buildCard(ctx.store, record.nftContract, "Auto Mint");
    if (!data) return ctx.reply("Couldn't assemble a card for that collection.");
    await sendCard(bot, ctx.chat!.id, data);
  });

  bot.action(/^card:hist:(.+)$/, async (ctx) => {
    const contract = resolveToken(ctx.session, ctx.match[1]);
    if (!contract) return ctx.answerCbQuery("That menu expired — reopen Copy Mint.", { show_alert: true });
    await ctx.answerCbQuery("Rendering…");
    const data = await buildCard(ctx.store, contract, "Copy Mint");
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

    const settings = ctx.store.getSettings();
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const logger = withPrefix("sell", createLogger(createTelegramSink(bot, ctx.chat!.id)));
    const wallet = ctx.store.listWallets().find((w) => w.address.toLowerCase() === address.toLowerCase());
    if (!wallet) return ctx.reply("❌ Unknown wallet.");

    try {
      const walletKey = ctx.store.getDecryptedKey(wallet.address);

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
    const record = ctx.store.listMints().find((m) => m.nftContract.toLowerCase() === ctx.match[1].toLowerCase());
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
    const record = ctx.store.listMints().find((m) => m.nftContract.toLowerCase() === ctx.match[1].toLowerCase());
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
    const record = ctx.store.listMints().find((m) => m.nftContract.toLowerCase() === ctx.match[1].toLowerCase());
    if (!record?.slug) return ctx.answerCbQuery("Not sellable.", { show_alert: true });
    await ctx.answerCbQuery("Selling...");

    const settings = ctx.store.getSettings();
    const { urls } = resolveRpcsForChain(record.chainKey);
    const logger = withPrefix("sell", createLogger(createTelegramSink(bot, ctx.chat!.id)));

    // Sell from a wallet that actually minted this collection.
    const seller = ctx.store.listWallets().find((w) =>
      record.wallets.some((a) => a.toLowerCase() === w.address.toLowerCase())
    );
    if (!seller) return ctx.reply("❌ None of your current wallets hold this collection.");

    try {
      const walletKey = ctx.store.getDecryptedKey(seller.address);
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
    ctx.store.removeMint(ctx.match[1]);
    const mints = ctx.store.listMints();
    if (mints.length === 0) return ctx.editMessageText("Portfolio is empty.", menuFor(ctx));
    return ctx.editMessageText(`🖼 Portfolio — ${mints.length} collection(s)`, portfolioMenu(mints));
  });

  // ── Activity alerts on held collections ──────────────────────────────
  // Collections are taken from what the wallets actually hold, not just what
  // this bot minted — so alerts cover NFTs acquired before or outside it.
  // Falls back to the mint store if the holdings lookup returns nothing.
  async function resolveWatchedCollections(userId: number): Promise<{ slug: string; name: string }[]> {
    const store = stores.for(userId);
    const settings = store.getSettings();
    const key = process.env.OPENSEA_API_KEY;
    const seen = new Map<string, { slug: string; name: string }>();
    const unresolved = store.listMints();

    for (const w of store.listWallets()) {
      try {
        // 12 pages, not 3. A wallet here can hold hundreds of NFTs, and at
        // 50 per page the old cap saw the first 150 — everything past that
        // was simply not watched, which is how a sale goes unnoticed.
        const nfts = await fetchAccountNfts(settings.chainKey, w.address, key, 12);
        for (const c of groupByCollection(nfts)) {
          if (!seen.has(c.slug)) seen.set(c.slug, { slug: c.slug, name: c.slug });
        }
      } catch {
        /* one unreadable wallet shouldn't blank the whole watchlist */
      }
    }

    // Everything ever minted, including collections OpenSea's account index
    // misses — measured at 100 NFTs where the chain held 1,923.
    const needSlug: typeof unresolved = [];
    for (const m of store.listMints()) {
      if (m.slug) {
        if (!seen.has(m.slug)) seen.set(m.slug, { slug: m.slug, name: m.name || m.slug });
      } else {
        needSlug.push(m);
      }
    }

    // A mint whose slug was never resolved used to be dropped silently, so a
    // collection OpenSea hadn't indexed at mint time was never watched again.
    // Resolve it now instead.
    for (const m of needSlug.slice(0, 20)) {
      try {
        const info = await openseaContractInfo(settings.chainKey, m.nftContract, key);
        if (info?.slug && !seen.has(info.slug)) {
          seen.set(info.slug, { slug: info.slug, name: info.name || info.slug });
        }
      } catch {
        /* still unindexed; try again next refresh */
      }
    }
    return [...seen.values()];
  }

  async function startActivity(chatId: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const store = stores.for(chatId);
    if (runningActivity.has(chatId)) return { ok: true };
    const collections = await resolveWatchedCollections(chatId);
    if (collections.length === 0) {
      return { ok: false, reason: "No collections held by your wallets to watch yet." };
    }

    const settings = store.getSettings();
    const stopSignal = { stopped: false };
    // Alerts go to the second bot when one is configured, and to this one
    // otherwise. The chat id is the same either way: a Telegram private chat
    // is identified by the user, not by the bot.
    const logger = withPrefix("activity", createLogger(createTelegramSink(alerts ?? bot, chatId)));
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
    runningActivity.set(chatId, { stopSignal, promise });
    store.updateSettings({ activityEnabled: true });
    return { ok: true };
  }

  function stopActivity(userId: number): void {
    const watcher = runningActivity.get(userId);
    if (!watcher) return;
    watcher.stopSignal.stopped = true;
    runningActivity.delete(userId);
    stores.for(userId).updateSettings({ activityEnabled: false });
  }

  bot.action("menu:activity", (ctx) => {
    const tracked = ctx.store.listMints().filter((m) => m.slug).length;
    return ctx.editMessageText(
      `🔔 Activity alerts: ${runningActivity.has(ctx.from!.id) ? "🟢 running" : "🔴 stopped"}\n` +
        `Watching ${tracked} portfolio collection(s) for sweeps, floor moves and offers.\n` +
        "Alerts arrive here automatically; nothing is ever bought or sold.",
      activityMenu(runningActivity.has(ctx.from!.id), ctx.store.getSettings())
    );
  });

  bot.action("activity:toggle", async (ctx) => {
    if (runningActivity.has(ctx.from!.id)) {
      stopActivity(ctx.from!.id);
      await ctx.answerCbQuery("Stopping...");
    } else {
      const result = await startActivity(ctx.chat!.id);
      if (!result.ok) return ctx.answerCbQuery(result.reason, { show_alert: true });
      await ctx.answerCbQuery("Started.");
    }
    return ctx.editMessageText(
      `🔔 Activity alerts: ${runningActivity.has(ctx.from!.id) ? "🟢 running" : "🔴 stopped"}`,
      activityMenu(runningActivity.has(ctx.from!.id), ctx.store.getSettings())
    );
  });

  // Default-on: starts itself as soon as there's anything to watch. Holdings
  // are fetched asynchronously, so this can't block bot startup — and a
  // failure just leaves alerts off rather than preventing the bot from running.
  //
  // Always reports the outcome. "Always on" that quietly failed to start
  // would be worse than being off, because it looks identical to working.
  if (ownerStore.getSettings().activityEnabled) {
    void startActivity(ownerId)
      .then((result) => {
        const text = result.ok
          ? "🔔 Activity alerts running — watching your holdings for sweeps, floor moves and offers."
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
    const settings = ctx.store.getSettings();
    const wallets = ctx.store.listWallets();
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

    // A rejected API key looks identical to "no data" everywhere else, so say
    // it plainly in the one place someone checks when things seem dead.
    const authFailure = openSeaAuthFailure();
    // Names what is actually refused, and does not blame the key. Measured
    // with one valid key: offers works on an Ethereum collection and 401s on
    // a Robinhood one, events 401s everywhere, stats answers with no key at
    // all. So a 401 is about the endpoint and the chain, not the credential —
    // saying "replace your key" sends someone to fix something that works.
    const AREA_NAMES: Record<string, string> = {
      offers: "collection offers",
      events: "activity alerts and sale feeds",
      listings: "listings",
      orders: "listings and offers",
    };
    const openSeaNote = authFailure
      ? `\n\n⚠️ ${authFailure.areas.map((a) => AREA_NAMES[a] ?? a).join(", ")} unavailable.\n` +
        `${authFailure.detail}.\n` +
        "Floor prices, collection art and contract lookups still work — those need no key. " +
        "Minting is unaffected either way; it reads only the chain."
      : "";

    await ctx.editMessageText(
      `Chain: ${settings.chainKey}\n` +
        `Wallets: ${wallets.length}${balances}\n` +
        `Auto mint: ${runningAutoFor(ctx.from!.id).size > 0 ? `running on ${[...runningAutoFor(ctx.from!.id).keys()].join(", ")}` : "stopped"}\n` +
        `Copy mint: ${runningCopy.has(ctx.from!.id) ? "running" : "stopped"} (watching ${ctx.store.listCopyTargets().length})\n` +
        `Portfolio: ${ctx.store.listMints().length} collection(s)\n` +
        `Activity alerts: ${runningActivity.has(ctx.from!.id) ? "running" : "stopped"}` +
        openSeaNote,
      menuFor(ctx)
    );
  });

  // ── Wallets ──────────────────────────────────────────────────────────
  // Anything that reveals a key or a phrase is sent as its own message and
  // deleted shortly after. Telegram keeps chat history on its servers, so a
  // secret left in the thread is a secret stored by Telegram indefinitely.
  const REVEAL_TTL_MS = 90_000;

  async function revealBriefly(ctx: BotContext, text: string): Promise<void> {
    const sent = await ctx.reply(text);
    setTimeout(() => {
      ctx.telegram.deleteMessage(sent.chat.id, sent.message_id).catch(() => {
        /* already gone, or the user deleted it first */
      });
    }, REVEAL_TTL_MS);
  }

  bot.action(/^wallet:key:(.+)$/, async (ctx) => {
    const address = ctx.match[1];
    let key: string;
    try {
      key = ctx.store.getDecryptedKey(address);
    } catch (err: any) {
      return ctx.answerCbQuery(err?.message ?? "Couldn't read that key.", { show_alert: true });
    }
    await ctx.answerCbQuery("Sent — it self-deletes.");
    return revealBriefly(
      ctx,
      `🔑 Private key for ${address}\n\n${key}\n\n` +
        `Import it with this; anyone who reads it owns the wallet. ` +
        `This message deletes itself in ${REVEAL_TTL_MS / 1000}s — copy it now.`
    );
  });

  bot.action("menu:seeds", (ctx) => {
    const seeds = ctx.store.listSeeds();
    if (seeds.length === 0) {
      return ctx.editMessageText(
        "No seed phrases stored yet.\n\nGenerate one from Wallets → 🌱 Generate seed + wallets, " +
          "or import an existing one. Phrases created before this feature existed weren't stored and can't be recovered.",
        walletsMenu(ctx.store.listWallets())
      );
    }
    const counts: Record<string, number> = {};
    for (const seed of seeds) counts[seed.id] = ctx.store.walletsFromSeed(seed.id).length;
    return ctx.editMessageText("🌱 Seed phrases — one phrase restores every wallet under it.", seedsMenu(seeds, counts));
  });

  bot.action(/^seed:view:(.+)$/, (ctx) => {
    const seedId = ctx.match[1];
    const wallets = ctx.store.walletsFromSeed(seedId);
    const lines = wallets.map((w) => `  ${w.derivationIndex ?? "?"}. ${w.address}`);
    return ctx.editMessageText(
      `🌱 Seed ${seedId}\n\n${wallets.length} wallet(s) derived:\n${lines.join("\n") || "  (none)"}\n\n` +
        "The phrase restores all of these in MetaMask, Rabby or Ledger.",
      seedDetailMenu(seedId)
    );
  });

  bot.action(/^seed:reveal:(.+)$/, async (ctx) => {
    let phrase: string;
    try {
      phrase = ctx.store.getDecryptedSeed(ctx.match[1]);
    } catch (err: any) {
      return ctx.answerCbQuery(err?.message ?? "Couldn't read that phrase.", { show_alert: true });
    }
    await ctx.answerCbQuery("Sent — it self-deletes.");
    return revealBriefly(
      ctx,
      `🌱 Seed phrase\n\n${phrase}\n\n` +
        `This controls EVERY wallet derived from it, including ones not created yet. ` +
        `Write it down offline. This message deletes itself in ${REVEAL_TTL_MS / 1000}s.`
    );
  });

  bot.action(/^seed:more:(.+)$/, async (ctx) => {
    const seedId = ctx.match[1];
    let phrase: string;
    try {
      phrase = ctx.store.getDecryptedSeed(seedId);
    } catch (err: any) {
      return ctx.answerCbQuery(err?.message ?? "Couldn't read that phrase.", { show_alert: true });
    }
    // Continue past the highest index already derived, so re-deriving never
    // collides with a wallet that exists.
    const existing = ctx.store.walletsFromSeed(seedId);
    const nextIndex = existing.reduce((max, w) => Math.max(max, (w.derivationIndex ?? -1) + 1), 0);
    const added: string[] = [];
    for (const w of deriveWallets(phrase, 5, nextIndex)) {
      try {
        ctx.store.addWallet(`seed-${w.index}`, w.privateKey, { seedId, derivationIndex: w.index });
        added.push(w.address);
      } catch {
        /* already present */
      }
    }
    await ctx.answerCbQuery(`Derived ${added.length}.`);
    return ctx.reply(
      `✅ Added ${added.length} more wallet(s) from this seed:\n\n${added.join("\n")}\n\n` +
        "They mint on copy signals automatically. Fund them before the next drop."
    );
  });

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
    ctx.store.removeWallet(address);
    return ctx.editMessageText("Wallets — tap one to manage it. [🎯 Auto] [👀 Copy]:", walletsMenu(ctx.store.listWallets()));
  });

  /**
   * Full address in a code block — Telegram renders those tap-to-copy on
   * mobile, which is the only "copy button" the platform offers. A masked
   * address is fine in a list and useless when you need to fund the thing.
   */
  async function showWallet(ctx: BotContext, address: string, balance?: bigint): Promise<unknown> {
    const wallet = ctx.store.listWallets().find((w) => w.address.toLowerCase() === address.toLowerCase());
    if (!wallet) return ctx.answerCbQuery("That wallet no longer exists.", { show_alert: true });

    const settings = ctx.store.getSettings();
    const chain = resolveChain(settings.chainKey);
    const lines = [
      `${wallet.label}`,
      "",
      "```",
      wallet.address,
      "```",
      balance === undefined
        ? "Balance: tap 💰 Refresh balance"
        : `Balance: ${formatEther(balance)} ${chain?.nativeSymbol ?? "ETH"} on ${chain?.name ?? settings.chainKey}`,
    ];
    if (balance !== undefined) {
      // What stops an underfunded wallet is the upfront reservation, not the
      // mint price — see gas.ts.
      const needed = upfrontReservation(
        gasLimitForQuantity(1),
        await resolveFeeCeiling(settings, resolveRpcsForChain(settings.chainKey).urls)
      );
      lines.push(
        balance >= needed
          ? `✅ Covers ~${balance / needed} mint(s) in flight`
          : `⚠️ Under the ${formatEther(needed)} one mint reserves — it can't send yet`
      );
    }
    return ctx.editMessageText(lines.join("\n"), {
      parse_mode: "Markdown",
      ...walletDetailMenu(wallet),
    });
  }

  bot.action(/^wallet:manage:(.+)$/, (ctx) => showWallet(ctx, ctx.match[1]));

  bot.action(/^wallet:rename:(.+)$/, (ctx) => {
    const address = ctx.match[1];
    const wallet = ctx.store.listWallets().find((w) => w.address.toLowerCase() === address.toLowerCase());
    if (!wallet) return ctx.answerCbQuery("That wallet is gone.", { show_alert: true });
    ctx.session.step = "awaiting_wallet_label";
    ctx.session.renameWallet = address;
    return ctx.editMessageText(
      `✏️ Rename *${wallet.label}*

${maskAddress(wallet.address)}

Send the new name.`,
      { parse_mode: "Markdown" }
    );
  });

  bot.action(/^wallet:bal:(.+)$/, async (ctx) => {
    const address = ctx.match[1];
    await ctx.answerCbQuery("Checking…");
    const { urls } = resolveRpcsForChain(ctx.store.getSettings().chainKey);
    try {
      const balance = await raceRead(readableRpcs(urls), (url) => createProvider(url).getBalance(address));
      return showWallet(ctx, address, balance);
    } catch (err: any) {
      return ctx.answerCbQuery(`Couldn't read the balance: ${describeRpcError(err)}`, { show_alert: true });
    }
  });

  bot.action(/^wallet:toggle:(auto|copy):(.+)$/, (ctx) => {
    const feature = ctx.match[1] as "auto" | "copy";
    const address = ctx.match[2];
    try {
      const wallet = ctx.store.listWallets().find((w) => w.address.toLowerCase() === address.toLowerCase());
      if (!wallet) return ctx.answerCbQuery("That wallet no longer exists.", { show_alert: true });
      const currentlyOn = feature === "auto" ? wallet.includeInAutoMint !== false : wallet.includeInCopyMint !== false;
      const updated = ctx.store.setWalletInclusion(address, feature, !currentlyOn);
      return ctx.editMessageText(`${updated.label} (${maskAddress(updated.address)})`, walletDetailMenu(updated));
    } catch (err: any) {
      return ctx.answerCbQuery(err.message, { show_alert: true });
    }
  });

  // ── Copy-mint watchlist ──────────────────────────────────────────────
  bot.action("copy:add", (ctx) => {
    ctx.session.step = "awaiting_copy_target";
    return ctx.reply(
      "Send the wallet address to watch, optionally followed by a label:\n" +
        "0xabc... whale\n\n" +
        "Or paste many at once — one per line, or separated by spaces or commas. " +
        "Addresses already on the list are skipped."
    );
  });

  bot.action(/^copy:rename:(.+)$/, (ctx) => {
    const address = ctx.match[1];
    const target = ctx.store.listCopyTargets().find((t) => t.address.toLowerCase() === address.toLowerCase());
    if (!target) return ctx.answerCbQuery("That wallet is no longer watched.", { show_alert: true });
    ctx.session.step = "awaiting_copy_label";
    ctx.session.renameCopyTarget = address;
    return ctx.editMessageText(
      "Rename *" + target.label + "*\n\n" +
        maskAddress(target.address) +
        "\n\nSend the new name.",
      { parse_mode: "Markdown" }
    );
  });

  bot.action(/^copy:remove:(.+)$/, (ctx) => {
    const address = ctx.match[1];
    ctx.store.removeCopyTarget(address);
    return ctx.editMessageText("Copy-mint watchlist:", copyMenu(runningCopy.has(ctx.from!.id), ctx.store.listCopyTargets()));
  });

  // Pulled out of the toggle action so start-up can resume it too, without a
  // tap, whenever settings.copyMintEnabled says it was left running — same
  // pattern as Auto Mint's startAuto/stopAuto below.
  function startCopy(chatId: number): { ok: true } | { ok: false; reason: string } {
    const store = stores.for(chatId);
    if (runningCopy.has(chatId)) return { ok: true }; // already running
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
      describeCollection: async (nftContract) => {
        // Best-effort: a missing name costs a readable log line, never a mint.
        const known = store.listMints().find((m) => m.nftContract.toLowerCase() === nftContract.toLowerCase());
        if (known?.slug) return known.slug;
        const info = await openseaContractInfo(settings.chainKey, nftContract, process.env.OPENSEA_API_KEY);
        return info?.name ?? null;
      },
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
    runningCopy.set(chatId, { stopSignal, promise });
    store.updateSettings({ copyMintEnabled: true });
    return { ok: true };
  }

  function stopCopy(userId: number): void {
    const watcher = runningCopy.get(userId);
    if (!watcher) return;
    watcher.stopSignal.stopped = true;
    runningCopy.delete(userId);
    stores.for(userId).updateSettings({ copyMintEnabled: false });
  }

  // ── Copy-mint history ────────────────────────────────────────────────
  bot.action("copy:history", (ctx) => {
    const attempts = ctx.store.listCopyAttempts();
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
    const targets = ctx.store.listCopyTargets();
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
    ctx.store.clearCopyHistory();
    return ctx.editMessageText("📜 Copy-mint history cleared.", copyMenu(runningCopy.has(ctx.from!.id), ctx.store.listCopyTargets()));
  });

  bot.action(/^copy:hist:(.+)$/, async (ctx) => {
    const address = resolveToken(ctx.session, ctx.match[1]);
    if (!address) return ctx.answerCbQuery("That menu expired — reopen Copy Mint.", { show_alert: true });

    const attempts = ctx.store.listCopyAttempts(address);
    if (attempts.length === 0) return ctx.answerCbQuery("Nothing recorded for that wallet.", { show_alert: true });

    const target = ctx.store.listCopyTargets().find((t) => t.address.toLowerCase() === address.toLowerCase());
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
    if (runningCopy.has(ctx.from!.id)) {
      stopCopy(ctx.from!.id);
      await ctx.answerCbQuery("Stopping...");
    } else {
      const result = startCopy(ctx.chat!.id);
      if (!result.ok) return ctx.answerCbQuery(result.reason, { show_alert: true });
      await ctx.answerCbQuery("Started.");
    }
    return ctx.editMessageText(
      `Copy-mint watcher: ${runningCopy.has(ctx.from!.id) ? "🟢 running" : "🔴 stopped"}`,
      copyMenu(runningCopy.has(ctx.from!.id), ctx.store.listCopyTargets())
    );
  });

  // Re-arm every user's pending scheduled mints. A redeploy in the middle of
  // a long wait used to drop them silently — the record said "pending" and
  // nothing was waiting on it.
  for (const userId of stores.listUserIds()) {
    try {
      const count = rearmScheduled(userId);
      if (count > 0 && userId === ownerId) {
        bot.telegram
          .sendMessage(ownerId, `⏰ Re-armed ${count} scheduled mint(s) after restart.`)
          .catch(() => {});
      }
    } catch (err: any) {
      console.error(`Could not re-arm schedules for ${userId}: ${err?.message ?? err}`);
    }
  }

  // Resume automatically on every bot start if it was left "on" — same
  // reasoning as Auto Mint: a restart shouldn't silently turn this off
  // until someone notices and taps the button again. Never let this stop
  // the bot itself from starting.
  // Resume for EVERY user who left it on, not just the owner. Their watcher
  // used to stay dead until they noticed and tapped the button again, which
  // for a "runs while you sleep" feature is the same as being broken.
  for (const userId of stores.listUserIds()) {
    if (!stores.for(userId).getSettings().copyMintEnabled) continue;
    try {
      const result = startCopy(userId);
      if (result.ok) {
        bot.telegram.sendMessage(userId, "🟢 Copy-mint watcher resumed (was on before restart).").catch(() => {});
      } else {
        // Couldn't start — usually no wallets or no watched wallets yet. Leave
        // the setting ON so it starts by itself once that's fixed, rather than
        // silently turning itself off.
        if (userId === ownerId) {
          bot.telegram
            .sendMessage(userId, `🔕 Copy mint is ON but could not start: ${result.reason}`)
            .catch(() => {});
        }
      }
    } catch (err: any) {
      console.error(`Copy mint could not resume for ${userId}: ${err?.message ?? err}`);
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
    const store = stores.for(chatId);
    const wallets = store.listWalletsFor("auto");
    if (wallets.length === 0) {
      return { ok: false, reason: "No wallets enabled for Auto Mint — enable at least one in Wallets." };
    }

    const settings = store.getSettings();
    const chainKeys = settings.autoChainKeys?.length ? settings.autoChainKeys : [settings.chainKey];

    for (const key of chainKeys) {
      if (runningAutoFor(chatId).has(key)) continue; // already running on this chain
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
      runningAutoFor(chatId).set(key, { stopSignal, promise });
    }
    store.updateSettings({ autoEnabled: true });
    return { ok: true };
  }

  function stopAuto(userId: number): void {
    for (const watcher of runningAutoFor(userId).values()) watcher.stopSignal.stopped = true;
    runningAutoFor(userId).clear();
    stores.for(userId).updateSettings({ autoEnabled: false });
  }

  bot.action("auto:toggle", async (ctx) => {
    if (runningAutoFor(ctx.from!.id).size > 0) {
      stopAuto(ctx.from!.id);
      await ctx.answerCbQuery("Stopping...");
    } else {
      const result = startAuto(ctx.chat!.id);
      if (!result.ok) return ctx.answerCbQuery(result.reason, { show_alert: true });
      await ctx.answerCbQuery("Started.");
    }
    return ctx.editMessageText(
      `Auto free-mint watcher: ${runningAutoFor(ctx.from!.id).size > 0 ? `🟢 running on ${[...runningAutoFor(ctx.from!.id).keys()].join(", ")}` : "🔴 stopped"}`,
      autoMenu(runningAutoFor(ctx.from!.id).size > 0)
    );
  });

  // Resume automatically on every bot start if it was left "on" — so a
  // restart (redeploy, crash-and-relaunch, reboot) doesn't silently turn
  // auto-mint off until someone notices and taps the button again. Never
  // let this stop the bot itself from starting — worst case, auto-mint
  // just stays off and the owner can turn it back on from the menu.
  if (ownerStore.getSettings().autoEnabled) {
    try {
      const result = startAuto(ownerId);
      if (result.ok) {
        bot.telegram
          .sendMessage(ownerId, `🟢 Auto free-mint watcher resumed on ${[...runningAutoFor(ownerId).keys()].join(", ")} (was on before restart).`)
          .catch(() => {});
      } else {
        ownerStore.updateSettings({ autoEnabled: false });
      }
    } catch (err: any) {
      ownerStore.updateSettings({ autoEnabled: false });
      console.error(`Could not resume auto-mint on startup: ${err.message}`);
    }
  }

  // ── Fund wallets: send native currency from one wallet to several ─────
  bot.action(/^fund:source:(.+)$/, (ctx) => {
    const source = ctx.match[1];
    ctx.session.fundSource = source;
    ctx.session.fundTargets = [];
    const candidates = ctx.store.listWallets().filter((w) => w.address.toLowerCase() !== source.toLowerCase());
    return ctx.editMessageText("Send TO which wallet(s)? Tap to select, then Done.", fundTargetsMenu(candidates, new Set()));
  });

  bot.action(/^fund:target:toggle:(.+)$/, (ctx) => {
    const address = ctx.match[1].toLowerCase();
    const targets = new Set(ctx.session.fundTargets ?? []);
    if (targets.has(address)) targets.delete(address);
    else targets.add(address);
    ctx.session.fundTargets = [...targets];

    const candidates = ctx.store
      .listWallets()
      .filter((w) => w.address.toLowerCase() !== (ctx.session.fundSource ?? "").toLowerCase());
    return ctx.editMessageText("Send TO which wallet(s)? Tap to select, then Done.", fundTargetsMenu(candidates, targets));
  });

  bot.action("fund:targets:done", (ctx) => {
    if (!ctx.session.fundTargets || ctx.session.fundTargets.length === 0) {
      return ctx.answerCbQuery("Select at least one wallet.", { show_alert: true });
    }
    const settings = ctx.store.getSettings();
    const chain = resolveChain(settings.chainKey)!;
    ctx.session.step = "awaiting_fund_amount";
    return ctx.reply(`How much ${chain.nativeSymbol} to send to EACH of the ${ctx.session.fundTargets.length} selected wallet(s)?`);
  });

  bot.action("fund:cancel", (ctx) => {
    ctx.session.step = undefined;
    ctx.session.fundSource = undefined;
    ctx.session.fundTargets = undefined;
    ctx.session.fundAmountWei = undefined;
    return ctx.editMessageText("Cancelled.", menuFor(ctx));
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

    const settings = ctx.store.getSettings();
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const logger = createLogger(createTelegramSink(bot, ctx.chat!.id));
    try {
      await batchTransfer({
        rpcUrl: urls[0],
        sourceKey: ctx.store.getDecryptedKey(fundSource),
        targets: fundTargets,
        amountWei: BigInt(fundAmountWei),
        maxFeePerGas: await resolveFeeCeiling(settings, urls),
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
    ctx.store.updateSettings({ chainKey: ctx.match[1] });
    return ctx.editMessageText("Settings:", settingsMenu(ctx.store.getSettings()));
  });

  bot.action("setting:autoChains", (ctx) =>
    ctx.editMessageText(
      "Which chain(s) should Auto Mint watch? Select none to just use the default Chain above.",
      autoChainsMenu(new Set(ctx.store.getSettings().autoChainKeys ?? []))
    )
  );
  bot.action(/^setting:autoChains:toggle:(.+)$/, (ctx) => {
    const key = ctx.match[1];
    const selected = new Set(ctx.store.getSettings().autoChainKeys ?? []);
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    ctx.store.updateSettings({ autoChainKeys: selected.size > 0 ? [...selected] : undefined });
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
          : field === "maxFeeGwei"
            ? ' (or "auto" to follow the chain base fee — recommended, and reserves less)'
            : "";
      return ctx.reply(`Send the new value for ${field}${hint}:`);
    });
  }

  // ── Admin panel (owner only) ──────────────────────────────────────────
  const requireOwner = (ctx: BotContext): boolean => ctx.from?.id === ownerId;

  /**
   * The fee ceiling to sign with, outside the mint engine.
   *
   * A max fee of 0 means "follow the chain" (see gas-fit.ts), which the mint
   * path resolves for itself. Anything that signs its own transactions — the
   * batch transfer below — has to do the same, or it signs with a ceiling of
   * zero and the node never includes it.
   */
  async function resolveFeeCeiling(settings: BotSettings, urls: string[]): Promise<bigint> {
    const configured = gweiToWei(settings.maxFeeGwei);
    const priority = gweiToWei(settings.priorityGwei);
    if (configured > 0n) return configured;
    try {
      const head = await raceRead(readableRpcs(urls), (url) => createProvider(url).getBlock("latest"));
      return resolveMaxFee(configured, head?.baseFeePerGas ?? 0n, priority).maxFeePerGas;
    } catch {
      // Couldn't read the chain — a sane ceiling beats signing with zero.
      return marketFee(1_000_000_000n, priority);
    }
  }

  /**
   * Scan every wallet for a collection, reporting progress as it goes.
   *
   * Deliberately NOT awaited by the caller's handler. Telegraf wraps every
   * handler in a 90-second timeout, and a collection with no enumeration
   * costs one call per token in the whole drop — a 7,361-token drop took past
   * two minutes and surfaced as "Promise timed out after 90000 milliseconds"
   * while the scan was still running perfectly well behind it.
   *
   * Progress edits are throttled: Telegram rate-limits message edits, and a
   * batch completing every half second would trip that long before the scan
   * finished.
   */
  async function scanWithProgress(
    ctx: BotContext,
    contract: string,
    noteChatId: number,
    noteMessageId: number
  ): Promise<ScanResult | null> {
    const settings = ctx.store.getSettings();
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const wallets = ctx.store.listWallets();
    const say = (text: string, extra?: any) =>
      ctx.telegram.editMessageText(noteChatId, noteMessageId, undefined, text, extra).catch(() => {});

    let lastEdit = 0;
    try {
      return await scanHoldings(urls, contract, wallets.map((w) => w.address), {
        onProgress: (checked, total) => {
          const now = Date.now();
          if (now - lastEdit < PROGRESS_EDIT_MS || total <= 0) return;
          lastEdit = now;
          const pct = Math.min(100, Math.round((checked / total) * 100));
          void say(
            `Checking ${wallets.length} wallet(s) against ${total.toLocaleString()} tokens…\n` +
              `${pct}% — this collection can't be enumerated, so every token has to be asked about.`
          );
        },
      });
    } catch (err: any) {
      await say(`Couldn't read that collection: ${err?.shortMessage ?? err?.message ?? err}`);
      return null;
    }
  }

  /** Live state handed to the assistant. Read-only, and gathered per ask. */
  async function buildSnapshot(ctx: BotContext): Promise<BotSnapshot> {
    const store = ctx.store;
    const settings = store.getSettings();
    const userId = ctx.from!.id;
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const provider = createProvider(urls[0]);

    const wallets = await Promise.all(
      store.listWallets().map(async (w) => {
        let balanceEth = "unknown";
        try {
          balanceEth = formatEther(await provider.getBalance(w.address));
        } catch {
          /* a balance we can't read is worth saying so, not worth failing over */
        }
        return { address: w.address, balanceEth, copyOn: w.includeInCopyMint !== false };
      })
    );

    const when = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 16);
    return {
      chainKey: settings.chainKey,
      autoEnabled: settings.autoEnabled,
      copyEnabled: settings.copyMintEnabled,
      copyWatcherRunning: runningCopy.has(userId),
      autoChainsRunning: [...runningAutoFor(userId).keys()],
      maxFeeGwei: settings.maxFeeGwei,
      gasLimit: settings.gasLimit,
      copyMaxPriceEth: settings.copyMintMaxPriceEth,
      copyMaxQuantity: settings.copyMintMaxQuantity,
      copyBackfillHours: settings.copyBackfillHours,
      wallets,
      watchedCount: store.listCopyTargets().length,
      recentAttempts: store.listCopyAttempts().slice(0, 8).map((a) => ({
        when: when(a.at),
        contract: a.nftContract,
        outcome: a.outcome,
        reason: a.reason,
      })),
      recentMints: store.listMints().slice(0, 8).map((m) => ({
        when: when(m.lastMintedAt),
        contract: m.nftContract,
        quantity: m.quantity,
      })),
    };
  }

  bot.action("menu:admin", (ctx) => {
    if (!requireOwner(ctx)) return;
    return ctx.editMessageText(
      "🛠 Admin — invites, users, and the assistant.",
      adminMenu(access.listCodes().length, stores.listUserIds().length)
    );
  });

  bot.action("admin:invite", async (ctx) => {
    if (!requireOwner(ctx)) return;
    const { code, record } = access.createInvite();
    await ctx.answerCbQuery("Created.");
    return ctx.reply(
      `🎟 Invite code:\n\n${code}\n\n` +
        `Single use. Revoke just this one with /revoke ${record.id}\n` +
        `Shown once — only its hash is stored.`
    );
  });

  bot.action("admin:invites", (ctx) => {
    if (!requireOwner(ctx)) return;
    const codes = access.listCodes();
    if (codes.length === 0) return ctx.editMessageText("No invites yet.", adminMenu(0, stores.listUserIds().length));
    return ctx.editMessageText("Tap one to revoke that person. Others are unaffected.", adminInvitesMenu(codes));
  });

  bot.action(/^admin:revoke:(.+)$/, (ctx) => {
    if (!requireOwner(ctx)) return;
    const code = access.revokeCode(ctx.match[1]);
    if (!code) return ctx.answerCbQuery("No such invite.", { show_alert: true });
    return ctx.editMessageText(
      `✅ Revoked ${code.label || code.id}.` +
        (code.redeemedBy ? ` User ${code.redeemedBy} is locked out; their wallets are untouched.` : " It was never used."),
      adminMenu(access.listCodes().length, stores.listUserIds().length)
    );
  });

  bot.action("admin:users", (ctx) => {
    if (!requireOwner(ctx)) return;
    const ids = stores.listUserIds();
    const lines = ids.map((id) => {
      const inside = id === ownerId || access.hasAccess(id);
      return `${inside ? "✅" : "🔒"} ${id}${id === ownerId ? " (you)" : ""} — ${stores.for(id).listWallets().length} wallet(s)`;
    });
    return ctx.editMessageText(
      `Users: ${ids.length}\n\n${lines.join("\n") || "(none yet)"}`,
      adminMenu(access.listCodes().length, ids.length)
    );
  });

  bot.action("admin:backup", async (ctx) => {
    if (!requireOwner(ctx)) return;
    await ctx.answerCbQuery("Preparing…");
    const snapshot = ctx.store.exportSnapshot();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return ctx.replyWithDocument(
      { source: Buffer.from(snapshot, "utf8"), filename: `snake-minter-backup-${stamp}.json` },
      {
        caption:
          `💾 ${ctx.store.listWallets().length} wallet(s), ${ctx.store.listCopyTargets().length} watched, ` +
          `${ctx.store.listSeeds().length} seed phrase(s).\n\n` +
          "Keys inside are encrypted — this file alone can't spend anything. It needs your " +
          "WALLET_ENCRYPTION_KEY, which is NOT in here. Keep the two apart and restoring works; " +
          "lose the key and this file is unreadable.",
      }
    );
  });

  bot.action("admin:restore", (ctx) => {
    if (!requireOwner(ctx)) return;
    ctx.session.step = "awaiting_restore_file";
    return ctx.reply(
      "♻️ Send the backup file.\n\n" +
        "I'll check every key decrypts with this server's WALLET_ENCRYPTION_KEY before " +
        "changing anything — a backup from an install with a different key would restore " +
        "wallets nobody can spend from."
    );
  });

  bot.action("admin:restore:confirm", (ctx) => {
    if (!requireOwner(ctx)) return;
    const snapshot = ctx.session.pendingRestore;
    ctx.session.pendingRestore = undefined;
    if (!snapshot) return ctx.answerCbQuery("That upload expired — send the file again.", { show_alert: true });
    try {
      const result = ctx.store.importSnapshot(snapshot);
      return ctx.editMessageText(
        `✅ Restored ${result.wallets} wallet(s) and ${result.seeds} seed phrase(s).\n\n` +
          "Watchers reload on the next restart. The store this replaced is kept on disk as " +
          "*.pre-restore in case this was the wrong file.",
        mainMenu()
      );
    } catch (err: any) {
      return ctx.editMessageText(`❌ ${err.message}`, adminMenu(access.listCodes().length, stores.listUserIds().length));
    }
  });

  bot.action("admin:revokeall", (ctx) => {
    if (!requireOwner(ctx)) return;
    const active = access.listCodes().filter((c) => c.redeemedBy && !c.revoked).length;
    return ctx.editMessageText(
      `Revoke everyone?\n\n${active} person(s) lose access and every invite code dies. ` +
        "Nobody's wallets are deleted — they come back with a new code.\n\n" +
        "Use this when you don't know which code leaked. To remove one person, use Invites.",
      adminRevokeConfirmMenu()
    );
  });

  bot.action("admin:revokeall:confirm", (ctx) => {
    if (!requireOwner(ctx)) return;
    access.revokeAll();
    return ctx.editMessageText(
      "✅ Everyone revoked and every code killed. Issue fresh invites when you're ready.",
      adminMenu(access.listCodes().length, stores.listUserIds().length)
    );
  });

  bot.action("admin:ask", (ctx) => {
    if (!requireOwner(ctx)) return;
    ctx.session.step = "awaiting_agent_question";
    return ctx.reply(
      "🤖 What's the question?\n\n" +
        "I'll answer against the bot's live state — wallets, balances, watcher status, " +
        "recent attempts. Good for \"why didn't it mint that\" or \"is copy mint actually running\"."
    );
  });

  // Latency can only be measured from where the bot actually runs — a
  // laptop's numbers say nothing about the server's.
  bot.command("latency", async (ctx) => {
    if (!requireOwner(ctx)) return;
    const settings = ctx.store.getSettings();
    const chain = resolveChain(settings.chainKey);
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const note = await ctx.reply("📡 Measuring latency and scan limits…");
    const samples = await measureLatency(urls);
    // Latency alone would recommend a fast endpoint that can't scan.
    for (const sample of samples) {
      if (sample.medianMs === null) continue;
      const cap = await probeCapability(sample.url);
      sample.canRead = cap.canRead;
      sample.logRange = cap.logRange;
    }
    return ctx.telegram
      .editMessageText(
        note.chat.id,
        note.message_id,
        undefined,
        renderLatency(samples, chain?.blockSeconds ?? 12)
      )
      .catch(() => {});
  });

  bot.command("ask", async (ctx) => {
    if (!requireOwner(ctx)) return;
    const question = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
    if (!question) return ctx.reply("Send /ask <question>, or use 🛠 Admin → Ask the assistant.");
    return runAsk(ctx, question);
  });

  async function runAsk(ctx: BotContext, question: string): Promise<void> {
    const thinking = await ctx.reply("🤖 Thinking…");
    let snapshot: BotSnapshot;
    try {
      snapshot = await buildSnapshot(ctx);
    } catch (err: any) {
      await ctx.telegram
        .editMessageText(thinking.chat.id, thinking.message_id, undefined, `Couldn't read the bot's state: ${err?.message ?? err}`)
        .catch(() => {});
      return;
    }

    const result = await ask(question, snapshot);
    // Chunked: an answer can exceed Telegram's 4096-character limit, and a
    // send that fails on length would look like the assistant simply died.
    const parts = chunkMessage(result.text);
    await ctx.telegram
      .editMessageText(thinking.chat.id, thinking.message_id, undefined, parts[0])
      .catch(() => ctx.reply(parts[0]));
    for (const part of parts.slice(1)) await ctx.reply(part);
  }

  // ── Access control (owner only) ───────────────────────────────────────
  bot.command("invite", async (ctx) => {
    if (ctx.from!.id !== ownerId) return;
    const label = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
    const { code, record } = access.createInvite(label);
    // Sent on its own so it can be forwarded to one person, and shown once:
    // only the hash is stored, so this cannot be read back later.
    return ctx.reply(
      `🎟 Invite code${record.label ? ` for ${record.label}` : ""}:\n\n` +
        `${code}\n\n` +
        `Single use — it belongs to whoever redeems it first.\n` +
        `Revoke just this one later with /revoke ${record.id}\n\n` +
        `I can't show it again; only its hash is stored.`
    );
  });

  bot.command("invites", (ctx) => {
    if (ctx.from!.id !== ownerId) return;
    const codes = access.listCodes();
    if (codes.length === 0) return ctx.reply("No invites yet. /invite [name] to create one.");
    const lines = codes.map((c) => {
      const who = c.redeemedBy ? `user ${c.redeemedBy}` : "unredeemed";
      const state = c.revoked
        ? "🚫 revoked"
        : c.redeemedBy === undefined
          ? "⏳ unused"
          : c.epochAtRedeem === access.epoch
            ? "✅ active"
            : "🔒 revoked (all)";
      return `${state} · ${c.id}${c.label ? ` · ${c.label}` : ""} · ${who}`;
    });
    return ctx.reply(`Invites (${codes.length}):\n\n${lines.join("\n")}\n\n/revoke <id> removes one.`);
  });

  bot.command("revoke", (ctx) => {
    if (ctx.from!.id !== ownerId) return;
    const id = ctx.message.text.split(/\s+/)[1]?.trim();
    if (!id) return ctx.reply("Send /revoke <id> — /invites lists the ids.");
    const code = access.revokeCode(id);
    if (!code) return ctx.reply(`No invite with id ${id}.`);
    return ctx.reply(
      `✅ Revoked ${id}${code.label ? ` (${code.label})` : ""}.\n\n` +
        (code.redeemedBy
          ? `User ${code.redeemedBy} is locked out. Nobody else is affected, and their wallets are untouched.`
          : "That code was never used, so nobody was using it.")
    );
  });

  bot.command("revokeall", (ctx) => {
    if (ctx.from!.id !== ownerId) return;
    const epoch = access.revokeAll();
    const others = access.listCodes().filter((c) => c.redeemedBy !== undefined).length;
    return ctx.reply(
      `✅ Revoked everyone. ${others} redeemed code(s) are now dead.\n\n` +
        "Every existing invite is invalid — issue fresh ones with /invite. " +
        `Nobody's wallets were touched. (epoch ${epoch})`
    );
  });

  bot.command("users", (ctx) => {
    if (ctx.from!.id !== ownerId) return;
    const ids = stores.listUserIds();
    const lines = ids.map((id) => {
      const store = stores.for(id);
      const inside = id === ownerId || access.hasAccess(id);
      return `${inside ? "✅" : "🔒"} ${id}${id === ownerId ? " (you)" : ""} — ${store.listWallets().length} wallet(s)`;
    });
    return ctx.reply(
      `Users with a store: ${ids.length}\n\n${lines.join("\n") || "(none yet)"}\n\n` +
        "✅ has access · 🔒 locked out"
    );
  });

  // ── Manual one-off mint ──────────────────────────────────────────────
  // /mint <link> <quantity> [wallet labels/addresses, comma-separated]
  // The wallet filter is what makes this the fast path for "already live,
  // fire now with this one wallet" — one message, no menu taps, no
  // confirmation, so it's the fastest thing this bot can do for a
  // genuinely contested public stage.
  // Merkle allow-list mints. A proof is maths, not permission — if the
  // project publishes the list, the holder of a wallet on it can mint without
  // anyone's blessing. Signed stages are a different thing entirely and no
  // amount of this helps them; see seadrop-allowlist.ts.
  // ── FCFS / allow-list, owner only ─────────────────────────────────────
  // Separate from Scheduled Mint deliberately: that fires the public stage,
  // where the bot's speed work gives a real edge. This one mints against
  // terms that came from a published list, and belongs to whoever runs the
  // bot rather than to a tester.
  // ── Quick Mint ────────────────────────────────────────────────────────
  // For a stage that is live NOW. Paste a link, pick wallets, fire. Every
  // check that would otherwise show up as a revert happens before the button
  // appears: is the stage open, can each wallet still mint, and can it cover
  // the reservation rather than merely the price.
  bot.action("menu:quick", (ctx) => {
    ctx.session.quick = undefined;
    ctx.session.step = "awaiting_quick_target";
    return ctx.editMessageText(
      "⚡ Quick Mint\n\n" +
        "Send an OpenSea link or a contract address for a stage that's live now.\n\n" +
        "I'll check which of your wallets can mint it and how many, then it's one button.",
      Markup.inlineKeyboard([[Markup.button.callback("Cancel", "menu:main")]])
    );
  });

  bot.action(/^quick:w:(.+)$/, (ctx) => {
    const q = ctx.session.quick;
    if (!q) return ctx.answerCbQuery("That expired — start again.", { show_alert: true });
    const address = ctx.match[1].toLowerCase();
    const row = q.ready.find((r) => r.address.toLowerCase() === address);
    if (!row || row.canMint === 0) {
      return ctx.answerCbQuery(row?.reason ?? "That wallet can't mint this.", { show_alert: true });
    }
    q.chosen = q.chosen.includes(address)
      ? q.chosen.filter((a) => a !== address)
      : [...q.chosen, address];
    return ctx.editMessageReplyMarkup(quickWalletsMenu(q.ready, new Set(q.chosen)).reply_markup);
  });

  bot.action("quick:all", (ctx) => {
    const q = ctx.session.quick;
    if (!q) return ctx.answerCbQuery("That expired — start again.", { show_alert: true });
    const eligible = q.ready.filter((r) => r.canMint > 0).map((r) => r.address.toLowerCase());
    const allOn = eligible.every((a) => q.chosen.includes(a));
    q.chosen = allOn ? [] : eligible;
    return ctx.editMessageReplyMarkup(quickWalletsMenu(q.ready, new Set(q.chosen)).reply_markup);
  });

  bot.action("quick:go", async (ctx) => {
    const q = ctx.session.quick;
    if (!q) return ctx.answerCbQuery("That expired — start again.", { show_alert: true });
    if (q.chosen.length === 0) return ctx.answerCbQuery("Pick at least one wallet.", { show_alert: true });

    const usable = q.ready.filter((r) => q.chosen.includes(r.address.toLowerCase()));
    const most = Math.max(...usable.map((r) => r.canMint));

    // One mintable item means there is nothing to ask, and asking anyway puts
    // a tap between the user and a live stage.
    if (most <= 1) {
      q.quantity = 1;
      return showQuickConfirm(ctx);
    }
    ctx.session.step = "awaiting_quick_quantity";
    await ctx.answerCbQuery();
    return ctx.reply(`How many per wallet? Up to ${most}. Send a number, or "max".`);
  });

  async function showQuickConfirm(ctx: BotContext): Promise<unknown> {
    const q = ctx.session.quick!;
    const usable = q.ready.filter((r) => q.chosen.includes(r.address.toLowerCase()));
    const price = BigInt(q.priceWei);
    const lines = usable.map((r) => {
      const n = Math.min(r.canMint, q.quantity ?? r.canMint);
      return `  ${r.label} — ${n}`;
    });
    const total = usable.reduce(
      (sum, r) => sum + price * BigInt(Math.min(r.canMint, q.quantity ?? r.canMint)),
      0n
    );
    return ctx.reply(
      `⚡ ${q.name ?? q.contract}\n\n` +
        `${lines.join("\n")}\n\n` +
        `Price: ${price === 0n ? "FREE" : formatEther(price) + " ETH each"}\n` +
        `Total: ${total === 0n ? "gas only" : formatEther(total) + " ETH + gas"}`,
      quickConfirmMenu()
    );
  }

  bot.action("quick:fire", async (ctx) => {
    const q = ctx.session.quick;
    ctx.session.quick = undefined;
    if (!q) return ctx.answerCbQuery("That expired — start again.", { show_alert: true });

    await ctx.answerCbQuery("Firing...");
    const settings = ctx.store.getSettings();
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const logger = createLogger(createTelegramSink(bot, ctx.chat!.id));
    const usable = q.ready.filter((r) => q.chosen.includes(r.address.toLowerCase()));

    // Wallets can differ in how many they may take, and one plan carries one
    // quantity — so they are grouped and each group fired with its own.
    const byQuantity = new Map<number, string[]>();
    for (const r of usable) {
      const n = Math.min(r.canMint, q.quantity ?? r.canMint);
      if (n < 1) continue;
      byQuantity.set(n, [...(byQuantity.get(n) ?? []), r.address]);
    }

    for (const [quantity, addresses] of byQuantity) {
      try {
        const plan = await raceReadOrNull(urls, (url) => buildLocalMintPlan(url, q.contract, quantity), logger);
        if (!plan) {
          logger.errorBold(`${q.name ?? q.contract}: drop not resolvable — nothing sent.`);
          continue;
        }
        const outcome = await localPublicSnipe({
          nftContract: q.contract,
          quantity,
          walletKeys: addresses.map((a) => ctx.store.getDecryptedKey(a)),
          rpcUrls: urls,
          maxFeePerGas: gweiToWei(settings.maxFeeGwei),
          maxPriorityFee: gweiToWei(settings.priorityGwei),
          gasLimit: settings.gasLimit,
          targetStart: null,
          plan,
          logger,
        });
        await recordOutcome(ctx.store, settings.chainKey, outcome, {
          bot,
          chatId: ctx.chat!.id,
          source: "Manual Mint",
        });
      } catch (err: any) {
        logger.errorBold(`Quick mint failed: ${err?.message ?? err}`);
      }
    }
  });

  // ── OpenSea Mint, owner only ──────────────────────────────────────────
  // The one path that reaches stages whose permission is not on-chain. Each
  // wallet signs in to OpenSea as itself, OpenSea says which stages it may
  // mint, and hands back the transaction — signature or proof already inside
  // the calldata. Firing still goes through the local engine, so the speed
  // work applies here too.
  bot.action("menu:osmint", (ctx) => {
    if (!requireOwner(ctx)) return;
    ctx.session.osmint = undefined;
    ctx.session.step = "awaiting_osmint_target";
    return ctx.editMessageText(
      "🔐 OpenSea Mint\n\n" +
        "Send an OpenSea link or contract address.\n\n" +
        "Each wallet signs in to OpenSea as itself, then I ask which stages it can " +
        "mint — allow-list and signed stages included, since OpenSea issues the " +
        "signature to wallets it considers eligible.\n\n" +
        "Signing in proves ownership only. It moves nothing and approves no spend.",
      Markup.inlineKeyboard([[Markup.button.callback("Cancel", "menu:main")]])
    );
  });

  bot.action("osmint:noop", (ctx) =>
    ctx.answerCbQuery("OpenSea says that wallet isn't eligible.", { show_alert: true })
  );

  bot.action(/^osmint:go:(.+)$/, (ctx) => fireOpenSeaMint(ctx, [ctx.match[1]]));

  bot.action("osmint:all", (ctx) => {
    const eligible = (ctx.session.osmint?.rows ?? []).filter((r) => r.canMint > 0).map((r) => r.wallet);
    if (eligible.length === 0) {
      return ctx.answerCbQuery("No eligible wallet to mint with.", { show_alert: true });
    }
    return fireOpenSeaMint(ctx, eligible);
  });

  /**
   * Fetch fresh calldata and fire it.
   *
   * The calldata is fetched at fire time rather than reused from the
   * eligibility check: it carries a signature that OpenSea issues for a
   * specific wallet and moment, and a stale one is refused on-chain.
   */
  async function fireOpenSeaMint(ctx: BotContext, wallets: string[]): Promise<unknown> {
    if (!requireOwner(ctx)) return;
    const session = ctx.session.osmint;
    if (!session) return ctx.answerCbQuery("That expired — start again.", { show_alert: true });

    await ctx.answerCbQuery("Fetching calldata…");
    const settings = ctx.store.getSettings();
    const chain = resolveChain(settings.chainKey);
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const logger = createLogger(createTelegramSink(bot, ctx.chat!.id));

    for (const address of wallets) {
      const row = session.rows.find((r) => r.wallet.toLowerCase() === address.toLowerCase());
      if (!row || row.canMint < 1) continue;
      try {
        const wallet = new Wallet(ctx.store.getDecryptedKey(address));
        const client = new OpenSeaMintClient();
        await client.login(wallet, chain?.chainId ?? 1);

        const calldata = await client.mintCalldata({
          address: wallet.address,
          contractAddress: session.contract,
          chainIdentifier: settings.chainKey,
          tokenId: "0",
          quantity: row.canMint,
        });

        const outcome = await localPublicSnipe({
          nftContract: session.contract,
          quantity: row.canMint,
          walletKeys: [ctx.store.getDecryptedKey(address)],
          rpcUrls: urls,
          maxFeePerGas: gweiToWei(settings.maxFeeGwei),
          maxPriorityFee: gweiToWei(settings.priorityGwei),
          gasLimit: settings.gasLimit,
          targetStart: null,
          // OpenSea returned a complete transaction, so there is no public
          // drop to read — the engine only needs somewhere to send bytes.
          plan: {
            to: calldata.to,
            data: calldata.data,
            value: calldata.value,
            feeRecipient: calldata.to,
            drop: {
              mintPrice: row.canMint > 0 ? calldata.value / BigInt(row.canMint) : 0n,
              startTime: 0,
              endTime: 0,
              maxTotalMintableByWallet: row.canMint,
              feeBps: 0,
              restrictFeeRecipients: false,
            },
          },
          logger,
        });

        await recordOutcome(ctx.store, settings.chainKey, outcome, {
          bot,
          chatId: ctx.chat!.id,
          source: "Manual Mint",
        });
      } catch (err: any) {
        const kind = err instanceof OpenSeaMintError ? ` (${err.kind})` : "";
        logger.errorBold(`${maskAddress(address)}: ${err?.message ?? err}${kind}`);
      }
    }
    return undefined;
  }

  bot.action("menu:fcfs", (ctx) => {
    if (!requireOwner(ctx)) return;
    const armed = ctx.store.listPendingScheduled().filter((r) => r.allowlist);
    return ctx.editMessageText(
      armed.length > 0
        ? `⚡ ${armed.length} allow-list mint(s) armed. They fire on their own and survive a restart.`
        : "⚡ FCFS / Allowlist\n\nArm a collection and it fires the moment its stage opens — " +
            "no website, no wallet connect. Merkle stages only; a signed stage needs a " +
            "signature only the project can issue.",
      fcfsMenu(armed)
    );
  });

  bot.action("fcfs:add", (ctx) => {
    if (!requireOwner(ctx)) return;
    ctx.session.step = "awaiting_allowlist_json";
    ctx.session.allowlistContract = undefined;
    return ctx.reply(
      "Send the contract address.\n\n" +
        "I'll look for the published allow list on-chain and derive your proof. " +
        "If the project publishes no URI, paste the proof JSON instead."
    );
  });

  bot.action(/^fcfs:view:(.+)$/, (ctx) => {
    if (!requireOwner(ctx)) return;
    const record = ctx.store.listScheduled().find((r) => r.id === ctx.match[1]);
    if (!record) return ctx.answerCbQuery("That's gone.", { show_alert: true });
    const when = new Date(record.targetStartMs);
    return ctx.editMessageText(
      `⚡ ${record.name || record.nftContract}\n\n` +
        `Contract: ${record.nftContract}\n` +
        `Quantity: ${record.quantity} x ${record.wallets.length} wallet(s)\n` +
        `Fires: ${toIST(when)} IST\n` +
        `Proof: ${record.allowlist?.proof.length ?? 0} hashes, verified against the on-chain root`,
      fcfsViewMenu(record.id)
    );
  });

  bot.action(/^fcfs:cancel:(.+)$/, (ctx) => {
    if (!requireOwner(ctx)) return;
    ctx.store.removeScheduled(ctx.match[1]);
    const armed = ctx.store.listPendingScheduled().filter((r) => r.allowlist);
    return ctx.editMessageText("Cancelled.", fcfsMenu(armed));
  });

  bot.action("fcfs:arm", async (ctx) => {
    if (!requireOwner(ctx)) return;
    const ready = ctx.session.allowlistReady;
    ctx.session.allowlistReady = undefined;
    if (!ready) return ctx.answerCbQuery("That expired — arm it again.", { show_alert: true });

    const params = JSON.parse(ready.params);
    const startMs = Number(params.startTime) * 1000;
    // The stage carries its own opening time, so there is nothing to ask for:
    // if it has already opened, firing now IS the right target.
    const targetStartMs = startMs > Date.now() ? startMs : Date.now();

    const settings = ctx.store.getSettings();
    const info = await openseaContractInfo(settings.chainKey, ready.contract, process.env.OPENSEA_API_KEY).catch(
      () => null
    );

    const record = ctx.store.addScheduled({
      chainKey: settings.chainKey,
      nftContract: ready.contract,
      name: info?.name,
      slug: info?.slug,
      quantity: ready.quantity,
      wallets: ready.wallets,
      targetStartMs,
      allowlist: { proof: ready.proof, params: ready.params },
    });

    void runScheduled(ctx.store, record.id, ctx.chat!.id);

    await ctx.answerCbQuery("Armed.");
    return ctx.editMessageText(
      `⚡ Armed: ${record.name || record.nftContract}\n\n` +
        `Fires ${toIST(new Date(targetStartMs))} IST with ${record.wallets.length} wallet(s).\n` +
        "Pre-signed and sockets held warm through the wait. Survives a restart.",
      fcfsMenu(ctx.store.listPendingScheduled().filter((r) => r.allowlist))
    );
  });

  bot.action("allowlist:fire", async (ctx) => {
    if (!requireOwner(ctx)) return;
    const ready = ctx.session.allowlistReady;
    ctx.session.allowlistReady = undefined;
    if (!ready) return ctx.answerCbQuery("That expired — run /allowlist again.", { show_alert: true });

    await ctx.answerCbQuery("Firing...");
    const settings = ctx.store.getSettings();
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const logger = createLogger(createTelegramSink(bot, ctx.chat!.id));

    // Revive the params the session had to flatten to strings.
    const raw = JSON.parse(ready.params);
    const params: MintParams = {
      mintPrice: BigInt(raw.mintPrice),
      maxTotalMintableByWallet: BigInt(raw.maxTotalMintableByWallet),
      startTime: BigInt(raw.startTime),
      endTime: BigInt(raw.endTime),
      dropStageIndex: BigInt(raw.dropStageIndex),
      maxTokenSupplyForStage: BigInt(raw.maxTokenSupplyForStage),
      feeBps: BigInt(raw.feeBps),
      restrictFeeRecipients: Boolean(raw.restrictFeeRecipients),
    };

    try {
      const fee = await raceRead(urls, (url) => resolveFeeRecipient(url, ready.contract, params.restrictFeeRecipients));
      if (!fee) {
        return ctx.reply("Couldn't resolve an allowed fee recipient for that collection — nothing sent.");
      }

      const encoded = encodeMintAllowList(ready.contract, fee.address, ready.quantity, params, ready.proof);

      // Reuse the public-mint engine: it pre-signs, keeps sockets warm and
      // blasts every endpoint in parallel. Only the calldata differs, so the
      // stage terms are presented in the shape it already understands.
      const outcome = await localPublicSnipe({
        nftContract: ready.contract,
        quantity: ready.quantity,
        walletKeys: ready.wallets.map((a) => ctx.store.getDecryptedKey(a)),
        rpcUrls: urls,
        maxFeePerGas: gweiToWei(settings.maxFeeGwei),
        maxPriorityFee: gweiToWei(settings.priorityGwei),
        gasLimit: settings.gasLimit,
        targetStart: null,
        plan: {
          to: encoded.to,
          data: encoded.data,
          value: encoded.value,
          feeRecipient: fee.address,
          drop: {
            mintPrice: params.mintPrice,
            startTime: Number(params.startTime),
            endTime: Number(params.endTime),
            maxTotalMintableByWallet: Number(params.maxTotalMintableByWallet),
            feeBps: Number(params.feeBps),
            restrictFeeRecipients: params.restrictFeeRecipients,
          },
        },
        logger,
      });

      await recordOutcome(ctx.store, settings.chainKey, outcome, {
        bot,
        chatId: ctx.chat!.id,
        source: "Manual Mint",
      });
    } catch (err: any) {
      logger.errorBold(`Allow-list mint failed: ${err?.message ?? err}`);
    }
  });

  /**
   * Look up a collection's allow list and derive a proof for our wallets.
   *
   * Shared by /allowlist and the FCFS menu, which differ only in how the
   * contract address arrives.
   */
  async function startAllowListFlow(ctx: BotContext, contract: string): Promise<unknown> {

    const { urls } = resolveRpcsForChain(ctx.store.getSettings().chainKey);
    const root = await raceReadOrNull(urls, (url) => fetchAllowListRoot(url, contract));
    if (!root) {
      const stages = await explainNoPublicDrop(ctx.store.getSettings().chainKey, contract);
      return ctx.reply(
        "That collection has no Merkle allow-list stage.\n\n" + stages
      );
    }

    // Try to derive it ourselves first. SeaDrop puts a pointer to the
    // published list on-chain, so in the common case the user never has to
    // find a proof at all.
    const note = await ctx.reply("Looking for the published allow list on-chain…");
    const found = await raceReadOrNull(urls, (url) => findAllowListUri(url, contract));
    if (found) {
      try {
        const entries = parseAllowList(await fetchAllowList(found.uri));
        const lines: string[] = [];
        let ready: { wallet: string; derived: NonNullable<ReturnType<typeof deriveProof>> } | null = null;

        for (const wallet of ctx.store.listWallets()) {
          const derived = deriveProof(entries, wallet.address, root);
          if (!derived) {
            lines.push(`  ⛔ ${maskAddress(wallet.address)} — not on the list`);
          } else if (!derived.matchesChain) {
            // Our tree doesn't reproduce the stored root, so the proof would
            // revert. Either the list moved on or the encoding is off.
            lines.push(`  ⚠️ ${maskAddress(wallet.address)} — list doesn't match the on-chain root`);
          } else {
            lines.push(`  ✅ ${maskAddress(wallet.address)} — proof derived`);
            if (!ready) ready = { wallet: wallet.address, derived };
          }
        }

        if (ready) {
          const quantity = Number(ready.derived.params.maxTotalMintableByWallet);
          ctx.session.allowlistReady = {
            contract,
            wallets: [ready.wallet],
            params: JSON.stringify(ready.derived.params, (_k, v) =>
              typeof v === "bigint" ? v.toString() : v
            ),
            proof: ready.derived.proof,
            quantity,
          };
          return ctx.telegram
            .editMessageText(
              note.chat.id,
              note.message_id,
              undefined,
              `Found the list (${entries.length} entries).\n\n${lines.join("\n")}\n\n` +
                `Mint ${quantity} from the allow-list stage?`,
              fcfsArmMenu()
            )
            .catch(() => {});
        }

        await ctx.reply(
          `Found the list (${entries.length} entries), but no wallet here can use it:\n\n${lines.join("\n")}`
        );
      } catch (err: any) {
        await ctx.reply(`Found a list at ${found.uri} but couldn't use it: ${err?.message ?? err}`);
      }
    }

    ctx.session.allowlistContract = contract;
    ctx.session.step = "awaiting_allowlist_json";
    return ctx.reply(
      `Allow-list stage found (root ${root.slice(0, 14)}…).\n\n` +
        "Send the proof and stage terms as JSON — the project publishes these:\n\n" +
        '{"proof":["0x…","0x…"],"mintParams":{"mintPrice":"0","maxTotalMintableByWallet":2,' +
        '"startTime":0,"endTime":0,"dropStageIndex":1,"maxTokenSupplyForStage":0,"feeBps":1000,' +
        '"restrictFeeRecipients":true}}\n\n' +
        "I'll verify it against that root before anything is sent."
    );
  }

  bot.command("allowlist", async (ctx) => {
    // Owner only: this mints against terms from a published list rather
    // than from the chain's own public drop.
    if (!requireOwner(ctx)) return;
    const contract = ctx.message.text.split(/\s+/)[1]?.trim();
    if (!contract || !isAddress(contract)) {
      return ctx.reply(
        "Usage: /allowlist <contract address>\n\n" +
          "I look for the published allow list on-chain and derive your proof. " +
          "If the project publishes no URI, I'll ask you to paste it."
      );
    }
    return startAllowListFlow(ctx, contract);
  });

  bot.command("mint", async (ctx) => {
    const rawArgs = ctx.message.text.split(/\s+/).slice(1);
    const dryRun = rawArgs.includes("--dry");
    const args = rawArgs.filter((a) => a !== "--dry");
    const [link, qtyRaw, walletFilter] = args;
    const requestedQuantity = parseInt(qtyRaw ?? "1", 10);
    if (!link || !Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
      return ctx.reply("Usage: /mint <contract address, OpenSea link, or slug> <quantity> [wallet label(s)] [--dry]");
    }

    const allWallets = ctx.store.listWallets();
    const settings = ctx.store.getSettings();
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
      if (!preview) return ctx.reply(await explainNoPublicDrop(ctx.store.getSettings().chainKey, contract));
      const dropMax = preview.drop.maxTotalMintableByWallet;
      const quantity = dropMax > 0 ? Math.min(dropMax, requestedQuantity) : requestedQuantity;
      if (quantity < requestedQuantity) {
        await ctx.reply(`Capped to ${quantity}/wallet — this drop's real max is ${dropMax}.`);
      }

      const plan = await buildLocalMintPlan(urls[0], contract, quantity);
      if (!plan) return ctx.reply(await explainNoPublicDrop(ctx.store.getSettings().chainKey, contract));

      if (dryRun) {
        const chain = resolveChain(settings.chainKey)!;
        const perWallet = await previewMint(
          urls[0],
          chain.nativeSymbol,
          wallets,
          settings.gasLimit,
          await resolveFeeCeiling(settings, urls),
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
        walletKeys: wallets.map((w) => ctx.store.getDecryptedKey(w.address)),
        rpcUrls: urls,
        maxFeePerGas: gweiToWei(settings.maxFeeGwei),
        maxPriorityFee: gweiToWei(settings.priorityGwei),
        gasLimit: settings.gasLimit,
        targetStart: null,
        plan,
        logger,
      });
      await recordOutcome(ctx.store, settings.chainKey, outcome, {
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
    const wallets = ctx.store.listWallets();
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
    return ctx.editMessageText("Mint FROM which wallet(s)? Tap to select, then Done.", schedWalletsMenu(ctx.store.listWallets(), selected));
  });

  bot.action("sched:wallets:done", async (ctx) => {
    if (!ctx.session.schedWallets || ctx.session.schedWallets.length === 0) {
      return ctx.answerCbQuery("Select at least one wallet.", { show_alert: true });
    }
    ctx.session.step = "awaiting_sched_quantity";
    const max = ctx.session.schedDropMax ?? 0;

    // Per-wallet eligibility, read from the chain before anything is armed.
    // The cap is only half the story: a wallet that already minted its limit,
    // or a collection with less supply left than the cap, both revert.
    let eligibility = "";
    const contract = ctx.session.schedContract;
    if (contract && max > 0) {
      const { urls } = resolveRpcsForChain(ctx.store.getSettings().chainKey);
      const lines: string[] = [];
      for (const address of ctx.session.schedWallets ?? []) {
        try {
          const e = await raceRead(urls, (url) => checkEligibility(url, contract, address, max));
          lines.push("  " + describeEligibility(address, e));
        } catch {
          lines.push(`  ${address.slice(0, 8)}… (couldn't check)`);
        }
      }
      if (lines.length > 0) eligibility = `\n\nEligibility right now:\n${lines.join("\n")}`;
    }

    return ctx.reply(
      `How many per wallet? (drop's real max is ${max > 0 ? max : "unspecified"} — you'll never exceed it)${eligibility}`
    );
  });

  bot.action("sched:cancel", (ctx) => {
    resetSchedSession(ctx);
    return ctx.editMessageText("Cancelled.", menuFor(ctx));
  });

  /**
   * Arm a scheduled mint.
   *
   * The wait is deliberately NOT awaited here. Telegraf wraps every handler in
   * a 90-second timeout (`handlerTimeout`), so awaiting a stage that opens
   * hours from now guaranteed "Promise timed out after 90000 milliseconds" —
   * the mint kept running in the background, but the user was told it failed.
   * The work is detached and reports its own progress by message instead.
   */
  async function fireScheduled(ctx: BotContext, targetStart: Date | null): Promise<void> {
    const { schedContract, schedWallets, schedQuantity } = ctx.session;
    if (!schedContract || !schedWallets?.length || !schedQuantity) {
      await ctx.answerCbQuery("That request expired — start over from Scheduled Mint.", { show_alert: true });
      return;
    }
    resetSchedSession(ctx);
    await ctx.answerCbQuery(targetStart ? "Scheduled." : "Firing...");

    const settings = ctx.store.getSettings();
    const chatId = ctx.chat!.id;

    // Name and link, best-effort: a contract address alone is unreadable when
    // the confirmation arrives hours later.
    const info = await openseaContractInfo(settings.chainKey, schedContract, process.env.OPENSEA_API_KEY).catch(
      () => null
    );

    const record = ctx.store.addScheduled({
      chainKey: settings.chainKey,
      nftContract: schedContract,
      name: info?.name,
      slug: info?.slug,
      quantity: schedQuantity,
      wallets: [...schedWallets],
      targetStartMs: targetStart ? targetStart.getTime() : Date.now(),
    });

    await ctx.editMessageText(
      describeScheduled(record, targetStart) +
        (targetStart ? "\n\nIt survives a restart — I'll report here when it fires." : "")
    );

    void runScheduled(ctx.store, record.id, chatId);
  }

  /** Human-readable summary of an armed mint. */
  function describeScheduled(record: ScheduledMint, targetStart: Date | null): string {
    const lines = [
      record.name ? `📌 ${record.name}` : `📌 ${record.nftContract}`,
      record.slug ? openseaCollectionUrl(record.slug) : "",
      "",
      `Contract: ${record.nftContract}`,
      `Quantity: ${record.quantity} per wallet · ${record.wallets.length} wallet(s)`,
      targetStart ? `Fires: ${toIST(targetStart)} IST` : "Firing now.",
    ];
    return lines.filter((l) => l !== "").join("\n");
  }

  /**
   * Run one armed mint to completion. Detached from any handler, so it may
   * wait for hours; every outcome is reported to the chat and written back to
   * the record, which is what makes a restart able to pick this up again.
   */
  /** Revive stored allow-list terms — the store flattens bigints to strings. */
  function revivedParams(json: string): MintParams {
    const raw = JSON.parse(json);
    return {
      mintPrice: BigInt(raw.mintPrice),
      maxTotalMintableByWallet: BigInt(raw.maxTotalMintableByWallet),
      startTime: BigInt(raw.startTime),
      endTime: BigInt(raw.endTime),
      dropStageIndex: BigInt(raw.dropStageIndex),
      maxTokenSupplyForStage: BigInt(raw.maxTokenSupplyForStage),
      feeBps: BigInt(raw.feeBps),
      restrictFeeRecipients: Boolean(raw.restrictFeeRecipients),
    };
  }

  /**
   * A mint plan for an allow-list stage, shaped like the public one so the
   * same firing engine handles both. Only the calldata differs.
   */
  async function buildAllowListPlan(
    urls: string[],
    record: ScheduledMint
  ): Promise<LocalMintPlan | null> {
    if (!record.allowlist) return null;
    const params = revivedParams(record.allowlist.params);
    const fee = await raceRead(urls, (url) =>
      resolveFeeRecipient(url, record.nftContract, params.restrictFeeRecipients)
    );
    if (!fee) return null;

    const encoded = encodeMintAllowList(
      record.nftContract,
      fee.address,
      record.quantity,
      params,
      record.allowlist.proof
    );
    return {
      to: encoded.to,
      data: encoded.data,
      value: encoded.value,
      feeRecipient: fee.address,
      drop: {
        mintPrice: params.mintPrice,
        startTime: Number(params.startTime),
        endTime: Number(params.endTime),
        maxTotalMintableByWallet: Number(params.maxTotalMintableByWallet),
        feeBps: Number(params.feeBps),
        restrictFeeRecipients: params.restrictFeeRecipients,
      },
    };
  }

  async function runScheduled(store: TelegramStore, id: string, chatId: number): Promise<void> {
    const record = store.listScheduled().find((r) => r.id === id);
    if (!record || record.status !== "pending") return;

    const settings = store.getSettings();
    const { urls } = resolveRpcsForChain(record.chainKey);
    const logger = createLogger(createTelegramSink(bot, chatId));
    const label = record.name || record.nftContract;

    try {
      // An allow-list record carries its own proof and stage terms, so the
      // plan is built from those rather than read from the public drop.
      // Nothing is fetched at fire time: a list lookup on the critical path
      // would undo the whole point of arming it in advance.
      const plan = record.allowlist
        ? await buildAllowListPlan(urls, record)
        : await buildLocalMintPlan(urls[0], record.nftContract, record.quantity);

      if (!plan) {
        store.updateScheduled(id, { status: "failed", note: "drop not resolvable on-chain" });
        logger.errorBold(`${label}: drop is no longer resolvable on-chain — nothing fired.`);
        return;
      }

      const targetStart = record.targetStartMs > Date.now() ? new Date(record.targetStartMs) : null;
      const outcome = await localPublicSnipe({
        nftContract: record.nftContract,
        quantity: record.quantity,
        walletKeys: record.wallets.map((addr) => store.getDecryptedKey(addr)),
        rpcUrls: urls,
        maxFeePerGas: gweiToWei(settings.maxFeeGwei),
        maxPriorityFee: gweiToWei(settings.priorityGwei),
        gasLimit: settings.gasLimit,
        targetStart,
        plan,
        logger,
      });

      store.updateScheduled(id, {
        status: outcome.minted.length > 0 ? "fired" : "failed",
        note: outcome.minted.length > 0 ? `${outcome.minted.length} wallet(s) minted` : "no confirmed mint",
      });
      await recordOutcome(store, record.chainKey, outcome, { bot, chatId, source: "Scheduled Mint" });
    } catch (err: any) {
      store.updateScheduled(id, { status: "failed", note: err?.message ?? String(err) });
      logger.errorBold(`${label}: scheduled mint failed — ${err?.message ?? err}`);
    }
  }

  /**
   * Re-arm everything still pending after a restart.
   *
   * Without this a redeploy silently dropped every armed mint: the record
   * said "pending" forever and nothing was waiting on it.
   */
  function rearmScheduled(userId: number): number {
    const store = stores.for(userId);
    const pending = store.listPendingScheduled();
    for (const record of pending) {
      // Long past its moment and clearly missed while the process was down —
      // say so rather than firing into a stage that closed hours ago.
      if (record.targetStartMs < Date.now() - 60 * 60 * 1000) {
        store.updateScheduled(record.id, { status: "failed", note: "missed while the bot was offline" });
        continue;
      }
      void runScheduled(store, record.id, userId);
    }
    return pending.length;
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
    const settings = ctx.store.getSettings();
    const chain = resolveChain(settings.chainKey)!;
    const { urls } = resolveRpcsForChain(settings.chainKey);
    try {
      const plan = await buildLocalMintPlan(urls[0], schedContract, schedQuantity);
      if (!plan) return ctx.reply("🧪 DRY RUN: drop is not currently resolvable on-chain — a real fire would fail.");

      const wallets = ctx.store.listWallets().filter((w) => schedWallets.includes(w.address.toLowerCase()));
      const perWallet = await previewMint(
        urls[0],
        chain.nativeSymbol,
        wallets,
        settings.gasLimit,
        await resolveFeeCeiling(settings, urls),
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
  // Restore uploads. Validation happens on the SNAPSHOT, before anything is
  // written — see importSnapshot — so a bad file costs nothing but a message.
  /**
   * Why a contract has no public drop, in terms the user can act on.
   *
   * "No public drop found" is true and useless: the collection often has an
   * allow-list or signed stage that is live right now. Naming it turns a dead
   * end into "go and get the signature".
   */
  async function explainNoPublicDrop(chainKey: string, nftContract: string): Promise<string> {
    const { urls } = resolveRpcsForChain(chainKey);
    try {
      const stages = await raceRead(urls, (url) => readStages(url, nftContract));
      return `No public stage on that contract.\n\n${describeStages(stages)}`;
    } catch {
      return "No public drop found for that contract on the configured chain.";
    }
  }

  bot.on(message("document"), async (ctx) => {
    if (ctx.session.step !== "awaiting_restore_file") return;
    if (!requireOwner(ctx)) return;
    ctx.session.step = undefined;

    const doc = ctx.message.document;
    // A store this large is not a store; refuse before pulling it down.
    if ((doc.file_size ?? 0) > 25 * 1024 * 1024) {
      return ctx.reply("That file is too large to be a backup of this bot.");
    }

    let snapshot: string;
    try {
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const res = await fetch(link.toString());
      snapshot = await res.text();
    } catch (err: any) {
      return ctx.reply(`❌ Couldn't download that file: ${err?.message ?? err}`);
    }

    // Parse and check it now, so the confirmation can state what will happen
    // rather than asking the user to approve something unexamined.
    let summary: { wallets: number; targets: number; seeds: number };
    try {
      const parsed = JSON.parse(snapshot);
      if (!Array.isArray(parsed?.wallets)) throw new Error("no wallet list in it");
      summary = {
        wallets: parsed.wallets.length,
        targets: (parsed.copyTargets ?? []).length,
        seeds: (parsed.seeds ?? []).length,
      };
    } catch (err: any) {
      return ctx.reply(`❌ That doesn't look like a backup of this bot (${err?.message ?? err}).`);
    }

    ctx.session.pendingRestore = snapshot;
    const current = ctx.store.listWallets().length;
    return ctx.reply(
      `♻️ This backup holds ${summary.wallets} wallet(s), ${summary.targets} watched wallet(s), ` +
        `${summary.seeds} seed phrase(s).\n\n` +
        (current > 0
          ? `⚠️ It REPLACES the ${current} wallet(s) currently here. The replaced store is kept on disk, but ` +
            "anything added since your last backup is gone."
          : "Nothing here yet, so nothing is lost.") +
        "\n\nKeys are verified against this server's encryption key before anything changes.",
      restoreConfirmMenu()
    );
  });

  bot.on(message("text"), async (ctx) => {
    const step = ctx.session.step;
    if (!step) return; // not mid-flow — ignore free text rather than guess intent

    if (step === "awaiting_wallet_key") {
      const key = ctx.message.text.trim();
      await ctx.deleteMessage(ctx.message.message_id).catch(() => {});
      ctx.session.step = undefined;
      try {
        const record = ctx.store.addWallet("", key);
        await ctx.reply(`✅ Added ${maskAddress(record.address)} (label: ${record.label}).`, menuFor(ctx));
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
      // Stored so it can be read back later. A phrase shown once and never
      // again is not a backup — see SeedRecord in store.ts.
      const seed = ctx.store.addSeed(phrase);
      const added: string[] = [];
      let dupes = 0;
      for (const w of deriveWallets(phrase, count)) {
        try {
          ctx.store.addWallet(`seed-${w.index}`, w.privateKey, { seedId: seed.id, derivationIndex: w.index });
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
          "It restores every wallet above in MetaMask, Rabby or Ledger, and anyone who " +
          "reads it can take everything in them. You can see it again under " +
          "Wallets → 🌱 Seed phrases — but keep an offline copy anyway.",
        menuFor(ctx)
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
      const seed = ctx.store.addSeed(phrase, "imported");
      for (const w of deriveWallets(phrase, count)) {
        try {
          ctx.store.addWallet(`seed-${w.index}`, w.privateKey, { seedId: seed.id, derivationIndex: w.index });
          added.push(w.address);
        } catch {
          dupes++;
        }
      }
      return ctx.reply(
        `✅ Imported ${added.length} wallet(s)${dupes ? ` (${dupes} already added)` : ""}.\n\n` +
          added.map((a, i) => `${i + 1}. ${a}`).join("\n") +
          "\n\nThey mint on copy signals automatically. Fund them before the next drop.",
        menuFor(ctx)
      );
    }

    if (step === "awaiting_agent_question") {
      ctx.session.step = undefined;
      if (ctx.from!.id !== ownerId) return;
      await runAsk(ctx, ctx.message.text.trim());
      return;
    }

    if (step === "awaiting_osmint_target") {
      ctx.session.step = undefined;
      if (!requireOwner(ctx)) return;

      const settings = ctx.store.getSettings();
      const chain = resolveChain(settings.chainKey);
      const note = await ctx.reply("Signing in and checking eligibility…");
      const say = (text: string, extra?: any) =>
        ctx.telegram.editMessageText(note.chat.id, note.message_id, undefined, text, extra).catch(() => {});

      let contract: string;
      try {
        contract = await resolveMintTarget(ctx.message.text.trim(), settings.chainKey);
      } catch (err: any) {
        return say(`Couldn't read that as a collection: ${err?.message ?? err}`);
      }

      // The eligibility query is keyed by slug, so a contract address has to
      // be turned into one first. A collection link carries the slug in its
      // URL and skips this entirely, which is the reliable route when
      // OpenSea is throttling the lookup — so say that rather than implying
      // the collection does not exist.
      const lookup = await lookupContract(settings.chainKey, contract, process.env.OPENSEA_API_KEY);
      if (isLookupFailure(lookup)) {
        return say(
          `Couldn't turn that contract into an OpenSea collection.\n\n${lookup.detail}.\n\n` +
            "Send the OpenSea collection link instead — the slug is in the URL, so it needs no lookup."
        );
      }
      const info = lookup;

      const wallets = ctx.store.listWallets();
      if (wallets.length === 0) return say("Add a wallet first.");

      // One sign-in per wallet: eligibility is a property of the address, so
      // each has to authenticate as itself. Done sequentially to stay well
      // inside OpenSea's rate limit — this runs before the race, not during.
      const rows: { wallet: string; label: string; stageType: string; canMint: number; reason?: string }[] = [];
      for (const w of wallets) {
        try {
          const client = new OpenSeaMintClient();
          await client.login(new Wallet(ctx.store.getDecryptedKey(w.address)), chain?.chainId ?? 1);
          const stages = await client.eligibility(info.slug, w.address);
          const usable = stages.filter((s) => s.isEligible);
          if (usable.length === 0) {
            rows.push({ wallet: w.address, label: w.label, stageType: "—", canMint: 0, reason: "no eligible stage" });
            continue;
          }
          // Best available: the stage allowing the most, since they are
          // mutually exclusive at any one moment anyway.
          const best = usable.reduce((a, b) =>
            (b.eligibleMaxTotalMintableByWallet ?? b.maxTotalMintableByWallet ?? 1) >
            (a.eligibleMaxTotalMintableByWallet ?? a.maxTotalMintableByWallet ?? 1)
              ? b
              : a
          );
          rows.push({
            wallet: w.address,
            label: w.label,
            stageType: best.stageType,
            canMint: best.eligibleMaxTotalMintableByWallet ?? best.maxTotalMintableByWallet ?? 1,
          });
        } catch (err: any) {
          rows.push({
            wallet: w.address,
            label: w.label,
            stageType: "—",
            canMint: 0,
            reason: err instanceof OpenSeaMintError ? err.kind : "check failed",
          });
        }
      }

      ctx.session.osmint = { contract, slug: info.slug, name: info.name, rows };
      const eligible = rows.filter((r) => r.canMint > 0).length;
      return say(
        `🔐 ${info.name ?? info.slug}\n\n` +
          (eligible > 0
            ? `${eligible} of ${rows.length} wallet(s) eligible. Calldata is fetched fresh when you fire — ` +
              "a signature is issued for one wallet and moment."
            : "No wallet is eligible for any stage right now."),
        osMintStagesMenu(rows)
      );
    }

    if (step === "awaiting_quick_target") {
      ctx.session.step = undefined;
      const note = await ctx.reply("Checking the stage and your wallets…");

      const settings = ctx.store.getSettings();
      const { urls } = resolveRpcsForChain(settings.chainKey);
      const say = (text: string, extra?: any) =>
        ctx.telegram.editMessageText(note.chat.id, note.message_id, undefined, text, extra).catch(() => {});

      let contract: string;
      try {
        contract = await resolveMintTarget(ctx.message.text.trim(), settings.chainKey);
      } catch (err: any) {
        return say(`Couldn't read that as a collection: ${err?.message ?? err}`);
      }

      const plan = await raceReadOrNull(urls, (url) => buildLocalMintPlan(url, contract, 1));
      if (!plan) {
        return say(await explainNoPublicDrop(settings.chainKey, contract));
      }

      // A stage that hasn't opened is not a Quick Mint — it's a scheduled one,
      // and saying so is more useful than a revert.
      const window = stageWindow(plan.drop.startTime, plan.drop.endTime);
      if (!window.live) {
        return say(
          window.ended
            ? "That stage has already ended."
            : `That stage opens in ${Math.ceil(window.opensInMs / 60000)} minute(s). ` +
                "Use Scheduled Mint to arm it instead."
        );
      }

      const wallets = ctx.store.listWallets();
      if (wallets.length === 0) return say("Add a wallet first.");

      const ready = await Promise.all(
        wallets.map(async (w) => {
          const [balance, elig] = await Promise.all([
            raceRead(readableRpcs(urls), (url) => createProvider(url).getBalance(w.address)).catch(() => null),
            raceRead(urls, (url) =>
              checkEligibility(url, contract, w.address, plan.drop.maxTotalMintableByWallet)
            ).catch(() => null),
          ]);
          const r = assessWallet(w.address, {
            balanceWei: balance,
            mintPriceWei: plan.drop.mintPrice,
            maxFeePerGas: gweiToWei(settings.maxFeeGwei),
            gasLimit: settings.gasLimit,
            maxPerWallet: plan.drop.maxTotalMintableByWallet,
            alreadyMinted: elig?.alreadyMinted ?? 0,
            supplyRemaining: elig?.supplyRemaining ?? plan.drop.maxTotalMintableByWallet,
          });
          return { address: w.address, label: w.label, canMint: r.canMint, reason: r.reason };
        })
      );

      const info = await openseaContractInfo(settings.chainKey, contract, process.env.OPENSEA_API_KEY).catch(
        () => null
      );
      ctx.session.quick = {
        contract,
        name: info?.name,
        slug: info?.slug,
        priceWei: plan.drop.mintPrice.toString(),
        maxPerWallet: plan.drop.maxTotalMintableByWallet,
        ready,
        chosen: ready.filter((r) => r.canMint > 0).map((r) => r.address.toLowerCase()),
      };

      const usable = ready.filter((r) => r.canMint > 0).length;
      if (usable === 0) {
        return say(
          `🔴 No wallet can mint ${info?.name ?? contract} right now:\n\n` +
            ready.map((r) => `  ⛔ ${r.label} — ${r.reason ?? "can't mint"}`).join("\n")
        );
      }

      // Every eligible wallet is pre-selected: the common case is "all of
      // them", and a live stage is the wrong moment to make someone tick boxes.
      return say(
        `🟢 LIVE — ${info?.name ?? contract}\n` +
          `${plan.drop.mintPrice === 0n ? "FREE" : formatEther(plan.drop.mintPrice) + " ETH"} · ` +
          `max ${plan.drop.maxTotalMintableByWallet} per wallet\n\n` +
          "Tap to deselect any wallet, then Continue.",
        quickWalletsMenu(ready, new Set(ctx.session.quick.chosen))
      );
    }

    if (step === "awaiting_quick_quantity") {
      ctx.session.step = undefined;
      const q = ctx.session.quick;
      if (!q) return ctx.reply("That expired — start Quick Mint again.");
      const raw = ctx.message.text.trim().toLowerCase();
      const usable = q.ready.filter((r) => q.chosen.includes(r.address.toLowerCase()));
      const most = Math.max(...usable.map((r) => r.canMint));
      const wanted = raw === "max" ? most : parseInt(raw, 10);
      if (!Number.isFinite(wanted) || wanted < 1) return ctx.reply('Send a number, or "max".');
      q.quantity = Math.min(wanted, most);
      if (wanted > most) await ctx.reply(`Capped to ${most} — that's the most any chosen wallet can take.`);
      return showQuickConfirm(ctx);
    }

    if (step === "awaiting_allowlist_json") {
      ctx.session.step = undefined;
      if (!requireOwner(ctx)) return;
      const typed = ctx.message.text.trim();

      // Arriving from the FCFS menu there is no contract yet — a bare address
      // means "go and find the list yourself", which is the common case.
      if (!ctx.session.allowlistContract && isAddress(typed)) {
        return startAllowListFlow(ctx, typed);
      }

      const contract = ctx.session.allowlistContract;
      ctx.session.allowlistContract = undefined;
      if (!contract) {
        return ctx.reply(
          "Send a contract address to look the list up, or run /allowlist <contract> first to paste a proof."
        );
      }

      let parsed;
      try {
        parsed = parseAllowListInput(ctx.message.text);
      } catch (err: any) {
        return ctx.reply(`❌ ${err.message}`);
      }

      const settings = ctx.store.getSettings();
      const { urls } = resolveRpcsForChain(settings.chainKey);
      const wallets = ctx.store.listWallets();
      if (wallets.length === 0) return ctx.reply("Add a wallet first.");

      // Checked per wallet: a proof is issued for one address, so the answer
      // differs across your wallets and the wrong one reverts.
      const lines: string[] = [];
      const eligible: string[] = [];
      for (const wallet of wallets) {
        try {
          const check = await raceRead(urls, (url) =>
            checkAllowListProof(url, contract, wallet.address, parsed.params, parsed.proof)
          );
          if (check.ok) {
            eligible.push(wallet.address);
            lines.push(`  ✅ ${maskAddress(wallet.address)} — proof valid`);
          } else {
            lines.push(`  ⛔ ${maskAddress(wallet.address)} — ${check.reason}`);
          }
        } catch (err: any) {
          lines.push(`  ? ${maskAddress(wallet.address)} — couldn't check (${describeRpcError(err)})`);
        }
      }

      if (eligible.length === 0) {
        return ctx.reply(
          `No wallet here matches that proof.\n\n${lines.join("\n")}\n\n` +
            "A proof is issued for one specific address and one set of stage terms — check you " +
            "pasted the one for a wallet this bot holds."
        );
      }

      const quantity = Number(parsed.params.maxTotalMintableByWallet);
      ctx.session.allowlistReady = {
        contract,
        wallets: eligible,
        // BigInt doesn't survive the session's plain-JSON shape.
        params: JSON.stringify(parsed.params, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
        proof: parsed.proof,
        quantity,
      };

      const priceEth = formatEther(parsed.params.mintPrice * BigInt(quantity));
      return ctx.reply(
        `${lines.join("\n")}\n\n` +
          `Mint ${quantity} per wallet from the allow-list stage, ${eligible.length} wallet(s)?\n` +
          `Cost: ${priceEth} ETH per wallet plus gas.`,
        fcfsArmMenu()
      );
    }

    if (step === "awaiting_copy_target") {
      ctx.session.step = undefined;
      const tokens = ctx.message.text.trim().split(/[\s,]+/).filter(Boolean);
      const addresses = tokens.filter((t) => isAddress(t));

      if (addresses.length === 0) {
        return ctx.reply("I couldn't find a valid address in that. Paste one or more 0x… addresses.");
      }

      // One address plus trailing words is the single-add case, where those
      // words are its label. Several addresses is a bulk paste, and stray
      // words in it are ignored rather than becoming a label for whichever
      // address happened to come first.
      const bulk = addresses.length > 1;
      const label = bulk ? "" : tokens.filter((t) => !isAddress(t)).join(" ");

      const added: string[] = [];
      const already: string[] = [];
      for (const address of addresses) {
        try {
          added.push(ctx.store.addCopyTarget(label, address).address);
        } catch {
          already.push(address); // addCopyTarget rejects duplicates by design
        }
      }

      const skipped = tokens.length - addresses.length;
      const lines = [`✅ Watching ${added.length} new wallet(s).`];
      if (already.length) lines.push(`${already.length} already on the list.`);
      if (bulk && skipped > 0) lines.push(`${skipped} item(s) weren't valid addresses and were ignored.`);
      lines.push("", `Total watched: ${ctx.store.listCopyTargets().length}`);
      await ctx.reply(
        lines.join("\n"),
        copyMenu(ctx.store.getSettings().copyMintEnabled, ctx.store.listCopyTargets())
      );
      return;
    }

    if (step === "awaiting_sched_link") {
      ctx.session.step = undefined;
      const link = ctx.message.text.trim();
      const settings = ctx.store.getSettings();
      try {
        const contract = await resolveMintTarget(link, settings.chainKey);
        const { urls } = resolveRpcsForChain(settings.chainKey);
        const preview = await buildLocalMintPlan(urls[0], contract, 1);
        if (!preview) return ctx.reply(await explainNoPublicDrop(ctx.store.getSettings().chainKey, contract));

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
        await ctx.reply("Mint FROM which wallet(s)? Tap to select, then Done.", schedWalletsMenu(ctx.store.listWallets(), new Set()));
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

    if (step === "awaiting_copy_label") {
      ctx.session.step = undefined;
      const address = ctx.session.renameCopyTarget;
      ctx.session.renameCopyTarget = undefined;
      if (!address) return ctx.reply("That request expired — open Copy Mint again.");

      const renamed = ctx.store.renameCopyTarget(address, ctx.message.text);
      if (!renamed) return ctx.reply("That wallet is no longer watched.");
      // Matching is by address, so the watcher keeps copying it either way.
      return ctx.reply(
        "✅ Renamed to *" + renamed.label + "*.",
        { parse_mode: "Markdown", ...copyMenu(runningCopy.has(ctx.from!.id), ctx.store.listCopyTargets()) }
      );
    }

    if (step === "awaiting_wallet_label") {
      ctx.session.step = undefined;
      const address = ctx.session.renameWallet;
      ctx.session.renameWallet = undefined;
      if (!address) return ctx.reply("That request expired — open the wallet again.");

      const renamed = ctx.store.renameWallet(address, ctx.message.text);
      if (!renamed) return ctx.reply("That wallet is gone.");
      // The label is presentation only, so nothing else needs updating: every
      // other reference to a wallet is by address.
      await ctx.reply(`✅ Renamed to *${renamed.label}*.`, { parse_mode: "Markdown" });
      return showWallet(ctx, renamed.address);
    }

    if (step === "awaiting_find_contract") {
      ctx.session.step = undefined;
      const settings = ctx.store.getSettings();
      let contract: string;
      try {
        contract = await resolveMintTarget(ctx.message.text.trim(), settings.chainKey);
      } catch (err: any) {
        return ctx.reply(`Couldn't read that as a collection: ${err?.message ?? err}`);
      }

      const wallets = ctx.store.listWallets();
      const note = await ctx.reply(`Looking through ${wallets.length} wallet(s)…`);

      // Detached for the same reason as Consolidate and P&L: a collection
      // with no enumeration is walked token by token, which outruns
      // Telegraf's ninety-second handler timeout.
      void (async () => {
        const say = (text: string, extra?: any) =>
          ctx.telegram.editMessageText(note.chat.id, note.message_id, undefined, text, extra).catch(() => {});
        try {
          const scan = await scanWithProgress(ctx, contract, note.chat.id, note.message_id);
          if (!scan) return;

          const found = holders(scan);
          const total = found.reduce((sum, h) => sum + h.tokenIds.length, 0);
          if (total === 0) {
            const unreadable = scan.skipped.filter((sk) => sk.reason !== "holds none");
            return say(
              unreadable.length > 0
                ? `None of your wallets hold this collection.\n\n${unreadable
                    .map((sk) => `• ${maskAddress(sk.address)} — ${sk.reason}`)
                    .join("\n")}`
                : "None of your wallets hold this collection."
            );
          }

          // On-chain facts first, market data second. The holdings are always
          // right; everything below them depends on OpenSea answering, which
          // on this chain it currently often does not.
          const labelFor = (addr: string) =>
            wallets.find((w) => w.address.toLowerCase() === addr.toLowerCase())?.label ?? maskAddress(addr);
          const lookup = await lookupContract(settings.chainKey, contract, process.env.OPENSEA_API_KEY);
          const slug = isLookupFailure(lookup) ? null : lookup.slug;
          const key = process.env.OPENSEA_API_KEY;
          const [info, stats, offer] = await Promise.all([
            slug ? fetchCollection(slug, key).catch(() => null) : Promise.resolve(null),
            slug ? fetchStats(slug, key).catch(() => null) : Promise.resolve(null),
            slug ? fetchBestCollectionOffer(slug, key).catch(() => null) : Promise.resolve(null),
          ]);

          const name = info?.name || (isLookupFailure(lookup) ? maskAddress(contract) : lookup.name);
          const lines = [
            `🔎 *${name}*`,
            "",
            `Held: *${total}* across *${found.length}* wallet(s)`,
            ...found.map((h) => `  ${labelFor(h.address)} — ${h.tokenIds.length}`),
            "",
            stats?.floorPrice != null
              ? `Floor: *${stats.floorPrice} ${stats.floorSymbol}*`
              : "Floor: — (nothing listed)",
            offer ? `Best offer: *${offer.priceEth} ETH*` : "Best offer: — (no standing bid)",
          ];

          // Say why the market half is blank rather than leaving it looking
          // like the collection simply has no activity. They are different
          // problems and only one of them is yours to fix.
          if (!slug) {
            lines.push(
              "",
              `_OpenSea has no collection for this contract right now (${
                isLookupFailure(lookup) ? lookup.detail : "unknown"
              }), so there is no floor, no offers and nothing to list against._`
            );
          } else if (!stats && !offer) {
            lines.push("", "_OpenSea returned no market data for this collection right now._");
          }

          // The sell and list actions are keyed by (wallet, slug) and already
          // exist, so this hands straight off to them rather than repeating
          // them. Only the biggest holder is offered: acting on the wallet
          // holding one of twelve is almost never what was meant.
          const kb =
            slug !== null
              ? sellCollectionMenu(found[0].address, slug, offer !== null, makeTokenizer(ctx.session))
              : undefined;
          if (kb) {
            lines.push("", `_Actions below apply to *${labelFor(found[0].address)}*, which holds the most._`);
          }

          return say(lines.join("\n"), { parse_mode: "Markdown", ...(kb ?? {}) });
        } catch (err: any) {
          console.error(`Find NFT failed for ${contract}: ${err?.message ?? err}`);
          await say(`Lookup failed: ${err?.shortMessage ?? err?.message ?? err}`);
        }
      })();
      return;
    }

    if (step === "awaiting_pnl_contract") {
      ctx.session.step = undefined;
      const settings = ctx.store.getSettings();
      let contract: string;
      try {
        contract = await resolveMintTarget(ctx.message.text.trim(), settings.chainKey);
      } catch (err: any) {
        return ctx.reply(`Couldn't read that as a collection: ${err?.message ?? err}`);
      }

      const wallets = ctx.store.listWallets();
      if (wallets.length === 0) return ctx.reply("Add a wallet first.");
      const note = await ctx.reply(`Counting what ${wallets.length} wallet(s) hold…`);

      // Detached: see scanWithProgress. Awaiting this would hand Telegraf a
      // promise it kills at 90 seconds, and a large collection takes longer.
      void (async () => {
        const say = (text: string, extra?: any) =>
          ctx.telegram.editMessageText(note.chat.id, note.message_id, undefined, text, extra).catch(() => {});
        try {
          const { urls } = resolveRpcsForChain(settings.chainKey);
          const chain = resolveChain(settings.chainKey)!;

          // Holdings first and on their own: this is the only figure here
          // that comes off the chain, and every value below it is someone
          // else's opinion layered on top.
          const scan = await scanWithProgress(ctx, contract, note.chat.id, note.message_id);
          if (!scan) return;

          const found = holders(scan);
          const quantity = found.reduce((sum, h) => sum + h.tokenIds.length, 0);
          if (quantity === 0) {
            const unreadable = scan.skipped.filter((sk) => sk.reason !== "holds none");
            return say(
              unreadable.length > 0
                ? `None of your wallets hold this collection.\n\n${unreadable
                    .map((sk) => `• ${maskAddress(sk.address)} — ${sk.reason}`)
                    .join("\n")}`
                : "None of your wallets hold this collection, so there's no P&L to show."
            );
          }

          await say(`Found ${quantity} across ${found.length} wallet(s). Pricing them…`);

          // Everything below is best-effort. A missing floor or a collection
          // OpenSea has never indexed degrades the report; it never kills it,
          // because the holdings above are already worth showing on their own.
          const lookup = await lookupContract(settings.chainKey, contract, process.env.OPENSEA_API_KEY);
          const slug = isLookupFailure(lookup) ? null : lookup.slug;
          const apiKey = process.env.OPENSEA_API_KEY;

          const [stages, info, stats, offer] = await Promise.all([
            raceReadOrNull(urls, (url) => readStages(url, contract)).catch(() => null),
            slug ? fetchCollection(slug, apiKey).catch(() => null) : Promise.resolve(null),
            slug ? fetchStats(slug, apiKey).catch(() => null) : Promise.resolve(null),
            slug ? fetchBestCollectionOffer(slug, apiKey).catch(() => null) : Promise.resolve(null),
          ]);

          const publicStage = (stages ?? []).find((s) => s.kind === "public");
          const mintPriceEth =
            publicStage?.priceWei !== undefined ? Number(formatEther(publicStage.priceWei)) : null;

          // Gas from the same model the mint path sizes its limit with, at
          // the fee ceiling this bot would sign at. Every wallet paid its own,
          // so it scales with wallets and tokens rather than tokens alone.
          let gasEth: number | null = null;
          try {
            const ceiling = await resolveFeeCeiling(settings, urls);
            const perWallet = found.map((h) => BigInt(gasLimitForQuantity(h.tokenIds.length)) * ceiling);
            gasEth = Number(formatEther(perWallet.reduce((a, b) => a + b, 0n)));
          } catch {
            /* a modelled figure we can't model is better left out than guessed */
          }

          const labelFor = (addr: string) =>
            wallets.find((w) => w.address.toLowerCase() === addr.toLowerCase())?.label ?? maskAddress(addr);

          const report: PnlReport = {
            name: info?.name || (isLookupFailure(lookup) ? maskAddress(contract) : lookup.name),
            contract,
            symbol: chain.nativeSymbol,
            quantity,
            wallets: found.length,
            mintPriceEth,
            gasEth,
            floorEth: stats?.floorPrice ?? null,
            bestOfferEth: offer?.priceEth ?? null,
            priceSource: mintPriceEth === null ? "unknown" : "stage",
            breakdown: found.map((h) => ({
              address: h.address,
              label: labelFor(h.address),
              count: h.tokenIds.length,
            })),
          };
          const pnl = computePnl(report);

          // The card is decoration around a report that already stands on its
          // own, so a rasteriser failure must not cost the numbers.
          try {
            const png = await renderPnlCardPng({ report, pnl, artHref: info?.imageUrl ?? null });
            await ctx.replyWithPhoto({ source: png });
          } catch (err: any) {
            console.error(`P&L card failed for ${contract}: ${err?.message ?? err}`);
          }

          await say(renderPnl(report, pnl), { parse_mode: "Markdown" });
        } catch (err: any) {
          console.error(`P&L failed for ${contract}: ${err?.message ?? err}`);
          await say(`P&L failed: ${err?.shortMessage ?? err?.message ?? err}`);
        }
      })();
      return;
    }

    if (step === "awaiting_consolidate_contract") {
      ctx.session.step = undefined;
      const settings = ctx.store.getSettings();
      let contract: string;
      try {
        contract = await resolveMintTarget(ctx.message.text.trim(), settings.chainKey);
      } catch (err: any) {
        return ctx.reply(`Couldn't read that as a collection: ${err?.message ?? err}`);
      }

      const wallets = ctx.store.listWallets();
      const note = await ctx.reply(`Checking ${wallets.length} wallet(s) for this collection…`);

      // Detached for the same reason as P&L above: this can outrun Telegraf's
      // 90-second handler timeout on a collection that has to be walked.
      void (async () => {
        const say = (text: string, extra?: any) =>
          ctx.telegram.editMessageText(note.chat.id, note.message_id, undefined, text, extra).catch(() => {});
        try {
          const scan = await scanWithProgress(ctx, contract, note.chat.id, note.message_id);
          if (!scan) return;

          const found = holders(scan);
          if (found.length === 0) {
            // Distinguish "you own none" from "these couldn't be read" — the
            // second is a different problem with a different fix.
            const unreadable = scan.skipped.filter((sk) => sk.reason !== "holds none");
            return say(
              unreadable.length > 0
                ? `None of your wallets hold this collection.\n\n${unreadable
                    .map((sk) => `• ${maskAddress(sk.address)} — ${sk.reason}`)
                    .join("\n")}`
                : "None of your wallets hold this collection."
            );
          }

          const labelFor = (addr: string) =>
            wallets.find((w) => w.address.toLowerCase() === addr.toLowerCase())?.label ?? maskAddress(addr);
          ctx.session.consolidate = {
            contract,
            found: found.map((h) => ({
              owner: h.address,
              label: labelFor(h.address),
              tokenIds: h.tokenIds.map((id) => id.toString()),
            })),
            // Pre-selected: sweeping everything is the common case, so the
            // default is one tap to Done and deselecting is the exception.
            selected: found.map((h) => h.address.toLowerCase()),
          };

          const unreadable = scan.skipped.filter((sk) => sk.reason !== "holds none");
          const total = found.reduce((s, h) => s + h.tokenIds.length, 0);
          let text =
            `📦 Found *${total}* NFT(s) across *${found.length}* wallet(s).\n\n` +
            "Tap to choose which wallets to sweep, then Done.";
          if (unreadable.length > 0) {
            text += `\n\nCouldn't read:\n${unreadable
              .map((sk) => `• ${maskAddress(sk.address)} — ${sk.reason}`)
              .join("\n")}`;
          }
          await say(text, {
            parse_mode: "Markdown",
            ...consolidateSourcesMenu(
              found.map((h) => ({ address: h.address, label: labelFor(h.address), count: h.tokenIds.length })),
              new Set(found.map((h) => h.address.toLowerCase()))
            ),
          });
        } catch (err: any) {
          console.error(`Consolidate scan failed for ${contract}: ${err?.message ?? err}`);
          await say(`Scan failed: ${err?.shortMessage ?? err?.message ?? err}`);
        }
      })();
      return;
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

      const settings = ctx.store.getSettings();
      const chain = resolveChain(settings.chainKey)!;
      // Same ceiling the transfer will actually sign with. Passing the raw
      // setting would quote gas as free whenever it is set to auto.
      const { urls: fundUrls } = resolveRpcsForChain(settings.chainKey);
      const worstCase = estimateBatchCost(
        targets.length,
        amountWei,
        await resolveFeeCeiling(settings, fundUrls)
      );
      const sourceLabel = ctx.store.listWallets().find((w) => w.address.toLowerCase() === source.toLowerCase())?.label ?? source;
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
        ctx.store.updateSettings({ [field]: undefined } as any);
        return ctx.reply(
          field === "autoMaxQuantity"
            ? "Cleared — auto mint will use each drop's true max per wallet."
            : "Cleared — copy mint will use each drop's true max per wallet."
        );
      }

      // "auto" on the gas limit means size it from the quantity being minted,
      // which is stored as 0. A fixed limit both over-reserves for a small
      // mint and runs out of gas on a large one.
      if (field === "maxFeeGwei" && raw.toLowerCase() === "auto") {
        // 0 means "read the base fee at signing time". A hand-set ceiling is
        // a guess that ages: too low and nothing lands, too high and every
        // wallet reserves more than the block costs.
        ctx.store.updateSettings({ maxFeeGwei: 0 });
        return ctx.reply(
          "✅ Max fee now follows the chain — read fresh at signing time, with headroom for it rising.\n\n" +
            "This also lowers what each wallet must hold, since the ceiling is what gets reserved.",
          settingsMenu(ctx.store.getSettings())
        );
      }

      if (field === "gasLimit" && raw.toLowerCase() === "auto") {
        ctx.store.updateSettings({ gasLimit: 0 });
        return ctx.reply(
          "✅ Gas limit is now sized automatically from the quantity being minted.",
          settingsMenu(ctx.store.getSettings())
        );
      }

      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) return ctx.reply("That's not a valid number.");
      ctx.store.updateSettings({ [field]: value } as any);
      return ctx.reply(`✅ ${field} set to ${value}.`, settingsMenu(ctx.store.getSettings()));
    }
  });

  return bot;
}
