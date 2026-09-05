import { describe, it, expect } from "vitest";
import { parseWalletList, describeParse, toCsv } from "./wallet-csv";

const A = "0x28e6D584D97dc56bdc57E70C4e47B0677C9808e2";
const B = "0x2a6a25d519BD0204e36a4018a5F4bee0B846fd49";

describe("parseWalletList", () => {
  it("reads a bare list", () => {
    expect(parseWalletList(`${A}\n${B}`).addresses).toEqual([A, B]);
  });

  it("skips a header row rather than choking on it", () => {
    const out = parseWalletList(`address,label\n${A},mine`);
    expect(out.addresses).toEqual([A]);
    expect(out.skippedLines).toBe(1);
  });

  it("finds the address wherever the column happens to be", () => {
    // Exports disagree about column order; demanding one is how a real file
    // gets rejected for no reason.
    expect(parseWalletList(`1,alice,${A},2024-01-01`).addresses).toEqual([A]);
  });

  it("handles semicolons and tabs, not just commas", () => {
    expect(parseWalletList(`${A};x`).addresses).toEqual([A]);
    expect(parseWalletList(`${A}\tx`).addresses).toEqual([A]);
  });

  it("reads quoted cells", () => {
    expect(parseWalletList(`"${A}","a, b"`).addresses).toEqual([A]);
  });

  it("strips the BOM Excel writes, which would hide the first address", () => {
    expect(parseWalletList(`﻿${A}`).addresses).toEqual([A]);
  });

  it("checksums a lowercase address", () => {
    expect(parseWalletList(A.toLowerCase()).addresses).toEqual([A]);
  });

  it("de-duplicates regardless of case", () => {
    const out = parseWalletList(`${A}\n${A.toLowerCase()}\n${B}`);
    expect(out.addresses).toEqual([A, B]);
    expect(out.duplicates).toBe(1);
    expect(out.found).toBe(3);
  });

  it("keeps first-seen order", () => {
    expect(parseWalletList(`${B}\n${A}`).addresses).toEqual([B, A]);
  });

  it("takes several addresses from one line", () => {
    expect(parseWalletList(`${A},${B}`).addresses).toEqual([A, B]);
  });

  it("ignores a transaction hash, which is 64 hex not 40", () => {
    const hash = `0x${"a".repeat(64)}`;
    expect(parseWalletList(`${hash}\n${A}`).addresses).toEqual([A]);
  });

  it("handles CRLF line endings", () => {
    expect(parseWalletList(`${A}\r\n${B}`).addresses).toEqual([A, B]);
  });

  it("returns nothing for a file with no addresses", () => {
    const out = parseWalletList("name,email\nalice,a@b.c");
    expect(out.addresses).toEqual([]);
    expect(out.skippedLines).toBe(2);
  });

  it("handles an empty file", () => {
    expect(parseWalletList("").addresses).toEqual([]);
  });

  it("scales to a large list", () => {
    const many = Array.from({ length: 50_000 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    const out = parseWalletList(many.join("\n"));
    expect(out.addresses).toHaveLength(50_000);
  });
});

describe("describeParse", () => {
  it("leads with the count, which is what was asked", () => {
    expect(describeParse(parseWalletList(`${A}\n${B}`))).toContain("2 unique wallet(s)");
  });

  it("mentions duplicates only when there were some", () => {
    expect(describeParse(parseWalletList(`${A}\n${B}`))).not.toContain("duplicate");
    expect(describeParse(parseWalletList(`${A}\n${A}`))).toContain("1 duplicate(s) removed");
  });
});

describe("toCsv", () => {
  it("writes a header and rows", () => {
    expect(toCsv([{ address: A, balance: 1 }])).toBe(`address,balance\n${A},1`);
  });

  it("quotes a value containing a comma", () => {
    expect(toCsv([{ a: "x,y" }])).toBe('a\n"x,y"');
  });

  it("doubles an embedded quote", () => {
    expect(toCsv([{ a: 'he said "hi"' }])).toBe('a\n"he said ""hi"""');
  });

  it("leaves a plain value unquoted", () => {
    expect(toCsv([{ a: "plain" }])).toBe("a\nplain");
  });

  it("returns nothing for no rows", () => {
    expect(toCsv([])).toBe("");
  });

  it("honours an explicit column order", () => {
    expect(toCsv([{ b: 2, a: 1 }], ["a", "b"])).toBe("a,b\n1,2");
  });
});
