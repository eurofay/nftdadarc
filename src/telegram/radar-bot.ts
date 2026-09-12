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
import { installGuards } from "./bot-guards";
import { CHAINS, ChainProfile, resolveChain, logChunkBlocksFor, blocksForSeconds } from "../chains";
import { resolveRpcsForChain } from "../rpc-resolver";
import { RadarBoard, UpcomingDrop, Verdict, countdown, priceLabel, leadMs, isLive } from "../drop-radar";
import { runDropRadar } from "../radar-watch";
import { scanAllMints } from "../minter-scan";
import { scanSales, mergeSales } from "../seaport-sales";
import { profitScout, whyProfit } from "../profit-scout";
import { scout, why, RankedMinter } from "../minter-scout";
import { dossierRows, summaryRow, describeDossier } from "../smart-wallet";
import { buildDossier } from "../smart-wallet-build";
import { toCsv } from "../wallet-csv";
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
  mainBotUsername?: () => string | undefined,
  smartBotUsername?: () => string | undefined
): RadarBot | null {
  const cleaned = cleanToken(token);
  if (!cleaned.token) {
    // Said out loud. Returning null in silence makes "not configured"
    // indistinguishable from "not responding", and the second is what it
    // looks like from the chat -- you press Start and nothing ever answers.
    console.log(`Radar (bot 3): off — TELEGRAM_RADAR_BOT_TOKEN is not set. Effect: no drop radar, no scout, no proven profit.`);
    return null;
  }
  for (const note of cleaned.notes) console.warn(`TELEGRAM_RADAR_BOT_TOKEN: ${note}.`);
  if (!cleaned.looksValid) {
    console.error("TELEGRAM_RADAR_BOT_TOKEN is not shaped like a bot token. The radar stays off.");
    return null;
  }

  const bot = new Telegraf(cleaned.token);
  // Before any handler. Without these a single bad button press rejects the
  // launch promise and the bot silently stops polling -- which is what took
  // bot 3 down after every redeploy.
  installGuards(bot, "Radar (bot 3)");
  const handle: RadarBot = { telegram: bot.telegram, stop: (reason) => bot.stop(reason) };
  const boards = new Map<string, RadarBoard>();
  const watchers = new Map<string, { stopped: boolean }>();
  const owner = (ctx: any): boolean => ctx.from?.id === ownerId;

  const boardFor = (key: string): RadarBoard => {
    let b = boards.get(key);
    if (!b) boards.set(key, (b = new RadarBoard()));
    return b;
  };

  /** Which chains the radar watches. Falls back to the shipped default. */
  function radarChains(store: ReturnType<UserStores["for"]>): string[] {
    const chosen = store.getSettings().radarChainKeys;
    if (chosen && chosen.length > 0) return chosen.filter((k) => resolveChain(k));
    return CHAINS.filter((c) => c.key !== "avalanche").map((c) => c.key);
  }

  function chainsMenu(store: ReturnType<UserStores["for"]>) {
    const on = new Set(radarChains(store));
    const rows = CHAINS.map((c) => [
      Markup.button.callback(
        `${on.has(c.key) ? "✅" : "⬜"} ${c.name}${watchers.has(c.key) ? " · watching" : ""}`,
        `radar:chain:${c.key}`
      ),
    ]);
    rows.push([Markup.button.callback("⬅ Back", "radar:menu")]);
    return Markup.inlineKeyboard(rows);
  }

  bot.action("radar:chains", async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      "Chains the radar watches.\n\n" +
        "Watching only reads, so there is no cost to adding one — the only reason to leave a " +
        "chain off is that it runs no drops.",
      chainsMenu(stores.for(ownerId))
    );
  });

  bot.action(/^radar:chain:([a-z0-9-]+)$/, async (ctx) => {
    if (!owner(ctx)) return;
    const key = ctx.match[1];
    const store = stores.for(ownerId);
    const current = new Set(radarChains(store));
    if (current.has(key)) {
      current.delete(key);
      // Stop it now rather than at the next restart, or the toggle is a lie.
      const running = watchers.get(key);
      if (running) running.stopped = true;
    } else {
      current.add(key);
    }
    store.updateSettings({ radarChainKeys: [...current] });
    await ctx.answerCbQuery(current.has(key) ? "Watching" : "Off");

    // A chain switched on while the radar is running starts immediately.
    if (current.has(key) && watchers.size > 0) startWatching(ctx.chat!.id);
    return ctx.editMessageReplyMarkup(chainsMenu(store).reply_markup).catch(() => {});
  });

  function menu() {
    const on = [...watchers.keys()];
    return Markup.inlineKeyboard([
      [Markup.button.callback("📡 Board", "radar:board"), Markup.button.callback("🔭 Scout", "radar:scout")],
      [Markup.button.callback("💰 Proven profit", "radar:profit")],
      [Markup.button.callback("🧠 Smart wallets", "smart:list"), Markup.button.callback("⬇ Export CSV", "smart:export")],
      [Markup.button.callback("🌐 Chains", "radar:chains")],
      [Markup.button.callback(on.length ? `⏸ Stop (${on.length})` : "▶️ Start watching", "radar:toggle")],
    ]);
  }

  /**
   * A CSV of results, and a one-tap link that starts watching all of them.
   *
   * The link carries a HANDLE rather than the addresses: Telegram caps a
   * deep-link payload at 64 characters, which is one and a half addresses.
   */
  async function offerWatchAll(
    chatId: number,
    addresses: string[],
    rows: Record<string, string | number>[],
    note: string,
    chainName: string
  ) {
    if (addresses.length === 0) return;

    const csv = toCsv(rows);
    if (csv) {
      const stamp = new Date().toISOString().slice(0, 10);
      const slug = chainName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      await bot.telegram
        .sendDocument(chatId, {
          source: Buffer.from(csv, "utf8"),
          filename: `${note}-${slug}-${stamp}.csv`,
        })
        .catch(() => {});
    }

    const smart = smartBotUsername?.();
    const id = stores.for(ownerId).stageWalletBatch(addresses, note);

    await bot.telegram
      .sendMessage(
        chatId,
        smart
          ? "☝️ Every wallet in that list, as a file. One tap to watch them all:"
          : "☝️ Every wallet in that list, as a file.\n\n_Set TELEGRAM_SMART_BOT_TOKEN to get a one-tap watch button here._",
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard(
            smart
              ? [[Markup.button.url(`👁 Watch all ${addresses.length}`, `https://t.me/${smart}?start=add_${id}`)]]
              : []
          ),
        }
      )
      .catch(() => {});
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
      `${headline} — ${named?.name ?? "Unknown collection"} on ${chain.name}\n` +
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
    // The radar's own list, not Auto Mint's. Watching is free; minting is not,
    // so the two lists want different lengths.
    const keys = radarChains(store);
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
      })
        // .finally() does NOT handle a rejection -- it re-raises it. Without
        // this catch, a watcher throwing became an unhandled rejection, and
        // Node's default since v15 is to KILL THE PROCESS. The symptom was
        // that a redeploy fixed the bot, it flushed its backlog, and then it
        // stopped: the watcher was dying and taking all four bots with it.
        .catch((err: any) => {
          const name = resolveChain(key)?.name ?? key;
          console.error(`Radar watcher for ${name} stopped: ${err?.message ?? err}`);
          void bot.telegram
            .sendMessage(chatId, `Radar stopped watching ${name} — ${err?.message ?? err}`)
            .catch(() => {});
        })
        .finally(() => watchers.delete(key));
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
    const store = stores.for(ownerId);
    if (watchers.size > 0) {
      for (const s of watchers.values()) s.stopped = true;
      // Written down, so a deliberate stop is not undone by the next deploy.
      store.updateSettings({ radarWatchOn: false });
      return ctx.editMessageText("Radar off. It will stay off until you turn it back on.", menu());
    }
    store.updateSettings({ radarWatchOn: true });
    const n = startWatching(ctx.chat!.id);
    return ctx.editMessageText(
      n > 0 ? `Radar on — watching ${n} chain(s).` : "No chains selected. Pick them in the main bot's settings.",
      menu()
    );
  });

  bot.action("radar:board", async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery();

    // One board across every chain, sorted by when each opens rather than
    // grouped by chain. A countdown answers "what is next", and that question
    // does not care which chain the answer is on — but every row has to SAY
    // which, or the board is unreadable the moment a second chain is watched.
    const rows: { at: number; text: string }[] = [];
    for (const [key, board] of boards) {
      const chain = resolveChain(key);
      for (const d of board.board()) {
        rows.push({
          at: d.startTime,
          text:
            `${isLive(d) ? "🔴" : "⏳"} *${chain?.name ?? key}* · \`${mask(d.contract)}\`\n` +
            `   ${countdown(leadMs(d))} · ${priceLabel(d.priceWei, chain?.nativeSymbol ?? "ETH")}` +
            ` · max ${d.maxPerWallet}`,
        });
      }
    }
    rows.sort((a, b) => a.at - b.at);

    const watching = [...watchers.keys()].map((k) => resolveChain(k)?.name ?? k);
    const header = watching.length
      ? `📡 *Board* — watching ${watching.join(", ")}`
      : "📡 *Board* — radar is off";

    return ctx.editMessageText(
      rows.length
        ? `${header}\n\n${rows.map((r) => r.text).join("\n\n")}`
        : `${header}\n\nNothing upcoming yet.`,
      { parse_mode: "Markdown", ...menu() }
    );
  });

  bot.action("radar:profit", async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery("Scanning…");
    return runProfitScout(ctx.chat!.id);
  });

  bot.action(/^profit:on:([a-z0-9-]+)$/, async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery("Scanning…");
    return runProfitScout(ctx.chat!.id, ctx.match[1]);
  });

  bot.command("profit", (ctx) => {
    if (!owner(ctx)) return;
    return runProfitScout(ctx.chat.id);
  });

  /**
   * Who has actually made money, settled on-chain.
   *
   * Scout ranks on earliness, which says a wallet behaves like it knows
   * something. This ranks on whether it was right — mints matched to Seaport
   * sales, cost against proceeds, both sides prices a transaction happened at.
   */
  async function runProfitScout(chatId: number, chainKey?: string) {
    const store = stores.for(ownerId);
    const key = chainKey ?? store.getSettings().chainKey;
    const chain = resolveChain(key);
    if (!chain) return;
    const { urls } = resolveRpcsForChain(key);

    const note = await bot.telegram.sendMessage(chatId, `💰 Reading ${chain.name} mints and sales…`);
    const edit = (t: string) =>
      bot.telegram
        .editMessageText(chatId, note.message_id, undefined, t, { parse_mode: "Markdown" })
        .catch(() => {});

    try {
      const provider = createProvider(urls[0]);
      const head = await provider.getBlockNumber();
      // Six hours. A win rate needs sales to count, and sales are rarer than
      // mints — two hours of this chain yields too few to rank on.
      const span = blocksForSeconds(key, 6 * 3600);
      const from = Math.max(0, head - span);
      const chunk = logChunkBlocksFor(key);

      // Both streams at once: they are independent reads over the same range,
      // and doing them in turn doubles the wait for no benefit.
      const [mints, sales] = await Promise.all([
        scanAllMints(urls[0], from, head, { chunkBlocks: chunk, maxRecords: 80_000 }),
        scanSales(urls[0], from, head, { chunkBlocks: chunk, maxRecords: 80_000 }),
      ]);

      const mine = store.listWallets().map((w) => w.address);
      const watched = store.listCopyTargets().map((t) => t.address);
      const top = profitScout(mints, sales, { limit: 8, exclude: [...mine, ...watched] });

      if (top.length === 0) {
        return edit(
          `No wallet on ${chain.name} has a provable profit in the last six hours.\n\n` +
            `_${mints.length} mints and ${sales.length} sales read. A wallet needs to have both ` +
            "minted AND sold here to have a cost basis at all._"
        );
      }

      await edit(
        `💰 *Proven profit — ${chain.name}*\n\n` +
          `${mints.length.toLocaleString()} mints · ${sales.length.toLocaleString()} settled sales · last 6h\n\n` +
          "Mints matched to Seaport sales. Both sides are prices a transaction actually happened at — " +
          "not a floor, which is an ask, and not an offer, which is a bid."
      );

      for (const m of top) {
        await bot.telegram.sendMessage(
          chatId,
          `\`${m.address}\`\n${whyProfit(m)}`,
          {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "🧠 Record",
                  `scout:save:${m.address}:${m.score.toFixed(2)}:${m.winRate.toFixed(3)}`
                ),
                Markup.button.callback("👀 Copy", `scout:watch:${m.address}`),
              ],
              [
                Markup.button.callback("📊 Dossier", `smart:dossier:${m.address}`),
                Markup.button.url("🔎 Explorer", `${chain.explorer}/address/${m.address}`),
              ],
            ]),
          }
        );
      }

      await offerWatchAll(
        chatId,
        top.map((m) => m.address),
        top.map((m) => ({
          wallet: m.address,
          chain: key,
          win_rate: m.winRate.toFixed(2),
          sold: m.sold,
          realised_eth: m.realisedEth.toFixed(5),
          per_sale_eth: m.perSaleEth.toFixed(6),
          proceeds_eth: m.proceedsEth.toFixed(5),
          cost_eth: m.costEth.toFixed(5),
          collections: m.collections,
          best_sale_eth: m.bestSaleEth.toFixed(5),
          score: m.score.toFixed(2),
        })),
        "proven-profit",
        chain.name
      );

      const others = radarChains(store).filter((k) => k !== key);
      if (others.length > 0) {
        await bot.telegram.sendMessage(chatId, "Check another chain:", {
          ...Markup.inlineKeyboard(
            others.map((k) => [Markup.button.callback(resolveChain(k)?.name ?? k, `profit:on:${k}`)])
          ),
        });
      }
    } catch (err: any) {
      await edit(`Profit scan failed: ${err?.message ?? err}`);
    }
  }

  bot.action("radar:scout", async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery("Scanning…");
    return runScout(ctx.chat!.id);
  });

  bot.action(/^scout:on:([a-z0-9-]+)$/, async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery("Scanning…");
    return runScout(ctx.chat!.id, ctx.match[1]);
  });

  bot.command("scout", (ctx) => {
    if (!owner(ctx)) return;
    return runScout(ctx.chat.id);
  });

  bot.command("board", (ctx) => {
    if (!owner(ctx)) return;
    return ctx.reply("📡 Radar:", menu());
  });

  async function runScout(chatId: number, chainKey?: string) {
    const store = stores.for(ownerId);
    const key = chainKey ?? store.getSettings().chainKey;
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

      // Scouting is per chain: minters on Ink are a different population from
      // minters on Ethereum, and averaging them would describe neither.
      await offerWatchAll(
        chatId,
        top.map((m) => m.address),
        top.map((m) => ({
          wallet: m.address,
          chain: key,
          mints: m.mints,
          collections: m.collections,
          earliness_percent: Math.round(m.earliness * 100),
          front_runs: m.frontRuns,
          score: m.score.toFixed(2),
        })),
        "scout",
        chain.name
      );

      await bot.telegram.sendMessage(chatId, "Scout another chain:", {
        ...Markup.inlineKeyboard(
          radarChains(store)
            .filter((k) => k !== key)
            .map((k) => [Markup.button.callback(resolveChain(k)?.name ?? k, `scout:on:${k}`)])
        ),
      });

      for (const m of top) {
        await bot.telegram.sendMessage(
          chatId,
          `\`${m.address}\`\n${why(m)}`,
          {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback("🧠 Record", `scout:save:${m.address}:${m.score.toFixed(2)}:${m.earliness.toFixed(3)}`),
                Markup.button.callback("👀 Copy", `scout:watch:${m.address}`),
              ],
              [
                Markup.button.callback("📊 Dossier", `smart:dossier:${m.address}`),
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


  // ── smart wallets: record, read, export ──────────────────────────────────

  bot.action(/^scout:save:(0x[0-9a-fA-F]{40}):([0-9.]+):([0-9.]+)$/, async (ctx) => {
    if (!owner(ctx)) return;
    const [, address, sc, early] = ctx.match;
    const store = stores.for(ownerId);
    store.addSmartWallet({
      address,
      label: `smart-${address.slice(-4)}`,
      addedAt: Date.now(),
      chainKey: store.getSettings().chainKey,
      scoutedScore: Number(sc),
      scoutedEarliness: Number(early),
    });
    await ctx.answerCbQuery("Recorded.");
    return undefined;
  });

  bot.action("smart:list", async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery();
    const list = stores.for(ownerId).listSmartWallets();
    if (list.length === 0) {
      return ctx.editMessageText("No smart wallets recorded yet. Run Scout and press Record.", menu());
    }
    const body = list
      .map(
        (w) =>
          "`" + mask(w.address) + "` — score " + (w.scoutedScore ?? 0).toFixed(2) +
          ", " + Math.round((w.scoutedEarliness ?? 0) * 100) + "% early"
      )
      .join("\n");
    return ctx.editMessageText("🧠 *Smart wallets* (" + list.length + ")\n\n" + body, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        ...list.slice(0, 8).map((w) => [
          Markup.button.callback("📊 " + mask(w.address), `smart:dossier:${w.address}`),
          Markup.button.callback("🗑", `smart:drop:${w.address}`),
        ]),
        [Markup.button.callback("⬅ Back", "radar:menu")],
      ]),
    });
  });

  bot.action(/^smart:drop:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
    if (!owner(ctx)) return;
    stores.for(ownerId).removeSmartWallet(ctx.match[1]);
    await ctx.answerCbQuery("Removed.");
    return undefined;
  });

  bot.action("radar:menu", async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery();
    return ctx.editMessageText("📡 Radar:", menu());
  });

  bot.action(/^smart:dossier:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery("Building…");
    return sendDossier(ctx.chat!.id, ctx.match[1]);
  });

  bot.command("smart", async (ctx) => {
    if (!owner(ctx)) return;
    const arg = ctx.message.text.split(/\s+/)[1];
    if (arg && /^0x[0-9a-fA-F]{40}$/.test(arg)) return sendDossier(ctx.chat.id, arg);
    return ctx.reply("📡 Radar:", menu());
  });

  /**
   * Everything known about one wallet: what it minted, what it paid, what it
   * still holds, and what that is worth now.
   */
  async function sendDossier(chatId: number, address: string) {
    const store = stores.for(ownerId);
    const key = store.getSettings().chainKey;
    const chain = resolveChain(key);
    if (!chain) return;
    const { urls } = resolveRpcsForChain(key);

    const note = await bot.telegram.sendMessage(chatId, `Reading ${mask(address)}…`);
    const edit = (t: string) =>
      bot.telegram
        .editMessageText(chatId, note.message_id, undefined, t, { parse_mode: "Markdown" })
        .catch(() => {});

    try {
      const provider = createProvider(urls[0]);
      const head = await provider.getBlockNumber();
      // A day of history: far enough back to be a record rather than a
      // snapshot, close enough that the scan stays minutes not hours.
      const span = blocksForSeconds(key, 24 * 3600);
      const from = Math.max(0, head - span);

      // One wallet, so both queries can use the event's own indexed topic and
      // the node answers from an index. Measured: 2,000,000 blocks in ONE call
      // in 300ms, where the unfiltered version needed the range chunked and
      // capped to a day. That is why the window below is a WEEK rather than a
      // day -- it is both faster and covers far more history, which also
      // retires most of the "holdings predate this window" answer.
      const wide = Math.max(0, head - blocksForSeconds(key, 7 * 24 * 3600));

      await edit(`Reading ${mask(address)} across a week of ${chain.name}…`);
      const [records, listed, broad] = await Promise.all([
        scanAllMints(urls[0], wide, head, { minters: [address], maxRecords: 60_000 }),
        // Catches everything this wallet LISTED, over the whole week.
        scanSales(urls[0], wide, head, { offerers: [address], maxRecords: 60_000 }),
        // And a broad recent sweep, because a sale made by ACCEPTING an offer
        // names the seller in a field Seaport does not index, so the filtered
        // query above cannot see it.
        scanSales(urls[0], from, head, {
          chunkBlocks: logChunkBlocksFor(key),
          maxRecords: 60_000,
        }),
      ]);
      const sales = mergeSales(listed, broad);

      const dossier = await buildDossier({
        sales,
        address,
        chainKey: key,
        symbol: chain.nativeSymbol,
        rpcUrl: urls[0],
        records,
        window: { from, to: head },
        apiKey: process.env.OPENSEA_API_KEY,
        onProgress: (done, total) => {
          if (done % 5 === 0) void edit(`Pricing ${done}/${total} collections…`);
        },
      });

      const saved = store.listSmartWallets().find((w) => w.address.toLowerCase() === address.toLowerCase());
      await edit(describeDossier(dossier, saved?.label));

      const top = dossier.positions.slice(0, 6);
      if (top.length > 0) {
        const lines = top
          .map(
            (p) =>
              (p.name ?? mask(p.contract)) +
              ` — ${p.minted} minted` +
              (p.held !== undefined ? `, ${p.held} held` : "") +
              (p.floorEth != null ? `, floor ${p.floorEth}` : "")
          )
          .join("\n");
        await bot.telegram.sendMessage(chatId, "*What they minted*\n\n" + lines, { parse_mode: "Markdown" });
      }

      // The file, always: a dossier is the kind of thing worth keeping.
      const csv = toCsv(dossierRows(dossier));
      if (csv) {
        await bot.telegram.sendDocument(chatId, {
          source: Buffer.from(csv, "utf8"),
          filename: `${address.slice(0, 10)}-positions.csv`,
        });
      }
    } catch (err: any) {
      await edit(`Could not build that dossier: ${err?.message ?? err}`);
    }
  }

  bot.action("smart:export", async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery("Exporting…");
    return exportAll(ctx.chat!.id);
  });

  bot.command("export", (ctx) => {
    if (!owner(ctx)) return;
    return exportAll(ctx.chat.id);
  });

  /** Every recorded wallet, one row each, as a file. */
  async function exportAll(chatId: number) {
    const store = stores.for(ownerId);
    const list = store.listSmartWallets();
    if (list.length === 0) {
      return bot.telegram.sendMessage(chatId, "Nothing recorded yet. Run Scout and press Record.");
    }
    const key = store.getSettings().chainKey;
    const chain = resolveChain(key)!;
    const { urls } = resolveRpcsForChain(key);

    const note = await bot.telegram.sendMessage(chatId, `Building a report on ${list.length} wallet(s)…`);
    const edit = (t: string) =>
      bot.telegram.editMessageText(chatId, note.message_id, undefined, t).catch(() => {});

    try {
      const provider = createProvider(urls[0]);
      const head = await provider.getBlockNumber();
      const span = blocksForSeconds(key, 24 * 3600);
      const from = Math.max(0, head - span);
      // Scanned ONCE and reused for every wallet. A per-wallet scan would
      // re-read the same day of chain for every row in the report.
      const records = await scanAllMints(urls[0], from, head, {
        chunkBlocks: logChunkBlocksFor(key),
        maxRecords: 60_000,
      });
      await edit("Reading settled sales from Seaport…");
      const sales = await scanSales(urls[0], from, head, {
        chunkBlocks: logChunkBlocksFor(key),
        maxRecords: 60_000,
      });

      const summaries: Record<string, string | number>[] = [];
      const positions: Record<string, string | number>[] = [];
      for (const [i, w] of list.entries()) {
        await edit(`Pricing wallet ${i + 1}/${list.length}…`);
        const d = await buildDossier({
          sales,
          address: w.address,
          chainKey: key,
          symbol: chain.nativeSymbol,
          rpcUrl: urls[0],
          records,
          window: { from, to: head },
          apiKey: process.env.OPENSEA_API_KEY,
        });
        summaries.push(summaryRow(d, w));
        positions.push(...dossierRows(d));
      }

      await edit(`Done — ${summaries.length} wallet(s), ${positions.length} position(s).`);
      const stamp = new Date().toISOString().slice(0, 10);
      await bot.telegram.sendDocument(chatId, {
        source: Buffer.from(toCsv(summaries), "utf8"),
        filename: `smart-wallets-${stamp}.csv`,
      });
      if (positions.length > 0) {
        await bot.telegram.sendDocument(chatId, {
          source: Buffer.from(toCsv(positions), "utf8"),
          filename: `smart-wallet-positions-${stamp}.csv`,
        });
      }
    } catch (err: any) {
      await edit(`Export failed: ${err?.message ?? err}`);
    }
  }

  bot
    .launch(() => {
      console.log(`Radar bot running — drop radar and scout, reporting to ${ownerId}.`);

      // Watching is what this bot is FOR, so it does not wait to be asked.
      // A feed that needs a tap after every deploy is one you discover is off
      // by missing the thing it existed to catch.
      //
      // A Telegram private chat carries the same id as the user, so the owner
      // id already addresses the right conversation -- provided they have
      // pressed Start once, which Telegram requires before any bot may write.
      if (stores.for(ownerId).getSettings().radarWatchOn !== false) {
        try {
          const started = startWatching(ownerId);
          console.log(`Radar auto-started on ${started} chain(s).`);
        } catch (err: any) {
          console.error(`Radar could not auto-start: ${err?.message ?? err}`);
        }
      } else {
        console.log("Radar is off — stopped deliberately, and it stays that way until turned back on.");
      }
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
      if (err?.response?.error_code === 409) {
        // Telegram allows exactly ONE long-poller per token. A second one --
        // an old deployment still alive, a local run, the same token pasted
        // into two variables -- gets this, and the bot simply never receives
        // an update while looking perfectly healthy.
        console.error(
          "TELEGRAM_RADAR_BOT_TOKEN: another instance is already polling this token. " +
            "Stop the old deployment, or give this bot its own token from @BotFather."
        );
      }
    });

  return handle;
}

export { CHAINS, formatEther };
