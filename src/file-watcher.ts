import fs from "node:fs";
import path from "node:path";
import { enqueue, setFileSyncStatus } from "./queue.js";

type SyncState = {
  watcher: fs.FSWatcher;
  localDir: string;
  scriptRoot: string;
  classMap: Record<string, "Script" | "LocalScript" | "ModuleScript">;
  ignore: RegExp[];
  fileToPath: Map<string, string>; // localFile -> Studio path
  debounceTimers: Map<string, NodeJS.Timeout>;
};

let CURRENT: SyncState | null = null;

const DEFAULT_CLASS_MAP: Record<string, "Script" | "LocalScript" | "ModuleScript"> = {
  ".lua": "Script",
  ".server.lua": "Script",
  ".client.lua": "LocalScript",
  ".module.lua": "ModuleScript",
  ".luau": "ModuleScript",
};

function classifyFile(filename: string, classMap: Record<string, "Script" | "LocalScript" | "ModuleScript">): { className: "Script" | "LocalScript" | "ModuleScript"; baseName: string } | null {
  // Match longer suffixes first
  const suffixes = Object.keys(classMap).sort((a, b) => b.length - a.length);
  for (const suf of suffixes) {
    if (filename.endsWith(suf)) {
      return {
        className: classMap[suf]!,
        baseName: filename.slice(0, -suf.length),
      };
    }
  }
  return null;
}

function fileToScriptPath(localFile: string, localDir: string, scriptRoot: string, classMap: Record<string, "Script" | "LocalScript" | "ModuleScript">): { path: string; className: "Script" | "LocalScript" | "ModuleScript" } | null {
  const rel = path.relative(localDir, localFile);
  if (rel.startsWith("..")) return null;

  const dirParts = rel.split(path.sep);
  const filename = dirParts.pop()!;
  const classified = classifyFile(filename, classMap);
  if (!classified) return null;

  const segments = [scriptRoot, ...dirParts, classified.baseName].filter(Boolean);
  return {
    path: segments.join("."),
    className: classified.className,
  };
}

export async function startFileSync(opts: {
  localDir: string;
  scriptRoot: string;
  classMap?: Record<string, "Script" | "LocalScript" | "ModuleScript">;
  ignore?: string[];
}): Promise<{ watching: string; root: string; initialPushed: number }> {
  if (CURRENT) await stopFileSync();

  if (!fs.existsSync(opts.localDir)) {
    throw new Error(`Local directory does not exist: ${opts.localDir}`);
  }

  const classMap = opts.classMap ?? DEFAULT_CLASS_MAP;
  const ignore = (opts.ignore ?? []).map((g) => new RegExp(g.replace(/\*/g, ".*")));

  const fileToPath = new Map<string, string>();
  const debounceTimers = new Map<string, NodeJS.Timeout>();

  const isIgnored = (p: string): boolean => ignore.some((re) => re.test(p));

  const pushFile = (localFile: string): void => {
    if (isIgnored(localFile)) return;
    const mapped = fileToScriptPath(localFile, opts.localDir, opts.scriptRoot, classMap);
    if (!mapped) return;
    let source = "";
    try {
      source = fs.readFileSync(localFile, "utf8");
    } catch {
      return;
    }
    fileToPath.set(localFile, mapped.path);
    enqueue("set_script_source", {
      path: mapped.path,
      source,
      createIfMissing: true,
      className: mapped.className,
    }).catch(() => { /* swallowed; UI will show errors */ });
  };

  // Initial sync — push every file
  let initialPushed = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        pushFile(full);
        initialPushed++;
      }
    }
  };
  walk(opts.localDir);

  const watcher = fs.watch(opts.localDir, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    const full = path.join(opts.localDir, filename.toString());
    // Debounce per file (editors save in bursts)
    const existing = debounceTimers.get(full);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      full,
      setTimeout(() => {
        debounceTimers.delete(full);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) pushFile(full);
      }, 150),
    );
  });

  CURRENT = {
    watcher,
    localDir: opts.localDir,
    scriptRoot: opts.scriptRoot,
    classMap,
    ignore,
    fileToPath,
    debounceTimers,
  };
  setFileSyncStatus(true, opts.localDir, opts.scriptRoot);
  return { watching: opts.localDir, root: opts.scriptRoot, initialPushed };
}

export async function stopFileSync(): Promise<{ wasActive: boolean }> {
  if (!CURRENT) return { wasActive: false };
  CURRENT.watcher.close();
  for (const t of CURRENT.debounceTimers.values()) clearTimeout(t);
  CURRENT = null;
  setFileSyncStatus(false);
  return { wasActive: true };
}

export function getFileSyncState(): { active: boolean; localDir?: string; scriptRoot?: string; trackedFiles?: number } {
  if (!CURRENT) return { active: false };
  return {
    active: true,
    localDir: CURRENT.localDir,
    scriptRoot: CURRENT.scriptRoot,
    trackedFiles: CURRENT.fileToPath.size,
  };
}
