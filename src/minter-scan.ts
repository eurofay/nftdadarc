// Collecting every mint in a window, so the scout has something to rank.
//
// seadrop-events.scanSeaDropMints exists but filters to a list of wallets you
// already named -- it returns nothing for an empty list, by design, because
// it serves Copy Mint. The scout asks the opposite question: who is out there
// that I have never heard of. So it needs the unfiltered stream, plus the log
// index, because two mints in one block still have an order and on a
// sequencer that orders by arrival that order is the entire signal.

import { Interface, getAddress } from "ethers";
import { createProvider } from "./rpc-provider";
import { SEADROP_ADDRESS } from "./seadrop-public";
import { MintRecord } from "./minter-scout";

const IFACE = new Interface([
  "event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)",
]);
const MINT_TOPIC = IFACE.getEvent("SeaDropMint")!.topicHash;

export interface ScanAllOpts {
  chunkBlocks?: number;
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
  const chunk = Math.max(1, opts.chunkBlocks ?? 2_000);
  const cap = opts.maxRecords ?? 20_000;
  const out: MintRecord[] = [];

  for (let to = toBlock; to >= fromBlock; to -= chunk) {
    if (opts.shouldStop?.()) break;
    const from = Math.max(fromBlock, to - chunk + 1);

    let logs;
    try {
      logs = await provider.getLogs({
        address: SEADROP_ADDRESS,
        topics: [MINT_TOPIC],
        fromBlock: from,
        toBlock: to,
      });
    } catch {
      // A refused chunk is usually the node's result cap. Skipping it biases
      // the sample toward quiet periods, so it is reported rather than
      // hidden -- but one gap must not end the scan.
      opts.onProgress?.(toBlock - from, out.length);
      continue;
    }

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

    opts.onProgress?.(toBlock - from, out.length);
    if (out.length >= cap) break;
  }

  return out;
}
