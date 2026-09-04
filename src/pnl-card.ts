// The P&L card: collection art on the left, the numbers on the right.
//
// Shares the mint card's palette and diagonal seam on purpose — these arrive
// in the same chat and reading as one family makes the difference between
// them ("this is what you got" versus "this is what it is worth now") land
// faster than a legend would.
//
// Kept as a pure string-producing function, like mint-card.ts, so the layout
// is testable without a rasteriser anywhere near it.

import { PALETTE, formatEth } from "./mint-card";
import { Pnl, PnlReport } from "./pnl";

const escapeXml = (s: string): string =>
  s.replace(/[<>&"']/g, (c) => (
    { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" } as Record<string, string>
  )[c]);

export function fit(text: string, max: number): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(1, max - 1))}…`;
}

export interface PnlCardData {
  report: PnlReport;
  pnl: Pnl;
  /** Data URI or URL for the collection art; a monogram is drawn when absent. */
  artHref?: string | null;
}

/**
 * Green above cost, red below, amber when there is nothing to compare against.
 *
 * Driven by the offer figure rather than the floor: the floor is an asking
 * price nobody has agreed to, and colouring a card green on the strength of
 * one optimistic listing is exactly the kind of flattering lie a P&L should
 * not tell.
 */
export function accent(pnl: Pnl): string {
  const decisive = pnl.profitAtOfferEth ?? pnl.profitAtFloorEth;
  if (decisive === null) return PALETTE.flame;
  if (decisive > 0) return PALETTE.mint;
  if (decisive < 0) return PALETTE.ember;
  return PALETTE.flameHot;
}

/** The single figure the card leads with, and what it means. */
export function headline(pnl: Pnl): { value: string; unit: string } {
  if (pnl.profitAtOfferEth !== null) {
    return {
      value: `${pnl.profitAtOfferEth > 0 ? "+" : ""}${formatEth(pnl.profitAtOfferEth)}`,
      unit: "ETH IF SOLD NOW",
    };
  }
  if (pnl.profitAtFloorEth !== null) {
    return {
      value: `${pnl.profitAtFloorEth > 0 ? "+" : ""}${formatEth(pnl.profitAtFloorEth)}`,
      unit: "ETH AT FLOOR",
    };
  }
  // No market either side: fall back to the paper value, then to the count —
  // there is always something true to lead with.
  if (pnl.floorValueEth !== null) return { value: formatEth(pnl.floorValueEth), unit: "ETH AT FLOOR" };
  return { value: "—", unit: "NO MARKET YET" };
}

function stat(x: number, y: number, label: string, value: string, color: string = PALETTE.cream): string {
  return `
    <g transform="translate(${x} ${y})">
      <text x="0" y="0" font-family="'DM Mono','SF Mono',ui-monospace,monospace" font-size="11"
            letter-spacing="2.6" fill="${PALETTE.creamDim}">${escapeXml(label)}</text>
      <text x="0" y="26" font-family="'DM Sans',Inter,system-ui,sans-serif" font-size="22"
            font-weight="600" fill="${color}">${escapeXml(value)}</text>
    </g>`;
}

export function renderPnlCard(d: PnlCardData): string {
  const W = 1256;
  const H = 810;
  const { report, pnl } = d;
  const tint = accent(pnl);
  const head = headline(pnl);

  const seam = "M0,0 L742,0 L560,810 L0,810 Z";

  const art = d.artHref
    ? `<image href="${escapeXml(d.artHref)}" x="-40" y="0" width="820" height="810"
              preserveAspectRatio="xMidYMid slice"/>`
    : `<g>
         <rect x="-40" y="0" width="820" height="810" fill="${PALETTE.groundLift}"/>
         <text x="350" y="470" text-anchor="middle" font-family="'DM Sans',Inter,sans-serif"
               font-size="300" font-weight="700" fill="${PALETTE.ground}"
               >${escapeXml(report.name.slice(0, 2).toUpperCase())}</text>
       </g>`;

  const roi =
    pnl.roiPercent === null
      ? "—"
      : `${pnl.roiPercent > 0 ? "+" : ""}${pnl.roiPercent.toFixed(0)}%`;

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

  <text x="792" y="96" font-family="'DM Mono','SF Mono',ui-monospace,monospace" font-size="12"
        letter-spacing="4" fill="${tint}">PROFIT &amp; LOSS</text>
  <text x="792" y="146" font-family="'DM Sans',Inter,system-ui,sans-serif" font-size="40"
        font-weight="700" fill="${PALETTE.cream}">${escapeXml(fit(report.name, 20))}</text>

  <text x="792" y="272" font-family="'DM Sans',Inter,system-ui,sans-serif" font-size="86"
        font-weight="700" fill="${tint}">${escapeXml(head.value)}</text>
  <text x="792" y="308" font-family="'DM Mono','SF Mono',ui-monospace,monospace" font-size="12"
        letter-spacing="3.4" fill="${PALETTE.creamDim}">${escapeXml(head.unit)}</text>

  ${stat(792, 386, "HELD", `${report.quantity} in ${report.wallets} wallet${report.wallets === 1 ? "" : "s"}`)}
  ${stat(1024, 386, "ROI", roi, pnl.roiPercent !== null && pnl.roiPercent < 0 ? PALETTE.salmon : PALETTE.cream)}

  ${stat(792, 470, "COST", formatEth(pnl.totalCostEth))}
  ${stat(1024, 470, "FLOOR", formatEth(report.floorEth))}

  ${stat(792, 554, "AT FLOOR", formatEth(pnl.floorValueEth))}
  ${stat(1024, 554, "BEST OFFER", formatEth(report.bestOfferEth))}

  ${stat(792, 638, "MINT EACH", report.priceSource === "stage" ? formatEth(report.mintPriceEth) : "?")}
  ${stat(1024, 638, "BREAK-EVEN", formatEth(pnl.breakEvenFloorEth))}

  <text x="792" y="742" font-family="'DM Mono','SF Mono',ui-monospace,monospace" font-size="12"
        letter-spacing="2" fill="${PALETTE.creamDim}">${escapeXml(
          `${report.contract.slice(0, 10)}…${report.contract.slice(-6)}`
        )}</text>
  <text x="792" y="768" font-family="'DM Mono','SF Mono',ui-monospace,monospace" font-size="11"
        letter-spacing="2" fill="${PALETTE.creamDim}">ESTIMATED COST BASIS</text>
</svg>`;
}
