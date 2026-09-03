// Minting stages whose permission is not on-chain.
//
// Everywhere else in this repo a mint is built from chain state alone, which is
// what lets it be pre-signed and fired in one round trip. That works for a
// public stage and only a public stage: an allow list keeps its proof
// off-chain, and a signed stage keeps its signature on the project's server.
// Reading the chain produces neither.
//
// There is one route to both, and it is the route a browser takes. The wallet
// signs a standard SIWE login message — proving it owns the address, and
// authorising no spend — and OpenSea then answers, for that wallet, which
// stages it is eligible for and what transaction to send. For a signed stage
// the signature arrives already inside that calldata, issued by OpenSea to a
// wallet it has decided is eligible.
//
// Nothing here forges or derives a credential; it asks, as the owner, for
// something the owner is entitled to. Ported from the user's own OSNM-Z Rust
// CLI, which does the same thing.
//
// Two caveats that belong beside the code. These are internal endpoints
// (/__api/, GraphQL) with no compatibility promise, so every response is
// validated and a mismatch is reported rather than guessed around. And
// automated access may sit outside OpenSea's terms — the operator's call, and
// the reason this is owner-only in the bot.

import { Wallet } from "ethers";

export const SIWE_STATEMENT =
  "Click to sign in and accept the OpenSea Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).";

export const DEFAULT_ORIGIN = "https://opensea.io";
export const DEFAULT_GRAPHQL_URL = "https://gql.opensea.io/graphql";
export const DEFAULT_APP_ID = "os2-web";

/** EIP-4361 layout, field order included — the verifier is strict about it. */
export function createSiweMessage(opts: {
  domain: string;
  address: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
}): string {
  return (
    `${opts.domain} wants you to sign in with your Ethereum account:\n` +
    `${opts.address}\n\n` +
    `${SIWE_STATEMENT}\n\n` +
    `URI: ${opts.uri}\n` +
    `Version: 1\n` +
    `Chain ID: ${opts.chainId}\n` +
    `Nonce: ${opts.nonce}\n` +
    `Issued At: ${opts.issuedAt}`
  );
}

export interface EligibleStage {
  stageType: string;
  stageIndex: number;
  isEligible: boolean;
  maxTotalMintableByWallet: number | null;
  eligibleMaxTotalMintableByWallet: number | null;
  /** Price per item in the chain's native unit, as a decimal string. */
  priceUnit: string | null;
}

export interface MintCalldata {
  to: string;
  data: string;
  value: bigint;
}

export class OpenSeaMintError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "rate-limited" | "not-eligible" | "protocol" | "transport"
  ) {
    super(message);
    this.name = "OpenSeaMintError";
  }
}

/**
 * Cookies, kept by hand.
 *
 * Node's fetch has no cookie jar, and the session established by SIWE
 * verification is carried in one, so it is captured from set-cookie and
 * replayed. Only name=value is kept; the attributes are a browser's business.
 */
export class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(headers: Headers): void {
    // getSetCookie keeps multiple Set-Cookie headers separate. A plain get()
    // joins them with commas, which corrupts any cookie value containing one.
    const raw =
      typeof (headers as any).getSetCookie === "function"
        ? ((headers as any).getSetCookie() as string[])
        : headers.get("set-cookie")
          ? [headers.get("set-cookie") as string]
          : [];
    for (const line of raw) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  get size(): number {
    return this.jar.size;
  }
}

const ELIGIBILITY_QUERY = `
query DropEligibilityQuery($collectionSlug: String!, $address: Address!) {
  dropBySlug(slug: $collectionSlug) {
    __typename
    ... on Erc721SeaDropV1 { minterQuantityMinted(minter: $address) }
    stages {
      __typename
      stageType
      stageIndex
      isEligible
      eligibleMinterAddress
      maxTotalMintableByWallet
      eligibleMaxTotalMintableByWallet
      eligiblePrice { usd token { unit symbol contractAddress chain { identifier } } }
    }
  }
}`;

const MINT_ACTION_QUERY = `
query MintActionTimelineQuery(
  $address: Address!
  $fromAssets: [AssetQuantityInput!]!
  $toAssets: [AssetQuantityInput!]!
  $recipient: Address
) {
  swap(address: $address, fromAssets: $fromAssets, toAssets: $toAssets, recipient: $recipient, action: MINT) {
    actions {
      __typename
      ... on TransactionAction {
        transactionSubmissionData { to data value chain { networkId identifier } }
      }
    }
    errors { __typename }
  }
}`;

/** The chain's own currency, denoted by the zero address. */
const NATIVE_CURRENCY = "0x0000000000000000000000000000000000000000";

export interface ClientOpts {
  origin?: string;
  graphqlUrl?: string;
  appId?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class OpenSeaMintClient {
  private readonly origin: string;
  private readonly graphqlUrl: string;
  private readonly appId: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => Date;
  private readonly cookies = new CookieJar();
  private authenticated = false;

  constructor(opts: ClientOpts = {}) {
    this.origin = opts.origin ?? DEFAULT_ORIGIN;
    this.graphqlUrl = opts.graphqlUrl ?? DEFAULT_GRAPHQL_URL;
    this.appId = opts.appId ?? DEFAULT_APP_ID;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  get isAuthenticated(): boolean {
    return this.authenticated;
  }

  /**
   * Sign in as this wallet.
   *
   * The signature proves ownership of the address and nothing more — it moves
   * no funds and approves no spend. It is the message the website asks for.
   */
  async login(wallet: Wallet, chainId: number): Promise<void> {
    const nonceRes = await this.request(`${this.origin}/__api/auth/siwe/nonce`, { method: "GET" });
    const nonce = (await nonceRes.text()).trim().replace(/^"|"$/g, "");
    if (!nonce) throw new OpenSeaMintError("No login nonce was issued.", "protocol");

    const message = createSiweMessage({
      domain: new URL(this.origin).host,
      address: wallet.address,
      uri: this.origin,
      chainId,
      nonce,
      issuedAt: this.now().toISOString(),
    });

    const verify = await this.request(`${this.origin}/__api/auth/siwe/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        signature: await wallet.signMessage(message),
        address: wallet.address,
      }),
    });
    if (!verify.ok) {
      throw new OpenSeaMintError(`Sign-in was rejected (HTTP ${verify.status}).`, "auth");
    }
    if (this.cookies.size === 0) {
      throw new OpenSeaMintError("Sign-in returned no session cookie.", "protocol");
    }
    this.authenticated = true;
  }

  /** Which stages this wallet may mint, and at what price. */
  async eligibility(slug: string, address: string): Promise<EligibleStage[]> {
    const data = await this.graphql<any>("DropEligibilityQuery", ELIGIBILITY_QUERY, {
      collectionSlug: slug,
      address,
    });
    const stages = data?.dropBySlug?.stages;
    if (!Array.isArray(stages)) {
      throw new OpenSeaMintError("No mint stages were returned for that collection.", "protocol");
    }
    return stages.map((s: any) => ({
      stageType: String(s.stageType ?? "UNKNOWN"),
      stageIndex: Number(s.stageIndex ?? 0),
      isEligible: Boolean(s.isEligible),
      maxTotalMintableByWallet: numberOrNull(s.maxTotalMintableByWallet),
      eligibleMaxTotalMintableByWallet: numberOrNull(s.eligibleMaxTotalMintableByWallet),
      priceUnit: s.eligiblePrice?.token?.unit != null ? String(s.eligiblePrice.token.unit) : null,
    }));
  }

  /**
   * The exact transaction this wallet should send.
   *
   * Whatever the stage requires — a Merkle proof, a server signature — is
   * already encoded in `data`. That is the entire reason this path exists.
   */
  async mintCalldata(opts: {
    address: string;
    contractAddress: string;
    chainIdentifier: string;
    tokenId: string;
    quantity: number;
  }): Promise<MintCalldata> {
    if (opts.quantity < 1) throw new OpenSeaMintError("Quantity must be at least 1.", "protocol");
    if (!/^\d+$/.test(opts.tokenId)) {
      throw new OpenSeaMintError("Token id must be numeric.", "protocol");
    }

    const data = await this.graphql<any>("MintActionTimelineQuery", MINT_ACTION_QUERY, {
      address: opts.address,
      fromAssets: [{ asset: { contractAddress: NATIVE_CURRENCY, chain: opts.chainIdentifier } }],
      toAssets: [
        {
          asset: {
            contractAddress: opts.contractAddress,
            chain: opts.chainIdentifier,
            tokenId: opts.tokenId,
          },
          quantity: String(opts.quantity),
        },
      ],
      recipient: null,
    });
    return decodeMintAction(data);
  }

  private async graphql<T>(operationName: string, query: string, variables: unknown): Promise<T> {
    const res = await this.request(this.graphqlUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-app-id": this.appId,
      },
      body: JSON.stringify({ operationName, query, variables }),
    });

    let envelope: any;
    try {
      envelope = await res.json();
    } catch {
      throw new OpenSeaMintError("The API returned something that wasn't JSON.", "protocol");
    }
    if (Array.isArray(envelope?.errors) && envelope.errors.length > 0) {
      throw classifyGraphqlErrors(envelope.errors);
    }
    return envelope?.data as T;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.doFetch(url, {
        ...init,
        headers: {
          accept: "application/json",
          origin: this.origin,
          referer: `${this.origin}/`,
          ...(this.cookies.size > 0 ? { cookie: this.cookies.header() } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (err: any) {
      throw new OpenSeaMintError(`Couldn't reach OpenSea: ${err?.message ?? err}`, "transport");
    }
    this.cookies.absorb(res.headers);
    if (res.status === 401) throw new OpenSeaMintError("Session expired — sign in again.", "auth");
    if (res.status === 429) throw new OpenSeaMintError("Rate limited by OpenSea.", "rate-limited");
    return res;
  }
}

function numberOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export function classifyGraphqlErrors(errors: any[]): OpenSeaMintError {
  const text = errors
    .map((e) => String(e?.message ?? e?.__typename ?? ""))
    .join(" ")
    .toLowerCase();
  if (text.includes("unauthorized") || text.includes("authenticat")) {
    return new OpenSeaMintError("Not signed in for that request.", "auth");
  }
  if (text.includes("rate") && text.includes("limit")) {
    return new OpenSeaMintError("Rate limited by OpenSea.", "rate-limited");
  }
  if (text.includes("eligib") || text.includes("allowlist")) {
    return new OpenSeaMintError("This wallet isn't eligible for that stage.", "not-eligible");
  }
  return new OpenSeaMintError(
    `OpenSea rejected the request: ${errors.map((e) => e?.message ?? e?.__typename).join(", ")}`,
    "protocol"
  );
}

/**
 * Pull the transaction out of a swap response.
 *
 * A swap can return several actions — approvals and the like — and only a
 * TransactionAction carries something sendable. Anything else means the mint
 * is not actually available to this wallet, whatever the stage looked like.
 */
export function decodeMintAction(data: any): MintCalldata {
  const swap = data?.swap;
  if (!swap) throw new OpenSeaMintError("No mint action was returned.", "protocol");

  if (Array.isArray(swap.errors) && swap.errors.length > 0) {
    const names = swap.errors.map((e: any) => e?.__typename ?? "error").join(", ");
    throw new OpenSeaMintError(`OpenSea won't mint this for that wallet: ${names}`, "not-eligible");
  }

  const actions = Array.isArray(swap.actions) ? swap.actions : [];
  for (const action of actions) {
    const tx = action?.transactionSubmissionData;
    if (!tx?.to || !tx?.data) continue;
    return { to: String(tx.to), data: String(tx.data), value: BigInt(tx.value ?? 0) };
  }
  throw new OpenSeaMintError(
    "OpenSea returned no transaction for this mint — usually the stage isn't open to this wallet.",
    "not-eligible"
  );
}
