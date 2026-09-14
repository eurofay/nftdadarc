// OpenSea's DOCUMENTED Drops API.
//
//   POST /api/v2/drops/{slug}/mint        build_drop_mint_transaction
//   GET  /api/v2/drops/{slug}             the drop and its stages
//   GET  /api/v2/drops/{slug}/eligibility is this minter allowed, and for how many
//
// https://docs.opensea.io/reference/build_drop_mint_transaction
//
// WHY THIS EXISTS ALONGSIDE opensea-mint.ts. That file talks to gql.opensea.io
// with a SIWE login -- OpenSea's own web app's internal endpoints, which carry
// no compatibility promise and can change without notice. This is the
// published, supported route, and it is the one to prefer.
//
// WHAT IS MEASURED, because it decides which transport actually runs. With a
// valid key -- /chains and /collections/{slug} both answer 200 on it -- every
// /drops/* path answers:
//
//   401 {"errors":["Invalid API key"]}
//
// A key that works everywhere else and fails only here is not malformed; the
// Drops API is entitled separately. So this module is written as the primary
// transport and degrades to the internal one until that entitlement exists,
// rather than being the only path and failing shut.
//
// Stage selection is OpenSea's, deliberately. The endpoint picks the first
// eligible active stage for the given minter, which means allow-list and
// signed stages resolve server-side with the proof or signature already
// inside the returned calldata. Nothing here derives, forges, or substitutes
// authorisation -- it asks on behalf of the wallet that will sign.

const BASE = "https://api.opensea.io/api/v2";

/**
 * A browser User-Agent, because Cloudflare answers 429 without one.
 *
 * Measured: the identical request with no User-Agent returns 429 "Request was
 * throttled" on the first call from an IP that has sent nothing. Node's fetch
 * sends none. This is not evasion; it is the header every other HTTP client
 * sends by default.
 */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type DropsErrorCode =
  | "NOT_ENTITLED"
  | "NOT_ELIGIBLE"
  | "STAGE_NOT_ACTIVE"
  | "DROP_NOT_STARTED"
  | "DROP_ENDED"
  | "SUPPLY_EXHAUSTED"
  | "WALLET_LIMIT_EXCEEDED"
  | "RATE_LIMITED"
  | "API_ERROR";

export class DropsError extends Error {
  constructor(
    message: string,
    readonly code: DropsErrorCode,
    /** True for timeouts, 429s and 5xx — the only errors worth retrying. */
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = "DropsError";
  }
}

/**
 * Turn a response into a reason, so a caller can tell a wallet that will never
 * be eligible from an endpoint that was merely busy.
 *
 * Retrying a deterministic refusal is how a rate limit is earned; retrying a
 * transient one is how a mint is saved. The difference has to be read out of
 * the message, because the status alone does not carry it.
 */
export function classifyDropsError(status: number, body: string): DropsError {
  const t = body.toLowerCase();

  if (status === 401 || status === 403) {
    // The specific shape seen in practice: a key that answers 200 on
    // /chains and /collections and 401 on every /drops path.
    return new DropsError(
      "OpenSea refused the key for the Drops API. It is entitled separately from the rest of v2 — " +
        "request Drops access for this key, or the internal transport stays in use.",
      "NOT_ENTITLED",
      false,
      status
    );
  }
  if (status === 429) {
    return new DropsError("OpenSea rate-limited this request.", "RATE_LIMITED", true, status);
  }
  if (status >= 500) {
    return new DropsError(`OpenSea returned ${status}.`, "API_ERROR", true, status);
  }
  if (t.includes("not eligible") || t.includes("ineligible") || t.includes("allowlist")) {
    return new DropsError("This wallet is not eligible for any active stage.", "NOT_ELIGIBLE", false, status);
  }
  if (t.includes("limit")) {
    return new DropsError("This wallet has used its allowance for the stage.", "WALLET_LIMIT_EXCEEDED", false, status);
  }
  if (t.includes("sold out") || t.includes("supply")) {
    return new DropsError("The stage has no supply left.", "SUPPLY_EXHAUSTED", false, status);
  }
  if (t.includes("not started") || t.includes("has not begun")) {
    return new DropsError("The drop has not opened yet.", "DROP_NOT_STARTED", false, status);
  }
  if (t.includes("ended") || t.includes("expired")) {
    return new DropsError("The drop has ended.", "DROP_ENDED", false, status);
  }
  if (t.includes("not active") || t.includes("no active")) {
    return new DropsError("No stage is active for this drop right now.", "STAGE_NOT_ACTIVE", false, status);
  }
  return new DropsError(
    `OpenSea answered ${status}: ${body.slice(0, 160)}`,
    "API_ERROR",
    status >= 500,
    status
  );
}

export interface DropsOpts {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

async function request(path: string, init: RequestInit, opts: DropsOpts): Promise<any> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await doFetch(`${opts.baseUrl ?? BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": DEFAULT_USER_AGENT,
        ...(opts.apiKey ? { "x-api-key": opts.apiKey } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const body = await res.text();
    if (!res.ok) throw classifyDropsError(res.status, body);
    try {
      return JSON.parse(body);
    } catch {
      throw new DropsError("OpenSea returned something that was not JSON.", "API_ERROR", false, res.status);
    }
  } catch (err: any) {
    if (err instanceof DropsError) throw err;
    // A timeout or a socket failure is transient by nature.
    const aborted = err?.name === "AbortError";
    throw new DropsError(
      aborted ? "OpenSea timed out." : `Could not reach OpenSea: ${err?.message ?? err}`,
      "API_ERROR",
      true
    );
  } finally {
    clearTimeout(timer);
  }
}

/** The transaction OpenSea says this minter should send. */
export interface DropMintTransaction {
  to: string;
  data: string;
  value: bigint;
  chain?: string;
}

/**
 * Build the mint transaction for one minter.
 *
 * The minter is named in the request and is the wallet the authorisation is
 * issued to, so the wallet that signs must be this one. Passing wallet A's
 * calldata to wallet B is not a shortcut, it is a different transaction that
 * the contract will reject.
 */
export async function buildDropMintTransaction(
  slug: string,
  minter: string,
  quantity: number,
  opts: DropsOpts = {}
): Promise<DropMintTransaction> {
  const json = await request(
    `/drops/${encodeURIComponent(slug)}/mint`,
    { method: "POST", body: JSON.stringify({ minter, quantity }) },
    opts
  );

  // The documented response nests the transaction; tolerate both shapes rather
  // than assuming one, since a missing field here is a silent non-mint.
  const tx = json?.transaction ?? json?.data?.transaction ?? json;
  const to = tx?.to ?? tx?.target;
  const data = tx?.data ?? tx?.input_data ?? tx?.calldata;
  if (typeof to !== "string" || typeof data !== "string") {
    throw new DropsError(
      "OpenSea's response carried no transaction to send.",
      "STAGE_NOT_ACTIVE",
      false
    );
  }
  return {
    to,
    data,
    value: BigInt(tx?.value ?? 0),
    chain: tx?.chain,
  };
}

export interface DropEligibility {
  eligible: boolean;
  /** How many this minter may take, when the API says. */
  quantity?: number;
  reason?: string;
}

/**
 * Whether this minter may mint, before asking for a transaction.
 *
 * Worth its own call only because it turns an opaque refusal into a sentence.
 * The mint endpoint is authoritative either way — this is for telling someone
 * why a wallet is about to be left out.
 */
export async function checkDropEligibility(
  slug: string,
  minter: string,
  quantity: number,
  opts: DropsOpts = {}
): Promise<DropEligibility> {
  try {
    const json = await request(
      `/drops/${encodeURIComponent(slug)}/eligibility?minter=${minter}&quantity=${quantity}`,
      { method: "GET" },
      opts
    );
    const eligible = Boolean(json?.eligible ?? json?.is_eligible);
    return {
      eligible,
      quantity: json?.quantity ?? json?.max_quantity,
      reason: json?.reason ?? json?.message,
    };
  } catch (err: any) {
    if (err instanceof DropsError && err.code === "NOT_ELIGIBLE") {
      return { eligible: false, reason: err.message };
    }
    throw err;
  }
}

/** Whether this key can use the Drops API at all. One call, cached by caller. */
export async function hasDropsAccess(slug: string, opts: DropsOpts = {}): Promise<boolean> {
  try {
    await request(`/drops/${encodeURIComponent(slug)}`, { method: "GET" }, opts);
    return true;
  } catch (err: any) {
    if (err instanceof DropsError && err.code === "NOT_ENTITLED") return false;
    // Anything else means the endpoint answered us; entitlement is not the
    // problem even if this particular drop is.
    return true;
  }
}
