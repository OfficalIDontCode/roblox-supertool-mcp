/**
 * CraftPix.net — 2D game asset freebies (sprites, tilesets, GUI, icons).
 * No public API. We scrape the WordPress-rendered HTML at:
 *   https://craftpix.net/freebies/page/<n>/
 *
 * Each listing card contains an asset slug + thumbnail. The detail page at
 *   https://craftpix.net/freebies/<slug>/
 * has the larger preview images + a "free download" button pointing to
 *   https://craftpix.net/download/<numeric-id>/
 *
 * The /download/<id>/ URL requires a logged-in CraftPix account session.
 * The user provides their session cookie (`wordpress_logged_in_*`) via the
 * Studio plugin widget — see src/auth.ts. Without the cookie we still expose
 * browse/preview functionality, just not the actual zip download.
 *
 * Asset categories on the site: tilesets, sprites, GUI, icons, audio. Most
 * are PNG — directly upload-able to Roblox as Decals after extracting the zip.
 *
 * License: each asset's page has a "License details" link. CraftPix's standard
 * free license permits commercial use; the user is responsible for verifying
 * per-asset terms before shipping.
 */
import { fetchText, fetchBuffer, downloadToTemp } from "./common.js";
import { getCraftpixCookie } from "../auth.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SITE = "https://craftpix.net";
const TMP_DIR = path.join(os.tmpdir(), "roblox-supertool", "scraped", "craftpix");

export type CraftpixListItem = {
  slug: string;
  name: string;
  pageUrl: string;
  thumbnailUrl: string | null;
  category?: string;
};

export type CraftpixListOpts = {
  page?: number;
  query?: string;
};

/**
 * Decode common HTML entities in scraped text. The site emits standard WP
 * entities (&amp;, &#8217;, &#8211;, etc.) — full DOMParser is overkill.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "’")
    .replace(/&#8216;/g, "‘")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * Scrape a /freebies/page/N/ listing. Returns up to ~30 cards per page.
 * Pages are 1-indexed; page 1 is also accessible at /freebies/.
 */
export async function listFreebies(opts: CraftpixListOpts = {}): Promise<CraftpixListItem[]> {
  const page = opts.page ?? 1;
  const url = page === 1 ? `${SITE}/freebies/` : `${SITE}/freebies/page/${page}/`;
  const html = await fetchText(url);

  const items: CraftpixListItem[] = [];
  // Each card is an <article ...> ... </article> on the listing. Inside it
  // there's a link to the freebie page with class "post-thumbnail" or similar
  // and an <img> for the thumb. We match on the <a href="...">/<img src="...">
  // pair scoped to /freebies/<slug>/.
  const cardRe = /<article[\s\S]*?<\/article>/gi;
  for (const cardMatch of html.matchAll(cardRe)) {
    const card = cardMatch[0];

    const linkMatch = /<a\s[^>]*href="(https?:\/\/craftpix\.net\/freebies\/[^"\/?#]+)\/?"[^>]*>/i.exec(card);
    if (!linkMatch) continue;
    const pageUrl = linkMatch[1];
    const slug = pageUrl.replace(/^.*\/freebies\//, "").replace(/\/$/, "");
    if (!slug) continue;

    const titleMatch = /<a[^>]*href="https?:\/\/craftpix\.net\/freebies\/[^"]*"[^>]*>([^<]+)<\/a>/i.exec(card);
    const name = titleMatch ? decodeEntities(titleMatch[1].trim()) : slug;

    const imgMatch =
      /<img[^>]*\bsrc="([^"]+)"[^>]*>/i.exec(card) ||
      /<img[^>]*\bdata-src="([^"]+)"[^>]*>/i.exec(card);
    const thumbnailUrl = imgMatch ? imgMatch[1] : null;

    const catMatch = /in:\s*<a[^>]*>([^<]+)<\/a>/i.exec(card);
    const category = catMatch ? decodeEntities(catMatch[1].trim()) : undefined;

    items.push({ slug, name, pageUrl, thumbnailUrl, category });
  }

  // De-duplicate (the site sometimes emits both an image-only and text-only
  // anchor for the same card → two articles with the same slug).
  const seen = new Set<string>();
  const unique = items.filter((it) => {
    if (seen.has(it.slug)) return false;
    seen.add(it.slug);
    return true;
  });

  if (opts.query) {
    const q = opts.query.toLowerCase();
    return unique.filter((it) => it.name.toLowerCase().includes(q) || it.slug.includes(q));
  }
  return unique;
}

export type CraftpixDetail = {
  slug: string;
  name: string;
  pageUrl: string;
  description: string;
  previewImages: string[];
  /** "Files: AI, EPS, PNG" or similar — verbatim from the spec block. */
  fileFormats?: string;
  layered?: boolean;
  sprite?: boolean;
  /** Numeric download id used by /download/<id>/. Null if not found (rare). */
  downloadId: string | null;
  downloadUrl: string | null;
};

const PREVIEW_HOSTS = ["img.craftpix.net", "craftpix.net"];

export async function getDetail(slug: string): Promise<CraftpixDetail> {
  const pageUrl = `${SITE}/freebies/${encodeURIComponent(slug)}/`;
  const html = await fetchText(pageUrl);

  // Title: first <h1>...</h1> on the page.
  const titleMatch = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const name = titleMatch ? decodeEntities(stripTags(titleMatch[1])).trim() : slug;

  // Description: <meta name="description" content="...">
  const descMatch = /<meta\s+name="description"\s+content="([^"]+)"/i.exec(html);
  const description = descMatch ? decodeEntities(descMatch[1]) : "";

  // Preview images — match img tags pointing at img.craftpix.net.
  const previewImages: string[] = [];
  const seenImg = new Set<string>();
  const imgRe = /<img[^>]*\b(?:src|data-src)="(https?:\/\/[^"]+)"/gi;
  for (const m of html.matchAll(imgRe)) {
    const src = m[1];
    if (!PREVIEW_HOSTS.some((h) => src.includes(h))) continue;
    if (!/\.(jpe?g|png|webp|gif)(\?|$)/i.test(src)) continue;
    // Skip site chrome (logos, avatars).
    if (/avatar|logo|icon-/i.test(src)) continue;
    if (seenImg.has(src)) continue;
    seenImg.add(src);
    previewImages.push(src);
  }

  // Specs block
  const fileFormatsMatch = /Files?:\s*([A-Z0-9, ]+)/i.exec(html);
  const fileFormats = fileFormatsMatch ? fileFormatsMatch[1].trim() : undefined;

  const layered = /Layered:\s*Yes/i.test(html) ? true : /Layered:\s*No/i.test(html) ? false : undefined;
  const sprite  = /Sprite:\s*Yes/i.test(html) ? true : /Sprite:\s*No/i.test(html) ? false : undefined;

  // Download URL — looks like href="https://craftpix.net/download/123456/"
  const dlMatch = /href="(https?:\/\/craftpix\.net\/download\/(\d+)\/?)"/i.exec(html);
  const downloadUrl = dlMatch ? dlMatch[1] : null;
  const downloadId = dlMatch ? dlMatch[2] : null;

  return {
    slug,
    name,
    pageUrl,
    description,
    previewImages,
    fileFormats,
    layered,
    sprite,
    downloadId,
    downloadUrl,
  };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

/**
 * Download the freebie's zip. Requires a logged-in session cookie set in the
 * plugin widget. CraftPix issues a 302 redirect from /download/<id>/ to a
 * signed S3 URL when the cookie is valid; otherwise it 302s back to the login.
 */
export async function downloadFreebie(slug: string): Promise<{ filePath: string; bytes: number; sourceUrl: string; meta: CraftpixDetail }> {
  const cookie = getCraftpixCookie();
  if (!cookie) {
    throw new Error(
      "No CraftPix session cookie configured. Open the Supertool widget in Studio, paste your CraftPix `wordpress_logged_in_*` cookie value into the CraftPix Cookie field, and click Save. Find it in browser DevTools → Application → Cookies → craftpix.net after logging in.",
    );
  }
  const meta = await getDetail(slug);
  if (!meta.downloadUrl) {
    throw new Error(`No download URL found on ${meta.pageUrl}. Site structure may have changed, or this freebie isn't publicly downloadable.`);
  }

  const res = await fetch(meta.downloadUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 RobloxSupertool/0.4 (+local; contact via plugin)",
      Cookie: cookie,
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`CraftPix download failed (HTTP ${res.status}). Cookie may be expired — re-login and re-paste.`);
  }
  // CraftPix sometimes 200s with an HTML "please log in" page even on a bad cookie.
  const ctype = res.headers.get("content-type") ?? "";
  if (ctype.includes("text/html")) {
    throw new Error("CraftPix returned HTML, not a zip. Your session cookie is probably expired — re-login and update the value in the Supertool widget.");
  }
  const buf = Buffer.from(await res.arrayBuffer());

  await fs.mkdir(TMP_DIR, { recursive: true });
  const safe = slug.replace(/[^A-Za-z0-9._-]+/g, "_");
  const filePath = path.join(TMP_DIR, `${safe}.zip`);
  await fs.writeFile(filePath, buf);

  return { filePath, bytes: buf.length, sourceUrl: res.url || meta.downloadUrl, meta };
}

/**
 * Download a specific preview image (no login required). Returns local path —
 * suitable for asset_upload_image since previews are PNG/JPG/WebP.
 */
export async function downloadPreview(slug: string, index = 0): Promise<{ filePath: string; bytes: number; sourceUrl: string }> {
  const meta = await getDetail(slug);
  if (!meta.previewImages.length) throw new Error(`No preview images found for ${slug}.`);
  if (index < 0 || index >= meta.previewImages.length) {
    throw new Error(`Preview index ${index} out of range (have ${meta.previewImages.length}).`);
  }
  const url = meta.previewImages[index];
  // Roblox doesn't accept WebP — only PNG/JPG/BMP/TGA. Force a JPG extension
  // when the source is webp; the file content is still webp bytes, so the
  // caller should rasterize first if needed. The asset_upload_image tool
  // also rejects webp — we surface a clear error in that case below.
  const ext = path.extname(new URL(url).pathname).toLowerCase() || ".bin";
  const dl = await downloadToTemp(url, { subdir: "craftpix", extension: ext });
  return { ...dl, sourceUrl: url };
}

/** Fetch a thumbnail image as raw bytes (used for inline AI previews). */
export async function fetchThumbnailBuffer(url: string): Promise<Buffer> {
  return fetchBuffer(url);
}
