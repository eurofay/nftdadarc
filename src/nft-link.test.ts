import { describe, it, expect } from "vitest";
import { parseNftLink } from "./nft-link";

describe("parseNftLink", () => {
  it("accepts a bare contract address", () => {
    const r = parseNftLink("0x1234567890123456789012345678901234567890");
    expect(r).toEqual({ kind: "address", value: "0x1234567890123456789012345678901234567890" });
  });

  it("accepts a bare collection slug", () => {
    const r = parseNftLink("my-cool-drop");
    expect(r).toEqual({ kind: "slug", value: "my-cool-drop" });
  });

  it("lowercases a bare slug", () => {
    const r = parseNftLink("My-Cool-Drop");
    expect(r.kind).toBe("slug");
    expect(r.value).toBe("my-cool-drop");
  });

  it("parses a collection URL with no chain segment", () => {
    const r = parseNftLink("https://opensea.io/collection/my-cool-drop");
    expect(r).toEqual({ kind: "slug", value: "my-cool-drop", chainHint: undefined });
  });

  it("parses a collection URL with a chain segment", () => {
    const r = parseNftLink("https://opensea.io/base/collection/my-cool-drop");
    expect(r.kind).toBe("slug");
    expect(r.value).toBe("my-cool-drop");
    expect(r.chainHint).toBe("base");
  });

  it("parses a collection URL with a trailing /drop path", () => {
    const r = parseNftLink("https://opensea.io/collection/my-cool-drop/drop");
    expect(r.kind).toBe("slug");
    expect(r.value).toBe("my-cool-drop");
  });

  it("normalizes the eth/mainnet chain aliases", () => {
    expect(parseNftLink("https://opensea.io/ethereum/collection/foo").chainHint).toBe("ethereum");
    expect(parseNftLink("https://opensea.io/eth/collection/foo").chainHint).toBe("ethereum");
    expect(parseNftLink("https://opensea.io/mainnet/collection/foo").chainHint).toBe("ethereum");
  });

  it("parses an item URL and extracts chain, address and tokenId", () => {
    const r = parseNftLink(
      "https://opensea.io/item/base/0x1234567890123456789012345678901234567890/42"
    );
    expect(r).toEqual({
      kind: "address",
      value: "0x1234567890123456789012345678901234567890",
      chainHint: "base",
      tokenId: "42",
    });
  });

  it("parses an /assets/ URL the same way as /item/", () => {
    const r = parseNftLink(
      "https://opensea.io/assets/ethereum/0x1234567890123456789012345678901234567890/1"
    );
    expect(r.kind).toBe("address");
    expect(r.chainHint).toBe("ethereum");
  });

  it("falls back to a loose contract address anywhere in the path", () => {
    const r = parseNftLink(
      "https://opensea.io/some/weird/path/0x1234567890123456789012345678901234567890"
    );
    expect(r.kind).toBe("address");
    expect(r.value).toBe("0x1234567890123456789012345678901234567890");
  });

  it("strips trailing slashes before parsing", () => {
    const r = parseNftLink("https://opensea.io/collection/my-cool-drop/");
    expect(r.value).toBe("my-cool-drop");
  });

  it("throws on empty input", () => {
    expect(() => parseNftLink("")).toThrow();
    expect(() => parseNftLink("   ")).toThrow();
  });

  it("throws on a slug with illegal characters", () => {
    expect(() => parseNftLink("not a slug!")).toThrow();
  });

  it("throws when a URL has no recognizable collection or address", () => {
    expect(() => parseNftLink("https://opensea.io/learn/whatever")).toThrow();
  });
});
