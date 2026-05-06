/**
 * Poly Haven — public CC0 textures, HDRIs, and 3D models.
 * Fully public JSON API at api.polyhaven.com. No key, no auth, no rate limit
 * documented (we still backoff politely on 429).
 *
 * What's useful for Roblox:
 *   - Textures: diffuse/albedo JPG → upload as Decal (asset_upload_image)
 *   - HDRIs:   download only, not directly useful in Studio without conversion
 *   - Models:  FBX → upload as Model (asset_upload_model)
 *
 * Endpoints (public, undocumented but stable for years):
 *   GET https://api.polyhaven.com/assets?t=<type>&c=<cat>&search=<text>
 *     -> { "<slug>": { name, type, categories, tags, dimensions, ... }, ... }
 *   GET https://api.polyhaven.com/info/<slug>
 *   GET https://api.polyhaven.com/files/<slug>
 *     -> nested object: { <map>: { <res>: { <fmt>: { url, size, md5 } } } }
 */
import { fetchJson, downloadToTemp } from "./common.js";

const API = "https://api.polyhaven.com";

export type PolyHavenType = "textures" | "hdris" | "models";

// `type` is encoded as int in the API: 0=hdris, 1=textures, 2=models
const TYPE_TO_QUERY: Record<PolyHavenType, string> = {
  hdris: "hdris",
  textures: "textures",
  models: "models",
};

export type PolyHavenAsset = {
  slug: string;
  name: string;
  type: PolyHavenType;
  categories: string[];
  tags: string[];
  authors?: Record<string, string>;
  date_published?: number;
  download_count?: number;
  dimensions?: [number, number, number];
  thumbnail_url?: string;
};

export type PolyHavenSearchOpts = {
  type: PolyHavenType;
  search?: string;
  categories?: string[];
  limit?: number;
};

type RawAssetMap = Record<string, {
  name: string;
  type: number;
  categories?: string[];
  tags?: string[];
  authors?: Record<string, string>;
  date_published?: number;
  download_count?: number;
  dimensions?: [number, number, number];
  thumbnail_url?: string;
}>;

export async function search(opts: PolyHavenSearchOpts): Promise<PolyHavenAsset[]> {
  // Poly Haven's /assets endpoint only filters server-side by `t` (type) and
  // `c` (category). Free-text search is done client-side on their website,
  // so we mirror that: fetch the full list for the type, then filter locally
  // by name / slug / tags / categories.
  const params = new URLSearchParams({ t: TYPE_TO_QUERY[opts.type] });
  if (opts.categories?.length) params.set("c", opts.categories.join(","));

  const data = await fetchJson<RawAssetMap>(`${API}/assets?${params.toString()}`);
  let items: PolyHavenAsset[] = Object.entries(data).map(([slug, v]) => ({
    slug,
    name: v.name,
    type: opts.type,
    categories: v.categories ?? [],
    tags: v.tags ?? [],
    authors: v.authors,
    date_published: v.date_published,
    download_count: v.download_count,
    dimensions: v.dimensions,
    thumbnail_url: v.thumbnail_url ?? `https://cdn.polyhaven.com/asset_img/thumbs/${slug}.png?width=256&height=256`,
  }));

  if (opts.search?.trim()) {
    const q = opts.search.toLowerCase().trim();
    const terms = q.split(/\s+/).filter(Boolean);
    items = items.filter((it) => {
      const haystack = [it.name, it.slug, ...(it.tags ?? []), ...(it.categories ?? [])]
        .join(" ").toLowerCase();
      return terms.every((t) => haystack.includes(t));
    });
  }

  // Sort by download count desc so popular assets come first
  items.sort((a, b) => (b.download_count ?? 0) - (a.download_count ?? 0));

  const limit = opts.limit ?? 30;
  return items.slice(0, limit);
}

// ── File map traversal ──────────────────────────────────────────────────────

type FileEntry = { url: string; size?: number; md5?: string };
type FilesResponse = Record<string, Record<string, Record<string, FileEntry>>>;

export async function getFiles(slug: string): Promise<FilesResponse> {
  return fetchJson<FilesResponse>(`${API}/files/${encodeURIComponent(slug)}`);
}

export type DownloadOpts = {
  /** Resolution: textures/hdris support 1k/2k/4k/8k; models support 1k/2k/4k. */
  resolution?: "1k" | "2k" | "4k" | "8k";
  /** Format preference. For textures we default to jpg, for models fbx. */
  format?: string;
};

/**
 * Download a texture's diffuse/albedo map at the chosen resolution as JPG.
 * Returns the temp file path — feed to asset_upload_image.
 */
export async function downloadTextureDiffuse(
  slug: string,
  opts: DownloadOpts = {},
): Promise<{ filePath: string; bytes: number; sourceUrl: string }> {
  const files = await getFiles(slug);
  const res = opts.resolution ?? "1k";
  const fmt = opts.format ?? "jpg";

  // Texture maps in the wild have many possible "diffuse" key names. Try in order.
  const diffuseKeys = ["Diffuse", "diff", "diffuse", "albedo", "Color", "col"];
  let entry: FileEntry | null = null;
  for (const key of diffuseKeys) {
    const node = files[key]?.[res]?.[fmt];
    if (node?.url) { entry = node; break; }
  }
  if (!entry) {
    throw new Error(
      `No diffuse map found for ${slug} at ${res}/${fmt}. Available top-level keys: ${Object.keys(files).join(", ")}`,
    );
  }
  const dl = await downloadToTemp(entry.url, { subdir: "polyhaven", extension: ".jpg" });
  return { ...dl, sourceUrl: entry.url };
}

/**
 * Download a 3D model's FBX file. Roblox Open Cloud accepts FBX uploads.
 */
export async function downloadModelFbx(
  slug: string,
  opts: DownloadOpts = {},
): Promise<{ filePath: string; bytes: number; sourceUrl: string }> {
  const files = await getFiles(slug);
  const res = opts.resolution ?? "1k";
  const entry = files["fbx"]?.[res]?.["fbx"];
  if (!entry?.url) {
    throw new Error(
      `No FBX file for ${slug} at ${res}. Available: ${Object.keys(files).join(", ")}`,
    );
  }
  const dl = await downloadToTemp(entry.url, { subdir: "polyhaven", extension: ".fbx" });
  return { ...dl, sourceUrl: entry.url };
}

/**
 * Download an HDRI's tonemapped JPG (panorama). Note this is for inspection
 * only — Roblox doesn't natively use spherical panoramas as decals.
 */
export async function downloadHdriTonemapped(slug: string): Promise<{ filePath: string; bytes: number; sourceUrl: string }> {
  const files = await getFiles(slug);
  const url = (files as any)?.tonemapped?.url ?? (files as any)?.tonemapped?.["8k"]?.jpg?.url;
  if (!url) throw new Error(`No tonemapped JPG for HDRI ${slug}`);
  const dl = await downloadToTemp(url, { subdir: "polyhaven", extension: ".jpg" });
  return { ...dl, sourceUrl: url };
}

export async function fetchThumbnailBase64(slug: string): Promise<string | null> {
  try {
    const url = `https://cdn.polyhaven.com/asset_img/thumbs/${encodeURIComponent(slug)}.png?width=256&height=256`;
    const buf = await (await fetch(url)).arrayBuffer();
    return Buffer.from(buf).toString("base64");
  } catch {
    return null;
  }
}
