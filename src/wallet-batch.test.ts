import { describe, it, expect } from "vitest";
import { parseWalletList, describeParse } from "./wallet-csv";

// The three ways a list of wallets arrives at the alerts bot — pasted, as a
// CSV, or behind a deep link — all end up in parseWalletList, so what it
// tolerates is what the feature tolerates.

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("however the list arrives", () => {
  it("reads one per line", () => {
    expect(parseWalletList(`${A}\n${B}`).addresses).toHaveLength(2);
  });

  it("reads a comma-separated paste", () => {
    expect(parseWalletList(`${A}, ${B}`).addresses).toHaveLength(2);
  });

  it("reads this bot's own CSV export, header and all", () => {
    // The exact shape offerWatchAll writes, so the round trip is covered:
    // radar exports it, alerts bot reads it back.
    const csv = [
      "wallet,chain,win_rate,sold,realised_eth",
      `${A},robinhood,1.00,31,0.10910`,
      `${B},robinhood,0.86,28,0.10620`,
    ].join("\n");
    const parsed = parseWalletList(csv);
    expect(parsed.addresses).toEqual([A, B].map((a) => a));
    // The header is not an address and must not be counted as a failure.
    expect(parsed.invalid).toHaveLength(0);
  });

  it("survives a spreadsheet's quoting and stray columns", () => {
    const csv = `"label","wallet","note"\n"smart-1111","${A}","early"`;
    expect(parseWalletList(csv).addresses).toEqual([A]);
  });

  it("de-duplicates, because the same wallet shows up in two exports", () => {
    const parsed = parseWalletList(`${A}\n${A}\n${B}`);
    expect(parsed.addresses).toHaveLength(2);
    expect(parsed.duplicates).toBe(1);
  });

  it("finds nothing in a file that holds no addresses", () => {
    expect(parseWalletList("collection,floor\nVessels,0.05").addresses).toHaveLength(0);
  });

  it("says what it did in words", () => {
    const text = describeParse(parseWalletList(`${A}\n${A}\n${B}`));
    expect(text).toContain("2 unique wallet(s)");
    expect(text).toContain("1 duplicate(s) removed");
  });
});
