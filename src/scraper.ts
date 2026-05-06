/**
 * Roblox Marketplace / Toolbox scraper.
 *
 * Direct port of C:\Dev\roblox-scraper\scraper.py to TypeScript so it runs
 * in-process, returns image content for AI visual selection, and integrates
 * with the supertool's `insert_asset` tool for one-shot search→insert flows.
 *
 * Hits the public toolbox-service + thumbnails APIs. No auth required.
 */
import fs from "node:fs";
import path from "node:path";

export const CATEGORY_IDS: Record<string, number> = {
  audio: 3,
  decal: 13,
  model: 10,
  meshpart: 40,
  animation: 24,
  plugin: 38,
};

export const SORT_TYPES: Record<string, string> = {
  relevance: "Relevance",
  recent: "MostRecent",
  oldest: "LeastRecent",
  downloads: "MostDownloaded",
  votes: "MostFavorited",
};

const SEARCH_URL = (cat: number) =>
  `https://apis.roblox.com/toolbox-service/v1/marketplace/${cat}`;
const DETAILS_URL = "https://apis.roblox.com/toolbox-service/v1/items/details";
const THUMB_URL = "https://thumbnails.roblox.com/v1/assets";

const UA = "Mozilla/5.0 RobloxSupertoolScraper/0.3 (+https://github.com/local)";

export const PRESETS_DIR = "C:/Dev/roblox-scraper/presets";

// ─── HTTP with retry/backoff ─────────────────────────────────────────────────

async function fetchJson<T = unknown>(url: string, retries = 4): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (res.status === 429 && attempt < retries) {
        await sleep(attempt * 1000);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(attempt * 500);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`thumbnail fetch ${res.status}: ${url}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Item type ───────────────────────────────────────────────────────────────

export type Item = {
  id: string;
  textureId: string | null;
  name: string;
  description: string;
  creator: string;
  creatorId: number | null;
  creatorType: string;
  isVerifiedCreator: boolean;
  typeId: number | null;
  duration: number;
  isFree: boolean;
  upVotes: number;
  downVotes: number;
  voteRatio: number;
  keyword: string;
  marketplaceUrl: string;
  rbxAssetId: string;     // "rbxassetid://..."
  insertableId: string;   // numeric ID suitable for InsertService:LoadAsset
};

function parseItem(raw: any, keyword: string): Item | null {
  const a = raw?.asset ?? {};
  const c = raw?.creator ?? {};
  const fp = raw?.fiatProduct ?? {};
  const voting = raw?.voting ?? {};
  const assetId = a?.id;
  if (!assetId) return null;

  const creatorTypeId = c?.type;
  let creatorType = creatorTypeId === 1 ? "User" : creatorTypeId === 2 ? "Group" : String(creatorTypeId ?? "");
  if (c?.id === 1 || (c?.name ?? "").toLowerCase() === "roblox") creatorType = "Roblox";

  const typeId = a?.typeId ?? null;
  const textureId = a?.textureId ? String(a.textureId) : null;
  // For decals (type 13), ImageLabel.Image needs the underlying textureId
  const usableId = typeId === 13 && textureId ? textureId : String(assetId);

  return {
    id: String(assetId),
    textureId,
    name: a?.name ?? "",
    description: (a?.description ?? "").slice(0, 240),
    creator: c?.name ?? "",
    creatorId: c?.id ?? null,
    creatorType,
    isVerifiedCreator: !!c?.isVerifiedCreator,
    typeId,
    duration: Number(a?.duration ?? 0),
    isFree: !!fp?.isFree,
    upVotes: Number(voting?.upVotes ?? 0),
    downVotes: Number(voting?.downVotes ?? 0),
    voteRatio: Number(voting?.upVotePercent ?? 0),
    keyword,
    marketplaceUrl: `https://create.roblox.com/store/asset/${assetId}`,
    rbxAssetId: `rbxassetid://${usableId}`,
    insertableId: String(assetId),
  };
}

// ─── Search core ─────────────────────────────────────────────────────────────

export type SearchOpts = {
  category: keyof typeof CATEGORY_IDS;
  keywords: string[];
  limit?: number;
  pages?: number;
  sort?: keyof typeof SORT_TYPES;
  freeOnly?: boolean;
  minVotes?: number;
  minRatio?: number;
  maxDuration?: number;
  creatorId?: number;
  officialOnly?: boolean;
};

export async function searchIds(
  category: number,
  keyword: string,
  opts: { limit: number; pages: number; sort: string },
): Promise<string[]> {
  const ids: string[] = [];
  let page = 1;
  while (page <= opts.pages) {
    const params = new URLSearchParams({
      keyword,
      limit: String(Math.min(30, opts.limit)),
      pageNumber: String(page),
      sortType: SORT_TYPES[opts.sort] ?? "Relevance",
    });
    const data = await fetchJson<{ data?: Array<{ id?: number }>; nextPageCursor?: string }>(
      `${SEARCH_URL(category)}?${params.toString()}`,
    );
    const rows = data.data ?? [];
    if (rows.length === 0) break;
    for (const r of rows) if (r.id) ids.push(String(r.id));
    if (!data.nextPageCursor) break;
    page++;
    await sleep(300);
  }
  return ids;
}

export async function fetchDetails(ids: string[], keyword = ""): Promise<Item[]> {
  const out: Item[] = [];
  const batchSize = 50;
  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    const url = `${DETAILS_URL}?assetIds=${chunk.join(",")}`;
    const data = await fetchJson<{ data?: any[] }>(url);
    for (const entry of data.data ?? []) {
      const item = parseItem(entry, keyword);
      if (item) out.push(item);
    }
    if (i + batchSize < ids.length) await sleep(300);
  }
  return out;
}

export async function search(opts: SearchOpts): Promise<Item[]> {
  const catId = CATEGORY_IDS[opts.category];
  if (!catId) throw new Error(`Unknown category: ${opts.category}`);

  const limit = opts.limit ?? 12;
  const pages = opts.pages ?? 1;
  const sort = opts.sort ?? "relevance";

  // Dedup IDs across keywords; remember which keyword surfaced each
  const idToKeyword = new Map<string, string>();
  for (const kw of opts.keywords) {
    try {
      const ids = await searchIds(catId, kw, { limit, pages, sort });
      for (const id of ids) if (!idToKeyword.has(id)) idToKeyword.set(id, kw);
    } catch {
      // continue with other keywords
    }
  }

  // Fetch details, grouping by keyword
  const byKw = new Map<string, string[]>();
  for (const [id, kw] of idToKeyword.entries()) {
    if (!byKw.has(kw)) byKw.set(kw, []);
    byKw.get(kw)!.push(id);
  }
  const items: Item[] = [];
  for (const [kw, idsInKw] of byKw.entries()) {
    items.push(...(await fetchDetails(idsInKw, kw)));
  }

  // Apply filters
  const filtered = items.filter((it) => {
    if ((opts.freeOnly ?? true) && !it.isFree) return false;
    if (opts.minVotes && it.upVotes - it.downVotes < opts.minVotes) return false;
    if (opts.minRatio && it.upVotes + it.downVotes > 0 && it.voteRatio < opts.minRatio) return false;
    if (opts.maxDuration !== undefined && it.duration > opts.maxDuration) return false;
    if (opts.creatorId !== undefined && it.creatorId !== opts.creatorId) return false;
    if (opts.officialOnly && !(it.isVerifiedCreator || it.creatorType === "Roblox")) return false;
    return true;
  });

  // Sort: votes net desc, ratio desc, name asc
  filtered.sort((a, b) => {
    const aNet = a.upVotes - a.downVotes;
    const bNet = b.upVotes - b.downVotes;
    if (aNet !== bNet) return bNet - aNet;
    if (a.voteRatio !== b.voteRatio) return b.voteRatio - a.voteRatio;
    return a.name.localeCompare(b.name);
  });

  return filtered;
}

// ─── Thumbnails ──────────────────────────────────────────────────────────────

export type ThumbnailSize = "150x150" | "420x420" | "700x700";

/**
 * Returns map of assetId -> CDN imageUrl. Skips entries that aren't ready yet.
 */
export async function fetchThumbnailUrls(ids: string[], size: ThumbnailSize = "420x420"): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const batchSize = 50;
  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    const params = new URLSearchParams({
      assetIds: chunk.join(","),
      size,
      format: "png",
    });
    const data = await fetchJson<{ data?: Array<{ targetId: number; state: string; imageUrl?: string }> }>(
      `${THUMB_URL}?${params.toString()}`,
    );
    for (const t of data.data ?? []) {
      if (t.state === "Completed" && t.imageUrl) result.set(String(t.targetId), t.imageUrl);
    }
    if (i + batchSize < ids.length) await sleep(200);
  }
  return result;
}

/**
 * Fetch a single thumbnail and return as base64 PNG. Returns null on failure.
 */
export async function fetchThumbnailBase64(assetId: string, size: ThumbnailSize = "420x420"): Promise<string | null> {
  try {
    const urls = await fetchThumbnailUrls([assetId], size);
    const url = urls.get(assetId);
    if (!url) return null;
    const buf = await fetchBuffer(url);
    return buf.toString("base64");
  } catch {
    return null;
  }
}

/**
 * Batch-fetch thumbnails; returns array aligned to input ids (null where unavailable).
 */
export async function fetchThumbnailsBatch(ids: string[], size: ThumbnailSize = "420x420"): Promise<Array<{ id: string; base64: string | null }>> {
  const urlMap = await fetchThumbnailUrls(ids, size);
  const out: Array<{ id: string; base64: string | null }> = [];
  // Limited concurrency — Roblox CDN handles bursts but be polite
  const concurrency = 6;
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const i = cursor++;
      const id = ids[i]!;
      const url = urlMap.get(id);
      if (!url) {
        out[i] = { id, base64: null };
        continue;
      }
      try {
        const buf = await fetchBuffer(url);
        out[i] = { id, base64: buf.toString("base64") };
      } catch {
        out[i] = { id, base64: null };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

// ─── Presets (compatible with C:\Dev\roblox-scraper\presets\*.json) ─────────

export type PresetSpec = {
  description?: string;
  defaults?: {
    limit?: number;
    pages?: number;
    sort?: keyof typeof SORT_TYPES;
    free_only?: boolean;
    min_votes?: number;
    min_ratio?: number;
    max_duration?: number;
    creator_id?: number;
    official_only?: boolean;
  };
  queries: Record<string, { category: string; keywords: string[] }>;
};

export function listPresets(): Array<{ name: string; description: string; tagCount: number; path: string }> {
  if (!fs.existsSync(PRESETS_DIR)) return [];
  return fs
    .readdirSync(PRESETS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const full = path.join(PRESETS_DIR, f);
      try {
        const data = JSON.parse(fs.readFileSync(full, "utf8")) as PresetSpec;
        return {
          name: f.replace(/\.json$/, ""),
          description: data.description ?? "",
          tagCount: Object.keys(data.queries ?? {}).length,
          path: full,
        };
      } catch {
        return { name: f.replace(/\.json$/, ""), description: "(invalid JSON)", tagCount: 0, path: full };
      }
    });
}

export function loadPreset(name: string): PresetSpec {
  const candidates = [
    path.join(PRESETS_DIR, `${name}.json`),
    path.join(PRESETS_DIR, name),
    name,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      return JSON.parse(fs.readFileSync(c, "utf8")) as PresetSpec;
    }
  }
  throw new Error(`Preset not found: ${name} (looked in ${PRESETS_DIR})`);
}

export async function runPreset(name: string): Promise<Record<string, Item[]>> {
  const preset = loadPreset(name);
  const defaults = preset.defaults ?? {};
  const result: Record<string, Item[]> = {};
  for (const [tag, group] of Object.entries(preset.queries ?? {})) {
    const cat = group.category as keyof typeof CATEGORY_IDS;
    if (!CATEGORY_IDS[cat]) continue;
    const items = await search({
      category: cat,
      keywords: group.keywords,
      limit: defaults.limit ?? 20,
      pages: defaults.pages ?? 1,
      sort: defaults.sort ?? "relevance",
      freeOnly: defaults.free_only ?? true,
      minVotes: defaults.min_votes,
      minRatio: defaults.min_ratio,
      maxDuration: defaults.max_duration,
      creatorId: defaults.creator_id,
      officialOnly: defaults.official_only,
    });
    result[tag] = items;
  }
  return result;
}
