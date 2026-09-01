import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Wallet } from "ethers";
import { resolveAccess } from "./bot";
import { UserStores } from "./user-stores";

// The rule that keeps one user out of another's wallets. The bot holds other
// people's private keys, so this boundary carries real money and is asserted
// directly rather than through Telegraf's update plumbing.

const PASS = "test-passphrase-not-a-real-key";
const KEY_A = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const KEY_B = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

let dir: string;
let stores: UserStores;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "access-"));
  stores = new UserStores(dir, PASS);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("resolveAccess", () => {
  it("hands each user their own store, never a shared one", () => {
    stores.for(111).addWallet("alice", KEY_A.privateKey);
    stores.for(222).addWallet("bob", KEY_B.privateKey);

    const alice = resolveAccess("private", 111, stores);
    const bob = resolveAccess("private", 222, stores);
    expect(alice.allowed && bob.allowed).toBe(true);
    if (!alice.allowed || !bob.allowed) throw new Error("unreachable");

    expect(alice.store.listWallets().map((w) => w.label)).toEqual(["alice"]);
    expect(bob.store.listWallets().map((w) => w.label)).toEqual(["bob"]);
    expect(alice.store).not.toBe(bob.store);
  });

  it("gives a brand-new user an empty store, not someone else's", () => {
    stores.for(111).addWallet("alice", KEY_A.privateKey);
    const newcomer = resolveAccess("private", 333, stores);
    expect(newcomer.allowed).toBe(true);
    if (!newcomer.allowed) throw new Error("unreachable");
    expect(newcomer.store.listWallets()).toEqual([]);
  });

  it("refuses group chats, where members would share whoever resolved first", () => {
    for (const type of ["group", "supergroup", "channel"]) {
      const access = resolveAccess(type, 111, stores);
      expect(access.allowed).toBe(false);
    }
  });

  it("refuses an update with no user id", () => {
    expect(resolveAccess("private", undefined, stores).allowed).toBe(false);
  });

  it("refuses an id that can't safely become a file path", () => {
    for (const bad of [0, -1, 1.5, NaN, "../../etc/passwd" as unknown as number]) {
      expect(resolveAccess("private", bad as number, stores).allowed).toBe(false);
    }
    expect(fs.readdirSync(path.join(dir, "users"))).toEqual([]);
  });

  it("is stable across calls, so a user's writes aren't split over two copies", () => {
    const a = resolveAccess("private", 111, stores);
    const b = resolveAccess("private", 111, stores);
    expect(a.allowed && b.allowed && a.store === b.store).toBe(true);
  });
});
