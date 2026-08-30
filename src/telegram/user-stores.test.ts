import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Wallet } from "ethers";
import { UserStores } from "./user-stores";
import { TelegramStore } from "./store";

const PASS = "test-passphrase-not-a-real-key";
const KEY_A = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const KEY_B = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "userstores-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("UserStores isolation", () => {
  it("never shows one user's wallets to another", () => {
    const stores = new UserStores(dir, PASS);
    stores.for(111).addWallet("mine", KEY_A.privateKey);
    stores.for(222).addWallet("theirs", KEY_B.privateKey);

    expect(stores.for(111).listWallets().map((w) => w.address)).toEqual([KEY_A.address]);
    expect(stores.for(222).listWallets().map((w) => w.address)).toEqual([KEY_B.address]);
  });

  it("keeps watchlists and settings separate too", () => {
    const stores = new UserStores(dir, PASS);
    stores.for(111).addCopyTarget("a", KEY_A.address);
    stores.for(111).updateSettings({ copyMintMaxPriceEth: 0.05 });

    expect(stores.for(222).listCopyTargets()).toEqual([]);
    expect(stores.for(222).getSettings().copyMintMaxPriceEth).not.toBe(0.05);
  });

  it("writes one file per user, so a bad write can't cost everyone", () => {
    const stores = new UserStores(dir, PASS);
    stores.for(111).addWallet("", KEY_A.privateKey);
    stores.for(222).addWallet("", KEY_B.privateKey);
    expect(stores.listUserIds()).toEqual([111, 222]);
    expect(fs.existsSync(path.join(dir, "users", "111.json"))).toBe(true);
  });

  it("returns the same instance per user, so writes aren't lost to a stale copy", () => {
    const stores = new UserStores(dir, PASS);
    expect(stores.for(111)).toBe(stores.for(111));
  });

  it("survives a reload from disk", () => {
    new UserStores(dir, PASS).for(111).addWallet("", KEY_A.privateKey);
    const reopened = new UserStores(dir, PASS);
    expect(reopened.for(111).listWallets()).toHaveLength(1);
    expect(reopened.for(222).listWallets()).toHaveLength(0);
  });

  it("refuses an id that isn't a plain positive integer", () => {
    const stores = new UserStores(dir, PASS);
    // The id builds a file path and arrives from outside, so it is validated
    // rather than sanitised into something that merely looks safe.
    for (const bad of [0, -1, 1.5, NaN, Infinity, "../../etc/passwd" as unknown as number]) {
      expect(() => stores.for(bad as number)).toThrow(/invalid user id/i);
    }
    expect(fs.readdirSync(path.join(dir, "users"))).toEqual([]);
  });
});

describe("UserStores.migrateLegacy", () => {
  it("moves a single-owner store to its owner without disturbing others", () => {
    const legacy = path.join(dir, "telegram-store.json");
    new TelegramStore(legacy, PASS).addWallet("legacy", KEY_A.privateKey);

    const stores = new UserStores(dir, PASS);
    expect(stores.migrateLegacy(legacy, 999)).toBe(true);
    expect(stores.for(999).listWallets().map((w) => w.address)).toEqual([KEY_A.address]);
    expect(stores.for(111).listWallets()).toEqual([]);
  });

  it("is a no-op when the owner already has a store, rather than clobbering it", () => {
    const legacy = path.join(dir, "telegram-store.json");
    new TelegramStore(legacy, PASS).addWallet("legacy", KEY_A.privateKey);

    const stores = new UserStores(dir, PASS);
    stores.for(999).addWallet("already here", KEY_B.privateKey);

    expect(stores.migrateLegacy(legacy, 999)).toBe(false);
    expect(stores.for(999).listWallets().map((w) => w.address)).toEqual([KEY_B.address]);
    expect(fs.existsSync(legacy)).toBe(true); // left for a human to inspect
  });

  it("does nothing when there is no legacy store", () => {
    const stores = new UserStores(dir, PASS);
    expect(stores.migrateLegacy(path.join(dir, "nope.json"), 999)).toBe(false);
  });
});
