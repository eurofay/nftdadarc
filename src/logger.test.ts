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

  it("forwards headline events (errorBold, successBold, warnBold, done, title) to the sink", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const forwarded: string[] = [];
    const log = createLogger((msg) => forwarded.push(msg));

    log.title("title");
    log.successBold("success bold");
    log.warnBold("warn bold");
    log.errorBold("error bold");
    log.done("done");
    log.success("success");
    log.warn("warn");
    log.error("error");
    log.raw("raw");

    expect(forwarded).toEqual([
      "title",
      "success bold",
      "warn bold",
      "error bold",
      "done",
      "success",
      "warn",
      "error",
      "raw",
    ]);
  });

  it("does not forward the high-volume info/highlight tiers to the sink", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const forwarded: string[] = [];
    const log = createLogger((msg) => forwarded.push(msg));

    log.info("routine detail");
    log.highlight("routine sighting");

    expect(forwarded).toEqual([]);
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

    log.title("watching");
    log.errorBold("failed");
    log.done("stopped");

    expect(forwarded).toEqual(["[robinhood] watching", "[robinhood] failed", "[robinhood] stopped"]);
  });

  it("keeps the quiet tiers quiet — prefixing doesn't change what's forwarded", () => {
    const forwarded: string[] = [];
    const base = createLogger((msg) => forwarded.push(msg));
    const log = withPrefix("ethereum", base);

    log.info("routine");
    log.highlight("routine sighting");

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
