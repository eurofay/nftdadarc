// Discover live SeaDrop public drops directly from the chain.
//
// Every SeaDrop collection shares one singleton contract (SEADROP_ADDRESS).
// Whenever a project owner configures a public-mint stage, that singleton
// emits PublicDropUpdated(nftContract, publicDrop) with the full stage
// (price, window, per-wallet cap) in the log itself — no extra RPC call
// needed to read it back. Watching that one contract's event log is a
// complete, first-party feed of every SeaDrop drop on the chain: no OpenSea
// dependency, no undocumented endpoint, and it can't be spoofed by an
// unrelated contract since the log can only originate from SEADROP_ADDRESS.
//
// Event signature verified against ProjectOpenSea/seadrop's
// SeaDropErrorsAndEvents.sol / SeaDropStructs.sol.

import { Interface, getAddress, zeroPadValue } from "ethers";
import { PublicDrop, SEADROP_ADDRESS } from "./seadrop-public";
import { createProvider } from "./rpc-provider";

const EVENTS_ABI = [
  "event PublicDropUpdated(address indexed nftContract, tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients) publicDrop)",
  // Emitted on every successful SeaDrop mint. nftContract/minter/feeRecipient
  // are all indexed, which is what lets the copy-mint watcher filter by
  // watched wallet server-side instead of downloading whole blocks.
  // Verified against ProjectOpenSea/seadrop's SeaDropErrorsAndEvents.sol.
  "event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)",
];

const IFACE = new Interface(EVENTS_ABI);
const TOPIC = IFACE.getEvent("PublicDropUpdated")!.topicHash;
const MINT_TOPIC = IFACE.getEvent("SeaDropMint")!.topicHash;

export interface DropSighting {
  nftContract: string;
  drop: PublicDrop;
  blockNumber: number;
}

export interface MintSighting {
  nftContract: string;
  minter: string;
  txHash: string;
  blockNumber: number;
}

// Providers cap how many blocks eth_getLogs can span in one call, so a wide
// range is walked in chunks rather than requested in one shot. This defaults
// small on purpose: Alchemy's free tier — the provider this repo's .env.example
// recommends — allows only 10 blocks per call. A too-large chunk doesn't
// degrade gracefully, it just errors on every call, so "safe everywhere" beats
// "fast on a plan the caller might not have." Raise it via the chunkBlocks
// param (AUTO_LOG_CHUNK_BLOCKS at the CLI layer) if your provider allows more —
// it only affects catch-up speed after downtime, not steady-state polling.
const DEFAULT_CHUNK_BLOCKS = 10;

export async function scanPublicDropUpdates(
  rpcUrl: string,
  fromBlock: number,
  toBlock: number,
  chunkBlocks: number = DEFAULT_CHUNK_BLOCKS
): Promise<DropSighting[]> {
  if (fromBlock > toBlock) return [];
  const provider = createProvider(rpcUrl);
  const sightings: DropSighting[] = [];

  for (let start = fromBlock; start <= toBlock; start += chunkBlocks) {
    const end = Math.min(start + chunkBlocks - 1, toBlock);
    const logs = await provider.getLogs({
      address: SEADROP_ADDRESS,
      topics: [TOPIC],
      fromBlock: start,
      toBlock: end,
    });

    for (const log of logs) {
      const parsed = IFACE.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      const raw = parsed.args.publicDrop;
      sightings.push({
        nftContract: parsed.args.nftContract,
        blockNumber: log.blockNumber,
        drop: {
          mintPrice: BigInt(raw.mintPrice),
          startTime: Number(raw.startTime),
          endTime: Number(raw.endTime),
          maxTotalMintableByWallet: Number(raw.maxTotalMintableByWallet),
          feeBps: Number(raw.feeBps),
          restrictFeeRecipients: Boolean(raw.restrictFeeRecipients),
        },
      });
    }
  }

  return sightings;
}

// Finds mints performed by any of `minters`, using SeaDropMint's indexed
// `minter` topic so the node does the filtering.
//
// This replaced pulling every block in full and inspecting each transaction.
// That worked, but cost one eth_getBlockByNumber per block — ruinous on a
// fast chain (Robinhood produces ~10 blocks/second, so ~40 full blocks per
// 4s poll) and the dominant source of both RPC spend and rate-limit pressure.
// A topic-filtered getLogs covers the same range in one call per chunk.
//
// It also keys off the mint *event* rather than a mintPublic *call*, so it
// only reports mints that actually succeeded, and it catches allowlist mints
// too — a watched wallet getting in early is exactly the signal worth copying.
export async function scanSeaDropMints(
  rpcUrl: string,
  fromBlock: number,
  toBlock: number,
  minters: string[],
  chunkBlocks: number = DEFAULT_CHUNK_BLOCKS
): Promise<MintSighting[]> {
  if (fromBlock > toBlock || minters.length === 0) return [];
  const provider = createProvider(rpcUrl);
  const sightings: MintSighting[] = [];

  // An array in a topic slot is an OR filter — one call covers every wallet.
  const minterTopics = minters.map((m) => zeroPadValue(getAddress(m), 32));

  for (let start = fromBlock; start <= toBlock; start += chunkBlocks) {
    const end = Math.min(start + chunkBlocks - 1, toBlock);
    const logs = await provider.getLogs({
      address: SEADROP_ADDRESS,
      topics: [MINT_TOPIC, null, minterTopics],
      fromBlock: start,
      toBlock: end,
    });

    for (const log of logs) {
      const parsed = IFACE.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      sightings.push({
        nftContract: parsed.args.nftContract,
        minter: parsed.args.minter,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      });
    }
  }

  return sightings;
}
