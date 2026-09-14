import { describe, it, expect, vi } from "vitest";
import { getAddress } from "ethers";
import {
  AuthorizationError,
  classifyAuthStatus,
  describeSource,
  fetchApiAuthorization,
  parseAuthorizationResponse,
} from "./mint-authorization";

// A signature cannot be derived, at any cost, by anyone. It has to be asked
// for. These pin that asking is done honestly: one request per wallet, the
// answer passed through untouched, and a refusal treated as an answer rather
// than something to retry in a loop.

const ALICE = getAddress("0x" + "aa".repeat(20));
const BOB = getAddress("0x" + "bb".repeat(20));
const SIG = "0x" + "cd".repeat(65);
const PROOF = ["0x" + "11".repeat(32)];

describe("reading a project's answer", () => {
  it("reads a proof, whatever the field is called", () => {
    expect(parseAuthorizationResponse({ merkleProof: PROOF }, ALICE).proof).toEqual(PROOF);
    expect(parseAuthorizationResponse({ hexProof: PROOF }, ALICE).proof).toEqual(PROOF);
  });

  it("reads a signature and the values issued with it", () => {
    const auth = parseAuthorizationResponse(
      { signature: SIG, nonce: 42, allowance: 3, price: "1000" },
      ALICE
    );
    expect(auth.signature).toBe(SIG);
    expect(auth.nonce).toBe(42n);
    expect(auth.allowance).toBe(3n);
    expect(auth.priceWei).toBe(1000n);
  });

  it("looks one level down, where most APIs put the useful part", () => {
    expect(parseAuthorizationResponse({ data: { signature: SIG } }, ALICE).signature).toBe(SIG);
  });

  it("files the answer against the address it was asked for", () => {
    expect(parseAuthorizationResponse({ proof: PROOF }, ALICE).address).toBe(ALICE);
    expect(parseAuthorizationResponse({ proof: PROOF }, BOB).address).toBe(BOB);
  });

  it("treats an explicit refusal as final", () => {
    // Retrying "not eligible" cannot succeed however many times it runs, and
    // spends a rate-limit budget the transient failures need.
    try {
      parseAuthorizationResponse({ eligible: false }, ALICE);
      throw new Error("should have refused");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationError);
      expect((err as AuthorizationError).code).toBe("NOT_ELIGIBLE");
      expect((err as AuthorizationError).retryable).toBe(false);
    }
  });

  it("treats a 200 carrying neither proof nor signature as a refusal", () => {
    // A success with nothing in it is a refusal dressed as one, and signing an
    // empty credential is a guaranteed revert.
    expect(() => parseAuthorizationResponse({ ok: true }, ALICE)).toThrow(
      /neither a proof nor a signature/
    );
  });

  it("rejects a malformed proof entry instead of passing it along", () => {
    expect(() => parseAuthorizationResponse({ proof: ["0x1234"] }, ALICE)).toThrow(/32-byte hash/);
  });

  it("rejects a signature that is not hex bytes", () => {
    expect(() => parseAuthorizationResponse({ signature: "yes please" }, ALICE)).toThrow(/hex bytes/);
  });
});

describe("classifying an HTTP failure by cause", () => {
  it("retries only what can change", () => {
    expect(classifyAuthStatus(429, "").retryable).toBe(true);
    expect(classifyAuthStatus(503, "").retryable).toBe(true);
    expect(classifyAuthStatus(404, "").retryable).toBe(false);
  });

  it("separates 'you may not ask' from 'this wallet may not mint'", () => {
    // The two want opposite handling: one is the operator's problem to fix,
    // the other is a final answer about the wallet.
    expect(classifyAuthStatus(403, "forbidden").code).toBe("UNAUTHORIZED");
    expect(classifyAuthStatus(403, "wallet not eligible").code).toBe("NOT_ELIGIBLE");
  });

  it("reads a 404 as not being on the list", () => {
    expect(classifyAuthStatus(404, "").code).toBe("NOT_ELIGIBLE");
  });

  it("reads 'not open yet' as worth asking again later", () => {
    const e = classifyAuthStatus(400, "mint has not started");
    expect(e.code).toBe("NOT_OPEN");
    expect(e.retryable).toBe(true);
  });
});

describe("asking for one wallet's authorisation", () => {
  const source = { kind: "api" as const, urlTemplate: "https://api.example/auth/{address}?q={quantity}" };

  it("substitutes the wallet into the URL and returns what came back", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      new Response(JSON.stringify({ signature: SIG, nonce: 7 }), { status: 200 })
    ) as unknown as typeof fetch;

    const auth = await fetchApiAuthorization(source, ALICE, { quantity: 2, chainId: 1, fetchImpl });
    expect((fetchImpl as any).mock.calls[0][0]).toBe(`https://api.example/auth/${ALICE}?q=2`);
    expect(auth.signature).toBe(SIG);
    expect(auth.nonce).toBe(7n);
  });

  it("asks separately for each wallet, never reusing one answer", async () => {
    // A credential issued to one address is not a credential for another.
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ proof: PROOF }), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchApiAuthorization(source, ALICE, { quantity: 1, chainId: 1, fetchImpl });
    await fetchApiAuthorization(source, BOB, { quantity: 1, chainId: 1, fetchImpl });
    expect(seen[0]).toContain(ALICE);
    expect(seen[1]).toContain(BOB);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("surfaces the project's refusal as a final answer", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{"error":"not eligible"}', { status: 403 })
    ) as unknown as typeof fetch;

    await expect(
      fetchApiAuthorization(source, ALICE, { quantity: 1, chainId: 1, fetchImpl })
    ).rejects.toMatchObject({ code: "NOT_ELIGIBLE", retryable: false });
  });

  it("reports an unreachable endpoint as retryable, not as ineligible", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(
      fetchApiAuthorization(source, ALICE, { quantity: 1, chainId: 1, fetchImpl })
    ).rejects.toMatchObject({ code: "NETWORK", retryable: true });
  });

  it("POSTs a body when one is configured", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ signature: SIG }), { status: 200 })
    ) as unknown as typeof fetch;

    await fetchApiAuthorization(
      { ...source, bodyTemplate: '{"wallet":"{address}","qty":{quantity}}' },
      ALICE,
      { quantity: 3, chainId: 8453, fetchImpl }
    );
    const init = (fetchImpl as any).mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(`{"wallet":"${ALICE}","qty":3}`);
  });
});

describe("describing where authorisations come from", () => {
  it("never prints the headers, which can carry the operator's key", () => {
    const described = describeSource({
      kind: "api",
      urlTemplate: "https://api.example/{address}",
      headers: { "x-api-key": "super-secret-value" },
    });
    expect(described).not.toContain("super-secret-value");
    expect(described).toContain("https://api.example/{address}");
    expect(described).toContain("1 header");
  });
});
