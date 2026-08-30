// Per-user stores: one encrypted file per Telegram user.
//
// The bot began as a single-owner tool with one store. Serving other people
// means each user's wallets, watchlist, settings and history must be reachable
// ONLY by that user — this file is the boundary that guarantees it. Everything
// downstream keeps using TelegramStore unchanged; the only new idea is which
// store a request is allowed to touch.
//
// A file per user rather than one shared file with a users map: a corrupt
// write, a bad migration or an accidental dump costs one person's data instead
// of everyone's, and there is no code path where the wrong branch of an
// in-memory object is served to the wrong caller.

import fs from "fs";
import path from "path";
import { TelegramStore } from "./store";

export class UserStores {
  private readonly dir: string;
  private readonly passphrase: string;
  private readonly cache = new Map<number, TelegramStore>();

  constructor(dataDir: string, passphrase: string) {
    this.dir = path.join(dataDir, "users");
    this.passphrase = passphrase;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * The store belonging to this user, created on first use.
   *
   * The id is validated rather than trusted: it reaches us from Telegram and
   * is used to build a path, so anything but a plain positive integer is
   * refused outright instead of being sanitised into something plausible.
   */
  for(userId: number): TelegramStore {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new Error(`Refusing to open a store for an invalid user id: ${userId}`);
    }
    const cached = this.cache.get(userId);
    if (cached) return cached;

    const store = new TelegramStore(this.pathFor(userId), this.passphrase);
    this.cache.set(userId, store);
    return store;
  }

  /** Every user who has ever had a store written. */
  listUserIds(): number[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => /^\d+\.json$/.test(f))
      .map((f) => Number(f.replace(/\.json$/, "")))
      .filter((id) => Number.isSafeInteger(id) && id > 0)
      .sort((a, b) => a - b);
  }

  /**
   * Move a pre-multi-user store to its owner. Returns true if it moved one.
   *
   * Copies rather than renames, and never overwrites: if the owner already has
   * a per-user store, the legacy file is left untouched for a human to look at
   * rather than silently clobbering whichever copy is newer.
   */
  migrateLegacy(legacyFile: string, ownerId: number): boolean {
    if (!fs.existsSync(legacyFile)) return false;
    const target = this.pathFor(ownerId);
    if (fs.existsSync(target)) return false;
    fs.copyFileSync(legacyFile, target);
    this.cache.delete(ownerId); // force a reload from the migrated file
    return true;
  }

  private pathFor(userId: number): string {
    return path.join(this.dir, `${userId}.json`);
  }
}
