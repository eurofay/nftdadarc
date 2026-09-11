import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger, withPrefix } from "./logger";

describe("createLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("always prints locally regardless of forwarding tier", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger();
    log.info("quiet line");
    log.errorBold("loud line");
    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it("forwards only the bold tiers, because a chat line is a push notification", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const forwarded: string[] = [];
    const log = createLogger((msg) => forwarded.push(msg));

    log.successBold("success bold");
    log.warnBold("warn bold");
    log.errorBold("error bold");

    expect(forwarded).toEqual(["success bold", "warn bold", "error bold"]);
  });

  it("keeps terminal furniture out of the chat", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const forwarded: string[] = [];
    const log = createLogger((msg) => forwarded.push(msg));

    // Furniture is suppressed whoever is listening: a banner, a config dump
    // and per-field commentary mean nothing on a phone. All of it still
    // prints locally, unchanged.
    log.title("-- COPY-MINT WATCHER --");
    log.info("  Chain: Robinhood");
    log.highlight("sighting");

    expect(forwarded).toEqual([]);
  });

  it("still prints every tier locally", () => {
    const printed = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger(() => {});

    log.title("t");
    log.info("i");
    log.done("d");

    expect(printed).toHaveBeenCalledTimes(3);
  });

  it("keeps a requested run's results, since the result is what was asked for", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const forwarded: string[] = [];
    const log = createLogger((msg) => forwarded.push(msg));

    // Consolidation and fund transfer report what they moved through these.
    // Silencing them would mean asking to sweep 200 NFTs and hearing nothing.
    log.success("moved #12");
    log.error("#13 failed");
    log.done("COMPLETE: 199/200 confirmed");

    expect(forwarded).toEqual(["moved #12", "#13 failed", "COMPLETE: 199/200 confirmed"]);
  });

  it("drops everything but headlines for a watcher nobody asked to run", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const forwarded: string[] = [];
    const log = createLogger((msg) => forwarded.push(msg), "headlines");

    log.success("checked a wallet");
    log.error("skipped: price too high");
    log.done("scan complete");
    log.warnBold("copying a mint");
    log.successBold("DISPATCHED 2 tx(s)");

    expect(forwarded).toEqual(["copying a mint", "DISPATCHED 2 tx(s)"]);
  });

  it("strips ANSI color codes before forwarding to the sink", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const forwarded: string[] = [];
    const log = createLogger((msg) => forwarded.push(msg));

    log.errorBold("plain text");
    expect(forwarded[0]).toBe("plain text");
    expect(forwarded[0]).not.toMatch(/\x1b\[/);
  });
});

describe("withPrefix", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prepends the label to every method's output", () => {
    const forwarded: string[] = [];
    const base = createLogger((msg) => forwarded.push(msg));
    const log = withPrefix("robinhood", base);

    log.warnBold("watching");
    log.errorBold("failed");
    log.successBold("stopped");

    expect(forwarded).toEqual(["[robinhood] watching", "[robinhood] failed", "[robinhood] stopped"]);
  });

  it("keeps the quiet tiers quiet — prefixing doesn't change what's forwarded", () => {
    const forwarded: string[] = [];
    const base = createLogger((msg) => forwarded.push(msg));
    const log = withPrefix("ethereum", base);

    log.info("routine");
    log.highlight("routine sighting");
    log.title("banner");

    expect(forwarded).toEqual([]);
  });

  it("distinguishes concurrent chains printing to the same console", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    withPrefix("robinhood").title("running");
    withPrefix("ethereum").title("running");

    expect(logSpy.mock.calls[0][0]).toContain("[robinhood]");
    expect(logSpy.mock.calls[1][0]).toContain("[ethereum]");
  });
});
