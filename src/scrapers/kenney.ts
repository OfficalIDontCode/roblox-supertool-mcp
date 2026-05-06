/**
 * Kenney.nl — CC0 game asset packs (3D, 2D, UI, audio).
 * No API. Each pack is at https://kenney.nl/assets/<slug> with a Download
 * button linking to a content-hashed zip URL like
 *   https://kenney.nl/media/pages/assets/<slug>/<hash>/<slug>.zip
 *
 * Two browse paths:
 *   - searchCatalog():  fast curated list of ~30 popular packs (below). Zero
 *                       network calls. Use when you want common kits quickly.
 *   - listAllPacks():   scrapes the full /assets listing pagination (~13
 *                       pages, ~280+ packs total). Cached in memory after
 *                       first call. Use when the curated list misses something.
 *
 * Per-pack details (description, file count, screenshots) come from
 *   getPackDetail(slug) which scrapes the individual pack page.
 *
 * All packs ship under CC0 — public domain, no attribution required, safe
 * for monetized Roblox games.
 */
import { fetchText, fetchBuffer, downloadToTemp } from "./common.js";

const SITE = "https://kenney.nl";

export type KenneyContentType = "3d" | "2d" | "ui" | "audio" | "fonts";

export type KenneyPack = {
  slug: string;
  name: string;
  contentTypes: KenneyContentType[];
  tags: string[];
};

/**
 * Curated list of well-known free CC0 packs. Slugs are the URL path segment
 * at kenney.nl/assets/<slug>. Coverage is breadth-first: kits for the most
 * common Roblox game genres + UI + audio.
 */
export const KENNEY_CATALOG: KenneyPack[] = [
  // ── 3D Kits ────────────────────────────────────────────────────────────
  { slug: "platformer-kit",           name: "Platformer Kit",           contentTypes: ["3d"], tags: ["platform", "lowpoly", "blocks"] },
  { slug: "city-kit-suburban",        name: "City Kit (Suburban)",      contentTypes: ["3d"], tags: ["city", "buildings", "houses"] },
  { slug: "city-kit-commercial",      name: "City Kit (Commercial)",    contentTypes: ["3d"], tags: ["city", "buildings", "shops"] },
  { slug: "city-kit-roads",           name: "City Kit (Roads)",         contentTypes: ["3d"], tags: ["roads", "city", "modular"] },
  { slug: "nature-kit",               name: "Nature Kit",               contentTypes: ["3d"], tags: ["trees", "rocks", "outdoor"] },
  { slug: "fantasy-town-kit",         name: "Fantasy Town Kit",         contentTypes: ["3d"], tags: ["fantasy", "medieval", "town"] },
  { slug: "medieval-rts-kit",         name: "Medieval RTS Kit",         contentTypes: ["3d"], tags: ["medieval", "rts", "castle"] },
  { slug: "castle-kit",               name: "Castle Kit",               contentTypes: ["3d"], tags: ["castle", "fantasy", "stone"] },
  { slug: "space-kit",                name: "Space Kit",                contentTypes: ["3d"], tags: ["sci-fi", "ships", "space"] },
  { slug: "tower-defense-kit",        name: "Tower Defense Kit",        contentTypes: ["3d"], tags: ["towers", "td", "fantasy"] },
  { slug: "racing-kit",               name: "Racing Kit",               contentTypes: ["3d"], tags: ["cars", "racing", "track"] },
  { slug: "car-kit",                  name: "Car Kit",                  contentTypes: ["3d"], tags: ["vehicles", "cars"] },
  { slug: "furniture-kit",            name: "Furniture Kit",            contentTypes: ["3d"], tags: ["interior", "rooms", "props"] },
  { slug: "modular-buildings",        name: "Modular Buildings",        contentTypes: ["3d"], tags: ["buildings", "modular"] },
  { slug: "pirate-kit",               name: "Pirate Kit",               contentTypes: ["3d"], tags: ["pirates", "ships", "ocean"] },
  { slug: "mini-dungeon",             name: "Mini Dungeon",             contentTypes: ["3d"], tags: ["dungeon", "rpg", "lowpoly"] },
  { slug: "mini-arena",               name: "Mini Arena",               contentTypes: ["3d"], tags: ["arena", "fighting", "lowpoly"] },
  { slug: "mini-arcade",              name: "Mini Arcade",              contentTypes: ["3d"], tags: ["arcade", "machines"] },
  { slug: "mini-skate",               name: "Mini Skate",               contentTypes: ["3d"], tags: ["skate", "park"] },
  { slug: "survival-kit",             name: "Survival Kit",             contentTypes: ["3d"], tags: ["survival", "items"] },
  { slug: "voxel-pack",               name: "Voxel Pack",               contentTypes: ["3d"], tags: ["voxel", "blocks"] },
  { slug: "blaster-kit",              name: "Blaster Kit",              contentTypes: ["3d"], tags: ["weapons", "guns", "scifi"] },
  { slug: "weapon-pack",              name: "Weapon Pack",              contentTypes: ["3d"], tags: ["weapons", "swords", "guns"] },
  { slug: "animated-characters-2",    name: "Animated Characters 2",    contentTypes: ["3d"], tags: ["characters", "rigged"] },

  // ── 2D / UI ────────────────────────────────────────────────────────────
  { slug: "ui-pack",                  name: "UI Pack",                  contentTypes: ["ui", "2d"], tags: ["ui", "buttons", "panels"] },
  { slug: "ui-pack-rpg-expansion",    name: "UI Pack (RPG Expansion)",  contentTypes: ["ui", "2d"], tags: ["ui", "rpg", "fantasy"] },
  { slug: "ui-pack-sci-fi",           name: "UI Pack (Sci-Fi)",         contentTypes: ["ui", "2d"], tags: ["ui", "scifi"] },
  { slug: "ui-pack-adventure",        name: "UI Pack (Adventure)",      contentTypes: ["ui", "2d"], tags: ["ui", "adventure"] },
  { slug: "game-icons",               name: "Game Icons",               contentTypes: ["ui", "2d"], tags: ["icons"] },
  { slug: "game-icons-expansion",     name: "Game Icons Expansion",     contentTypes: ["ui", "2d"], tags: ["icons"] },
  { slug: "smoke-particles",          name: "Smoke Particles",          contentTypes: ["2d"], tags: ["particles", "smoke"] },
  { slug: "particle-pack",            name: "Particle Pack",            contentTypes: ["2d"], tags: ["particles", "fx"] },

  // ── Audio ──────────────────────────────────────────────────────────────
  { slug: "impact-sounds",            name: "Impact Sounds",            contentTypes: ["audio"], tags: ["sfx", "impacts", "thud"] },
  { slug: "ui-audio",                 name: "UI Audio",                 contentTypes: ["audio"], tags: ["sfx", "ui", "click"] },
  { slug: "sci-fi-sounds",            name: "Sci-Fi Sounds",            contentTypes: ["audio"], tags: ["sfx", "scifi", "lasers"] },
  { slug: "casino-audio",             name: "Casino Audio",             contentTypes: ["audio"], tags: ["sfx", "casino", "coin"] },
  { slug: "rpg-audio",                name: "RPG Audio",                contentTypes: ["audio"], tags: ["sfx", "rpg", "fantasy"] },
  { slug: "music-jingles",            name: "Music Jingles",            contentTypes: ["audio"], tags: ["music", "jingles"] },
  { slug: "voiceover-pack",           name: "Voiceover Pack",           contentTypes: ["audio"], tags: ["voice", "vo"] },
];

export type KenneySearchOpts = {
  query?: string;
  contentType?: KenneyContentType;
};

export function searchCatalog(opts: KenneySearchOpts = {}): KenneyPack[] {
  const q = (opts.query ?? "").toLowerCase().trim();
  return KENNEY_CATALOG.filter((p) => {
    if (opts.contentType && !p.contentTypes.includes(opts.contentType)) return false;
    if (!q) return true;
    if (p.name.toLowerCase().includes(q)) return true;
    if (p.slug.includes(q)) return true;
    if (p.tags.some((t) => t.includes(q))) return true;
    return false;
  });
}

export function packPageUrl(slug: string): string {
  return `${SITE}/assets/${encodeURIComponent(slug)}`;
}

/**
 * Scrape the pack page for the current zip download URL. Kenney uses
 * content-hashed paths so the URL changes when a pack is updated.
 *
 * Looks for the first `<a ... href="https://kenney.nl/media/.../*.zip">` on
 * the page. Stable enough — that anchor has been there for years.
 */
export async function findZipUrl(slug: string): Promise<string> {
  const html = await fetchText(packPageUrl(slug));
  // Match either kenney.nl/media or relative /media paths
  const re = /href\s*=\s*["'](https?:\/\/kenney\.nl\/media\/[^"']+\.zip)["']/i;
  const m = re.exec(html);
  if (m?.[1]) return m[1];
  const reRel = /href\s*=\s*["'](\/media\/[^"']+\.zip)["']/i;
  const m2 = reRel.exec(html);
  if (m2?.[1]) return SITE + m2[1];
  throw new Error(
    `Could not locate .zip download link on ${packPageUrl(slug)}. Site structure may have changed — visit the page manually.`,
  );
}

export async function downloadPackZip(slug: string): Promise<{ filePath: string; bytes: number; sourceUrl: string }> {
  const url = await findZipUrl(slug);
  const dl = await downloadToTemp(url, { subdir: "kenney", extension: ".zip" });
  return { ...dl, sourceUrl: url };
}

// ── Full-site listing scrape ────────────────────────────────────────────────

export type KenneyListPack = {
  slug: string;
  name: string;
  pageUrl: string;
  thumbnailUrl: string | null;
  /** Tags shown on the listing card — usually 1-3 of {3D, 2D, Audio, Textures, Modular, Tower, ...}. */
  tags: string[];
};

const FULL_LIST_TTL_MS = 6 * 60 * 60 * 1000;
let FULL_LIST_CACHE: { fetchedAt: number; packs: KenneyListPack[] } | null = null;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "’")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * Scrape one page of /assets?page=N. Each card on the listing looks like:
 *
 *   <div class='asset'>
 *     <a href='https://kenney.nl/assets/<slug>'>
 *       <div class='cover' style='background-image:url("...sample-400x.png")'></div>
 *     </a>
 *     <h2><a href='https://kenney.nl/assets/<slug>'>Pack Name</a></h2>
 *     <span class='bold text-muted'>
 *       <span><a href='.../assets/category:3D'>3D</a></span>
 *       ...
 *     </span>
 *   </div>
 *
 * Quotes are SINGLE on the live site, hrefs are absolute. Thumbnails are
 * CSS `background-image: url(...)` on a `<div class='cover'>` (not <img>).
 * Category/tag anchors point to `/assets/category:X` or `/assets/tag:Y`,
 * which we filter out — only bare slugs are real packs.
 */
async function scrapeListingPage(pageNum: number): Promise<KenneyListPack[]> {
  const url = pageNum === 1 ? `${SITE}/assets` : `${SITE}/assets/page:${pageNum}`;
  const html = await fetchText(url);
  const out: KenneyListPack[] = [];

  // Each card is a <div class='asset'> ... </div>. Cards are at the same DOM
  // depth, so we segment by that opening tag and capture until the next one.
  const cards = html.split(/<div\s+class=['"]asset['"]>/i).slice(1);

  for (const cardRest of cards) {
    // Truncate at the next "<div class='asset'>" or end of grid container.
    const card = cardRest.split(/<div\s+class=['"]asset['"]>|<\/div>\s*<\/div>\s*<\/div>/)[0] ?? cardRest;

    // Slug: first href to /assets/<slug> that is NOT a category:/tag: link.
    const hrefRe = /href=['"](?:https?:\/\/kenney\.nl)?\/assets\/([^'"#?\/]+)['"]/gi;
    let slug: string | null = null;
    for (const m of card.matchAll(hrefRe)) {
      const candidate = m[1];
      if (!candidate || candidate.includes(":") || candidate === "all") continue;
      slug = candidate;
      break;
    }
    if (!slug) continue;

    // Thumbnail: from background-image:url("...") in the cover div.
    const thumbMatch = /background-image:\s*url\(['"]?([^'")\s]+)['"]?\)/i.exec(card);
    const thumbnailUrl = thumbMatch ? thumbMatch[1] : null;

    // Name: first <h2><a ...>Name</a></h2>.
    const headingMatch = /<h2[^>]*>\s*<a[^>]*>([^<]+)<\/a>/i.exec(card);
    const name = headingMatch ? decodeEntities(headingMatch[1]).trim() : slug;

    // Tags: anchors pointing to /assets/category:X or /assets/tag:X.
    const tags: string[] = [];
    const tagRe = /href=['"][^'"]*\/assets\/(?:category|tag):([^'"#?\/]+)['"][^>]*>([^<]+)<\/a>/gi;
    for (const t of card.matchAll(tagRe)) {
      const tagText = decodeEntities(t[2]).trim();
      if (tagText) tags.push(tagText);
    }

    out.push({ slug, name, pageUrl: `${SITE}/assets/${slug}`, thumbnailUrl, tags });
  }

  // De-dup by slug (defensive — split should produce one card per pack).
  const seen = new Set<string>();
  return out.filter((p) => {
    if (seen.has(p.slug)) return false;
    seen.add(p.slug);
    return true;
  });
}

/** Detect total page count from the pagination block. Pagination URL form: /assets/page:N */
async function detectMaxPage(): Promise<number> {
  const html = await fetchText(`${SITE}/assets`);
  let max = 1;
  for (const m of html.matchAll(/\/assets\/page:(\d+)/g)) {
    const n = Number(m[1]);
    if (n > max && n < 50) max = n;
  }
  return max;
}

/**
 * Scrape the full /assets pagination. Cached for 6 hours.
 * Pages are fetched serially to be polite — total runtime ~2-4s.
 */
export async function listAllPacks(opts: { force?: boolean } = {}): Promise<KenneyListPack[]> {
  if (!opts.force && FULL_LIST_CACHE && Date.now() - FULL_LIST_CACHE.fetchedAt < FULL_LIST_TTL_MS) {
    return FULL_LIST_CACHE.packs;
  }

  const maxPage = await detectMaxPage();
  const all: KenneyListPack[] = [];
  for (let p = 1; p <= maxPage; p++) {
    const page = await scrapeListingPage(p);
    if (!page.length) break; // tail: no more results
    all.push(...page);
  }
  // Final de-dup across pages.
  const seen = new Set<string>();
  const unique = all.filter((p) => {
    if (seen.has(p.slug)) return false;
    seen.add(p.slug);
    return true;
  });
  FULL_LIST_CACHE = { fetchedAt: Date.now(), packs: unique };
  return unique;
}

/**
 * Search the full scraped catalog (vs the curated 30 in searchCatalog).
 * Triggers a one-time site scrape on first call. Free-text query matches
 * name + slug + tags.
 */
export async function searchAll(query?: string, contentType?: KenneyContentType): Promise<KenneyListPack[]> {
  const all = await listAllPacks();
  const q = (query ?? "").toLowerCase().trim();
  const terms = q.split(/\s+/).filter(Boolean);

  return all.filter((p) => {
    if (contentType) {
      // Content type is on the curated list but not always on scraped tags;
      // the listing tags do contain "3D" / "2D" / "Audio" / "Textures".
      const wantTag = ({ "3d": "3d", "2d": "2d", ui: "ui", audio: "audio", fonts: "fonts" } as const)[contentType];
      const hay = p.tags.join(" ").toLowerCase();
      if (!hay.includes(wantTag)) return false;
    }
    if (!terms.length) return true;
    const haystack = [p.name, p.slug, ...p.tags].join(" ").toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

// ── Per-pack details (description, screenshots, file count) ─────────────────

export type KenneyPackDetail = {
  slug: string;
  name: string;
  pageUrl: string;
  description: string;
  /** Direct URLs to large screenshots / preview images shown on the pack page. */
  screenshots: string[];
  /** "150×" → 150. The number of files included in the pack. */
  fileCount?: number;
  /** "Creative Commons CC0" verbatim. */
  license?: string;
  zipUrl?: string;
};

export async function getPackDetail(slug: string): Promise<KenneyPackDetail> {
  const pageUrl = packPageUrl(slug);
  const html = await fetchText(pageUrl);

  const titleMatch = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const name = titleMatch
    ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, "")).trim()
    : slug;

  // Description: meta tag, falling back to the first <p> on the page.
  const descMatch = /<meta\s+name="description"\s+content="([^"]+)"/i.exec(html);
  const description = descMatch ? decodeEntities(descMatch[1]) : "";

  // Screenshots: every <img> pointing into /media/pages/assets/<slug>/.../*.png
  const screenshots: string[] = [];
  const seenImg = new Set<string>();
  const imgRe = /<img[^>]*\bsrc="([^"]+)"/gi;
  for (const m of html.matchAll(imgRe)) {
    let src = m[1];
    if (src.startsWith("/")) src = SITE + src;
    if (!/\/media\/pages\/assets\/.+\.(png|jpg|jpeg|webp)$/i.test(src)) continue;
    if (seenImg.has(src)) continue;
    seenImg.add(src);
    screenshots.push(src);
  }

  // File count: look for "<n>×" or "<n> files" in the page text.
  const fileMatch = /(\d{1,4})\s*(?:×|files?\b)/i.exec(html);
  const fileCount = fileMatch ? Number(fileMatch[1]) : undefined;

  // License: look for "Creative Commons CC0" or just "CC0".
  const licMatch = /(Creative Commons\s+CC0|CC0)/i.exec(html);
  const license = licMatch ? licMatch[1] : undefined;

  // Zip URL — reuse the existing extractor.
  let zipUrl: string | undefined;
  try { zipUrl = await findZipUrl(slug); } catch { /* leave undefined if not found */ }

  return { slug, name, pageUrl, description, screenshots, fileCount, license, zipUrl };
}

/** Fetch a thumbnail (or any single image) as raw bytes — used for AI inline preview. */
export async function fetchImageBuffer(url: string): Promise<Buffer> {
  return fetchBuffer(url);
}
