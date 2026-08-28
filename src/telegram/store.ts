// Persisted state for the Telegram bot: wallets (key encrypted at rest —
// see crypto.ts), a copy-mint watchlist, and settings. One JSON file on disk,
// git-ignored, since this is a single-owner bot with no concurrent writers.

import fs from "fs";
import path from "path";
import { Wallet } from "ethers";
import { encrypt, decrypt } from "./crypto";

export interface WalletRecord {
  label: string;
  address: string;
  encryptedKey: string;
  addedAt: number;
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

export interface BotSettings {
  chainKey: string; // the single chain used by /mint, Fund Wallets, and Copy Mint
  maxFeeGwei: number;
  priorityGwei: number;
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

interface StoreData {
  wallets: WalletRecord[];
  copyTargets: CopyTarget[];
  mints: MintRecord[];
  settings: BotSettings;
}

const DEFAULT_SETTINGS: BotSettings = {
  chainKey: "base",
  maxFeeGwei: 2,
  priorityGwei: 0.05,
  gasLimit: 250_000,
  autoEnabled: false,
  copyMintEnabled: false,
  copyMintMaxPriceEth: 0,
  activityEnabled: false,
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
      return { wallets: [], copyTargets: [], mints: [], settings: { ...DEFAULT_SETTINGS } };
    }
    const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    return {
      wallets: raw.wallets ?? [],
      copyTargets: raw.copyTargets ?? [],
      mints: raw.mints ?? [],
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  // ── Wallets ──────────────────────────────────────────────────────────
  addWallet(label: string, privateKey: string): WalletRecord {
    const wallet = new Wallet(privateKey); // throws on a malformed key — validate before ever persisting
    if (this.data.wallets.some((w) => w.address.toLowerCase() === wallet.address.toLowerCase())) {
      throw new Error(`Wallet ${wallet.address} is already added.`);
    }
    const record: WalletRecord = {
      label: label || wallet.address.slice(0, 8),
      address: wallet.address,
      encryptedKey: encrypt(privateKey, this.passphrase),
      addedAt: Date.now(),
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

  listMints(): MintRecord[] {
    return [...this.data.mints].sort((a, b) => b.lastMintedAt - a.lastMintedAt);
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
    return { ...this.data.settings };
  }

  updateSettings(patch: Partial<BotSettings>): BotSettings {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.getSettings();
  }
}
