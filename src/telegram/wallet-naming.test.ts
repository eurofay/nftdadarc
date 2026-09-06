import { describe, it, expect } from "vitest";
import { loopNames, tail, describeRenamePlan, NAME_PREFIX } from "./wallet-naming";

const A = "0xEf41B3f5f0bA5b1eDC9D5B1eDC9D5B1eDC9D3486";
const B = "0x631a25d519BD0204e36a4018a5F4bee0B8468617";
const C = "0xAdd5c9BA1f0bA5b1eDC9D5B1eDC9D5B1eDC9A6F2";

describe("tail", () => {
  it("takes the last n characters, ignoring the 0x", () => {
    expect(tail(A, 3)).toBe("486");
    expect(tail(B, 3)).toBe("617");
  });

  it("handles an address written without the prefix", () => {
    expect(tail("abcdef", 3)).toBe("def");
  });

  it("never returns more than the address has", () => {
    expect(tail("0xab", 10)).toBe("ab");
  });
});

describe("loopNames", () => {
  it("names each wallet from its own address", () => {
    const names = loopNames([A, B, C]);
    expect(names.get(A)).toBe("l00p-486");
    expect(names.get(B)).toBe("l00p-617");
    expect(names.get(C)).toBe("l00p-6F2");
  });

  it("uses the l00p- prefix by default", () => {
    expect([...loopNames([A]).values()][0].startsWith(NAME_PREFIX)).toBe(true);
  });

  it("keys the result by the address exactly as given", () => {
    // Checksummed addresses are mixed case; looking the result up must not
    // require guessing which casing was used.
    const names = loopNames([A]);
    expect(names.has(A)).toBe(true);
  });

  it("preserves the address's own casing in the name", () => {
    expect(loopNames([C]).get(C)).toBe("l00p-6F2");
  });

  describe("collisions", () => {
    // Two wallets sharing a name defeats the whole point of naming them.
    const X = "0x1111111111111111111111111111111111111abc";
    const Y = "0x2222222222222222222222222222222222222abc";

    it("widens both names until they differ", () => {
      const names = loopNames([X, Y]);
      expect(names.get(X)).not.toBe(names.get(Y));
    });

    it("widens by as little as possible", () => {
      const names = loopNames([X, Y]);
      // Both end "abc", so 3 clashes; one more character separates them.
      expect(names.get(X)).toBe("l00p-1abc");
      expect(names.get(Y)).toBe("l00p-2abc");
    });

    it("keeps widening when one extra character is not enough", () => {
      const P = "0x1111111111111111111111111111111111112abc";
      const Q = "0x2222222222222222222222222222222222232abc";
      const names = loopNames([P, Q]);
      expect(names.get(P)).toBe("l00p-12abc");
      expect(names.get(Q)).toBe("l00p-32abc");
    });

    it("leaves non-clashing wallets short", () => {
      const names = loopNames([X, Y, A]);
      expect(names.get(A)).toBe("l00p-486");
    });

    it("terminates when the same address appears twice", () => {
      // Identical addresses can never be told apart; looping forever to find
      // that out would be worse than naming them the same.
      const names = loopNames([A, A]);
      expect(names.get(A)).toBeDefined();
    });
  });

  it("accepts a different prefix and width", () => {
    const names = loopNames([A], { prefix: "w-", suffix: 4 });
    expect(names.get(A)).toBe("w-3486");
  });

  it("handles an empty list", () => {
    expect(loopNames([]).size).toBe(0);
  });
});

describe("describeRenamePlan", () => {
  const wallets = [
    { address: A, label: "0xEf41B3" },
    { address: B, label: "0x631a25" },
  ];

  it("shows old and new side by side", () => {
    const out = describeRenamePlan(wallets, loopNames([A, B]));
    expect(out).toContain("0xEf41B3 → l00p-486");
    expect(out).toContain("0x631a25 → l00p-617");
  });

  it("lists only what actually changes", () => {
    const already = [{ address: A, label: "l00p-486" }, { address: B, label: "0x631a25" }];
    const out = describeRenamePlan(already, loopNames([A, B]));
    expect(out).not.toContain("l00p-486 →");
    expect(out).toContain("l00p-617");
  });

  it("says so when there is nothing to do", () => {
    const already = [{ address: A, label: "l00p-486" }];
    expect(describeRenamePlan(already, loopNames([A]))).toContain("already");
  });

  it("truncates a long list rather than flooding the message", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      address: `0x${i.toString(16).padStart(40, "0")}`,
      label: `w${i}`,
    }));
    const out = describeRenamePlan(many, loopNames(many.map((w) => w.address)));
    expect(out).toContain("…and 8 more");
  });
});
