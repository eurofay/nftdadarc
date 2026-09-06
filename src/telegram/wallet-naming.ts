// Naming a whole set of wallets at once.
//
// A seed derives ten wallets in one go and they all arrive called things like
// "0x8C25B4", which is the default and tells you nothing you cannot already
// see. A scheme that names them from their own address keeps the label tied to
// the thing it identifies, so a name can never drift onto the wrong wallet.

/** Default: enough of the address to pick a wallet out of a list. */
export const NAME_PREFIX = "l00p-";

/** How much of the address the name ends with, before collisions widen it. */
export const DEFAULT_SUFFIX = 3;

/**
 * Assign a name to every address, widening the suffix only where it must.
 *
 * Three hex characters is 4,096 possibilities, so across a dozen wallets a
 * collision is unlikely but not rare — and two wallets sharing a name defeats
 * the entire point of naming them. Where two or more would collide, every
 * name in that group grows by one character until they are distinct. Only the
 * clashing group widens: the rest stay short.
 *
 * Returns a map keyed by the address exactly as it was passed in.
 */
export function loopNames(
  addresses: string[],
  opts: { prefix?: string; suffix?: number } = {}
): Map<string, string> {
  const prefix = opts.prefix ?? NAME_PREFIX;
  const start = Math.max(1, opts.suffix ?? DEFAULT_SUFFIX);
  const names = new Map<string, string>();

  // Group by the short form first, then widen only the groups that clash.
  const groups = new Map<string, string[]>();
  for (const address of addresses) {
    const key = tail(address, start).toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), address]);
  }

  for (const group of groups.values()) {
    let width = start;
    // Widen until distinct, bounded by the address itself: two entries for the
    // same address can never be told apart, and looping forever to discover
    // that would be worse than naming them identically.
    const maxWidth = Math.max(...group.map((a) => stripPrefix(a).length));
    while (width < maxWidth) {
      const seen = new Set(group.map((a) => tail(a, width).toLowerCase()));
      if (seen.size === group.length) break;
      width++;
    }
    for (const address of group) names.set(address, `${prefix}${tail(address, width)}`);
  }

  return names;
}

/** The last n characters of the address, ignoring the 0x. */
export function tail(address: string, n: number): string {
  const body = stripPrefix(address);
  return body.slice(Math.max(0, body.length - n));
}

function stripPrefix(address: string): string {
  return address.startsWith("0x") || address.startsWith("0X") ? address.slice(2) : address;
}

/**
 * A short preview of what a bulk rename would do.
 *
 * Renaming every wallet at once overwrites names someone may have chosen
 * deliberately, so it is worth showing before it happens rather than after.
 */
export function describeRenamePlan(
  wallets: { address: string; label: string }[],
  names: Map<string, string>,
  limit = 12
): string {
  const changing = wallets.filter((w) => names.get(w.address) !== w.label);
  if (changing.length === 0) return "Every wallet already has that name.";

  const lines = changing
    .slice(0, limit)
    .map((w) => `  ${w.label} → ${names.get(w.address)}`);
  if (changing.length > limit) lines.push(`  …and ${changing.length - limit} more`);
  return lines.join("\n");
}
