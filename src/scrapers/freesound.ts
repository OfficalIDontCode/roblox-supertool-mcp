/**
 * Freesound — large CC-licensed sound library.
 * REST API at freesound.org/apiv2. Requires a free API key:
 *   https://freesound.org/apiv2/apply
 *
 * The user enters the key in the Studio plugin's widget; it's persisted via
 * plugin:SetSetting and re-sent on every /poll. Same in-memory-only model as
 * the Open Cloud key — see src/auth.ts.
 *
 * What works without OAuth:
 *   - Search (text, tags, filters)
 *   - Sound metadata
 *   - Preview downloads (~22kHz mp3/ogg, public CDN URL on each result)
 *
 * What requires OAuth (out of scope for now):
 *   - Original full-quality file downloads
 *   - User favorites, packs, etc.
 *
 * Previews are fine for Roblox upload — Roblox accepts mp3/ogg/wav for
 * Audio assets via Open Cloud.
 *
 * License field in results: "Creative Commons 0", "Attribution",
 * "Attribution NonCommercial", "Sampling+". Filter to CC0/Attribution if you
 * plan to monetize the game.
 */
import { fetchJson, downloadToTemp } from "./common.js";
import { requireFreesoundKey, getFreesoundKey } from "../auth.js";

const API = "https://freesound.org/apiv2";

export function getApiKey(): string {
  return requireFreesoundKey();
}

export function isConfigured(): boolean {
  return getFreesoundKey() !== null;
}

// ── Search ──────────────────────────────────────────────────────────────────

export type FreesoundLicense =
  | "Creative Commons 0"
  | "Attribution"
  | "Attribution NonCommercial"
  | "Sampling+";

export type FreesoundResult = {
  id: number;
  name: string;
  username: string;
  duration: number; // seconds
  license: string;
  tags: string[];
  description: string;
  filesize: number;
  type: string; // "mp3" | "wav" | "ogg" | ...
  channels: number;
  samplerate: number;
  previews: {
    "preview-hq-mp3": string;
    "preview-hq-ogg": string;
    "preview-lq-mp3": string;
    "preview-lq-ogg": string;
  };
  url: string;
  num_downloads: number;
  avg_rating: number;
  num_ratings: number;
};

export type FreesoundSearchOpts = {
  query: string;
  /** Server-side filter, e.g. 'duration:[0 TO 5] license:"Creative Commons 0"' */
  filter?: string;
  /** Subset of licenses to allow. Translates to a `filter=` clause. */
  licenses?: Array<"cc0" | "by" | "by-nc" | "sampling+">;
  /** Max duration in seconds (server-side). */
  maxDuration?: number;
  /** Min duration in seconds (server-side). */
  minDuration?: number;
  sort?: "score" | "duration_desc" | "duration_asc" | "downloads_desc" | "rating_desc" | "created_desc";
  pageSize?: number; // 1..150, default 15
  page?: number;
};

const LICENSE_FILTER: Record<string, string> = {
  "cc0": 'license:"Creative Commons 0"',
  "by": 'license:"Attribution"',
  "by-nc": 'license:"Attribution NonCommercial"',
  "sampling+": 'license:"Sampling+"',
};

const FIELDS = [
  "id", "name", "username", "duration", "license", "tags", "description",
  "filesize", "type", "channels", "samplerate", "previews", "url",
  "num_downloads", "avg_rating", "num_ratings",
].join(",");

export async function search(opts: FreesoundSearchOpts): Promise<{ count: number; results: FreesoundResult[] }> {
  const key = getApiKey();
  const params = new URLSearchParams({
    query: opts.query,
    fields: FIELDS,
    page_size: String(opts.pageSize ?? 15),
    page: String(opts.page ?? 1),
    token: key,
  });
  if (opts.sort) params.set("sort", opts.sort);

  const filterParts: string[] = [];
  if (opts.filter) filterParts.push(opts.filter);
  if (opts.licenses?.length) {
    const clauses = opts.licenses.map((l) => LICENSE_FILTER[l]).filter(Boolean);
    if (clauses.length) filterParts.push("(" + clauses.join(" OR ") + ")");
  }
  if (opts.minDuration !== undefined || opts.maxDuration !== undefined) {
    const lo = opts.minDuration ?? 0;
    const hi = opts.maxDuration ?? 600;
    filterParts.push(`duration:[${lo} TO ${hi}]`);
  }
  if (filterParts.length) params.set("filter", filterParts.join(" "));

  const data = await fetchJson<{ count: number; results: FreesoundResult[] }>(
    `${API}/search/text/?${params.toString()}`,
  );
  return data;
}

export async function getSound(id: number): Promise<FreesoundResult> {
  const key = getApiKey();
  const params = new URLSearchParams({ fields: FIELDS, token: key });
  return fetchJson<FreesoundResult>(`${API}/sounds/${id}/?${params.toString()}`);
}

/**
 * Download the high-quality MP3 preview. Preview URLs are public CDN — no
 * token needed on the actual download (token only needed for the search/info).
 */
export async function downloadPreview(
  id: number,
  format: "mp3" | "ogg" = "mp3",
): Promise<{ filePath: string; bytes: number; sourceUrl: string; meta: FreesoundResult }> {
  const meta = await getSound(id);
  const url = format === "ogg" ? meta.previews["preview-hq-ogg"] : meta.previews["preview-hq-mp3"];
  if (!url) throw new Error(`No ${format} preview URL for sound ${id}`);
  const dl = await downloadToTemp(url, { subdir: "freesound", extension: "." + format });
  return { ...dl, sourceUrl: url, meta };
}
