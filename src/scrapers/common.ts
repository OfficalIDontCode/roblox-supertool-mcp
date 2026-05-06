/**
 * Shared HTTP + filesystem helpers for the third-party asset scrapers.
 * All scrapers fetch JSON / binaries the same way, so the boilerplate
 * (User-Agent, retry, temp file paths) lives here.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const SCRAPER_UA =
  "Mozilla/5.0 RobloxSupertool/0.3 (+local; contact via plugin)";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  retries = 3,
): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          "User-Agent": SCRAPER_UA,
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
      });
      if (res.status === 429 && attempt < retries) {
        await sleep(attempt * 1000);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 240)}`);
      }
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(attempt * 500);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchText(url: string, init: RequestInit = {}): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": SCRAPER_UA, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

export async function fetchBuffer(url: string, init: RequestInit = {}): Promise<Buffer> {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": SCRAPER_UA, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Stable temp directory for the supertool's own downloads — keeps everything
 * findable + cleanable instead of scattered across os.tmpdir().
 */
export const SCRAPER_TMP_DIR = path.join(os.tmpdir(), "roblox-supertool", "scraped");

async function ensureTmp(): Promise<void> {
  await fs.mkdir(SCRAPER_TMP_DIR, { recursive: true });
}

/**
 * Download `url` into the supertool temp dir. Returns the absolute file path.
 * Filename derives from the URL (last path segment) plus a short hash so two
 * downloads with the same name don't collide.
 */
export async function downloadToTemp(
  url: string,
  opts: { extension?: string; subdir?: string } = {},
): Promise<{ filePath: string; bytes: number }> {
  await ensureTmp();
  const buf = await fetchBuffer(url);

  const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 8);
  const urlPath = (() => {
    try { return new URL(url).pathname; } catch { return url; }
  })();
  const baseName = path.basename(urlPath).replace(/[^A-Za-z0-9._-]+/g, "_") || "file";
  const ext = opts.extension ?? path.extname(baseName) ?? "";
  const stem = ext && baseName.endsWith(ext) ? baseName.slice(0, -ext.length) : baseName;
  const filename = `${stem}_${hash}${ext.startsWith(".") ? ext : ext ? "." + ext : ""}`;

  const dir = opts.subdir ? path.join(SCRAPER_TMP_DIR, opts.subdir) : SCRAPER_TMP_DIR;
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, buf);
  return { filePath, bytes: buf.length };
}

/** Convenience: base64 a buffer fetched at `url`. Used for inline previews. */
export async function fetchBase64(url: string): Promise<string> {
  const buf = await fetchBuffer(url);
  return buf.toString("base64");
}
