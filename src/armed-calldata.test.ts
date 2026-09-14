import { describe, it, expect } from "vitest";
import { Interface } from "ethers";
import { decodeMint, validateArmed, describeArmed } from "./armed-calldata";
import { SEADROP_ADDRESS } from "./seadrop-public";

// Arming a signed mint hours early is only sound because SeaDrop's digest has
// no clock in it. These pin what that does and does not let us assume.

const MP = "(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients)";
const IF = new Interface([
  `function mintSigned(address,address,address,uint256,${MP},uint256,bytes) payable`,
  `function mintAllowList(address,address,address,uint256,${MP},bytes32[]) payable`,
]);
const NFT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const FEE = "0x3333333333333333333333333333333333333333";
const ZERO = "0x0000000000000000000000000000000000000000";
const NOW = 1_800_000_000;

const params = (over: Partial<{ price: bigint; start: number; end: number }> = {}) => [
  over.price ?? 5_000_000_000_000_000n, 3, over.start ?? NOW + 600, over.end ?? NOW + 7200, 1, 0, 1000, true,
];
const signed = (nft = NFT, over = {}) =>
  IF.encodeFunctionData("mintSigned", [nft, FEE, ZERO, 2, params(over), 12345n, "0xbeef"]);
const allow = (nft = NFT) =>
  IF.encodeFunctionData("mintAllowList", [nft, FEE, ZERO, 2, params(), ["0x" + "aa".repeat(32)]]);

describe("reading armed calldata", () => {
  it("decodes a signed mint, salt and all", () => {
    const d = decodeMint(signed());
    expect(d.kind).toBe("signed");
    expect(d.quantity).toBe(2);
    expect(d.salt).toBe(12345n);
    expect(d.mintPriceWei).toBe(5_000_000_000_000_000n);
  });

  it("decodes an allow-list mint, which carries no salt", () => {
    const d = decodeMint(allow());
    expect(d.kind).toBe("allowlist");
    expect(d.salt).toBeUndefined();
  });

  it("says so rather than guessing at bytes it cannot read", () => {
    // Storing opaque bytes unread means arming something nobody looked at.
    expect(decodeMint("0xdeadbeef").kind).toBe("unknown");
  });
});

describe("what is checked before firing armed calldata", () => {
  const opts = { rpcUrl: "http://unused", expectedContract: NFT, nowSec: NOW };

  it("accepts a mint armed well before its stage opens", () => {
    // The whole point. SeaDrop's digest covers the params and a salt — no
    // issue time, no expiry — so age alone is not a reason to refuse.
    return validateArmed({ to: SEADROP_ADDRESS, data: allow() }, opts).then((r) => {
      expect(r.ok).toBe(true);
    });
  });

  it("refuses calldata addressed anywhere but the SeaDrop singleton", async () => {
    // The one failure worth being blunt about: it would send value to an
    // unknown contract.
    const r = await validateArmed({ to: OTHER, data: allow() }, opts);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("not the SeaDrop singleton");
  });

  it("refuses calldata for a different collection", async () => {
    const r = await validateArmed({ to: SEADROP_ADDRESS, data: allow(OTHER) }, opts);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("different collection");
  });

  it("refuses a stage that has already ended", async () => {
    const r = await validateArmed(
      { to: SEADROP_ADDRESS, data: signed(NFT, { end: NOW - 1 }) },
      opts
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("already ended");
  });

  it("has no age test at all, deliberately", async () => {
    // An age cutoff would throw away good calldata and reintroduce exactly
    // the fire-time fetch this exists to remove.
    const ancient = await validateArmed({ to: SEADROP_ADDRESS, data: allow() }, { ...opts, nowSec: NOW });
    expect(ancient.ok).toBe(true);
  });

  it("refuses bytes it could not decode", async () => {
    const r = await validateArmed({ to: SEADROP_ADDRESS, data: "0x1234" }, opts);
    expect(r.ok).toBe(false);
  });
});

describe("describing an armed mint", () => {
  it("reads as a sentence, so it can be disagreed with before it fires", () => {
    const text = describeArmed(decodeMint(signed()), "ETH");
    expect(text).toContain("signed mint");
    expect(text).toContain("×2");
    expect(text).toContain("0.0050 ETH");
  });

  it("says free rather than 0.0000", () => {
    expect(describeArmed(decodeMint(signed(NFT, { price: 0n })), "ETH")).toContain("free");
  });
});

// A project's own contract is minted by calling the collection directly, so
// "to" is the collection rather than the singleton and the calldata is a
// function this file has no decoder for. Without expectedTo, every such mint
// was rejected -- correct about the decoding, wrong about the conclusion.
describe("arming a mint on a contract that is not SeaDrop's", () => {
  const PROJECT = "0x4444444444444444444444444444444444444444";
  // allowlistMint(uint256,bytes32[]) -- a real mint, not a shape this decodes.
  const GENERIC = new Interface(["function allowlistMint(uint256,bytes32[])"]).encodeFunctionData(
    "allowlistMint",
    [2, ["0x" + "aa".repeat(32)]]
  );

  it("accepts calldata addressed where it was armed", async () => {
    const r = await validateArmed(
      { to: PROJECT, data: GENERIC },
      { rpcUrl: "http://unused", expectedContract: PROJECT, expectedTo: PROJECT, nowSec: NOW }
    );
    expect(r.ok).toBe(true);
    expect(r.decoded.kind).toBe("unknown");
  });

  it("refuses calldata addressed somewhere else entirely", async () => {
    // The check that actually matters here: armed bytes must go where the
    // operator armed them, so value cannot be sent to an address that
    // arrived from somewhere else.
    const r = await validateArmed(
      { to: OTHER, data: GENERIC },
      { rpcUrl: "http://unused", expectedContract: PROJECT, expectedTo: PROJECT, nowSec: NOW }
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(OTHER);
  });

  it("still refuses undecodable bytes when no destination was armed", async () => {
    // Supplying expectedTo must not weaken the SeaDrop path: without it,
    // nothing changes.
    const r = await validateArmed(
      { to: SEADROP_ADDRESS, data: GENERIC },
      { rpcUrl: "http://unused", expectedContract: PROJECT, nowSec: NOW }
    );
    expect(r.ok).toBe(false);
  });

  it("keeps checking SeaDrop calldata as SeaDrop, even with expectedTo set", async () => {
    // A SeaDrop mint that decodes must go through the SeaDrop checks, not be
    // waved through by a matching destination.
    const r = await validateArmed(
      { to: SEADROP_ADDRESS, data: signed(OTHER) },
      {
        rpcUrl: "http://unused",
        expectedContract: NFT,
        expectedTo: SEADROP_ADDRESS,
        nowSec: NOW,
      }
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("different collection");
  });
});
