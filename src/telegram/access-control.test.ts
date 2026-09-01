import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { AccessControl } from "./access-control";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "access-ctl-"));
  file = path.join(dir, "access.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("password storage", () => {
  it("never writes the password itself to disk", () => {
    const ac = new AccessControl(file);
    ac.setPassword("correct horse battery");
    const onDisk = fs.readFileSync(file, "utf8");
    expect(onDisk).not.toContain("correct horse battery");
    expect(JSON.parse(onDisk).passwordHash).toBeTruthy();
  });

  it("accepts the right password and rejects everything else", () => {
    const ac = new AccessControl(file);
    ac.setPassword("letmein-please");
    expect(ac.verify("letmein-please")).toBe(true);
    expect(ac.verify("letmein-pleas")).toBe(false);
    expect(ac.verify("")).toBe(false);
    expect(ac.verify("LETMEIN-PLEASE")).toBe(false);
  });

  it("salts, so the same password hashes differently in two installs", () => {
    const a = new AccessControl(file);
    const b = new AccessControl(path.join(dir, "other.json"));
    a.setPassword("same-password");
    b.setPassword("same-password");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).passwordHash).not.toBe(
      JSON.parse(fs.readFileSync(path.join(dir, "other.json"), "utf8")).passwordHash
    );
  });

  it("refuses a trivially short password", () => {
    const ac = new AccessControl(file);
    expect(() => ac.setPassword("abc")).toThrow(/6 characters/);
    expect(ac.isConfigured()).toBe(false);
  });

  it("survives a restart", () => {
    new AccessControl(file).setPassword("persist-me-now");
    expect(new AccessControl(file).verify("persist-me-now")).toBe(true);
  });
});

describe("revokeAll", () => {
  it("invalidates grants that were valid a moment ago", () => {
    const ac = new AccessControl(file);
    ac.setPassword("original-pass");
    const granted = ac.epoch;
    expect(ac.isGrantValid(granted)).toBe(true);

    ac.revokeAll("brand-new-pass");
    // Everyone already inside is out, in a single write.
    expect(ac.isGrantValid(granted)).toBe(false);
    expect(ac.isGrantValid(ac.epoch)).toBe(true);
  });

  it("stops the leaked password working — the whole point", () => {
    const ac = new AccessControl(file);
    ac.setPassword("leaked-everywhere");
    ac.revokeAll("nobody-knows-this");
    expect(ac.verify("leaked-everywhere")).toBe(false);
    expect(ac.verify("nobody-knows-this")).toBe(true);
  });

  it("refuses to revoke into an invalid password, leaving the old gate intact", () => {
    const ac = new AccessControl(file);
    ac.setPassword("original-pass");
    const before = ac.epoch;
    expect(() => ac.revokeAll("shrt")).toThrow(/6 characters/);
    // Nothing changed: still the old password, still the old epoch. A failed
    // revoke must not leave the bot in a half-open state.
    expect(ac.verify("original-pass")).toBe(true);
    expect(ac.epoch).toBe(before);
  });

  it("holds across a restart", () => {
    const ac = new AccessControl(file);
    ac.setPassword("first-password");
    const stale = ac.epoch;
    ac.revokeAll("second-password");
    const reloaded = new AccessControl(file);
    expect(reloaded.isGrantValid(stale)).toBe(false);
    expect(reloaded.verify("first-password")).toBe(false);
  });
});

describe("brute-force resistance", () => {
  it("locks a user out after repeated wrong guesses", () => {
    const ac = new AccessControl(file);
    ac.setPassword("hard-to-guess");
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) expect(ac.recordFailure(999, now)).toBe(0);
    expect(ac.recordFailure(999, now)).toBeGreaterThan(0);
    expect(ac.lockoutRemainingMs(999, now)).toBeGreaterThan(0);
  });

  it("locks only the guessing user, not everyone else", () => {
    const ac = new AccessControl(file);
    ac.setPassword("hard-to-guess");
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) ac.recordFailure(999, now);
    expect(ac.lockoutRemainingMs(999, now)).toBeGreaterThan(0);
    expect(ac.lockoutRemainingMs(111, now)).toBe(0);
  });

  it("expires the lockout rather than banning forever", () => {
    const ac = new AccessControl(file);
    ac.setPassword("hard-to-guess");
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) ac.recordFailure(999, now);
    expect(ac.lockoutRemainingMs(999, now + 16 * 60 * 1000)).toBe(0);
  });

  it("clears the count once someone gets in", () => {
    const ac = new AccessControl(file);
    ac.setPassword("hard-to-guess");
    ac.recordFailure(999);
    ac.clearFailures(999);
    expect(ac.lockoutRemainingMs(999)).toBe(0);
  });

  it("frees everyone's lockout on revoke, so a revoke can't strand people", () => {
    const ac = new AccessControl(file);
    ac.setPassword("hard-to-guess");
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) ac.recordFailure(999, now);
    ac.revokeAll("a-fresh-password");
    expect(ac.lockoutRemainingMs(999, now)).toBe(0);
  });
});

describe("failure modes", () => {
  it("denies everyone when the gate file is corrupt, rather than opening up", () => {
    new AccessControl(file).setPassword("real-password");
    fs.writeFileSync(file, "{ this is not json");
    const ac = new AccessControl(file);
    expect(ac.isConfigured()).toBe(false);
    expect(ac.verify("real-password")).toBe(false);
  });

  it("reports unconfigured before any password is set", () => {
    const ac = new AccessControl(file);
    expect(ac.isConfigured()).toBe(false);
    expect(ac.verify("anything")).toBe(false);
    expect(ac.isGrantValid(undefined)).toBe(false);
  });
});
