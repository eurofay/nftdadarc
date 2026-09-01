// The password gate for everyone who isn't the owner.
//
// Anyone can find the bot on Telegram, so the bot itself has to be the door.
// Three properties matter, and each shapes the design:
//
//   1. A leaked password must be revocable for EVERYONE AT ONCE, including
//      people already inside. That's the epoch: each user records the epoch
//      they unlocked at, and a revoke bumps the global one, so every existing
//      grant stops matching in a single write.
//
//   2. Revoking must REPLACE the password, not just kick people out. Bumping
//      the epoch alone would leave the leaked password working, and everyone
//      who has it simply walks back in.
//
//   3. The owner is never gated. A bot holding real keys must not be lockable
//      by its own door — a forgotten password would strand the wallets.

import crypto from "crypto";
import fs from "fs";
import path from "path";

const SCRYPT_KEYLEN = 64;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

interface FailureRecord {
  count: number;
  lockedUntil?: number;
}

interface AccessData {
  /** scrypt hash, hex. Absent until a password is first set. */
  passwordHash?: string;
  /** Per-password random salt, hex. */
  salt?: string;
  /** Bumped by revokeAll; a grant is valid only while it matches. */
  epoch: number;
  /** Brute-force tracking, keyed by Telegram user id. */
  failures: Record<string, FailureRecord>;
}

const EMPTY: AccessData = { epoch: 1, failures: {} };

export class AccessControl {
  private readonly filePath: string;
  private data: AccessData;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
  }

  private load(): AccessData {
    if (!fs.existsSync(this.filePath)) return { ...EMPTY };
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return { epoch: raw.epoch ?? 1, failures: raw.failures ?? {}, passwordHash: raw.passwordHash, salt: raw.salt };
    } catch {
      // A corrupt gate must fail CLOSED — a fresh object denies everyone
      // rather than silently opening the bot to the world.
      return { ...EMPTY };
    }
  }

  // Same atomic write as the wallet store: a truncated gate file would be a
  // corrupt gate, and the load above turns that into "nobody gets in".
  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmp, "w", 0o600);
      fs.writeFileSync(fd, JSON.stringify(this.data, null, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* already on the error path */ }
      }
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
      throw err;
    }
  }

  /** No password set yet — the owner must choose one before anyone can join. */
  isConfigured(): boolean {
    return Boolean(this.data.passwordHash && this.data.salt);
  }

  get epoch(): number {
    return this.data.epoch;
  }

  setPassword(plain: string): void {
    if (plain.trim().length < 6) throw new Error("Use at least 6 characters.");
    const salt = crypto.randomBytes(16);
    // Stored as a hash, never as the password: whoever reads this file — a
    // backup, a support session, a leaked volume — learns nothing usable.
    this.data.salt = salt.toString("hex");
    this.data.passwordHash = crypto.scryptSync(plain.trim(), salt, SCRYPT_KEYLEN).toString("hex");
    this.save();
  }

  /** Constant-time check, so timing can't be used to narrow the password. */
  verify(plain: string): boolean {
    if (!this.data.passwordHash || !this.data.salt) return false;
    const expected = Buffer.from(this.data.passwordHash, "hex");
    const actual = crypto.scryptSync(plain.trim(), Buffer.from(this.data.salt, "hex"), SCRYPT_KEYLEN);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  /**
   * Kick everyone out and replace the password in one step.
   *
   * Both halves are required. A new password alone leaves people already
   * inside; an epoch bump alone leaves the leaked password working.
   */
  revokeAll(newPassword: string): number {
    this.setPassword(newPassword); // validates before anything is invalidated
    this.data.epoch += 1;
    this.data.failures = {};
    this.save();
    return this.data.epoch;
  }

  /** Whether a grant recorded at `grantedEpoch` is still good. */
  isGrantValid(grantedEpoch: number | undefined): boolean {
    return grantedEpoch !== undefined && grantedEpoch === this.data.epoch;
  }

  lockoutRemainingMs(userId: number, now = Date.now()): number {
    const rec = this.data.failures[String(userId)];
    if (!rec?.lockedUntil) return 0;
    return Math.max(0, rec.lockedUntil - now);
  }

  /** Returns the lockout in ms if this failure triggered one. */
  recordFailure(userId: number, now = Date.now()): number {
    const key = String(userId);
    const rec = this.data.failures[key] ?? { count: 0 };
    rec.count += 1;
    if (rec.count >= MAX_ATTEMPTS) {
      rec.lockedUntil = now + LOCKOUT_MS;
      rec.count = 0; // the lockout replaces the count; it restarts after it expires
    }
    this.data.failures[key] = rec;
    this.save();
    return rec.lockedUntil && rec.lockedUntil > now ? rec.lockedUntil - now : 0;
  }

  clearFailures(userId: number): void {
    delete this.data.failures[String(userId)];
    this.save();
  }
}
