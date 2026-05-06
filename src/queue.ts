import { randomUUID } from "node:crypto";
import type { Command, CommandResult, PluginStatus, OutputMessage } from "./types.js";

const PENDING: Command[] = [];
const RESULTS = new Map<string, CommandResult>();
const WAITERS = new Map<string, (r: CommandResult) => void>();
const OUTPUT_BUFFER: OutputMessage[] = [];

const STATUS: PluginStatus = {
  connected: false,
  lastPollAt: 0,
  readOnlyMode: false,
  fileSyncActive: false,
  outputBufferSize: 0,
};

const COMMAND_TIMEOUT_MS = 30_000;
const STALE_PLUGIN_MS = 5_000;
const MAX_OUTPUT_BUFFER = 2000;

export class ReadOnlyError extends Error {
  constructor(tool: string) {
    super(
      `Tool '${tool}' is mutating but read-only mode is enabled. Disable read-only mode in the Studio plugin widget or via POST /readonly to use mutating tools.`,
    );
    this.name = "ReadOnlyError";
  }
}

export function enqueue(tool: string, args: Record<string, unknown>): Promise<CommandResult> {
  const cmd: Command = { id: randomUUID(), tool, args, createdAt: Date.now() };
  PENDING.push(cmd);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      WAITERS.delete(cmd.id);
      resolve({
        id: cmd.id,
        ok: false,
        error: `Plugin did not respond within ${COMMAND_TIMEOUT_MS / 1000}s. Is Studio running with the supertool plugin loaded?`,
        durationMs: Date.now() - cmd.createdAt,
      });
    }, COMMAND_TIMEOUT_MS);

    WAITERS.set(cmd.id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

export function takePending(max = 16): Command[] {
  STATUS.connected = true;
  STATUS.lastPollAt = Date.now();
  return PENDING.splice(0, max);
}

export function deliverResult(result: CommandResult): void {
  RESULTS.set(result.id, result);
  const waiter = WAITERS.get(result.id);
  if (waiter) {
    WAITERS.delete(result.id);
    waiter(result);
  }
}

export function setPluginInfo(info: Partial<PluginStatus>): void {
  Object.assign(STATUS, info, { lastPollAt: Date.now(), connected: true });
}

export function getStatus(): PluginStatus {
  if (Date.now() - STATUS.lastPollAt > STALE_PLUGIN_MS) {
    STATUS.connected = false;
  }
  STATUS.outputBufferSize = OUTPUT_BUFFER.length;
  return { ...STATUS };
}

export function setReadOnly(value: boolean): void {
  STATUS.readOnlyMode = value;
}

export function isReadOnly(): boolean {
  return STATUS.readOnlyMode;
}

export function setFileSyncStatus(active: boolean, localDir?: string, scriptRoot?: string): void {
  STATUS.fileSyncActive = active;
  STATUS.fileSyncDir = active ? localDir : undefined;
  STATUS.fileSyncRoot = active ? scriptRoot : undefined;
}

// ─── Output buffer (pushed by plugin via /output, drained by tail_output) ──

export function pushOutput(messages: OutputMessage[]): void {
  for (const m of messages) {
    OUTPUT_BUFFER.push(m);
  }
  while (OUTPUT_BUFFER.length > MAX_OUTPUT_BUFFER) OUTPUT_BUFFER.shift();
}

export function tailOutput(lines: number, sinceTs?: number): OutputMessage[] {
  if (sinceTs !== undefined) {
    return OUTPUT_BUFFER.filter((m) => m.ts > sinceTs);
  }
  return OUTPUT_BUFFER.slice(Math.max(0, OUTPUT_BUFFER.length - lines));
}

export function clearOutput(): void {
  OUTPUT_BUFFER.length = 0;
}
