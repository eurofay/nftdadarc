// The invite gate for everyone who isn't the owner.
//
// Anyone can find the bot on Telegram, so the bot itself has to be the door.
// Codes rather than one shared password, for one reason: a shared secret can
// only ever be revoked for EVERYONE. With a code per person, the owner can
// remove exactly the person who leaked theirs and nobody else notices.
//
// Three properties shape the design:
//
//   1. A code is a bearer token, so it's stored as a salted hash and never in
//      the clear. It's shown once, at generation, and cannot be read back —
//      the same reason a password manager can show you a key only once.
//
//   2. Revoking ONE person must not disturb anyone else. Each redeemed code
//      names its holder, so revoking that code locks out that user alone.
//
//   3. Revoking EVERYONE must still be one action, for when the owner doesn't
//      know which code leaked. That's the epoch: every grant records the epoch
//      it was made at, and bumping it invalidates all of them in a single write.
//
// The owner is never gated. A bot holding real keys must not be lockable by
// its own door.

import crypto from "crypto";
import fs from "fs";
import path from "path";

const SCRYPT_KEYLEN = 64;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const CODE_BYTES = 9; // 72 bits — far past guessable, still short enough to paste

export interface InviteCode {
  /** Random id for referring to this code without revealing it. */
  id: string;
  hash: string;
  salt: string;
  /** Owner's note about who it's for. */
  label?: string;
  createdAt: number;
  redeemedBy?: number;
  redeemedAt?: number;
  revoked?: boolean;
  /** Access epoch at redemption; a global revoke moves past it. */
  epochAtRedeem?: number;
}

interface FailureRecord {
  count: number;
  lockedUntil?: number;
}

interface AccessData {
  epoch: number;
  codes: InviteCode[];
  failures: Record<string, FailureRecord>;
}

const EMPTY: AccessData = { epoch: 1, codes: [], failures: {} };

export type RedeemResult =
  | { ok: true; code: InviteCode }
  | { ok: false; reason: "invalid" | "already-used" | "revoked" | "locked"; waitMs?: number };

export class AccessControl {
  private readonly filePath: string;
  private data: AccessData;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
  }

  private load(): AccessData {
    if (!fs.existsSync(this.filePath)) return { ...EMPTY, codes: [], failures: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return {
        epoch: raw.epoch ?? 1,
        codes: Array.isArray(raw.codes) ? raw.codes : [],
        failures: raw.failures ?? {},
      };
    } catch {
      // A corrupt gate must fail CLOSED — an empty object denies everyone
      // rather than silently opening the bot to the world.
      return { ...EMPTY, codes: [], failures: {} };
    }
  }

  // Same atomic write as the wallet store: a truncated gate file is a corrupt
  // gate, and the load above turns that into "nobody gets in".
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

  get epoch(): number {
    return this.data.epoch;
  }

  private hash(plain: string, salt: Buffer): string {
    return crypto.scryptSync(plain.trim(), salt, SCRYPT_KEYLEN).toString("hex");
  }

  /**
   * Mint a code. The plaintext is returned ONCE and never stored — the owner
   * shows it to one person, and neither the file nor a backup of it can give
   * the code back.
   */
  createInvite(label?: string): { code: string; record: InviteCode } {
    const code = crypto.randomBytes(CODE_BYTES).toString("base64url");
    const salt = crypto.randomBytes(16);
    const record: InviteCode = {
      id: crypto.randomBytes(4).toString("hex"),
      hash: this.hash(code, salt),
      salt: salt.toString("hex"),
      label: label?.trim() || undefined,
      createdAt: Date.now(),
    };
    this.data.codes.push(record);
    this.save();
    return { code, record };
  }

  /** Whether this user currently holds a live grant. */
  hasAccess(userId: number): boolean {
    return this.data.codes.some(
      (c) => c.redeemedBy === userId && !c.revoked && c.epochAtRedeem === this.data.epoch
    );
  }

  redeem(userId: number, plain: string, now = Date.now()): RedeemResult {
    const waitMs = this.lockoutRemainingMs(userId, now);
    if (waitMs > 0) return { ok: false, reason: "locked", waitMs };

    // Every code is checked with a constant-time compare rather than stopping
    // at the first match, so timing doesn't reveal how far down the list a
    // guess landed.
    let found: InviteCode | undefined;
    for (const c of this.data.codes) {
      const expected = Buffer.from(c.hash, "hex");
      const actual = Buffer.from(this.hash(plain, Buffer.from(c.salt, "hex")), "hex");
      if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) found = c;
    }

    if (!found) return { ok: false, reason: "invalid" };
    if (found.revoked) return { ok: false, reason: "revoked" };
    // Single use: a code passed on to a second person is not a second seat.
    if (found.redeemedBy !== undefined && found.redeemedBy !== userId) {
      return { ok: false, reason: "already-used" };
    }

    found.redeemedBy = userId;
    found.redeemedAt = now;
    found.epochAtRedeem = this.data.epoch;
    delete this.data.failures[String(userId)];
    this.save();
    return { ok: true, code: found };
  }

  /** Revoke one code — and so exactly one person — leaving everyone else in. */
  revokeCode(id: string): InviteCode | null {
    const code = this.data.codes.find((c) => c.id === id);
    if (!code) return null;
    code.revoked = true;
    this.save();
    return code;
  }

  /**
   * Revoke every grant at once, for when the owner doesn't know which leaked.
   *
   * Every existing code is marked revoked, not just cut loose from the epoch.
   * Bumping the epoch alone left each code REDEEMABLE — the holder simply sent
   * it again and was re-granted at the new epoch, which is precisely the
   * situation this is meant to end. The epoch bump stays as a second barrier
   * for any grant that predates a code record.
   */
  revokeAll(): number {
    for (const code of this.data.codes) code.revoked = true;
    this.data.epoch += 1;
    this.data.failures = {};
    this.save();
    return this.data.epoch;
  }

  listCodes(): InviteCode[] {
    return [...this.data.codes];
  }

  /** True once at least one code exists — before that the bot is closed. */
  isConfigured(): boolean {
    return this.data.codes.length > 0;
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
      rec.count = 0; // the lockout replaces the count and restarts after it expires
    }
    this.data.failures[key] = rec;
    this.save();
    return rec.lockedUntil && rec.lockedUntil > now ? rec.lockedUntil - now : 0;
  }
}
