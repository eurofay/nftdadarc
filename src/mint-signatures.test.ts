import { describe, it, expect } from "vitest";
import { id } from "ethers";
import {
  KNOWN_MINTS,
  detectMints,
  mintsForSelector,
  selectorOf,
  selectorsFromBytecode,
} from "./mint-signatures";

// Recovering a contract's selectors from its bytecode is what makes minting an
// unknown contract possible at all. These pin the part that is easy to get
// subtly wrong and impossible to notice: the disassembly.

const push4 = (sel: string) => `63${sel.replace(/^0x/, "")}`;
const push32 = (hex64: string) => `7f${hex64}`;

describe("recovering selectors from bytecode", () => {
  it("finds a PUSH4 immediate", () => {
    const code = `0x6080604052${push4("0xa0712d68")}14${push4("0xdeadbeef")}00`;
    const found = selectorsFromBytecode(code);
    expect(found.has("0xa0712d68")).toBe(true);
    expect(found.has("0xdeadbeef")).toBe(true);
  });

  it("does NOT read selectors out of another PUSH's payload", () => {
    // The bug this prevents. 0x63 is also the ASCII for 'c', so any string
    // constant with a 'c' in it looks like a PUSH4 to a naive scan -- and the
    // four bytes after it become a phantom function the contract never had.
    // Here a PUSH32 payload contains a perfectly formed `PUSH4 aabbccdd`.
    const payload = `0000000000000000000000000000000000000063aabbccdd0000000000000000`;
    expect(payload).toHaveLength(64);
    const code = `0x${push32(payload)}00`;
    expect(selectorsFromBytecode(code).has("0xaabbccdd")).toBe(false);
  });

  it("keeps walking after a wide PUSH, rather than losing the rest of the code", () => {
    const payload = "11".repeat(32);
    const code = `0x${push32(payload)}${push4("0xcafebabe")}00`;
    expect(selectorsFromBytecode(code).has("0xcafebabe")).toBe(true);
  });

  it("returns nothing for an address with no code", () => {
    expect(selectorsFromBytecode("0x").size).toBe(0);
    expect(selectorsFromBytecode("").size).toBe(0);
  });

  it("does not throw on truncated code", () => {
    // A node returning a half-word must not take the probe down with it.
    expect(() => selectorsFromBytecode("0x63aabb")).not.toThrow();
  });
});

describe("the signature dictionary", () => {
  it("computes selectors the same way the EVM does", () => {
    for (const m of KNOWN_MINTS) {
      expect(m.selector).toBe(id(m.signature).slice(0, 10));
      expect(m.selector).toMatch(/^0x[0-9a-f]{8}$/);
    }
  });

  it("keeps argument maps the same length as their signatures", () => {
    // An off-by-one here fills the wrong slot -- calldata that encodes
    // cleanly, passes every local check, and reverts on-chain.
    for (const m of KNOWN_MINTS) {
      const arity = m.signature.slice(m.signature.indexOf("(") + 1, m.signature.lastIndexOf(")"));
      const expected = arity === "" ? 0 : splitTopLevel(arity).length;
      expect(m.args.length, m.signature).toBe(expected);
    }
  });

  it("marks a signature with an underivable argument as not autofillable", () => {
    // Manifold's mint is keyed by an instanceId only the project's claim page
    // knows. Recognising it is useful; pretending it can be called is not.
    const manifold = KNOWN_MINTS.find((m) => m.family.includes("Manifold"))!;
    expect(manifold.args).toContain("operator");
    expect(manifold.autofillable).toBe(false);
  });

  it("treats argument order as part of the identity", () => {
    // whitelistMint(uint256,bytes32[]) and whitelistMint(bytes32[],uint256)
    // are different functions. Filling one as the other is a decode revert.
    const a = KNOWN_MINTS.find((m) => m.signature === "whitelistMint(uint256,bytes32[])")!;
    const b = KNOWN_MINTS.find((m) => m.signature === "whitelistMint(bytes32[],uint256)")!;
    expect(a.selector).not.toBe(b.selector);
    expect(a.args).toEqual(["quantity", "proof"]);
    expect(b.args).toEqual(["proof", "quantity"]);
  });
});

describe("choosing which mint a contract exposes", () => {
  const bytecodeWith = (...sigs: string[]) =>
    `0x6080${sigs.map((s) => push4(selectorOf(s))).join("14")}00`;

  it("ranks a gated entry point above a public one", () => {
    // Same reasoning as mint-resolve's stage ordering: a collection with both
    // almost always has the gated stage as the reason for being there, and
    // taking the public one means paying the public price in the public race.
    const code = bytecodeWith("mint(uint256)", "allowlistMint(uint256,bytes32[])");
    const found = detectMints(code);
    expect(found[0].signature).toBe("allowlistMint(uint256,bytes32[])");
    expect(found.map((m) => m.signature)).toContain("mint(uint256)");
  });

  it("finds nothing on a contract with no recognised mint", () => {
    expect(detectMints(`0x6080${push4("0x11223344")}00`)).toHaveLength(0);
  });

  it("reports every signature sharing a selector, never just the first", () => {
    // Four bytes of a hash can collide. Anything relying on a match being
    // unique would silently call the wrong function.
    const sel = selectorOf("mint(uint256)");
    const all = mintsForSelector(sel);
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) expect(m.selector).toBe(sel);
  });
});

/** Split a solidity arg list on top-level commas, so tuples stay intact. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}
