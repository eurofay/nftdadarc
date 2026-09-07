import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SERVER_SOURCE = fs.readFileSync(path.resolve(__dirname, "server.ts"), "utf8");

/**
 * The server with its comments removed.
 *
 * These tests assert what the code does, and the file explains the same rules
 * in prose directly above the code that keeps them -- so a naive search finds
 * the documentation and fails on it. Stripping comments is the difference
 * between testing the boundary and testing the description of it.
 */
const SERVER = SERVER_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const UI = fs.readFileSync(path.resolve(__dirname, "..", "..", "assets", "web", "app.html"), "utf8");

/**
 * These assert a boundary rather than a behaviour.
 *
 * The web UI is reachable by anyone who finds the URL, while the Telegram bot
 * is gated behind an account id. So the rule is that secrets have no path out
 * through this surface at all — not gated, not confirmed, absent. A boundary
 * that depends on nobody adding the wrong line later is not a boundary, so it
 * is checked here instead of trusted.
 */
describe("the web may spend, but may not read secrets", () => {
  // The line moved once, deliberately, when minting was asked for here. It
  // moved rather than being erased:
  //
  //   MAY spend    -- arm and fire a mint, which costs gas and buys tokens
  //   MAY NOT read -- no private key or seed phrase leaves this process
  //
  // So a stolen session costs a mint's worth of gas and cannot cost a wallet.
  // Signing still happens on the Telegram side: this server writes a
  // scheduled record and hands the id over, which is why the assertions below
  // about Wallet and localPublicSnipe still hold even though minting works.
  it("delegates the actual signing rather than doing it here", () => {
    expect(SERVER).toContain("addScheduled");
    expect(SERVER).toContain("onScheduled");
    expect(SERVER).not.toContain("signTransaction");
  });

  it("never decrypts a private key", () => {
    expect(SERVER).not.toContain("getDecryptedKey");
    expect(SERVER).not.toContain("getDecryptedKeys");
  });

  it("never decrypts a seed phrase", () => {
    expect(SERVER).not.toContain("getDecryptedSeed");
  });

  it("never reads the raw encrypted material either", () => {
    // Handing out ciphertext hands out an offline guessing target.
    expect(SERVER).not.toContain("encryptedKey");
    expect(SERVER).not.toContain("exportSnapshot");
  });

  it("does not sign or send transactions from a browser request", () => {
    // Moving funds stays on the surface with the stronger door.
    expect(SERVER).not.toContain("new Wallet(");
    expect(SERVER).not.toContain("localPublicSnipe");
    expect(SERVER).not.toContain("consolidate(");
  });
});

describe("every route is behind a session", () => {
  it("checks auth before serving anything but login and the page", () => {
    const gate = SERVER.indexOf("if (!authed(req))");
    const login = SERVER.indexOf('route === "/api/login"');
    const overview = SERVER.indexOf('route === "/api/overview"');
    const wallets = SERVER.indexOf('route === "/api/wallets"');
    const streams = SERVER.indexOf("/^\\/api\\/stream\\/");

    expect(gate).toBeGreaterThan(-1);
    // Login is reachable before the gate; everything else sits after it.
    expect(login).toBeLessThan(gate);
    expect(overview).toBeGreaterThan(gate);
    expect(wallets).toBeGreaterThan(gate);
    expect(streams).toBeGreaterThan(gate);
  });

  it("refuses to start on a weak token rather than opening a guessable door", () => {
    expect(SERVER).toContain("checkTokenStrength");
    expect(SERVER).toContain("return null");
  });

  it("compares the token in constant time", () => {
    // A plain === leaks the token one character at a time.
    expect(SERVER).toContain("secretsMatch");
    expect(SERVER).not.toMatch(/body\.token\s*===/);
  });

  it("rate limits login attempts", () => {
    expect(SERVER).toContain("limiter.lockedFor");
    expect(SERVER).toContain("limiter.recordFailure");
  });
});

describe("the page", () => {
  it("asks for the token as a password field, so it is not shoulder-readable", () => {
    // Asserted by property rather than by element id: the id is a design
    // detail that changed once already, the input type is the actual
    // guarantee.
    expect(UI).toMatch(/type="password"/);
    expect(UI).not.toMatch(/id="tok"[^>]*type="text"/);
  });

  it("sends credentials same-origin only", () => {
    expect(UI).toContain('credentials: "same-origin"');
  });

  it("escapes anything it renders from the server", () => {
    // Labels are user-supplied and end up in innerHTML.
    expect(UI).toContain("const esc =");
    expect(UI).toContain("esc(w.label)");
  });

  it("streams long jobs instead of waiting on one response", () => {
    // The whole reason the web UI exists.
    expect(UI).toContain("EventSource");
    expect(UI).toContain('addEventListener("progress"');
  });

  it("carries the brand rather than default styling", () => {
    // The accent value is the brand; which custom property holds it is not.
    expect(UI).toContain("#F5871F");
    expect(UI).toContain("DM Sans");
    expect(UI).toContain("l00p");
  });

  it("respects a reduced-motion preference", () => {
    expect(UI).toContain("prefers-reduced-motion");
  });

  it("reaches every feature, not just the ones that shipped first", () => {
    for (const view of ["home", "wallets", "copy", "find", "pnl", "sweep", "filter", "settings"]) {
      expect(UI).toContain(`data-v="${view}"`);
    }
  });

  it("marks the current page for assistive tech, not just with colour", () => {
    expect(UI).toContain('aria-current="page"');
  });
});
