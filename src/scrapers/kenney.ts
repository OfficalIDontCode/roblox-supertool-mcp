/**
 * Kenney.nl — CC0 game asset packs (3D, 2D, UI, audio).
 * No API. Each pack is at https://kenney.nl/assets/<slug> with a Download
 * button linking to a content-hashed zip URL like
 *   https://kenney.nl/media/pages/assets/<slug>/<hash>/<slug>.zip
 *
 * Strategy:
 *   1. Curated catalog of ~30 popular packs (below) — used as the default
 *      browse/search corpus, since enumerating all assets requires HTML
 *      scraping the listing page (which is paginated and JS-heavy).
 *   2. To DOWNLOAD a pack, we fetch the pack page HTML and extract the
 *      .zip URL from the Download button via regex. This is the only way
 *      to get the current content-hashed URL without an API.
 *
 * All packs ship under CC0 — public domain, no attribution required, safe
 * for monetized Roblox games.
 */
import { fetchText, downloadToTemp } from "./common.js";

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
