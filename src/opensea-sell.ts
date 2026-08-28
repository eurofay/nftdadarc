// Selling: accept a collection offer, via two independent paths.
//
// Path 1 (SDK)  — @opensea/sdk, OpenSea's official client. Constructs and
//                 signs the Seaport fulfillment itself, so it's correct by
//                 construction. Preferred.
// Path 2 (API)  — POST /api/v2/offers/fulfillment_data, then encode and send
//                 the returned call ourselves. Independent of the SDK's
//                 version and chain config, so it can work when the SDK
//                 can't.
//
// THE SAFETY RULE that makes trying both acceptable: fall back ONLY on a
// failure that happened before anything was broadcast. Once a transaction is
// on the network, a "failure" might just be a lost receipt — retrying via the
// other path could sell twice or burn a second lot of gas. Every attempt
// therefore reports `broadcast`, and the orchestrator refuses to continue
// once it's true.

import { Contract, Interface, Wallet, ZeroHash } from "ethers";
import { createProvider } from "./rpc-provider";
import { defaultLogger, Logger } from "./logger";

// Seaport's ConduitController is deployed at the same address on every chain
// it supports; it maps a conduitKey to the conduit that actually moves tokens.
const CONDUIT_CONTROLLER = "0x00000000F9490004C11Cef243f5400493c00Ad63";

const CONDUIT_CONTROLLER_ABI = [
  "function getConduit(bytes32 conduitKey) view returns (address conduit, bool exists)",
];

const ERC721_ABI = [
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
];

export type SellPath = "sdk" | "api";

export interface SellAttempt {
  path: SellPath;
  ok: boolean;
  txHash?: string;
  error?: string;
  // True once a transaction reached the network. Blocks any further attempt.
  broadcast: boolean;
}

export interface AcceptOfferResult {
  ok: boolean;
  txHash?: string;
  usedPath?: SellPath;
  attempts: SellAttempt[];
}

export interface OfferRef {
  chain: string;
  orderHash: string;
  protocolAddress: string;
  // Seaport's conduitKey from the order. Decides who needs NFT approval:
  // the zero key means Seaport itself moves the token, otherwise a conduit does.
  conduitKey?: string;
}

// Resolves who must be approved to transfer the NFT for this order.
//
// Hardcoding OpenSea's usual conduit (0x1E00...3c71) is the common shortcut
// and it is wrong on chains where that conduit was never deployed — Robinhood
// being one. Approving a non-existent address still "succeeds" as a
// transaction while granting nothing, and every later sale fails with no
// obvious cause. So this always derives the target from the order.
export async function resolveApprovalTarget(
  rpcUrl: string,
  seaportAddress: string,
  conduitKey?: string
): Promise<string> {
  if (!conduitKey || conduitKey === ZeroHash) return seaportAddress;
  const provider = createProvider(rpcUrl);
  const controller = new Contract(CONDUIT_CONTROLLER, CONDUIT_CONTROLLER_ABI, provider);
  try {
    const [conduit, exists] = await controller.getConduit(conduitKey);
    // A key with no deployed conduit can't move anything — Seaport is the
    // only meaningful target left.
    if (!exists || conduit === "0x0000000000000000000000000000000000000000") return seaportAddress;
    return conduit;
  } catch {
    return seaportAddress;
  }
}

export async function isApprovedForAll(
  rpcUrl: string,
  nftContract: string,
  owner: string,
  operator: string
): Promise<boolean> {
  const provider = createProvider(rpcUrl);
  const nft = new Contract(nftContract, ERC721_ABI, provider);
  try {
    return await nft.isApprovedForAll(owner, operator);
  } catch {
    return false;
  }
}

export interface ApprovalResult {
  alreadyApproved: boolean;
  txHash?: string;
  operator: string;
}

// Grants approval only when it's actually missing, so repeat sales don't
// re-send (and re-pay for) an approval that's already in place.
export async function ensureApproval(opts: {
  rpcUrl: string;
  nftContract: string;
  walletKey: string;
  seaportAddress: string;
  conduitKey?: string;
  maxFeePerGas: bigint;
  maxPriorityFee: bigint;
  logger?: Logger;
}): Promise<ApprovalResult> {
  const log = opts.logger ?? defaultLogger;
  const provider = createProvider(opts.rpcUrl);
  const wallet = new Wallet(opts.walletKey, provider);

  const operator = await resolveApprovalTarget(opts.rpcUrl, opts.seaportAddress, opts.conduitKey);
  if (await isApprovedForAll(opts.rpcUrl, opts.nftContract, wallet.address, operator)) {
    return { alreadyApproved: true, operator };
  }

  log.warn(`  Granting transfer approval to ${operator} for ${opts.nftContract}...`);
  const nft = new Contract(opts.nftContract, ERC721_ABI, wallet);
  const tx = await nft.setApprovalForAll(operator, true, {
    maxFeePerGas: opts.maxFeePerGas,
    maxPriorityFeePerGas: opts.maxPriorityFee,
  });
  await tx.wait(1);
  log.success(`  ✓ Approval granted (${tx.hash})`);
  return { alreadyApproved: false, txHash: tx.hash, operator };
}

// ── Path 1: the official SDK ─────────────────────────────────────────────
export async function acceptOfferViaSdk(opts: {
  rpcUrl: string;
  walletKey: string;
  chainKey: string;
  slug: string;
  tokenId?: string;
  apiKey?: string;
  maxFeePerGas: bigint;
  maxPriorityFee: bigint;
}): Promise<SellAttempt> {
  let broadcast = false;
  try {
    // Imported lazily so a missing/incompatible SDK degrades into a failed
    // attempt the orchestrator can fall back from, rather than breaking the
    // whole bot at import time.
    const { OpenSeaSDK, Chain } = await import("@opensea/sdk");
    const chain = (Chain as Record<string, string>)[
      Object.keys(Chain).find((k) => (Chain as any)[k] === opts.chainKey) ?? ""
    ];
    if (!chain) throw new Error(`@opensea/sdk has no Chain entry for "${opts.chainKey}"`);

    const provider = createProvider(opts.rpcUrl);
    const wallet = new Wallet(opts.walletKey, provider);
    const sdk = new OpenSeaSDK(wallet as any, { chain: chain as any, apiKey: opts.apiKey });

    const offer = await (sdk.api as any).getBestOffer(opts.slug, opts.tokenId);
    if (!offer) throw new Error("no offer returned by the SDK");

    broadcast = true; // everything after this point may put a tx on the network
    const txHash = await sdk.fulfillOrder({
      order: offer,
      accountAddress: wallet.address,
      overrides: { maxFeePerGas: opts.maxFeePerGas, maxPriorityFeePerGas: opts.maxPriorityFee },
    });
    return { path: "sdk", ok: true, txHash, broadcast: true };
  } catch (err: any) {
    return { path: "sdk", ok: false, error: err?.message ?? String(err), broadcast };
  }
}

// ── Path 2: raw fulfillment API ──────────────────────────────────────────
// OpenSea returns the *decoded* parameters plus a bare type signature with no
// argument names, so the call has to be re-encoded against Seaport's real
// named ABI. Only the basic-order function is covered here; anything else
// fails cleanly pre-broadcast and lets the SDK path handle it.
const SEAPORT_FULFILL_ABI = [
  "function fulfillBasicOrder_efficient_6GL6yc(tuple(address considerationToken, uint256 considerationIdentifier, uint256 considerationAmount, address offerer, address zone, address offerToken, uint256 offerIdentifier, uint256 offerAmount, uint8 basicOrderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 offererConduitKey, bytes32 fulfillerConduitKey, uint256 totalOriginalAdditionalRecipients, tuple(uint256 amount, address recipient)[] additionalRecipients, bytes signature) parameters) payable returns (bool fulfilled)",
  "function fulfillBasicOrder(tuple(address considerationToken, uint256 considerationIdentifier, uint256 considerationAmount, address offerer, address zone, address offerToken, uint256 offerIdentifier, uint256 offerAmount, uint8 basicOrderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 offererConduitKey, bytes32 fulfillerConduitKey, uint256 totalOriginalAdditionalRecipients, tuple(uint256 amount, address recipient)[] additionalRecipients, bytes signature) parameters) payable returns (bool fulfilled)",
];

const SEAPORT_IFACE = new Interface(SEAPORT_FULFILL_ABI);

// Exported for testing — the encoding is the fiddly part of this path.
export function encodeFulfillment(functionSignature: string, inputData: any): string {
  const name = functionSignature.split("(")[0];
  const fragment = SEAPORT_IFACE.fragments.find((f: any) => f.name === name);
  if (!fragment) throw new Error(`unsupported fulfillment function "${name}"`);
  const params = inputData?.parameters ?? inputData;
  if (!params) throw new Error("fulfillment response carried no parameters");
  return SEAPORT_IFACE.encodeFunctionData(name, [params]);
}

export async function acceptOfferViaApi(opts: {
  rpcUrl: string;
  walletKey: string;
  offer: OfferRef;
  nftContract: string;
  tokenId: string;
  apiKey?: string;
  maxFeePerGas: bigint;
  maxPriorityFee: bigint;
  gasLimit: number;
}): Promise<SellAttempt> {
  let broadcast = false;
  try {
    const provider = createProvider(opts.rpcUrl);
    const wallet = new Wallet(opts.walletKey, provider);

    const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
    if (opts.apiKey) headers["x-api-key"] = opts.apiKey;

    const res = await fetch("https://api.opensea.io/api/v2/offers/fulfillment_data", {
      method: "POST",
      headers,
      body: JSON.stringify({
        offer: {
          chain: opts.offer.chain,
          hash: opts.offer.orderHash,
          protocol_address: opts.offer.protocolAddress,
        },
        fulfiller: { address: wallet.address },
        consideration: { asset_contract_address: opts.nftContract, token_id: opts.tokenId },
      }),
    });
    if (!res.ok) throw new Error(`fulfillment_data ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const json: any = await res.json();
    const tx = json?.fulfillment_data?.transaction;
    if (!tx?.to || !tx?.function) throw new Error("fulfillment response had no transaction");

    const data = encodeFulfillment(tx.function, tx.input_data);

    broadcast = true;
    const sent = await wallet.sendTransaction({
      to: tx.to,
      data,
      value: BigInt(tx.value ?? 0),
      maxFeePerGas: opts.maxFeePerGas,
      maxPriorityFeePerGas: opts.maxPriorityFee,
      gasLimit: opts.gasLimit,
    });
    return { path: "api", ok: true, txHash: sent.hash, broadcast: true };
  } catch (err: any) {
    return { path: "api", ok: false, error: err?.message ?? String(err), broadcast };
  }
}

// Parses a listing price that may be absolute ("0.05") or derived from the
// live floor ("floor", "floor*1.2"). Returns null for anything unusable
// rather than guessing — a misread price here lists an NFT at the wrong
// number, so ambiguity must fail loudly instead of defaulting.
export function parseListingPrice(input: string, floorPrice: number | null): number | null {
  const raw = input.trim().toLowerCase();

  const floorExpr = /^floor(?:\s*\*\s*([0-9]*\.?[0-9]+))?$/.exec(raw);
  if (floorExpr) {
    if (floorPrice == null || floorPrice <= 0) return null;
    const multiplier = floorExpr[1] ? Number(floorExpr[1]) : 1;
    if (!Number.isFinite(multiplier) || multiplier <= 0) return null;
    return floorPrice * multiplier;
  }

  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Listing ──────────────────────────────────────────────────────────────
// Creating a listing means constructing a Seaport order with the right fee
// and royalty split, signing it EIP-712, and posting it. Getting the
// consideration wrong lists an NFT at the wrong price, so this delegates
// entirely to the official SDK rather than hand-rolling the order.
//
// Unlike accepting an offer, listing costs no gas and moves nothing — it
// publishes a signed offer to sell. Nothing leaves the wallet until a buyer
// fills it, which is why this doesn't need the broadcast guard.
export interface ListingResult {
  ok: boolean;
  orderHash?: string;
  error?: string;
}

export async function createListing(opts: {
  rpcUrl: string;
  walletKey: string;
  chainKey: string;
  tokenAddress: string;
  tokenId: string;
  priceEth: number;
  expirationMinutes?: number;
  apiKey?: string;
  logger?: Logger;
}): Promise<ListingResult> {
  const log = opts.logger ?? defaultLogger;
  try {
    const { OpenSeaSDK, Chain } = await import("@opensea/sdk");
    const chain = Object.values(Chain).find((c) => c === opts.chainKey);
    if (!chain) throw new Error(`@opensea/sdk has no Chain entry for "${opts.chainKey}"`);

    const provider = createProvider(opts.rpcUrl);
    const wallet = new Wallet(opts.walletKey, provider);
    const sdk = new OpenSeaSDK(wallet as any, { chain: chain as any, apiKey: opts.apiKey });

    const expiration = Math.round(Date.now() / 1000) + (opts.expirationMinutes ?? 60 * 24) * 60;
    log.info(`  Listing ${opts.tokenAddress} #${opts.tokenId} at ${opts.priceEth} ETH...`);

    const order = await (sdk as any).createListing({
      asset: { tokenAddress: opts.tokenAddress, tokenId: opts.tokenId },
      accountAddress: wallet.address,
      startAmount: opts.priceEth,
      expirationTime: expiration,
    });
    return { ok: true, orderHash: order?.orderHash ?? order?.order_hash };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// ── Orchestrator ─────────────────────────────────────────────────────────
// Runs the paths in order and stops at the first success — or at the first
// attempt that broadcast anything, successful or not.
export async function acceptOfferWithFallback(
  attempts: (() => Promise<SellAttempt>)[],
  logger?: Logger
): Promise<AcceptOfferResult> {
  const log = logger ?? defaultLogger;
  const tried: SellAttempt[] = [];

  for (const run of attempts) {
    const attempt = await run();
    tried.push(attempt);

    if (attempt.ok) {
      log.successBold(`  ✓ Offer accepted via ${attempt.path} path — ${attempt.txHash}`);
      return { ok: true, txHash: attempt.txHash, usedPath: attempt.path, attempts: tried };
    }

    if (attempt.broadcast) {
      // Something went out. Never try the other path — a lost receipt is not
      // proof the sale failed, and a second attempt could sell twice.
      log.errorBold(
        `  ✗ ${attempt.path} path failed AFTER broadcasting (${attempt.error}). ` +
          `Not trying the other path — check the chain before retrying.`
      );
      return { ok: false, attempts: tried };
    }

    log.warn(`  ${attempt.path} path unavailable (${attempt.error}) — trying the next one`);
  }

  return { ok: false, attempts: tried };
}
