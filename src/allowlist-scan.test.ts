import { describe, it, expect, vi, beforeEach } from "vitest";

const getLogs = vi.fn();
const getBlockNumber = vi.fn(async () => 60_000_000);

vi.mock("./rpc-provider", () => ({
  createProvider: () => ({ getLogs, getBlockNumber }),
}));

import { findAllowListUri } from "./allowlist-fetch";

const NFT = "0x3333333333333333333333333333333333333333";

// An AllowListUpdated payload: (string[] publicKeyURI, string allowListURI).
function encodeUri(uri: string): string {
  const raw = Buffer.from(uri, "utf8").toString("hex");
  const hex = raw.padEnd(Math.ceil(raw.length / 64) * 64, "0");
  const word = (n: number) => n.toString(16).padStart(64, "0");
  // head: offset to publicKeyURI (0x40), offset to allowListURI (0x60);
  // then the empty string[], then the URI's length and bytes.
  return "0x" + word(0x40) + word(0x60) + word(0) + word(uri.length) + hex;
}

beforeEach(() => {
  getLogs.mockReset();
  getBlockNumber.mockClear();
});

describe("findAllowListUri", () => {
  it("asks for all of history in one call", async () => {
    // The old version walked back 200 chunks over a 2,000,000-block window,
    // which on a 0.1s chain is 2.34 days -- so a list set a week before the
    // drop was invisible, and the search outlived Telegram's 90s handler.
    getLogs.mockResolvedValueOnce([{ data: encodeUri("ipfs://Qm123"), blockNumber: 42 }]);

    const found = await findAllowListUri("http://rpc", NFT);

    expect(found).toEqual({ uri: "ipfs://Qm123", block: 42 });
    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(getLogs.mock.calls[0][0]).toMatchObject({ fromBlock: 0, toBlock: 60_000_000 });
  });

  it("takes the newest list when one replaced another", async () => {
    getLogs.mockResolvedValueOnce([
      { data: encodeUri("ipfs://old"), blockNumber: 10 },
      { data: encodeUri("ipfs://new"), blockNumber: 900 },
    ]);
    expect(await findAllowListUri("http://rpc", NFT)).toEqual({ uri: "ipfs://new", block: 900 });
  });

  it("treats an empty full-history answer as authoritative", async () => {
    // Asking the same question 200 more times in smaller pieces cannot turn
    // "no such event" into a result, and used to cost minutes doing it.
    getLogs.mockResolvedValueOnce([]);
    expect(await findAllowListUri("http://rpc", NFT)).toBe(null);
    expect(getLogs).toHaveBeenCalledTimes(1);
  });

  it("falls back to chunks only when the node refuses the wide range", async () => {
    getLogs.mockRejectedValueOnce(new Error("query returned more than 10000 results"));
    getLogs.mockResolvedValue([{ data: encodeUri("ipfs://Qm456"), blockNumber: 7 }]);

    const found = await findAllowListUri("http://rpc", NFT, { chunkBlocks: 2_000, maxBlocks: 4_000 });

    expect(found).toEqual({ uri: "ipfs://Qm456", block: 7 });
    expect(getLogs.mock.calls.length).toBeGreaterThan(1);
    expect(getLogs.mock.calls[1][0].toBlock).toBe(60_000_000);
  });
});
