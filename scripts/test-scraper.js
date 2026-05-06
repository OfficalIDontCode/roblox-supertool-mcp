// Standalone test of the scraper against the real Roblox Toolbox API
import { search, fetchThumbnailUrls, listPresets } from "../build/scraper.js";

console.log("=== Listing presets ===");
const presets = listPresets();
for (const p of presets) {
  console.log(`  ${p.name} (${p.tagCount} tags) — ${p.description.slice(0, 60)}`);
}

console.log("\n=== Test search: 'sword' models ===");
const items = await search({
  category: "model",
  keywords: ["sword", "blade"],
  limit: 10,
  pages: 1,
  sort: "votes",
  freeOnly: true,
});
console.log(`Found ${items.length} items. Top 5:`);
for (const it of items.slice(0, 5)) {
  console.log(`  [${it.id}] ${it.name} by ${it.creator}`);
  console.log(`    votes: +${it.upVotes - it.downVotes}, ratio ${it.voteRatio.toFixed(0)}%, free: ${it.isFree}`);
  console.log(`    rbx: ${it.rbxAssetId}`);
}

console.log("\n=== Thumbnail URL fetch for top 3 ===");
const top3 = items.slice(0, 3);
const ids = top3.map((it) => (it.typeId === 13 && it.textureId ? it.textureId : it.id));
const urls = await fetchThumbnailUrls(ids, "420x420");
for (const id of ids) {
  console.log(`  ${id} -> ${urls.get(id) ?? "(not ready)"}`);
}

console.log("\n=== Decal search: 'wood texture' ===");
const decals = await search({
  category: "decal",
  keywords: ["wood texture"],
  limit: 5,
  sort: "votes",
});
console.log(`Found ${decals.length} decals. Top 3:`);
for (const it of decals.slice(0, 3)) {
  console.log(`  [${it.id}] ${it.name} (textureId: ${it.textureId})`);
  console.log(`    rbx: ${it.rbxAssetId}`);
}
