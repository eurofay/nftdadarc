// Collecting every mint in a window, so the scout has something to rank.
//
// seadrop-events.scanSeaDropMints exists but filters to a list of wallets you
// already named -- it returns nothing for an empty list, by design, because
// it serves Copy Mint. The scout asks the opposite question: who is out there
// that I have never heard of. So it needs the unfiltered stream, plus the log
// index, because two mints in one block still have an order and on a
// sequencer that orders by arrival that order is the entire signal.

import { Interface, getAddress, zeroPadValue } from "ethers";
import { chunksOf, runChunks } from "./chunk-scan";
import { createProvider } from "./rpc-provider";
import { SEADROP_ADDRESS } from "./seadrop-public";
import { MintRecord } from "./minter-scout";

const IFACE = new Interface([
  "event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)",
]);
const MINT_TOPIC = IFACE.getEvent("SeaDropMint")!.topicHash;

export interface ScanAllOpts {
  chunkBlocks?: number;
  /**
   * Restrict to these minters, using the event's own indexed topic.
   *
   * `minter` is indexed on SeaDropMint, so the node does the filtering and
   * returns only what was asked for. Measured: a whole-chain scan of 2,000,000
   * blocks for ONE wallet came back in 300ms with 44 logs, where the same span
   * unfiltered would blow the endpoint's 10,000-result cap many times over.
   *
   * Leave empty to read every minter, which is what ranking needs.
   */
  minters?: string[];
  concurrency?: number;
  /** Called when chunks were lost even after retries. */
  onFailedChunks?: (count: number) => void;
  /** Stop early once this many records are in hand. */
  maxRecords?: number;
  onProgress?: (scanned: number, found: number) => void;
  shouldStop?: () => boolean;
}

/**
 * Every SeaDrop mint between two blocks.
 *
 * Walks newest-first: a scout report is about who is active NOW, and stopping
 * at a record cap having scanned the most recent blocks is a better answer
 * than stopping having scanned the oldest.
 */
export async function scanAllMints(
  rpcUrl: string,
  fromBlock: number,
  toBlock: number,
  opts: ScanAllOpts = {}
): Promise<MintRecord[]> {
  if (fromBlock > toBlock) return [];
  const provider = createProvider(rpcUrl);

  // An array in a topic slot is an OR filter, so one call covers every named
  // wallet. `minter` is the second indexed argument, hence the null for the
  // collection in between.
  const minterTopics =
    opts.minters && opts.minters.length > 0
      ? opts.minters.map((m) => zeroPadValue(getAddress(m), 32))
      : null;
  const topics: (string | string[] | null)[] = minterTopics
    ? [MINT_TOPIC, null, minterTopics]
    : [MINT_TOPIC];

  // A filtered query is narrow enough for the node to serve from an index, so
  // chunking it only adds round trips. One call, whatever the span.
  const chunk = minterTopics ? Math.max(1, toBlock - fromBlock + 1) : Math.max(1, opts.chunkBlocks ?? 2_000);

  const { results: logs, failed } = await runChunks(
    chunksOf(fromBlock, toBlock, chunk),
    async (range) =>
      provider.getLogs({
        address: SEADROP_ADDRESS,
        topics,
        fromBlock: range.from,
        toBlock: range.to,
      }),
    {
      concurrency: opts.concurrency,
      maxResults: opts.maxRecords ?? 20_000,
      shouldStop: opts.shouldStop,
      onProgress: (done, total, found) => opts.onProgress?.(done, found),
    }
  );
  // Surfaced rather than swallowed: a scan missing chunks is a scan whose
  // totals are wrong, and the caller has to be able to say so.
  if (failed > 0) opts.onFailedChunks?.(failed);

  const out: MintRecord[] = [];
  for (const lg of logs) {
    try {
      const parsed = IFACE.decodeEventLog("SeaDropMint", lg.data, lg.topics);
      out.push({
        nftContract: getAddress(parsed.nftContract as string),
        minter: getAddress(parsed.minter as string),
        blockNumber: lg.blockNumber,
        logIndex: lg.index,
        txHash: lg.transactionHash,
        quantity: Number(parsed.quantityMinted ?? 0n),
        unitPriceWei: BigInt(parsed.unitMintPrice ?? 0n),
      });
    } catch {
      /* a log that will not decode is not this contract's shape */
    }
  }
  return out;
}
