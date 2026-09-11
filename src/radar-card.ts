// The card a radar alert arrives as.
//
// A drop alert is read in two seconds on a phone, usually while doing
// something else, and the decision it has to support is "do I arm this or
// ignore it". So the hierarchy is: how long have I got, what does it cost,
// and is it actually mintable by wallets I hold. Everything else is
// supporting detail.
//
// The contract address is shown in full rather than masked. A mask is right
// in a list, where addresses are labels to tell apart; it is wrong here,
// where the address is the thing you copy into the bot to act on it.

import { PALETTE, fitText } from "./mint-card";

export interface RadarCardData {
  collection: string;
  contract: string;
  chain: string;
  /** "in 34 min", "opening now" — already formatted by drop-radar.countdown. */
  countdown: string;
  /** "FREE" or "0.0050 ETH". */
  price: string;
  maxPerWallet: number;
  /** Wallets of yours that could mint it right now, and how many you hold. */
  readyWallets?: number;
  totalWallets?: number;
  /** Local time the stage opens, pre-formatted. */
  opensAt: string;
  /** Supply cap if known. */
  maxSupply?: number | null;
  /** True once the stage is open — changes the whole read of the card. */
  live?: boolean;
  artHref?: string | null;
}

const esc = (s: string): string =>
  s.replace(/[<>&"']/g, (c) => (
    { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" } as Record<string, string>
  )[c]);

/**
 * Which tint the card carries.
 *
 * Same logic the P&L card uses, so the two read as one family: flame is the
 * brand and the neutral state, mint means good news, ember means urgent.
 * A live drop is ember for the same reason a loss is -- it is the one you
 * cannot sit on.
 */
export function accentFor(d: Pick<RadarCardData, "live" | "price">): string {
  if (d.live) return PALETTE.ember;
  return d.price === "FREE" ? PALETTE.mint : PALETTE.flame;
}

export function renderRadarCard(d: RadarCardData): string {
  const W = 1256;
  const H = 810;
  const tint = accentFor(d);
  const status = d.live ? "LIVE NOW" : "DROP RADAR";

  // The same diagonal seam the mint and P&L cards use. It is the family
  // signature -- a vertical split renders fine and looks like a different
  // product, which for something arriving in the same chat is worse than
  // ugly.
  const seam = "M0,0 L742,0 L560,810 L0,810 Z";

  const art = d.artHref
    ? `<image href="${esc(d.artHref)}" x="-40" y="0" width="820" height="810"
              preserveAspectRatio="xMidYMid slice"/>`
    : `<g>
         <rect x="-40" y="0" width="820" height="810" fill="${PALETTE.groundLift}"/>
         <text x="350" y="470" text-anchor="middle" font-family="'DM Sans',Inter,sans-serif"
               font-size="300" font-weight="700" fill="${PALETTE.ground}"
               >${esc(d.collection.slice(0, 2).toUpperCase())}</text>
       </g>`;

  const x = 792;
  const rows: string[] = [];
  let y = 356;
  const row = (label: string, value: string, colour: string = PALETTE.cream) => {
    rows.push(
      `<text x="${x}" y="${y}" font-family="'DM Mono','SF Mono',ui-monospace,monospace" font-size="12"
             letter-spacing="4" fill="${PALETTE.creamDim}">${esc(label)}</text>
       <text x="${x}" y="${y + 42}" font-family="'DM Sans',Inter,system-ui,sans-serif" font-size="34"
             font-weight="700" fill="${colour}">${esc(value)}</text>`
    );
    y += 92;
  };

  row("PRICE", d.price, d.price === "FREE" ? PALETTE.mint : PALETTE.cream);
  row("MAX PER WALLET", d.maxPerWallet > 0 ? String(d.maxPerWallet) : "unlimited");
  if (d.readyWallets !== undefined && d.totalWallets !== undefined) {
    // The line that decides whether this alert is actionable at all.
    row(
      "YOUR WALLETS",
      `${d.readyWallets} of ${d.totalWallets} funded`,
      d.readyWallets > 0 ? PALETTE.mint : PALETTE.salmon
    );
  }
  if (d.maxSupply) row("SUPPLY", d.maxSupply.toLocaleString());

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="night" x1="0.15" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="${PALETTE.ground}"/>
      <stop offset="58%"  stop-color="${PALETTE.void}"/>
      <stop offset="100%" stop-color="#0B100F"/>
    </linearGradient>
    <linearGradient id="seamGlow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="${tint}" stop-opacity="1"/>
      <stop offset="100%" stop-color="${tint}" stop-opacity="0.18"/>
    </linearGradient>
    <linearGradient id="artFade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="55%"  stop-color="${PALETTE.void}" stop-opacity="0"/>
      <stop offset="100%" stop-color="${PALETTE.void}" stop-opacity="0.92"/>
    </linearGradient>
    <clipPath id="seamClip"><path d="${seam}"/></clipPath>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#night)"/>

  <g clip-path="url(#seamClip)">
    ${art}
    <rect x="-40" y="0" width="820" height="810" fill="url(#artFade)"/>
  </g>
  <path d="M742,0 L560,810" stroke="url(#seamGlow)" stroke-width="3" fill="none"/>

  <text x="${x}" y="96" font-family="'DM Mono','SF Mono',ui-monospace,monospace" font-size="12"
        letter-spacing="4" fill="${tint}">${esc(status)}</text>
  <text x="${x}" y="146" font-family="'DM Sans',Inter,system-ui,sans-serif" font-size="40"
        font-weight="700" fill="${PALETTE.cream}">${esc(fitText(d.collection, 20))}</text>

  <!-- The countdown is the headline: it is what the whole alert is for. -->
  <text x="${x}" y="246" font-family="'DM Sans',Inter,system-ui,sans-serif" font-size="72"
        font-weight="700" fill="${tint}">${esc(d.countdown)}</text>
  <text x="${x}" y="286" font-family="'DM Mono','SF Mono',ui-monospace,monospace" font-size="12"
        letter-spacing="4" fill="${PALETTE.creamDim}">OPENS ${esc(d.opensAt.toUpperCase())}</text>

  ${rows.join("\n  ")}

  <!-- The address in full, because it is what you copy to act on this. -->
  <line x1="${x}" y1="${H - 108}" x2="${W - 64}" y2="${H - 108}"
        stroke="${PALETTE.groundLift}" stroke-width="2"/>
  <text x="${x}" y="${H - 66}" font-family="'DM Mono','SF Mono',ui-monospace,monospace" font-size="17"
        fill="${PALETTE.creamDim}">${esc(d.contract)}</text>
  <text x="${x}" y="${H - 34}" font-family="'DM Mono','SF Mono',ui-monospace,monospace" font-size="17"
        fill="${PALETTE.creamDim}">${esc(d.chain)}</text>
</svg>`;
}
