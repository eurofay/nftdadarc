// Access control for the web UI.
//
// This process can decrypt private keys. The Telegram bot gates that behind a
// numeric account id an attacker cannot forge; a URL is reachable by anyone
// who finds it, and on a hosted deployment it is public. So the web door is
// the weakest point in the whole system unless it is built to be the
// strongest, and everything here exists for that reason.
//
// Two rules follow from it, and they are enforced elsewhere rather than
// suggested here:
//
//   1. No route ever returns a private key or a seed phrase. Not behind
//      re-auth, not behind a confirmation. Those stay Telegram-only, so a
//      stolen web session cannot become stolen funds.
//   2. Nothing runs without a session. There is no read-only tier, because
//      wallet addresses and balances are worth protecting too.

import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/** Sessions last a working session, not a month. Re-login is cheap. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Failed attempts allowed from one address before it is locked out. */
export const MAX_ATTEMPTS = 5;

/** How long that lockout lasts. */
export const LOCKOUT_MS = 15 * 60 * 1000;

/** Shortest token accepted. Anything less is guessable at web speeds. */
export const MIN_TOKEN_LENGTH = 24;

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * A plain === returns as soon as it finds a difference, so the time it takes
 * reveals how much of a guess was correct — enough to recover a token one
 * character at a time. Both sides are hashed first so the comparison is over
 * equal-length buffers, which timingSafeEqual requires and which also stops
 * the length itself being a signal.
 */
export function secretsMatch(supplied: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHmac("sha256", "compare").update(supplied).digest();
  const b = createHmac("sha256", "compare").update(expected).digest();
  return timingSafeEqual(a, b);
}

export interface TokenCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Whether the configured token is fit to protect a key store.
 *
 * Checked at startup rather than at login: a deployment with a weak token
 * should refuse to open the door at all, not discover the problem when
 * someone guesses it.
 */
export function checkTokenStrength(token: string | undefined): TokenCheck {
  const value = (token ?? "").trim();
  if (!value) return { ok: false, reason: "no WEB_ACCESS_TOKEN is set" };
  if (value.length < MIN_TOKEN_LENGTH) {
    return { ok: false, reason: `WEB_ACCESS_TOKEN is ${value.length} characters, needs at least ${MIN_TOKEN_LENGTH}` };
  }
  if (/^[0-9]+$/.test(value)) return { ok: false, reason: "WEB_ACCESS_TOKEN is all digits" };
  // A token that looks like the placeholder is almost certainly the
  // placeholder, and shipping with it open is worse than not starting.
  if (/^(changeme|password|secret|token|admin)/i.test(value)) {
    return { ok: false, reason: "WEB_ACCESS_TOKEN looks like a placeholder" };
  }
  return { ok: true };
}

/** A cookie value that proves a login, signed so it cannot be forged. */
export function mintSession(secret: string, now = Date.now(), ttlMs = SESSION_TTL_MS): string {
  const expires = now + ttlMs;
  const nonce = randomBytes(9).toString("base64url");
  const payload = `${expires}.${nonce}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/**
 * Whether a cookie is a session this server issued and has not expired.
 *
 * The signature is checked before the expiry so a forged cookie cannot be
 * distinguished from an expired one by how long the check takes.
 */
export function verifySession(cookie: string | undefined, secret: string, now = Date.now()): boolean {
  if (!cookie) return false;
  const parts = cookie.split(".");
  if (parts.length !== 3) return false;
  const [expires, nonce, sig] = parts;
  const expected = createHmac("sha256", secret).update(`${expires}.${nonce}`).digest("base64url");
  if (!secretsMatch(sig, expected)) return false;
  const at = Number(expires);
  return Number.isFinite(at) && at > now;
}

interface Attempts {
  count: number;
  lockedUntil: number;
}

/**
 * Per-client failure tracking.
 *
 * Keyed by whatever the caller can identify a client by. That is imperfect
 * behind a proxy, which is why it is a delay rather than a ban: it exists to
 * make guessing slow, not to be an access list.
 */
export class LoginLimiter {
  private readonly seen = new Map<string, Attempts>();

  constructor(
    private readonly maxAttempts = MAX_ATTEMPTS,
    private readonly lockoutMs = LOCKOUT_MS
  ) {}

  /** Milliseconds this client must wait, or 0 if it may try now. */
  lockedFor(key: string, now = Date.now()): number {
    const record = this.seen.get(key);
    if (!record) return 0;
    return record.lockedUntil > now ? record.lockedUntil - now : 0;
  }

  recordFailure(key: string, now = Date.now()): void {
    const record = this.seen.get(key) ?? { count: 0, lockedUntil: 0 };
    record.count += 1;
    if (record.count >= this.maxAttempts) {
      record.lockedUntil = now + this.lockoutMs;
      record.count = 0;
    }
    this.seen.set(key, record);
  }

  /** A correct login clears the record: the client has proved it is not guessing. */
  recordSuccess(key: string): void {
    this.seen.delete(key);
  }
}

/** Parse a Cookie header into a map. Tolerant, because browsers are. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/**
 * The Set-Cookie for a session.
 *
 * HttpOnly so script cannot read it, SameSite=Strict so another origin cannot
 * ride it, and Secure whenever the connection is not plain local http —
 * a session cookie for a key store has no business crossing the wire in clear.
 */
export function sessionCookie(value: string, opts: { secure: boolean; ttlMs?: number }): string {
  const maxAge = Math.floor((opts.ttlMs ?? SESSION_TTL_MS) / 1000);
  return [
    `l00p_session=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    opts.secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearedCookie(): string {
  return "l00p_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
}
