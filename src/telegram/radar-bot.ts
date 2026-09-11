// A third bot: the one that tells you what is coming.
//
// Same process, same store, same wallets as the other two — separated for the
// same reason the alerts bot was. The main bot is where you go to do things,
// and a drop alert is the opposite kind of traffic: it arrives unasked, it is
// time-critical, and it must not be buried under the menus you were using.
// Putting it in its own chat also means its notification setting is its own,
// which for the one feed you actually want to interrupt you is the point.
//
// Read-and-recommend by design. It can add a wallet to your copy list, which
// is a preference; it cannot spend, sign, or reveal a key. Arming a mint is a
// deep link back to the main bot, behind that bot's access control, because
// two front doors onto a key store is two to guard.

import { Telegraf, Telegram, Markup } from "telegraf";
import { formatEther } from "ethers";
import { UserStores } from "./user-stores";
import { cleanToken } from "./token";
import { CHAINS, ChainProfile, resolveChain, logChunkBlocksFor, blocksForSeconds } from "../chains";
import { resolveRpcsForChain } from "../rpc-resolver";
import { RadarBoard, UpcomingDrop, Verdict, countdown, priceLabel, leadMs, isLive } from "../drop-radar";
import { runDropRadar } from "../radar-watch";
import { scanAllMints } from "../minter-scan";
import { scout, why, RankedMinter } from "../minter-scout";
import { renderRadarCardPng } from "../mint-card-render";
import { lookupContract, isLookupFailure } from "../slug-resolver";
import { createProvider } from "../rpc-provider";
import { createLogger } from "../logger";

export interface RadarBot {
  telegram: Telegram;
  username?: string;
  stop: (reason?: string) => void;
}

const mask = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Links worth having on every alert, in the order they get used. */
function linksFor(chain: ChainProfile, contract: string, slug: string | null) {
  const rows: ReturnType<typeof Markup.button.url>[][] = [];
  const os = slug
    ? `https://opensea.io/collection/${slug}`
    : `https://opensea.io/assets/${chain.key}/${contract}`;
  rows.push([
    Markup.button.url("🌊 OpenSea", os),
    Markup.button.url("🔎 Explorer", `${chain.explorer}/address/${contract}`),
  ]);
  return rows;
}

/**
 * How many of your wallets could actually pay for this.
 *
 * Balance only — a full eligibility read is several calls per wallet and this
 * runs on every alert, but "can it cover the cost" is the question that
 * decides whether the alert is worth acting on, and it is one call each.
 */
async function readyWallets(
  rpcUrl: string,
  addresses: string[],
  priceWei: bigint,
  gasBufferWei: bigint
): Promise<number> {
  const provider = createProvider(rpcUrl);
  const need = priceWei + gasBufferWei;
  const results = await Promise.all(
    addresses.map((a) =>
      provider
        .getBalance(a)
        .then((b) => b >= need)
        .catch(() => false)
    )
  );
  return results.filter(Boolean).length;
}

export function startRadarBot(
  token: string | undefined,
  ownerId: number,
  stores: UserStores,
  mainBotUsername?: () => string | undefined
): RadarBot | null {
  const cleaned = cleanToken(token);
  if (!cleaned.token) return null;
  for (const note of cleaned.notes) console.warn(`TELEGRAM_RADAR_BOT_TOKEN: ${note}.`);
  if (!cleaned.looksValid) {
    console.error("TELEGRAM_RADAR_BOT_TOKEN is not shaped like a bot token. The radar stays off.");
    return null;
  }

  const bot = new Telegraf(cleaned.token);
  const handle: RadarBot = { telegram: bot.telegram, stop: (reason) => bot.stop(reason) };
  const boards = new Map<string, RadarBoard>();
  const watchers = new Map<string, { stopped: boolean }>();
  const owner = (ctx: any): boolean => ctx.from?.id === ownerId;

  const boardFor = (key: string): RadarBoard => {
    let b = boards.get(key);
    if (!b) boards.set(key, (b = new RadarBoard()));
    return b;
  };

  function menu() {
    const on = [...watchers.keys()];
    return Markup.inlineKeyboard([
      [Markup.button.callback("📡 Board", "radar:board"), Markup.button.callback("🔭 Scout", "radar:scout")],
      [Markup.button.callback(on.length ? `⏸ Stop (${on.length})` : "▶️ Start watching", "radar:toggle")],
    ]);
  }

  /** Build and send one alert, art and all. */
  async function sendAlert(chatId: number, chain: ChainProfile, drop: UpcomingDrop, verdict: Verdict) {
    const store = stores.for(ownerId);
    const info = await lookupContract(chain.key, drop.contract, process.env.OPENSEA_API_KEY).catch(() => null);
    const named = info && !isLookupFailure(info) ? info : null;
    const wallets = store.listWallets().map((w) => w.address);
    const { urls } = resolveRpcsForChain(chain.key);

    // A rough gas allowance, so "ready" is not a promise the chain refuses.
    const ready = await readyWallets(urls[0], wallets, drop.priceWei, 500_000_000_000_000n).catch(() => 0);
    const live = isLive(drop);

    const png = await renderRadarCardPng({
      collection: named?.name ?? `${drop.contract.slice(0, 10)}…`,
      contract: drop.contract,
      chain: chain.name,
      countdown: countdown(leadMs(drop)),
      price: priceLabel(drop.priceWei, chain.nativeSymbol),
      maxPerWallet: drop.maxPerWallet,
      readyWallets: ready,
      totalWallets: wallets.length,
      opensAt: new Date(drop.startTime * 1000).toLocaleString(),
      artHref: (named as any)?.imageUrl ?? null,
      live,
    }).catch(() => null);

    const headline = verdict === "changed" ? "♻️ Stage changed" : live ? "🔴 Live now" : "📡 Incoming drop";
    const caption =
      `${headline} — ${named?.name ?? "Unknown collection"}\n` +
      `${countdown(leadMs(drop))} · ${priceLabel(drop.priceWei, chain.nativeSymbol)} · max ${drop.maxPerWallet}/wallet\n` +
      `${ready} of ${wallets.length} wallets funded\n\n` +
      `\`${drop.contract}\``;

    const rows = linksFor(chain, drop.contract, named?.slug ?? null);
    const main = mainBotUsername?.();
    if (main) {
      // Arming spends, so it happens on the main bot behind its access
      // control. The deep link carries the address so it is still one tap.
      rows.push([Markup.button.url("⚡ Arm in l00p Bot", `https://t.me/${main}?start=mint_${drop.contract}`)]);
    }

    const extra = { parse_mode: "Markdown" as const, ...Markup.inlineKeyboard(rows) };
    if (png) await bot.telegram.sendPhoto(chatId, { source: png }, { caption, ...extra });
    else await bot.telegram.sendMessage(chatId, caption, extra);
  }

  function startWatching(chatId: number): number {
    const store = stores.for(ownerId);
    const keys = store.getSettings().autoChainKeys?.length
      ? store.getSettings().autoChainKeys!
      : [store.getSettings().chainKey];
    let started = 0;
    for (const key of keys) {
      if (watchers.has(key)) continue;
      const chain = resolveChain(key);
      if (!chain) continue;
      const { urls } = resolveRpcsForChain(key);
      const signal = { stopped: false };
      watchers.set(key, signal);
      started++;
      void runDropRadar({
        chain,
        rpcUrls: urls,
        board: boardFor(key),
        logChunkBlocks: logChunkBlocksFor(key),
        // Half an hour back, so a drop announced during a redeploy is not lost.
        backfillBlocks: blocksForSeconds(key, 1800),
        stopSignal: signal,
        logger: createLogger((text) => void bot.telegram.sendMessage(chatId, text).catch(() => {}), "headlines"),
        onAlert: (drop, verdict) => sendAlert(chatId, chain, drop, verdict),
      }).finally(() => watchers.delete(key));
    }
    return started;
  }

  bot.start((ctx) => {
    if (!owner(ctx)) return ctx.reply("This bot only serves its owner.");
    return ctx.reply(
      "📡 *Radar*\n\n" +
        "Drops announce themselves on-chain before they open. Measured on Robinhood, " +
        "*56% of them* are configured ahead of time, with a median of *37 minutes* of warning.\n\n" +
        "This watches for that and tells you — with the art, the terms, and how many of your " +
        "wallets are funded for it.\n\n" +
        "*Scout* is the other half: it ranks wallets by how early they get into drops, " +
        "so your copy list comes from the chain rather than from guesswork.\n\n" +
        "Arming happens on the main bot. Nothing here can spend.",
      { parse_mode: "Markdown", ...menu() }
    );
  });

  bot.action("radar:toggle", async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery();
    if (watchers.size > 0) {
      for (const s of watchers.values()) s.stopped = true;
      return ctx.editMessageText("Radar off.", menu());
    }
    const n = startWatching(ctx.chat!.id);
    return ctx.editMessageText(
      n > 0 ? `Radar on — watching ${n} chain(s).` : "No chains selected. Pick them in the main bot's settings.",
      menu()
    );
  });

  bot.action("radar:board", async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery();
    const lines: string[] = [];
    for (const [key, board] of boards) {
      const chain = resolveChain(key);
      for (const d of board.board()) {
        lines.push(
          `${isLive(d) ? "🔴" : "⏳"} \`${mask(d.contract)}\` — ${countdown(leadMs(d))} · ` +
            `${priceLabel(d.priceWei, chain?.nativeSymbol ?? "ETH")} · max ${d.maxPerWallet}`
        );
      }
    }
    return ctx.editMessageText(
      lines.length ? `📡 *Board*\n\n${lines.join("\n")}` : "Nothing on the board yet.",
      { parse_mode: "Markdown", ...menu() }
    );
  });

  bot.action("radar:scout", async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery("Scanning…");
    return runScout(ctx.chat!.id);
  });

  bot.command("scout", (ctx) => {
    if (!owner(ctx)) return;
    return runScout(ctx.chat.id);
  });

  bot.command("board", (ctx) => {
    if (!owner(ctx)) return;
    return ctx.reply("📡 Radar:", menu());
  });

  async function runScout(chatId: number) {
    const store = stores.for(ownerId);
    const key = store.getSettings().chainKey;
    const chain = resolveChain(key);
    if (!chain) return;
    const { urls } = resolveRpcsForChain(key);

    const note = await bot.telegram.sendMessage(chatId, `🔭 Scanning ${chain.name} for active minters…`);
    const edit = (t: string) =>
      bot.telegram.editMessageText(chatId, note.message_id, undefined, t, { parse_mode: "Markdown" }).catch(() => {});

    try {
      const provider = createProvider(urls[0]);
      const head = await provider.getBlockNumber();
      // Two hours: long enough for a real sample, short enough that it is
      // about who is active now rather than who was last week.
      const span = blocksForSeconds(key, 2 * 3600);
      const records = await scanAllMints(urls[0], Math.max(0, head - span), head, {
        chunkBlocks: logChunkBlocksFor(key),
        maxRecords: 25_000,
        onProgress: (scanned, found) => {
          if (scanned % (span / 4) < logChunkBlocksFor(key)) void edit(`🔭 Scanning… ${found} mints so far.`);
        },
      });

      const mine = store.listWallets().map((w) => w.address);
      const watched = store.listCopyTargets().map((t) => t.address);
      const top = scout(records, { limit: 8, exclude: [...mine, ...watched] });

      if (top.length === 0) {
        return edit(`No minter on ${chain.name} has a track record worth copying in the last two hours.`);
      }

      const collections = new Set(records.map((r) => r.nftContract)).size;
      await edit(
        `🔭 *Scout — ${chain.name}*\n\n` +
          `${records.length.toLocaleString()} mints · ${collections} collections · last 2h\n\n` +
          "Ranked by how early they get in, across how many drops. " +
          "_Not realised profit — that needs sale prices, which are not on-chain._"
      );

      for (const m of top) {
        await bot.telegram.sendMessage(
          chatId,
          `\`${m.address}\`\n${why(m)}`,
          {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback("👀 Copy this wallet", `scout:watch:${m.address}`),
                Markup.button.url("🔎 Explorer", `${chain.explorer}/address/${m.address}`),
              ],
            ]),
          }
        );
      }
    } catch (err: any) {
      await edit(`Scout failed: ${err?.message ?? err}`);
    }
  }

  bot.action(/^scout:watch:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
    if (!owner(ctx)) return;
    const address = ctx.match[1];
    try {
      stores.for(ownerId).addCopyTarget(`scout-${address.slice(-4)}`, address);
      await ctx.answerCbQuery("Added to your copy list.");
      return ctx.editMessageReplyMarkup(undefined);
    } catch (err: any) {
      return ctx.answerCbQuery(err?.message ?? "Could not add that one.", { show_alert: true });
    }
  });

  bot
    .launch(() => {
      console.log(`Radar bot running — drop radar and scout, reporting to ${ownerId}.`);
      bot.telegram
        .getMe()
        .then((me) => {
          handle.username = me.username;
          console.log(`Radar bot is @${me.username}.`);
        })
        .catch(() => {});
    })
    .catch((err: any) => {
      console.error(`Radar bot could not start: ${err?.description || err?.message || err}`);
    });

  return handle;
}

export { CHAINS, formatEther };
