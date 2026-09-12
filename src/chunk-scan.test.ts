import { describe, it, expect, vi } from "vitest";
import { chunksOf, runChunks, DEFAULT_CONCURRENCY } from "./chunk-scan";

describe("chunksOf", () => {
  it("walks newest first, so a capped scan keeps the recent end", () => {
    const out = chunksOf(0, 100, 40);
    expect(out[0]).toEqual({ from: 61, to: 100 });
    expect(out[out.length - 1].from).toBe(0);
  });

  it("covers the range exactly, with no gap and no overlap", () => {
    const out = chunksOf(10, 99, 25);
    const covered = new Set<number>();
    for (const r of out) for (let b = r.from; b <= r.to; b++) covered.add(b);
    expect(covered.size).toBe(90);
    expect(Math.min(...covered)).toBe(10);
    expect(Math.max(...covered)).toBe(99);
  });

  it("returns one chunk when the span fits inside it", () => {
    expect(chunksOf(0, 50, 1000)).toEqual([{ from: 0, to: 50 }]);
  });
});

describe("runChunks", () => {
  const ok = async (r: { from: number; to: number }) => [r.from];

  it("keeps chunk order however the requests finish", async () => {
    // A "first N" cap that returned different data each run because the
    // network reordered it would be worse than no cap at all.
    const out = await runChunks(chunksOf(0, 99, 10), async (r) => {
      await new Promise((res) => setTimeout(res, r.from % 30));
      return [r.to];
    });
    expect(out.results).toEqual([...out.results].sort((a, b) => b - a));
  });

  it("runs several at once rather than one at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    await runChunks(
      chunksOf(0, 99, 10),
      async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return [1];
      },
      { concurrency: 3 }
    );
    expect(peak).toBe(3);
  });

  it("retries a chunk before giving up on it", async () => {
    // Parallel requests reach a public node's throttle far sooner than serial
    // ones. Without this the first version returned a third of the data with
    // no error at all.
    let calls = 0;
    const out = await runChunks(
      [{ from: 0, to: 10 }],
      async () => {
        if (++calls < 3) throw new Error("rate limited");
        return [42];
      },
      { retries: 3 }
    );
    expect(out.results).toEqual([42]);
    expect(out.failed).toBe(0);
  });

  it("counts a chunk it could not get, rather than silently dropping it", async () => {
    const out = await runChunks(
      chunksOf(0, 19, 10),
      async (r) => {
        if (r.from === 0) throw new Error("gone");
        return [r.to];
      },
      { retries: 1 }
    );
    expect(out.failed).toBe(1);
    expect(out.results).toHaveLength(1);
  });

  it("stops starting work once the cap is reached", async () => {
    const seen = vi.fn(async () => [1, 2, 3, 4, 5]);
    const out = await runChunks(chunksOf(0, 999, 10), seen, { maxResults: 10, concurrency: 1 });
    expect(out.results.length).toBeGreaterThanOrEqual(10);
    expect(seen.mock.calls.length).toBeLessThan(10);
  });

  it("honours a stop signal", async () => {
    let stop = false;
    const out = await runChunks(
      chunksOf(0, 999, 10),
      async (r) => {
        stop = true;
        return [r.to];
      },
      { shouldStop: () => stop, concurrency: 1 }
    );
    expect(out.results).toHaveLength(1);
  });

  it("does nothing gracefully with no ranges", async () => {
    expect(await runChunks([], ok)).toEqual({ results: [], failed: 0 });
  });

  it("defaults to a concurrency the endpoint can stand", () => {
    // Measured: six at once was 3.5x faster than serial, but sustained load at
    // that rate got throttled. Three keeps most of the gain with headroom for
    // the rest of the bot sharing the endpoint.
    expect(DEFAULT_CONCURRENCY).toBe(3);
  });
});
