// An optional second bot carrying the noisy, long-running things.
//
// Same process, same store, same wallets — only the chat is different. The
// point is separation of attention rather than separation of systems: the
// main bot is where you go to do things, and a feed of sale alerts or a
// filter grinding through 50,000 wallets in that same thread buries the
// menus you were trying to use.
//
// A Telegram private chat has the same id as the user, so the owner id
// already addresses the right conversation on the second bot. The only
// requirement is that the owner has pressed Start on it once — Telegram will
// not let a bot open a conversation the user has not opened first.
//
// Read-only by design. Everything that can move funds or reveal a key stays
// on the main bot behind its access control, because two front doors is two
// to guard.

import { Telegraf, Telegram, Markup } from "telegraf";
import { UserStores } from "./user-stores";
import { registerWalletFilter, FILTER_INTRO } from "./wallet-filter-flow";

export interface AlertsBot {
  telegram: Telegram;
  /**
   * The bot's @username, once Telegram has told us.
   *
   * Filled in asynchronously after launch, which is why it is mutable rather
   * than a constructor argument: the main bot needs it to build a t.me link,
   * and it reads it at click time, long after startup.
   */
  username?: string;
  stop: (reason?: string) => void;
}

function toolsMenu() {
  return Markup.inlineKeyboard([[Markup.button.callback("🧮 Wallet Filter", "menu:filter")]]);
}

/**
 * Start the companion bot, or return null when none is configured.
 *
 * Never throws. Moving alerts and the filter to a second chat is a
 * convenience, and a bad token for it must not stop the main bot from
 * running — those features simply stay where they already were.
 */
export function startAlertsBot(
  token: string | undefined,
  ownerId: number,
  stores: UserStores
): AlertsBot | null {
  const trimmed = (token ?? "").trim();
  if (!trimmed) return null;

  const bot = new Telegraf(trimmed);
  const filter = registerWalletFilter(bot, { ownerId, stores });

  const handle: AlertsBot = {
    telegram: bot.telegram,
    stop: (reason) => bot.stop(reason),
  };

  bot.start((ctx) => {
    if (ctx.from?.id !== ownerId) return ctx.reply("This bot only serves its owner.");

    // Arriving from the main bot's link carries ?start=filter. Landing on a
    // generic welcome after clicking "Wallet Filter" would make you go
    // looking for the thing you just clicked, so jump straight in.
    if (ctx.startPayload === "filter") {
      filter.beginFor(ctx.chat.id);
      return ctx.reply(FILTER_INTRO, { parse_mode: "Markdown" });
    }

    return ctx.reply(
      "🔔 *Alerts & tools*\n\n" +
        "Activity alerts arrive here, so they stop burying the menus in the main bot.\n\n" +
        "The wallet filter lives here too — a filter run is a stream of progress edits followed " +
        "by a CSV, which is the same kind of traffic.\n\n" +
        "Anything that moves funds or reveals a key stays on the main bot.",
      { parse_mode: "Markdown", ...toolsMenu() }
    );
  });

  bot.command("filter", (ctx) => {
    if (ctx.from?.id !== ownerId) return;
    filter.beginFor(ctx.chat.id);
    return ctx.reply(FILTER_INTRO, { parse_mode: "Markdown" });
  });

  bot.command("tools", (ctx) => {
    if (ctx.from?.id !== ownerId) return;
    return ctx.reply("Tools:", toolsMenu());
  });

  bot
    .launch(() => {
      console.log(`Companion bot running — alerts and wallet filter, reporting to ${ownerId}.`);
      // Best-effort: the link on the main bot degrades to plain text without
      // it, which is worth far less than the main bot failing to start.
      bot.telegram
        .getMe()
        .then((me) => {
          handle.username = me.username;
          console.log(`Companion bot is @${me.username} — the main bot will link to it.`);
        })
        .catch((err: any) => console.error(`Couldn't read the companion bot's username: ${err?.message ?? err}`));
    })
    .catch((err: any) => {
      // Logged, not thrown: see above.
      console.error(`Companion bot could not start: ${err?.description || err?.message || err}`);
      if (err?.response?.error_code === 401) {
        console.error("TELEGRAM_ALERTS_BOT_TOKEN is not a valid bot token.");
      }
    });

  return handle;
}
