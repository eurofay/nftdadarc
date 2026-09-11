import { describe, it, expect } from "vitest";
import {
  RadarBoard,
  UpcomingDrop,
  countdown,
  isLive,
  isUpcoming,
  leadMs,
  priceLabel,
  shouldAlert,
  ALERT_HORIZON_MS,
} from "./drop-radar";
import { rankMinters, scout, score, why, MintRecord, MIN_COLLECTIONS } from "./minter-scout";

const NOW = 1_800_000_000_000; // fixed, so nothing here depends on the clock
const sec = (ms: number) => Math.floor(ms / 1000);

const drop = (over: Partial<UpcomingDrop> = {}): UpcomingDrop => ({
  contract: "0x1111111111111111111111111111111111111111",
  chainKey: "robinhood",
  startTime: sec(NOW) + 1800,
  endTime: 0,
  priceWei: 0n,
  maxPerWallet: 5,
  blockNumber: 100,
  firstSeenMs: NOW,
  ...over,
});

describe("what counts as upcoming", () => {
  it("is upcoming until the moment it opens", () => {
    expect(isUpcoming(drop({ startTime: sec(NOW) + 1 }), NOW)).toBe(true);
    expect(isUpcoming(drop({ startTime: sec(NOW) - 1 }), NOW)).toBe(false);
  });

  it("is live while open, and an endTime of zero means no end", () => {
    expect(isLive(drop({ startTime: sec(NOW) - 60, endTime: 0 }), NOW)).toBe(true);
    expect(isLive(drop({ startTime: sec(NOW) - 60, endTime: sec(NOW) - 1 }), NOW)).toBe(false);
  });
});

describe("the board", () => {
  it("does not alert twice for the same drop", () => {
    // 19 of the 45 sampled events were edits to a stage already configured.
    // Without dedupe, one project adjusting a price alerts on every save.
    const board = new RadarBoard();
    expect(board.note(drop())).toBe("new");
    expect(board.note(drop())).toBe("known");
  });

  it("does alert again when the terms actually move", () => {
    // A price or time changing on a drop you are already armed for is the
    // single most important thing the radar can say, so dedupe must not eat it.
    const board = new RadarBoard();
    board.note(drop());
    expect(board.note(drop({ priceWei: 5n }))).toBe("changed");
    expect(board.note(drop({ priceWei: 5n, startTime: sec(NOW) + 60 }))).toBe("changed");
  });

  it("keeps the moment it was first seen across updates", () => {
    const board = new RadarBoard();
    board.note(drop({ firstSeenMs: 111 }));
    board.note(drop({ firstSeenMs: 999, priceWei: 7n }));
    expect(board.get(drop().contract, "robinhood")?.firstSeenMs).toBe(111);
  });

  it("counts the same address on two chains as two drops", () => {
    const board = new RadarBoard();
    board.note(drop({ chainKey: "robinhood" }));
    expect(board.note(drop({ chainKey: "base" }))).toBe("new");
  });

  it("orders the board as a countdown, soonest first", () => {
    const board = new RadarBoard();
    board.note(drop({ contract: "0x" + "a".repeat(40), startTime: sec(NOW) + 7200 }));
    board.note(drop({ contract: "0x" + "b".repeat(40), startTime: sec(NOW) + 600 }));
    expect(board.board(NOW)[0].contract).toBe("0x" + "b".repeat(40));
  });

  it("keeps a just-opened drop on the board, since that is when it matters", () => {
    const board = new RadarBoard();
    board.note(drop({ startTime: sec(NOW) - 120 }));
    expect(board.board(NOW)).toHaveLength(1);
  });

  it("forgets what ended, so a long run does not grow forever", () => {
    const board = new RadarBoard();
    board.note(drop({ startTime: sec(NOW) - 60, endTime: sec(NOW) - 1 }));
    expect(board.prune(NOW)).toBe(1);
    expect(board.size).toBe(0);
  });
});

describe("what is worth a notification", () => {
  it("alerts on something new inside the horizon", () => {
    expect(shouldAlert("new", drop(), NOW)).toBe(true);
  });

  it("stays quiet about a drop a month away", () => {
    // One sampled drop was configured 720 hours ahead. Alerting is not an
    // edge there, it is a notification forgotten long before it matters --
    // and it would fire again every time the project touched the stage.
    const far = drop({ startTime: sec(NOW + ALERT_HORIZON_MS) + 3600 });
    expect(shouldAlert("new", far, NOW)).toBe(false);
  });

  it("never alerts for a repeat or something already over", () => {
    expect(shouldAlert("known", drop(), NOW)).toBe(false);
    expect(shouldAlert("stale", drop(), NOW)).toBe(false);
  });
});

describe("formatting", () => {
  it("reads as a countdown at every scale", () => {
    expect(countdown(-5)).toBe("opening now");
    expect(countdown(34 * 60_000)).toBe("in 34 min");
    expect(countdown(2 * 3_600_000 + 5 * 60_000)).toBe("in 2h 05m");
    expect(countdown(72 * 3_600_000)).toBe("in 3 days");
  });

  it("says FREE rather than 0.0000", () => {
    expect(priceLabel(0n, "ETH")).toBe("FREE");
    expect(priceLabel(5_000_000_000_000_000n, "ETH")).toBe("0.0050 ETH");
  });

  it("names the chain's own currency", () => {
    expect(priceLabel(10n ** 18n, "AVAX")).toContain("AVAX");
  });

  it("counts lead time from the stage, not from when it was seen", () => {
    expect(leadMs(drop({ startTime: sec(NOW) + 600 }), NOW)).toBe(600_000);
  });
});

// ── the scout ───────────────────────────────────────────────────────────────

const mint = (minter: string, collection: string, block: number, logIndex = 0): MintRecord => ({
  nftContract: collection,
  minter,
  blockNumber: block,
  logIndex,
  txHash: "0xabc",
  quantity: 1,
  unitPriceWei: 0n,
});

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const C = "0x" + "c".repeat(40);

/** Ten minters into one collection, in the order given. */
const crowd = (collection: string, order: string[]): MintRecord[] =>
  order.map((m, i) => mint(m, collection, 100 + i, i));

describe("ranking minters", () => {
  it("prefers early across many drops over many mints in one", () => {
    // The distinction the whole feature rests on. Ranking by raw mint count
    // finds the biggest spender, which is a different question -- measured on
    // live data, the second-busiest wallet had 17 mints across only 9
    // collections at 70% earliness and correctly did not make the top eight.
    const records = [
      ...crowd("0xC1", [A, "0x" + "1".repeat(40), "0x" + "2".repeat(40)]),
      ...crowd("0xC2", [A, "0x" + "3".repeat(40), "0x" + "4".repeat(40)]),
      ...crowd("0xC3", [A, "0x" + "5".repeat(40), "0x" + "6".repeat(40)]),
      // B mints the same collection over and over, always last.
      ...[0, 1, 2, 3, 4, 5].map((i) => mint(B, "0xC4", 200 + i, i)),
      mint("0x" + "7".repeat(40), "0xC4", 199, 0),
      mint("0x" + "8".repeat(40), "0xC5", 300, 0),
      mint(B, "0xC5", 301, 1),
    ];
    const ranked = rankMinters(records);
    const first = ranked.findIndex((m) => m.address === A.toLowerCase());
    const second = ranked.findIndex((m) => m.address === B.toLowerCase());
    expect(first).toBeLessThan(second);
  });

  it("scores a wallet with no track record at zero", () => {
    // One drop is indistinguishable from clicking a link once, and
    // recommending it would be recommending noise with a number attached.
    expect(score({ address: A, mints: 9, collections: 1, earliness: 1, frontRuns: 1, lastBlock: 1 })).toBe(0);
    expect(MIN_COLLECTIONS).toBe(2);
  });

  it("measures earliness per drop, so a quiet drop is not worth less", () => {
    const records = [...crowd("0xC1", [A, B]), ...crowd("0xC2", [A, B, C, "0x" + "9".repeat(40)])];
    const ranked = rankMinters(records);
    expect(ranked.find((m) => m.address === A.toLowerCase())!.earliness).toBe(1);
    expect(ranked.find((m) => m.address === B.toLowerCase())!.earliness).toBeLessThan(1);
  });

  it("counts a wallet's first mint in a collection, not each of them", () => {
    // Minting five times in one drop is one arrival, counted five times would
    // make a whale look like five early entries.
    const records = [
      mint(A, "0xC1", 100, 0),
      mint(A, "0xC1", 101, 0),
      mint(A, "0xC1", 102, 0),
      mint(B, "0xC1", 103, 0),
      ...crowd("0xC2", [A, B]),
    ];
    const a = rankMinters(records).find((m) => m.address === A.toLowerCase())!;
    expect(a.mints).toBe(4);
    expect(a.collections).toBe(2);
  });
});

describe("scout", () => {
  const records = [...crowd("0xC1", [A, B, C]), ...crowd("0xC2", [A, B, C]), ...crowd("0xC3", [B, A, C])];

  it("leaves out wallets you already hold or watch", () => {
    // Recommending someone their own wallet is the fastest way to make a
    // recommendation list look broken.
    const out = scout(records, { exclude: [A] });
    expect(out.map((m) => m.address)).not.toContain(A.toLowerCase());
  });

  it("returns a list short enough to read", () => {
    expect(scout(records, { limit: 2 })).toHaveLength(2);
  });

  it("gives a reason, never just a number", () => {
    const [top] = scout(records, { limit: 1 });
    expect(why(top)).toMatch(/mints across \d+ collections/);
    expect(why(top)).toMatch(/earliness/);
  });
});
