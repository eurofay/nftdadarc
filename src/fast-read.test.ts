import { describe, it, expect, vi } from "vitest";
import { raceRead, raceReadOrNull } from "./fast-read";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("raceRead", () => {
  it("returns the fastest answer, not the first endpoint's", async () => {
    // The whole point: urls[0] is chosen for scan width, not speed.
    const got = await raceRead(["slow", "fast"], async (url) => {
      await sleep(url === "slow" ? 60 : 5);
      return url;
    });
    expect(got).toBe("fast");
  });

  it("ignores endpoints that reject — send-only ones reject every read", async () => {
    const got = await raceRead(["sequencer", "rpc"], async (url) => {
      if (url === "sequencer") throw new Error("method does not exist");
      await sleep(10);
      return url;
    });
    expect(got).toBe("rpc");
  });

  it("lets a slower endpoint win when the quick one answers null", async () => {
    // null means "couldn't tell us", not "the answer is nothing".
    const got = await raceRead<string | null>(["quick", "slow"], async (url) => {
      if (url === "quick") return null;
      await sleep(15);
      return "real answer";
    });
    expect(got).toBe("real answer");
  });

  it("rejects only when every endpoint fails, and says why", async () => {
    await expect(
      raceRead(["a", "b"], async (url) => {
        throw new Error(`${url} exploded`);
      })
    ).rejects.toThrow(/exploded/);
  });

  it("rejects when all answers are unusable", async () => {
    await expect(raceRead(["a", "b"], async () => null)).rejects.toThrow(/usable/i);
  });

  it("refuses an empty endpoint list rather than hanging", async () => {
    await expect(raceRead([], async () => "x")).rejects.toThrow(/No RPC endpoints/);
  });

  it("does not wait for stragglers once it has an answer", async () => {
    const start = Date.now();
    await raceRead(["slow", "fast"], async (url) => {
      await sleep(url === "slow" ? 500 : 5);
      return url;
    });
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe("raceReadOrNull", () => {
  it("returns null instead of throwing when everything fails", async () => {
    const logger = { info: vi.fn() } as any;
    expect(
      await raceReadOrNull(["a"], async () => {
        throw new Error("down");
      }, logger)
    ).toBeNull();
    expect(logger.info).toHaveBeenCalled();
  });
});
