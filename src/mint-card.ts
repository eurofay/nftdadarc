// Generates the "00" mint card — the visual receipt posted after a mint.
//
// Pure: data in, SVG string out. No I/O and no rendering dependency, so the
// layout is testable and the same markup serves both an animated preview in
// a browser and a rasterised PNG for Telegram.
//
// Composition is a poster, not a dashboard: the artwork bleeds the full
// height of the left side, one number carries the card, and everything else
// is small. Palette is sampled from the reference art — ember red and flame
// orange over a near-black teal ground.

export const PALETTE = {
  void: "#121A19",
  ground: "#1B2725",
  groundLift: "#263634",
  ember: "#C4342A",
  emberDeep: "#7E1D18",
  flame: "#F5871F",
  flameHot: "#FBB040",
  cream: "#F6EFE4",
  creamDim: "#93A5A2",
  salmon: "#F0B9B7",
  mint: "#5FD6A4",
} as const;

export interface MintCardData {
  collection: string;
  contract: string;
  chain: string;
  source: "Auto Mint" | "Copy Mint" | "Scheduled Mint" | "Manual Mint";
  minted: number;
  wallets: number;
  pricePaidEth: number;
  floorEth?: number | null;
  bestOfferEth?: number | null;
  mintedAt: number;
  /** Data URI or URL for the collection art; a monogram is drawn when absent. */
  artHref?: string | null;
  /** SMIL animation is great in a browser and ignored by most rasterisers. */
  animated?: boolean;
}

const escapeXml = (s: string): string =>
  s.replace(/[<>&"']/g, (c) => (
    { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" } as Record<string, string>
  )[c]);

export function fitText(text: string, max: number): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(1, max - 1))}…`;
}

// ETH here spans orders of magnitude — a free mint is 0, a floor can be
// 0.00019. Fixed decimals would render most of these as "0.00".
export function formatEth(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "FREE";
  if (value >= 1) return `${value.toFixed(3)}`;
  if (value >= 0.001) return `${value.toFixed(4)}`;
  return `${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/** Floor value of everything just acquired — the number the card leads with. */
export function haulValueEth(minted: number, floor?: number | null): number | null {
  if (floor === null || floor === undefined || !Number.isFinite(floor) || floor <= 0) return null;
  return minted * floor;
}

// Headline: value of the haul when a floor exists, otherwise the count. The
// count is always known, so the card always has something to lead with.
export function headline(d: Pick<MintCardData, "minted" | "floorEth">): { value: string; unit: string } {
  const haul = haulValueEth(d.minted, d.floorEth);
  if (haul === null) return { value: `×${d.minted}`, unit: "MINTED" };
  return { value: formatEth(haul), unit: "ETH AT FLOOR" };
}

// Free mints are the common case and deserve the strongest colour; a paid
// mint already above its cost is good news; below cost is not.
export function accentFor(d: Pick<MintCardData, "pricePaidEth" | "floorEth" | "minted">): string {
  const haul = haulValueEth(d.minted, d.floorEth);
  const spent = d.pricePaidEth * d.minted;
  if (spent <= 0) return PALETTE.flameHot;
  if (haul !== null && haul < spent) return PALETTE.ember;
  return PALETTE.mint;
}

function meta(x: number, y: number, label: string, value: string): string {
  return `
    <g transform="translate(${x} ${y})">
      <text x="0" y="0" font-family="'DM Mono','SF Mono',ui-monospace,monospace" font-size="11"
            letter-spacing="2.6" fill="${PALETTE.creamDim}">${escapeXml(label)}</text>
      <text x="0" y="24" font-family="'DM Sans',Inter,system-ui,sans-serif" font-size="21"
            font-weight="600" fill="${PALETTE.cream}">${escapeXml(value)}</text>
    </g>`;
}

export function renderMintCard(d: MintCardData): string {
  const W = 1256;
  const H = 810;
  const animated = d.animated !== false;
  const accent = accentFor(d);
  const head = headline(d);

  const when = new Date(d.mintedAt);
  const stamp = `${String(when.getUTCDate()).padStart(2, "0")}.${String(when.getUTCMonth() + 1).padStart(2, "0")}.${when.getUTCFullYear()}`;

  // Diagonal seam: art on the left, data on the right, cut on a slant.
  const seam = "M0,0 L742,0 L560,810 L0,810 Z";

  const art = d.artHref
    ? `<image href="${escapeXml(d.artHref)}" x="-40" y="0" width="820" height="810"
              preserveAspectRatio="xMidYMid slice"/>`
    : `<g>
         <rect x="-40" y="0" width="820" height="810" fill="${PALETTE.groundLift}"/>
         <text x="350" y="470" text-anchor="middle" font-family="'DM Sans',Inter,sans-serif"
               font-size="300" font-weight="700" fill="${PALETTE.ground}"
               >${escapeXml(d.collection.slice(0, 2).toUpperCase())}</text>
       </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="night" x1="0.15" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="${PALETTE.ground}"/>
      <stop offset="58%"  stop-color="${PALETTE.void}"/>
      <stop offset="100%" stop-color="#0B100F"/>
    </linearGradient>

    <linearGradient id="emberWash" x1="0" y1="0" x2="1" y2="0.6">
      <stop offset="0%"   stop-color="${PALETTE.ember}"  stop-opacity="0.95"/>
      <stop offset="55%"  stop-color="${PALETTE.emberDeep}" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="${PALETTE.void}"   stop-opacity="0.15"/>
    </linearGradient>

    <linearGradient id="seamGlow" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="${PALETTE.flameHot}"/>
      <stop offset="60%"  stop-color="${PALETTE.ember}"/>
      <stop offset="100%" stop-color="${PALETTE.emberDeep}"/>
    </linearGradient>

    <radialGradient id="headGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="${accent}" stop-opacity="0.32"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>

    <!-- Grain is computed once over a 200px tile and repeated, rather than
         run as a filter across the whole card. Same texture, and it takes
         the render from ~12s to well under a second — filters are priced
         per pixel, and a full card is a million of them. -->
    <filter id="noiseTile" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="3" seed="11" result="n"/>
      <feColorMatrix in="n" type="saturate" values="0" result="m"/>
      <feComponentTransfer in="m">
        <feFuncA type="discrete" tableValues="0 0.25 0.55 0.8 1"/>
      </feComponentTransfer>
    </filter>
    <pattern id="grain" width="200" height="200" patternUnits="userSpaceOnUse">
      <rect width="200" height="200" filter="url(#noiseTile)"/>
    </pattern>

    <clipPath id="artSide"><path d="${seam}"/></clipPath>
    <clipPath id="card"><rect width="${W}" height="${H}" rx="16"/></clipPath>
  </defs>

  <g clip-path="url(#card)">
    <rect width="${W}" height="${H}" fill="url(#night)"/>

    <!-- Ember wash behind the artwork -->
    <g clip-path="url(#artSide)">
      <rect width="${W}" height="${H}" fill="url(#emberWash)"/>
      ${art}
      <!-- Ember pushed back over the art: ties it to the palette and keeps
           the seam reading, without hiding the collection's own colours. -->
      <rect width="${W}" height="${H}" fill="${PALETTE.emberDeep}" opacity="0.30" style="mix-blend-mode:multiply"/>
      <rect width="${W}" height="${H}" fill="url(#emberWash)" opacity="0.45"/>
    </g>

    <!-- The seam itself -->
    <path d="M742,0 L560,810 L586,810 L768,0 Z" fill="url(#seamGlow)" opacity="0.95"/>
    ${
      animated
        ? `<path d="M742,0 L560,810 L586,810 L768,0 Z" fill="${PALETTE.flameHot}">
             <animate attributeName="opacity" values="0.15;0.55;0.15" dur="4.5s" repeatCount="indefinite"/>
           </path>`
        : ""
    }

    <!-- Brand, top-right -->
    <g transform="translate(${W - 72} 74)" text-anchor="end">
      <text x="0" y="0" font-family="'DM Sans',Inter,sans-serif" font-size="40" font-weight="700"
            letter-spacing="10" fill="${PALETTE.cream}">00${
              animated
                ? `<animate attributeName="opacity" values="1;0.62;1" dur="3.4s" repeatCount="indefinite"/>`
                : ""
            }</text>
      <text x="0" y="24" font-family="'DM Mono','SF Mono',ui-monospace,monospace" font-size="10"
            letter-spacing="4.2" fill="${PALETTE.creamDim}">MINT BOT</text>
    </g>

    <!-- Headline block -->
    <ellipse cx="1000" cy="392" rx="330" ry="180" fill="url(#headGlow)"/>
    <g text-anchor="end">
      <text x="${W - 72}" y="288" font-family="'DM Sans',Inter,system-ui,sans-serif" font-size="46"
            font-weight="700" letter-spacing="-0.5" fill="${PALETTE.cream}"
            >${escapeXml(fitText(d.collection, 18))}</text>

      <text x="${W - 72}" y="404" font-family="'DM Sans',Inter,system-ui,sans-serif" font-size="104"
            font-weight="700" letter-spacing="-3" fill="${accent}">${escapeXml(head.value)}</text>

      <text x="${W - 72}" y="446" font-family="'DM Mono','SF Mono',ui-monospace,monospace" font-size="13"
            letter-spacing="4" fill="${PALETTE.creamDim}">${escapeXml(head.unit)}</text>

      <text x="${W - 72}" y="492" font-family="'DM Mono','SF Mono',ui-monospace,monospace" font-size="13"
            letter-spacing="2.4" fill="${PALETTE.salmon}"
            >${escapeXml(`${d.source.toUpperCase()} · ${d.chain.toUpperCase()}`)}</text>
    </g>

    <!-- Supporting figures -->
    ${meta(806, 592, "MINTED", `${d.minted}`)}
    ${meta(806, 664, "PAID", d.pricePaidEth === 0 ? "FREE" : formatEth(d.pricePaidEth * d.minted))}
    ${meta(1010, 592, "FLOOR", formatEth(d.floorEth))}
    ${meta(1010, 664, "OFFER", formatEth(d.bestOfferEth))}

    <!-- Footer -->
    <text x="${W - 72}" y="${H - 44}" text-anchor="end"
          font-family="'DM Mono','SF Mono',ui-monospace,monospace" font-size="11"
          letter-spacing="2.6" fill="${PALETTE.creamDim}"
          >${escapeXml(`${d.contract.slice(0, 8)}…${d.contract.slice(-6)} · ${stamp}`)}</text>

    <!-- Grain over everything -->
    <rect width="${W}" height="${H}" fill="url(#grain)" opacity="0.10"/>
    <rect width="${W}" height="${H}" rx="16" fill="none" stroke="${PALETTE.groundLift}" stroke-width="2"/>
  </g>
</svg>`;
}
