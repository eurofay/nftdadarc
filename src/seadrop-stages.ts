// Reading every mint stage a collection has configured, not just the public one.
//
// SeaDrop supports four ways to mint, and they differ in WHERE the permission
// to mint lives:
//
//   public            — anyone may mint. The rules are entirely on-chain.
//   allow list        — a Merkle root is on-chain; your PROOF is not. The
//                       project publishes the list off-chain and you supply
//                       the proof.
//   signed            — a signer address is on-chain; the SIGNATURE is not.
//                       Only the project's server can issue one.
//   token gated       — the allowed token contracts are on-chain, and whether
//                       you hold one is on-chain. Fully derivable.
//
// That is the honest answer to "why does it only read mintPublic": public is
// the only stage whose authorisation is fully on-chain, so it is the only one
// a bot can mint from nothing but an address. The rest need a credential
// issued elsewhere.
//
// Detecting them is still worth doing. "No public drop" and "there is a signed
// allow-list stage you need a signature for" are very different messages, and
// the second one tells you to go and get the signature.

import { Interface } from "ethers";
import { createProvider } from "./rpc-provider";
import { SEADROP_ADDRESS } from "./seadrop-public";

const IFACE = new Interface([
  "function getPublicDrop(address) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))",
  "function getAllowListMerkleRoot(address) view returns (bytes32)",
  "function getSigners(address) view returns (address[])",
  "function getTokenGatedAllowedTokens(address) view returns (address[])",
]);

export type StageKind = "public" | "allowlist" | "signed" | "token-gated";

export interface Stage {
  kind: StageKind;
  /** Configured on the contract at all. */
  present: boolean;
  /** This bot can complete it from on-chain data alone. */
  mintable: boolean;
  detail: string;
  /** Only for the public stage. */
  startTime?: number;
  endTime?: number;
  priceWei?: bigint;
  maxPerWallet?: number;
}

const TOKEN_IFACE = new Interface([
  "function getMintStats(address minter) view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)",
]);

const ZERO_ROOT = "0x0000000000000000000000000000000000000000000000000000000000000000";

async function call<T>(rpcUrl: string, fn: string, nftContract: string): Promise<T | null> {
  try {
    const provider = createProvider(rpcUrl);
    const res = await provider.call({
      to: SEADROP_ADDRESS,
      data: IFACE.encodeFunctionData(fn, [nftContract]),
    });
    return IFACE.decodeFunctionResult(fn, res)[0] as T;
  } catch {
    // An unconfigured stage and an unreachable node look the same here; the
    // caller treats both as "not present", which is the safe reading.
    return null;
  }
}

export async function readStages(rpcUrl: string, nftContract: string): Promise<Stage[]> {
  const [drop, root, signers, gated] = await Promise.all([
    call<any>(rpcUrl, "getPublicDrop", nftContract),
    call<string>(rpcUrl, "getAllowListMerkleRoot", nftContract),
    call<string[]>(rpcUrl, "getSigners", nftContract),
    call<string[]>(rpcUrl, "getTokenGatedAllowedTokens", nftContract),
  ]);

  const stages: Stage[] = [];

  const hasPublic = Boolean(drop) && Number(drop.endTime) > 0;
  stages.push({
    kind: "public",
    present: hasPublic,
    mintable: hasPublic,
    detail: hasPublic ? "anyone can mint — this bot fires it" : "not configured",
    startTime: hasPublic ? Number(drop.startTime) : undefined,
    endTime: hasPublic ? Number(drop.endTime) : undefined,
    priceWei: hasPublic ? BigInt(drop.mintPrice) : undefined,
    maxPerWallet: hasPublic ? Number(drop.maxTotalMintableByWallet) : undefined,
  });

  const hasAllowList = Boolean(root) && root !== ZERO_ROOT;
  stages.push({
    kind: "allowlist",
    present: hasAllowList,
    mintable: false,
    detail: hasAllowList
      ? "the proof for your wallet is published off-chain by the project — the chain only holds the root"
      : "not configured",
  });

  const hasSigned = Array.isArray(signers) && signers.length > 0;
  stages.push({
    kind: "signed",
    present: hasSigned,
    mintable: false,
    detail: hasSigned
      ? `needs a signature from ${signers![0]}, issued by the project's server — not derivable on-chain`
      : "not configured",
  });

  const hasGated = Array.isArray(gated) && gated.length > 0;
  stages.push({
    kind: "token-gated",
    present: hasGated,
    mintable: false,
    detail: hasGated
      ? `open to holders of ${gated!.length} collection(s) — derivable on-chain, not yet wired up`
      : "not configured",
  });

  return stages;
}

/** What to tell someone who pasted a contract with no public stage. */
export function describeStages(stages: Stage[]): string {
  const present = stages.filter((s) => s.present);
  if (present.length === 0) {
    return "No mint stages are configured on this contract at all — it may not be a SeaDrop collection, or nothing has been set up yet.";
  }

  const lines = ["Stages configured on this collection:", ""];
  for (const stage of present) {
    lines.push(`  ${stage.mintable ? "✅" : "🔒"} ${stage.kind} — ${stage.detail}`);
  }

  if (!present.some((s) => s.mintable)) {
    lines.push(
      "",
      "None of these can be fired from on-chain data alone. Public mints are the ones " +
        "this bot can win; the others hand out a proof or a signature off-chain, and " +
        "without it the contract rejects the mint."
    );
  }
  return lines.join("\n");
}

export interface Eligibility {
  /** Already minted by this wallet on this collection. */
  alreadyMinted: number;
  /** The drop's per-wallet cap for the public stage. */
  maxPerWallet: number;
  /** Left in the collection overall. */
  supplyRemaining: number;
  /** What this wallet can actually mint right now — the smaller limit wins. */
  canMint: number;
  reason?: string;
}

/**
 * What this specific wallet can mint from the PUBLIC stage right now.
 *
 * Both limits are on-chain and both bind: the drop's per-wallet cap, and
 * whatever supply is left. Minting the per-wallet max into a collection with
 * three left reverts, so the smaller number is the real answer.
 *
 * This only speaks for the public stage. Eligibility for an allow list is a
 * proof the project issues off-chain — a wallet does not carry it, and no
 * amount of reading the chain reveals whether one exists for you.
 */
export async function checkEligibility(
  rpcUrl: string,
  nftContract: string,
  wallet: string,
  maxPerWallet: number
): Promise<Eligibility> {
  const provider = createProvider(rpcUrl);
  const res = await provider.call({
    to: nftContract,
    data: TOKEN_IFACE.encodeFunctionData("getMintStats", [wallet]),
  });
  const [minted, supply, maxSupply] = TOKEN_IFACE.decodeFunctionResult("getMintStats", res);

  const alreadyMinted = Number(minted);
  const supplyRemaining = Number(maxSupply) - Number(supply);
  const walletRemaining = Math.max(0, maxPerWallet - alreadyMinted);
  const canMint = Math.max(0, Math.min(walletRemaining, supplyRemaining));

  let reason: string | undefined;
  if (canMint === 0) {
    reason =
      walletRemaining === 0
        ? `this wallet already minted its limit of ${maxPerWallet}`
        : "the collection is sold out";
  } else if (supplyRemaining < walletRemaining) {
    reason = `only ${supplyRemaining} left in the collection`;
  }

  return { alreadyMinted, maxPerWallet, supplyRemaining, canMint, reason };
}

/** One line per wallet, for a pre-mint check. */
export function describeEligibility(wallet: string, e: Eligibility): string {
  const head = `${wallet.slice(0, 8)}… ${e.canMint > 0 ? `✅ can mint ${e.canMint}` : "⛔ can't mint"}`;
  return e.reason ? `${head} — ${e.reason}` : head;
}
