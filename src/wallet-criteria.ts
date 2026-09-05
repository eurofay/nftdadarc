// Turning "wallets with more than 5 transactions and at least 0.01 eth" into
// something that can actually filter a list.
//
// Two layers on purpose. A pattern parser handles the phrasings people
// actually use, costs nothing, and works with no API key. Anything it cannot
// read falls through to the assistant, which is far better at unusual wording
// but costs a call and can be unavailable.
//
// The parser is the one that runs first, not the model. A deterministic
// answer to "balance > 0.1" is worth more than a clever one: the user is
// about to spend an hour of RPC time on the result, and a filter that
// silently meant something else is the expensive kind of wrong.

export type Field = "balance" | "txCount" | "nftCount";
export type Op = "gte" | "lte" | "gt" | "lt" | "eq";

export interface Condition {
  field: Field;
  op: Op;
  value: number;
}

export interface Criteria {
  conditions: Condition[];
  /** How the conditions combine. "all" is the default and the safe reading. */
  join: "all" | "any";
}

export const FIELD_LABELS: Record<Field, string> = {
  balance: "balance",
  txCount: "transactions",
  nftCount: "NFTs held",
};

const OP_LABELS: Record<Op, string> = {
  gte: "at least",
  lte: "at most",
  gt: "more than",
  lt: "fewer than",
  eq: "exactly",
};

// Which on-chain reads a set of conditions actually requires. Fetching a
// field nobody filtered on would double an already long run.
export function fieldsNeeded(criteria: Criteria): Field[] {
  return [...new Set(criteria.conditions.map((c) => c.field))];
}

const FIELD_WORDS: { re: RegExp; field: Field }[] = [
  { re: /\b(tx|txs|transaction|transactions|txcount|tx count|nonce|activity)\b/i, field: "txCount" },
  { re: /\b(nft|nfts|token|tokens|holding|holdings|item|items)\b/i, field: "nftCount" },
  { re: /\b(balance|bal|eth|funds|funded|money|worth)\b/i, field: "balance" },
];

// Ordered longest-first so "at least" is not matched as "least", and ">=" is
// never read as ">".
const OP_WORDS: { re: RegExp; op: Op }[] = [
  { re: />=|=>|\b(at least|minimum|min|no less than|not less than|or more|greater than or equal)\b/i, op: "gte" },
  { re: /<=|=<|\b(at most|maximum|max|no more than|not more than|or less|less than or equal)\b/i, op: "lte" },
  { re: />|\b(more than|greater than|above|over|higher than|exceeds?)\b/i, op: "gt" },
  { re: /<|\b(less than|fewer than|below|under|lower than)\b/i, op: "lt" },
  { re: /\b(exactly|equal to|equals|is)\b/i, op: "eq" },
];

/** Numbers with an optional k/m suffix, since "10k" is how people write it. */
function parseNumber(raw: string): number | null {
  const m = /^([0-9]*\.?[0-9]+)\s*([km])?$/i.exec(raw.trim().replace(/,/g, ""));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = m[2]?.toLowerCase();
  return suffix === "k" ? n * 1_000 : suffix === "m" ? n * 1_000_000 : n;
}

/**
 * Read criteria from plain English, or return null to hand over to the model.
 *
 * Each clause is parsed independently, so one unreadable clause does not
 * discard the ones beside it — but a partially-understood filter is not
 * returned either. Silently dropping "and more than 5 transactions" would
 * produce a larger list that looks perfectly plausible.
 */
export function parseCriteria(input: string): Criteria | null {
  const text = input.trim();
  if (!text) return null;

  const join: "all" | "any" = /\bor\b/i.test(text) && !/\band\b/i.test(text) ? "any" : "all";

  // Split on connectives and punctuation; each piece should hold one clause.
  // A comma between digits is a thousands separator, not a clause break --
  // splitting on it turned "more than 1,500 transactions" into "more than 1".
  const clauses = text
    .split(/\s*(?:,(?!\d)|;|\band\b|\bor\b|\bwith\b|\bthat have\b|\bhaving\b)\s*/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const conditions: Condition[] = [];
  let unreadable = 0;

  for (const clause of clauses) {
    const field = FIELD_WORDS.find((f) => f.re.test(clause))?.field;
    const numberMatch = /([0-9][0-9,]*\.?[0-9]*\s*[km]?)/i.exec(clause);
    if (!field || !numberMatch) {
      // A clause with neither a field nor a number is filler like "wallets"
      // or "show me" — not something that failed to parse.
      if (field || numberMatch) unreadable++;
      continue;
    }
    const value = parseNumber(numberMatch[1]);
    if (value === null) {
      unreadable++;
      continue;
    }
    // No comparator at all reads as a minimum: "wallets with 5 transactions"
    // means at least five, not exactly five, in every use of this anyone has.
    const op = OP_WORDS.find((o) => o.re.test(clause))?.op ?? "gte";
    conditions.push({ field, op, value });
  }

  if (conditions.length === 0 || unreadable > 0) return null;
  return { conditions, join };
}

/** Read the filter back in plain words, so it can be confirmed before it runs. */
export function describeCriteria(criteria: Criteria): string {
  const parts = criteria.conditions.map((c) => {
    const value = c.field === "balance" ? `${c.value} ETH` : c.value.toLocaleString();
    return `${FIELD_LABELS[c.field]} ${OP_LABELS[c.op]} ${value}`;
  });
  if (parts.length === 1) return parts[0];
  return parts.join(criteria.join === "all" ? " AND " : " OR ");
}

export interface WalletStats {
  address: string;
  balance?: number;
  txCount?: number;
  nftCount?: number;
}

function passes(stat: WalletStats, c: Condition): boolean {
  const actual = stat[c.field];
  // Unknown is not a pass. A wallet whose balance could not be read must not
  // land in a filtered list as though it qualified.
  if (actual === undefined || !Number.isFinite(actual)) return false;
  switch (c.op) {
    case "gte":
      return actual >= c.value;
    case "lte":
      return actual <= c.value;
    case "gt":
      return actual > c.value;
    case "lt":
      return actual < c.value;
    case "eq":
      return actual === c.value;
  }
}

export function applyCriteria(stats: WalletStats[], criteria: Criteria): WalletStats[] {
  return stats.filter((s) =>
    criteria.join === "all"
      ? criteria.conditions.every((c) => passes(s, c))
      : criteria.conditions.some((c) => passes(s, c))
  );
}

/** The JSON shape the assistant is asked for when the parser gives up. */
export const CRITERIA_SCHEMA = `{
  "join": "all" | "any",
  "conditions": [
    { "field": "balance" | "txCount" | "nftCount", "op": "gte"|"lte"|"gt"|"lt"|"eq", "value": number }
  ]
}`;

/**
 * Validate a model's answer before trusting it.
 *
 * The model is being asked for JSON, not obeyed as an instruction — its reply
 * decides how an hour of RPC work is spent, so a malformed or invented field
 * has to be rejected rather than half-applied.
 */
export function parseCriteriaJson(raw: string): Criteria | null {
  let json: any;
  try {
    // Models like to wrap JSON in prose or a fenced block.
    const match = /\{[\s\S]*\}/.exec(raw);
    if (!match) return null;
    json = JSON.parse(match[0]);
  } catch {
    return null;
  }

  const join = json?.join === "any" ? "any" : "all";
  if (!Array.isArray(json?.conditions) || json.conditions.length === 0) return null;

  const conditions: Condition[] = [];
  for (const c of json.conditions) {
    if (!["balance", "txCount", "nftCount"].includes(c?.field)) return null;
    if (!["gte", "lte", "gt", "lt", "eq"].includes(c?.op)) return null;
    const value = typeof c?.value === "number" ? c.value : Number(c?.value);
    if (!Number.isFinite(value)) return null;
    conditions.push({ field: c.field, op: c.op, value });
  }
  return { conditions, join };
}
