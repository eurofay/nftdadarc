import { describe, it, expect } from "vitest";
import {
  DEFAULT_LADDER,
  MarketState,
  Position,
  applyExit,
  entryEquivalentValue,
  evaluatePosition,
  markPeak,
  positionPnL,
} from "./position";

// Every rule here is a decision about money, so every rule is tested without a
// chain. The two bugs these were written to catch are both in "after a rung
// has fired" -- the state the naive version gets wrong.

const COST = 1_000_000n; // 1 USDC at 6dp
const TOKENS = 1_000n * 10n ** 18n;

const pos = (over: Partial<Position> = {}): Position => ({
  token: "0x" + "77".repeat(20),
  poolId: "0x" + "ab".repeat(32),
  wallet: "0x" + "11".repeat(20),
  costQuote: COST,
  tokensHeld: TOKENS,
  tokensAtEntry: TOKENS,
  openedAt: 0,
  realisedQuote: 0n,
  firedRungs: [],
  peakQuote: COST,
  ...over,
});

const market = (over: Partial<MarketState> = {}): MarketState => ({
  valueQuote: COST,
  sellable: true,
  ...over,
});

describe("the tripwire outranks everything", () => {
  it("dumps the whole position when the token stops allowing sells", () => {
    // A ladder assumes you can sell when you decide to. This is that
    // assumption failing, and it does not recover.
    const d = evaluatePosition(pos(), market({ sellable: false, valueQuote: COST * 50n }));
    expect(d.reason).toBe("RUG");
    expect(d.sellTokens).toBe(TOKENS);
  });

  it("beats a ladder rung that would otherwise have fired", () => {
    // At 50x every rung is in the money. It does not matter: if it cannot be
    // sold, the rungs are theoretical and leaving is the only real option.
    const d = evaluatePosition(pos(), market({ sellable: false, valueQuote: COST * 50n }));
    expect(d.reason).not.toBe("LADDER");
  });

  it("fires when liquidity is pulled out from under it", () => {
    const d = evaluatePosition(
      pos(),
      market({ poolQuoteAtEntry: 100_000n, poolQuote: 30_000n })
    );
    expect(d.reason).toBe("RUG");
    expect(d.detail).toContain("30%");
  });

  it("tolerates ordinary draining, which is not a rug", () => {
    // A pool loses some depth as people sell into it. Treating that as a
    // removal would exit every position that anyone else also sold.
    expect(
      evaluatePosition(pos(), market({ poolQuoteAtEntry: 100_000n, poolQuote: 50_000n })).reason
    ).toBe("HOLD");
  });

  it("says nothing when it has no entry liquidity to compare against", () => {
    expect(evaluatePosition(pos(), market({ poolQuote: 1n })).reason).toBe("HOLD");
  });
});

describe("the ladder", () => {
  it("holds below the first rung", () => {
    expect(evaluatePosition(pos(), market({ valueQuote: (COST * 199n) / 100n })).reason).toBe("HOLD");
  });

  it("sells half at 2x, which puts the stake back in the wallet", () => {
    const d = evaluatePosition(pos(), market({ valueQuote: COST * 2n }));
    expect(d.reason).toBe("LADDER");
    expect(d.rung).toBe(2);
    expect(d.sellTokens).toBe(TOKENS / 2n);
    expect(d.detail).toContain("original stake");
  });

  it("never fires the same rung twice", () => {
    // Without this the position sells itself out in a few seconds of polling.
    const after = pos({ firedRungs: [2], tokensHeld: TOKENS / 2n });
    expect(evaluatePosition(after, market({ valueQuote: COST })).reason).toBe("HOLD");
  });

  it("STILL fires later rungs after a partial sell", () => {
    // The first of the two bugs this file was written for. After selling half
    // at 2x the remainder is worth about 1x cost again. Comparing remaining
    // value to cost would need 10x on the chart to call it 5x, so the later
    // rungs would essentially never fire.
    const after = pos({ firedRungs: [2], tokensHeld: TOKENS / 2n });
    // Price is 5x entry: half the tokens, worth 2.5x the original cost.
    const d = evaluatePosition(after, market({ valueQuote: (COST * 5n) / 2n }));
    expect(d.reason).toBe("LADDER");
    expect(d.rung).toBe(5);
  });

  it("takes the highest rung passed, not the lowest", () => {
    // A token that gaps straight to 6x should not sell in dribbles on the way
    // through a level it never traded at.
    const d = evaluatePosition(pos(), market({ valueQuote: COST * 6n }));
    expect(d.rung).toBe(5);
  });

  it("sizes each rung against the ENTRY holding", () => {
    // So "sell 25%" means a quarter of what was bought, whatever earlier
    // rungs already sold.
    const after = pos({ firedRungs: [2], tokensHeld: TOKENS / 2n });
    const d = evaluatePosition(after, market({ valueQuote: (COST * 5n) / 2n }));
    expect(d.sellTokens).toBe((TOKENS * 2_500n) / 10_000n);
  });

  it("never tries to sell more than is actually held", () => {
    const thin = pos({ firedRungs: [2, 5], tokensHeld: 10n });
    const d = evaluatePosition(thin, market({ valueQuote: COST * 100n }));
    expect(d.sellTokens).toBeLessThanOrEqual(10n);
  });

  it("does nothing once the position is closed", () => {
    expect(evaluatePosition(pos({ tokensHeld: 0n }), market()).reason).toBe("HOLD");
  });

  it("closes the position completely if every rung runs", () => {
    // A ladder that leaves a remainder nobody decided about is a ladder with
    // a bug in it.
    expect(DEFAULT_LADDER.reduce((n, r) => n + r.sellBps, 0)).toBe(10_000);
  });
});

describe("the trailing stop", () => {
  it("stays disarmed near the entry price, where noise lives", () => {
    // A new token routinely moves 30% either way before doing anything. A
    // stop that fires there turns every position into a small loss.
    const p = pos({ peakQuote: (COST * 12n) / 10n });
    expect(evaluatePosition(p, market({ valueQuote: (COST * 6n) / 10n })).reason).toBe("HOLD");
  });

  it("fires once armed and the price falls far enough from the peak", () => {
    // The 2x rung is already fired, so the stop is the live rule rather than
    // competing with a rung that has not sold yet. An unfired rung SHOULD win
    // -- taking the stake home beats stopping out — which is what the first
    // version of this test got wrong.
    const p = pos({ firedRungs: [2], tokensHeld: TOKENS / 2n, peakQuote: COST * 4n });
    // Price 2.4x: below the 35% floor under a 4x peak (2.6x), and nowhere
    // near the next unfired rung at 5x.
    const d = evaluatePosition(p, market({ valueQuote: (COST * 24n) / 20n }));
    expect(d.reason).toBe("TRAILING_STOP");
    expect(d.sellTokens).toBe(TOKENS / 2n);
  });

  it("lets an unfired rung win over the stop", () => {
    // Recovering the stake beats closing at a stop, when both are in range.
    const p = pos({ peakQuote: COST * 4n });
    expect(evaluatePosition(p, market({ valueQuote: (COST * 24n) / 10n })).reason).toBe("LADDER");
  });

  it("does NOT fire because a ladder rung just sold half the position", () => {
    // The second bug. A peak stored as the value of the CURRENT holding
    // collapses the moment a rung sells, and the stop then reads its own sale
    // as a 50% crash and dumps the rest.
    const after = pos({ firedRungs: [2], tokensHeld: TOKENS / 2n, peakQuote: COST * 2n });
    // Price unchanged at 2x; half the tokens, so value is 1x cost.
    const d = evaluatePosition(after, market({ valueQuote: COST }));
    expect(d.reason).toBe("HOLD");
  });

  it("can be switched off", () => {
    const p = pos({ peakQuote: COST * 10n, trailingStopBps: 0 });
    expect(evaluatePosition(p, market({ valueQuote: COST / 2n })).reason).toBe("HOLD");
  });
});

describe("tracking the peak", () => {
  it("records the price, so a partial sell does not move it", () => {
    const after = pos({ firedRungs: [2], tokensHeld: TOKENS / 2n, peakQuote: COST * 2n });
    // Same price as the peak, half the tokens.
    expect(markPeak(after, COST).peakQuote).toBe(COST * 2n);
  });

  it("rises with a new high", () => {
    expect(markPeak(pos(), COST * 3n).peakQuote).toBe(COST * 3n);
  });

  it("scales a held value up to the entry quantity", () => {
    const half = pos({ tokensHeld: TOKENS / 2n });
    expect(entryEquivalentValue(half, COST)).toBe(COST * 2n);
    expect(entryEquivalentValue(pos({ tokensHeld: 0n }), COST)).toBe(0n);
  });
});

describe("applying an exit", () => {
  it("reduces the holding and banks the proceeds", () => {
    const d = evaluatePosition(pos(), market({ valueQuote: COST * 2n }));
    const after = applyExit(pos(), d, COST);
    expect(after.tokensHeld).toBe(TOKENS / 2n);
    expect(after.realisedQuote).toBe(COST);
    expect(after.firedRungs).toEqual([2]);
  });

  it("never drives the holding negative", () => {
    const p = pos({ tokensHeld: 5n });
    const after = applyExit(p, { reason: "RUG", sellTokens: TOKENS, detail: "" }, 1n);
    expect(after.tokensHeld).toBe(0n);
  });

  it("does not record a rung for a stop or a rug", () => {
    const after = applyExit(pos(), { reason: "RUG", sellTokens: 1n, detail: "" }, 1n);
    expect(after.firedRungs).toEqual([]);
  });
});

describe("where the position stands", () => {
  it("says plainly once the stake is home", () => {
    // The fact that changes how a position should be treated, and one a
    // percentage does not show.
    const after = pos({ realisedQuote: COST, tokensHeld: TOKENS / 2n });
    expect(positionPnL(after, COST).stakeRecovered).toBe(true);
    expect(positionPnL(pos(), COST).stakeRecovered).toBe(false);
  });

  it("reports a loss as a loss", () => {
    const pnl = positionPnL(pos(), COST / 4n);
    expect(pnl.netQuote).toBe(-(COST * 3n) / 4n);
  });

  it("counts realised and unrealised together", () => {
    const after = pos({ realisedQuote: COST * 2n, tokensHeld: TOKENS / 2n });
    expect(positionPnL(after, COST).netQuote).toBe(COST * 2n);
  });
});
