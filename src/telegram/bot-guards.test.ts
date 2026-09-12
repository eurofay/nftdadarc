import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isNotModified } from "./bot-guards";

// Bot 3 kept going quiet after every redeploy. The cause was not the token and
// not the watcher: a handler throwing propagates out of Telegraf's update loop
// and REJECTS THE LAUNCH PROMISE, which stops the poller. The main bot had a
// bot.catch and survived; the three companion bots were written without one.
//
// Pressing 📡 Board twice was enough to do it, because Telegram rejects an
// edit that changes nothing with "message is not modified".

describe("isNotModified", () => {
  it("recognises the error that means nothing needed doing", () => {
    expect(isNotModified({ description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same" })).toBe(true);
    expect(isNotModified(new Error("message is not modified"))).toBe(true);
  });

  it("does not swallow anything else", () => {
    // Every other edit failure is real and has to reach bot.catch.
    for (const err of [
      { description: "Bad Request: message to edit not found" },
      { description: "Forbidden: bot was blocked by the user" },
      new Error("socket hang up"),
      null,
      undefined,
    ]) {
      expect(isNotModified(err), String(err)).toBe(false);
    }
  });
});

describe("every bot is guarded", () => {
  const bots = [
    ["main", "bot.ts"],
    ["alerts (2)", "alerts-bot.ts"],
    ["radar (3)", "radar-bot.ts"],
    ["smart alerts (4)", "smart-alerts-bot.ts"],
  ] as const;

  it.each(bots)("%s catches handler errors so they cannot stop the poller", (_name, file) => {
    const src = readFileSync(join(__dirname, file), "utf8");
    // Either its own bot.catch, or the shared installer.
    expect(/bot\.catch\(|installGuards\(/.test(src)).toBe(true);
  });

  it.each(bots)("%s tolerates an edit that changes nothing", (_name, file) => {
    const src = readFileSync(join(__dirname, file), "utf8");
    expect(/message is not modified|installGuards\(/.test(src)).toBe(true);
  });
});

describe("the guard actually swallows it", () => {
  it("returns rather than throwing for a no-op edit", async () => {
    // Reproduces the exact failure from the deploy log: pressing Board when
    // the board is already showing the same thing.
    const { installGuards } = await import("./bot-guards");
    const handlers: any[] = [];
    const fakeBot: any = {
      catch: (fn: any) => handlers.push(fn),
      use: (fn: any) => handlers.push(fn),
    };
    installGuards(fakeBot, "test");

    const middleware = handlers[1];
    const ctx: any = {
      editMessageText: async () => {
        throw { description: "Bad Request: message is not modified" };
      },
      editMessageReplyMarkup: async () => {
        throw { description: "Bad Request: message is not modified" };
      },
    };
    await middleware(ctx, async () => {});
    await expect(ctx.editMessageText("same")).resolves.toBe(true);
    await expect(ctx.editMessageReplyMarkup(undefined)).resolves.toBe(true);
  });

  it("still throws a real edit failure", async () => {
    const { installGuards } = await import("./bot-guards");
    const handlers: any[] = [];
    const fakeBot: any = { catch: (fn: any) => handlers.push(fn), use: (fn: any) => handlers.push(fn) };
    installGuards(fakeBot, "test");
    const ctx: any = {
      editMessageText: async () => {
        throw { description: "Bad Request: message to edit not found" };
      },
      editMessageReplyMarkup: async () => true,
    };
    await handlers[1](ctx, async () => {});
    await expect(ctx.editMessageText("x")).rejects.toBeTruthy();
  });
});
