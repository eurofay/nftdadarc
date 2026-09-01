// Persisted state for the Telegram bot: wallets (key encrypted at rest —
// see crypto.ts), a copy-mint watchlist, and settings. One JSON file on disk,
// git-ignored, since this is a single-owner bot with no concurrent writers.

import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { Wallet } from "ethers";
import { encrypt, decrypt } from "./crypto";

export interface WalletRecord {
  label: string;
  address: string;
  encryptedKey: string;
  addedAt: number;
  /** Set when this wallet was derived from a stored seed phrase. */
  seedId?: string;
  derivationIndex?: number;
  // Per-wallet opt-in for the two "use every added wallet" watchers. Default
  // true when unset, so existing wallets keep today's behavior until someone
  // deliberately excludes one — named to avoid colliding with
  // BotSettings.copyMintEnabled, which means "is the watcher currently
  // running", a different concept from "does this wallet participate".
  includeInAutoMint?: boolean;
  includeInCopyMint?: boolean;
}

export interface CopyTarget {
  label: string;
  address: string;
  addedAt: number;
}

// One row per collection actually minted (confirmed on-chain), not per token
// — the portfolio view is about "which collections am I in", and quantity
// accumulates as more mints land.
export interface MintRecord {
  chainKey: string;
  nftContract: string;
  slug?: string; // resolved from OpenSea when available; absent for unindexed collections
  name?: string;
  quantity: number;
  wallets: string[];
  lastTxHash: string;
  firstMintedAt: number;
  lastMintedAt: number;
}

// One row per copy-mint attempt, whatever came of it. Skips and failures are
// as interesting as successes here — "why didn't it copy that one" is the
// question this history exists to answer.
export type CopyAttemptOutcome = "success" | "failed" | "skipped";

export interface CopyMintAttempt {
  at: number;
  chainKey: string;
  sourceWallet: string; // the watched wallet whose mint triggered this
  sourceTxHash?: string;
  nftContract: string;
  slug?: string;
  name?: string;
  quantity: number;
  outcome: CopyAttemptOutcome;
  reason?: string; // why it was skipped, or how it failed
  txHashes: string[];
}

// Bounded so a long-running bot can't grow the store without limit.
const MAX_COPY_HISTORY = 500;

export interface BotSettings {
  chainKey: string; // the single chain used by /mint, Fund Wallets, and Copy Mint
  maxFeeGwei: number;
  priorityGwei: number;
  // 0 means "size it from the quantity being minted" (see gas.ts). A fixed
  // number over-reserves for a small mint and runs out of gas on a large one.
  gasLimit: number;
  autoEnabled: boolean;
  autoMaxQuantity?: number;
  // Which chain(s) Auto Mint watches — independent of chainKey, since this
  // is the one feature that makes sense to run on several chains at once
  // (one runAutoMintWatcher instance per chain, same as CLI's AUTO_CHAIN
  // comma-list). Empty/unset means "just chainKey", so existing setups
  // don't change behavior until this is deliberately turned into a list.
  autoChainKeys?: string[];
  copyMintEnabled: boolean;
  // Copy-mint isn't restricted to free drops, so this is the one guardrail
  // against blindly following a watched wallet into an expensive mint.
  copyMintMaxPriceEth: number;
  // Hours of history the copy watcher scans on startup. Drops it follows
  // routinely stay open for days, so a mint seen this morning is usually
  // still mintable — starting at the chain head threw those away.
  copyBackfillHours: number;
  // Caps quantity per wallet the same way autoMaxQuantity does for Auto
  // Mint — capped at whichever is smaller, this or the drop's own max, so
  // a huge per-wallet allowance (e.g. 4000) doesn't burn far more gas than
  // intended just because nothing here says otherwise.
  copyMintMaxQuantity?: number;
  // Activity watcher — alerts on sweeps/floor moves/offers for held collections.
  activityEnabled: boolean;
  activitySweepSales: number;
  activityFloorMovePct: number;
  activityOfferVsFloorPct: number;
}

/**
 * A mint armed for a future stage opening.
 *
 * Persisted because the wait is long — hours, usually — and a redeploy or a
 * crash in the middle of it must not silently drop the mint the user is
 * counting on. On boot every pending record is re-armed.
 */
export interface ScheduledMint {
  id: string;
  chainKey: string;
  nftContract: string;
  name?: string;
  slug?: string;
  quantity: number;
  wallets: string[];
  targetStartMs: number;
  createdAt: number;
  status: "pending" | "fired" | "failed" | "cancelled";
  note?: string;
}

/**
 * A stored seed phrase.
 *
 * Originally the phrase was shown once and never persisted, on the reasoning
 * that one stolen string controls every wallet derived from it. That reasoning
 * still holds — but it made the phrase useless as a backup, which is the only
 * thing a phrase is FOR. A phrase you cannot re-read is strictly worse than
 * the private keys sitting next to it, which were always stored.
 *
 * So it is kept, encrypted with the same key as those private keys, and shown
 * only on an explicit request that says plainly what it exposes.
 */
export interface SeedRecord {
  id: string;
  encryptedPhrase: string;
  label?: string;
  createdAt: number;
}

interface StoreData {
  seeds: SeedRecord[];
  scheduled: ScheduledMint[];
  wallets: WalletRecord[];
  copyTargets: CopyTarget[];
  mints: MintRecord[];
  copyHistory: CopyMintAttempt[];
  settings: BotSettings;
}

const DEFAULT_SETTINGS: BotSettings = {
  chainKey: "base",
  maxFeeGwei: 2,
  priorityGwei: 0.05,
  gasLimit: 250_000,
  autoEnabled: false,
  // On by default: the whole point of the bot is that it copies without being
  // asked each time. Turning it off is a deliberate act and is remembered.
  copyMintEnabled: true,
  copyMintMaxPriceEth: 0,
  copyBackfillHours: 12,
  activityEnabled: true,
  activitySweepSales: 3,
  activityFloorMovePct: 15,
  activityOfferVsFloorPct: 80,
};

export class TelegramStore {
  private filePath: string;
  private passphrase: string;
  private data: StoreData;

  constructor(filePath: string, passphrase: string) {
    this.filePath = filePath;
    this.passphrase = passphrase;
    this.data = this.load();
  }

  private load(): StoreData {
    if (!fs.existsSync(this.filePath)) {
      return { seeds: [], scheduled: [], wallets: [], copyTargets: [], mints: [], copyHistory: [], settings: { ...DEFAULT_SETTINGS } };
    }
    const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    return {
      wallets: raw.wallets ?? [],
      copyTargets: raw.copyTargets ?? [],
      mints: raw.mints ?? [],
      copyHistory: raw.copyHistory ?? [],
      seeds: raw.seeds ?? [],
      scheduled: raw.scheduled ?? [],
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    };
  }

  // Written to a temp file, flushed, then renamed over the target. rename is
  // atomic within a filesystem, so a reader either sees the whole old file or
  // the whole new one — never a half-written one.
  //
  // Writing straight to the target was fine on a laptop and is not fine on a
  // host that restarts: a SIGTERM landing mid-write leaves the file truncated,
  // and a truncated store is every private key in it gone. Redeploys make that
  // an ordinary event rather than a freak one.
  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(this.data, null, 2);
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmp, "w", 0o600);
      fs.writeFileSync(fd, payload);
      // Without the flush the rename can land while the contents are still in
      // the OS cache, which on a hard stop leaves an empty file in place.
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* already closing on the error path */ }
      }
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
      throw err;
    }
  }

  // ── Wallets ──────────────────────────────────────────────────────────
  addWallet(
    label: string,
    privateKey: string,
    origin?: { seedId: string; derivationIndex: number }
  ): WalletRecord {
    const wallet = new Wallet(privateKey); // throws on a malformed key — validate before ever persisting
    if (this.data.wallets.some((w) => w.address.toLowerCase() === wallet.address.toLowerCase())) {
      throw new Error(`Wallet ${wallet.address} is already added.`);
    }
    const record: WalletRecord = {
      label: label || wallet.address.slice(0, 8),
      address: wallet.address,
      encryptedKey: encrypt(privateKey, this.passphrase),
      addedAt: Date.now(),
      seedId: origin?.seedId,
      derivationIndex: origin?.derivationIndex,
    };
    this.data.wallets.push(record);
    this.save();
    return record;
  }

  removeWallet(address: string): boolean {
    const before = this.data.wallets.length;
    this.data.wallets = this.data.wallets.filter((w) => w.address.toLowerCase() !== address.toLowerCase());
    const removed = this.data.wallets.length !== before;
    if (removed) this.save();
    return removed;
  }

  listWallets(): WalletRecord[] {
    return [...this.data.wallets];
  }

  // Flips includeInAutoMint / includeInCopyMint for one wallet.
  setWalletInclusion(address: string, feature: "auto" | "copy", included: boolean): WalletRecord {
    const record = this.data.wallets.find((w) => w.address.toLowerCase() === address.toLowerCase());
    if (!record) throw new Error(`No wallet stored for ${address}.`);
    if (feature === "auto") record.includeInAutoMint = included;
    else record.includeInCopyMint = included;
    this.save();
    return record;
  }

  // Decrypted only at the point of use (signing), never logged or displayed.
  getDecryptedKeys(): string[] {
    return this.data.wallets.map((w) => decrypt(w.encryptedKey, this.passphrase));
  }

  getDecryptedKey(address: string): string {
    const record = this.data.wallets.find((w) => w.address.toLowerCase() === address.toLowerCase());
    if (!record) throw new Error(`No wallet stored for ${address}.`);
    return decrypt(record.encryptedKey, this.passphrase);
  }

  // Wallets opted into a given watcher — unset defaults to true, so existing
  // wallets keep today's "every wallet participates" behavior unchanged.
  listWalletsFor(feature: "auto" | "copy"): WalletRecord[] {
    const flag = feature === "auto" ? "includeInAutoMint" : "includeInCopyMint";
    return this.data.wallets.filter((w) => w[flag] !== false);
  }

  getDecryptedKeysFor(feature: "auto" | "copy"): string[] {
    return this.listWalletsFor(feature).map((w) => decrypt(w.encryptedKey, this.passphrase));
  }

  // ── Copy-mint watchlist ──────────────────────────────────────────────
  addCopyTarget(label: string, address: string): CopyTarget {
    if (this.data.copyTargets.some((t) => t.address.toLowerCase() === address.toLowerCase())) {
      throw new Error(`${address} is already on the copy-mint watchlist.`);
    }
    const target: CopyTarget = { label: label || address.slice(0, 8), address, addedAt: Date.now() };
    this.data.copyTargets.push(target);
    this.save();
    return target;
  }

  removeCopyTarget(address: string): boolean {
    const before = this.data.copyTargets.length;
    this.data.copyTargets = this.data.copyTargets.filter((t) => t.address.toLowerCase() !== address.toLowerCase());
    const removed = this.data.copyTargets.length !== before;
    if (removed) this.save();
    return removed;
  }

  // ── Seed phrases ─────────────────────────────────────────────────────
  addSeed(phrase: string, label?: string): SeedRecord {
    const record: SeedRecord = {
      id: randomBytes(4).toString("hex"),
      encryptedPhrase: encrypt(phrase, this.passphrase),
      label,
      createdAt: Date.now(),
    };
    this.data.seeds.push(record);
    this.save();
    return record;
  }

  listSeeds(): SeedRecord[] {
    return [...this.data.seeds].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Decrypts on demand — never held in the record the caller can log. */
  getDecryptedSeed(id: string): string {
    const record = this.data.seeds.find((s) => s.id === id);
    if (!record) throw new Error(`No seed phrase with id ${id}.`);
    return decrypt(record.encryptedPhrase, this.passphrase);
  }

  removeSeed(id: string): boolean {
    const before = this.data.seeds.length;
    this.data.seeds = this.data.seeds.filter((s) => s.id !== id);
    if (this.data.seeds.length === before) return false;
    this.save();
    return true;
  }

  /** Wallets derived from a given seed, in derivation order. */
  walletsFromSeed(seedId: string): WalletRecord[] {
    return this.data.wallets
      .filter((w) => w.seedId === seedId)
      .sort((a, b) => (a.derivationIndex ?? 0) - (b.derivationIndex ?? 0));
  }

  // ── Scheduled mints ──────────────────────────────────────────────────
  addScheduled(entry: Omit<ScheduledMint, "id" | "createdAt" | "status">): ScheduledMint {
    const record: ScheduledMint = {
      ...entry,
      id: randomBytes(4).toString("hex"),
      createdAt: Date.now(),
      status: "pending",
    };
    this.data.scheduled.push(record);
    this.save();
    return record;
  }

  listScheduled(): ScheduledMint[] {
    return [...this.data.scheduled].sort((a, b) => a.targetStartMs - b.targetStartMs);
  }

  /** Only the ones still waiting — what a restart needs to re-arm. */
  listPendingScheduled(): ScheduledMint[] {
    return this.listScheduled().filter((s) => s.status === "pending");
  }

  updateScheduled(id: string, patch: Partial<Pick<ScheduledMint, "status" | "note">>): ScheduledMint | null {
    const record = this.data.scheduled.find((s) => s.id === id);
    if (!record) return null;
    Object.assign(record, patch);
    this.save();
    return record;
  }

  removeScheduled(id: string): boolean {
    const before = this.data.scheduled.length;
    this.data.scheduled = this.data.scheduled.filter((s) => s.id !== id);
    if (this.data.scheduled.length === before) return false;
    this.save();
    return true;
  }

  listCopyTargets(): CopyTarget[] {
    return [...this.data.copyTargets];
  }

  // ── Minted holdings ──────────────────────────────────────────────────
  // Accumulates into one row per (chain, contract). Called only for mints
  // confirmed on-chain, so this reflects what was actually received.
  recordMint(entry: {
    chainKey: string;
    nftContract: string;
    quantity: number;
    wallets: string[];
    txHash: string;
    slug?: string;
    name?: string;
  }): MintRecord {
    const key = entry.nftContract.toLowerCase();
    let record = this.data.mints.find(
      (m) => m.nftContract.toLowerCase() === key && m.chainKey === entry.chainKey
    );
    const now = Date.now();

    if (record) {
      record.quantity += entry.quantity;
      record.wallets = [...new Set([...record.wallets, ...entry.wallets])];
      record.lastTxHash = entry.txHash;
      record.lastMintedAt = now;
      // Metadata may resolve on a later mint even if it didn't the first time.
      if (entry.slug && !record.slug) record.slug = entry.slug;
      if (entry.name && !record.name) record.name = entry.name;
    } else {
      record = {
        chainKey: entry.chainKey,
        nftContract: entry.nftContract,
        slug: entry.slug,
        name: entry.name,
        quantity: entry.quantity,
        wallets: [...new Set(entry.wallets)],
        lastTxHash: entry.txHash,
        firstMintedAt: now,
        lastMintedAt: now,
      };
      this.data.mints.push(record);
    }
    this.save();
    return record;
  }

  // ── Copy-mint history ────────────────────────────────────────────────
  recordCopyAttempt(entry: Omit<CopyMintAttempt, "at">): CopyMintAttempt {
    const record: CopyMintAttempt = { at: Date.now(), ...entry };
    this.data.copyHistory.push(record);
    // Keep the newest; trimming from the front drops the least useful rows.
    if (this.data.copyHistory.length > MAX_COPY_HISTORY) {
      this.data.copyHistory = this.data.copyHistory.slice(-MAX_COPY_HISTORY);
    }
    this.save();
    return record;
  }

  // Newest first. Pass a watched wallet to see only what it triggered.
  //
  // Two attempts can share a millisecond, and Date.now() then can't separate
  // them. Array.sort is stable, so reversing before sorting makes the later
  // *insertion* win a tie — which is what "newest" means here.
  listCopyAttempts(sourceWallet?: string): CopyMintAttempt[] {
    const all = [...this.data.copyHistory].reverse().sort((a, b) => b.at - a.at);
    if (!sourceWallet) return all;
    return all.filter((a) => a.sourceWallet.toLowerCase() === sourceWallet.toLowerCase());
  }

  // Wallets that actually appear in the history, so the menu can offer them
  // even after one has been removed from the live watchlist.
  listCopyHistoryWallets(): string[] {
    return [...new Set(this.data.copyHistory.map((a) => a.sourceWallet))];
  }

  clearCopyHistory(): void {
    this.data.copyHistory = [];
    this.save();
  }

  listMints(): MintRecord[] {
    // Same millisecond-tie reasoning as listCopyAttempts.
    return [...this.data.mints].reverse().sort((a, b) => b.lastMintedAt - a.lastMintedAt);
  }

  removeMint(nftContract: string): boolean {
    const before = this.data.mints.length;
    this.data.mints = this.data.mints.filter(
      (m) => m.nftContract.toLowerCase() !== nftContract.toLowerCase()
    );
    const removed = this.data.mints.length !== before;
    if (removed) this.save();
    return removed;
  }

  // ── Settings ─────────────────────────────────────────────────────────
  getSettings(): BotSettings {
    // load() already merges DEFAULT_SETTINGS over what's on disk, so a store
    // written before a setting existed answers with that setting's default.
    return { ...this.data.settings };
  }


  updateSettings(patch: Partial<BotSettings>): BotSettings {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.getSettings();
  }
}
