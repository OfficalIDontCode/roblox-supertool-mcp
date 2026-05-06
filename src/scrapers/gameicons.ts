/**
 * Game-icons.net — 3000+ free game icons (CC-BY 3.0).
 *
 * Source: github.com/game-icons/icons (the canonical SVG repo).
 * Site:   game-icons.net (renders SVGs with color transforms).
 *
 * Strategy:
 *   - Build the full icon catalog from one GitHub recursive tree call:
 *       https://api.github.com/repos/game-icons/icons/git/trees/master?recursive=1
 *     That returns every blob in the repo. We filter to <author>/<name>.svg.
 *   - The catalog is cached in memory after first fetch (~3000 entries, small).
 *   - Per-icon SVG download is from the raw.githubusercontent.com mirror.
 *   - Roblox accepts PNG/JPG/BMP/TGA — not SVG. We rasterize via @resvg/resvg-js
 *     (pure WASM, no native deps) before upload.
 *   - Thumbnail previews: we render the SVG to a small PNG inline (so the AI
 *     can visually pick) using the same rasterizer.
 *
 * License: every icon is CC-BY 3.0 except `delapouite/cybernetic-eye.svg`
 * which the author has released to the public domain. Attribution is required
 * when shipping CC-BY assets in a Roblox game (credit screen / description).
 */
import { Resvg } from "@resvg/resvg-js";
import { fetchJson, fetchText, fetchBuffer } from "./common.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TMP_DIR = path.join(os.tmpdir(), "roblox-supertool", "scraped", "gameicons");

const GH_TREE = "https://api.github.com/repos/game-icons/icons/git/trees/master?recursive=1";
const RAW_BASE = "https://raw.githubusercontent.com/game-icons/icons/master";

export type GameIcon = {
  /** "<author>/<name>" — globally unique across the catalog. */
  id: string;
  author: string;
  name: string;
  /** Direct SVG download URL (raw.githubusercontent.com). */
  svgUrl: string;
};

type GhTreeEntry = { path: string; type: "blob" | "tree"; size?: number };
type GhTreeResponse = { tree: GhTreeEntry[]; truncated?: boolean };

let CATALOG: GameIcon[] | null = null;
let CATALOG_FETCHED_AT = 0;
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000; // 24h — repo changes rarely

async function loadCatalog(): Promise<GameIcon[]> {
  if (CATALOG && Date.now() - CATALOG_FETCHED_AT < CATALOG_TTL_MS) return CATALOG;

  const data = await fetchJson<GhTreeResponse>(GH_TREE);
  if (data.truncated) {
    // The repo is well under GitHub's 100k-entry truncation threshold; if this
    // ever fires, fall back to per-author listing.
    throw new Error(
      "GitHub returned a truncated tree for game-icons/icons. Open an issue — fallback enumeration not implemented yet.",
    );
  }
  const icons: GameIcon[] = [];
  for (const e of data.tree) {
    if (e.type !== "blob") continue;
    if (!e.path.endsWith(".svg")) continue;
    const m = /^([^/]+)\/([^/]+)\.svg$/.exec(e.path);
    if (!m) continue;
    const author = m[1];
    const name = m[2];
    // Skip top-level helper SVGs (none currently, but be defensive).
    if (author.startsWith(".")) continue;
    icons.push({
      id: `${author}/${name}`,
      author,
      name,
      svgUrl: `${RAW_BASE}/${author}/${name}.svg`,
    });
  }
  CATALOG = icons;
  CATALOG_FETCHED_AT = Date.now();
  return icons;
}

export async function getCatalogStats(): Promise<{ count: number; authors: number; cached: boolean }> {
  const wasCached = CATALOG !== null;
  const icons = await loadCatalog();
  const authors = new Set(icons.map((i) => i.author)).size;
  return { count: icons.length, authors, cached: wasCached };
}

export type GameIconsSearchOpts = {
  query?: string;
  author?: string;
  limit?: number;
};

export async function search(opts: GameIconsSearchOpts = {}): Promise<GameIcon[]> {
  const icons = await loadCatalog();
  const q = (opts.query ?? "").toLowerCase().trim();
  const terms = q.split(/[\s\-_]+/).filter(Boolean);
  const author = opts.author?.toLowerCase().trim();

  const matches = icons.filter((it) => {
    if (author && it.author.toLowerCase() !== author) return false;
    if (!terms.length) return true;
    const haystack = `${it.author} ${it.name}`.toLowerCase().replace(/-/g, " ");
    return terms.every((t) => haystack.includes(t));
  });

  // Rank: exact-name match first, then prefix, then substring.
  if (terms.length) {
    matches.sort((a, b) => score(b, terms) - score(a, terms));
  }
  return matches.slice(0, opts.limit ?? 30);
}

function score(it: GameIcon, terms: string[]): number {
  const name = it.name.toLowerCase().replace(/-/g, " ");
  let s = 0;
  const joined = terms.join(" ");
  if (name === joined) s += 100;
  if (name.startsWith(joined)) s += 50;
  for (const t of terms) {
    if (name === t) s += 30;
    if (name.startsWith(t)) s += 10;
    if (name.includes(t)) s += 1;
  }
  return s;
}

export async function getIcon(id: string): Promise<GameIcon> {
  const icons = await loadCatalog();
  const found = icons.find((i) => i.id === id);
  if (!found) throw new Error(`Unknown game-icons id: ${id}. Use the form '<author>/<name>'.`);
  return found;
}

// ── SVG rasterization ───────────────────────────────────────────────────────

export type RasterizeOpts = {
  /** Output PNG width in pixels. Aspect is square (the SVGs are 512x512). */
  size?: number;
  /** Foreground hex color "RRGGBB". Default white. */
  fg?: string;
  /** Background hex color "RRGGBB" or null for transparent. Default null. */
  bg?: string | null;
};

/**
 * Apply game-icons-style color tinting + background to an SVG string.
 *
 * The upstream SVGs are pure black on white (no fill attrs). game-icons.net
 * recolors them server-side by wrapping in a <svg> with rect+fill. We mirror
 * that approach: parse the inner SVG, drop it inside a wrapper that paints
 * the foreground with `fill` and the background with a colored rect.
 */
function tintSvg(svg: string, opts: RasterizeOpts): string {
  const fg = (opts.fg ?? "ffffff").replace(/^#/, "");
  const bg = opts.bg === null ? null : (opts.bg ?? "000000").replace(/^#/, "");

  // Strip XML decl / DOCTYPE — resvg handles them but they trip the regex below.
  let inner = svg.replace(/<\?xml[^>]*\?>/i, "").replace(/<!DOCTYPE[^>]*>/i, "").trim();

  // Replace the outer <svg ...> attributes to ensure 512x512 viewBox + size.
  inner = inner.replace(/<svg[^>]*>/i, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">');

  // Force foreground fill on every <path>. Some upstream icons already have a
  // `fill="..."` attribute (e.g. cathelineau/*) — strip those first to avoid
  // resvg's "duplicate attribute" parser error, then inject ours.
  inner = inner.replace(/<path\b[^>]*>/gi, (tag) => {
    const stripped = tag.replace(/\s+fill\s*=\s*"[^"]*"/gi, "").replace(/\s+fill\s*=\s*'[^']*'/gi, "");
    return stripped.replace(/^<path\b/i, `<path fill="#${fg}"`);
  });

  if (bg !== null) {
    // Insert a background rect right after the opening <svg ...>.
    inner = inner.replace(
      /(<svg[^>]*>)/i,
      `$1<rect width="100%" height="100%" fill="#${bg}"/>`,
    );
  }
  return inner;
}

export async function rasterize(
  id: string,
  opts: RasterizeOpts = {},
): Promise<{ filePath: string; bytes: number; sourceUrl: string }> {
  const icon = await getIcon(id);
  const svg = await fetchText(icon.svgUrl);
  const tinted = tintSvg(svg, opts);

  const size = opts.size ?? 512;
  const resvg = new Resvg(tinted, {
    fitTo: { mode: "width", value: size },
    background: opts.bg === null ? "rgba(0,0,0,0)" : undefined,
  });
  const png = resvg.render().asPng();

  const safeId = icon.id.replace(/[^A-Za-z0-9._-]+/g, "_");
  const filename = `gameicons_${safeId}_${size}.png`;
  await fs.mkdir(TMP_DIR, { recursive: true });
  const filePath = path.join(TMP_DIR, filename);
  await fs.writeFile(filePath, png);
  return { filePath, bytes: png.length, sourceUrl: icon.svgUrl };
}

/**
 * Inline base64 PNG of an icon at a small preview size — used by the
 * "_visual" search variant so the AI can see thumbnails.
 */
export async function thumbnailBase64(id: string, opts: RasterizeOpts = {}): Promise<string> {
  const icon = await getIcon(id);
  const svg = await fetchText(icon.svgUrl);
  const tinted = tintSvg(svg, { ...opts, size: opts.size ?? 96 });
  const resvg = new Resvg(tinted, {
    fitTo: { mode: "width", value: opts.size ?? 96 },
    background: opts.bg === null ? "rgba(0,0,0,0)" : undefined,
  });
  return resvg.render().asPng().toString("base64");
}

/**
 * Download a raw SVG to a local temp file (no rasterization). Useful if
 * the user wants to import it into Studio's AssetService manually or use
 * with a separate workflow.
 */
export async function downloadSvg(id: string): Promise<{ filePath: string; bytes: number; sourceUrl: string }> {
  const icon = await getIcon(id);
  const buf = await fetchBuffer(icon.svgUrl);
  const safeId = icon.id.replace(/[^A-Za-z0-9._-]+/g, "_");
  await fs.mkdir(TMP_DIR, { recursive: true });
  const filePath = path.join(TMP_DIR, `gameicons_${safeId}.svg`);
  await fs.writeFile(filePath, buf);
  return { filePath, bytes: buf.length, sourceUrl: icon.svgUrl };
}
