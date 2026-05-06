export type Command = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  createdAt: number;
};

export type CommandResult = {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  durationMs: number;
};

export type PluginStatus = {
  connected: boolean;
  lastPollAt: number;
  pluginVersion?: string;
  studioPlace?: string;
  readOnlyMode: boolean;
  fileSyncActive: boolean;
  fileSyncDir?: string;
  fileSyncRoot?: string;
  outputBufferSize: number;
};

export type OutputMessage = {
  ts: number;          // unix ms
  level: "info" | "warn" | "error";
  text: string;
  source?: string;     // origin (Output, Script, etc)
};

export type FileSyncConfig = {
  localDir: string;
  scriptRootPath: string;   // e.g. "game.ServerScriptService"
  classMap?: Record<string, "Script" | "LocalScript" | "ModuleScript">;  // by extension
  ignore?: string[];        // glob patterns
};
