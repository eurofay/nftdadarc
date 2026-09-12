// The fifth bot: what your smart wallets are doing, right now.
//
// The radar bot tells you a drop is coming. This one tells you that wallets
// you have decided are worth watching just acted — which is a different feed
// with a different urgency, and putting it in the radar chat would bury the
// thing you set the radar up for. Five bots sounds like a lot until you notice
// that each one is a separate notification setting, and that is the whole
// point: this is the feed you let through at 3am.
//
// It reads and nothing else. No key, no signing, no spending. Every action it
// offers is a link out — to Smart Mint in the main bot, or to an explorer.

import { Telegraf, Telegram, Markup } from "telegraf";
import { UserStores } from "./user-stores";
import { cleanToken } from "./token";
import { resolveChain, blocksForSeconds, logChunkBlocksFor } from "../chains";
import { resolveRpcsForChain } from "../rpc-resolver";
import { createProvider } from "../rpc-provider";
import { scanActivity } from "../activity-scan";
import {
  Activity,
  ClusterTracker,
  describeActivity,
  describeCluster,
  isNoteworthy,
  KIND_LABEL,
  ActivityKind,
} from "../wallet-activity";
import { lookupContract, isLookupFailure } from "../slug-resolver";

export interface SmartAlertsBot {
  telegram: Telegram;
  username?: string;
  stop: (reason?: string) => void;
}

const mask = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Every kind, and whether it is on by default. */
const KIND_DEFAULTS: Record<ActivityKind, boolean> = {
  mint: true,
  buy: true,
  sell: true,
  "sell-offer": true,
  out: true,
  // Off by default: a wallet receiving something is usually the other leg of
  // an event already reported, or an airdrop nobody asked for.
  in: false,
};

export function startSmartAlertsBot(
  token: string | undefined,
  ownerId: number,
  stores: UserStores,
  mainBotUsername?: () => string | undefined
): SmartAlertsBot | null {
  const cleaned = cleanToken(token);
  if (!cleaned.token) return null;
  for (const note of cleaned.notes) console.warn(`TELEGRAM_SMART_BOT_TOKEN: ${note}.`);
  if (!cleaned.looksValid) {
    console.error("TELEGRAM_SMART_BOT_TOKEN is not shaped like a bot token. Smart alerts stay off.");
    return null;
  }

  const bot = new Telegraf(cleaned.token);
  const handle: SmartAlertsBot = { telegram: bot.telegram, stop: (reason) => bot.stop(reason) };
  const owner = (ctx: any): boolean => ctx.from?.id === ownerId;

  const clusters = new ClusterTracker();
  const names = new Map<string, string>();
  let watching: { stopped: boolean } | null = null;
  let enabled = new Set<ActivityKind>(
    (Object.keys(KIND_DEFAULTS) as ActivityKind[]).filter((k) => KIND_DEFAULTS[k])
  );
  let seenTransfers = false;

  /** Cached, because a busy wallet hits the same collection repeatedly. */
  async function nameOf(chainKey: string, contract: string): Promise<string> {
    const k = `${chainKey}:${contract.toLowerCase()}`;
    const hit = names.get(k);
    if (hit) return hit;
    const info = await lookupContract(chainKey, contract, process.env.OPENSEA_API_KEY).catch(() => null);
    const name = info && !isLookupFailure(info) ? info.name : mask(contract);
    names.set(k, name);
    return name;
  }

  function menu() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(watching ? "⏸ Stop" : "▶️ Start watching", "sa:toggle"),
        Markup.button.callback("🔔 What to alert", "sa:kinds"),
      ],
      [Markup.button.callback("🧠 Who I'm watching", "sa:who")],
    ]);
  }

  function kindsMenu() {
    const rows = (Object.keys(KIND_DEFAULTS) as ActivityKind[]).map((k) => [
      Markup.button.callback(`${enabled.has(k) ? "✅" : "⬜"} ${KIND_LABEL[k]}`, `sa:kind:${k}`),
    ]);
    rows.push([Markup.button.callback("⬅ Back", "sa:menu")]);
    return Markup.inlineKeyboard(rows);
  }

  async function sendActivity(chatId: number, chainKey: string, a: Activity) {
    const chain = resolveChain(chainKey);
    const store = stores.for(ownerId);
    const saved = store
      .listSmartWallets()
      .find((w) => w.address.toLowerCase() === a.wallet.toLowerCase());
    const label = saved?.label ?? mask(a.wallet);
    const name = await nameOf(chainKey, a.contract);

    const rows: ReturnType<typeof Markup.button.url>[][] = [
      [
        Markup.button.url("🔎 Tx", `${chain?.explorer ?? ""}/tx/${a.txHash}`),
        Markup.button.url("👛 Wallet", `${chain?.explorer ?? ""}/address/${a.wallet}`),
      ],
    ];
    const main = mainBotUsername?.();
    // Only worth offering on the way IN. Following a wallet out of a position
    // is not a mint, it is a decision this bot should not make for you.
    if (main && (a.kind === "mint" || a.kind === "buy")) {
      rows.push([Markup.button.url("⚡ Mint this too", `https://t.me/${main}?start=mint_${a.contract}`)]);
    }

    await bot.telegram
      .sendMessage(
        chatId,
        `${describeActivity(a, label, name, chain?.nativeSymbol ?? "ETH")}\n\`${a.contract}\``,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) }
      )
      .catch(() => {});
  }

  async function sendCluster(chatId: number, chainKey: string, c: ReturnType<ClusterTracker["note"]>) {
    if (!c) return;
    const chain = resolveChain(chainKey);
    const name = await nameOf(chainKey, c.contract);
    const rows: ReturnType<typeof Markup.button.url>[][] = [
      [Markup.button.url("🔎 Collection", `${chain?.explorer ?? ""}/address/${c.contract}`)],
    ];
    const main = mainBotUsername?.();
    if (main && c.kind !== "sell" && c.kind !== "sell-offer") {
      rows.push([Markup.button.url("⚡ Mint this too", `https://t.me/${main}?start=mint_${c.contract}`)]);
    }
    await bot.telegram
      .sendMessage(
        chatId,
        `${describeCluster(c, name, chain?.nativeSymbol ?? "ETH", mask)}\n\n\`${c.contract}\``,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) }
      )
      .catch(() => {});
  }

  /**
   * Poll new blocks and report what the watched wallets did in them.
   *
   * Only ever the blocks since the last pass, so the work per tick is tiny
   * however long the bot has been running.
   */
  async function watch(chatId: number, signal: { stopped: boolean }) {
    const store = stores.for(ownerId);
    const chainKey = store.getSettings().chainKey;
    const chain = resolveChain(chainKey);
    if (!chain) return;
    const { urls } = resolveRpcsForChain(chainKey);
    const provider = createProvider(urls[0]);

    let cursor: number;
    try {
      cursor = await provider.getBlockNumber();
    } catch (err: any) {
      await bot.telegram.sendMessage(chatId, `Could not reach ${chain.name}: ${err?.message ?? err}`);
      return;
    }

    await bot.telegram.sendMessage(
      chatId,
      `👁 Watching ${store.listSmartWallets().length} smart wallet(s) on ${chain.name}.`
    );

    while (!signal.stopped) {
      try {
        const wallets = store.listSmartWallets().map((w) => w.address);
        const head = await provider.getBlockNumber();
        if (wallets.length > 0 && head > cursor) {
          const acts = await scanActivity({
            rpcUrl: urls[0],
            wallets,
            fromBlock: cursor + 1,
            toBlock: head,
            chunkBlocks: logChunkBlocksFor(chainKey),
            includeTransfers: enabled.has("in") || enabled.has("out"),
          });

          for (const a of acts) {
            if (!enabled.has(a.kind) || !isNoteworthy(a)) continue;
            await sendActivity(chatId, chainKey, a);
            // Clustering runs on everything that passed the filter, because
            // several wallets converging is the signal the individual events
            // only hint at.
            await sendCluster(chatId, chainKey, clusters.note(a));
          }
          clusters.prune();
        }
        cursor = head;
      } catch {
        /* a failed tick is a failed tick; the next one starts from the same cursor */
      }
      await new Promise((r) => setTimeout(r, 12_000));
    }

    await bot.telegram.sendMessage(chatId, "👁 Smart alerts off.").catch(() => {});
  }

  bot.start((ctx) => {
    if (!owner(ctx)) return ctx.reply("This bot only serves its owner.");
    const n = stores.for(ownerId).listSmartWallets().length;
    return ctx.reply(
      "👁 *Smart wallet alerts*\n\n" +
        `Watching the ${n} wallet(s) you recorded in the radar bot — mints, buys, sells and ` +
        "offers taken, the moment they settle.\n\n" +
        "*The one worth waiting for* is several of them landing on the same collection inside " +
        "ten minutes. One good minter is an opinion; four at once is the thing you wanted to know.\n\n" +
        "_Listings and offers being SET are not here, and cannot be: a Seaport order is a signed " +
        "message held off-chain, and nothing touches the chain until someone fills it. What you " +
        "see below is everything that settles._",
      { parse_mode: "Markdown", ...menu() }
    );
  });

  bot.action("sa:menu", async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery();
    return ctx.editMessageText("👁 Smart alerts:", menu());
  });

  bot.action("sa:toggle", async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery();
    if (watching) {
      watching.stopped = true;
      watching = null;
      return ctx.editMessageText("Stopped.", menu());
    }
    if (stores.for(ownerId).listSmartWallets().length === 0) {
      return ctx.editMessageText(
        "No smart wallets recorded yet. Find some with Scout or Proven profit in the radar bot, then press Record.",
        menu()
      );
    }
    const signal = { stopped: false };
    watching = signal;
    void watch(ctx.chat!.id, signal);
    return ctx.editMessageText("Watching.", menu());
  });

  bot.action("sa:kinds", async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery();
    return ctx.editMessageText("Alert me about:", kindsMenu());
  });

  bot.action(/^sa:kind:(.+)$/, async (ctx) => {
    if (!owner(ctx)) return;
    const k = ctx.match[1] as ActivityKind;
    if (!(k in KIND_DEFAULTS)) return ctx.answerCbQuery();
    if (enabled.has(k)) enabled.delete(k);
    else enabled.add(k);
    if (k === "in" || k === "out") seenTransfers = true;
    await ctx.answerCbQuery(enabled.has(k) ? "On" : "Off");
    return ctx.editMessageReplyMarkup(kindsMenu().reply_markup).catch(() => {});
  });

  bot.action("sa:who", async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery();
    const list = stores.for(ownerId).listSmartWallets();
    return ctx.editMessageText(
      list.length === 0
        ? "Nothing recorded yet. Record wallets in the radar bot and they appear here."
        : `🧠 *${list.length} watched*\n\n` +
            list
              .map((w) => `\`${mask(w.address)}\` — ${w.label}`)
              .join("\n"),
      { parse_mode: "Markdown", ...menu() }
    );
  });

  bot.command("watch", (ctx) => {
    if (!owner(ctx)) return;
    return ctx.reply("👁 Smart alerts:", menu());
  });

  bot
    .launch(() => {
      console.log(`Smart alerts bot running — watching recorded wallets for ${ownerId}.`);
      bot.telegram
        .getMe()
        .then((me) => (handle.username = me.username))
        .catch(() => {});
    })
    .catch((err: any) => {
      console.error(`Smart alerts bot could not start: ${err?.description || err?.message || err}`);
    });

  void seenTransfers;
  return handle;
}
