import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Wallet } from "ethers";
import { TelegramStore } from "./store";
import { deriveWallets } from "../hd-wallet";

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

describe("TelegramStore renameWallet", () => {
  it("changes the label", () => {
    const store = freshStore();
    const added = store.addWallet("main", TEST_KEY_1);
    const renamed = store.renameWallet(added.address, "cold storage");
    expect(renamed?.label).toBe("cold storage");
    expect(store.listWallets()[0].label).toBe("cold storage");
  });

  it("keeps the key and address untouched", () => {
    // A rename must never be able to lose access to a funded wallet.
    const store = freshStore();
    const added = store.addWallet("main", TEST_KEY_1);
    store.renameWallet(added.address, "renamed");
    expect(store.listWallets()[0].address).toBe(added.address);
    expect(store.getDecryptedKey(added.address)).toBe(TEST_KEY_1);
  });

  it("matches the address regardless of case", () => {
    const store = freshStore();
    const added = store.addWallet("main", TEST_KEY_1);
    expect(store.renameWallet(added.address.toLowerCase(), "lower")?.label).toBe("lower");
  });

  it("returns null for a wallet that is not there", () => {
    const store = freshStore();
    expect(store.renameWallet(new Wallet(TEST_KEY_2).address, "ghost")).toBe(null);
  });

  it("falls back to the address stub rather than leaving a blank button", () => {
    const store = freshStore();
    const added = store.addWallet("main", TEST_KEY_1);
    expect(store.renameWallet(added.address, "   ")?.label).toBe(added.address.slice(0, 8));
  });

  it("trims surrounding whitespace", () => {
    const store = freshStore();
    const added = store.addWallet("main", TEST_KEY_1);
    expect(store.renameWallet(added.address, "  spaced  ")?.label).toBe("spaced");
  });

  it("caps a very long name, which would otherwise break every keyboard", () => {
    const store = freshStore();
    const added = store.addWallet("main", TEST_KEY_1);
    const renamed = store.renameWallet(added.address, "x".repeat(500));
    expect(renamed!.label.length).toBeLessThanOrEqual(40);
  });

  it("persists across a reload", () => {
    const store = freshStore();
    const added = store.addWallet("main", TEST_KEY_1);
    store.renameWallet(added.address, "kept");
    const reopened = new TelegramStore(tmpFile, "test-pass");
    expect(reopened.listWallets()[0].label).toBe("kept");
  });

  it("leaves other wallets alone", () => {
    const store = freshStore();
    const a = store.addWallet("first", TEST_KEY_1);
    store.addWallet("second", TEST_KEY_2);
    store.renameWallet(a.address, "changed");
    expect(store.listWallets().map((w) => w.label).sort()).toEqual(["changed", "second"]);
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
    // Auto mint fires on ANY free drop, so it stays opt-in. Copy mint only
    // acts on wallets the user chose to follow, and the point of the bot is
    // that it copies without being asked each time — so it starts on.
    expect(s.autoEnabled).toBe(false);
    expect(s.copyMintEnabled).toBe(true);
    // A copy signal is only worth acting on immediately; a stage seen hours
    // ago has usually moved on, and re-minting it is arriving late.
    expect(s.copyBackfillHours).toBe(0);
  });

  it("remembers a deliberate turn-off across a restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copyoff-"));
    const file = path.join(dir, "s.json");
    new TelegramStore(file, "pass").updateSettings({ copyMintEnabled: false });
    // "On by default" must not mean "back on every restart" — that would
    // override the one thing the user explicitly asked for.
    expect(new TelegramStore(file, "pass").getSettings().copyMintEnabled).toBe(false);
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

describe("save durability", () => {
  it("leaves no partial file behind, and no temp files after a write", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-atomic-"));
    try {
      const file = path.join(dir, "s.json");
      const store = new TelegramStore(file, "pass");
      store.addWallet("a", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
      store.addWallet("b", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

      // A temp file surviving the write would be a leak, and on a restart loop
      // would accumulate one per crash.
      expect(fs.readdirSync(dir)).toEqual(["s.json"]);
      // Whole-file readable, not truncated.
      expect(() => JSON.parse(fs.readFileSync(file, "utf8"))).not.toThrow();
      expect(new TelegramStore(file, "pass").listWallets()).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the previous good file when a write fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-atomic-"));
    try {
      const file = path.join(dir, "s.json");
      const store = new TelegramStore(file, "pass");
      store.addWallet("keeper", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
      const good = fs.readFileSync(file, "utf8");

      const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
        throw new Error("disk full");
      });
      expect(() =>
        store.addWallet("doomed", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
      ).toThrow(/disk full/);
      spy.mockRestore();

      // The old contents are intact and nothing was left half-written.
      expect(fs.readFileSync(file, "utf8")).toBe(good);
      expect(fs.readdirSync(dir)).toEqual(["s.json"]);
      expect(new TelegramStore(file, "pass").listWallets().map((w) => w.label)).toEqual(["keeper"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scheduled mints", () => {
  const base = {
    chainKey: "robinhood",
    nftContract: "0x922fd5da48db5d65da7804d1bb12712311 13e5b5".replace(/ /g, ""),
    quantity: 2,
    wallets: ["0xE607f2b18daE93e1f5D4c5a5C71b1d1070823ba0"],
    targetStartMs: Date.now() + 3_600_000,
  };

  function fresh(): TelegramStore {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
    return new TelegramStore(path.join(dir, "s.json"), "pass");
  }

  it("survives a restart — the whole reason it's persisted", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
    const file = path.join(dir, "s.json");
    const id = new TelegramStore(file, "pass").addScheduled(base).id;
    // A redeploy mid-wait used to drop this entirely.
    const after = new TelegramStore(file, "pass").listPendingScheduled();
    expect(after.map((r) => r.id)).toEqual([id]);
  });

  it("starts pending and carries the label fields for a readable notice", () => {
    const store = fresh();
    const rec = store.addScheduled({ ...base, name: "GOAT STATE", slug: "goat-state" });
    expect(rec.status).toBe("pending");
    expect(rec.name).toBe("GOAT STATE");
    expect(rec.slug).toBe("goat-state");
  });

  it("lists soonest first, so the next one to fire is obvious", () => {
    const store = fresh();
    const later = store.addScheduled({ ...base, targetStartMs: 3000 });
    const sooner = store.addScheduled({ ...base, targetStartMs: 1000 });
    expect(store.listScheduled().map((r) => r.id)).toEqual([sooner.id, later.id]);
  });

  it("drops fired and failed ones from the pending set", () => {
    const store = fresh();
    const a = store.addScheduled(base);
    const b = store.addScheduled(base);
    store.updateScheduled(a.id, { status: "fired", note: "1 wallet(s) minted" });
    expect(store.listPendingScheduled().map((r) => r.id)).toEqual([b.id]);
    expect(store.listScheduled()).toHaveLength(2); // history is kept
  });

  it("records why one failed, so the chat message isn't the only trace", () => {
    const store = fresh();
    const rec = store.addScheduled(base);
    store.updateScheduled(rec.id, { status: "failed", note: "missed while the bot was offline" });
    expect(store.listScheduled()[0].note).toMatch(/offline/);
  });

  it("can be cancelled before it fires", () => {
    const store = fresh();
    const rec = store.addScheduled(base);
    expect(store.removeScheduled(rec.id)).toBe(true);
    expect(store.listPendingScheduled()).toEqual([]);
    expect(store.removeScheduled(rec.id)).toBe(false);
  });

  it("reports an unknown id rather than pretending it updated", () => {
    expect(fresh().updateScheduled("nope", { status: "fired" })).toBeNull();
  });
});

describe("seed phrases", () => {
  const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  function fresh(): { store: TelegramStore; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
    const file = path.join(dir, "s.json");
    return { store: new TelegramStore(file, "pass"), file };
  }

  it("stores the phrase encrypted, never in the clear", () => {
    const { store, file } = fresh();
    store.addSeed(PHRASE);
    // The whole file is on a volume that gets backed up; a plaintext phrase
    // there would control every wallet derived from it.
    expect(fs.readFileSync(file, "utf8")).not.toContain("abandon");
  });

  it("reads the phrase back — the reason it's stored at all", () => {
    const { store } = fresh();
    const rec = store.addSeed(PHRASE);
    expect(store.getDecryptedSeed(rec.id)).toBe(PHRASE);
  });

  it("survives a restart", () => {
    const { store, file } = fresh();
    const id = store.addSeed(PHRASE).id;
    expect(new TelegramStore(file, "pass").getDecryptedSeed(id)).toBe(PHRASE);
  });

  it("links wallets to the seed they came from, in derivation order", () => {
    const { store } = fresh();
    const seed = store.addSeed(PHRASE);
    for (const w of deriveWallets(PHRASE, 3)) {
      store.addWallet(`seed-${w.index}`, w.privateKey, { seedId: seed.id, derivationIndex: w.index });
    }
    const linked = store.walletsFromSeed(seed.id);
    expect(linked).toHaveLength(3);
    expect(linked.map((w) => w.derivationIndex)).toEqual([0, 1, 2]);
  });

  it("keeps a pasted wallet unlinked, so it isn't claimed by a seed", () => {
    const { store } = fresh();
    store.addSeed(PHRASE);
    store.addWallet("pasted", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    expect(store.listWallets()[0].seedId).toBeUndefined();
  });

  it("refuses an unknown id rather than returning something wrong", () => {
    expect(() => fresh().store.getDecryptedSeed("nope")).toThrow(/No seed phrase/);
  });

  it("can be deleted", () => {
    const { store } = fresh();
    const rec = store.addSeed(PHRASE);
    expect(store.removeSeed(rec.id)).toBe(true);
    expect(store.listSeeds()).toEqual([]);
    expect(store.removeSeed(rec.id)).toBe(false);
  });
});

describe("backup and restore", () => {
  const KEY_A = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const KEY_B = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  function at(dir: string, pass = "pass"): TelegramStore {
    return new TelegramStore(path.join(dir, "s.json"), pass);
  }
  function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "backup-"));
  }

  it("round-trips wallets, targets and history to a new install", () => {
    const a = tmp();
    const source = at(a);
    source.addWallet("one", KEY_A);
    source.addCopyTarget("whale", "0x3A24615eED0dA3821409d3aCB22643B9b43F9Fae");
    source.addSeed(PHRASE);
    const snapshot = source.exportSnapshot();

    // A different directory, same encryption key — the migration case.
    const restored = at(tmp());
    const result = restored.importSnapshot(snapshot);

    expect(result.wallets).toBe(1);
    expect(restored.listWallets()[0].address).toBe(source.listWallets()[0].address);
    expect(restored.listCopyTargets()).toHaveLength(1);
    expect(restored.getDecryptedSeed(restored.listSeeds()[0].id)).toBe(PHRASE);
  });

  it("keeps the keys usable, which is the only thing that really matters", () => {
    const source = at(tmp());
    source.addWallet("one", KEY_A);
    const restored = at(tmp());
    restored.importSnapshot(source.exportSnapshot());

    const address = restored.listWallets()[0].address;
    expect(new Wallet(restored.getDecryptedKey(address)).address).toBe(address);
  });

  it("refuses a backup encrypted with a different key, and changes nothing", () => {
    // The failure this exists to prevent: the file parses, looks healthy, and
    // every wallet in it is unspendable. It would only surface at mint time.
    const foreign = at(tmp(), "a-different-encryption-key");
    foreign.addWallet("theirs", KEY_A);

    const mine = at(tmp());
    mine.addWallet("mine", KEY_B);
    const before = mine.listWallets()[0].address;

    expect(() => mine.importSnapshot(foreign.exportSnapshot())).toThrow(/different WALLET_ENCRYPTION_KEY/);
    expect(mine.listWallets()[0].address).toBe(before);
  });

  it("refuses a key that doesn't control the address it's filed under", () => {
    const source = at(tmp());
    source.addWallet("one", KEY_A);
    const tampered = JSON.parse(source.exportSnapshot());
    tampered.wallets[0].address = new Wallet(KEY_B).address;

    expect(() => at(tmp()).importSnapshot(JSON.stringify(tampered))).toThrow(/doesn't control it/);
  });

  it("rejects junk rather than wiping the store with it", () => {
    const store = at(tmp());
    store.addWallet("keeper", KEY_A);
    expect(() => store.importSnapshot("not json at all")).toThrow(/valid JSON/);
    expect(() => store.importSnapshot('{"hello":"world"}')).toThrow(/doesn't look like a backup/);
    expect(store.listWallets()).toHaveLength(1);
  });

  it("keeps the replaced store on disk, so a wrong restore isn't final", () => {
    const dir = tmp();
    const store = at(dir);
    store.addWallet("original", KEY_A);

    const other = at(tmp());
    other.addWallet("incoming", KEY_B);
    store.importSnapshot(other.exportSnapshot());

    const backup = path.join(dir, "s.json.pre-restore");
    expect(fs.existsSync(backup)).toBe(true);
    expect(JSON.parse(fs.readFileSync(backup, "utf8")).wallets[0].label).toBe("original");
  });

  it("reports what it replaced, so the message can say what was lost", () => {
    const store = at(tmp());
    store.addWallet("a", KEY_A);
    const other = at(tmp());
    other.addWallet("b", KEY_B);
    expect(store.importSnapshot(other.exportSnapshot()).replaced).toBe(1);
  });

  it("survives a restart after restoring", () => {
    const dir = tmp();
    const source = at(tmp());
    source.addWallet("one", KEY_A);
    at(dir).importSnapshot(source.exportSnapshot());
    expect(at(dir).listWallets()).toHaveLength(1);
  });
});
