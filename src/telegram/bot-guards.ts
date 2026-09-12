// The two guards every bot in this process needs, in one place.
//
// The main bot grew both of these the hard way and the companion bots were
// written without them, which is exactly why the main bot survives a bad
// button press and the others do not.
//
// WHAT ACTUALLY HAPPENS WITHOUT THEM. A handler throws — pressing a menu
// button that re-renders the same screen is enough — and Telegraf propagates
// it out of the update loop, where it REJECTS THE LAUNCH PROMISE. The poller
// stops. From the chat that reads as "the bot worked after a redeploy, sent
// its backlog, then went quiet", because a restart is the only thing that
// starts it polling again. The log even says "could not start", long after it
// started, which sends you looking at boot for a fault that is in a tap.

import { Telegraf, Context } from "telegraf";

/** True for the one Telegram error that means "nothing to do". */
export function isNotModified(err: unknown): boolean {
  const e = err as any;
  return String(e?.description ?? e?.message ?? "").includes("message is not modified");
}

/**
 * Keep a bot alive through a bad handler, and stop pointless edits erroring.
 *
 * Call before registering any handler.
 */
export function installGuards<C extends Context>(bot: Telegraf<C>, label: string): void {
  bot.catch(async (err: any, ctx) => {
    const detail = err?.description || err?.message || String(err);
    // Tapping Back to a menu already on screen is a normal thing to do and
    // must not be reported as a failure.
    if (isNotModified(err)) return;
    console.error(`${label}: handler error on ${ctx.updateType} — ${detail}`);
    try {
      await ctx.reply(`⚠️ That action failed: ${detail}`);
    } catch {
      /* the chat may be unreachable; the log above is the fallback */
    }
  });

  // Telegram rejects an edit whose text AND markup are byte-identical to what
  // is already on screen. Re-rendering an unchanged menu is the common case,
  // so swallow exactly that and let every other edit failure through.
  bot.use((ctx, next) => {
    const original = ctx.editMessageText.bind(ctx);
    ctx.editMessageText = (async (...args: Parameters<typeof original>) => {
      try {
        return await original(...args);
      } catch (err: any) {
        if (isNotModified(err)) return true as any;
        throw err;
      }
    }) as typeof ctx.editMessageText;

    const originalMarkup = ctx.editMessageReplyMarkup.bind(ctx);
    ctx.editMessageReplyMarkup = (async (...args: Parameters<typeof originalMarkup>) => {
      try {
        return await originalMarkup(...args);
      } catch (err: any) {
        if (isNotModified(err)) return true as any;
        throw err;
      }
    }) as typeof ctx.editMessageReplyMarkup;

    return next();
  });
}
