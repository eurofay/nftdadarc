// The wallet-filter conversation, packaged so either bot can carry it.
//
// It lives on the companion bot when one is configured. A filter run is a
// stream of progress edits followed by a CSV, which is exactly the kind of
// traffic that buries a menu — the same reason the activity alerts moved
// there. When no companion bot is configured it mounts on the main bot
// instead, because a feature that vanishes unless you set an optional
// environment variable is worse than one in a slightly noisy thread.
//
// Self-contained on purpose: it keeps its own conversation state rather than
// borrowing the host bot's session, so mounting it cannot collide with
// whatever else that bot is in the middle of. Its text and document
// middleware call next() whenever no filter is in progress, so it composes
// with the host's own handlers instead of swallowing their messages.

import { Telegraf, Context, Markup } from "telegraf";
import { message } from "telegraf/filters";
import Anthropic from "@anthropic-ai/sdk";
import { UserStores } from "./user-stores";
import { AGENT_MODEL } from "./agent";
import { resolveRpcsForChain } from "../rpc-resolver";
import { resolveChain } from "../chains";
import { readableRpcs } from "../fast-read";
import { parseWalletList, describeParse, toCsv } from "../wallet-csv";
import {
  Criteria,
  parseCriteria,
  parseCriteriaJson,
  describeCriteria,
  applyCriteria,
  fieldsNeeded,
  CRITERIA_SCHEMA,
} from "../wallet-criteria";
import { enrichWallets, measureRate, describeEta } from "../wallet-enrich";

// Telegram rate-limits edits to a message; a batch finishes far faster than
// this, and editing every time would trip the limit long before a long run
// finished.
const PROGRESS_EDIT_MS = 4_000;

interface FilterState {
  step?: "awaiting_file" | "awaiting_criteria";
  addresses?: string[];
  criteria?: Criteria;
  jobId?: string;
}

export interface WalletFilterDeps {
  ownerId: number;
  stores: UserStores;
}

export function filterConfirmMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Start", "filter:run"), Markup.button.callback("❌ Cancel", "filter:cancel")],
  ]);
}

// A long run needs a way out that keeps what it has already found.
export function filterRunningMenu() {
  return Markup.inlineKeyboard([[Markup.button.callback("⏹ Stop and keep results", "filter:cancel")]]);
}

export const FILTER_INTRO =
  "🧮 *Wallet filter*\n\n" +
  "Upload a CSV or TXT file of wallet addresses — attach it, don't paste it.\n\n" +
  "Any layout works: header or not, address in any column, comma or tab separated. " +
  "I'll tell you how many I found, then ask what you want to filter on.";

/**
 * Mount the whole flow on a bot.
 *
 * Returns nothing: everything it needs is registered as middleware, and the
 * only entry point is the "menu:filter" action, which the host bot surfaces
 * however it likes.
 */
export function registerWalletFilter(bot: Telegraf<any>, deps: WalletFilterDeps): void {
  const { ownerId, stores } = deps;
  const states = new Map<number, FilterState>();
  const stopped = new Set<string>();

  const stateFor = (chatId: number): FilterState => {
    const existing = states.get(chatId);
    if (existing) return existing;
    const fresh: FilterState = {};
    states.set(chatId, fresh);
    return fresh;
  };

  const isOwner = (ctx: Context) => ctx.from?.id === ownerId;

  bot.action("menu:filter", (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCbQuery("Not available.", { show_alert: true });
    states.set(ctx.chat!.id, { step: "awaiting_file" });
    return ctx.editMessageText(FILTER_INTRO, { parse_mode: "Markdown" });
  });

  bot.action("filter:cancel", (ctx) => {
    const state = stateFor(ctx.chat!.id);
    // A running job is stopped rather than abandoned: the results it already
    // has are still worth handing over.
    if (state.jobId) stopped.add(state.jobId);
    states.set(ctx.chat!.id, {});
    return ctx.editMessageText("Filter cancelled.").catch(() => ctx.reply("Filter cancelled."));
  });

  bot.on(message("document"), async (ctx, next) => {
    const state = stateFor(ctx.chat!.id);
    if (state.step !== "awaiting_file") return next();
    if (!isOwner(ctx)) return next();
    state.step = undefined;

    const doc = (ctx.message as any).document;
    // Telegram's own ceiling for a bot download is 20 MB, which at ~43 bytes
    // per line is roughly 450,000 addresses — far past anything anyone will
    // filter. Refusing here beats a confusing failure inside getFileLink.
    if ((doc.file_size ?? 0) > 20 * 1024 * 1024) {
      return ctx.reply(
        "That file is over Telegram's 20 MB limit for bot downloads. Split it and send the parts separately."
      );
    }

    let text: string;
    try {
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const res = await fetch(link.toString());
      text = await res.text();
    } catch (err: any) {
      return ctx.reply(`❌ Couldn't download that file: ${err?.message ?? err}`);
    }

    const parsed = parseWalletList(text);
    if (parsed.addresses.length === 0) {
      return ctx.reply(
        "I couldn't find any wallet addresses in that file.\n\n" +
          "It should have 0x… addresses in it somewhere — any column, any separator."
      );
    }

    states.set(ctx.chat!.id, { step: "awaiting_criteria", addresses: parsed.addresses });
    return ctx.reply(
      `📄 *${describeParse(parsed)}*\n\n` +
        "Now tell me what to filter on, in your own words. For example:\n" +
        "• wallets with more than 5 transactions\n" +
        "• at least 0.01 eth\n" +
        "• over 10 transactions and at least 0.05 eth\n\n" +
        "I can filter on balance and transaction count.",
      { parse_mode: "Markdown" }
    );
  });

  bot.on(message("text"), async (ctx, next) => {
    const state = stateFor(ctx.chat!.id);
    if (state.step !== "awaiting_criteria" || !state.addresses?.length) return next();
    if (!isOwner(ctx)) return next();
    state.step = undefined;

    const thinking = await ctx.reply("Reading that…");
    const say = (text: string, extra?: any) =>
      ctx.telegram.editMessageText(thinking.chat.id, thinking.message_id, undefined, text, extra).catch(() => {});

    const { criteria, via } = await readCriteria((ctx.message as any).text.trim());
    if (!criteria) {
      state.step = "awaiting_criteria";
      return say(
        "I couldn't turn that into a filter." +
          (via === "no-model" ? "" : " I tried the assistant too.") +
          "\n\nI can filter on *balance* and *transactions*. Try something like:\n" +
          "• more than 5 transactions\n" +
          "• at least 0.01 eth\n" +
          "• over 10 transactions and at least 0.05 eth",
        { parse_mode: "Markdown" }
      );
    }

    state.criteria = criteria;

    // Time a small sample and quote a real number. Throughput on these
    // endpoints varies by an order of magnitude with load, and committing
    // someone to an hour having implied twenty minutes is worse than making
    // them wait a few seconds for the truth.
    const settings = stores.for(ctx.from!.id).getSettings();
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const reads = state.addresses.length * fieldsNeeded(criteria).length;
    const sample = await measureRate(readableRpcs(urls)[0], state.addresses.slice(0, 20));
    const eta = sample.ratePerSecond > 0 ? describeEta(reads / sample.ratePerSecond) : "unknown";

    return say(
      "🧮 *Ready to filter*\n\n" +
        `Wallets: *${state.addresses.length.toLocaleString()}*\n` +
        `Filter: ${describeCriteria(criteria)}\n` +
        (via === "model" ? "_Read by the assistant — check it says what you meant._\n" : "") +
        `\nThat needs *${reads.toLocaleString()}* chain reads at about ` +
        `${sample.ratePerSecond.toFixed(0)}/sec, so roughly *${eta}*.\n` +
        (reads > 20_000
          ? "\nA run this long is worth doing on a private RPC — the public one is the slow part, " +
            "not the bot. You can stop it at any point and keep what it found.\n"
          : "") +
        "\nStart?",
      { parse_mode: "Markdown", ...filterConfirmMenu() }
    );
  });

  bot.action("filter:run", async (ctx) => {
    const state = stateFor(ctx.chat!.id);
    if (!isOwner(ctx)) return ctx.answerCbQuery("Not available.", { show_alert: true });
    if (!state.addresses?.length || !state.criteria) {
      return ctx.answerCbQuery("That request expired — upload the file again.", { show_alert: true });
    }
    await ctx.answerCbQuery("Started.");

    const addresses = state.addresses;
    const criteria = state.criteria;
    const jobId = `${ctx.chat!.id}:${Date.now()}`;
    state.jobId = jobId;

    const note = await ctx.reply(`Reading ${addresses.length.toLocaleString()} wallet(s) from the chain…`);
    const settings = stores.for(ctx.from!.id).getSettings();
    const { urls } = resolveRpcsForChain(settings.chainKey);
    const chain = resolveChain(settings.chainKey)!;

    // Detached: this can run for an hour and Telegraf kills a handler at
    // ninety seconds.
    void (async () => {
      const say = (text: string, extra?: any) =>
        ctx.telegram.editMessageText(note.chat.id, note.message_id, undefined, text, extra).catch(() => {});
      let lastEdit = 0;
      try {
        const result = await enrichWallets({
          rpcUrl: readableRpcs(urls)[0],
          addresses,
          fields: fieldsNeeded(criteria),
          shouldStop: () => stopped.has(jobId),
          onProgress: (p) => {
            const now = Date.now();
            if (now - lastEdit < PROGRESS_EDIT_MS) return;
            lastEdit = now;
            const pct = Math.round((p.done / p.total) * 100);
            void say(
              `🧮 Filtering ${addresses.length.toLocaleString()} wallet(s)\n\n` +
                `${pct}% — ${p.done.toLocaleString()} of ${p.total.toLocaleString()} reads\n` +
                `${p.rate.toFixed(0)}/sec, ${describeEta(p.etaSeconds)} left`,
              filterRunningMenu()
            );
          },
        });

        stopped.delete(jobId);
        state.jobId = undefined;
        const matched = applyCriteria(result.stats, criteria);
        const csv = toCsv(
          matched.map((s) => ({
            address: s.address,
            ...(s.balance !== undefined ? { balance: s.balance } : {}),
            ...(s.txCount !== undefined ? { transactions: s.txCount } : {}),
          }))
        );

        await say(
          `🧮 *Filter complete*${result.stopped ? " (stopped early)" : ""}\n\n` +
            `Filter: ${describeCriteria(criteria)}\n` +
            `Matched: *${matched.length.toLocaleString()}* of ${addresses.length.toLocaleString()} ` +
            `(${((matched.length / addresses.length) * 100).toFixed(1)}%)\n` +
            `Took ${Math.round(result.elapsedMs / 1000)}s on ${chain.name}` +
            (result.unreadable.length > 0
              ? `\n\n⚠️ ${result.unreadable.length.toLocaleString()} wallet(s) couldn't be read and are ` +
                "excluded — an unknown value is not a match."
              : ""),
          { parse_mode: "Markdown" }
        );

        if (matched.length > 0) {
          await ctx.replyWithDocument({
            source: Buffer.from(csv, "utf8"),
            filename: `filtered-${matched.length}-wallets.csv`,
          });
        }
      } catch (err: any) {
        stopped.delete(jobId);
        state.jobId = undefined;
        console.error(`Wallet filter failed: ${err?.message ?? err}`);
        await say(`Filter failed: ${err?.shortMessage ?? err?.message ?? err}`);
      }
    })();
  });
}

/**
 * Read the criteria, by pattern first and the assistant only if that fails.
 *
 * The parser is deterministic, free, and works with no API key. The model is
 * better at unusual phrasing but costs a call and can be unavailable, so it
 * is the fallback rather than the default — and its answer is validated as
 * JSON against a fixed schema, never executed as an instruction.
 */
export async function readCriteria(text: string): Promise<{ criteria: Criteria | null; via: string }> {
  const direct = parseCriteria(text);
  if (direct) return { criteria: direct, via: "parsed" };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { criteria: null, via: "no-model" };

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: 512,
      system:
        "Convert the user's wallet-filter request into JSON matching this schema, and reply with the JSON only:\n" +
        CRITERIA_SCHEMA +
        "\n\nFields: balance is native currency in ETH units; txCount is the number of transactions " +
        "sent (the nonce); nftCount is NFTs held. If the request cannot be expressed in this schema, " +
        'reply exactly {"conditions":[]}.',
      messages: [{ role: "user", content: text }],
    });
    const raw = response.content
      .map((b: any) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return { criteria: parseCriteriaJson(raw), via: "model" };
  } catch {
    return { criteria: null, via: "model-failed" };
  }
}
