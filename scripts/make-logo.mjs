// l00p Bot logo generator.
//
// The mark is a lemniscate drawn as a ribbon that visibly crosses over
// itself: a loop that returns to its own start, which is what the bot does —
// watch, fire, watch again. It doubles as the "00" in l00p.
//
// Palette is lifted from mint-card.ts on purpose. The bot already sends mint
// cards and P&L cards in these colours, so the avatar sitting above them in
// the chat reads as the same thing rather than as a stranger.

import { Resvg } from "@resvg/resvg-js";
import fs from "fs";
import path from "path";

const OUT = process.env.OUT_DIR || "assets/brand";
const FONT_DIR = path.resolve("assets/fonts");

const P = {
  void: "#121A19",
  ground: "#1B2725",
  ember: "#C4342A",
  emberDeep: "#7E1D18",
  flame: "#F5871F",
  flameHot: "#FBB040",
  cream: "#F6EFE4",
  mint: "#5FD6A4",
};

// A lemniscate centred at (cx,cy). Two cubic lobes meeting at the middle,
// which is exactly where the ribbon has to cross itself.
function lemniscate(cx, cy, w, h) {
  return (
    `M ${cx},${cy} ` +
    `C ${cx - w},${cy - h} ${cx - w},${cy + h} ${cx},${cy} ` +
    `C ${cx + w},${cy - h} ${cx + w},${cy + h} ${cx},${cy}`
  );
}

/**
 * The mark itself.
 *
 * Drawn three times: the whole ribbon, a short stroke of background colour
 * across the centre to punch a gap, then the over-strand redrawn on top. That
 * gap is what turns a flat figure-eight into something that reads as one
 * continuous band passing over itself.
 */
function mark({ cx, cy, w, h, stroke, gradientId, gapColor, overId = "fireOver", capStyle = "round" }) {
  const d = lemniscate(cx, cy, w, h);
  const over = stroke * 1.9;
  return `
    <path d="${d}" fill="none" stroke="url(#${gradientId})" stroke-width="${stroke}"
          stroke-linecap="${capStyle}" stroke-linejoin="round"/>
    <line x1="${cx - over / 2}" y1="${cy - over / 2}" x2="${cx + over / 2}" y2="${cy + over / 2}"
          stroke="${gapColor}" stroke-width="${stroke * 1.55}" stroke-linecap="butt"/>
    <line x1="${cx - stroke * 0.78}" y1="${cy - stroke * 0.78}" x2="${cx + stroke * 0.78}" y2="${cy + stroke * 0.78}"
          stroke="url(#${overId})" stroke-width="${stroke}" stroke-linecap="round"/>`;
}

function gradients() {
  return `
    <linearGradient id="fire" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="${P.flameHot}"/>
      <stop offset="55%"  stop-color="${P.flame}"/>
      <stop offset="100%" stop-color="${P.ember}"/>
    </linearGradient>
    <linearGradient id="fireOver" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#FFD06A"/>
      <stop offset="100%" stop-color="${P.flameHot}"/>
    </linearGradient>
    <linearGradient id="creamOver" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#FFFFFF"/>
      <stop offset="100%" stop-color="${P.cream}"/>
    </linearGradient>
    <linearGradient id="creamGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="${P.cream}"/>
      <stop offset="100%" stop-color="#CDBBA6"/>
    </linearGradient>
    <linearGradient id="darkGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="${P.ground}"/>
      <stop offset="100%" stop-color="${P.void}"/>
    </linearGradient>
    <linearGradient id="night" x1="0.1" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="${P.ground}"/>
      <stop offset="60%"  stop-color="${P.void}"/>
      <stop offset="100%" stop-color="#0B100F"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="45%" r="55%">
      <stop offset="0%"   stop-color="${P.flame}" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="${P.flame}" stop-opacity="0"/>
    </radialGradient>`;
}

// A: the mark alone, for the Telegram avatar. At 64px in a chat list a
// wordmark is unreadable, so the avatar carries the symbol and nothing else.
function avatarMark(S = 512) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 512 512">
  <defs>${gradients()}</defs>
  <rect width="512" height="512" rx="116" fill="url(#night)"/>
  <circle cx="256" cy="240" r="190" fill="url(#glow)"/>
  ${mark({ cx: 256, cy: 250, w: 205, h: 168, stroke: 44, gradientId: "fire", gapColor: P.void })}
</svg>`;
}

// B: mark plus wordmark, for a profile header or a README.
function avatarWord(S = 512) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 512 512">
  <defs>${gradients()}</defs>
  <rect width="512" height="512" rx="116" fill="url(#night)"/>
  <circle cx="256" cy="205" r="175" fill="url(#glow)"/>
  ${mark({ cx: 256, cy: 210, w: 168, h: 136, stroke: 36, gradientId: "fire", gapColor: P.void })}
  <text x="256" y="418" text-anchor="middle" font-family="DM Sans" font-size="92"
        font-weight="700" fill="${P.cream}" letter-spacing="-2">l00p</text>
  <text x="256" y="458" text-anchor="middle" font-family="DM Mono" font-size="21"
        letter-spacing="9" fill="${P.flame}">BOT</text>
</svg>`;
}

// C: light ground, for anywhere the dark square would disappear.
function avatarLight(S = 512) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 512 512">
  <defs>${gradients()}</defs>
  <rect width="512" height="512" rx="116" fill="${P.cream}"/>
  ${mark({ cx: 256, cy: 250, w: 205, h: 168, stroke: 44, gradientId: "fire", gapColor: P.cream })}
</svg>`;
}

// D: one colour, no gradient. This is the version that survives being
// stamped on a favicon, embroidered, or printed in one ink.
function avatarMono(S = 512) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 512 512">
  <defs>${gradients()}</defs>
  <rect width="512" height="512" rx="116" fill="${P.void}"/>
  ${mark({ cx: 256, cy: 250, w: 205, h: 168, stroke: 44, gradientId: "creamGrad", gapColor: P.void, overId: "creamOver" })}
</svg>`;
}

// E: horizontal lock-up, for a README banner or a site header.
function wordmark() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="360" viewBox="0 0 1200 360">
  <defs>${gradients()}</defs>
  <rect width="1200" height="360" fill="url(#night)"/>
  <circle cx="250" cy="180" r="150" fill="url(#glow)"/>
  ${mark({ cx: 250, cy: 180, w: 130, h: 106, stroke: 28, gradientId: "fire", gapColor: P.void })}
  <text x="440" y="196" font-family="DM Sans" font-size="132" font-weight="700"
        fill="${P.cream}" letter-spacing="-4">l00p</text>
  <text x="448" y="252" font-family="DM Mono" font-size="26" letter-spacing="13"
        fill="${P.flame}">MINT BOT</text>
</svg>`;
}

const VARIANTS = {
  "loop-avatar": avatarMark(),
  "loop-avatar-wordmark": avatarWord(),
  "loop-avatar-light": avatarLight(),
  "loop-avatar-mono": avatarMono(),
  "loop-wordmark": wordmark(),
};

function render(svg, width) {
  return Buffer.from(
    new Resvg(svg, {
      fitTo: { mode: "width", value: width },
      font: {
        loadSystemFonts: false,
        fontDirs: [FONT_DIR],
        defaultFontFamily: "DM Sans",
        sansSerifFamily: "DM Sans",
        monospaceFamily: "DM Mono",
      },
    })
      .render()
      .asPng()
  );
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, svg] of Object.entries(VARIANTS)) {
  fs.writeFileSync(path.join(OUT, `${name}.svg`), svg);
  const width = name === "loop-wordmark" ? 1200 : 512;
  fs.writeFileSync(path.join(OUT, `${name}.png`), render(svg, width));
  console.log(`  ${name}.svg + .png`);
}

// Contact sheet, so all five can be judged side by side at once.
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="900" viewBox="0 0 1240 900">
  <defs>${gradients()}</defs>
  <rect width="1240" height="900" fill="#0A0E0D"/>
  <text x="60" y="72" font-family="DM Mono" font-size="20" letter-spacing="6" fill="${P.flame}">L00P BOT — LOGO</text>
  ${[
    ["loop-avatar", "avatar", 60, 120],
    ["loop-avatar-wordmark", "avatar + word", 360, 120],
    ["loop-avatar-light", "light ground", 660, 120],
    ["loop-avatar-mono", "one colour", 960, 120],
  ]
    .map(
      ([key, label, x, y]) => `
    <g transform="translate(${x} ${y}) scale(${220 / 512})">${VARIANTS[key]
      .replace(/^<svg[^>]*>/, "")
      .replace(/<\/svg>$/, "")
      .replace(/<defs>[\s\S]*?<\/defs>/, "")}</g>
    <text x="${x}" y="${y + 250}" font-family="DM Mono" font-size="15" fill="${P.cream}" opacity="0.75">${label}</text>`
    )
    .join("")}
  <g transform="translate(60 440) scale(0.6)">${VARIANTS["loop-wordmark"]
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>$/, "")
    .replace(/<defs>[\s\S]*?<\/defs>/, "")}</g>
  <text x="60" y="700" font-family="DM Mono" font-size="15" fill="${P.cream}" opacity="0.75">horizontal lock-up</text>

  <text x="60" y="770" font-family="DM Mono" font-size="15" fill="${P.cream}" opacity="0.55">how it reads small:</text>
  ${[64, 48, 32, 24]
    .map(
      (s, i) => `<g transform="translate(${240 + i * 110} ${742}) scale(${s / 512})">${VARIANTS["loop-avatar"]
        .replace(/^<svg[^>]*>/, "")
        .replace(/<\/svg>$/, "")
        .replace(/<defs>[\s\S]*?<\/defs>/, "")}</g>
       <text x="${240 + i * 110}" y="${835}" font-family="DM Mono" font-size="12" fill="${P.cream}" opacity="0.5">${s}px</text>`
    )
    .join("")}
</svg>`;
fs.writeFileSync(path.join(OUT, "contact-sheet.png"), render(sheet, 1240));
console.log("  contact-sheet.png");
