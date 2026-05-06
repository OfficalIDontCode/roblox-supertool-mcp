/**
 * Rojo project integration.
 *
 * Reads a `default.project.json` (or other Rojo project file), parses the tree,
 * walks `$path` directories, and builds a bidirectional map between
 * Studio dot-paths and local files. Detects roblox-ts projects so the AI
 * doesn't write to compiled output.
 *
 * Also wraps `rojo serve` lifecycle.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export type ScriptClass = "Script" | "LocalScript" | "ModuleScript";

export type RojoBinding = {
  studioPath: string;     // e.g. "game.ServerScriptService.MyScript"
  localFile: string;      // absolute path to the .lua/.luau file
  className: ScriptClass;
};

export type RojoProject = {
  projectPath: string;          // abs path to default.project.json
  projectDir: string;           // dir containing it
  name: string;
  isRobloxTs: boolean;          // true if tsconfig + rbxts deps detected
  tsSourceDir?: string;         // typically "src" — where source TS lives
  tsOutputDir?: string;         // typically "out" — Rojo-mapped compiled output
  bindings: RojoBinding[];      // every script mapping
  byStudioPath: Map<string, RojoBinding>;
  byLocalFile: Map<string, RojoBinding>;
  rawTree: unknown;
};

const SCRIPT_SUFFIXES: Array<{ ext: string; className: ScriptClass; isInit: boolean }> = [
  { ext: ".server.luau", className: "Script", isInit: false },
  { ext: ".server.lua", className: "Script", isInit: false },
  { ext: ".client.luau", className: "LocalScript", isInit: false },
  { ext: ".client.lua", className: "LocalScript", isInit: false },
  { ext: ".luau", className: "ModuleScript", isInit: false },
  { ext: ".lua", className: "ModuleScript", isInit: false },
];

const INIT_PATTERNS: Array<{ name: string; className: ScriptClass }> = [
  { name: "init.server.luau", className: "Script" },
  { name: "init.server.lua",  className: "Script" },
  { name: "init.client.luau", className: "LocalScript" },
  { name: "init.client.lua",  className: "LocalScript" },
  { name: "init.luau",        className: "ModuleScript" },
  { name: "init.lua",         className: "ModuleScript" },
];

function classifyScript(filename: string): { className: ScriptClass; baseName: string } | null {
  for (const { ext, className } of SCRIPT_SUFFIXES) {
    if (filename.endsWith(ext)) {
      return { className, baseName: filename.slice(0, -ext.length) };
    }
  }
  return null;
}

function findInitScript(dir: string): { className: ScriptClass; file: string } | null {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir);
  for (const { name, className } of INIT_PATTERNS) {
    if (entries.includes(name)) return { className, file: path.join(dir, name) };
  }
  return null;
}

/**
 * Walk a Rojo $path directory and emit bindings under a given Studio dot-path.
 *
 * If the directory has an `init.lua`/`init.server.lua`/etc., the directory ITSELF
 * becomes that script (Rojo's standard "init" convention). Otherwise it's a Folder
 * with named children.
 */
function walkPathDir(localDir: string, studioPath: string, bindings: RojoBinding[]): void {
  if (!fs.existsSync(localDir) || !fs.statSync(localDir).isDirectory()) return;

  // init.* turns the directory itself into a script
  const init = findInitScript(localDir);
  if (init) {
    bindings.push({
      studioPath,
      localFile: init.file,
      className: init.className,
    });
  }

  for (const entry of fs.readdirSync(localDir, { withFileTypes: true })) {
    const full = path.join(localDir, entry.name);
    if (entry.isDirectory()) {
      walkPathDir(full, `${studioPath}.${entry.name}`, bindings);
    } else if (entry.isFile()) {
      // skip init.* files (handled above)
      if (entry.name.startsWith("init.")) continue;
      // skip metadata
      if (entry.name.endsWith(".meta.json") || entry.name.endsWith(".project.json")) continue;
      const classified = classifyScript(entry.name);
      if (!classified) continue;
      bindings.push({
        studioPath: `${studioPath}.${classified.baseName}`,
        localFile: full,
        className: classified.className,
      });
    }
  }
}

/**
 * Recursively walk the project.json `tree` and emit bindings.
 * Each node may have `$path`, `$className`, child names. We emit nothing for
 * `$className` nodes without children/$path (they're virtual Folders/Instances).
 */
function walkTree(node: unknown, studioPath: string, projectDir: string, bindings: RojoBinding[]): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  // Direct $path mapping
  const pathProp = obj.$path;
  if (typeof pathProp === "string") {
    const abs = path.isAbsolute(pathProp) ? pathProp : path.resolve(projectDir, pathProp);
    if (fs.existsSync(abs)) {
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        walkPathDir(abs, studioPath, bindings);
      } else if (stat.isFile()) {
        const classified = classifyScript(path.basename(abs));
        if (classified) {
          bindings.push({
            studioPath,
            localFile: abs,
            className: classified.className,
          });
        }
      }
    }
  }

  // Recurse into children (any key not starting with $)
  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith("$")) continue;
    walkTree(val, `${studioPath}.${key}`, projectDir, bindings);
  }
}

export function findProjectFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, "default.project.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function loadProject(projectPath: string): RojoProject {
  const abs = path.resolve(projectPath);
  if (!fs.existsSync(abs)) throw new Error(`Project file not found: ${abs}`);
  const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as { name?: string; tree?: unknown };
  const projectDir = path.dirname(abs);
  const tree = raw.tree ?? {};

  const bindings: RojoBinding[] = [];
  // The top-level tree node maps to "game" (the DataModel)
  walkTree(tree, "game", projectDir, bindings);

  const byStudioPath = new Map<string, RojoBinding>();
  const byLocalFile = new Map<string, RojoBinding>();
  for (const b of bindings) {
    byStudioPath.set(b.studioPath, b);
    byLocalFile.set(b.localFile.toLowerCase(), b); // case-insensitive on Windows
  }

  // roblox-ts detection
  const tsconfig = path.join(projectDir, "tsconfig.json");
  const pkgJson = path.join(projectDir, "package.json");
  let isRobloxTs = false;
  let tsSourceDir: string | undefined;
  let tsOutputDir: string | undefined;
  if (fs.existsSync(tsconfig) && fs.existsSync(pkgJson)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      isRobloxTs =
        Object.keys(allDeps).some((d) => d.startsWith("@rbxts/") || d === "roblox-ts") ||
        Object.keys(allDeps).some((d) => d.startsWith("@flamework/"));

      if (isRobloxTs) {
        // Try common conventions
        const tsRaw = JSON.parse(fs.readFileSync(tsconfig, "utf8")) as {
          compilerOptions?: { rootDir?: string; outDir?: string };
        };
        tsSourceDir = tsRaw.compilerOptions?.rootDir
          ? path.resolve(projectDir, tsRaw.compilerOptions.rootDir)
          : path.join(projectDir, "src");
        tsOutputDir = tsRaw.compilerOptions?.outDir
          ? path.resolve(projectDir, tsRaw.compilerOptions.outDir)
          : path.join(projectDir, "out");
      }
    } catch {
      /* tsconfig might have comments; skip */
    }
  }

  return {
    projectPath: abs,
    projectDir,
    name: raw.name ?? path.basename(projectDir),
    isRobloxTs,
    tsSourceDir,
    tsOutputDir,
    bindings,
    byStudioPath,
    byLocalFile,
    rawTree: tree,
  };
}

// ─── In-memory current project ───────────────────────────────────────────────

let CURRENT: RojoProject | null = null;

export function getCurrentProject(): RojoProject | null {
  return CURRENT;
}

export function setCurrentProject(project: RojoProject | null): void {
  CURRENT = project;
}

export function resolveStudioPathToFile(studioPath: string): RojoBinding | null {
  if (!CURRENT) return null;
  return CURRENT.byStudioPath.get(studioPath) ?? null;
}

export function resolveLocalFileToStudio(localPath: string): RojoBinding | null {
  if (!CURRENT) return null;
  return CURRENT.byLocalFile.get(path.resolve(localPath).toLowerCase()) ?? null;
}

/**
 * For a Studio path that's mapped from compiled-TypeScript output (out/...),
 * try to find the corresponding TypeScript source file.
 *
 * `out/server/foo/bar.lua` → `src/server/foo/bar.ts`
 */
export function maybeFindTsSourceForBinding(binding: RojoBinding): string | null {
  if (!CURRENT || !CURRENT.isRobloxTs || !CURRENT.tsOutputDir || !CURRENT.tsSourceDir) return null;
  const outDir = CURRENT.tsOutputDir;
  if (!binding.localFile.toLowerCase().startsWith(outDir.toLowerCase())) return null;
  const rel = path.relative(outDir, binding.localFile);
  // strip .lua/.luau extension and any rbxts suffixes
  const noExt = rel.replace(/\.(luau|lua)$/i, "");
  // Try .ts, .tsx in source dir
  for (const ext of [".ts", ".tsx"]) {
    const candidate = path.join(CURRENT.tsSourceDir, noExt + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  // Also try as folder with index.ts
  for (const ext of [".ts", ".tsx"]) {
    const candidate = path.join(CURRENT.tsSourceDir, noExt, "index" + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ─── rojo serve lifecycle ────────────────────────────────────────────────────

let SERVE_PROC: ChildProcess | null = null;
let SERVE_INFO: { projectPath: string; port: number; pid: number; startedAt: number } | null = null;

const ROJO_BIN = path.join(process.env.USERPROFILE ?? "", ".aftman", "bin", "rojo.exe");

function rojoBin(): string {
  // Prefer Aftman-managed binary; fall back to PATH
  if (fs.existsSync(ROJO_BIN)) return ROJO_BIN;
  return "rojo";
}

export async function serveStart(projectPath?: string, port?: number): Promise<{ pid: number; port: number; projectPath: string }> {
  if (SERVE_PROC && !SERVE_PROC.killed) {
    throw new Error(`rojo serve already running (pid ${SERVE_PROC.pid}, port ${SERVE_INFO?.port})`);
  }
  const finalProject = projectPath ?? CURRENT?.projectPath ?? findProjectFile(process.cwd());
  if (!finalProject) throw new Error("No project path provided and no default.project.json found");
  const finalPort = port ?? 34872;

  const args = ["serve", finalProject, "--port", String(finalPort)];
  const proc = spawn(rojoBin(), args, { detached: false, stdio: ["ignore", "pipe", "pipe"] });
  proc.on("exit", () => {
    SERVE_PROC = null;
    SERVE_INFO = null;
  });

  // give it a tick to bind
  await new Promise((r) => setTimeout(r, 400));
  if (proc.exitCode !== null) {
    throw new Error(`rojo serve exited immediately with code ${proc.exitCode}`);
  }

  SERVE_PROC = proc;
  SERVE_INFO = { projectPath: finalProject, port: finalPort, pid: proc.pid ?? -1, startedAt: Date.now() };
  return { pid: proc.pid ?? -1, port: finalPort, projectPath: finalProject };
}

export async function serveStop(): Promise<{ wasRunning: boolean }> {
  if (!SERVE_PROC) return { wasRunning: false };
  try {
    SERVE_PROC.kill();
  } catch {}
  SERVE_PROC = null;
  SERVE_INFO = null;
  return { wasRunning: true };
}

export function serveStatus(): { running: boolean; info?: typeof SERVE_INFO; binary: string } {
  return {
    running: SERVE_PROC !== null && !SERVE_PROC.killed,
    info: SERVE_INFO ?? undefined,
    binary: rojoBin(),
  };
}
