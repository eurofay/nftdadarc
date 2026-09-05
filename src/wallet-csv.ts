// Pulling wallet addresses out of whatever file someone actually has.
//
// Exports from different tools disagree about everything: header or no
// header, comma or semicolon or tab, address in the first column or the
// fourth, quoted or bare, checksummed or lowercase, sometimes with a BOM in
// front of the first cell. Rather than demand one shape, this finds the
// column that looks like addresses and reads that.
//
// Deliberately not a general CSV parser. It never needs to reassemble a row —
// only to find 0x-addresses — so a quoted field containing a comma cannot
// break it the way it would break a naive row splitter.

import { getAddress } from "ethers";

// The trailing guard matters: without it the first 40 hex characters of a
// 64-character transaction hash match, and every hash in the file becomes a
// wallet that does not exist.
const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

export interface ParsedWallets {
  /** Checksummed, de-duplicated, in first-seen order. */
  addresses: string[];
  /** Total address-shaped strings found, before de-duplication. */
  found: number;
  duplicates: number;
  /** Lines that held no address at all — usually a header, or a blank. */
  skippedLines: number;
  /** Things that looked like addresses but were not valid. */
  invalid: string[];
}

/**
 * Every address in the text, de-duplicated.
 *
 * Matching by shape rather than by column means a file with the address in
 * column four, or two address columns, or no header, all work without being
 * told which is which. The cost is that any 40-hex string is taken as an
 * address — acceptable, because a transaction hash is 64 hex and nothing else
 * in these exports is 40.
 */
export function parseWalletList(text: string): ParsedWallets {
  const seen = new Set<string>();
  const addresses: string[] = [];
  const invalid: string[] = [];
  let found = 0;
  let skippedLines = 0;

  // Strip a UTF-8 BOM: Excel writes one, and it glues itself to the first
  // cell so that cell no longer matches anything.
  const clean = text.replace(/^﻿/, "");

  for (const line of clean.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const matches = line.match(ADDRESS);
    if (!matches) {
      skippedLines++;
      continue;
    }
    for (const raw of matches) {
      found++;
      let checksummed: string;
      try {
        // getAddress validates the checksum when there is mixed case, so a
        // corrupted address is caught here rather than at the RPC.
        checksummed = getAddress(raw.toLowerCase());
      } catch {
        invalid.push(raw);
        continue;
      }
      const key = checksummed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      addresses.push(checksummed);
    }
  }

  return { addresses, found, duplicates: found - addresses.length - invalid.length, skippedLines, invalid };
}

/** A short, human summary of what the file turned out to contain. */
export function describeParse(parsed: ParsedWallets): string {
  const parts = [`${parsed.addresses.length.toLocaleString()} unique wallet(s)`];
  if (parsed.duplicates > 0) parts.push(`${parsed.duplicates.toLocaleString()} duplicate(s) removed`);
  if (parsed.invalid.length > 0) parts.push(`${parsed.invalid.length} unreadable`);
  return parts.join(", ");
}

/** CSV back out again, for handing the filtered list to the user. */
export function toCsv(rows: Record<string, string | number>[], columns?: string[]): string {
  if (rows.length === 0) return "";
  const cols = columns ?? Object.keys(rows[0]);
  const escape = (v: string | number | undefined): string => {
    const s = v === undefined || v === null ? "" : String(v);
    // Quote only when it would otherwise change the shape of the row.
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => escape(r[c])).join(","))].join("\n");
}
