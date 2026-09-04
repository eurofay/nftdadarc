// Turn an OpenSea collection slug into a contract address.
//
// The API key is optional. OpenSea's public collections endpoint often answers
// unauthenticated, so we always attempt the lookup and only attach a key when
// one is configured — the key makes this reliable rather than possible. If the
// lookup is refused, the caller falls back to asking for the contract address
// directly, which never needs a key at all.

interface CollectionInfo {
  name: string;
  contractAddress: string;
  chain: string;
}

export async function resolveSlug(
  slug: string,
  apiKey?: string,
  preferredChain?: string
): Promise<CollectionInfo> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

  const res = await fetch(`https://api.opensea.io/api/v2/collections/${slug}`, { headers });

  if (res.status === 401 || res.status === 403) {
    // Unauthenticated lookups get 401 both for an unknown slug and for one that
    // needs a key, so the message has to cover both rather than guess.
    throw new Error(
      apiKey
        ? `OpenSea rejected the API key (${res.status}) — check OPENSEA_API_KEY.`
        : `OpenSea refused the lookup (${res.status}) — the slug may be misspelled, or it wants an API key.`
    );
  }
  if (res.status === 404) {
    throw new Error(`No OpenSea collection called "${slug}".`);
  }
  if (res.status === 429) {
    throw new Error("OpenSea rate-limited the lookup — retry shortly.");
  }
  if (!res.ok) {
    throw new Error(`Could not resolve "${slug}": ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as any;

  const contracts = json.contracts;
  if (!contracts || contracts.length === 0) {
    throw new Error(`No contracts listed for "${slug}".`);
  }

  // Prefer the contract on the chain we're actually minting on, otherwise take
  // whichever OpenSea lists first.
  const wanted = preferredChain?.trim().toLowerCase();
  const picked =
    (wanted && contracts.find((c: any) => c.chain?.toLowerCase() === wanted)) || contracts[0];

  return {
    name: json.name || slug,
    contractAddress: picked.address,
    chain: picked.chain,
  };
}

// A slug is anything that isn't a raw contract address.
export function isSlug(input: string): boolean {
  return !input.startsWith("0x");
}

// Reverse lookup: contract address -> OpenSea collection slug and name.
//
// This endpoint is rate-limited hard, and it signals the limit as
// 401 {"errors":["Invalid API key"]} rather than 429. Measured against one
// real Robinhood collection with one valid key:
//
//   spaced-out requests, key or no key   200
//   after a burst of probing             401, keyed and unkeyed alike
//   ~3 minutes idle                      200 again
//
// So a 401 here says almost nothing about the key. The same body comes back
// for a contract OpenSea does not index, for a throttled caller, and for a
// key whose plan excludes the endpoint. Reporting it as "invalid API key"
// sends someone off to regenerate a credential that was working.
//
// Unauthenticated requests are served opportunistically -- OpenSea's own
// refusal says a key "is required for this request", yet unkeyed calls
// usually succeed -- so the key is sent when there is one and dropped as a
// fallback, since the two are throttled separately and rarely both at once.
//
// This used to return null before making any request when no key was
// configured, which turned an endpoint that answers most of the time into a
// flat "OpenSea has never heard of this collection".
export interface ContractLookupFailure {
  status: number | null;
  detail: string;
}

export async function lookupContract(
  chain: string,
  address: string,
  apiKey?: string
): Promise<{ name: string; slug: string } | ContractLookupFailure> {
  const first = await attemptLookup(chain, address, apiKey);
  if (!isLookupFailure(first) || first.status !== 401) return first;

  // Keyed and unkeyed are throttled separately, so the one that was not just
  // refused is worth a try. No delay between them: recovery takes minutes,
  // not milliseconds, and nobody waiting on a Telegram reply will sit through
  // it -- if both are refused the honest answer is to say so and point at the
  // collection link, which needs no lookup at all.
  const fallback = await attemptLookup(chain, address, apiKey ? undefined : "");
  return isLookupFailure(fallback) ? first : fallback;
}

async function attemptLookup(
  chain: string,
  address: string,
  apiKey?: string
): Promise<{ name: string; slug: string } | ContractLookupFailure> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  try {
    const res = await fetch(`https://api.opensea.io/api/v2/chain/${chain}/contract/${address}`, { headers });
    if (res.status === 404) {
      return { status: 404, detail: `OpenSea has no ${chain} collection for that contract` };
    }
    if (res.status === 401 || res.status === 403) {
      // Deliberately does not say the key is invalid, however OpenSea words
      // it. Throttling and an unindexed contract produce this same response.
      return {
        status: res.status,
        detail:
          `OpenSea refused the lookup (HTTP ${res.status}) — it rate-limits this endpoint and reports ` +
          `the limit as an auth error, so this is usually throttling or a contract it doesn't index on ${chain}`,
      };
    }
    if (res.status === 429) {
      return { status: 429, detail: "OpenSea rate-limited the lookup — retry shortly" };
    }
    if (!res.ok) {
      return { status: res.status, detail: `OpenSea returned HTTP ${res.status}` };
    }
    const json = (await res.json()) as any;
    // A contract OpenSea knows but has not grouped into a collection has no
    // slug, which is a different problem from the lookup failing.
    if (!json.collection) {
      return { status: 200, detail: "OpenSea knows that contract but has not put it in a collection yet" };
    }
    return { name: json.name || json.collection, slug: json.collection };
  } catch (err: any) {
    return { status: null, detail: `couldn't reach OpenSea — ${err?.message ?? err}` };
  }
}

/** True when the lookup failed rather than returning a collection. */
export function isLookupFailure(
  result: { name: string; slug: string } | ContractLookupFailure
): result is ContractLookupFailure {
  return "detail" in result;
}

// Best-effort form, for callers that only want this to decorate a log line
// and never to gate anything. The on-chain event stays the source of truth.
export async function openseaContractInfo(
  chain: string,
  address: string,
  apiKey?: string
): Promise<{ name: string; slug: string } | null> {
  const result = await lookupContract(chain, address, apiKey);
  return isLookupFailure(result) ? null : result;
}
