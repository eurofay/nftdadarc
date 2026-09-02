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
export const DEFAULT_CHUNK_BLOCKS = 10;

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
export interface ScanOpts {
  /** Pause between chunk requests, so a long scan doesn't trip a rate limit. */
  chunkDelayMs?: number;
  /** Attempts per chunk before the scan gives up. */
  retriesPerChunk?: number;
  // Called after every chunk that succeeds, with the highest block covered so
  // far and that chunk's sightings.
  //
  // Without this a scan is all-or-nothing: one chunk failing at the end throws
  // away every chunk already fetched, and the caller can only rescan the whole
  // range from the start. Over a long backfill — a 12h Robinhood window is
  // hundreds of thousands of blocks — that is not a slow scan, it is a scan
  // that mathematically never finishes, because the odds of getting through
  // every chunk without one transient failure fall to nothing.
  onProgress?: (scannedThrough: number, found: MintSighting[]) => void;
  // Checked before each chunk. A long scan is otherwise uninterruptible: a
  // 12h Robinhood backfill at a small chunk is tens of thousands of sequential
  // calls, so a watcher told to stop would keep hitting the RPC for as long as
  // that scan had left to run. Returns what it has covered so far.
  shouldStop?: () => boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ethers caches an identical JSON-RPC request for ~250ms. Any retry must
// outlast that window or it never reaches the node.
export const RETRY_FLOOR_MS = 300;

export async function scanSeaDropMints(
  rpcUrl: string,
  fromBlock: number,
  toBlock: number,
  minters: string[],
  chunkBlocks: number = DEFAULT_CHUNK_BLOCKS,
  opts: ScanOpts = {}
): Promise<MintSighting[]> {
  if (fromBlock > toBlock || minters.length === 0) return [];
  const provider = createProvider(rpcUrl);
  const sightings: MintSighting[] = [];

  // An array in a topic slot is an OR filter — one call covers every wallet.
  const minterTopics = minters.map((m) => zeroPadValue(getAddress(m), 32));

  // Public nodes rate-limit sustained eth_getLogs. Measured on Robinhood with
  // 19 watched wallets: 5 back-to-back calls succeed, 15 do not. A long
  // backfill is dozens of calls, so it needs both a pause between them and a
  // retry per chunk — without the retry, one throttled call threw away every
  // chunk already fetched.
  const delayMs = opts.chunkDelayMs ?? 120;
  const attempts = Math.max(1, opts.retriesPerChunk ?? 3);
  let first = true;

  for (let start = fromBlock; start <= toBlock; start += chunkBlocks) {
    if (opts.shouldStop?.()) break;
    const end = Math.min(start + chunkBlocks - 1, toBlock);

    if (!first && delayMs > 0) await sleep(delayMs);
    first = false;

    let logs;
    for (let attempt = 1; ; attempt++) {
      try {
        logs = await provider.getLogs({
          address: SEADROP_ADDRESS,
          topics: [MINT_TOPIC, null, minterTopics],
          fromBlock: start,
          toBlock: end,
        });
        break;
      } catch (err) {
        if (attempt >= attempts) throw err;
        // Must clear ethers' request cache, which dedupes identical calls for
        // ~250ms and hands back the SAME failure without touching the network.
        // A retry inside that window is not a retry at all — it silently
        // returns the cached error, and the scan dies as if nothing was tried.
        await sleep(Math.max(RETRY_FLOOR_MS, delayMs * 4 * attempt));
      }
    }

    const found: MintSighting[] = [];
    for (const log of logs) {
      const parsed = IFACE.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      found.push({
        nftContract: parsed.args.nftContract,
        minter: parsed.args.minter,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      });
    }
    sightings.push(...found);
    // Reported per chunk, not at the end, so a caller keeps the work a later
    // chunk's failure would otherwise discard.
    opts.onProgress?.(end, found);
  }

  return sightings;
}
