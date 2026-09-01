import { describe, it, expect, vi, afterEach } from "vitest";
import { shouldPing, startWarmKeeper, HOT_WINDOW_MS, WARM_PING_MS } from "./connection-warmer";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("shouldPing", () => {
  it("stays quiet while the target is far off", () => {
    // Pinging through a multi-hour wait would be thousands of pointless
    // requests to someone else's node.
    expect(shouldPing(6 * 60 * 60 * 1000)).toBe(false);
    expect(shouldPing(HOT_WINDOW_MS + 1)).toBe(false);
  });

  it("starts once inside the window that decides the race", () => {
    expect(shouldPing(HOT_WINDOW_MS)).toBe(true);
    expect(shouldPing(5_000)).toBe(true);
    expect(shouldPing(0)).toBe(true);
  });

  it("pings below Node's idle keep-alive timeout, or the socket dies anyway", () => {
    expect(WARM_PING_MS).toBeLessThan(4_000);
  });
});

describe("startWarmKeeper", () => {
  it("does nothing without a target — an immediate fire is already warm", () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const stop = startWarmKeeper(["https://example.com"], null);
    stop();
    expect(spy).not.toHaveBeenCalled();
  });

  it("holds every endpoint open once inside the window", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 })
    );
    const urls = ["https://a.example", "https://b.example"];
    const stop = startWarmKeeper(urls, Date.now() + 10_000, { pingMs: 1_000, hotWindowMs: 60_000 });

    await vi.advanceTimersByTimeAsync(3_500);
    stop();

    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(urls.length * 3);
    // Both endpoints, not just the first.
    const hit = new Set(spy.mock.calls.map((c) => String(c[0])));
    expect(hit).toEqual(new Set(urls));
  });

  it("stays silent while the target is outside the window", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const stop = startWarmKeeper(["https://a.example"], Date.now() + 3_600_000, {
      pingMs: 1_000,
      hotWindowMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    stop();
    expect(spy).not.toHaveBeenCalled();
  });

  it("stops on request, so nothing races the real transaction for the socket", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const stop = startWarmKeeper(["https://a.example"], Date.now() + 10_000, { pingMs: 1_000 });
    await vi.advanceTimersByTimeAsync(2_500);
    const before = spy.mock.calls.length;
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spy.mock.calls.length).toBe(before);
  });

  it("goes quiet once the target has passed", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const stop = startWarmKeeper(["https://a.example"], Date.now() - 1_000, { pingMs: 500 });
    await vi.advanceTimersByTimeAsync(2_000);
    stop();
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps going when an endpoint is down — it may be up at fire time", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const stop = startWarmKeeper(["https://a.example"], Date.now() + 10_000, { pingMs: 1_000 });
    await vi.advanceTimersByTimeAsync(3_500);
    stop();
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
