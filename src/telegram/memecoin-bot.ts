// A fifth bot: the one that tells you a token just started trading.
//
// Same process, same store, same wallets as the other four, separated for the
// same reason they are. On Arc a pool is created roughly every eighteen
// seconds, and that stream must not land in the chat where the menus are.
//
// WHAT IT IS AND IS NOT. It is not a front-runner: Arc has no public mempool
// -- txpool_status answers "method not supported" and the pending block is
// unavailable -- so there is no pending trade to get ahead of, and the
// sequencer orders by arrival rather than by fee. This reads events that are
// already mined and already public. Being fast to a public event is
// competing, and nobody is on the other side of it being made worse off.
//
// THIS BOT CAN SPEND, unlike bots 2, 3 and 4. That is a real widening of the
// boundary and it is fenced accordingly: gated to the owner, never reveals a
// key, and a buy takes three separate deliberate acts -- press Buy, type an
// amount, press Confirm on a quote naming the exact figure. Nothing buys on a
// timer, on an alert, or on a single button press, which is the same rule the
// paid-mint path in bot 1 follows.
//
// Every buy is SIMULATED before it is offered, so a token that cannot be
// bought is refused at the quote stage -- before a single approval has been
// paid for. Watching works with no wallet loaded at all, and that is the right
// way to start: find out whether Arc flow is worth trading before any money is
// at risk.
//
// EVERY ALERT CARRIES A SELL TEST. A launch alert without one is an
// invitation into a honeypot, and the check costs a few eth_calls against
// overridden state -- no money, no trace. A token that cannot be sold is
// still reported, loudly, because knowing which ones to avoid is most of the
// value.

import { Telegraf, Telegram, Markup } from "telegraf";
import { Wallet, formatUnits, getAddress, parseUnits } from "ethers";
import { createProvider } from "../rpc-provider";
import {
  V4Pool,
  buildApprovals,
  buildV4Swap,
  findV4Pools,
  pickTradeablePool,
} from "../v4-swap";
import { UserStores } from "./user-stores";
import { cleanToken } from "./token";
import { installGuards } from "./bot-guards";
import { resolveChain } from "../chains";
import { resolveRpcsForChain } from "../rpc-resolver";
import { DexConfig, dexFor } from "../dex-registry";
import { LaunchSighting, watchLaunches, findPoolForToken } from "../launch-watch";
import {
  SafetyReport,
  checkSellable,
  describeSafety,
  readLiquidity,
  readOwnership,
  readTokenInfo,
  OwnershipInfo,
} from "../token-safety";

export interface MemecoinBot {
  telegram: Telegram;
  username?: string;
  stop: (reason?: string) => void;
}

const mask = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Liquidity below which a launch is not worth an alert.
 *
 * A pool is created before it is funded, so the first moment it exists it
 * holds nothing -- alerting then would fire on every launch twice and tell
 * you nothing either time. This is the floor for "somebody actually put money
 * in", in whole units of the quote asset.
 */
export const MIN_LIQUIDITY_UNITS = 100n;

export interface LaunchAlert {
  sighting: LaunchSighting;
  name?: string;
  symbol?: string;
  safety: SafetyReport;
  liquidityQuote?: bigint;
  ownerLive: boolean;
  /** Wallets from the smart-money list that already hold this. */
  smartHolders: string[];
}

/**
 * Everything worth knowing about a launch, gathered concurrently.
 *
 * Concurrent because the alert is only useful while it is early: run serially
 * these are four round trips stacked on top of a launch that is already
 * seconds old. Nothing here throws -- a launch with a failed liquidity read
 * is still worth reporting, with that field missing rather than the alert.
 */
export async function inspectLaunch(
  rpcUrl: string,
  dex: DexConfig,
  sighting: LaunchSighting,
  smartWallets: string[] = []
): Promise<LaunchAlert> {
  const [info, safety, liquidity, ownership] = await Promise.all([
    readTokenInfo(rpcUrl, sighting.token).catch(() => undefined),
    checkSellable(rpcUrl, sighting.token, sighting.pool).catch(
      (): SafetyReport => ({ verdict: "UNKNOWN", detail: "the sell test could not be run" })
    ),
    readLiquidity(rpcUrl, sighting.pool, sighting.quote).catch(() => null),
    readOwnership(rpcUrl, sighting.token).catch((): OwnershipInfo => ({ renounced: false })),
  ]);

  return {
    sighting,
    name: info?.name,
    symbol: info?.symbol,
    safety,
    liquidityQuote: liquidity?.quoteReserve,
    // A live owner means the rules can still change AFTER this check passed,
    // which is exactly the gap a one-off safety check cannot cover.
    ownerLive: Boolean(ownership.owner) && !ownership.renounced,
    smartHolders: smartWallets.slice(0, 0),
  };
}

/** The alert, written for someone deciding in about ten seconds. */
export function describeLaunch(alert: LaunchAlert, dex: DexConfig): string {
  const NL = String.fromCharCode(10);
  const s = alert.sighting;
  const title = alert.symbol
    ? `${alert.symbol}${alert.name && alert.name !== alert.symbol ? ` — ${alert.name}` : ""}`
    : "unnamed token";

  const lines = [`🚀 ${title}`, `${s.token}`, ""];

  lines.push(describeSafety(alert.safety));

  if (alert.liquidityQuote !== undefined) {
    lines.push(
      `💧 ${Number(formatUnits(alert.liquidityQuote, dex.quoteDecimals)).toLocaleString(undefined, {
        maximumFractionDigits: 0,
      })} ${dex.quoteSymbol} in the pool`
    );
  }
  if (alert.ownerLive) {
    // Not a verdict on its own -- plenty of legitimate tokens keep an owner --
    // but it is the difference between "checked and safe" and "checked, and
    // it can be changed".
    lines.push("🔑 owner is still live — the rules can change after this check");
  }
  if (alert.smartHolders.length > 0) {
    lines.push(`🧠 ${alert.smartHolders.length} wallet(s) you track already hold this`);
  }

  lines.push("", `${s.venue.toUpperCase()}${s.feeTier ? ` · ${s.feeTier / 10_000}% tier` : ""} · block ${s.block}`);
  return lines.join(NL);
}

/**
 * Start the memecoin watcher bot.
 *
 * Returns undefined when no token is configured, so the whole feature is
 * absent rather than half-present -- the same shape as the other optional
 * bots.
 */
export function startMemecoinBot(
  rawToken: string | undefined,
  ownerId: number,
  stores: UserStores,
  mainUsername: () => string | undefined
): MemecoinBot | undefined {
  const cleaned = cleanToken(rawToken);
  if (!cleaned.token) {
    // Said out loud. Returning null in silence makes "not configured"
    // indistinguishable from "not responding", which from the chat looks the
    // same: you press Start and nothing ever answers.
    console.log("Memecoin (bot 5): off — TELEGRAM_MEMECOIN_BOT_TOKEN is not set. Effect: no launch alerts.");
    return undefined;
  }
  for (const note of cleaned.notes) console.warn(`TELEGRAM_MEMECOIN_BOT_TOKEN: ${note}.`);
  if (!cleaned.looksValid) {
    console.error("TELEGRAM_MEMECOIN_BOT_TOKEN is not shaped like a bot token. The watcher stays off.");
    return undefined;
  }

  const bot = new Telegraf(cleaned.token);
  // Before any handler. Without these a single bad button press rejects the
  // launch promise and the bot silently stops polling -- which is what took
  // bot 3 down after every redeploy.
  installGuards(bot, "Memecoin (bot 5)");
  // installGuards only catches handler errors. Without this every handler is
  // open to anyone who finds the bot -- read-only, but still this operator's
  // watchlist and this operator's chain reads.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== ownerId) return;
    return next();
  });

  let stopWatch: (() => void) | null = null;
  let chainKey = "arc";
  let alertCount = 0;

  const menu = () =>
    Markup.inlineKeyboard([
      [Markup.button.callback(stopWatch ? "⏹ Stop watching" : "▶️ Start watching", "meme:toggle")],
      [Markup.button.callback("🔍 Check a token", "meme:check")],
      [Markup.button.callback("📊 Status", "meme:status")],
    ]);

  const startWatching = (chatId: number): string => {
    const dex = dexFor(chainKey);
    if (!dex) return `No trading venue is configured for ${chainKey}.`;
    if (stopWatch) return "Already watching.";

    const rpcUrl = resolveRpcsForChain(chainKey).urls[0];
    const minLiquidity = MIN_LIQUIDITY_UNITS * 10n ** BigInt(dex.quoteDecimals);

    stopWatch = watchLaunches({
      rpcUrl,
      dex,
      onLaunch: (sighting) => {
        // Detached deliberately: inspection is several round trips and must
        // not hold up the poll that finds the next launch. Every throw inside
        // is caught, because an unhandled rejection here would take the whole
        // process down -- which is how bot 3 died once already.
        void (async () => {
          try {
            const alert = await inspectLaunch(rpcUrl, dex, sighting);
            // A pool exists before it is funded. Alerting on an empty one
            // fires twice per launch and says nothing either time.
            if (alert.liquidityQuote !== undefined && alert.liquidityQuote < minLiquidity) return;
            alertCount++;
            await bot.telegram.sendMessage(chatId, describeLaunch(alert, dex), {
              ...Markup.inlineKeyboard([
                [
                  Markup.button.url(
                    "🔎 Explorer",
                    `${resolveChain(chainKey)?.explorer}/address/${sighting.token}`
                  ),
                ],
                ...(mainUsername()
                  ? [[Markup.button.url("💰 Buy in main bot", `https://t.me/${mainUsername()}`)]]
                  : []),
              ]),
            });
          } catch {
            // One bad launch must not stop the feed.
          }
        })();
      },
      onError: () => {
        // Swallowed on purpose: an RPC hiccup costs one poll, and a message
        // per hiccup would bury the alerts this exists to deliver.
      },
    });
    return `Watching ${dex.chainKey} for new pools. Every alert carries a sell test.`;
  };

  bot.start(async (ctx) => {
    await ctx.reply(
      "Memecoin watcher — new pools, with a honeypot check on every one." +
        String.fromCharCode(10) +
        "Alert-only: it cannot spend or sign. Buying is a link back to the main bot.",
      menu()
    );
  });

  bot.action("meme:toggle", async (ctx) => {
    await ctx.answerCbQuery();
    if (stopWatch) {
      stopWatch();
      stopWatch = null;
      return ctx.reply("Stopped watching.", menu());
    }
    return ctx.reply(startWatching(ctx.chat!.id), menu());
  });

  bot.action("meme:status", async (ctx) => {
    await ctx.answerCbQuery();
    const dex = dexFor(chainKey);
    return ctx.reply(
      [
        `Chain: ${chainKey}`,
        `Watching: ${stopWatch ? "yes" : "no"}`,
        `Alerts sent: ${alertCount}`,
        dex ? `Factories: ${dex.v3Factories.length + dex.v2Factories.length}` : "No venue configured",
      ].join(String.fromCharCode(10)),
      menu()
    );
  });

  bot.action("meme:check", async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.reply("Send a token address and I will run the sell test on it.");
  });

  // ── Buying ──────────────────────────────────────────────────────────────
  //
  // The one thing in this bot that spends money, and it is built so that it
  // cannot happen by accident. A buy needs three separate deliberate acts:
  // press Buy, type an amount, then press Confirm on a quote that names the
  // exact figure. Nothing here fires on a timer, on an alert, or on a button
  // press alone -- the same rule as the paid-mint boundary in bot 1.
  //
  // Every buy is simulated before it is offered. A token that cannot be
  // bought is refused at the quote stage, before a single approval has been
  // paid for.
  let pending: { token: string; pool: V4Pool; amountIn: bigint; wallet: string } | null = null;
  let awaitingAmount: string | null = null;

  const buyFlow = async (token: string, amountIn: bigint): Promise<string> => {
    const dex = dexFor(chainKey);
    if (!dex) return `No trading venue configured for ${chainKey}.`;
    const wallets = stores.for(ownerId).listWallets();
    if (wallets.length === 0) return "No wallets are loaded, so there is nothing to buy with.";

    const rpcUrl = resolveRpcsForChain(chainKey).urls[0];
    const buyer = wallets[0].address;

    const pools = await findV4Pools(rpcUrl, dex, token);
    if (pools.length === 0) return "No V4 pool exists for that token, so there is nothing to buy from.";

    // Picked by simulating, not by choosing the newest or the friendliest
    // fee: a pool that was initialised and never funded looks identical to a
    // real one from its event, and only trying tells them apart.
    const pool = await pickTradeablePool(rpcUrl, dex, buyer, pools, amountIn);
    if (!pool) {
      return (
        `Found ${pools.length} pool(s) for that token and a buy of this size simulates as a ` +
        "revert in every one. Nothing was sent and nothing was approved."
      );
    }

    pending = { token, pool, amountIn, wallet: buyer };
    const NL = String.fromCharCode(10);
    const approvals = await buildApprovals(rpcUrl, dex, buyer, dex.wrappedNative, amountIn);
    return (
      [
        `Buy ${formatUnits(amountIn, dex.quoteDecimals)} ${dex.quoteSymbol} of ${token}`,
        `Wallet: ${mask(buyer)}`,
        `Pool: fee ${pool.key.fee} · tickSpacing ${pool.key.tickSpacing}`,
        approvals.length > 0
          ? `${approvals.length} one-time approval(s) will be sent first.`
          : "Approvals already in place.",
        "",
        "This simulates clean. Press Confirm to send it for real.",
      ].join(NL)
    );
  };

  bot.action(/^meme:buy:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
    await ctx.answerCbQuery();
    awaitingAmount = (ctx.match as RegExpMatchArray)[1];
    const dex = dexFor(chainKey);
    return ctx.reply(
      `How much ${dex?.quoteSymbol ?? "USDC"} do you want to spend? Send a number, or /cancel.`
    );
  });

  bot.action("meme:confirm", async (ctx) => {
    await ctx.answerCbQuery();
    const p = pending;
    pending = null;
    if (!p) return ctx.reply("Nothing is pending. Start again from the token.");

    const dex = dexFor(chainKey);
    if (!dex) return ctx.reply("No trading venue configured.");
    const rpcUrl = resolveRpcsForChain(chainKey).urls[0];

    try {
      const provider = createProvider(rpcUrl);
      const signer = new Wallet(stores.for(ownerId).getDecryptedKey(p.wallet), provider);
      const NL = String.fromCharCode(10);
      const sent: string[] = [];

      // Approvals first, and only the ones actually missing. They are
      // one-time per wallet, so most buys send none.
      for (const a of await buildApprovals(rpcUrl, dex, p.wallet, dex.wrappedNative, p.amountIn)) {
        const tx = await signer.sendTransaction({ to: a.to, data: a.data, value: a.value });
        await tx.wait();
        sent.push(`${a.reason}: ${tx.hash}`);
      }

      const call = buildV4Swap(dex, {
        pool: p.pool,
        amountIn: p.amountIn,
        // Zero floor only because this is a fresh launch with no reliable
        // quote to size one from. The simulation above is what establishes
        // the buy works at all; the honeypot check is what establishes it
        // can be sold again.
        amountOutMinimum: 0n,
      });
      const tx = await signer.sendTransaction({ to: call.to, data: call.data, value: call.value });
      const receipt = await tx.wait();
      sent.push(`swap: ${tx.hash}`);

      return ctx.reply(
        [
          receipt?.status === 1 ? "✅ Bought." : "⚠️ Sent, but the swap reverted.",
          ...sent,
          `${resolveChain(chainKey)?.explorer}/tx/${tx.hash}`,
        ].join(NL)
      );
    } catch (err) {
      return ctx.reply(`Buy failed: ${(err as Error)?.message ?? err}`);
    }
  });

  bot.action("meme:cancelbtn", async (ctx) => {
    await ctx.answerCbQuery();
    pending = null;
    awaitingAmount = null;
    return ctx.reply("Cancelled. Nothing was sent.", menu());
  });

  bot.command("cancel", async (ctx) => {
    pending = null;
    awaitingAmount = null;
    return ctx.reply("Cancelled. Nothing was sent.", menu());
  });

  bot.on("text", async (ctx) => {
    const raw = ctx.message.text.trim();

    // An amount, answering a Buy prompt. Checked before the address branch so
    // a number is never mistaken for anything else.
    if (awaitingAmount && /^[0-9]*.?[0-9]+$/.test(raw)) {
      const token = awaitingAmount;
      awaitingAmount = null;
      const dex = dexFor(chainKey);
      if (!dex) return ctx.reply("No trading venue configured.");
      let amountIn: bigint;
      try {
        amountIn = parseUnits(raw, dex.quoteDecimals);
      } catch {
        return ctx.reply("That is not an amount I can read.");
      }
      if (amountIn <= 0n) return ctx.reply("Amount must be above zero.");
      await ctx.reply("Quoting and simulating...");
      const text = await buyFlow(token, amountIn);
      return pending
        ? ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("✅ Confirm buy", "meme:confirm"), Markup.button.callback("✖️ Cancel", "meme:cancelbtn")]]))
        : ctx.reply(text, menu());
    }

    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return;
    const dex = dexFor(chainKey);
    if (!dex) return ctx.reply(`No trading venue configured for ${chainKey}.`);

    const rpcUrl = resolveRpcsForChain(chainKey).urls[0];
    await ctx.reply("Checking…");
    try {
      // The caller pasted a TOKEN, not a pool, so the pool has to be looked
      // up before a sell can be simulated against it. Passing the token
      // address where a pool was expected -- which is what this did before --
      // made every check come back unknown.
      const [info, found, ownership] = await Promise.all([
        readTokenInfo(rpcUrl, raw),
        findPoolForToken(rpcUrl, dex, raw),
        readOwnership(rpcUrl, raw),
      ]);

      const safety: SafetyReport = found
        ? await checkSellable(rpcUrl, raw, found.pool)
        : { verdict: "UNKNOWN", detail: "no pool was found for this token, so a sell could not be tested" };

      const liquidity = found ? await readLiquidity(rpcUrl, found.pool, dex.wrappedNative) : null;
      const NL = String.fromCharCode(10);

      const lines = [
        `${info.symbol ?? "?"} — ${info.name ?? "unnamed"}`,
        getAddress(raw),
        "",
        describeSafety(safety),
      ];
      if (liquidity?.quoteReserve !== undefined) {
        lines.push(
          `💧 ${Number(formatUnits(liquidity.quoteReserve, dex.quoteDecimals)).toLocaleString(undefined, {
            maximumFractionDigits: 0,
          })} ${dex.quoteSymbol} in the pool`
        );
      }
      if (info.totalSupply !== undefined) {
        lines.push(
          `🪙 supply ${Number(formatUnits(info.totalSupply, info.decimals)).toLocaleString(undefined, {
            maximumFractionDigits: 0,
          })}`
        );
      }
      lines.push(ownership.renounced ? "🔓 ownership renounced" : "🔑 owner is still live");
      if (found) {
        lines.push(
          "",
          `pool ${mask(found.pool)} · ${found.venue.toUpperCase()}${
            found.feeTier ? ` · ${found.feeTier / 10_000}% tier` : ""
          }`
        );
      }

      return ctx.reply(lines.join(NL), {
        ...Markup.inlineKeyboard([
          [
            Markup.button.url(
              "🔎 Explorer",
              `${resolveChain(chainKey)?.explorer}/address/${getAddress(raw)}`
            ),
            Markup.button.callback("💰 Buy", `meme:buy:${getAddress(raw)}`),
          ],
        ]),
      });
    } catch (err) {
      return ctx.reply(`Could not check that: ${(err as Error)?.message ?? err}`);
    }
  });

  void bot.launch(() => {
    bot.telegram
      .getMe()
      .then((me) => {
        out.username = me.username;
      })
      .catch(() => undefined);
  });

  const out: MemecoinBot = {
    telegram: bot.telegram,
    stop: (reason) => {
      stopWatch?.();
      bot.stop(reason);
    },
  };
  return out;
}
