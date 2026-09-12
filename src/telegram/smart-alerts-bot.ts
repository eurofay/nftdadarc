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
import { parseWalletList, describeParse } from "../wallet-csv";
import { Wallet } from "ethers";
import { resolveMint, planLookup } from "../mint-resolve";
import { buildLocalMintPlan } from "../seadrop-public";
import { localPublicSnipe } from "../local-mint";
import { createLogger } from "../logger";
import {
  decideClusterMint,
  describeAsk,
  DEFAULT_CLUSTER_MINT,
  ClusterMintSettings,
  ASK_TTL_MS,
} from "../cluster-mint";

export interface SmartAlertsBot {
  telegram: Telegram;
  username?: string;
  stop: (reason?: string) => void;
}

/** Gwei to wei. Local rather than imported: the other copies are private. */
const gweiToWei = (gwei: number): bigint => BigInt(Math.round(gwei * 1e9));

/** First endpoint that answers, rather than the first that is listed. */
async function firstAnswer<T>(urls: string[], fn: (url: string) => Promise<T | null>): Promise<T | null> {
  for (const url of urls) {
    try {
      const out = await fn(url);
      if (out !== null && out !== undefined) return out;
    } catch {
      /* try the next endpoint */
    }
  }
  return null;
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
  let awaitingPaste = false;

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
      [Markup.button.callback("⚡ Auto-mint on a cluster", "sa:auto")],
      [
        Markup.button.callback("➕ Add wallets", "sa:add"),
        Markup.button.callback("🧠 Who I'm watching", "sa:who"),
      ],
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
            const cluster = clusters.note(a);
            await sendCluster(chatId, chainKey, cluster);
            if (cluster) await considerCluster(chatId, chainKey, cluster);
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

    // Arriving from the radar bot's "watch all of these" button. The payload
    // is a handle, not the list: Telegram caps it at 64 characters, which is
    // one and a half addresses.
    const payload = ctx.startPayload ?? "";
    if (payload.startsWith("add_")) {
      const batch = stores.for(ownerId).peekWalletBatch(payload.slice("add_".length));
      if (!batch) {
        return ctx.reply("That link has expired -- run the search again and use the new one.", menu());
      }
      const { added, already } = importWallets(batch.addresses, batch.note ?? "scout");
      return ctx.reply(
        "👁 Added *" + added + "* wallet(s) from " + (batch.note ?? "the radar bot") + "." +
          (already > 0 ? "\n\n_" + already + " were already on the list._" : "") +
          "\n\nPress Start watching and they are live.",
        { parse_mode: "Markdown", ...menu() }
      );
    }

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

  // ── getting wallets in ────────────────────────────────────────────────────
  //
  // Three doors onto one function, because the same list arrives three ways:
  // pasted from somewhere, as a file, or as a link from the radar bot that
  // already knows which wallets it just found.

  /** Record a parsed list and say what actually happened to it. */
  function importWallets(addresses: string[], source: string): { added: number; already: number } {
    const store = stores.for(ownerId);
    const existing = new Set(store.listSmartWallets().map((w) => w.address.toLowerCase()));
    let added = 0;
    let already = 0;
    for (const address of addresses) {
      if (existing.has(address.toLowerCase())) {
        already++;
        continue;
      }
      store.addSmartWallet({
        address,
        label: `${source}-${address.slice(-4)}`,
        addedAt: Date.now(),
        chainKey: store.getSettings().chainKey,
      });
      existing.add(address.toLowerCase());
      added++;
    }
    return { added, already };
  }

  function importSummary(parsed: ReturnType<typeof parseWalletList>, added: number, already: number): string {
    const lines = [`👁 Read ${describeParse(parsed)}.`, ""];
    lines.push(`Now watching *${added}* new wallet(s).`);
    // Said out loud rather than folded into the total: "I added 40" when 38
    // were already there is a number that looks like progress and is not.
    if (already > 0) lines.push(`_${already} were already on the list._`);
    if (parsed.invalid.length > 0) {
      lines.push("", `_Ignored ${parsed.invalid.length} entr${parsed.invalid.length === 1 ? "y" : "ies"} that were not addresses._`);
    }
    return lines.join("\n");
  }

  bot.action("sa:add", async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery();
    awaitingPaste = true;
    return ctx.editMessageText(
      "Send addresses, or upload a CSV.\n\n" +
        "Paste as many as you like — one per line, comma separated, or straight out of a " +
        "spreadsheet. Addresses are found by shape, so a header row, extra columns and the " +
        "exports from the radar bot all work without being told which column is which.",
      Markup.inlineKeyboard([[Markup.button.callback("Cancel", "sa:menu")]])
    );
  });

  bot.on("text", async (ctx, next) => {
    if (!owner(ctx) || !awaitingPaste) return next();
    awaitingPaste = false;
    const parsed = parseWalletList(ctx.message.text);
    if (parsed.addresses.length === 0) {
      return ctx.reply("No addresses in that. Send a list, or upload a CSV.", menu());
    }
    const { added, already } = importWallets(parsed.addresses, "paste");
    return ctx.reply(importSummary(parsed, added, already), { parse_mode: "Markdown", ...menu() });
  });

  /**
   * A CSV, straight from the radar bot's export.
   *
   * Accepted whether or not the paste prompt was open: sending a file of
   * wallets to a bot whose job is watching wallets has one obvious meaning,
   * and making it depend on a prior tap would just be a rule to remember.
   */
  bot.on("document", async (ctx) => {
    if (!owner(ctx)) return;
    const doc = ctx.message.document;
    // A quarter megabyte is tens of thousands of addresses; anything larger
    // is not a wallet list and should not be pulled into memory to find out.
    if ((doc.file_size ?? 0) > 256 * 1024) {
      return ctx.reply("That file is too big to be a wallet list.");
    }
    awaitingPaste = false;
    try {
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const text = await (await fetch(link.toString())).text();
      const parsed = parseWalletList(text);
      if (parsed.addresses.length === 0) {
        return ctx.reply(`No addresses found in ${doc.file_name ?? "that file"}.`, menu());
      }
      const { added, already } = importWallets(parsed.addresses, "csv");
      return ctx.reply(importSummary(parsed, added, already), { parse_mode: "Markdown", ...menu() });
    } catch (err: any) {
      return ctx.reply(`Couldn't read that file: ${err?.message ?? err}`);
    }
  });

  bot.action(/^sa:drop:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
    if (!owner(ctx)) return;
    stores.for(ownerId).removeSmartWallet(ctx.match[1]);
    await ctx.answerCbQuery("Removed.");
    return undefined;
  });

  bot.action("sa:clear", async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery();
    const n = stores.for(ownerId).listSmartWallets().length;
    return ctx.editMessageText(
      `Stop watching all ${n} wallet(s)?`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Yes, clear the list", "sa:clear:yes")],
        [Markup.button.callback("Keep them", "sa:menu")],
      ])
    );
  });

  bot.action("sa:clear:yes", async (ctx) => {
    if (!owner(ctx)) return;
    const store = stores.for(ownerId);
    for (const w of store.listSmartWallets()) store.removeSmartWallet(w.address);
    await ctx.answerCbQuery("Cleared.");
    return ctx.editMessageText("List cleared.", menu());
  });

  // ── following a crowd into a mint ─────────────────────────────────────────

  /** Confirmations waiting on a tap, by short id. Cleared when they expire. */
  const pending = new Map<
    string,
    { contract: string; wallets: string[]; quantity: number; at: number; name: string }
  >();

  let firedToday = 0;
  let firedDay = new Date().toDateString();

  function countFire() {
    const today = new Date().toDateString();
    if (today !== firedDay) {
      firedDay = today;
      firedToday = 0;
    }
    firedToday++;
  }

  function clusterSettings(store: ReturnType<UserStores["for"]>): ClusterMintSettings {
    return { ...DEFAULT_CLUSTER_MINT, ...(store.getSettings().clusterMint ?? {}) };
  }

  /**
   * Actually send it.
   *
   * Signing happens here, from the encrypted store, exactly as the main bot
   * does it — the keys never leave the process and this bot never sees one.
   */
  async function fireMint(chatId: number, contract: string, wallets: string[], quantity: number, why: string) {
    const store = stores.for(ownerId);
    const settings = store.getSettings();
    const chainKey = settings.chainKey;
    const chain = resolveChain(chainKey);
    if (!chain) return;
    const { urls } = resolveRpcsForChain(chainKey);
    const logger = createLogger((text) => void bot.telegram.sendMessage(chatId, text).catch(() => {}), "headlines");

    try {
      const resolved = await resolveMint({
        rpcUrls: urls,
        chainKey,
        chainId: chain.chainId,
        contract,
        wallets,
        quantity,
        signerFor: (address) => new Wallet(store.getDecryptedKey(address)),
      });
      if (!resolved || resolved.plans.length === 0) {
        return bot.telegram.sendMessage(chatId, "Couldn't resolve a mintable stage for that after all — nothing sent.");
      }

      const planFor = planLookup(resolved);
      const representative = resolved.plans[0].plan;
      countFire();

      const outcome = await localPublicSnipe({
        nftContract: contract,
        quantity: resolved.quantity,
        walletKeys: resolved.plans.map((p) => store.getDecryptedKey(p.address)),
        rpcUrls: urls,
        maxFeePerGas: gweiToWei(settings.maxFeeGwei),
        maxPriorityFee: gweiToWei(settings.priorityGwei),
        gasLimit: settings.gasLimit,
        earlyFireMs: settings.earlyFireMs,
        targetStart: null,
        plan: representative,
        planFor,
        onGas: (e) => store.recordGas(e),
        gasLabel: "Cluster Mint",
        logger,
      });

      await bot.telegram.sendMessage(
        chatId,
        outcome.minted.length > 0
          ? `Minted from ${outcome.minted.length} wallet(s) — ${why}.`
          : `Nothing confirmed. ${why}, but no wallet landed it.`
      );
    } catch (err: any) {
      await bot.telegram.sendMessage(chatId, `Cluster mint failed: ${err?.message ?? err}`);
    }
  }

  /**
   * A crowd formed. Work out whether to follow it, and how.
   *
   * Every branch that could spend runs through decideClusterMint, which is a
   * pure function with its own tests — the rule that a paid mint never fires
   * unattended lives there rather than in the middle of this.
   */
  async function considerCluster(chatId: number, chainKey: string, c: NonNullable<ReturnType<ClusterTracker["note"]>>) {
    const store = stores.for(ownerId);
    const settings = clusterSettings(store);
    if (!settings.enabled || c.kind !== "mint") return;

    const chain = resolveChain(chainKey);
    if (!chain) return;
    const { urls } = resolveRpcsForChain(chainKey);
    const mine = store.listWallets().map((w) => w.address);
    if (mine.length === 0) return;

    let priceEth: number | null = null;
    let maxPerWallet = 0;
    let alreadyHold = false;
    try {
      const plan = await firstAnswer(urls, (url: string) => buildLocalMintPlan(url, c.contract, 1));
      if (plan) {
        priceEth = Number(plan.drop.mintPrice) / 1e18;
        maxPerWallet = plan.drop.maxTotalMintableByWallet;
      }
      // Holding it already means the crowd is late for you, not early.
      const held = await createProvider(urls[0])
        .call({
          to: c.contract,
          data: "0x70a08231" + mine[0].slice(2).toLowerCase().padStart(64, "0"),
        })
        .catch(() => "0x");
      alreadyHold = held !== "0x" && BigInt(held) > 0n;
    } catch {
      /* priceEth stays null, which decideClusterMint treats as paid */
    }

    const decision = decideClusterMint({
      settings,
      clusterWallets: c.wallets.length,
      kind: c.kind,
      priceEth,
      eligible: mine,
      maxPerWallet,
      firedToday,
      alreadyHold,
    });

    const name = await nameOf(chainKey, c.contract);

    if (decision.action === "skip") {
      // Said quietly rather than silently: a rule that declines without
      // explanation is indistinguishable from one that is broken.
      await bot.telegram
        .sendMessage(chatId, `_Not auto-minting ${name} — ${decision.why}._`, { parse_mode: "Markdown" })
        .catch(() => {});
      return;
    }

    if (decision.action === "fire") {
      await bot.telegram.sendMessage(chatId, `⚡ Auto-minting *${name}* — ${decision.why}.`, {
        parse_mode: "Markdown",
      });
      return fireMint(chatId, c.contract, decision.wallets, decision.quantity, decision.why);
    }

    // Paid: ask, and let it expire.
    const id = Math.random().toString(36).slice(2, 10);
    pending.set(id, {
      contract: c.contract,
      wallets: decision.wallets,
      quantity: decision.quantity,
      at: Date.now(),
      name,
    });
    for (const [k, v] of pending) if (Date.now() - v.at > ASK_TTL_MS) pending.delete(k);

    await bot.telegram.sendMessage(chatId, describeAsk(decision, name, chain.nativeSymbol, priceEth ?? 0), {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback(`✅ Mint it — ${decision.totalCostEth.toFixed(4)} ${chain.nativeSymbol}`, `cm:go:${id}`)],
        [Markup.button.callback("✖ No", `cm:no:${id}`)],
      ]),
    });
  }

  bot.action(/^cm:go:(.+)$/, async (ctx) => {
    if (!owner(ctx)) return;
    const job = pending.get(ctx.match[1]);
    pending.delete(ctx.match[1]);
    if (!job) return ctx.answerCbQuery("That expired — the terms may have moved.", { show_alert: true });
    if (Date.now() - job.at > ASK_TTL_MS) {
      return ctx.answerCbQuery("That expired — the terms may have moved.", { show_alert: true });
    }
    await ctx.answerCbQuery("Minting…");
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    countFire();
    return fireMint(ctx.chat!.id, job.contract, job.wallets, job.quantity, "you confirmed it");
  });

  bot.action(/^cm:no:(.+)$/, async (ctx) => {
    if (!owner(ctx)) return;
    pending.delete(ctx.match[1]);
    await ctx.answerCbQuery("Left it.");
    return ctx.editMessageReplyMarkup(undefined).catch(() => {});
  });

  bot.action("sa:auto", async (ctx) => {
    if (!owner(ctx)) return;
    await ctx.answerCbQuery();
    const store = stores.for(ownerId);
    const s = clusterSettings(store);
    return ctx.editMessageText(
      "⚡ *Auto-mint on a cluster*\n\n" +
        `Currently *${s.enabled ? "on" : "off"}*.\n\n` +
        `Fires when *${s.minWallets}* watched wallets mint the same collection within ten minutes, ` +
        `using up to *${s.maxWallets}* of your wallets, *${s.quantityPerWallet}* each, ` +
        `at most *${s.maxPerDay}* times a day.\n\n` +
        (s.maxPriceEth > 0
          ? `Paid mints up to *${s.maxPriceEth}* each will ASK first.`
          : "*Free mints only.* A paid one is skipped rather than offered.") +
        "\n\n_A paid mint never fires without a tap, whatever these are set to._",
      Markup.inlineKeyboard([
        [Markup.button.callback(s.enabled ? "⏸ Turn off" : "▶️ Turn on", "sa:auto:toggle")],
        [
          Markup.button.callback(`Wallets needed: ${s.minWallets}`, "sa:auto:min"),
          Markup.button.callback(`Use: ${s.maxWallets}`, "sa:auto:use"),
        ],
        [Markup.button.callback(`Paid ceiling: ${s.maxPriceEth || "off"}`, "sa:auto:price")],
        [Markup.button.callback("⬅ Back", "sa:menu")],
      ])
    );
  });

  bot.action("sa:auto:toggle", async (ctx) => {
    if (!owner(ctx)) return;
    const store = stores.for(ownerId);
    const s = clusterSettings(store);
    store.updateSettings({ clusterMint: { ...s, enabled: !s.enabled } });
    await ctx.answerCbQuery(!s.enabled ? "On" : "Off");
    return (ctx as any).update.callback_query && bot.telegram
      .editMessageText(ctx.chat!.id, (ctx.callbackQuery as any).message.message_id, undefined, "…")
      .then(() => undefined)
      .catch(() => undefined);
  });

  for (const [action, field, values] of [
    ["sa:auto:min", "minWallets", [2, 3, 4, 5]],
    ["sa:auto:use", "maxWallets", [1, 2, 3, 5, 10]],
    ["sa:auto:price", "maxPriceEth", [0, 0.001, 0.005, 0.01, 0.05]],
  ] as const) {
    bot.action(action, async (ctx) => {
      if (!owner(ctx)) return;
      const store = stores.for(ownerId);
      const s = clusterSettings(store);
      const current = (s as any)[field] as number;
      // Cycle rather than prompt: four taps beats a typed number that has to
      // be validated, and every value here is one someone would actually pick.
      const next = values[(values.indexOf(current as never) + 1) % values.length];
      store.updateSettings({ clusterMint: { ...s, [field]: next } });
      await ctx.answerCbQuery(`${field}: ${next}`);
      return undefined;
    });
  }

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
