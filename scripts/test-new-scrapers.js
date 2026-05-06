#!/usr/bin/env node
/**
 * Smoke test: each new scraper's read-only paths.
 * Skips download tests for the auth-required CraftPix flow.
 */
import * as gameicons from "../build/scrapers/gameicons.js";
import * as craftpix from "../build/scrapers/craftpix.js";
import * as kenney from "../build/scrapers/kenney.js";

async function tag(label, p) {
  process.stdout.write(`  ${label} ... `);
  const t = Date.now();
  try {
    const v = await p;
    process.stdout.write(`OK (${Date.now() - t}ms)\n`);
    return v;
  } catch (e) {
    process.stdout.write(`FAIL: ${e.message}\n`);
    throw e;
  }
}

console.log("\n[gameicons]");
const stats = await tag("getCatalogStats", gameicons.getCatalogStats());
console.log(`    -> ${stats.count} icons, ${stats.authors} authors`);
const swordHits = await tag("search('sword')", gameicons.search({ query: "sword", limit: 5 }));
console.log(`    -> ${swordHits.length} hits, first: ${swordHits[0]?.id}`);
const png = await tag("rasterize first hit", gameicons.rasterize(swordHits[0].id, { size: 128 }));
console.log(`    -> ${png.filePath} (${png.bytes}B)`);

console.log("\n[craftpix]");
const items = await tag("listFreebies(page=1)", craftpix.listFreebies({ page: 1 }));
console.log(`    -> ${items.length} items, first: ${items[0]?.slug}`);
if (items.length) {
  const detail = await tag(`getDetail('${items[0].slug}')`, craftpix.getDetail(items[0].slug));
  console.log(`    -> name="${detail.name}" previews=${detail.previewImages.length} dlId=${detail.downloadId}`);
}

console.log("\n[kenney]");
const kall = await tag("listAllPacks (full scrape, may take a few seconds)", kenney.listAllPacks());
console.log(`    -> ${kall.length} packs`);
const platDetail = await tag("getPackDetail('platformer-kit')", kenney.getPackDetail("platformer-kit"));
console.log(`    -> screenshots=${platDetail.screenshots.length} files=${platDetail.fileCount} license=${platDetail.license}`);

console.log("\nDone.");
