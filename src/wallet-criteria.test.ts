import { describe, it, expect } from "vitest";
import {
  parseCriteria,
  describeCriteria,
  applyCriteria,
  fieldsNeeded,
  parseCriteriaJson,
  WalletStats,
} from "./wallet-criteria";

describe("parseCriteria", () => {
  it("reads a transaction floor", () => {
    expect(parseCriteria("wallets with more than 5 transactions")).toEqual({
      join: "all",
      conditions: [{ field: "txCount", op: "gt", value: 5 }],
    });
  });

  it("reads a balance floor", () => {
    expect(parseCriteria("minimum balance of 0.01 eth")).toEqual({
      join: "all",
      conditions: [{ field: "balance", op: "gte", value: 0.01 }],
    });
  });

  it("reads two clauses joined by and", () => {
    const out = parseCriteria("more than 10 transactions and at least 0.05 eth");
    expect(out?.join).toBe("all");
    expect(out?.conditions).toEqual([
      { field: "txCount", op: "gt", value: 10 },
      { field: "balance", op: "gte", value: 0.05 },
    ]);
  });

  it("treats or as any", () => {
    expect(parseCriteria("over 100 transactions or over 1 eth")?.join).toBe("any");
  });

  it("takes a bare number as a minimum, which is what people mean", () => {
    // "wallets with 5 transactions" has never once meant exactly five.
    expect(parseCriteria("wallets with 5 transactions")?.conditions[0]).toEqual({
      field: "txCount",
      op: "gte",
      value: 5,
    });
  });

  it("does not read 'at least' as 'less than'", () => {
    expect(parseCriteria("at least 3 transactions")?.conditions[0].op).toBe("gte");
  });

  it("does not read '>=' as '>'", () => {
    expect(parseCriteria("tx >= 3")?.conditions[0].op).toBe("gte");
  });

  it("understands symbols", () => {
    expect(parseCriteria("balance > 0.5")?.conditions[0]).toEqual({
      field: "balance",
      op: "gt",
      value: 0.5,
    });
  });

  it("expands a k suffix", () => {
    expect(parseCriteria("more than 10k transactions")?.conditions[0].value).toBe(10_000);
  });

  it("strips thousands separators", () => {
    expect(parseCriteria("more than 1,500 transactions")?.conditions[0].value).toBe(1500);
  });

  it("reads an upper bound", () => {
    expect(parseCriteria("no more than 2 transactions")?.conditions[0].op).toBe("lte");
  });

  it("reads nft holdings", () => {
    expect(parseCriteria("holding at least 3 nfts")?.conditions[0].field).toBe("nftCount");
  });

  it("gives up rather than half-understanding", () => {
    // Dropping an unreadable clause would silently widen the filter, and the
    // result would look perfectly plausible.
    expect(parseCriteria("more than 5 transactions and something weird 7")).toBe(null);
  });

  it("returns null on nothing usable", () => {
    expect(parseCriteria("hello there")).toBe(null);
    expect(parseCriteria("")).toBe(null);
  });
});

describe("fieldsNeeded", () => {
  it("lists each field once, so nothing is fetched twice", () => {
    const c = parseCriteria("more than 5 transactions and at least 1 tx")!;
    expect(fieldsNeeded(c)).toEqual(["txCount"]);
  });

  it("covers both fields when both are filtered", () => {
    const c = parseCriteria("more than 5 transactions and at least 0.1 eth")!;
    expect(fieldsNeeded(c).sort()).toEqual(["balance", "txCount"]);
  });
});

describe("describeCriteria", () => {
  it("reads back in plain words for confirmation", () => {
    const c = parseCriteria("more than 5 transactions and at least 0.05 eth")!;
    expect(describeCriteria(c)).toBe("transactions more than 5 AND balance at least 0.05 ETH");
  });

  it("says OR when that is what was meant", () => {
    expect(describeCriteria(parseCriteria("over 5 tx or over 1 eth")!)).toContain(" OR ");
  });
});

describe("applyCriteria", () => {
  const stats: WalletStats[] = [
    { address: "0xa", balance: 1, txCount: 10 },
    { address: "0xb", balance: 0.001, txCount: 100 },
    { address: "0xc", balance: 5, txCount: 0 },
  ];

  it("keeps only wallets meeting every condition", () => {
    const c = parseCriteria("at least 0.5 eth and more than 5 transactions")!;
    expect(applyCriteria(stats, c).map((s) => s.address)).toEqual(["0xa"]);
  });

  it("keeps wallets meeting any condition when asked", () => {
    const c = parseCriteria("over 50 transactions or over 4 eth")!;
    expect(applyCriteria(stats, c).map((s) => s.address)).toEqual(["0xb", "0xc"]);
  });

  it("excludes a wallet whose value could not be read", () => {
    // An unknown balance is not a passing balance. Letting it through would
    // put wallets in the output that may not qualify at all.
    const unread: WalletStats[] = [{ address: "0xd", txCount: 100 }];
    const c = parseCriteria("at least 0.5 eth")!;
    expect(applyCriteria(unread, c)).toEqual([]);
  });

  it("handles an empty input", () => {
    expect(applyCriteria([], parseCriteria("over 1 eth")!)).toEqual([]);
  });
});

describe("parseCriteriaJson", () => {
  it("accepts a well-formed answer", () => {
    const out = parseCriteriaJson('{"join":"all","conditions":[{"field":"balance","op":"gte","value":1}]}');
    expect(out).toEqual({ join: "all", conditions: [{ field: "balance", op: "gte", value: 1 }] });
  });

  it("digs the json out of surrounding prose", () => {
    const out = parseCriteriaJson('Sure!\n```json\n{"join":"all","conditions":[{"field":"txCount","op":"gt","value":2}]}\n```');
    expect(out?.conditions[0].field).toBe("txCount");
  });

  it("rejects an invented field rather than guessing at it", () => {
    // The reply decides how an hour of RPC work is spent; a field nobody can
    // fetch has to be refused, not coerced into something plausible.
    expect(parseCriteriaJson('{"conditions":[{"field":"vibes","op":"gte","value":1}]}')).toBe(null);
  });

  it("rejects an unknown operator", () => {
    expect(parseCriteriaJson('{"conditions":[{"field":"balance","op":"near","value":1}]}')).toBe(null);
  });

  it("rejects a non-numeric value", () => {
    expect(parseCriteriaJson('{"conditions":[{"field":"balance","op":"gte","value":"lots"}]}')).toBe(null);
  });

  it("rejects an empty condition list", () => {
    expect(parseCriteriaJson('{"conditions":[]}')).toBe(null);
  });

  it("rejects malformed json", () => {
    expect(parseCriteriaJson("not json at all")).toBe(null);
  });

  it("defaults an unrecognised join to all, the safer reading", () => {
    const out = parseCriteriaJson('{"join":"maybe","conditions":[{"field":"balance","op":"gte","value":1}]}');
    expect(out?.join).toBe("all");
  });
});
