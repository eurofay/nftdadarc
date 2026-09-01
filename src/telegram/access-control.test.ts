import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { AccessControl } from "./access-control";

let dir: string;
let file: string;
let ac: AccessControl;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "invite-"));
  file = path.join(dir, "access.json");
  ac = new AccessControl(file);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ALICE = 111;
const BOB = 222;

describe("issuing codes", () => {
  it("never writes the code itself to disk", () => {
    const { code } = ac.createInvite("alice");
    expect(fs.readFileSync(file, "utf8")).not.toContain(code);
    expect(ac.listCodes()[0].hash).toBeTruthy();
  });

  it("issues a different code every time", () => {
    const seen = new Set(Array.from({ length: 10 }, () => ac.createInvite().code));
    expect(seen.size).toBe(10);
  });

  it("is closed until the first invite exists", () => {
    expect(ac.isConfigured()).toBe(false);
    ac.createInvite();
    expect(ac.isConfigured()).toBe(true);
  });
});

describe("redeeming", () => {
  it("lets the holder in and remembers who they are", () => {
    const { code, record } = ac.createInvite("alice");
    expect(ac.hasAccess(ALICE)).toBe(false);

    const result = ac.redeem(ALICE, code);
    expect(result.ok).toBe(true);
    expect(ac.hasAccess(ALICE)).toBe(true);
    expect(ac.listCodes().find((c) => c.id === record.id)?.redeemedBy).toBe(ALICE);
  });

  it("rejects a wrong code without granting anything", () => {
    ac.createInvite();
    expect(ac.redeem(ALICE, "not-a-real-code")).toEqual({ ok: false, reason: "invalid" });
    expect(ac.hasAccess(ALICE)).toBe(false);
  });

  it("is single use — passing a code on does not create a second seat", () => {
    const { code } = ac.createInvite();
    expect(ac.redeem(ALICE, code).ok).toBe(true);
    expect(ac.redeem(BOB, code)).toEqual({ ok: false, reason: "already-used" });
    expect(ac.hasAccess(BOB)).toBe(false);
  });

  it("lets the same person re-enter their own code, so a re-send isn't a lockout", () => {
    const { code } = ac.createInvite();
    ac.redeem(ALICE, code);
    expect(ac.redeem(ALICE, code).ok).toBe(true);
  });

  it("survives a restart", () => {
    const { code } = ac.createInvite();
    ac.redeem(ALICE, code);
    expect(new AccessControl(file).hasAccess(ALICE)).toBe(true);
  });
});

describe("revoking one person", () => {
  it("locks out exactly that person and nobody else", () => {
    const a = ac.createInvite("alice");
    const b = ac.createInvite("bob");
    ac.redeem(ALICE, a.code);
    ac.redeem(BOB, b.code);

    ac.revokeCode(a.record.id);

    // The whole point of codes over one shared password.
    expect(ac.hasAccess(ALICE)).toBe(false);
    expect(ac.hasAccess(BOB)).toBe(true);
  });

  it("stops a revoked code being redeemed again", () => {
    const { code, record } = ac.createInvite();
    ac.revokeCode(record.id);
    expect(ac.redeem(ALICE, code)).toEqual({ ok: false, reason: "revoked" });
  });

  it("reports an unknown id rather than pretending it worked", () => {
    expect(ac.revokeCode("nope")).toBeNull();
  });

  it("can revoke an unused code before anyone gets it", () => {
    const { code, record } = ac.createInvite();
    ac.revokeCode(record.id);
    expect(ac.redeem(ALICE, code).ok).toBe(false);
  });
});

describe("revoking everyone", () => {
  it("kills every grant in one action", () => {
    const a = ac.createInvite();
    const b = ac.createInvite();
    ac.redeem(ALICE, a.code);
    ac.redeem(BOB, b.code);

    ac.revokeAll();

    expect(ac.hasAccess(ALICE)).toBe(false);
    expect(ac.hasAccess(BOB)).toBe(false);
  });

  it("invalidates old codes so a leaked one can't be reused", () => {
    const { code } = ac.createInvite();
    ac.redeem(ALICE, code);
    ac.revokeAll();
    // Regression: bumping the epoch alone left the code redeemable, so
    // sending it again re-granted access at the new epoch.
    expect(ac.redeem(ALICE, code)).toEqual({ ok: false, reason: "revoked" });
    expect(ac.hasAccess(ALICE)).toBe(false);
  });

  it("holds across a restart", () => {
    const { code } = ac.createInvite();
    ac.redeem(ALICE, code);
    ac.revokeAll();
    expect(new AccessControl(file).hasAccess(ALICE)).toBe(false);
  });
});

describe("brute-force resistance", () => {
  it("locks a user out after repeated wrong guesses", () => {
    ac.createInvite();
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) expect(ac.recordFailure(ALICE, now)).toBe(0);
    expect(ac.recordFailure(ALICE, now)).toBeGreaterThan(0);
    expect(ac.redeem(ALICE, "guess", now)).toMatchObject({ ok: false, reason: "locked" });
  });

  it("locks only the guesser", () => {
    ac.createInvite();
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) ac.recordFailure(ALICE, now);
    expect(ac.lockoutRemainingMs(BOB, now)).toBe(0);
  });

  it("expires rather than banning forever", () => {
    ac.createInvite();
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) ac.recordFailure(ALICE, now);
    expect(ac.lockoutRemainingMs(ALICE, now + 16 * 60 * 1000)).toBe(0);
  });

  it("clears the count once a real code lands", () => {
    const { code } = ac.createInvite();
    ac.recordFailure(ALICE);
    ac.redeem(ALICE, code);
    expect(ac.lockoutRemainingMs(ALICE)).toBe(0);
  });
});

describe("failure modes", () => {
  it("denies everyone when the gate file is corrupt, rather than opening up", () => {
    const { code } = ac.createInvite();
    ac.redeem(ALICE, code);
    fs.writeFileSync(file, "{ not json");

    const reloaded = new AccessControl(file);
    expect(reloaded.isConfigured()).toBe(false);
    expect(reloaded.hasAccess(ALICE)).toBe(false);
    expect(reloaded.redeem(ALICE, code).ok).toBe(false);
  });
});
