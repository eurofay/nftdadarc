import { describe, it, expect } from "vitest";
import {
  trimEth,
  describeShortfall,
  renderCopyAttempt,
  RepeatFilter,
  CopyAttemptSummary,
} from "./copy-mint-message";

const eth = (s: string): bigint => BigInt(Math.round(Number(s) * 1e18));

describe("trimEth", () => {
  it("keeps the digits that matter on a tiny balance", () => {
    // The real value from the log. Sixteen figures buries the one that counts.
    expect(trimEth(eth("0.0004899558491099"))).toBe("0.00049");
  });

  it("does not collapse a small number to zero", () => {
    expect(trimEth(eth("0.0000982152864"))).not.toBe("0");
    expect(Number(trimEth(eth("0.0000982152864")))).toBeGreaterThan(0);
  });

  it("renders zero plainly", () => {
    expect(trimEth(0n)).toBe("0");
  });

  it("handles whole-ether amounts without scientific notation", () => {
    expect(trimEth(eth("1.5"))).not.toMatch(/e/i);
  });
});

describe("describeShortfall", () => {
  const wallets = [
    { address: "0xEf41Bc3F00000000000000000000000000000000", heldWei: eth("0.00048995"), neededWei: eth("0.0005") },
    { address: "0xE607f2b100000000000000000000000000000000", heldWei: eth("0.00032058"), neededWei: eth("0.0005") },
  ];

  it("names the closest wallet and the gap, not every balance", () => {
    // The gap is what turns "it didn't work" into an action.
    const out = describeShortfall(wallets)!;
    expect(out).toContain("0xEf41");
    expect(out).toMatch(/short/i);
    expect(out).not.toContain("0xE607");
  });

  it("reports the amount each wallet needs", () => {
    expect(describeShortfall(wallets)).toContain("0.0005");
  });

  it("is null when every wallet can afford it", () => {
    expect(
      describeShortfall([{ address: "0xA", heldWei: eth("1"), neededWei: eth("0.0005") }])
    ).toBeNull();
  });

  it("picks the genuinely closest, not the first listed", () => {
    const out = describeShortfall([
      { address: "0xFar0000000000000000000000000000000000000", heldWei: 0n, neededWei: eth("0.0005") },
      { address: "0xNear000000000000000000000000000000000000", heldWei: eth("0.00049"), neededWei: eth("0.0005") },
    ])!;
    expect(out).toContain("0xNear");
  });
});

describe("renderCopyAttempt", () => {
  const base: CopyAttemptSummary = {
    collection: "GOAT STATE",
    contract: "0x660eD4D021987D3881dd59a467f097aAC5d7EeDc",
    slug: "goat-state",
    sourceWallet: "0x49DFF9fF7d0C84079b1631a54AdE13fFCE8552fE",
    blockNumber: 53724894,
    outcome: "skipped",
  };

  it("leads with the collection name, not the contract address", () => {
    const out = renderCopyAttempt(base);
    expect(out.split("\n")[0]).toContain("GOAT STATE");
    expect(out.split("\n")[0]).not.toContain("0x660eD4D0");
  });

  it("includes a link when the slug is known", () => {
    expect(renderCopyAttempt(base)).toContain("opensea.io/collection/goat-state");
  });

  it("omits the link rather than inventing one", () => {
    expect(renderCopyAttempt({ ...base, slug: undefined })).not.toContain("opensea.io");
  });

  it("reports a success with what was actually minted", () => {
    const out = renderCopyAttempt({
      ...base,
      outcome: "minted",
      quantity: 3,
      txHashes: ["0xaaa", "0xbbb"],
    });
    expect(out).toContain("🟢");
    expect(out).toContain("Minted 3");
    expect(out).toContain("2 wallet(s)");
  });

  it("gives one shortfall line, not a line per wallet", () => {
    const out = renderCopyAttempt({
      ...base,
      reason: "no wallet can cover the mint",
      wallets: [
        { address: "0xEf41Bc3F00000000000000000000000000000000", heldWei: eth("0.00048995"), neededWei: eth("0.0005") },
        { address: "0xE607f2b100000000000000000000000000000000", heldWei: eth("0.00032058"), neededWei: eth("0.0005") },
        { address: "0xAAAA000000000000000000000000000000000000", heldWei: eth("0.0001"), neededWei: eth("0.0005") },
      ],
    });
    // Three wallets, one shortfall sentence — the old log printed three.
    expect(out.split("\n").filter((l) => /short/i.test(l))).toHaveLength(1);
  });

  it("marks a repeat so the reader knows it is not new", () => {
    expect(renderCopyAttempt({ ...base, reason: "underfunded", repeatCount: 4 })).toContain("4×");
  });

  it("says nothing about repeats the first time", () => {
    expect(renderCopyAttempt({ ...base, reason: "underfunded", repeatCount: 1 })).not.toContain("×");
  });
});

describe("RepeatFilter", () => {
  it("always sends the first occurrence", () => {
    expect(new RepeatFilter().consider("underfunded").send).toBe(true);
  });

  it("swallows the ones in between", () => {
    // Nineteen watched wallets means the same failure many times an hour. The
    // first is information; the third is noise burying everything else.
    const f = new RepeatFilter(60_000, 5);
    f.consider("k");
    expect(f.consider("k").send).toBe(false);
    expect(f.consider("k").send).toBe(false);
    expect(f.consider("k").send).toBe(false);
  });

  it("resurfaces periodically, so a lasting problem stays visible", () => {
    const f = new RepeatFilter(60_000, 5);
    for (let i = 0; i < 4; i++) f.consider("k");
    const fifth = f.consider("k");
    expect(fifth.send).toBe(true);
    expect(fifth.count).toBe(5);
  });

  it("treats different reasons separately", () => {
    const f = new RepeatFilter();
    f.consider("underfunded");
    expect(f.consider("price too high").send).toBe(true);
  });

  it("starts fresh once the window has passed", () => {
    const f = new RepeatFilter(1000, 5);
    const t = 1_000_000;
    f.consider("k", t);
    expect(f.consider("k", t + 500).send).toBe(false);
    expect(f.consider("k", t + 2000).send).toBe(true);
  });
});
