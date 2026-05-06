/**
 * Open Cloud Asset upload — POST /assets/v1/assets, then poll the operation
 * until done. Supports Decal (image), Audio, and Model.
 *
 * Auth: API key via x-api-key header. Permissions on the key must include
 *   - asset:read
 *   - asset:write
 * IP allowlist must include the user's IP (or 0.0.0.0/0 for any).
 *
 * Docs: https://create.roblox.com/docs/cloud/reference/Asset
 */
import fs from "node:fs/promises";
import path from "node:path";
import { requireApiKey, getCreator } from "./auth.js";

const ASSETS_URL = "https://apis.roblox.com/assets/v1/assets";
const OPERATION_URL = (id: string) => `https://apis.roblox.com/assets/v1/${id}`;

export type UploadAssetType = "Decal" | "Audio" | "Model" | "Shirt" | "Pants" | "TShirt";

export type UploadResult = {
  ok: boolean;
  assetId?: string;
  operationId?: string;
  attempts: number;
  durationMs: number;
  rbxAssetId?: string; // "rbxassetid://..."
  error?: string;
};

const MIME_BY_EXT: Record<string, string> = {
  ".png":   "image/png",
  ".jpg":   "image/jpeg",
  ".jpeg":  "image/jpeg",
  ".bmp":   "image/bmp",
  ".tga":   "image/tga",
  ".mp3":   "audio/mpeg",
  ".ogg":   "audio/ogg",
  ".wav":   "audio/wav",
  ".fbx":   "model/fbx",            // Open Cloud rejects octet-stream for Model uploads
  ".obj":   "model/obj",
  ".rbxm":  "application/octet-stream",
  ".rbxmx": "application/xml",
};

function mimeFor(filePath: string, assetType: UploadAssetType): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? (assetType === "Audio" ? "audio/mpeg" : "image/png");
}

function buildCreator(): { userId?: string; groupId?: string } {
  const { userId, groupId } = getCreator();
  if (groupId) return { groupId };
  if (userId) return { userId };
  return {};
}

export async function uploadAsset(opts: {
  filePath: string;
  assetType: UploadAssetType;
  displayName: string;
  description?: string;
  pollTimeoutMs?: number;
}): Promise<UploadResult> {
  const apiKey = requireApiKey();
  const creator = buildCreator();
  if (!creator.userId && !creator.groupId) {
    throw new Error(
      "No creator configured. Set creatorUserId (your Roblox user id) or creatorGroupId in the Supertool widget. Find your user id at https://www.roblox.com/users/<name>/profile (the number in the URL).",
    );
  }

  const fileBuf = await fs.readFile(opts.filePath);
  const filename = path.basename(opts.filePath);
  const mime = mimeFor(opts.filePath, opts.assetType);

  const meta = {
    assetType: opts.assetType,
    displayName: opts.displayName,
    description: opts.description ?? "",
    creationContext: { creator },
  };

  // Build multipart manually — Node's fetch supports FormData with Blob
  const form = new FormData();
  form.append("request", JSON.stringify(meta));
  form.append("fileContent", new Blob([fileBuf], { type: mime }), filename);

  const startedAt = Date.now();
  const createRes = await fetch(ASSETS_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey },
    body: form,
  });
  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "");
    return {
      ok: false,
      attempts: 1,
      durationMs: Date.now() - startedAt,
      error: `Open Cloud upload failed (HTTP ${createRes.status}): ${body.slice(0, 400)}`,
    };
  }

  const opJson = (await createRes.json()) as { path?: string; operationId?: string; done?: boolean; response?: { assetId?: string } };
  const opPath = opJson.path ?? opJson.operationId;
  if (!opPath) {
    return {
      ok: false,
      attempts: 1,
      durationMs: Date.now() - startedAt,
      error: `Unexpected upload response: ${JSON.stringify(opJson).slice(0, 400)}`,
    };
  }

  // Poll the operation
  const timeout = opts.pollTimeoutMs ?? 30_000;
  const deadline = Date.now() + timeout;
  let attempts = 1;
  let backoff = 500;
  while (Date.now() < deadline) {
    attempts++;
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 1.4, 3000);

    const pollRes = await fetch(OPERATION_URL(opPath), {
      method: "GET",
      headers: { "x-api-key": apiKey },
    });
    if (!pollRes.ok) continue;
    const pollJson = (await pollRes.json()) as {
      done?: boolean;
      response?: { assetId?: string };
      error?: { code?: string; message?: string; details?: unknown };
      metadata?: unknown;
    };
    if (pollJson.done) {
      if (pollJson.error) {
        const e = pollJson.error;
        const detail = e.details ? `; details=${JSON.stringify(e.details).slice(0, 300)}` : "";
        const meta = pollJson.metadata ? `; metadata=${JSON.stringify(pollJson.metadata).slice(0, 200)}` : "";
        return {
          ok: false,
          attempts,
          durationMs: Date.now() - startedAt,
          operationId: opPath,
          error: `Operation failed (code=${e.code ?? "?"}, message=${e.message ?? "?"})${detail}${meta}`,
        };
      }
      const assetId = pollJson.response?.assetId;
      if (assetId) {
        return {
          ok: true,
          assetId: String(assetId),
          rbxAssetId: `rbxassetid://${assetId}`,
          operationId: opPath,
          attempts,
          durationMs: Date.now() - startedAt,
        };
      }
    }
  }

  return {
    ok: false,
    attempts,
    durationMs: Date.now() - startedAt,
    operationId: opPath,
    error: `Upload polling timed out after ${timeout}ms (operation ${opPath} may still complete; check Creator Hub > Inventory)`,
  };
}
