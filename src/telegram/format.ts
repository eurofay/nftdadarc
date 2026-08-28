// Turns a burst of log lines into one readable Telegram message.
//
// The engine logs line-by-line for a terminal, where that reads fine. Sent
// to Telegram one line per message, a single mint became a dozen separate
// bubbles — the "junk messages" problem. These helpers collapse a burst into
// one message, strip terminal-only decoration, and respect Telegram's
// 4096-character limit.

// Telegram's hard cap is 4096; leave room for the continuation marker.
export const TELEGRAM_LIMIT = 3900;

// Characters used only to draw rules and banners: the box-drawing block
// (U+2500–U+257F) plus the ASCII stand-ins for it.
const RULE_CHARS = "=\\-_*~\\u2500-\\u257F";

// A line that is nothing but decoration.
const RULE = new RegExp(`^[\\s${RULE_CHARS}]*$`);

// Banner runs wrapping real text, e.g. "===== MINT COMPLETE =====" or
// "── LOCAL PUBLIC MINT ──". The text is worth keeping; the rules around it
// are terminal furniture that reads as noise in a chat bubble.
const BANNER_EDGES = new RegExp(`^[\\s${RULE_CHARS}]+|[\\s${RULE_CHARS}]+$`, "g");

// Strips the "[robinhood] " style prefix the logger adds per watcher — it
// belongs once in the header, not repeated on every line of the same batch.
function stripPrefix(line: string): { prefix: string | null; rest: string } {
  const m = /^\s*\[([^\]]+)\]\s?(.*)$/.exec(line);
  return m ? { prefix: m[1], rest: m[2] } : { prefix: null, rest: line };
}

export interface FormattedBatch {
  header: string | null;
  body: string;
}

// Collapses a batch into a header (the shared watcher prefix, if every line
// agrees on one) plus a de-noised body.
export function formatBatch(lines: string[]): FormattedBatch {
  const parsed = lines.map(stripPrefix);

  const prefixes = new Set(parsed.map((p) => p.prefix).filter((p): p is string => p !== null));
  // Only hoist a prefix into the header when the whole batch shares it —
  // otherwise the per-line tags are load-bearing and must stay.
  const shared = prefixes.size === 1 && parsed.every((p) => p.prefix !== null) ? [...prefixes][0] : null;

  const out: string[] = [];
  for (const p of parsed) {
    const text = shared ? p.rest : p.prefix ? `[${p.prefix}] ${p.rest}` : p.rest;
    const trimmed = text.replace(/\s+$/, "");

    // Drop terminal rules and runs of blank lines — they separate sections on
    // a console but just add dead space in a chat bubble.
    if (RULE.test(trimmed)) continue;
    if (trimmed.trim() === "" && (out.length === 0 || out[out.length - 1].trim() === "")) continue;
    // Unwrap banners, then drop the console's indentation.
    out.push(trimmed.replace(BANNER_EDGES, "").replace(/^ {1,4}/, "") || trimmed.trim());
  }

  while (out.length && out[out.length - 1].trim() === "") out.pop();

  return { header: shared, body: out.join("\n").trim() };
}

// Splits an over-long message on line boundaries where possible, so a batch
// is never silently truncated or rejected by Telegram.
export function chunkMessage(text: string, limit = TELEGRAM_LIMIT): string[] {
  if (text.length <= limit) return text.length ? [text] : [];

  const chunks: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    // A single line longer than the limit has to be hard-split.
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    if (current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// The finished messages for one batch, header included.
export function renderBatch(lines: string[]): string[] {
  const { header, body } = formatBatch(lines);
  if (!body) return [];
  const full = header ? `【 ${header} 】\n${body}` : body;
  return chunkMessage(full);
}
