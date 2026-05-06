// Standalone test of the Rojo parser against C:\Dev\primal-islands
import { loadProject, findProjectFile, setCurrentProject, resolveStudioPathToFile, maybeFindTsSourceForBinding } from "../build/rojo.js";

const found = findProjectFile("C:/Dev/primal-islands");
console.log("Found project file:", found);

if (!found) {
  console.error("FAIL: project not found");
  process.exit(1);
}

const project = loadProject(found);
setCurrentProject(project);

console.log("\n=== Project summary ===");
console.log("Name:", project.name);
console.log("isRobloxTs:", project.isRobloxTs);
console.log("tsSourceDir:", project.tsSourceDir);
console.log("tsOutputDir:", project.tsOutputDir);
console.log("Total bindings:", project.bindings.length);

console.log("\n=== Sample bindings (first 10) ===");
for (const b of project.bindings.slice(0, 10)) {
  console.log(`  ${b.studioPath}\n    -> ${b.localFile}\n    [${b.className}]`);
}

console.log("\n=== Path resolution tests ===");
// Try resolving a known TS-mapped path
const tsTest = "game.ServerScriptService.TS";
const r1 = resolveStudioPathToFile(tsTest);
if (r1) {
  console.log(`${tsTest} → ${r1.localFile} [${r1.className}]`);
  const ts = maybeFindTsSourceForBinding(r1);
  console.log(`  TS source: ${ts ?? "(not found / not in compiled output)"}`);
} else {
  console.log(`${tsTest} → not directly mapped (likely a $path mapping with children)`);
}

// Try a few likely script paths
for (const sp of [
  "game.ReplicatedStorage.AdminPanelRS.AdminsModule",
  "game.StarterPlayer.StarterPlayerScripts.TS.controllers.GatheringBarController",
  "game.ServerScriptService.TS",
  "game.ServerScriptService.TS.services.GatheringSystemService",
  "game.ReplicatedStorage.TS.AdminsModule",
  "game.NotARealPath",
]) {
  const r = resolveStudioPathToFile(sp);
  if (r) {
    const ts = maybeFindTsSourceForBinding(r);
    console.log(`  ${sp}\n    -> ${r.localFile}${ts ? ` (TS: ${ts})` : ""}`);
  } else {
    console.log(`  ${sp} -> NOT MAPPED`);
  }
}

console.log("\n=== Sanity ===");
const tsBindings = project.bindings.filter((b) => b.studioPath.includes(".TS."));
const adminBindings = project.bindings.filter((b) => b.studioPath.includes("AdminPanel"));
console.log(`TS bindings: ${tsBindings.length}`);
console.log(`AdminPanel bindings: ${adminBindings.length}`);
