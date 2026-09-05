// An optional second bot that carries nothing but the activity alerts.
//
// Same process, same store, same wallets — only the chat is different. The
// point is separation of attention rather than separation of systems: the
// main bot is where you go to do things, and a feed of sale and floor alerts
// in that same thread buries the menus you were trying to use.
//
// A Telegram private chat has the same id as the user, so the owner id
// already addresses the right conversation on the second bot. The only
// requirement is that the owner has pressed Start on it once — Telegram will
// not let a bot open a conversation the user has not opened first.

import { Telegraf, Telegram } from "telegraf";

export interface AlertsBot {
  telegram: Telegram;
  stop: (reason?: string) => void;
}

/**
 * Start the alerts bot, or return null when none is configured.
 *
 * Never throws. Alerts moving to a second chat is a convenience, and a bad
 * token for it must not stop the main bot from running — the alerts simply
 * stay where they already were.
 */
export function startAlertsBot(token: string | undefined, ownerId: number): AlertsBot | null {
  const trimmed = (token ?? "").trim();
  if (!trimmed) return null;

  const bot = new Telegraf(trimmed);

  // It is deliberately almost inert. Anything that can move funds or reveal a
  // key lives on the main bot behind its access control; duplicating any of
  // that here would mean two front doors to guard instead of one.
  bot.start((ctx) =>
    ctx.reply(
      ctx.from?.id === ownerId
        ? "🔔 Activity alerts will arrive here.\n\nThis bot only reports — everything you *do* stays on the main bot."
        : "This bot only delivers alerts to its owner."
    )
  );
  bot.on("message", (ctx) => {
    if (ctx.from?.id !== ownerId) return;
    return ctx.reply("This is the alerts feed — use the main bot to change anything.");
  });

  bot
    .launch(() => console.log(`Alerts bot running, reporting to ${ownerId}.`))
    .catch((err: any) => {
      // Logged, not thrown: see above.
      console.error(`Alerts bot could not start: ${err?.description || err?.message || err}`);
      if (err?.response?.error_code === 401) {
        console.error("TELEGRAM_ALERTS_BOT_TOKEN is not a valid bot token.");
      }
    });

  return { telegram: bot.telegram, stop: (reason) => bot.stop(reason) };
}
