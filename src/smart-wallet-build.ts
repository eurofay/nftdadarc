// Filling in the half of a dossier that is not in the mint log.
//
// positionsFor() gets what was minted and what it cost, exactly, from the
// event. What it cannot know is whether the wallet still holds any of it, or
// what the market now thinks a collection is worth. Both of those need a call
// out -- one to the chain, one to OpenSea -- and both are optional: a dossier
// with holdings and no floors is still worth reading, and one with neither
// still says what was bought and for how much.

import { Contract } from "ethers";
import { createProvider } from "./rpc-provider";
import { Position, Dossier, summarise } from "./smart-wallet";
import { MintRecord } from "./minter-scout";
import { positionsFor } from "./smart-wallet";
import { lookupContract, isLookupFailure } from "./slug-resolver";
import { fetchStats, fetchBestCollectionOffer } from "./opensea-market";

const ERC721 = ["function balanceOf(address owner) view returns (uint256)"];

export interface BuildOpts {
  address: string;
  chainKey: string;
  symbol: string;
  rpcUrl: string;
  records: MintRecord[];
  window: { from: number; to: number };
  apiKey?: string;
  /** Skip the market calls — much faster, and enough for a spend-only view. */
  withMarket?: boolean;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Read the current balance for each collection.
 *
 * In parallel, because these are independent reads and a wallet in twenty
 * collections done serially is twenty round trips of waiting. A balance that
 * cannot be read stays undefined rather than becoming zero -- an unreadable
 * balance and an empty one mean opposite things about whether the wallet
 * flipped.
 */
export async function readHoldings(
  rpcUrl: string,
  address: string,
  positions: Position[]
): Promise<Position[]> {
  const provider = createProvider(rpcUrl);
  return Promise.all(
    positions.map(async (p) => {
      try {
        const held = await new Contract(p.contract, ERC721, provider).balanceOf(address);
        return { ...p, held: Number(held) };
      } catch {
        return p;
      }
    })
  );
}

/**
 * Name and price each collection.
 *
 * Serial on purpose: OpenSea rate-limits, and a dossier is not on any
 * critical path. A collection it has never indexed simply keeps its address
 * and no floor, which is common on a chain this new.
 */
export async function readMarket(
  chainKey: string,
  positions: Position[],
  apiKey?: string,
  onProgress?: (done: number, total: number) => void
): Promise<Position[]> {
  const out: Position[] = [];
  for (const [i, p] of positions.entries()) {
    let next = p;
    try {
      const info = await lookupContract(chainKey, p.contract, apiKey);
      if (!isLookupFailure(info)) {
        next = { ...next, name: info.name };
        const [stats, offer] = await Promise.all([
          fetchStats(info.slug, apiKey).catch(() => null),
          fetchBestCollectionOffer(info.slug, apiKey).catch(() => null),
        ]);
        if (stats?.floorPrice != null) next = { ...next, floorEth: stats.floorPrice };
        if (offer?.priceEth != null) next = { ...next, bestOfferEth: offer.priceEth };
      }
    } catch {
      /* an unindexed collection is normal here, not an error */
    }
    out.push(next);
    onProgress?.(i + 1, positions.length);
  }
  return out;
}

export async function buildDossier(opts: BuildOpts): Promise<Dossier> {
  let positions = positionsFor(opts.address, opts.records);
  positions = await readHoldings(opts.rpcUrl, opts.address, positions);
  if (opts.withMarket !== false) {
    positions = await readMarket(opts.chainKey, positions, opts.apiKey, opts.onProgress);
  }
  return summarise(opts.address, opts.chainKey, opts.symbol, positions, opts.window);
}
