import { describe, it, expect } from "vitest";
import { ask, renderSnapshot, AGENT_MODEL, BotSnapshot } from "./agent";

const SNAPSHOT: BotSnapshot = {
  chainKey: "robinhood",
  autoEnabled: false,
  copyEnabled: true,
  copyWatcherRunning: true,
  autoChainsRunning: [],
  maxFeeGwei: 0.5,
  gasLimit: 0,
  copyMaxPriceEth: 0.002,
  copyMaxQuantity: undefined,
  copyBackfillHours: 0,
  wallets: [
    { address: "0xE607f2b18daE93e1f5D4c5a5C71b1d1070823ba0", balanceEth: "0.000056", copyOn: true },
  ],
  watchedCount: 19,
  recentAttempts: [
    { when: "2026-08-30 12:00", contract: "0xabc", outcome: "skipped", reason: "price 0.02 ETH exceeds your 0.002 ETH cap" },
  ],
  recentMints: [{ when: "2026-08-30 11:00", contract: "0xdef", quantity: 2 }],
};

describe("renderSnapshot", () => {
  it("includes the things a diagnosis actually turns on", () => {
    const text = renderSnapshot(SNAPSHOT);
    expect(text).toContain("Copy Mint: ON");
    expect(text).toContain("watcher RUNNING");
    expect(text).toContain("Watched wallets: 19");
    expect(text).toContain("0.000056");
    // The skip reason is usually the whole answer to "why didn't it mint".
    expect(text).toContain("exceeds your 0.002 ETH cap");
  });

  it("spells out that gasLimit 0 is automatic, not broken", () => {
    expect(renderSnapshot(SNAPSHOT)).toContain("auto (sized per quantity)");
  });

  it("says unlimited rather than leaving the quantity cap blank", () => {
    expect(renderSnapshot(SNAPSHOT)).toContain("unlimited (drop max)");
  });

  it("copes with an empty bot", () => {
    const empty = { ...SNAPSHOT, wallets: [], recentAttempts: [], recentMints: [], watchedCount: 0 };
    expect(() => renderSnapshot(empty)).not.toThrow();
    expect(renderSnapshot(empty)).toContain("Wallets (0)");
  });
});

describe("ask", () => {
  it("explains the missing key instead of throwing at a chat handler", async () => {
    const result = await ask("why?", SNAPSHOT, { apiKey: "" });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("sends the snapshot and the question, and returns the text", async () => {
    let seen: any;
    const fake = {
      messages: {
        create: async (params: any) => {
          seen = params;
          return { content: [{ type: "text", text: "Because the wallet can't cover the reservation." }], stop_reason: "end_turn" };
        },
      },
    } as any;

    const result = await ask("why didn't it mint?", SNAPSHOT, { client: fake });
    expect(result).toEqual({ ok: true, text: "Because the wallet can't cover the reservation." });
    expect(seen.model).toBe(AGENT_MODEL);
    expect(seen.thinking).toEqual({ type: "adaptive" });
    const sent = seen.messages[0].content;
    expect(sent).toContain("why didn't it mint?");
    expect(sent).toContain("Watched wallets: 19");
  });

  it("turns an API failure into a sentence rather than a stack trace", async () => {
    const fake = { messages: { create: async () => { throw new Error("socket hang up"); } } } as any;
    const result = await ask("q", SNAPSHOT, { client: fake });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("socket hang up");
  });

  it("reports a refusal plainly", async () => {
    const fake = {
      messages: { create: async () => ({ content: [], stop_reason: "refusal" }) },
    } as any;
    expect((await ask("q", SNAPSHOT, { client: fake })).ok).toBe(false);
  });

  it("doesn't return an empty bubble when no text comes back", async () => {
    const fake = {
      messages: { create: async () => ({ content: [{ type: "thinking", thinking: "…" }], stop_reason: "end_turn" }) },
    } as any;
    const result = await ask("q", SNAPSHOT, { client: fake });
    expect(result.text.length).toBeGreaterThan(0);
  });
});
