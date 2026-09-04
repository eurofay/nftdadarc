// Racing reads across every endpoint, instead of trusting the first one.
//
// The read endpoint is chosen for the widest eth_getLogs range, because the
// copy watcher has to scan. But drop lookups on the mint path are eth_call,
// which every read endpoint serves — and the widest scanner is not always the
// quickest. Measured from Railway US East:
//
//   public rpc (widest scans)  1609ms
//   alchemy    (10-block cap)    18ms
//
// buildLocalMintPlan makes two sequential eth_calls, and copy-mint builds a
// plan twice, so four round trips sit between seeing a mint and sending one:
// ~6.4s on the slow endpoint against ~72ms on the quick one. Racing costs a
// few redundant calls and removes that entirely — whichever endpoint is
// healthiest right now wins, with no configuration to keep in step.

import { Logger, defaultLogger } from "./logger";

/**
 * First successful result across all endpoints.
 *
 * A rejection is not a failure of the race — send-only endpoints reject every
 * read, and a rate-limited one rejects intermittently. Only when EVERY
 * endpoint fails does this reject, carrying the first error so the caller can
 * report something specific.
 */
export async function raceRead<T>(
  rpcUrls: string[],
  read: (url: string) => Promise<T>,
  isUsable: (value: T) => boolean = (v) => v !== null && v !== undefined
): Promise<T> {
  if (rpcUrls.length === 0) throw new Error("No RPC endpoints to read from.");

  return new Promise<T>((resolve, reject) => {
    let outstanding = rpcUrls.length;
    let settled = false;
    let firstError: unknown;

    for (const url of rpcUrls) {
      read(url)
        .then((value) => {
          // A null answer means "this endpoint couldn't tell us", not "the
          // answer is nothing" — let a slower endpoint still win.
          if (settled || !isUsable(value)) return;
          settled = true;
          resolve(value);
        })
        .catch((err) => {
          if (firstError === undefined) firstError = err;
        })
        .finally(() => {
          outstanding -= 1;
          if (outstanding === 0 && !settled) {
            settled = true;
            reject(firstError ?? new Error("No endpoint returned a usable result."));
          }
        });
    }
  });
}

/** Same race, but a total failure yields null rather than throwing. */
export async function raceReadOrNull<T>(
  rpcUrls: string[],
  read: (url: string) => Promise<T | null>,
  logger: Logger = defaultLogger
): Promise<T | null> {
  try {
    return await raceRead(rpcUrls, read);
  } catch (err: any) {
    logger.info(`  No endpoint could answer: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Endpoints that can actually answer a read.
 *
 * A sequencer accepts eth_sendRawTransaction and rejects everything else —
 * including eth_chainId, which ethers calls once when constructing a provider.
 * That detection fails, and the provider then retries every second for the
 * life of the process, filling the log with "failed to detect network" while
 * the read it was for has long since been served by another endpoint.
 *
 * So reads are pointed only at endpoints that serve reads. Sending still goes
 * to every endpoint, which is where the sequencer earns its place.
 */
export function readableRpcs(urls: string[]): string[] {
  const readable = urls.filter((url) => !/sequencer/i.test(url));
  // Never hand back an empty list: a caller with nothing to read from fails
  // in a far more confusing way than one that tries an unlikely endpoint.
  return readable.length > 0 ? readable : urls;
}
