import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { TelegramStore, StoredPosition } from "./telegram/store";
import {
  DEFAULT_SELL_SLIPPAGE_BPS,
  ExitDecision,
  minOutForExit,
} from "./position";

// Two things that only matter when something goes wrong: a redeploy in the
// middle of a position, and a sale that fills badly. Both are tested here
// because both are invisible until the day they cost money.

describe("a floor on the sale, except when leaving is the point", () => {
  const decision = (reason: ExitDecision["reason"]): ExitDecision => ({
    reason,
    sellTokens: 100n,
    detail: "",
  });

  it("puts NO floor under a rug exit", () => {
    // The whole point of that path is to leave while leaving is still
    // possible. A minimum-out turns it into a transaction that reverts
    // exactly when the price is collapsing -- the one moment the position
    // has to actually move.
    expect(minOutForExit(decision("RUG"), 1_000_000n)).toBe(0n);
  });

  it("puts a floor under a ladder sell", () => {
    // Discretionary, no emergency. Accepting any price means a sandwich or a
    // dying pool can take the lot.
    const floor = minOutForExit(decision("LADDER"), 1_000_000n);
    expect(floor).toBeGreaterThan(0n);
    expect(floor).toBe((1_000_000n * BigInt(10_000 - DEFAULT_SELL_SLIPPAGE_BPS)) / 10_000n);
  });

  it("puts a floor under a trailing stop too", () => {
    expect(minOutForExit(decision("TRAILING_STOP"), 1_000_000n)).toBeGreaterThan(0n);
  });

  it("falls back to no floor when there is no price to work from", () => {
    // A floor computed from a missing quote would be a floor of zero anyway;
    // being explicit stops it reading as an accepted price.
    expect(minOutForExit(decision("LADDER"), 0n)).toBe(0n);
  });

  it("clamps a nonsense slippage rather than wrapping around", () => {
    expect(minOutForExit(decision("LADDER"), 1_000n, 99_999)).toBe(0n);
    expect(minOutForExit(decision("LADDER"), 1_000n, -5)).toBe(1_000n);
  });

  it("allows enough room for fees and impact, not just noise", () => {
    // The expected figure is a MID price: it ignores the pool fee and the
    // sale's own impact, and on a thin new pool the impact is the larger of
    // the two. A tight floor here does not protect against a bad fill, it
    // just reverts the sale and leaves the position open on the way down.
    expect(DEFAULT_SELL_SLIPPAGE_BPS).toBeGreaterThanOrEqual(1_000);
  });
});

describe("positions survive a restart", () => {
  let dir: string;
  let store: TelegramStore;

  const sample = (over: Partial<StoredPosition> = {}): StoredPosition => ({
    id: "p1",
    chainKey: "arc",
    token: "0x" + "77".repeat(20),
    wallet: "0x" + "11".repeat(20),
    poolKey: {
      currency0: "0x3600000000000000000000000000000000000000",
      currency1: "0x" + "77".repeat(20),
      fee: 0,
      tickSpacing: 200,
      hooks: "0x" + "ca".repeat(20),
    },
    buyIsZeroForOne: true,
    costQuote: "1000000",
    tokensHeld: "5000000000000000000",
    tokensAtEntry: "5000000000000000000",
    realisedQuote: "0",
    peakQuote: "1000000",
    firedRungs: [],
    openedAt: 1,
    ...over,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-"));
    store = new TelegramStore(path.join(dir, "store.json"), "pass");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const reopen = () => new TelegramStore(path.join(dir, "store.json"), "pass");

  it("comes back after the process restarts", () => {
    // A hosted bot redeploys routinely, and a position whose watcher died
    // looks exactly like one that is fine -- until it is rugged with nobody
    // watching.
    store.addPosition(sample());
    expect(reopen().listOpenPositions()).toHaveLength(1);
  });

  it("keeps every field the exit rules need", () => {
    store.addPosition(sample({ firedRungs: [2], realisedQuote: "1000000" }));
    const back = reopen().listOpenPositions()[0];
    // Amounts are decimal strings on purpose: a bigint does not survive the
    // store's JSON round trip, and a position that came back null would be a
    // position nobody is watching.
    expect(BigInt(back.tokensHeld)).toBe(5_000_000_000_000_000_000n);
    expect(BigInt(back.realisedQuote)).toBe(1_000_000n);
    expect(back.firedRungs).toEqual([2]);
  });

  it("keeps the whole pool key, because a V4 pool has no address", () => {
    // Without all five fields there is no way to name the pool again, and
    // therefore no way to sell.
    store.addPosition(sample());
    const key = reopen().listOpenPositions()[0].poolKey;
    expect(key.currency0).toBeTruthy();
    expect(key.currency1).toBeTruthy();
    expect(key.fee).toBe(0);
    expect(key.tickSpacing).toBe(200);
    expect(key.hooks).toBeTruthy();
  });

  it("records a fired rung so a restart does not fire it again", () => {
    // Without this a restart mid-ladder sells the 2x rung a second time.
    store.addPosition(sample());
    store.updatePosition("p1", { firedRungs: [2], tokensHeld: "2500000000000000000" });
    expect(reopen().listOpenPositions()[0].firedRungs).toEqual([2]);
  });

  it("keeps the peak, which the trailing stop measures from", () => {
    // Losing it to a redeploy re-arms the stop from scratch and gives back
    // the gain it was protecting.
    store.addPosition(sample());
    store.updatePosition("p1", { peakQuote: "4000000" });
    expect(reopen().listOpenPositions()[0].peakQuote).toBe("4000000");
  });

  it("stops resuming a position once it is closed", () => {
    store.addPosition(sample());
    store.closePosition("p1", "LADDER");
    expect(reopen().listOpenPositions()).toHaveLength(0);
    // Kept as history rather than erased.
    expect(reopen().listPositions()).toHaveLength(1);
    expect(reopen().listPositions()[0].closedBy).toBe("LADDER");
  });

  it("ignores an update for a position that is not there", () => {
    expect(store.updatePosition("nope", { peakQuote: "1" })).toBeNull();
  });

  it("reads a store written before positions existed", () => {
    // Every store that already exists is one of these.
    const file = path.join(dir, "legacy.json");
    fs.writeFileSync(file, JSON.stringify({ wallets: [], settings: {} }));
    expect(new TelegramStore(file, "pass").listOpenPositions()).toEqual([]);
  });
});
