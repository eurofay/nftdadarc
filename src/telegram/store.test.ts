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
