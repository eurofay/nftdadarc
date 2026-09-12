// Persisted state for the Telegram bot: wallets (key encrypted at rest —
// see crypto.ts), a copy-mint watchlist, and settings. One JSON file on disk,
// git-ignored, since this is a single-owner bot with no concurrent writers.

import { GasEntry } from "../gas-ledger";
import { SmartWallet } from "../smart-wallet";
import { ClusterMintSettings } from "../cluster-mint";
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { Wallet } from "ethers";
import { encrypt, decrypt } from "./crypto";

// Telegram inline buttons are ~64 bytes of callback data and a finite width;
// a pasted paragraph as a label makes every keyboard it appears in unusable.
const MAX_LABEL = 40;

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
// A month of heavy use at a few hundred transactions a day, which is what a
// spend report needs to answer "where did it go" without growing unbounded.
const MAX_GAS_HISTORY = 5_000;

export interface BotSettings {
  chainKey: string; // the single chain used by /mint, Fund Wallets, and Copy Mint
  maxFeeGwei: number;
  priorityGwei: number;
  // 0 means "size it from the quantity being minted" (see gas.ts). A fixed
  // number over-reserves for a small mint and runs out of gas on a large one.
  gasLimit: number;
  /**
   * Milliseconds to send before a stage opens, so the transaction arrives as
   * it opens rather than a flight time later. 0 is off, -1 measures the round
   * trip and decides. Landing early reverts, so this defaults to off.
   */
  earlyFireMs: number;
  autoEnabled: boolean;
  autoMaxQuantity?: number;
  // Which chain(s) Auto Mint watches — independent of chainKey, since this
  // is the one feature that makes sense to run on several chains at once
  // (one runAutoMintWatcher instance per chain, same as CLI's AUTO_CHAIN
  // comma-list). Empty/unset means "just chainKey", so existing setups
  // don't change behavior until this is deliberately turned into a list.
  autoChainKeys?: string[];
  /**
   * Chains the radar watches, independent of Auto Mint's list.
   *
   * It borrowed autoChainKeys at first, which sounds tidy and is wrong: Auto
   * Mint SPENDS on every chain it is given, so that list is kept deliberately
   * short. The radar only reads and notifies, so there is no reason to watch
   * fewer chains than actually run drops -- and borrowing meant it quietly
   * fell back to the single current chain and looked like it only knew one.
   */
  radarChainKeys?: string[];
  /**
   * Following a crowd of watched wallets into a mint.
   *
   * Absent means off. Nothing here can make a PAID mint fire unattended --
   * that rule lives in decideClusterMint and no setting reaches it.
   */
  clusterMint?: ClusterMintSettings;
  /**
   * Copy Mint follows the smart wallets too, without them being added twice.
   *
   * Recording a wallet in the radar bot and then adding it to Copy Mint by
   * hand is the same decision entered twice, and the two lists drift the
   * moment you forget. On, they are one list; off, Copy Mint keeps only what
   * was added to it directly.
   */
  copyFollowsSmart?: boolean;
  /**
   * Whether the radar and the smart-alert watcher run without being asked.
   *
   * Absent means ON: watching is what these two bots are FOR, and a feed that
   * needs a tap after every deploy is a feed you find out is off by missing
   * something. Stopping one writes false here, so a deliberate stop survives
   * a redeploy -- otherwise the Stop button only means "until the next push".
   */
  radarWatchOn?: boolean;
  smartWatchOn?: boolean;
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
  /**
   * Present when this is an allow-list mint rather than a public one.
   *
   * The proof and stage terms are stored with the record because they are
   * what makes the mint possible, and re-deriving them at fire time would put
   * a list fetch on the critical path — the opposite of the point.
   *
   * params is JSON with bigints as strings; they don't survive the store's
   * plain-JSON round trip. See seadrop-allowlist.MintParams.
   */
  allowlist?: {
    /**
     * Each wallet's own proof, keyed by lowercased address.
     *
     * Keyed rather than a single array because the Merkle leaf is
     * keccak256(abi.encode(minter, params)) — bound to one address. A record
     * arming five wallets needs five proofs, and lending one wallet's proof
     * to another is an InvalidProof revert that still pays the gas.
     */
    proofs?: Record<string, string[]>;
    /**
     * The old single-proof shape, kept so records armed before proofs existed
     * still fire. Only ever applied to a single-wallet record — see
     * proofForWallet — because that is the only case where it is unambiguous.
     */
    proof?: string[];
    params: string;
  };
  /**
   * Ready-to-send calldata, one entry per wallet, resolved when this was
   * armed rather than when it fires.
   *
   * Set for mints whose calldata cannot be derived from chain state alone —
   * a signed stage, where only the project's key can authorise a wallet.
   * Resolving it at arm time means the network work happens hours early
   * instead of on the critical path, and means an ineligible wallet is known
   * about while there is still time to do something about it.
   *
   * Values are decimal strings: a bigint does not survive the store's plain
   * JSON round trip.
   */
  prepared?: {
    source: string;
    perWallet: Record<string, { to: string; data: string; value: string }>;
  };
}

/**
 * This wallet's proof from an armed allow-list record, or null.
 *
 * Null means "do not send": no proof is not a slow mint, it is a guaranteed
 * revert with a real gas cost.
 */
/**
 * Every wallet on this record that actually has something to send.
 *
 * A wallet with no entry is not slow, it is a guaranteed revert with a real
 * gas cost — so it is left out rather than given another wallet's bytes.
 */
export function preparedWallets(record: ScheduledMint): string[] {
  const p = record.prepared?.perWallet;
  if (!p) return [];
  return record.wallets.filter((w) => p[w.toLowerCase()] !== undefined);
}

export function proofForWallet(record: ScheduledMint, address: string): string[] | null {
  const al = record.allowlist;
  if (!al) return null;
  const keyed = al.proofs?.[address.toLowerCase()];
  if (keyed) return keyed;
  // A legacy single-proof record is only unambiguous when it armed exactly
  // one wallet and this is that wallet. Anything else and we cannot say whose
  // proof it is, so we decline rather than guess and burn a fee.
  if (al.proof && record.wallets.length === 1 && record.wallets[0].toLowerCase() === address.toLowerCase()) {
    return al.proof;
  }
  return null;
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
  gasHistory: GasEntry[];
  smartWallets: SmartWallet[];
  walletBatches: { id: string; addresses: string[]; at: number; note?: string }[];
  settings: BotSettings;
}

/**
 * The gas numbers this shipped with before they were measured.
 *
 * A store still holding all three exactly has never had them deliberately
 * changed, so moving it to the measured defaults is a fix rather than an
 * override. Any wallet whose owner has touched even one of them is left
 * alone -- a setting someone chose is not ours to overwrite.
 */
export const LEGACY_GAS_DEFAULTS = { maxFeeGwei: 2, priorityGwei: 0.05, gasLimit: 250_000 };

export function migrateGasSettings<T extends { maxFeeGwei: number; priorityGwei: number; gasLimit: number }>(
  settings: T
): { settings: T; migrated: boolean } {
  const stale =
    settings.maxFeeGwei === LEGACY_GAS_DEFAULTS.maxFeeGwei &&
    settings.priorityGwei === LEGACY_GAS_DEFAULTS.priorityGwei &&
    settings.gasLimit === LEGACY_GAS_DEFAULTS.gasLimit;
  if (!stale) return { settings, migrated: false };
  return { settings: { ...settings, maxFeeGwei: 0, priorityGwei: 0, gasLimit: 0 }, migrated: true };
}

/**
 * Exported for tests only.
 *
 * The shipped defaults carry real decisions -- which chains the radar watches,
 * that gas figures are measured rather than hand-set -- and a test that
 * re-declares them proves nothing about what actually ships.
 */
export const DEFAULT_SETTINGS_FOR_TEST = (): BotSettings => ({ ...DEFAULT_SETTINGS });

const DEFAULT_SETTINGS: BotSettings = {
  chainKey: "base",
  // All three are "let the code work it out", and all three used to be
  // hand-set numbers that were wrong against the measured chain:
  //
  //   maxFeeGwei 2      ~19x the ceiling real mints use, and because a node
  //                     reserves gasLimit x maxFee up front, it demanded
  //                     0.0005 ETH in a wallet to send a mint costing
  //                     0.000011 ETH. That is what refuses a funded wallet.
  //   priorityGwei 0.05 a 47% surcharge on a 0.106 gwei base fee, buying
  //                     nothing on a chain that orders by arrival.
  //   gasLimit 250_000  non-zero, so it OVERRODE gasLimitForQuantity --
  //                     the measured 33-mint model never ran.
  //
  // Zero means measure it: fee follows the chain, limit follows the quantity.
  // The four with measured SeaDrop traffic. Avalanche is deliberately absent:
  // SeaDrop is deployed there and nothing is using it -- 0 drops and 0 mints
  // across a 5.9 hour sample -- so watching it is a poll loop that can never
  // fire. Add it from the picker if that changes.
  radarChainKeys: ["robinhood", "ethereum", "ink", "base"],
  maxFeeGwei: 0,
  priorityGwei: 0,
  gasLimit: 0,
  earlyFireMs: 0,
  autoEnabled: false,
  // On by default: the whole point of the bot is that it copies without being
  // asked each time. Turning it off is a deliberate act and is remembered.
  copyMintEnabled: true,
  copyMintMaxPriceEth: 0,
  // Off by default. A copy signal is only worth acting on immediately —
  // minting a collection hours after the watched wallet did means arriving
  // late to whatever edge that wallet had, and the stage may have closed.
  // The mechanism remains for covering downtime if it is ever wanted.
  copyBackfillHours: 0,
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
      return { seeds: [], scheduled: [], wallets: [], copyTargets: [], mints: [], copyHistory: [], gasHistory: [], smartWallets: [], walletBatches: [], settings: { ...DEFAULT_SETTINGS } };
    }
    const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    return {
      wallets: raw.wallets ?? [],
      copyTargets: raw.copyTargets ?? [],
      mints: raw.mints ?? [],
      copyHistory: raw.copyHistory ?? [],
      gasHistory: raw.gasHistory ?? [],
      smartWallets: raw.smartWallets ?? [],
      walletBatches: raw.walletBatches ?? [],
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

  /**
   * Rename a wallet. Returns the new record, or null when there is no such
   * wallet.
   *
   * The label is presentation only -- every other part of the bot addresses a
   * wallet by its address -- so renaming cannot orphan a copy-mint target, a
   * scheduled mint, or anything else holding a reference.
   */
  renameWallet(address: string, label: string): WalletRecord | null {
    const record = this.data.wallets.find((w) => w.address.toLowerCase() === address.toLowerCase());
    if (!record) return null;
    const trimmed = label.trim();
    // An empty name would leave a blank button that cannot be identified in a
    // list, so it falls back to the same default a new wallet gets.
    record.label = trimmed === "" ? record.address.slice(0, 8) : trimmed.slice(0, MAX_LABEL);
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

  /**
   * Rename a watched wallet. Returns the new record, or null if not watched.
   *
   * Same reasoning as renameWallet: the label is presentation only, and the
   * watcher matches sightings by address, so renaming cannot stop a wallet
   * being copied or silently start copying a different one.
   */
  renameCopyTarget(address: string, label: string): CopyTarget | null {
    const target = this.data.copyTargets.find((t) => t.address.toLowerCase() === address.toLowerCase());
    if (!target) return null;
    const trimmed = label.trim();
    target.label = trimmed === "" ? target.address.slice(0, 8) : trimmed.slice(0, MAX_LABEL);
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

  // ── Backup and restore ───────────────────────────────────────────────
  /**
   * The store exactly as it sits on disk.
   *
   * Private keys and seed phrases inside are encrypted with
   * WALLET_ENCRYPTION_KEY, which lives in the environment and never in this
   * file — so the export is inert on its own. That is what makes it safe to
   * carry through a chat or a backup service.
   */
  exportSnapshot(): string {
    return JSON.stringify(this.data, null, 2);
  }

  /**
   * Replace everything with a previously exported snapshot.
   *
   * Every encrypted secret is decrypted BEFORE anything is written. A
   * snapshot from an install with a different WALLET_ENCRYPTION_KEY parses
   * perfectly and looks healthy, but every private key in it is unreadable —
   * restoring it would replace working wallets with dead ones and the damage
   * would only surface at mint time. Refusing up front is the whole point of
   * this method.
   */
  importSnapshot(json: string): { wallets: number; seeds: number; replaced: number } {
    let parsed: any;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("That file isn't valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.wallets)) {
      throw new Error("That doesn't look like a backup of this bot — no wallet list in it.");
    }

    for (const w of parsed.wallets) {
      if (!w?.address || !w?.encryptedKey) {
        throw new Error("The backup has a wallet entry with no address or key — refusing to restore it.");
      }
      let key: string;
      try {
        key = decrypt(w.encryptedKey, this.passphrase);
      } catch {
        throw new Error(
          `Can't decrypt ${w.address} — this backup was made with a different WALLET_ENCRYPTION_KEY. ` +
            "Restoring it would give you wallets nobody can spend from. Nothing was changed."
        );
      }
      // Decrypting is not enough: it must also be the key for that address.
      if (new Wallet(key).address.toLowerCase() !== String(w.address).toLowerCase()) {
        throw new Error(`The key stored for ${w.address} doesn't control it. Nothing was changed.`);
      }
    }

    for (const seed of parsed.seeds ?? []) {
      try {
        decrypt(seed.encryptedPhrase, this.passphrase);
      } catch {
        throw new Error("A seed phrase in the backup can't be decrypted with this key. Nothing was changed.");
      }
    }

    // Keep what is being replaced. A restore is the one operation here that
    // destroys data, and "I restored the wrong file" needs a way back.
    const replaced = this.data.wallets.length;
    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, `${this.filePath}.pre-restore`);
    }

    this.data = {
      seeds: parsed.seeds ?? [],
      scheduled: parsed.scheduled ?? [],
      wallets: parsed.wallets,
      copyTargets: parsed.copyTargets ?? [],
      mints: parsed.mints ?? [],
      copyHistory: parsed.copyHistory ?? [],
      gasHistory: parsed.gasHistory ?? [],
      smartWallets: parsed.smartWallets ?? [],
      walletBatches: parsed.walletBatches ?? [],
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
    };
    this.save();
    return { wallets: this.data.wallets.length, seeds: this.data.seeds.length, replaced };
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
  /**
   * Record what a landed transaction cost.
   *
   * Only ever called with a receipt in hand: gasUsed and effectiveGasPrice are
   * both post-hoc, and a "cost" quoted from the limit and the bid would
   * overstate it by roughly 20x on this chain.
   */
  /**
   * Record a wallet worth watching.
   *
   * Kept apart from copy targets on purpose: a copy target is an instruction
   * to spend money following someone, and a smart wallet is a note that they
   * are interesting. Conflating the two would make researching a wallet the
   * same act as betting on it.
   */
  /**
   * Park a list of addresses behind a short id.
   *
   * Telegram caps a deep-link payload at 64 characters, which is one and a
   * half addresses -- so "watch all of these" cannot carry the list itself.
   * It carries a handle, and the list waits here.
   *
   * Persisted rather than held in memory because the whole point is that the
   * link survives being tapped ten minutes later, possibly after a redeploy.
   */
  stageWalletBatch(addresses: string[], note?: string): string {
    const id = randomBytes(6).toString("hex");
    this.data.walletBatches.push({ id, addresses, at: Date.now(), note });
    // An hour is longer than anyone leaves a message unread and far short of
    // letting these accumulate; the cap is the belt to that braces.
    const cutoff = Date.now() - 60 * 60 * 1000;
    this.data.walletBatches = this.data.walletBatches.filter((b) => b.at >= cutoff).slice(-25);
    this.save();
    return id;
  }

  /** Read a parked batch. Left in place, so a double tap is not a dead link. */
  peekWalletBatch(id: string): { addresses: string[]; note?: string } | null {
    const b = this.data.walletBatches.find((x) => x.id === id);
    return b ? { addresses: b.addresses, note: b.note } : null;
  }

  addSmartWallet(entry: SmartWallet): SmartWallet {
    const existing = this.data.smartWallets.findIndex(
      (w) => w.address.toLowerCase() === entry.address.toLowerCase()
    );
    // Re-recording refreshes the scout numbers but keeps the original date,
    // which is what makes "watched since" mean anything.
    if (existing >= 0) {
      const kept = this.data.smartWallets[existing];
      this.data.smartWallets[existing] = { ...entry, addedAt: kept.addedAt, note: entry.note ?? kept.note };
    } else {
      this.data.smartWallets.push(entry);
    }
    this.save();
    return this.data.smartWallets[existing >= 0 ? existing : this.data.smartWallets.length - 1];
  }

  /**
   * Every wallet Copy Mint should follow.
   *
   * The union when copyFollowsSmart is on, de-duplicated, with the
   * hand-added ones first so a label you chose wins over a generated one.
   */
  copyWatchList(): CopyTarget[] {
    const out: CopyTarget[] = [...this.listCopyTargets()];
    if (!this.getSettings().copyFollowsSmart) return out;
    const seen = new Set(out.map((t) => t.address.toLowerCase()));
    for (const w of this.listSmartWallets()) {
      if (seen.has(w.address.toLowerCase())) continue;
      seen.add(w.address.toLowerCase());
      // addedAt carried over so the menu can order and date them like any
      // other target -- a synthesised "now" would make every smart wallet
      // look like it was added this second.
      out.push({ address: w.address, label: w.label, addedAt: w.addedAt });
    }
    return out;
  }

  listSmartWallets(): SmartWallet[] {
    return [...this.data.smartWallets].sort((a, b) => (b.scoutedScore ?? 0) - (a.scoutedScore ?? 0));
  }

  removeSmartWallet(address: string): boolean {
    const before = this.data.smartWallets.length;
    this.data.smartWallets = this.data.smartWallets.filter(
      (w) => w.address.toLowerCase() !== address.toLowerCase()
    );
    if (this.data.smartWallets.length === before) return false;
    this.save();
    return true;
  }

  recordGas(entry: GasEntry): void {
    this.data.gasHistory.push(entry);
    if (this.data.gasHistory.length > MAX_GAS_HISTORY) {
      this.data.gasHistory = this.data.gasHistory.slice(-MAX_GAS_HISTORY);
    }
    this.save();
  }

  listGas(fromMs = 0): GasEntry[] {
    return this.data.gasHistory.filter((e) => e.at >= fromMs);
  }

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
    //
    // The gas migration runs here rather than at load so it also reaches a
    // store that was written while the old numbers were the defaults: those
    // values are on disk, not absent, so merging cannot fix them.
    const { settings, migrated } = migrateGasSettings(this.data.settings);
    if (migrated) {
      this.data.settings = settings;
      this.save();
    }
    return { ...settings };
  }


  updateSettings(patch: Partial<BotSettings>): BotSettings {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.getSettings();
  }
}
