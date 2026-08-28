import { describe, it, expect } from "vitest";
import { formatBatch, chunkMessage, renderBatch, collapseRepeats, TELEGRAM_LIMIT } from "./format";

// Lifted from a real run, which is what this exists to clean up.
const REAL_MINT_BURST = [
  "[robinhood] ",
  "[robinhood] 🎯 LIVE FREE MINT: 0xc520c3 — firing 1/wallet",
  "[robinhood]      OpenSea: Osborns (osborns)",
  "[robinhood] ",
  "[robinhood] ── LOCAL PUBLIC MINT (no OpenSea) ──",
  "[robinhood]   SeaDrop:       0x00005EA0",
  "[robinhood]   Price:         0.0 × 1 = 0.0 per wallet",
  "[robinhood] ",
  "[robinhood]   🚀 Firing immediately...",
  "[robinhood]   DISPATCHED 1 tx(s) (1.41ms, +2ms after stage)",
  "[robinhood] ",
  "[robinhood]   [W1] Block: 48566132 | Pos: 1 | SUCCESS | Gas: 99959",
  "[robinhood] ",
  "[robinhood] ===== LOCAL PUBLIC MINT COMPLETE =====",
];

describe("formatBatch", () => {
  it("hoists a shared watcher prefix into a header instead of repeating it", () => {
    const { header, body } = formatBatch(REAL_MINT_BURST);
    expect(header).toBe("robinhood");
    expect(body).not.toContain("[robinhood]");
    expect(body).toContain("LIVE FREE MINT");
  });

  it("keeps per-line tags when the batch mixes watchers", () => {
    const { header, body } = formatBatch(["[robinhood] a", "[ethereum] b"]);
    expect(header).toBeNull();
    expect(body).toContain("[robinhood] a");
    expect(body).toContain("[ethereum] b");
  });

  it("drops terminal rules and collapses blank runs", () => {
    const { body } = formatBatch(REAL_MINT_BURST);
    expect(body).not.toContain("─────");
    expect(body).not.toContain("=====");
    expect(body).not.toMatch(/\n\s*\n\s*\n/);
  });

  it("keeps every line that carries actual information", () => {
    const { body } = formatBatch(REAL_MINT_BURST);
    for (const needed of ["Osborns", "DISPATCHED", "SUCCESS", "Gas: 99959", "0.0 × 1"]) {
      expect(body).toContain(needed);
    }
  });

  it("turns a 14-line burst into a single compact block", () => {
    const { body } = formatBatch(REAL_MINT_BURST);
    // Was 14 separate Telegram messages; now one, with the noise gone.
    expect(body.split("\n").length).toBeLessThan(REAL_MINT_BURST.length);
    expect(body.startsWith(" ")).toBe(false);
  });

  it("returns an empty body for a batch that was only decoration", () => {
    expect(formatBatch(["[x] ", "[x] ────", "[x]    "]).body).toBe("");
  });
});

describe("chunkMessage", () => {
  it("leaves a short message as one chunk", () => {
    expect(chunkMessage("hello")).toEqual(["hello"]);
    expect(chunkMessage("")).toEqual([]);
  });

  it("splits on line boundaries when over the limit", () => {
    const line = "x".repeat(100);
    const chunks = chunkMessage(Array(60).fill(line).join("\n"), 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    // Nothing lost in the split.
    expect(chunks.join("\n").replace(/\n/g, "")).toBe(Array(60).fill(line).join(""));
  });

  it("hard-splits a single line longer than the limit rather than dropping it", () => {
    const chunks = chunkMessage("y".repeat(2500), 1000);
    expect(chunks).toHaveLength(3);
    expect(chunks.join("")).toBe("y".repeat(2500));
  });

  it("stays under Telegram's real cap by default", () => {
    expect(TELEGRAM_LIMIT).toBeLessThan(4096);
  });
});

describe("renderBatch", () => {
  it("produces one message with the header attached", () => {
    const msgs = renderBatch(REAL_MINT_BURST);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("robinhood");
    expect(msgs[0]).toContain("SUCCESS");
  });

  it("emits nothing for a batch with no real content", () => {
    expect(renderBatch(["[x] ", "[x] ═══"])).toEqual([]);
  });

  it("splits a very long batch across messages", () => {
    // Distinct lines on purpose — identical ones are collapsed by
    // collapseRepeats and would never reach the chunking path.
    const many = Array.from(
      { length: 400 },
      (_, i) => `[robinhood]   status line ${i} with some length to it`
    );
    const msgs = renderBatch(many);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
  });
});

describe("collapseRepeats", () => {
  it("collapses a flapping RPC's identical retries into one line with a count", () => {
    const err = "⚠ log scan failed: Internal error — retrying next tick";
    const { body } = formatBatch(Array(8).fill(`[robinhood] ${err}`));
    expect(body).toBe(`${err}  (×8)`);
  });

  it("leaves distinct lines alone", () => {
    const { body } = formatBatch(["[x] a", "[x] b", "[x] a"]);
    expect(body).toBe("a\nb\na");
  });

  it("only collapses consecutive repeats", () => {
    const { body } = formatBatch(["[x] a", "[x] a", "[x] b", "[x] a"]);
    expect(body).toBe("a  (×2)\nb\na");
  });
});
