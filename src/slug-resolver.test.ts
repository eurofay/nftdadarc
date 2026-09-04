import { describe, it, expect, vi, afterEach } from "vitest";
import { lookupContract, isLookupFailure, openseaContractInfo, isSlug } from "./slug-resolver";

function mockFetch(status: number, body: any) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as any);
}

const OK_BODY = {
  address: "0x54953ce3802fce0c94df335c0d819521cb3ea903",
  chain: "robinhood",
  collection: "glitchy404",
  name: "Glitchy",
};

afterEach(() => vi.restoreAllMocks());

describe("isSlug", () => {
  it("treats anything not starting with 0x as a slug", () => {
    expect(isSlug("glitchy404")).toBe(true);
    expect(isSlug("0x54953ce3802fce0c94df335c0d819521cb3ea903")).toBe(false);
  });
});

describe("lookupContract", () => {
  it("returns the collection when OpenSea knows it", async () => {
    mockFetch(200, OK_BODY);
    const result = await lookupContract("robinhood", OK_BODY.address, "key");
    expect(isLookupFailure(result)).toBe(false);
    expect(result).toMatchObject({ slug: "glitchy404", name: "Glitchy" });
  });

  it("still asks when no key is configured, since unkeyed calls usually succeed", async () => {
    // The old code bailed out before the request, which turned a working
    // public endpoint into "OpenSea has never heard of this collection".
    const fetchSpy = mockFetch(200, OK_BODY);
    const result = await lookupContract("robinhood", OK_BODY.address);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(isLookupFailure(result)).toBe(false);
  });

  it("sends no key header when there is no key", async () => {
    const fetchSpy = mockFetch(200, OK_BODY);
    await lookupContract("robinhood", OK_BODY.address);
    const headers = (fetchSpy.mock.calls[0][1] as any).headers;
    expect(headers).not.toHaveProperty("x-api-key");
  });

  it("sends the key when there is one", async () => {
    const fetchSpy = mockFetch(200, OK_BODY);
    await lookupContract("robinhood", OK_BODY.address, "sekrit");
    expect((fetchSpy.mock.calls[0][1] as any).headers["x-api-key"]).toBe("sekrit");
  });

  it("names the chain in a 404, since the contract may exist elsewhere", async () => {
    mockFetch(404, {});
    const result = await lookupContract("robinhood", OK_BODY.address, "key");
    expect(isLookupFailure(result) && result.detail).toContain("robinhood");
  });

  it("does not blame the key on a 401, because OpenSea 401s unindexed contracts", async () => {
    // Measured: a valid key gets 401 {"errors":["Invalid API key"]} for a
    // contract OpenSea does not index. Telling someone their key is broken
    // sends them to regenerate a working credential.
    mockFetch(401, { errors: ["Invalid API key"] });
    const result = await lookupContract("robinhood", OK_BODY.address, "key");
    expect(isLookupFailure(result) && result.detail).not.toMatch(/invalid/i);
    expect(isLookupFailure(result) && result.detail).toContain("rate-limits");
  });

  it("retries without the key when a keyed request is refused", async () => {
    // Measured live: the keyed request 401s in the same second the unkeyed
    // one returns 200, so the refusal follows the key, not the caller.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) } as any)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => OK_BODY } as any);
    const result = await lookupContract("robinhood", OK_BODY.address, "key");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((fetchSpy.mock.calls[1][1] as any).headers).not.toHaveProperty("x-api-key");
    expect(result).toMatchObject({ slug: "glitchy404" });
  });

  it("tries a key when it had none, since the two are throttled separately", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) } as any)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => OK_BODY } as any);
    const result = await lookupContract("robinhood", OK_BODY.address);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ slug: "glitchy404" });
  });

  it("stops after two attempts rather than hammering a throttled endpoint", async () => {
    // Recovery takes minutes, so a third try would add load and still fail.
    const fetchSpy = mockFetch(401, {});
    const result = await lookupContract("robinhood", OK_BODY.address, "key");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(isLookupFailure(result)).toBe(true);
  });

  it("does not retry a 404, which is a settled answer", async () => {
    const fetchSpy = mockFetch(404, {});
    await lookupContract("robinhood", OK_BODY.address, "key");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("separates a known contract with no collection from a failed lookup", async () => {
    mockFetch(200, { address: OK_BODY.address, chain: "robinhood" });
    const result = await lookupContract("robinhood", OK_BODY.address, "key");
    expect(isLookupFailure(result) && result.detail).toContain("not put it in a collection");
  });

  it("reports a network failure rather than throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    const result = await lookupContract("robinhood", OK_BODY.address, "key");
    expect(isLookupFailure(result) && result.status).toBe(null);
    expect(isLookupFailure(result) && result.detail).toContain("ECONNRESET");
  });

  it("falls back to the slug when the contract has no name", async () => {
    mockFetch(200, { collection: "glitchy404" });
    const result = await lookupContract("robinhood", OK_BODY.address, "key");
    expect(result).toMatchObject({ name: "glitchy404" });
  });
});

describe("openseaContractInfo", () => {
  it("flattens any failure to null for callers that only decorate a log", async () => {
    mockFetch(500, {});
    expect(await openseaContractInfo("robinhood", OK_BODY.address, "key")).toBe(null);
  });

  it("returns the collection on success", async () => {
    mockFetch(200, OK_BODY);
    expect(await openseaContractInfo("robinhood", OK_BODY.address, "key")).toMatchObject({
      slug: "glitchy404",
    });
  });

  it("works without a key, unlike the version that gated on one", async () => {
    mockFetch(200, OK_BODY);
    expect(await openseaContractInfo("robinhood", OK_BODY.address)).toMatchObject({ slug: "glitchy404" });
  });
});
