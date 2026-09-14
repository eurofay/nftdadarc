import { describe, it, expect } from "vitest";
import { getAddress } from "ethers";
import { buildMerkleTree } from "./allowlist-fetch";
import {
  GenericAllowEntry,
  LEAF_ENCODINGS,
  foldSorted,
  parseGenericAllowList,
  solveAllowList,
} from "./generic-merkle";

// Guessing is normally forbidden in this repo. It is allowed here for one
// reason: the answer is checkable against a root the contract already holds,
// exactly, before anything is signed. These pin that the check is real -- that
// a wrong list is rejected rather than turned into a proof that reverts.

const addr = (n: number) => getAddress("0x" + n.toString(16).padStart(2, "0").repeat(20));
const PEOPLE: GenericAllowEntry[] = [
  { address: addr(0x11), allowance: 2n },
  { address: addr(0x22), allowance: 5n },
  { address: addr(0x33), allowance: 1n },
  { address: addr(0x44), allowance: 3n },
  { address: addr(0x55), allowance: 1n },
];

/** Build the root a project would have published, using a chosen encoding. */
const rootUnder = (name: string, entries = PEOPLE) => {
  const encoding = LEAF_ENCODINGS.find((e) => e.name === name)!;
  return buildMerkleTree(entries.map((e) => encoding.encode(e))).root;
};

describe("finding the encoding a project used", () => {
  it("solves the plain packed-address list", () => {
    const root = rootUnder("keccak256(abi.encodePacked(address))");
    const solved = solveAllowList(PEOPLE, root)!;
    expect(solved).not.toBeNull();
    expect(solved.encoding.name).toBe("keccak256(abi.encodePacked(address))");
    expect(solved.entries).toBe(5);
  });

  it("solves a list whose leaves fold in the allowance", () => {
    // Distinguishable from the plain form only by which one reproduces the
    // root -- which is the whole point of checking rather than assuming.
    const name = "keccak256(abi.encodePacked(address, uint256))";
    const solved = solveAllowList(PEOPLE, rootUnder(name))!;
    expect(solved.encoding.name).toBe(name);
    expect(solved.allowances.get(addr(0x22).toLowerCase())).toBe(5n);
  });

  it("solves OpenZeppelin's double-hashed StandardMerkleTree", () => {
    const name = "OpenZeppelin StandardMerkleTree (address)";
    expect(solveAllowList(PEOPLE, rootUnder(name))!.encoding.name).toBe(name);
  });

  it("produces proofs that actually fold back to the root", () => {
    const name = "keccak256(abi.encodePacked(address))";
    const root = rootUnder(name);
    const solved = solveAllowList(PEOPLE, root)!;
    const encoding = LEAF_ENCODINGS.find((e) => e.name === name)!;
    for (const person of PEOPLE) {
      const proof = solved.proofs.get(person.address.toLowerCase())!;
      expect(foldSorted(encoding.encode(person), proof).toLowerCase()).toBe(root.toLowerCase());
    }
  });

  it("gives every wallet its OWN proof", () => {
    const solved = solveAllowList(PEOPLE, rootUnder("keccak256(abi.encodePacked(address))"))!;
    const proofs = PEOPLE.map((p) => JSON.stringify(solved.proofs.get(p.address.toLowerCase())));
    expect(new Set(proofs).size).toBe(PEOPLE.length);
  });

  it("returns null for a list that does not match the contract's root", () => {
    // The failure that matters. A list for a different stage, or one replaced
    // since publication, must be refused -- a proof from it reverts and still
    // pays the gas, discovered during the race it was meant to win.
    expect(solveAllowList(PEOPLE, "0x" + "de".repeat(32))).toBeNull();
  });

  it("returns null when one address is missing from the list", () => {
    // A dropped row changes every hash above it, so the root simply will not
    // match. Silently proceeding would hand out proofs that verify against
    // nothing.
    const short = PEOPLE.slice(0, 4);
    expect(solveAllowList(short, rootUnder("keccak256(abi.encodePacked(address))"))).toBeNull();
  });

  it("returns null for an empty list rather than inventing a tree", () => {
    expect(solveAllowList([], "0x" + "00".repeat(32))).toBeNull();
  });

  it("handles a one-entry list, where the leaf is the root", () => {
    const one = [PEOPLE[0]];
    const solved = solveAllowList(one, rootUnder("keccak256(abi.encodePacked(address))", one))!;
    expect(solved.proofs.get(PEOPLE[0].address.toLowerCase())).toEqual([]);
  });
});

describe("reading a published list", () => {
  it("reads a bare array of addresses", () => {
    const rows = parseGenericAllowList(JSON.stringify([addr(0x11), addr(0x22)]));
    expect(rows).toHaveLength(2);
    expect(rows[0].address).toBe(addr(0x11));
    expect(rows[0].allowance).toBeUndefined();
  });

  it("reads an array of objects, whatever the field is called", () => {
    const json = JSON.stringify([
      { address: addr(0x11), maxMint: 3 },
      { wallet: addr(0x22), allowance: "7" },
    ]);
    const rows = parseGenericAllowList(json);
    expect(rows[0].allowance).toBe(3n);
    expect(rows[1].address).toBe(addr(0x22));
    expect(rows[1].allowance).toBe(7n);
  });

  it("reads a list nested under a wrapper key", () => {
    const json = JSON.stringify({ allowlist: [addr(0x11)], updated: "yesterday" });
    expect(parseGenericAllowList(json)).toHaveLength(1);
  });

  it("reads an object keyed by address", () => {
    const json = JSON.stringify({ [addr(0x11)]: 2, [addr(0x22)]: 4 });
    const rows = parseGenericAllowList(json);
    expect(rows).toHaveLength(2);
    expect(rows[1].allowance).toBe(4n);
  });

  it("throws on a row it cannot read, rather than skipping it", () => {
    // Skipping changes the root. The failure would surface much later as an
    // unexplained "your list does not match this contract".
    expect(() => parseGenericAllowList(JSON.stringify([addr(0x11), { nope: 1 }]))).toThrow();
  });

  it("throws on something that is not a list at all", () => {
    expect(() => parseGenericAllowList('{"status":"ok"}')).toThrow(/list of addresses/);
    expect(() => parseGenericAllowList("not json")).toThrow(/valid JSON/);
  });
});
