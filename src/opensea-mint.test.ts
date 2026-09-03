import { describe, it, expect, vi } from "vitest";
import { Wallet, verifyMessage } from "ethers";
import {
  createSiweMessage,
  CookieJar,
  OpenSeaMintClient,
  OpenSeaMintError,
  decodeMintAction,
  classifyGraphqlErrors,
  SIWE_STATEMENT,
} from "./opensea-mint";

const WALLET = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

describe("createSiweMessage", () => {
  const opts = {
    domain: "opensea.io",
    address: WALLET.address,
    uri: "https://opensea.io",
    chainId: 4663,
    nonce: "abc123",
    issuedAt: "2026-09-04T10:00:00.000Z",
  };

  it("produces the exact EIP-4361 layout the verifier expects", () => {
    // Field order and blank lines are load-bearing — a reordered message is a
    // different message and the signature verifies against nothing.
    expect(createSiweMessage(opts)).toBe(
      `opensea.io wants you to sign in with your Ethereum account:\n` +
        `${WALLET.address}\n\n` +
        `${SIWE_STATEMENT}\n\n` +
        `URI: https://opensea.io\n` +
        `Version: 1\n` +
        `Chain ID: 4663\n` +
        `Nonce: abc123\n` +
        `Issued At: 2026-09-04T10:00:00.000Z`
    );
  });

  it("is signable and recovers to the same wallet", async () => {
    const message = createSiweMessage(opts);
    expect(verifyMessage(message, await WALLET.signMessage(message))).toBe(WALLET.address);
  });

  it("changes with the nonce, so a replayed signature is useless", () => {
    expect(createSiweMessage(opts)).not.toBe(createSiweMessage({ ...opts, nonce: "different" }));
  });
});

describe("CookieJar", () => {
  it("keeps each Set-Cookie separate", () => {
    // A joined header corrupts any cookie value containing a comma.
    const jar = new CookieJar();
    const headers = new Headers();
    headers.append("set-cookie", "session=abc; Path=/; HttpOnly");
    headers.append("set-cookie", "csrf=xyz; Path=/");
    jar.absorb(headers);
    expect(jar.size).toBe(2);
    expect(jar.header()).toContain("session=abc");
    expect(jar.header()).toContain("csrf=xyz");
  });

  it("drops attributes, keeping only name=value", () => {
    const jar = new CookieJar();
    const headers = new Headers();
    headers.append("set-cookie", "session=abc; Path=/; Secure; SameSite=Lax");
    jar.absorb(headers);
    expect(jar.header()).toBe("session=abc");
  });

  it("replaces a cookie when it is reissued", () => {
    const jar = new CookieJar();
    const first = new Headers();
    first.append("set-cookie", "session=old");
    jar.absorb(first);
    const second = new Headers();
    second.append("set-cookie", "session=new");
    jar.absorb(second);
    expect(jar.header()).toBe("session=new");
    expect(jar.size).toBe(1);
  });

  it("ignores a malformed line rather than storing junk", () => {
    const jar = new CookieJar();
    const headers = new Headers();
    headers.append("set-cookie", "novalue");
    jar.absorb(headers);
    expect(jar.size).toBe(0);
  });
});

describe("decodeMintAction", () => {
  const tx = { to: "0x00005EA0", data: "0xabcdef", value: "1000" };

  it("returns the transaction, which already carries any signature or proof", () => {
    const out = decodeMintAction({
      swap: { actions: [{ __typename: "TransactionAction", transactionSubmissionData: tx }] },
    });
    expect(out).toEqual({ to: "0x00005EA0", data: "0xabcdef", value: 1000n });
  });

  it("skips non-transaction actions and finds the real one", () => {
    const out = decodeMintAction({
      swap: {
        actions: [
          { __typename: "ApprovalAction" },
          { __typename: "TransactionAction", transactionSubmissionData: tx },
        ],
      },
    });
    expect(out.data).toBe("0xabcdef");
  });

  it("treats a missing value as zero, for a free mint", () => {
    const out = decodeMintAction({
      swap: { actions: [{ transactionSubmissionData: { to: "0x1", data: "0x2" } }] },
    });
    expect(out.value).toBe(0n);
  });

  it("reports swap errors as ineligibility, not a protocol fault", () => {
    expect(() =>
      decodeMintAction({ swap: { actions: [], errors: [{ __typename: "NotEligibleError" }] } })
    ).toThrow(/won't mint this/);
  });

  it("explains an empty action list rather than returning nothing", () => {
    // The common real case: the stage exists but isn't open to this wallet.
    expect(() => decodeMintAction({ swap: { actions: [] } })).toThrow(/isn't open to this wallet/);
  });

  it("rejects an action with no calldata", () => {
    expect(() =>
      decodeMintAction({ swap: { actions: [{ transactionSubmissionData: { to: "0x1" } }] } })
    ).toThrow(/no transaction/i);
  });

  it("fails clearly on a shape it doesn't recognise", () => {
    expect(() => decodeMintAction({})).toThrow(/No mint action/);
  });
});

describe("classifyGraphqlErrors", () => {
  it("separates the cases a caller must act on differently", () => {
    expect(classifyGraphqlErrors([{ message: "Unauthorized" }]).kind).toBe("auth");
    expect(classifyGraphqlErrors([{ message: "rate limit exceeded" }]).kind).toBe("rate-limited");
    expect(classifyGraphqlErrors([{ message: "not eligible for stage" }]).kind).toBe("not-eligible");
    expect(classifyGraphqlErrors([{ message: "something else" }]).kind).toBe("protocol");
  });

  it("carries the original text through, so the cause isn't lost", () => {
    expect(classifyGraphqlErrors([{ message: "weird upstream failure" }]).message).toContain(
      "weird upstream failure"
    );
  });
});

/** A fetch stub that records calls and replies from a script. */
function stubFetch(script: ((url: string, init: RequestInit) => Response)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const step = script[Math.min(i++, script.length - 1)];
    return step(String(url), init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const withCookie = (body: string, extra: Record<string, string> = {}) => {
  const headers = new Headers({ "content-type": "application/json", ...extra });
  headers.append("set-cookie", "session=abc; Path=/");
  return new Response(body, { headers });
};

describe("login", () => {
  it("signs the nonce it was given and keeps the session", async () => {
    const { impl, calls } = stubFetch([
      () => withCookie('"nonce-from-server"'),
      () => withCookie("{}"),
    ]);
    const client = new OpenSeaMintClient({ fetchImpl: impl });
    await client.login(WALLET, 4663);

    expect(client.isAuthenticated).toBe(true);
    const verify = JSON.parse(String(calls[1].init.body));
    expect(verify.message).toContain("nonce-from-server");
    // The signature must recover to this wallet, or the server rejects it.
    expect(verifyMessage(verify.message, verify.signature)).toBe(WALLET.address);
  });

  it("sends the session cookie on later requests", async () => {
    const { impl, calls } = stubFetch([
      () => withCookie('"n"'),
      () => withCookie("{}"),
      () => new Response(JSON.stringify({ data: { dropBySlug: { stages: [] } } })),
    ]);
    const client = new OpenSeaMintClient({ fetchImpl: impl });
    await client.login(WALLET, 4663);
    await client.eligibility("some-slug", WALLET.address);

    expect((calls[2].init.headers as any).cookie).toContain("session=abc");
  });

  it("refuses when no session cookie comes back", async () => {
    const { impl } = stubFetch([
      () => new Response('"n"'),
      () => new Response("{}"), // no set-cookie
    ]);
    const client = new OpenSeaMintClient({ fetchImpl: impl });
    await expect(client.login(WALLET, 4663)).rejects.toThrow(/no session cookie/i);
    expect(client.isAuthenticated).toBe(false);
  });

  it("reports a rejected sign-in as auth, not as a transport fault", async () => {
    const { impl } = stubFetch([
      () => withCookie('"n"'),
      () => new Response("nope", { status: 403 }),
    ]);
    const client = new OpenSeaMintClient({ fetchImpl: impl });
    await expect(client.login(WALLET, 4663)).rejects.toMatchObject({ kind: "auth" });
  });

  it("refuses an empty nonce instead of signing nothing", async () => {
    const { impl } = stubFetch([() => withCookie('""')]);
    const client = new OpenSeaMintClient({ fetchImpl: impl });
    await expect(client.login(WALLET, 4663)).rejects.toThrow(/nonce/i);
  });
});

describe("eligibility", () => {
  it("reports each stage and whether this wallet may mint it", async () => {
    const { impl } = stubFetch([
      () =>
        new Response(
          JSON.stringify({
            data: {
              dropBySlug: {
                stages: [
                  { stageType: "PUBLIC", stageIndex: 0, isEligible: true, maxTotalMintableByWallet: 3 },
                  {
                    stageType: "ALLOWLIST",
                    stageIndex: 1,
                    isEligible: false,
                    eligiblePrice: { token: { unit: "0.01" } },
                  },
                ],
              },
            },
          })
        ),
    ]);
    const stages = await new OpenSeaMintClient({ fetchImpl: impl }).eligibility("s", WALLET.address);
    expect(stages).toHaveLength(2);
    expect(stages[0]).toMatchObject({ stageType: "PUBLIC", isEligible: true, maxTotalMintableByWallet: 3 });
    expect(stages[1]).toMatchObject({ stageType: "ALLOWLIST", isEligible: false, priceUnit: "0.01" });
  });

  it("fails clearly when the collection returns no stages", async () => {
    const { impl } = stubFetch([() => new Response(JSON.stringify({ data: { dropBySlug: null } }))]);
    await expect(
      new OpenSeaMintClient({ fetchImpl: impl }).eligibility("s", WALLET.address)
    ).rejects.toThrow(/No mint stages/);
  });
});

describe("mintCalldata", () => {
  const ok = () =>
    new Response(
      JSON.stringify({
        data: {
          swap: {
            actions: [{ transactionSubmissionData: { to: "0xSeaDrop", data: "0xdeadbeef", value: "5" } }],
          },
        },
      })
    );

  it("asks for the collection paid in the chain's native currency", async () => {
    const { impl, calls } = stubFetch([ok]);
    await new OpenSeaMintClient({ fetchImpl: impl }).mintCalldata({
      address: WALLET.address,
      contractAddress: "0xCollection",
      chainIdentifier: "robinhood",
      tokenId: "0",
      quantity: 2,
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.variables.fromAssets[0].asset.contractAddress).toBe(
      "0x0000000000000000000000000000000000000000"
    );
    expect(body.variables.toAssets[0].quantity).toBe("2");
    expect(body.variables.toAssets[0].asset.contractAddress).toBe("0xCollection");
  });

  it("returns the calldata ready to sign", async () => {
    const { impl } = stubFetch([ok]);
    const out = await new OpenSeaMintClient({ fetchImpl: impl }).mintCalldata({
      address: WALLET.address,
      contractAddress: "0xC",
      chainIdentifier: "robinhood",
      tokenId: "0",
      quantity: 1,
    });
    expect(out).toEqual({ to: "0xSeaDrop", data: "0xdeadbeef", value: 5n });
  });

  it("rejects a non-numeric token id before making a request", async () => {
    const { impl, calls } = stubFetch([ok]);
    await expect(
      new OpenSeaMintClient({ fetchImpl: impl }).mintCalldata({
        address: WALLET.address,
        contractAddress: "0xC",
        chainIdentifier: "robinhood",
        tokenId: "abc",
        quantity: 1,
      })
    ).rejects.toThrow(/numeric/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a zero quantity", async () => {
    const { impl } = stubFetch([ok]);
    await expect(
      new OpenSeaMintClient({ fetchImpl: impl }).mintCalldata({
        address: WALLET.address,
        contractAddress: "0xC",
        chainIdentifier: "robinhood",
        tokenId: "0",
        quantity: 0,
      })
    ).rejects.toThrow(/at least 1/);
  });
});

describe("transport failures", () => {
  it("maps 401 to auth so the caller re-authenticates", async () => {
    const { impl } = stubFetch([() => new Response("", { status: 401 })]);
    await expect(
      new OpenSeaMintClient({ fetchImpl: impl }).eligibility("s", WALLET.address)
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("maps 429 to rate-limited, which is worth backing off rather than retrying", async () => {
    const { impl } = stubFetch([() => new Response("", { status: 429 })]);
    await expect(
      new OpenSeaMintClient({ fetchImpl: impl }).eligibility("s", WALLET.address)
    ).rejects.toMatchObject({ kind: "rate-limited" });
  });

  it("reports a network failure as transport, not as a protocol change", async () => {
    const impl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(
      new OpenSeaMintClient({ fetchImpl: impl }).eligibility("s", WALLET.address)
    ).rejects.toMatchObject({ kind: "transport" });
  });

  it("reports a non-JSON body as protocol, since that means the API moved", async () => {
    const { impl } = stubFetch([() => new Response("<html>maintenance</html>")]);
    await expect(
      new OpenSeaMintClient({ fetchImpl: impl }).eligibility("s", WALLET.address)
    ).rejects.toMatchObject({ kind: "protocol" });
  });
});
