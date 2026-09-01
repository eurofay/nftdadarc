// An assistant you can talk to from inside the bot.
//
// The point is diagnosis at the moment something looks wrong: "why didn't it
// mint that one", "is the watcher actually running", "what does this error
// mean" — answered against the bot's REAL current state rather than from
// memory, because the answer is almost always in the state.
//
// Deliberately read-only. It is handed a snapshot and returns prose; it
// cannot move funds, change settings, or touch a wallet. A chat assistant
// with authority over money is a much larger thing to get right than a chat
// assistant that explains what it sees, and the explaining is the useful part.

import Anthropic from "@anthropic-ai/sdk";

export const AGENT_MODEL = "claude-opus-5";

// Telegram hard-caps a message at 4096 characters and the answer is chunked
// anyway, so a long budget buys nothing. Adaptive thinking draws from the same
// pool, so this is sized to leave room for it rather than for a long answer.
const MAX_TOKENS = 8000;

export interface BotSnapshot {
  chainKey: string;
  autoEnabled: boolean;
  copyEnabled: boolean;
  copyWatcherRunning: boolean;
  autoChainsRunning: string[];
  maxFeeGwei: number;
  gasLimit: number;
  copyMaxPriceEth: number;
  copyMaxQuantity?: number;
  copyBackfillHours: number;
  wallets: { address: string; balanceEth: string; copyOn: boolean }[];
  watchedCount: number;
  recentAttempts: { when: string; contract: string; outcome: string; reason?: string }[];
  recentMints: { when: string; contract: string; quantity: number }[];
}

/**
 * The snapshot as text. Written as prose-ish lines rather than raw JSON
 * because the model reasons about it better, and because a human reading the
 * logs can see exactly what the assistant was told.
 */
export function renderSnapshot(s: BotSnapshot): string {
  const lines: string[] = [];
  lines.push(`Chain: ${s.chainKey}`);
  lines.push(`Auto Mint: ${s.autoEnabled ? "ON" : "OFF"}${s.autoChainsRunning.length ? ` (running: ${s.autoChainsRunning.join(", ")})` : ""}`);
  lines.push(`Copy Mint: ${s.copyEnabled ? "ON" : "OFF"} — watcher ${s.copyWatcherRunning ? "RUNNING" : "NOT RUNNING"}`);
  lines.push(`Watched wallets: ${s.watchedCount}`);
  lines.push(`Copy price cap: ${s.copyMaxPriceEth} ETH · max qty: ${s.copyMaxQuantity ?? "unlimited (drop max)"} · backfill: ${s.copyBackfillHours}h`);
  lines.push(`Gas: maxFee ${s.maxFeeGwei} gwei · limit ${s.gasLimit === 0 ? "auto (sized per quantity)" : s.gasLimit}`);
  lines.push("");
  lines.push(`Wallets (${s.wallets.length}):`);
  for (const w of s.wallets) {
    lines.push(`  ${w.address} — ${w.balanceEth} ETH — copy ${w.copyOn ? "on" : "off"}`);
  }
  if (s.recentAttempts.length) {
    lines.push("");
    lines.push("Recent copy attempts (newest first):");
    for (const a of s.recentAttempts) {
      lines.push(`  ${a.when} ${a.contract} → ${a.outcome}${a.reason ? ` (${a.reason})` : ""}`);
    }
  }
  if (s.recentMints.length) {
    lines.push("");
    lines.push("Recent mints (newest first):");
    for (const m of s.recentMints) lines.push(`  ${m.when} ${m.contract} ×${m.quantity}`);
  }
  return lines.join("\n");
}

// Facts the assistant would otherwise get wrong, all of them measured against
// this chain rather than assumed. Without these it reaches for generic
// Ethereum advice ("raise your gas") that is actively wrong here.
const SYSTEM = `You are the assistant inside a Telegram NFT mint bot, answering its owner.

You are talking to someone using the bot on their phone, mid-problem. Be brief and concrete. Lead with the answer. Under 200 words unless genuinely more is needed. No headers or bullet-point essays; this renders in a chat window.

What the bot does: it watches wallets that mint OpenSea SeaDrop NFTs and mints the same drop with the owner's wallets. It also has auto-mint (any free drop going live), scheduled mints, a portfolio view, and selling.

Measured facts about this deployment — prefer these over general knowledge:
- Chain is usually Robinhood Chain (chainId 4663), ~10 blocks/second.
- Gas price there is ~0.12 gwei, not 2. A mint costs about 0.000014 ETH.
- Gas used is about 101,000 + 3,500 per item minted.
- A node reserves gasLimit x maxFeePerGas UP FRONT. That reservation, not the
  mint price, is what usually blocks an underfunded wallet. At the current
  settings a single mint needs roughly 0.00007 ETH free.
- gasLimit 0 means "size it automatically from the quantity" and is correct.
- Copy mint starts at the chain head by design: it does NOT mint drops the
  watched wallets minted before the watcher started. Backfill 0 is deliberate.
- The public RPC rate-limits sustained eth_getLogs; scans are paced and retried.
- OpenSea's index is unreliable for these collections, so holdings are read
  from the chain. A missing floor price or image is normal, not a fault.

If the snapshot doesn't contain what you'd need, say what you'd need to see rather than guessing. If something in the snapshot looks like the actual problem, say so directly. Never invent transaction hashes, balances, or errors.`;

export interface AskResult {
  ok: boolean;
  text: string;
}

/**
 * Ask a question against the current snapshot.
 * Never throws — the caller is a chat handler, and an unhandled rejection
 * there is a dead button rather than an error message.
 */
export async function ask(
  question: string,
  snapshot: BotSnapshot,
  opts: { apiKey?: string; client?: Anthropic } = {}
): Promise<AskResult> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!opts.client && !apiKey) {
    return {
      ok: false,
      text: "No ANTHROPIC_API_KEY is set, so I can't answer. Add one in Railway → Variables and redeploy.",
    };
  }

  const client = opts.client ?? new Anthropic({ apiKey });
  try {
    const response = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Current bot state:\n\n${renderSnapshot(snapshot)}\n\n---\n\nQuestion: ${question}`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (response.stop_reason === "refusal") {
      return { ok: false, text: "I can't answer that one." };
    }
    return { ok: true, text: text || "(no answer came back)" };
  } catch (err: any) {
    // Typed first, so the common failures read as themselves rather than as
    // a wall of SDK error text in a chat bubble.
    if (err instanceof Anthropic.AuthenticationError) {
      return { ok: false, text: "The ANTHROPIC_API_KEY was rejected. Check it in Railway → Variables." };
    }
    if (err instanceof Anthropic.RateLimitError) {
      return { ok: false, text: "Rate limited by the API. Try again in a moment." };
    }
    if (err instanceof Anthropic.APIError) {
      return { ok: false, text: `API error ${err.status}: ${err.message}` };
    }
    return { ok: false, text: `Couldn't reach the API: ${err?.message ?? err}` };
  }
}
