import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The alerts bot was built read-only, and cluster auto-mint is the one thing
// in it that spends. The safety property is narrow and absolute:
//
//   a PAID mint never leaves this process without a human tap.
//
// decideClusterMint enforces it and has its own tests. This checks the
// WIRING, because a rule is only as good as the number of ways around it —
// a third call to fireMint added later would bypass the lot without failing
// a single existing test.
const SRC = readFileSync(join(__dirname, "smart-alerts-bot.ts"), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CODE = stripComments(SRC);

describe("the only ways a mint can fire", () => {
  it("has exactly two, and no more", () => {
    // One inside the free-only branch, one in the confirmation handler.
    const calls = CODE.match(/\bfireMint\s*\(/g) ?? [];
    // The declaration matches too, hence three.
    expect(calls.length, "an extra fireMint call bypasses the paid-mint guard").toBe(3);
  });

  it("guards the unattended one behind the free decision", () => {
    // The auto path may only run when decideClusterMint said "fire", which it
    // returns for a zero price and nothing else.
    const auto = CODE.slice(CODE.indexOf('decision.action === "fire"'));
    expect(auto.slice(0, 400)).toContain("fireMint(chatId, c.contract");
  });

  it("puts the paid one behind a callback, not a timer", () => {
    const handler = CODE.slice(CODE.indexOf("cm:go:"));
    expect(handler).toContain("fireMint(ctx.chat!.id");
    // Owner-only, like everything else that can cost money.
    expect(handler.slice(0, 200)).toContain("owner(ctx)");
  });

  it("expires a confirmation rather than letting it sit", () => {
    const handler = CODE.slice(CODE.indexOf("cm:go:"));
    expect(handler.slice(0, 700)).toContain("ASK_TTL_MS");
  });

  it("consumes a confirmation so it cannot be tapped twice", () => {
    const handler = CODE.slice(CODE.indexOf("cm:go:"));
    expect(handler.slice(0, 400)).toContain("pending.delete");
  });
});

describe("what the bot may not do", () => {
  it("never exports a key or a seed", () => {
    // It signs from the encrypted store in-process, exactly as the main bot
    // does. Reading one out to a chat is a different act entirely.
    for (const forbidden of ["getDecryptedSeed", "exportSnapshot", "listSeeds"]) {
      expect(CODE, forbidden).not.toContain(forbidden);
    }
  });

  it("routes every spending decision through the tested function", () => {
    // No second opinion about price anywhere in the wiring.
    expect(CODE).toContain("decideClusterMint(");
    expect((CODE.match(/decideClusterMint\(/g) ?? []).length).toBe(1);
  });
});
