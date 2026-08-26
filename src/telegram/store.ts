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
}

export interface CopyTarget {
  label: string;
  address: string;
  addedAt: number;
}

export interface BotSettings {
  chainKey: string;
  maxFeeGwei: number;
  priorityGwei: number;
  gasLimit: number;
  autoEnabled: boolean;
  autoMaxQuantity?: number;
  copyMintEnabled: boolean;
  // Copy-mint isn't restricted to free drops, so this is the one guardrail
  // against blindly following a watched wallet into an expensive mint.
  copyMintMaxPriceEth: number;
}

interface StoreData {
  wallets: WalletRecord[];
  copyTargets: CopyTarget[];
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
      return { wallets: [], copyTargets: [], settings: { ...DEFAULT_SETTINGS } };
    }
    const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    return {
      wallets: raw.wallets ?? [],
      copyTargets: raw.copyTargets ?? [],
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

  // Decrypted only at the point of use (signing), never logged or displayed.
  getDecryptedKeys(): string[] {
    return this.data.wallets.map((w) => decrypt(w.encryptedKey, this.passphrase));
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
