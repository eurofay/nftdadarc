// Telegram control surface for the mint sniper. Wraps the same tested engine
// the CLI uses (buildLocalMintPlan / localPublicSnipe / runAutoMintWatcher /
// runCopyMintWatcher) — this file is UI and wiring, not mint logic.
//
// Access is restricted to one Telegram user id (TELEGRAM_OWNER_ID) in private
// chat only; every other update is silently ignored.

import { Telegraf, Markup, Context } from "telegraf";
import { message } from "telegraf/filters";
import { isAddress, JsonRpcProvider, formatEther } from "ethers";
import { TelegramStore } from "./store";
import { mainMenu, walletsMenu, copyMenu, autoMenu, settingsMenu, chainPickerMenu, maskAddress } from "./menus";
import { resolveChain } from "../chains";
import { resolveRpcsForChain } from "../rpc-resolver";
import { parseNftLink } from "../nft-link";
import { resolveSlug } from "../slug-resolver";
import { buildLocalMintPlan } from "../seadrop-public";
import { localPublicSnipe } from "../local-mint";
import { runAutoMintWatcher } from "../auto-mint";
import { runCopyMintWatcher } from "../copy-mint";
import { createLogger, LogSink } from "../logger";

interface SessionData {
  step?: "awaiting_wallet_key" | "awaiting_copy_target" | `awaiting_setting:${string}`;
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

  let runningAuto: RunningWatcher | null = null;
  let runningCopy: RunningWatcher | null = null;

  // ── Menu navigation ──────────────────────────────────────────────────
  bot.start((ctx) => ctx.reply("NFT Public Mint Sniper — choose an action:", mainMenu()));
  bot.action("menu:main", (ctx) => ctx.editMessageText("Choose an action:", mainMenu()));

  bot.action("menu:wallets", (ctx) =>
    ctx.editMessageText("Wallets (tap to remove):", walletsMenu(store.listWallets()))
  );

  bot.action("menu:settings", (ctx) =>
    ctx.editMessageText("Settings (tap to change):", settingsMenu(store.getSettings()))
  );

  bot.action("menu:auto", (ctx) =>
    ctx.editMessageText(
      `Auto free-mint watcher: ${runningAuto ? "🟢 running" : "🔴 stopped"}\n` +
        "Detects any SeaDrop drop going live at price 0 and mints the max per wallet — no confirmation.",
      autoMenu(runningAuto !== null)
    )
  );

  bot.action("menu:copy", (ctx) =>
    ctx.editMessageText(
      `Copy-mint watcher: ${runningCopy ? "🟢 running" : "🔴 stopped"}\n` +
        "Copies any mintPublic call from a watched wallet, using your own wallets.",
      copyMenu(runningCopy !== null, store.listCopyTargets())
    )
  );

  bot.action("menu:status", async (ctx) => {
    const settings = store.getSettings();
    const wallets = store.listWallets();
    const chain = resolveChain(settings.chainKey);
    let balances = "";
    if (chain && wallets.length > 0) {
      try {
        const { urls } = resolveRpcsForChain(settings.chainKey);
        const provider = new JsonRpcProvider(urls[0]);
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
        `Auto mint: ${runningAuto ? "running" : "stopped"}\n` +
        `Copy mint: ${runningCopy ? "running" : "stopped"} (watching ${store.listCopyTargets().length})`,
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
    return ctx.editMessageText("Wallets (tap to remove):", walletsMenu(store.listWallets()));
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

  bot.action("copy:toggle", async (ctx) => {
    if (runningCopy) {
      runningCopy.stopSignal.stopped = true;
      runningCopy = null;
      await ctx.answerCbQuery("Stopping...");
    } else {
      const targets = store.listCopyTargets();
      const wallets = store.listWallets();
      const settings = store.getSettings();
      if (targets.length === 0) return ctx.answerCbQuery("Add a wallet to watch first.", { show_alert: true });
      if (wallets.length === 0) return ctx.answerCbQuery("Add a wallet to mint from first.", { show_alert: true });

      const chain = resolveChain(settings.chainKey)!;
      const { urls } = resolveRpcsForChain(settings.chainKey);
      const stopSignal = { stopped: false };
      const logger = createLogger(createTelegramSink(bot, ctx.chat!.id));
      const promise = runCopyMintWatcher({
        chain,
        rpcUrls: urls,
        walletKeys: store.getDecryptedKeys(),
        watchTargets: targets.map((t) => t.address),
        maxFeePerGas: gweiToWei(settings.maxFeeGwei),
        maxPriorityFee: gweiToWei(settings.priorityGwei),
        gasLimit: settings.gasLimit,
        pollIntervalMs: 4000,
        maxPriceEth: settings.copyMintMaxPriceEth,
        logger,
        stopSignal,
      }).catch((err) => logger.errorBold(`Copy-mint watcher crashed: ${err.message}`));
      runningCopy = { stopSignal, promise };
      await ctx.answerCbQuery("Started.");
    }
    return ctx.editMessageText(
      `Copy-mint watcher: ${runningCopy ? "🟢 running" : "🔴 stopped"}`,
      copyMenu(runningCopy !== null, store.listCopyTargets())
    );
  });

  // ── Auto free-mint watcher ───────────────────────────────────────────
  bot.action("auto:toggle", async (ctx) => {
    if (runningAuto) {
      runningAuto.stopSignal.stopped = true;
      runningAuto = null;
      await ctx.answerCbQuery("Stopping...");
    } else {
      const wallets = store.listWallets();
      const settings = store.getSettings();
      if (wallets.length === 0) return ctx.answerCbQuery("Add a wallet first.", { show_alert: true });

      const chain = resolveChain(settings.chainKey)!;
      const { urls } = resolveRpcsForChain(settings.chainKey);
      const stopSignal = { stopped: false };
      const logger = createLogger(createTelegramSink(bot, ctx.chat!.id));
      const promise = runAutoMintWatcher({
        chain,
        rpcUrls: urls,
        walletKeys: store.getDecryptedKeys(),
        maxFeePerGas: gweiToWei(settings.maxFeeGwei),
        maxPriorityFee: gweiToWei(settings.priorityGwei),
        gasLimit: settings.gasLimit,
        pollIntervalMs: 4000,
        maxQuantityPerWallet: settings.autoMaxQuantity,
        openseaApiKey: process.env.OPENSEA_API_KEY,
        logChunkBlocks: process.env.AUTO_LOG_CHUNK_BLOCKS ? parseInt(process.env.AUTO_LOG_CHUNK_BLOCKS, 10) : undefined,
        logger,
        stopSignal,
      }).catch((err) => logger.errorBold(`Auto-mint watcher crashed: ${err.message}`));
      runningAuto = { stopSignal, promise };
      await ctx.answerCbQuery("Started.");
    }
    return ctx.editMessageText(
      `Auto free-mint watcher: ${runningAuto ? "🟢 running" : "🔴 stopped"}`,
      autoMenu(runningAuto !== null)
    );
  });

  // ── Settings ─────────────────────────────────────────────────────────
  bot.action("setting:chain", (ctx) => ctx.editMessageText("Pick a chain:", chainPickerMenu()));
  bot.action(/^setting:chain:(.+)$/, (ctx) => {
    store.updateSettings({ chainKey: ctx.match[1] });
    return ctx.editMessageText("Settings:", settingsMenu(store.getSettings()));
  });

  const NUMERIC_SETTINGS = ["maxFeeGwei", "priorityGwei", "gasLimit", "autoMaxQuantity", "copyMintMaxPriceEth"] as const;
  for (const field of NUMERIC_SETTINGS) {
    bot.action(`setting:${field}`, (ctx) => {
      ctx.session.step = `awaiting_setting:${field}`;
      return ctx.reply(`Send the new value for ${field}${field === "autoMaxQuantity" ? " (or \"clear\" for unlimited)" : ""}:`);
    });
  }

  // ── Manual one-off mint ──────────────────────────────────────────────
  bot.command("mint", async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const [link, qtyRaw] = args;
    const quantity = parseInt(qtyRaw ?? "1", 10);
    if (!link || !Number.isFinite(quantity) || quantity <= 0) {
      return ctx.reply("Usage: /mint <contract address, OpenSea link, or slug> <quantity>");
    }

    const wallets = store.listWallets();
    const settings = store.getSettings();
    if (wallets.length === 0) return ctx.reply("Add a wallet first.");

    const logger = createLogger(createTelegramSink(bot, ctx.chat!.id));
    try {
      const parsed = parseNftLink(link);
      let contract: string;
      if (parsed.kind === "address") {
        contract = parsed.value;
      } else {
        const info = await resolveSlug(parsed.value, process.env.OPENSEA_API_KEY, settings.chainKey);
        contract = info.contractAddress;
      }

      const chain = resolveChain(settings.chainKey)!;
      const { urls } = resolveRpcsForChain(settings.chainKey);
      const plan = await buildLocalMintPlan(urls[0], contract, quantity);
      if (!plan) return ctx.reply("No public drop found for that contract on the configured chain.");

      await localPublicSnipe({
        nftContract: contract,
        quantity,
        walletKeys: store.getDecryptedKeys(),
        rpcUrls: urls,
        maxFeePerGas: gweiToWei(settings.maxFeeGwei),
        maxPriorityFee: gweiToWei(settings.priorityGwei),
        gasLimit: settings.gasLimit,
        targetStart: null,
        plan,
        logger,
      });
      void chain;
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

    if (step.startsWith("awaiting_setting:")) {
      const field = step.slice("awaiting_setting:".length) as (typeof NUMERIC_SETTINGS)[number];
      ctx.session.step = undefined;
      const raw = ctx.message.text.trim();

      if (field === "autoMaxQuantity" && raw.toLowerCase() === "clear") {
        store.updateSettings({ autoMaxQuantity: undefined });
        return ctx.reply("Cleared — auto mint will use each drop's true max per wallet.");
      }

      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) return ctx.reply("That's not a valid number.");
      store.updateSettings({ [field]: value } as any);
      return ctx.reply(`✅ ${field} set to ${value}.`, settingsMenu(store.getSettings()));
    }
  });

  return bot;
}
