import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Wallet } from "ethers";
import { TelegramStore } from "./store";

// Freshly generated for this test file only — not reused anywhere, no funds ever touch them.
const TEST_KEY_1 = "0xad6c4582d7bae64497e12e590deb375c3e5e1827044300f6a9d98f06c6dae4bd";
const TEST_KEY_2 = "0xed2d4e86c549055cc9ac40a86cfa836773d4c82aa71d1ec5503011707b90dfb0";

let tmpFile: string;

function freshStore(passphrase = "test-pass"): TelegramStore {
  tmpFile = path.join(os.tmpdir(), `store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return new TelegramStore(tmpFile, passphrase);
}

afterEach(() => {
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
});

describe("TelegramStore wallets", () => {
  it("adds a wallet from a valid private key and derives its address", () => {
    const store = freshStore();
    const record = store.addWallet("main", TEST_KEY_1);
    expect(record.address).toBe(new Wallet(TEST_KEY_1).address);
    expect(store.listWallets()).toHaveLength(1);
    expect(store.listWallets()[0].label).toBe("main");
  });

  it("rejects a malformed private key without persisting anything", () => {
    const store = freshStore();
    expect(() => store.addWallet("bad", "not-a-key")).toThrow();
    expect(store.listWallets()).toHaveLength(0);
  });

  it("rejects adding the same wallet twice", () => {
    const store = freshStore();
    store.addWallet("main", TEST_KEY_1);
    expect(() => store.addWallet("dupe", TEST_KEY_1)).toThrow();
    expect(store.listWallets()).toHaveLength(1);
  });

  it("decrypts stored keys back to the original values", () => {
    const store = freshStore();
    store.addWallet("a", TEST_KEY_1);
    store.addWallet("b", TEST_KEY_2);
    const decrypted = store.getDecryptedKeys();
    expect(decrypted).toContain(TEST_KEY_1);
    expect(decrypted).toContain(TEST_KEY_2);
  });

  it("decrypts a single wallet's key by address", () => {
    const store = freshStore();
    const rec = store.addWallet("a", TEST_KEY_1);
    store.addWallet("b", TEST_KEY_2);
    expect(store.getDecryptedKey(rec.address)).toBe(TEST_KEY_1);
    expect(store.getDecryptedKey(rec.address.toUpperCase())).toBe(TEST_KEY_1); // case-insensitive
  });

  it("throws for an address with no stored wallet", () => {
    const store = freshStore();
    expect(() => store.getDecryptedKey("0x000000000000000000000000000000000000ff")).toThrow();
  });

  it("never stores the plaintext key in the persisted record", () => {
    const store = freshStore();
    store.addWallet("main", TEST_KEY_1);
    const raw = fs.readFileSync(tmpFile, "utf8");
    expect(raw).not.toContain(TEST_KEY_1);
  });

  it("removes a wallet by address", () => {
    const store = freshStore();
    const rec = store.addWallet("main", TEST_KEY_1);
    expect(store.removeWallet(rec.address)).toBe(true);
    expect(store.listWallets()).toHaveLength(0);
  });

  it("removeWallet returns false for an address that isn't stored", () => {
    const store = freshStore();
    expect(store.removeWallet("0x000000000000000000000000000000000000ff")).toBe(false);
  });

  it("persists across a fresh instance pointed at the same file", () => {
    const store1 = freshStore();
    store1.addWallet("main", TEST_KEY_1);
    const store2 = new TelegramStore(tmpFile, "test-pass");
    expect(store2.listWallets()).toHaveLength(1);
    expect(store2.getDecryptedKeys()).toEqual([TEST_KEY_1]);
  });

  it("fails to decrypt keys when reopened with the wrong passphrase", () => {
    const store1 = freshStore("right-pass");
    store1.addWallet("main", TEST_KEY_1);
    const store2 = new TelegramStore(tmpFile, "wrong-pass");
    expect(() => store2.getDecryptedKeys()).toThrow();
  });

  it("includes every wallet in auto/copy mint by default, unset until told otherwise", () => {
    const store = freshStore();
    store.addWallet("a", TEST_KEY_1);
    store.addWallet("b", TEST_KEY_2);
    expect(store.listWalletsFor("auto")).toHaveLength(2);
    expect(store.listWalletsFor("copy")).toHaveLength(2);
    expect(store.getDecryptedKeysFor("auto")).toEqual([TEST_KEY_1, TEST_KEY_2]);
  });

  it("excludes a wallet from auto mint only, leaving copy mint untouched", () => {
    const store = freshStore();
    const a = store.addWallet("a", TEST_KEY_1);
    store.addWallet("b", TEST_KEY_2);
    store.setWalletInclusion(a.address, "auto", false);

    expect(store.listWalletsFor("auto")).toHaveLength(1);
    expect(store.listWalletsFor("auto")[0].label).toBe("b");
    expect(store.getDecryptedKeysFor("auto")).toEqual([TEST_KEY_2]);

    expect(store.listWalletsFor("copy")).toHaveLength(2); // untouched
  });

  it("can be toggled back on after being excluded", () => {
    const store = freshStore();
    const a = store.addWallet("a", TEST_KEY_1);
    store.setWalletInclusion(a.address, "copy", false);
    expect(store.listWalletsFor("copy")).toHaveLength(0);
    store.setWalletInclusion(a.address, "copy", true);
    expect(store.listWalletsFor("copy")).toHaveLength(1);
  });

  it("setWalletInclusion throws for an address with no stored wallet", () => {
    const store = freshStore();
    expect(() => store.setWalletInclusion("0x000000000000000000000000000000000000ff", "auto", false)).toThrow();
  });

  it("persists per-wallet inclusion across a fresh instance", () => {
    const store1 = freshStore();
    const a = store1.addWallet("a", TEST_KEY_1);
    store1.setWalletInclusion(a.address, "auto", false);
    const store2 = new TelegramStore(tmpFile, "test-pass");
    expect(store2.listWalletsFor("auto")).toHaveLength(0);
  });
});

describe("TelegramStore copy-mint watchlist", () => {
  it("adds and lists a copy-mint target", () => {
    const store = freshStore();
    store.addCopyTarget("whale", "0x1111111111111111111111111111111111111111");
    expect(store.listCopyTargets()).toHaveLength(1);
    expect(store.listCopyTargets()[0].label).toBe("whale");
  });

  it("rejects duplicate targets", () => {
    const store = freshStore();
    store.addCopyTarget("whale", "0x1111111111111111111111111111111111111111");
    expect(() => store.addCopyTarget("again", "0x1111111111111111111111111111111111111111")).toThrow();
  });

  it("removes a target by address", () => {
    const store = freshStore();
    store.addCopyTarget("whale", "0x1111111111111111111111111111111111111111");
    expect(store.removeCopyTarget("0x1111111111111111111111111111111111111111")).toBe(true);
    expect(store.listCopyTargets()).toHaveLength(0);
  });
});

describe("TelegramStore minted holdings", () => {
  const NFT = "0x1111111111111111111111111111111111111111";
  const W1 = "0xaaaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
  const W2 = "0xbbbBbBbbBbBbBbbBbBBBBBBBBbbbBbBbBbbBbbBb";

  it("records a first mint with its metadata", () => {
    const store = freshStore();
    const rec = store.recordMint({
      chainKey: "robinhood",
      nftContract: NFT,
      quantity: 3,
      wallets: [W1],
      txHash: "0xtx1",
      slug: "osborns",
      name: "Osborns",
    });
    expect(rec.quantity).toBe(3);
    expect(rec.slug).toBe("osborns");
    expect(store.listMints()).toHaveLength(1);
  });

  it("accumulates quantity and wallets into one row per collection", () => {
    const store = freshStore();
    store.recordMint({ chainKey: "robinhood", nftContract: NFT, quantity: 3, wallets: [W1], txHash: "0xa" });
    const rec = store.recordMint({ chainKey: "robinhood", nftContract: NFT, quantity: 2, wallets: [W2], txHash: "0xb" });

    expect(store.listMints()).toHaveLength(1);
    expect(rec.quantity).toBe(5);
    expect(rec.wallets).toEqual([W1, W2]);
    expect(rec.lastTxHash).toBe("0xb");
  });

  it("does not duplicate a wallet that mints the same collection twice", () => {
    const store = freshStore();
    store.recordMint({ chainKey: "robinhood", nftContract: NFT, quantity: 1, wallets: [W1], txHash: "0xa" });
    const rec = store.recordMint({ chainKey: "robinhood", nftContract: NFT, quantity: 1, wallets: [W1], txHash: "0xb" });
    expect(rec.wallets).toEqual([W1]);
    expect(rec.quantity).toBe(2);
  });

  it("backfills metadata that wasn't resolvable on the first mint", () => {
    const store = freshStore();
    store.recordMint({ chainKey: "robinhood", nftContract: NFT, quantity: 1, wallets: [W1], txHash: "0xa" });
    expect(store.listMints()[0].slug).toBeUndefined();

    const rec = store.recordMint({
      chainKey: "robinhood",
      nftContract: NFT,
      quantity: 1,
      wallets: [W1],
      txHash: "0xb",
      slug: "osborns",
      name: "Osborns",
    });
    expect(rec.slug).toBe("osborns");
    expect(rec.name).toBe("Osborns");
  });

  it("keeps the same contract on different chains as separate holdings", () => {
    const store = freshStore();
    store.recordMint({ chainKey: "robinhood", nftContract: NFT, quantity: 1, wallets: [W1], txHash: "0xa" });
    store.recordMint({ chainKey: "ethereum", nftContract: NFT, quantity: 1, wallets: [W1], txHash: "0xb" });
    expect(store.listMints()).toHaveLength(2);
  });

  it("matches the contract case-insensitively", () => {
    const store = freshStore();
    store.recordMint({ chainKey: "robinhood", nftContract: NFT, quantity: 1, wallets: [W1], txHash: "0xa" });
    store.recordMint({ chainKey: "robinhood", nftContract: NFT.toUpperCase(), quantity: 1, wallets: [W1], txHash: "0xb" });
    expect(store.listMints()).toHaveLength(1);
  });

  it("lists most-recently-minted first", () => {
    const store = freshStore();
    const other = "0x2222222222222222222222222222222222222222";
    store.recordMint({ chainKey: "robinhood", nftContract: NFT, quantity: 1, wallets: [W1], txHash: "0xa" });
    store.recordMint({ chainKey: "robinhood", nftContract: other, quantity: 1, wallets: [W1], txHash: "0xb" });
    expect(store.listMints()[0].nftContract).toBe(other);
  });

  it("removes a holding, and reports false for one that isn't held", () => {
    const store = freshStore();
    store.recordMint({ chainKey: "robinhood", nftContract: NFT, quantity: 1, wallets: [W1], txHash: "0xa" });
    expect(store.removeMint(NFT)).toBe(true);
    expect(store.listMints()).toHaveLength(0);
    expect(store.removeMint(NFT)).toBe(false);
  });

  it("persists holdings across a fresh instance", () => {
    const store1 = freshStore();
    store1.recordMint({ chainKey: "robinhood", nftContract: NFT, quantity: 4, wallets: [W1], txHash: "0xa" });
    const store2 = new TelegramStore(tmpFile, "test-pass");
    expect(store2.listMints()[0].quantity).toBe(4);
  });
});

describe("TelegramStore settings", () => {
  it("returns sane defaults when nothing has been set", () => {
    const store = freshStore();
    const s = store.getSettings();
    expect(s.chainKey).toBe("base");
    expect(s.autoEnabled).toBe(false);
    expect(s.copyMintEnabled).toBe(false);
  });

  it("merges a partial update without clobbering other fields", () => {
    const store = freshStore();
    store.updateSettings({ chainKey: "ethereum" });
    const s = store.updateSettings({ autoEnabled: true });
    expect(s.chainKey).toBe("ethereum");
    expect(s.autoEnabled).toBe(true);
  });

  it("persists settings across a fresh instance", () => {
    const store1 = freshStore();
    store1.updateSettings({ maxFeeGwei: 12.5 });
    const store2 = new TelegramStore(tmpFile, "test-pass");
    expect(store2.getSettings().maxFeeGwei).toBe(12.5);
  });
});

describe("TelegramStore copy-mint history", () => {
  const NFT = "0x1111111111111111111111111111111111111111";
  const SRC_A = "0xaaaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
  const SRC_B = "0xbbbBbBbbBbBbBbbBbBBBBBBBBbbbBbBbBbbBbbBb";

  const attempt = (over: Partial<Parameters<TelegramStore["recordCopyAttempt"]>[0]> = {}) => ({
    chainKey: "robinhood",
    sourceWallet: SRC_A,
    nftContract: NFT,
    quantity: 1,
    outcome: "success" as const,
    txHashes: ["0xtx"],
    ...over,
  });

  it("records every outcome, not just successes", () => {
    const store = freshStore();
    store.recordCopyAttempt(attempt({ outcome: "success" }));
    store.recordCopyAttempt(attempt({ outcome: "failed", reason: "no receipt" }));
    store.recordCopyAttempt(attempt({ outcome: "skipped", reason: "price exceeds cap" }));

    const all = store.listCopyAttempts();
    expect(all).toHaveLength(3);
    expect(all.map((a) => a.outcome).sort()).toEqual(["failed", "skipped", "success"]);
    // The reason is the point of recording a non-success at all.
    expect(all.find((a) => a.outcome === "skipped")!.reason).toBe("price exceeds cap");
  });

  it("stamps each attempt with a time", () => {
    const store = freshStore();
    const before = Date.now();
    const rec = store.recordCopyAttempt(attempt());
    expect(rec.at).toBeGreaterThanOrEqual(before);
  });

  it("filters by the watched wallet that triggered the copy", () => {
    const store = freshStore();
    store.recordCopyAttempt(attempt({ sourceWallet: SRC_A }));
    store.recordCopyAttempt(attempt({ sourceWallet: SRC_B }));
    store.recordCopyAttempt(attempt({ sourceWallet: SRC_B }));

    expect(store.listCopyAttempts(SRC_A)).toHaveLength(1);
    expect(store.listCopyAttempts(SRC_B)).toHaveLength(2);
    expect(store.listCopyAttempts()).toHaveLength(3);
  });

  it("matches the source wallet case-insensitively", () => {
    const store = freshStore();
    store.recordCopyAttempt(attempt({ sourceWallet: SRC_A }));
    expect(store.listCopyAttempts(SRC_A.toUpperCase())).toHaveLength(1);
  });

  it("lists newest first", () => {
    const store = freshStore();
    store.recordCopyAttempt(attempt({ nftContract: "0x1" }));
    store.recordCopyAttempt(attempt({ nftContract: "0x2" }));
    expect(store.listCopyAttempts()[0].nftContract).toBe("0x2");
  });

  it("reports the wallets that appear in history, even once un-watched", () => {
    const store = freshStore();
    store.recordCopyAttempt(attempt({ sourceWallet: SRC_A }));
    store.recordCopyAttempt(attempt({ sourceWallet: SRC_B }));
    store.recordCopyAttempt(attempt({ sourceWallet: SRC_A }));
    expect(store.listCopyHistoryWallets().sort()).toEqual([SRC_A, SRC_B].sort());
  });

  it("keeps history bounded, discarding the oldest", () => {
    const store = freshStore();
    for (let i = 0; i < 520; i++) store.recordCopyAttempt(attempt({ nftContract: `0x${i}` }));
    const all = store.listCopyAttempts();
    expect(all.length).toBeLessThanOrEqual(500);
    // Newest survived, oldest did not.
    expect(all[0].nftContract).toBe("0x519");
    expect(all.some((a) => a.nftContract === "0x0")).toBe(false);
  });

  it("clears history on request", () => {
    const store = freshStore();
    store.recordCopyAttempt(attempt());
    store.clearCopyHistory();
    expect(store.listCopyAttempts()).toEqual([]);
  });

  it("persists history across a fresh instance", () => {
    const store1 = freshStore();
    store1.recordCopyAttempt(attempt({ outcome: "failed", reason: "gas" }));
    const store2 = new TelegramStore(tmpFile, "test-pass");
    expect(store2.listCopyAttempts()[0].reason).toBe("gas");
  });
});
