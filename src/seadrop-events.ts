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

import { Interface, JsonRpcProvider } from "ethers";
import { PublicDrop, SEADROP_ADDRESS } from "./seadrop-public";

const EVENTS_ABI = [
  "event PublicDropUpdated(address indexed nftContract, tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients) publicDrop)",
];

const IFACE = new Interface(EVENTS_ABI);
const TOPIC = IFACE.getEvent("PublicDropUpdated")!.topicHash;

export interface DropSighting {
  nftContract: string;
  drop: PublicDrop;
  blockNumber: number;
}

// Most providers cap eth_getLogs to a few thousand blocks per call, so a wide
// range is walked in chunks rather than requested in one shot.
const CHUNK_BLOCKS = 2000;

export async function scanPublicDropUpdates(
  rpcUrl: string,
  fromBlock: number,
  toBlock: number
): Promise<DropSighting[]> {
  if (fromBlock > toBlock) return [];
  const provider = new JsonRpcProvider(rpcUrl);
  const sightings: DropSighting[] = [];

  for (let start = fromBlock; start <= toBlock; start += CHUNK_BLOCKS) {
    const end = Math.min(start + CHUNK_BLOCKS - 1, toBlock);
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
