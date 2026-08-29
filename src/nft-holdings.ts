// What a wallet actually holds, read from the chain.
//
// OpenSea's account-NFTs endpoint was the original source for this, which
// made the portfolio fail in two ways it shouldn't: it goes blank the moment
// an API key is rejected or rate-limited, and it can't show a collection
// OpenSea hasn't indexed — which for a brand-new drop is most of them, and
// this bot mints brand-new drops for a living.
//
// balanceOf() is authoritative, free, and works on any ERC-721 the moment it
// exists. OpenSea stays useful for the things only it knows (names, art,
// floors), but it is no longer what decides whether you own something.

import { Contract } from "ethers";
import { createProvider } from "./rpc-provider";

const ERC721_BALANCE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function name() view returns (string)",
];

export interface OnChainHolding {
  contract: string;
  balance: number;
  name?: string;
}

// Reads balances concurrently in small batches — one call per collection, so
// a wallet in 150 collections is 150 cheap eth_calls rather than a paginated
// crawl through someone else's index.
const BATCH = 10;

export async function fetchOnChainHoldings(
  rpcUrl: string,
  wallet: string,
  contracts: string[],
  opts: { withNames?: boolean } = {}
): Promise<OnChainHolding[]> {
  if (contracts.length === 0) return [];
  const provider = createProvider(rpcUrl);
  const held: OnChainHolding[] = [];

  const unique = [...new Set(contracts.map((c) => c.toLowerCase()))];

  for (let i = 0; i < unique.length; i += BATCH) {
    const slice = unique.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map(async (contract) => {
        try {
          const nft = new Contract(contract, ERC721_BALANCE_ABI, provider);
          const balance = Number(await nft.balanceOf(wallet));
          if (!Number.isFinite(balance) || balance <= 0) return null;

          let name: string | undefined;
          if (opts.withNames) {
            // Optional: plenty of contracts omit name(), and a missing label
            // is no reason to drop a holding that definitely exists.
            try {
              name = await nft.name();
            } catch {
              /* leave unnamed */
            }
          }
          return { contract, balance, name };
        } catch {
          // An unreadable contract (self-destructed, non-standard, RPC
          // hiccup) is not evidence of zero — just skip it rather than
          // reporting a holding that may exist as absent.
          return null;
        }
      })
    );
    for (const r of results) if (r) held.push(r);
  }

  return held.sort((a, b) => b.balance - a.balance);
}
