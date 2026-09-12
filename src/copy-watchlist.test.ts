import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramStore } from "./telegram/store";

// Recording a wallet in the alerts bot and then adding it to Copy Mint by hand
// is the same decision entered twice, and two lists drift the moment one is
// forgotten. copyWatchList is the single answer to "who is Copy Mint
// following", so nothing can disagree with anything else.

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
let dir: string;
let store: TelegramStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "copywatch-"));
  store = new TelegramStore(join(dir, "s.json"), "k".repeat(32));
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows holds handles */ }
});

describe("who Copy Mint follows", () => {
  it("is only the directly added ones by default", () => {
    store.addCopyTarget("hand", A);
    store.addSmartWallet({ address: B, label: "smart", addedAt: 1, chainKey: "robinhood" });
    expect(store.copyWatchList().map((t) => t.address)).toEqual([A]);
  });

  it("includes the smart wallets once switched on", () => {
    store.addCopyTarget("hand", A);
    store.addSmartWallet({ address: B, label: "smart", addedAt: 1, chainKey: "robinhood" });
    store.updateSettings({ copyFollowsSmart: true });
    expect(store.copyWatchList().map((t) => t.address).sort()).toEqual([A, B].sort());
  });

  it("does not list a wallet twice when it is on both lists", () => {
    store.addCopyTarget("hand", A);
    store.addSmartWallet({ address: A, label: "smart", addedAt: 1, chainKey: "robinhood" });
    store.updateSettings({ copyFollowsSmart: true });
    expect(store.copyWatchList()).toHaveLength(1);
  });

  it("keeps the label you chose over a generated one", () => {
    store.addCopyTarget("my-name", A);
    store.addSmartWallet({ address: A, label: "smart-1111", addedAt: 1, chainKey: "robinhood" });
    store.updateSettings({ copyFollowsSmart: true });
    expect(store.copyWatchList()[0].label).toBe("my-name");
  });

  it("carries the date a smart wallet was recorded, not the moment it was read", () => {
    // A synthesised "now" would make every smart wallet look freshly added
    // every time the list is opened.
    store.addSmartWallet({ address: B, label: "smart", addedAt: 12345, chainKey: "robinhood" });
    store.updateSettings({ copyFollowsSmart: true });
    expect(store.copyWatchList()[0].addedAt).toBe(12345);
  });

  it("still works with nothing added directly", () => {
    store.addSmartWallet({ address: B, label: "smart", addedAt: 1, chainKey: "robinhood" });
    store.updateSettings({ copyFollowsSmart: true });
    expect(store.copyWatchList()).toHaveLength(1);
  });
});
