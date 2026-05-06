import http from "node:http";
import {
  takePending,
  deliverResult,
  setPluginInfo,
  getStatus,
  setReadOnly,
  pushOutput,
} from "./queue.js";
import { setApiKey, setCreator, setFreesoundKey, setCraftpixCookie, getApiKeyStatus } from "./auth.js";

export const HTTP_PORT = Number(process.env.SUPERTOOL_PORT ?? 7977);
export const AUTH_TOKEN = process.env.SUPERTOOL_TOKEN ?? "";

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(json),
    "access-control-allow-origin": "*",
  });
  res.end(json);
}

function authOk(req: http.IncomingMessage): boolean {
  if (!AUTH_TOKEN) return true; // no token configured = open (localhost only anyway)
  const header = req.headers["authorization"] ?? "";
  const provided = typeof header === "string" ? header.replace(/^Bearer\s+/i, "") : "";
  return provided === AUTH_TOKEN;
}

export function startHttpBridge(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${HTTP_PORT}`);

    try {
      // ─── Auth gate (status + readonly toggle are open for widget convenience) ──
      const openPaths = new Set(["/status"]);
      if (!openPaths.has(url.pathname) && !authOk(req)) {
        return send(res, 401, { error: "unauthorized — set Authorization: Bearer <SUPERTOOL_TOKEN>" });
      }

      // Plugin polls this — returns pending commands
      if (req.method === "POST" && url.pathname === "/poll") {
        const body = (await readJson(req)) as {
          pluginVersion?: string;
          studioPlace?: string;
          apiKey?: string | null;
          creatorUserId?: string;
          creatorGroupId?: string;
          freesoundApiKey?: string | null;
          craftpixCookie?: string | null;
        };
        if (body?.pluginVersion) setPluginInfo({ pluginVersion: body.pluginVersion });
        if (body?.studioPlace) setPluginInfo({ studioPlace: body.studioPlace });
        // Receive secrets from plugin (sent every poll so we repopulate after server restart)
        if ("apiKey" in body) setApiKey(body.apiKey);
        if ("freesoundApiKey" in body) setFreesoundKey(body.freesoundApiKey);
        if ("craftpixCookie" in body) setCraftpixCookie(body.craftpixCookie);
        if (body.creatorUserId !== undefined || body.creatorGroupId !== undefined) {
          setCreator(body.creatorUserId, body.creatorGroupId);
        }
        const commands = takePending();
        return send(res, 200, { commands });
      }

      // API key status check (open — returns only lastFour, never the key)
      if (req.method === "GET" && url.pathname === "/apikey") {
        return send(res, 200, getApiKeyStatus());
      }

      // Plugin sends results back
      if (req.method === "POST" && url.pathname === "/result") {
        const body = (await readJson(req)) as {
          id: string;
          ok: boolean;
          data?: unknown;
          error?: string;
          durationMs?: number;
        };
        if (!body?.id) return send(res, 400, { error: "missing id" });
        deliverResult({
          id: body.id,
          ok: !!body.ok,
          data: body.data,
          error: body.error,
          durationMs: body.durationMs ?? 0,
        });
        return send(res, 200, { ok: true });
      }

      // Plugin pushes output panel messages
      if (req.method === "POST" && url.pathname === "/output") {
        const body = (await readJson(req)) as {
          messages?: Array<{ ts: number; level: "info" | "warn" | "error"; text: string; source?: string }>;
        };
        if (body?.messages?.length) pushOutput(body.messages);
        return send(res, 200, { ok: true });
      }

      // Status check
      if (req.method === "GET" && url.pathname === "/status") {
        return send(res, 200, getStatus());
      }

      // Toggle read-only mode
      if (req.method === "POST" && url.pathname === "/readonly") {
        const body = (await readJson(req)) as { value?: boolean };
        setReadOnly(!!body?.value);
        return send(res, 200, getStatus());
      }

      send(res, 404, { error: "not found", path: url.pathname });
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(HTTP_PORT, "127.0.0.1", () => {
    process.stderr.write(
      `[supertool] http bridge on http://127.0.0.1:${HTTP_PORT}${AUTH_TOKEN ? " (auth required)" : ""}\n`,
    );
  });

  return server;
}
