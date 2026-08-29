// Rasterises a mint card to PNG for Telegram, which cannot display SVG as a
// photo. Kept separate from mint-card.ts so the layout stays a pure function
// with no native dependency — only this file needs the renderer.

import path from "path";
import { Resvg } from "@resvg/resvg-js";
import { renderMintCard, MintCardData } from "./mint-card";

// Bundled rather than relying on system fonts: a server with no DM Sans
// installed silently falls back to a serif and the card stops looking like
// itself. Verified — that's exactly what the first render did.
const FONT_DIR = path.resolve(__dirname, "..", "assets", "fonts");

const MAX_ART_BYTES = 6 * 1024 * 1024;

// resvg decodes these and nothing else. OpenSea's CDN content-negotiates and
// will happily return AVIF, which embeds without error and then renders as a
// blank panel — so the type has to be checked, not assumed.
const RENDERABLE = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/svg+xml"]);

/**
 * resvg does not fetch remote images, so collection art has to be inlined as
 * a data URI before rendering. Returns null on any failure — a card without
 * art still renders via the monogram fallback, and a mint receipt is not
 * worth failing over a missing picture.
 */
export async function inlineImage(url: string, timeoutMs = 8000): Promise<string | null> {
  if (!url) return null;
  if (url.startsWith("data:")) return url;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // Ask for what the renderer can actually decode. Without this the CDN
      // picks AVIF or WebP by default and the art silently disappears.
      headers: { accept: "image/png,image/jpeg,image/gif,image/svg+xml" },
    });
    if (!res.ok) return null;

    const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!RENDERABLE.has(type)) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_ART_BYTES) return null;

    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface RenderOptions {
  /** Output width in pixels; height follows the card's aspect. */
  width?: number;
}

export async function renderMintCardPng(
  data: MintCardData,
  opts: RenderOptions = {}
): Promise<Buffer> {
  // Fetch art up front so the SVG handed to resvg is fully self-contained.
  const artHref = data.artHref ? await inlineImage(data.artHref) : null;

  // SMIL can't rasterise; asking for it only wastes work.
  const svg = renderMintCard({ ...data, artHref, animated: false });

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: opts.width ?? 1256 },
    background: "#121A19",
    font: {
      loadSystemFonts: false, // deterministic output across machines
      fontDirs: [FONT_DIR],
      defaultFontFamily: "DM Sans",
      sansSerifFamily: "DM Sans",
      monospaceFamily: "DM Mono",
    },
  });

  return Buffer.from(resvg.render().asPng());
}
