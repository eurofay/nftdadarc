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
import { resolveChain } from "../chains";
import { createProvider } from "../rpc-provider";
import { readableRpcs, tryInOrder } from "../fast-read";
import { scanHoldings, holders } from "../nft-consolidate";
import { lookupContract, isLookupFailure } from "../slug-resolver";
import { fetchCollection, fetchStats, fetchBestCollectionOffer } from "../opensea-market";
import { computePnl, renderPnl, PnlReport } from "../pnl";
import { gasLimitForQuantity } from "../gas";
import { resolveMaxFee, marketFee } from "../gas-fit";
import { parseNftLink } from "../nft-link";
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

      // ---- streaming jobs ----
      const streamRoute = /^\/api\/stream\/(find|pnl|scan)$/.exec(route);
      if (req.method === "GET" && streamRoute) {
        const raw = (url.searchParams.get("contract") ?? "").trim();
        const stream = new Stream(res);
        req.on("close", () => {
          /* the client went away; the job below checks stream.closed */
        });

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
