import { describe, it, expect } from "vitest";
import {
  secretsMatch,
  checkTokenStrength,
  mintSession,
  verifySession,
  LoginLimiter,
  parseCookies,
  sessionCookie,
  clearedCookie,
  SESSION_TTL_MS,
  MIN_TOKEN_LENGTH,
} from "./auth";

const SECRET = "a-server-secret-used-only-in-this-test-file";

describe("secretsMatch", () => {
  it("accepts the right secret", () => {
    expect(secretsMatch("hunter2-hunter2-hunter2-", "hunter2-hunter2-hunter2-")).toBe(true);
  });

  it("rejects a wrong one", () => {
    expect(secretsMatch("nope", "hunter2-hunter2-hunter2-")).toBe(false);
  });

  it("rejects when nothing is configured, rather than accepting everything", () => {
    // The dangerous failure: an unset expected value matching any input.
    expect(secretsMatch("", "")).toBe(false);
    expect(secretsMatch("anything", "")).toBe(false);
  });

  it("compares equal-length digests, so length is not a signal", () => {
    // Different lengths must not throw, which is what timingSafeEqual does on
    // mismatched buffers — hashing first is what avoids that.
    expect(() => secretsMatch("a", "a-much-longer-secret-value")).not.toThrow();
    expect(secretsMatch("a", "a-much-longer-secret-value")).toBe(false);
  });
});

describe("checkTokenStrength", () => {
  it("accepts a long random token", () => {
    expect(checkTokenStrength("s7Fh2kQp9zXv4Lm8Wc3Rt6Yb1Nd5Ag").ok).toBe(true);
  });

  it("refuses an unset token", () => {
    expect(checkTokenStrength(undefined).reason).toContain("no WEB_ACCESS_TOKEN");
    expect(checkTokenStrength("   ").ok).toBe(false);
  });

  it("refuses one short enough to guess", () => {
    const short = "x".repeat(MIN_TOKEN_LENGTH - 1);
    expect(checkTokenStrength(short).reason).toContain("at least");
  });

  it("refuses all digits, which is a PIN not a token", () => {
    expect(checkTokenStrength("1234567890123456789012345").ok).toBe(false);
  });

  it("refuses something that looks like a placeholder", () => {
    // Shipping with the example value is worse than not starting.
    expect(checkTokenStrength("changeme-changeme-changeme").ok).toBe(false);
    expect(checkTokenStrength("password12345678901234567890").ok).toBe(false);
  });
});

describe("sessions", () => {
  it("accepts a session it just issued", () => {
    expect(verifySession(mintSession(SECRET), SECRET)).toBe(true);
  });

  it("rejects one signed with a different secret", () => {
    expect(verifySession(mintSession("other-secret"), SECRET)).toBe(false);
  });

  it("rejects a tampered expiry", () => {
    // The obvious forgery: extend your own session.
    const [, nonce, sig] = mintSession(SECRET).split(".");
    const forged = `${Date.now() + 999_999_999}.${nonce}.${sig}`;
    expect(verifySession(forged, SECRET)).toBe(false);
  });

  it("rejects an expired session", () => {
    const issued = mintSession(SECRET, 1_000, 1_000);
    expect(verifySession(issued, SECRET, 3_000)).toBe(false);
  });

  it("accepts one that has not expired yet", () => {
    const issued = mintSession(SECRET, 1_000, 10_000);
    expect(verifySession(issued, SECRET, 5_000)).toBe(true);
  });

  it("rejects junk instead of throwing on it", () => {
    for (const junk of ["", "a", "a.b", "a.b.c.d", "....", "not-a-session"]) {
      expect(verifySession(junk, SECRET)).toBe(false);
    }
  });

  it("issues a different value each time, so one leak is not reusable forever", () => {
    expect(mintSession(SECRET)).not.toBe(mintSession(SECRET));
  });
});

describe("LoginLimiter", () => {
  it("lets a client try at first", () => {
    expect(new LoginLimiter().lockedFor("1.2.3.4")).toBe(0);
  });

  it("locks out after enough failures", () => {
    const limiter = new LoginLimiter(3, 60_000);
    for (let i = 0; i < 3; i++) limiter.recordFailure("1.2.3.4", 1_000);
    expect(limiter.lockedFor("1.2.3.4", 1_000)).toBeGreaterThan(0);
  });

  it("does not lock a client out before the limit", () => {
    const limiter = new LoginLimiter(3, 60_000);
    limiter.recordFailure("1.2.3.4");
    limiter.recordFailure("1.2.3.4");
    expect(limiter.lockedFor("1.2.3.4")).toBe(0);
  });

  it("releases the lock once it expires", () => {
    const limiter = new LoginLimiter(2, 1_000);
    limiter.recordFailure("1.2.3.4", 0);
    limiter.recordFailure("1.2.3.4", 0);
    expect(limiter.lockedFor("1.2.3.4", 500)).toBeGreaterThan(0);
    expect(limiter.lockedFor("1.2.3.4", 2_000)).toBe(0);
  });

  it("keeps clients separate, so one attacker cannot lock everyone out", () => {
    const limiter = new LoginLimiter(2, 60_000);
    limiter.recordFailure("attacker", 0);
    limiter.recordFailure("attacker", 0);
    expect(limiter.lockedFor("attacker", 0)).toBeGreaterThan(0);
    expect(limiter.lockedFor("someone-else", 0)).toBe(0);
  });

  it("forgets failures once the client proves it is not guessing", () => {
    const limiter = new LoginLimiter(3, 60_000);
    limiter.recordFailure("1.2.3.4");
    limiter.recordSuccess("1.2.3.4");
    limiter.recordFailure("1.2.3.4");
    limiter.recordFailure("1.2.3.4");
    expect(limiter.lockedFor("1.2.3.4")).toBe(0);
  });
});

describe("cookies", () => {
  it("reads a session out of a header", () => {
    expect(parseCookies("l00p_session=abc; other=1").l00p_session).toBe("abc");
  });

  it("survives a header that is absent or malformed", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("=nope; ;; junk")).toEqual({});
  });

  it("locks the cookie down", () => {
    const cookie = sessionCookie("v", { secure: true });
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
  });

  it("omits Secure only for plain local http", () => {
    // A session cookie for a key store must not cross the wire in clear, but
    // requiring Secure on http://localhost would make it unusable there.
    expect(sessionCookie("v", { secure: false })).not.toContain("Secure");
  });

  it("expires with the session rather than outliving it", () => {
    expect(sessionCookie("v", { secure: true })).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
  });

  it("clears by expiring immediately", () => {
    expect(clearedCookie()).toContain("Max-Age=0");
  });
});
