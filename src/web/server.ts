// The web UI's server.
//
// Same process, same store, same engine as the Telegram bot — this is another
// door onto the same house, not a second house. That is deliberate: two
// copies of the mint logic would drift, and the one that drifted would be the
// one holding your keys.
//
// The reason it exists is the timeout. Telegraf wraps every handler in a
// 90-second limit, and a scan of a collection with no enumeration can take
// minutes. Here the server just keeps sending lines over an event stream for
// as long as the work takes, with nothing to race.
//
// TWO RULES THAT ARE NOT NEGOTIABLE, enforced by what this file does and does
// not contain:
//
//   1. No route returns a private key or a seed phrase. getDecryptedKey is
//      never called here. A stolen web session must not become stolen funds,
//      and the only way to guarantee that is for the secrets to have no path
//      out through this surface at all.
//   2. Nothing but /api/login runs without a session. There is no read-only
//      tier — addresses and balances are worth protecting too.

import http, { IncomingMessage, ServerResponse } from "http";
import fs from "fs";
import path from "path";
import { formatEther } from "ethers";
import { UserStores } from "../telegram/user-stores";
import { resolveRpcsForChain } from "../rpc-resolver";
import { resolveChain, CHAINS } from "../chains";
import { createProvider } from "../rpc-provider";
import { readableRpcs, tryInOrder, raceReadOrNull } from "../fast-read";
import { scanHoldings, holders } from "../nft-consolidate";
import { lookupContract, isLookupFailure } from "../slug-resolver";
import { fetchCollection, fetchStats, fetchBestCollectionOffer } from "../opensea-market";
import { computePnl, renderPnl, PnlReport } from "../pnl";
import { gasLimitForQuantity } from "../gas";
import { resolveMaxFee, marketFee } from "../gas-fit";
import { parseNftLink } from "../nft-link";
import { buildLocalMintPlan } from "../seadrop-public";
import { simulateMint } from "../preflight";
import { checkEligibility } from "../seadrop-stages";
import { stageWindow, assessWallet } from "../mint-readiness";
import { resolveSlug, isSlug } from "../slug-resolver";
import { loopNames } from "../telegram/wallet-naming";
import { parseWalletList, describeParse, toCsv } from "../wallet-csv";
import { parseCriteria, describeCriteria, fieldsNeeded, applyCriteria, Criteria } from "../wallet-criteria";
import { enrichWallets, describeEta } from "../wallet-enrich";
import {
  checkTokenStrength,
  mintSession,
  verifySession,
  secretsMatch,
  parseCookies,
  sessionCookie,
  clearedCookie,
  LoginLimiter,
} from "./auth";

export interface WebServerDeps {
  stores: UserStores;
  ownerId: number;
  token: string | undefined;
  port: number;
  /** True when the deployment is reachable over https, so cookies get Secure. */
  secureCookies?: boolean;
  /**
   * Called when the web arms a mint, so the bot picks it up without waiting
   * for a restart. Without this the record would sit in the store until the
   * next boot re-armed it -- correct, but no use for a drop this afternoon.
   */
  onScheduled?: (id: string) => void;
}

const UI_FILE = path.resolve(__dirname, "..", "..", "assets", "web", "app.html");

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    // The page is entirely self-contained apart from the font stylesheet, so
    // it can be locked down hard. No inline-script exemption is needed for
    // data because none of it is injected into the HTML.
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(text);
}

/** Whoever is asking, as well as it can be known behind a proxy. */
function clientKey(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return (first ?? req.socket.remoteAddress ?? "unknown").trim();
}

async function readBody(req: IncomingMessage, limit = 8_192): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      // A login body is tiny. Anything larger is not a login.
      if (raw.length > limit) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/**
 * Parsed wallet lists, held between the upload and the stream that consumes
 * them.
 *
 * An event stream is a GET, and a list of fifty thousand addresses does not
 * fit in a query string — so the upload posts the list, gets a handle back,
 * and the stream quotes the handle. Entries expire because an abandoned
 * upload should not pin megabytes in memory for the life of the process.
 */
const FILTER_JOB_TTL_MS = 30 * 60 * 1000;
const filterJobs = new Map<string, { addresses: string[]; at: number }>();

function putFilterJob(addresses: string[]): string {
  const now = Date.now();
  for (const [id, job] of filterJobs) if (now - job.at > FILTER_JOB_TTL_MS) filterJobs.delete(id);
  const id = mintSession(String(now), now, 0).slice(0, 22);
  filterJobs.set(id, { addresses, at: now });
  return id;
}

/** An open event stream, with helpers for the shapes the page listens for. */
class Stream {
  constructor(private readonly res: ServerResponse) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      // Proxies that buffer would defeat the entire point of streaming.
      "x-accel-buffering": "no",
    });
  }

  send(event: string, data: unknown): void {
    if (this.res.writableEnded) return;
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  line(text: string): void {
    this.send("line", { text });
  }

  progress(percent: number | null, message?: string): void {
    this.send("progress", { percent, message });
  }

  done(message: string): void {
    this.send("done", { message });
    this.res.end();
  }

  failed(message: string): void {
    this.send("failed", { message });
    this.res.end();
  }

  get closed(): boolean {
    return this.res.writableEnded;
  }
}

/**
 * Start the web UI, or return null when it is not configured.
 *
 * Refuses to start on a weak token rather than opening a guessable door onto
 * a key store. A missing token is "not configured" and is silent; a bad one
 * is a misconfiguration and is loud.
 */
export function startWebServer(deps: WebServerDeps): { close: () => void } | null {
  const strength = checkTokenStrength(deps.token);
  if (!strength.ok) {
    if (deps.token) {
      console.error(`Web UI not started — ${strength.reason}. Everything stays on Telegram.`);
    }
    return null;
  }

  const token = deps.token!.trim();
  // Sessions are signed with a key derived at boot, so a restart invalidates
  // every outstanding session. For a key store that is the right trade.
  const sessionSecret = mintSession(token, Date.now(), 0) + process.pid;
  const limiter = new LoginLimiter();

  const authed = (req: IncomingMessage): boolean =>
    verifySession(parseCookies(req.headers.cookie).l00p_session, sessionSecret);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = url.pathname;

    try {
      // ---- the page itself ----
      if (req.method === "GET" && (route === "/" || route === "/index.html")) {
        const html = fs.readFileSync(UI_FILE, "utf8");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
        });
        res.end(html);
        return;
      }

      // ---- login ----
      if (req.method === "POST" && route === "/api/login") {
        const key = clientKey(req);
        const waitMs = limiter.lockedFor(key);
        if (waitMs > 0) {
          json(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(waitMs / 60_000)} minute(s).` });
          return;
        }
        const body = await readBody(req);
        if (!secretsMatch(String(body.token ?? ""), token)) {
          limiter.recordFailure(key);
          json(res, 401, { error: "That token is not right." });
          return;
        }
        limiter.recordSuccess(key);
        res.setHeader("set-cookie", sessionCookie(mintSession(sessionSecret), { secure: deps.secureCookies ?? false }));
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && route === "/api/logout") {
        res.setHeader("set-cookie", clearedCookie());
        json(res, 200, { ok: true });
        return;
      }

      // ---- everything past here needs a session ----
      if (!authed(req)) {
        json(res, 401, { error: "Not signed in." });
        return;
      }

      const store = deps.stores.for(deps.ownerId);
      const settings = store.getSettings();
      const chain = resolveChain(settings.chainKey);
      const { urls } = resolveRpcsForChain(settings.chainKey);

      if (req.method === "GET" && route === "/api/overview") {
        const wallets = store.listWallets();
        let total = 0n;
        const provider = createProvider(readableRpcs(urls)[0]);
        await Promise.all(
          wallets.map(async (w) => {
            try {
              total += await provider.getBalance(w.address);
            } catch {
              /* a balance we cannot read is not a balance of zero, but the
                 total is a summary and one unreachable wallet must not fail it */
            }
          })
        );
        json(res, 200, {
          wallets: wallets.length,
          chain: chain?.name ?? settings.chainKey,
          symbol: chain?.nativeSymbol ?? "ETH",
          totalBalance: Number(formatEther(total)).toFixed(4),
          copyRunning: settings.copyMintEnabled,
          copyTargets: store.listCopyTargets().length,
          earlyFire:
            settings.earlyFireMs === 0 ? "off" : settings.earlyFireMs === -1 ? "auto" : `${settings.earlyFireMs}ms`,
        });
        return;
      }

      if (req.method === "GET" && route === "/api/wallets") {
        const provider = createProvider(readableRpcs(urls)[0]);
        const wallets = await Promise.all(
          store.listWallets().map(async (w) => {
            let balance = "—";
            try {
              balance = Number(formatEther(await provider.getBalance(w.address))).toFixed(4);
            } catch {
              /* shown as a dash rather than a wrong number */
            }
            return {
              // Deliberately address, label and flags only. No key, ever.
              label: w.label,
              address: w.address,
              balance,
              auto: w.includeInAutoMint !== false,
              copy: w.includeInCopyMint !== false,
            };
          })
        );
        json(res, 200, { wallets, symbol: chain?.nativeSymbol ?? "ETH" });
        return;
      }

      // ---- settings ----
      if (req.method === "GET" && route === "/api/settings") {
        json(res, 200, {
          settings: {
            chainKey: settings.chainKey,
            maxFeeGwei: settings.maxFeeGwei,
            priorityGwei: settings.priorityGwei,
            gasLimit: settings.gasLimit,
            earlyFireMs: settings.earlyFireMs,
            copyMintMaxPriceEth: settings.copyMintMaxPriceEth,
            copyBackfillHours: settings.copyBackfillHours,
          },
          chains: CHAINS.map((c) => ({ key: c.key, name: c.name })),
        });
        return;
      }

      if (req.method === "POST" && route === "/api/settings") {
        const body = await readBody(req);
        // Allow-listed rather than spread: an open updateSettings from a web
        // request would let anything in the body become a setting.
        const patch: Record<string, unknown> = {};
        const numeric = [
          "maxFeeGwei",
          "priorityGwei",
          "gasLimit",
          "earlyFireMs",
          "copyMintMaxPriceEth",
          "copyBackfillHours",
        ];
        for (const field of numeric) {
          if (body[field] === undefined) continue;
          const value = Number(body[field]);
          if (!Number.isFinite(value)) {
            json(res, 400, { error: `${field} must be a number.` });
            return;
          }
          patch[field] = value;
        }
        if (typeof body.chainKey === "string") {
          if (!CHAINS.some((c) => c.key === body.chainKey)) {
            json(res, 400, { error: "Unknown chain." });
            return;
          }
          patch.chainKey = body.chainKey;
        }
        store.updateSettings(patch as any);
        json(res, 200, { ok: true, settings: store.getSettings() });
        return;
      }

      // ---- wallet edits: naming and which watchers use them ----
      // Configuration only. Nothing here can move a token or reveal a key.
      if (req.method === "POST" && route === "/api/wallets/rename") {
        const body = await readBody(req);
        const renamed = store.renameWallet(String(body.address ?? ""), String(body.label ?? ""));
        if (!renamed) {
          json(res, 404, { error: "No such wallet." });
          return;
        }
        json(res, 200, { ok: true, label: renamed.label });
        return;
      }

      if (req.method === "POST" && route === "/api/wallets/toggle") {
        const body = await readBody(req);
        const feature = body.feature === "auto" ? "auto" : "copy";
        try {
          const updated = store.setWalletInclusion(String(body.address ?? ""), feature, Boolean(body.on));
          json(res, 200, { ok: true, auto: updated.includeInAutoMint !== false, copy: updated.includeInCopyMint !== false });
        } catch (err: any) {
          json(res, 404, { error: err?.message ?? "No such wallet." });
        }
        return;
      }

      if (req.method === "POST" && route === "/api/wallets/rename-all") {
        const wallets = store.listWallets();
        const names = loopNames(wallets.map((w) => w.address));
        let changed = 0;
        for (const w of wallets) {
          const name = names.get(w.address);
          if (name && name !== w.label && store.renameWallet(w.address, name)) changed++;
        }
        json(res, 200, { ok: true, changed });
        return;
      }

      // ---- copy-mint watchlist ----
      if (req.method === "GET" && route === "/api/copy") {
        json(res, 200, {
          enabled: settings.copyMintEnabled,
          targets: store.listCopyTargets().map((t) => ({ label: t.label, address: t.address })),
        });
        return;
      }

      if (req.method === "POST" && route === "/api/copy/add") {
        const body = await readBody(req);
        const address = String(body.address ?? "").trim();
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
          json(res, 400, { error: "That is not a wallet address." });
          return;
        }
        try {
          const added = store.addCopyTarget(String(body.label ?? "").trim(), address);
          json(res, 200, { ok: true, label: added.label });
        } catch (err: any) {
          json(res, 409, { error: err?.message ?? "Already watched." });
        }
        return;
      }

      if (req.method === "POST" && route === "/api/copy/remove") {
        const body = await readBody(req);
        store.removeCopyTarget(String(body.address ?? ""));
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && route === "/api/copy/rename") {
        const body = await readBody(req);
        const renamed = store.renameCopyTarget(String(body.address ?? ""), String(body.label ?? ""));
        if (!renamed) {
          json(res, 404, { error: "That wallet is not watched." });
          return;
        }
        json(res, 200, { ok: true, label: renamed.label });
        return;
      }

      // ---- wallet filter ----
      // Reads balances and nonces for a pasted list. Touches no wallet of
      // yours and signs nothing; the addresses are someone else's.
      if (req.method === "POST" && route === "/api/filter/parse") {
        const body = await readBody(req, 24 * 1024 * 1024);
        const parsed = parseWalletList(String(body.text ?? ""));
        if (parsed.addresses.length === 0) {
          json(res, 400, { error: "No wallet addresses in that file." });
          return;
        }
        json(res, 200, {
          job: putFilterJob(parsed.addresses),
          count: parsed.addresses.length,
          summary: describeParse(parsed),
        });
        return;
      }

      if (req.method === "POST" && route === "/api/filter/criteria") {
        const body = await readBody(req);
        const criteria = parseCriteria(String(body.text ?? ""));
        if (!criteria) {
          json(res, 400, { error: "I can filter on balance and transactions. Try 'more than 5 transactions'." });
          return;
        }
        json(res, 200, { criteria, description: describeCriteria(criteria), fields: fieldsNeeded(criteria) });
        return;
      }

      // ---- minting ----
      //
      // These spend. You asked for them here, so the line moved -- but it
      // moved once and deliberately, and it stopped in a different place
      // rather than being erased:
      //
      //   the web MAY spend      (fire a mint, arm one for later)
      //   the web MAY NOT read   (no key, no seed, ever leaves this process)
      //
      // Signing happens server-side from the encrypted store, exactly as the
      // Telegram path does. A stolen session can therefore cost you a mint's
      // worth of gas, and cannot cost you a wallet.
      if (req.method === "POST" && route === "/api/mint/preview") {
        const body = await readBody(req);
        let contract: string;
        try {
          contract = await resolveMintTarget(String(body.contract ?? "").trim(), settings.chainKey);
        } catch (err: any) {
          json(res, 400, { error: `Couldn't read that as a collection: ${err?.message ?? err}` });
          return;
        }

        const quantity = Math.max(1, Math.floor(Number(body.quantity) || 1));
        const plan = await raceReadOrNull(urls, (url) => buildLocalMintPlan(url, contract, quantity));
        if (!plan) {
          json(res, 404, { error: "That collection has no readable public stage on this chain." });
          return;
        }

        const window = stageWindow(plan.drop.startTime, plan.drop.endTime);
        const info = await lookupContract(settings.chainKey, contract, process.env.OPENSEA_API_KEY);
        const wallets = store.listWallets();

        const rows = await Promise.all(
          wallets.map(async (w) => {
            const [balance, elig] = await Promise.all([
              tryInOrder(readableRpcs(urls), (url) => createProvider(url).getBalance(w.address)).catch(() => null),
              tryInOrder(urls, (url) =>
                checkEligibility(url, contract, w.address, plan.drop.maxTotalMintableByWallet)
              ).catch(() => null),
            ]);
            const r = assessWallet(w.address, {
              balanceWei: balance,
              mintPriceWei: plan.drop.mintPrice,
              maxFeePerGas: BigInt(Math.round(settings.maxFeeGwei * 1e9)) || 1_000_000_000n,
              gasLimit: settings.gasLimit,
              maxPerWallet: plan.drop.maxTotalMintableByWallet,
              alreadyMinted: elig?.alreadyMinted ?? 0,
              supplyRemaining: elig?.supplyRemaining ?? Number.MAX_SAFE_INTEGER,
              requested: quantity,
            });
            return {
              address: w.address,
              label: w.label,
              canMint: r.canMint,
              reason: r.reason ?? null,
              balance: balance === null ? null : Number(formatEther(balance)).toFixed(4),
            };
          })
        );

        json(res, 200, {
          contract,
          name: isLookupFailure(info) ? null : info.name,
          priceEth: Number(formatEther(plan.drop.mintPrice)),
          maxPerWallet: plan.drop.maxTotalMintableByWallet,
          startTime: plan.drop.startTime,
          endTime: plan.drop.endTime,
          live: window.live,
          opensInMs: window.opensInMs,
          ended: window.ended,
          symbol: chain?.nativeSymbol ?? "ETH",
          wallets: rows,
        });
        return;
      }

      // Simulate rather than send. Costs nothing, spends nothing, and on an
      // allow-list stage armed in advance it separates "your proof is wrong"
      // from "you are simply early" -- which at fire time look identical and
      // by then cannot be fixed.
      if (req.method === "POST" && route === "/api/mint/preflight") {
        const body = await readBody(req);
        let contract: string;
        try {
          contract = await resolveMintTarget(String(body.contract ?? "").trim(), settings.chainKey);
        } catch (err: any) {
          json(res, 400, { error: `Couldn't read that as a collection: ${err?.message ?? err}` });
          return;
        }
        const quantity = Math.max(1, Math.floor(Number(body.quantity) || 1));
        const chosen: string[] = Array.isArray(body.wallets) ? body.wallets.map(String) : [];
        const plan = await raceReadOrNull(urls, (url) => buildLocalMintPlan(url, contract, quantity));
        if (!plan) {
          json(res, 404, { error: "That collection has no readable public stage on this chain." });
          return;
        }

        const rpcUrl = readableRpcs(urls)[0];
        const wallets = store.listWallets().filter((w) => chosen.includes(w.address));
        const results = await Promise.all(
          wallets.map(async (w) => {
            const p = await simulateMint({
              rpcUrl,
              from: w.address,
              to: plan.to,
              data: plan.data,
              value: plan.value,
            });
            return { address: w.address, label: w.label, ...p };
          })
        );
        json(res, 200, { results });
        return;
      }

      if (req.method === "POST" && route === "/api/mint/schedule") {
        const body = await readBody(req);
        let contract: string;
        try {
          contract = await resolveMintTarget(String(body.contract ?? "").trim(), settings.chainKey);
        } catch (err: any) {
          json(res, 400, { error: `Couldn't read that as a collection: ${err?.message ?? err}` });
          return;
        }
        const chosen = Array.isArray(body.wallets) ? body.wallets.map(String) : [];
        if (chosen.length === 0) {
          json(res, 400, { error: "Pick at least one wallet." });
          return;
        }
        const quantity = Math.max(1, Math.floor(Number(body.quantity) || 1));
        // "now" arms it for immediate fire; anything else must be a future
        // moment, since arming for the past is a fire with extra steps.
        const at = body.at === "now" ? Date.now() : Number(body.at);
        if (!Number.isFinite(at)) {
          json(res, 400, { error: "That is not a time." });
          return;
        }

        const info = await lookupContract(settings.chainKey, contract, process.env.OPENSEA_API_KEY);
        const record = store.addScheduled({
          chainKey: settings.chainKey,
          nftContract: contract,
          name: isLookupFailure(info) ? undefined : info.name,
          slug: isLookupFailure(info) ? undefined : info.slug,
          quantity,
          wallets: chosen,
          targetStartMs: at,
        });
        deps.onScheduled?.(record.id);
        json(res, 200, { ok: true, id: record.id, targetStartMs: record.targetStartMs });
        return;
      }

      if (req.method === "GET" && route === "/api/scheduled") {
        json(res, 200, {
          armed: store.listPendingScheduled().map((r) => ({
            id: r.id,
            name: r.name ?? null,
            contract: r.nftContract,
            quantity: r.quantity,
            wallets: r.wallets.length,
            targetStartMs: r.targetStartMs,
          })),
        });
        return;
      }

      if (req.method === "POST" && route === "/api/scheduled/cancel") {
        const body = await readBody(req);
        const removed = store.removeScheduled(String(body.id ?? ""));
        json(res, 200, { ok: removed });
        return;
      }

      // ---- streaming jobs ----
      const streamRoute = /^\/api\/stream\/(find|pnl|scan|filter)$/.exec(route);
      if (req.method === "GET" && streamRoute) {
        const raw = (url.searchParams.get("contract") ?? "").trim();
        const stream = new Stream(res);
        req.on("close", () => {
          /* the client went away; the job below checks stream.closed */
        });

        // The filter works on a posted list rather than a contract, so it
        // takes the other path entirely.
        if (streamRoute[1] === "filter") {
          const job = filterJobs.get(url.searchParams.get("job") ?? "");
          const criteria = parseCriteria(url.searchParams.get("criteria") ?? "");
          if (!job) {
            stream.failed("That upload expired. Send the file again.");
            return;
          }
          if (!criteria) {
            stream.failed("I could not read that as a filter.");
            return;
          }
          await runFilterJob(stream, job.addresses, criteria, urls);
          return;
        }

        let contract: string;
        try {
          const parsed = parseNftLink(raw);
          if (parsed.kind !== "address") throw new Error("Send a contract address.");
          contract = parsed.value;
        } catch (err: any) {
          stream.failed(`Couldn't read that as a contract: ${err?.message ?? err}`);
          return;
        }

        await runScanJob(streamRoute[1] as "find" | "pnl" | "scan", stream, {
          contract,
          store,
          settings,
          urls,
          chainName: chain?.nativeSymbol ?? "ETH",
          chainKey: settings.chainKey,
        });
        return;
      }

      json(res, 404, { error: "No such route." });
    } catch (err: any) {
      if (!res.writableEnded) json(res, 500, { error: err?.message ?? "Something failed." });
    }
  });

  server.listen(deps.port, () => {
    console.log(`Web UI on port ${deps.port} — unlock it with WEB_ACCESS_TOKEN.`);
  });

  return { close: () => server.close() };
}

/**
 * The scan every streaming route starts from.
 *
 * All three want the same thing first — what these wallets hold, read off the
 * chain — and differ only in what they say about it afterwards. Streaming the
 * progress is what makes a multi-minute walk bearable, and is the thing
 * Telegram could not do.
 */
async function runScanJob(
  kind: "find" | "pnl" | "scan",
  stream: Stream,
  ctx: {
    contract: string;
    store: ReturnType<UserStores["for"]>;
    settings: any;
    urls: string[];
    chainName: string;
    chainKey: string;
  }
): Promise<void> {
  const wallets = ctx.store.listWallets();
  if (wallets.length === 0) {
    stream.failed("No wallets to check. Add them in Telegram first.");
    return;
  }

  stream.line(`Checking ${wallets.length} wallet(s)…`);
  let scan;
  try {
    scan = await tryInOrder(ctx.urls, (url) =>
      scanHoldings(url, ctx.contract, wallets.map((w) => w.address), {
        onProgress: (checked, total) => {
          if (stream.closed || total <= 0) return;
          stream.progress(
            Math.min(100, Math.round((checked / total) * 100)),
            `${checked.toLocaleString()} of ${total.toLocaleString()} tokens checked`
          );
        },
      })
    );
  } catch (err: any) {
    stream.failed(`Couldn't read that collection: ${err?.shortMessage ?? err?.message ?? err}`);
    return;
  }

  const found = holders(scan);
  const quantity = found.reduce((sum, h) => sum + h.tokenIds.length, 0);
  if (quantity === 0) {
    const unreadable = scan.skipped.filter((s) => s.reason !== "holds none");
    for (const s of unreadable) stream.line(`  ${s.address.slice(0, 10)}… — ${s.reason}`);
    stream.done("None of your wallets hold this collection.");
    return;
  }

  const labelFor = (addr: string) =>
    wallets.find((w) => w.address.toLowerCase() === addr.toLowerCase())?.label ?? addr.slice(0, 10);
  stream.line(`Found ${quantity} across ${found.length} wallet(s):`);
  for (const h of found) stream.line(`  ${labelFor(h.address)} — ${h.tokenIds.length}`);

  if (kind === "scan") {
    stream.done(`${quantity} token(s) ready to consolidate. Fire the transfer from Telegram.`);
    return;
  }

  // Market data, best effort. The holdings above are already the certain part.
  stream.progress(100, "Pricing…");
  const lookup = await lookupContract(ctx.chainKey, ctx.contract, process.env.OPENSEA_API_KEY);
  const slug = isLookupFailure(lookup) ? null : lookup.slug;
  if (!slug) {
    stream.line(`OpenSea has no collection for this contract — ${isLookupFailure(lookup) ? lookup.detail : ""}`);
    stream.done("Holdings are on-chain and correct; there is no market data to price them against.");
    return;
  }

  const key = process.env.OPENSEA_API_KEY;
  const [info, stats, offer] = await Promise.all([
    fetchCollection(slug, key).catch(() => null),
    fetchStats(slug, key).catch(() => null),
    fetchBestCollectionOffer(slug, key).catch(() => null),
  ]);

  if (kind === "find") {
    stream.line(`Floor: ${stats?.floorPrice ?? "—"}   Best offer: ${offer?.priceEth ?? "—"}`);
    stream.done(`${info?.name ?? slug} — ${quantity} held.`);
    return;
  }

  let gasEth: number | null = null;
  try {
    const head = await tryInOrder(readableRpcs(ctx.urls), (url) => createProvider(url).getBlock("latest"));
    const ceiling =
      ctx.settings.maxFeeGwei > 0
        ? BigInt(Math.round(ctx.settings.maxFeeGwei * 1e9))
        : resolveMaxFee(0n, head?.baseFeePerGas ?? 0n, BigInt(Math.round(ctx.settings.priorityGwei * 1e9)))
            .maxFeePerGas || marketFee(1_000_000_000n, 0n);
    gasEth = Number(
      formatEther(found.map((h) => BigInt(gasLimitForQuantity(h.tokenIds.length)) * ceiling).reduce((a, b) => a + b, 0n))
    );
  } catch {
    /* modelled gas we cannot model is better omitted than guessed */
  }

  const report: PnlReport = {
    name: info?.name ?? slug,
    contract: ctx.contract,
    symbol: ctx.chainName,
    quantity,
    wallets: found.length,
    mintPriceEth: null,
    gasEth,
    floorEth: stats?.floorPrice ?? null,
    bestOfferEth: offer?.priceEth ?? null,
    priceSource: "unknown",
    breakdown: found.map((h) => ({ address: h.address, label: labelFor(h.address), count: h.tokenIds.length })),
  };
  for (const line of renderPnl(report, computePnl(report)).split("\n")) {
    if (line.trim()) stream.line(line.replace(/\*/g, "").replace(/_/g, ""));
  }
  stream.done("P&L complete.");
}

/**
 * Read balances and nonces for a pasted list, and report what matches.
 *
 * This is the job that most wanted a browser. Fifty thousand wallets is
 * hundreds of thousands of chain reads and can run for a long time; on
 * Telegram that meant a progress message edited every four seconds to stay
 * inside a rate limit, and a hard ceiling that killed it anyway. Here it is
 * just a stream that keeps talking.
 *
 * These addresses are someone else's. Nothing is signed and no wallet of
 * yours is touched.
 */
async function runFilterJob(
  stream: Stream,
  addresses: string[],
  criteria: Criteria,
  urls: string[]
): Promise<void> {
  const fields = fieldsNeeded(criteria);
  stream.line(`${addresses.length.toLocaleString()} wallet(s) · ${describeCriteria(criteria)}`);
  stream.line(`${(addresses.length * fields.length).toLocaleString()} chain read(s) to do.`);

  try {
    const result = await enrichWallets({
      rpcUrl: readableRpcs(urls)[0],
      addresses,
      fields,
      shouldStop: () => stream.closed,
      onProgress: (p) => {
        if (stream.closed) return;
        stream.progress(
          Math.min(100, Math.round((p.done / p.total) * 100)),
          `${p.done.toLocaleString()} of ${p.total.toLocaleString()} · ${p.rate.toFixed(0)}/sec · ${describeEta(
            p.etaSeconds
          )} left`
        );
      },
    });

    const matched = applyCriteria(result.stats, criteria);
    const csv = toCsv(
      matched.map((m) => ({
        address: m.address,
        ...(m.balance !== undefined ? { balance: m.balance } : {}),
        ...(m.txCount !== undefined ? { transactions: m.txCount } : {}),
      }))
    );

    stream.line("");
    stream.line(`Matched ${matched.length.toLocaleString()} of ${addresses.length.toLocaleString()}.`);
    if (result.unreadable.length > 0) {
      stream.line(`${result.unreadable.length.toLocaleString()} could not be read and are excluded.`);
    }
    // Handed over as data rather than a file the server has to keep: the
    // page turns it into a download without another round trip.
    stream.send("result", { csv, matched: matched.length, total: addresses.length });
    stream.done(result.stopped ? "Stopped early — results are what it found." : "Filter complete.");
  } catch (err: any) {
    stream.failed(`Filter failed: ${err?.shortMessage ?? err?.message ?? err}`);
  }
}

/**
 * Turn whatever was pasted into a contract address.
 *
 * The same three shapes the bot accepts: a raw address, an OpenSea link, or a
 * bare slug. Kept here rather than imported from bot.ts because that module
 * builds a Telegraf instance on import, which a web request has no business
 * doing.
 */
async function resolveMintTarget(link: string, chainKey: string): Promise<string> {
  const parsed = parseNftLink(link);
  if (parsed.kind === "address") return parsed.value;
  const info = await resolveSlug(parsed.value, process.env.OPENSEA_API_KEY, chainKey);
  return info.contractAddress;
}
