// Getting a wallet's legitimate authorisation to mint a gated stage.
//
// Two gates, two completely different kinds of credential, and conflating them
// is why the gated path has been unreliable:
//
//   MERKLE  the contract holds a ROOT. A proof is MATHS over a list the
//           project published. Nobody issues it and nobody can withhold it --
//           anyone holding the list can compute one. See generic-merkle.ts.
//
//   SIGNED  the contract holds a SIGNER ADDRESS. The credential is a
//           SIGNATURE from a key only the project has. It cannot be derived
//           from anything, at any cost, by anyone. It must be ASKED FOR.
//
// This file asks. It talks to the endpoint the operator points it at -- the
// project's own mint API, the one its website calls -- and passes what comes
// back through untouched.
//
// WHAT IT WILL NOT DO, stated plainly because the distinction is the whole
// point of the module. It does not construct signatures. It does not alter
// signed parameters, because every one of them is covered by the signature and
// changing any is what makes a signature invalid. It does not retry a refusal
// as though it were a network error -- "this wallet is not on the list" is an
// answer, and asking again in a loop is just rate-limit abuse that produces
// the same answer. And it never uses one wallet's response for another wallet:
// each address gets its own request, and the response is filed against the
// address it was requested for.
//
// REFRESHING. Some projects issue authorisations with a deadline in them. Where
// the response says when it expires, that is recorded, and the mint path
// re-asks in the pre-roll rather than firing something already dead -- the same
// window local-mint.ts already uses for its round-trip measurement, so it costs
// nothing that was not being spent.

import { getAddress } from "ethers";
import { WalletAuthorization } from "./mint-spec";

export type AuthErrorCode =
  /** The project says this wallet is not eligible. Final; retrying cannot help. */
  | "NOT_ELIGIBLE"
  /** The endpoint refused us, not the wallet -- a key, a header, a referer check. */
  | "UNAUTHORIZED"
  /** Throttled. Worth another go. */
  | "RATE_LIMITED"
  /** The stage is not open for authorisation yet. Worth another go later. */
  | "NOT_OPEN"
  /** Reached it, could not understand the answer. */
  | "BAD_RESPONSE"
  /** Could not reach it. */
  | "NETWORK";

export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly code: AuthErrorCode,
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/** Where one wallet's authorisation comes from. */
export type AuthSource =
  | {
      kind: "list";
      /** A published allow list: https, ipfs, or a local file path. */
      uri: string;
    }
  | {
      kind: "api";
      /**
       * The project's endpoint, with {address} substituted per wallet.
       * {quantity} and {chainId} are substituted too where present.
       */
      urlTemplate: string;
      method?: "GET" | "POST";
      /**
       * Sent as-is. May carry a key the project issued to the operator, so it
       * is never logged -- see describeSource, which prints the URL shape and
       * nothing else.
       */
      headers?: Record<string, string>;
      /** JSON body template for POST, with the same substitutions. */
      bodyTemplate?: string;
    };

const substitute = (
  template: string,
  vars: { address: string; quantity: number; chainId: number }
): string =>
  template
    .replace(/\{address\}/gi, vars.address)
    .replace(/\{quantity\}/gi, String(vars.quantity))
    .replace(/\{chainId\}/gi, String(vars.chainId));

/**
 * Pull an authorisation out of whatever shape the project's API returned.
 *
 * Field names vary per project and there is no standard, so the spellings seen
 * in the wild are all accepted. What is NOT flexible is the requirement that
 * something usable came back: a 200 carrying no proof and no signature is a
 * refusal dressed as a success, and treating it as one avoids signing an empty
 * credential.
 */
export function parseAuthorizationResponse(
  body: unknown,
  address: string
): WalletAuthorization {
  const root = (body ?? {}) as Record<string, unknown>;
  // Most APIs wrap the useful part one level down.
  const d = ((root.data ?? root.result ?? root.payload ?? root) ?? {}) as Record<string, unknown>;

  const pick = (...names: string[]): unknown => {
    for (const n of names) {
      if (d[n] !== undefined && d[n] !== null) return d[n];
      if (root[n] !== undefined && root[n] !== null) return root[n];
    }
    return undefined;
  };

  // An explicit refusal, however the project spelled it.
  const eligible = pick("eligible", "isEligible", "allowed", "canMint");
  if (eligible === false) {
    throw new AuthorizationError(
      `The project's API says ${address} is not eligible for this stage.`,
      "NOT_ELIGIBLE",
      false
    );
  }

  const rawProof = pick("proof", "merkleProof", "hexProof", "proofs");
  let proof: string[] | undefined;
  if (Array.isArray(rawProof)) {
    proof = rawProof.map((n, i) => {
      if (typeof n !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(n)) {
        throw new AuthorizationError(
          `Proof entry ${i} isn't a 32-byte hash.`,
          "BAD_RESPONSE",
          false
        );
      }
      return n;
    });
  }

  const rawSig = pick("signature", "sig", "signedMessage", "voucher");
  let signature: string | undefined;
  if (typeof rawSig === "string") {
    if (!/^0x[0-9a-fA-F]+$/.test(rawSig) || rawSig.length < 10) {
      throw new AuthorizationError("The signature returned isn't hex bytes.", "BAD_RESPONSE", false);
    }
    signature = rawSig;
  }

  if (!proof && !signature) {
    throw new AuthorizationError(
      `The project's API answered for ${address} but returned neither a proof nor a signature.`,
      "BAD_RESPONSE",
      false
    );
  }

  const num = (...names: string[]): bigint | undefined => {
    const v = pick(...names);
    if (v === undefined || v === null || v === "") return undefined;
    try {
      return BigInt(v as never);
    } catch {
      return undefined;
    }
  };

  return {
    address: getAddress(address),
    proof,
    signature,
    allowance: num("allowance", "maxMint", "maxQuantity", "limit", "amount"),
    nonce: num("nonce", "deadline", "expiry", "expiresAt", "timestamp", "salt"),
    priceWei: num("price", "priceWei", "pricePerToken", "cost"),
    source: "the project's authorisation API",
  };
}

/** Classify an HTTP failure by cause, so only what can change is retried. */
export function classifyAuthStatus(status: number, bodyText: string): AuthorizationError {
  const t = bodyText.toLowerCase();
  if (status === 429) {
    return new AuthorizationError("The project's API is rate-limiting us.", "RATE_LIMITED", true, status);
  }
  if (status >= 500) {
    return new AuthorizationError(`The project's API returned ${status}.`, "NETWORK", true, status);
  }
  if (status === 401 || status === 403) {
    // A 403 can mean either "you may not ask" or "this wallet may not mint",
    // and the two want opposite handling, so the body decides where it can.
    if (/not eligible|not on the|no allocation|ineligible/.test(t)) {
      return new AuthorizationError(
        "The project's API says this wallet is not eligible.",
        "NOT_ELIGIBLE",
        false,
        status
      );
    }
    return new AuthorizationError(
      `The project's API rejected the request itself (${status}) rather than the wallet. ` +
        "It may need a key or a header its own site sends.",
      "UNAUTHORIZED",
      false,
      status
    );
  }
  if (status === 404) {
    return new AuthorizationError(
      "The project's API has nothing for this wallet -- usually meaning it is not on the list.",
      "NOT_ELIGIBLE",
      false,
      status
    );
  }
  if (/not started|not open|not live|too early/.test(t)) {
    return new AuthorizationError(
      "The project's API will not authorise this stage yet.",
      "NOT_OPEN",
      true,
      status
    );
  }
  return new AuthorizationError(`The project's API returned ${status}.`, "BAD_RESPONSE", false, status);
}

export interface FetchAuthOpts {
  quantity: number;
  chainId: number;
  timeoutMs?: number;
  /** Injectable so the path is testable without a live project API. */
  fetchImpl?: typeof fetch;
}

/**
 * One wallet's authorisation from the project's own endpoint.
 *
 * One request per wallet, filed against the address it was made for. Nothing
 * is cached across wallets: a credential issued to one address is not a
 * credential for another, and reusing it would produce a transaction the
 * contract rejects.
 */
export async function fetchApiAuthorization(
  source: Extract<AuthSource, { kind: "api" }>,
  address: string,
  opts: FetchAuthOpts
): Promise<WalletAuthorization> {
  const addr = getAddress(address);
  const vars = { address: addr, quantity: opts.quantity, chainId: opts.chainId };
  const url = substitute(source.urlTemplate, vars);
  const doFetch = opts.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const method = source.method ?? (source.bodyTemplate ? "POST" : "GET");
    const res = await doFetch(url, {
      method,
      signal: controller.signal,
      headers: {
        // Some project APIs refuse a request with no browser-shaped headers.
        // Sent so a legitimate request is not mistaken for a scraper -- not to
        // evade a limit, which is what the retry policy above is careful about.
        accept: "application/json",
        ...(source.bodyTemplate ? { "content-type": "application/json" } : {}),
        ...source.headers,
      },
      body: source.bodyTemplate ? substitute(source.bodyTemplate, vars) : undefined,
    });

    if (!res.ok) {
      throw classifyAuthStatus(res.status, await res.text().catch(() => ""));
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new AuthorizationError(
        "The project's API answered with something that isn't JSON.",
        "BAD_RESPONSE",
        false,
        res.status
      );
    }
    return parseAuthorizationResponse(json, addr);
  } catch (err) {
    if (err instanceof AuthorizationError) throw err;
    const msg = (err as Error)?.message ?? String(err);
    throw new AuthorizationError(
      `Could not reach the project's authorisation API: ${msg}`,
      "NETWORK",
      true
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The endpoint shape, with no secrets in it.
 *
 * Headers can carry a key the project issued to the operator, and a log line
 * is the easiest place in the world to leak one, so only the URL template is
 * ever printed -- and the address is left as a placeholder rather than
 * substituted, since the point is to show the shape.
 */
export function describeSource(source: AuthSource): string {
  if (source.kind === "list") return `published allow list at ${source.uri}`;
  const method = source.method ?? (source.bodyTemplate ? "POST" : "GET");
  const headerNames = Object.keys(source.headers ?? {});
  const auth = headerNames.length > 0 ? ` (+${headerNames.length} header(s))` : "";
  return `${method} ${source.urlTemplate}${auth}`;
}
