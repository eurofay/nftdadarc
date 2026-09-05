import { describe, it, expect } from "vitest";
import { cleanToken } from "./token";

// Shaped like a real one, but not one: digits, colon, 35 token characters.
const GOOD = "1234567890:AAaaBBbbCCccDDddEEffGGhhIIjjKKllMMn";
const CURLY_OPEN = String.fromCharCode(0x201c);
const CURLY_CLOSE = String.fromCharCode(0x201d);

describe("cleanToken", () => {
  it("leaves a clean token alone", () => {
    const out = cleanToken(GOOD);
    expect(out.token).toBe(GOOD);
    expect(out.notes).toEqual([]);
    expect(out.looksValid).toBe(true);
  });

  it("strips straight quotes", () => {
    expect(cleanToken(`"${GOOD}"`).token).toBe(GOOD);
    expect(cleanToken(`'${GOOD}'`).token).toBe(GOOD);
  });

  it("strips the curly quotes a phone keyboard substitutes", () => {
    // The actual reported failure: pasted from a phone, stored with the
    // quotes, and Telegram answers 401 without saying why.
    const out = cleanToken(`${CURLY_OPEN}${GOOD}${CURLY_CLOSE}`);
    expect(out.token).toBe(GOOD);
    expect(out.looksValid).toBe(true);
    expect(out.notes[0]).toContain("quotes");
  });

  it("strips an unpaired quote, since a truncated paste leaves one", () => {
    expect(cleanToken(`${CURLY_OPEN}${GOOD}`).token).toBe(GOOD);
    expect(cleanToken(`${GOOD}"`).token).toBe(GOOD);
  });

  it("strips a leading NAME= when the whole line was pasted", () => {
    const out = cleanToken(`TELEGRAM_ALERTS_BOT_TOKEN=${GOOD}`);
    expect(out.token).toBe(GOOD);
    expect(out.notes.some((n) => n.includes("NAME="))).toBe(true);
  });

  it("handles a whole line pasted with quotes as well", () => {
    expect(cleanToken(`TELEGRAM_ALERTS_BOT_TOKEN=${CURLY_OPEN}${GOOD}${CURLY_CLOSE}`).token).toBe(GOOD);
  });

  it("removes whitespace that a line wrap introduced", () => {
    const out = cleanToken(`1234567890:AAaaBBbbCCccDDdd EEffGGhhIIjjKKllMMn`);
    expect(out.token).toBe(GOOD);
    expect(out.notes.some((n) => n.includes("whitespace"))).toBe(true);
  });

  it("trims ordinary surrounding whitespace without comment", () => {
    const out = cleanToken(`  ${GOOD}  `);
    expect(out.token).toBe(GOOD);
    expect(out.notes).toEqual([]);
  });

  it("reports an unset value as empty rather than throwing", () => {
    expect(cleanToken(undefined).token).toBe("");
    expect(cleanToken("").looksValid).toBe(false);
    expect(cleanToken("   ").token).toBe("");
  });

  it("flags a value that is not shaped like a token at all", () => {
    // Better to say "that is not a token" up front than to let Telegram
    // answer 401 and leave someone hunting for a permissions problem.
    expect(cleanToken("hello-there").looksValid).toBe(false);
    expect(cleanToken("1234567890").looksValid).toBe(false);
    expect(cleanToken("abc:def").looksValid).toBe(false);
  });

  it("never invents a token out of nothing", () => {
    expect(cleanToken(`"""`).looksValid).toBe(false);
  });
});
