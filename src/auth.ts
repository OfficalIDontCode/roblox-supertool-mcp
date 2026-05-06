/**
 * In-memory storage for the user's secrets (Roblox Open Cloud key, Freesound
 * key, creator IDs).
 *
 * Security model:
 *   - Plugin persists each key via plugin:SetSetting (per-plugin, per-user,
 *     stored by Studio in the user's local plugin settings).
 *   - Plugin sends them all on every /poll call so the server (memory-only)
 *     repopulates after a restart. Empty string clears server-side.
 *   - Server holds keys ONLY in memory — never written to disk, never logged,
 *     never returned by status endpoints (only `isConfigured` + last-four).
 *   - Tool errors never echo a key back.
 *
 * If you uninstall the plugin (or clear Studio plugin settings), the keys
 * are gone for good — there's no other persistence layer.
 */

let API_KEY: string | null = null;
let CREATOR_USER_ID: string | null = null;
let CREATOR_GROUP_ID: string | null = null;
let FREESOUND_KEY: string | null = null;
let CRAFTPIX_COOKIE: string | null = null;

export function setApiKey(key: string | null | undefined): void {
  if (!key || key.trim().length === 0) {
    API_KEY = null;
    return;
  }
  API_KEY = key.trim();
}

export function getApiKey(): string | null {
  return API_KEY;
}

export function requireApiKey(): string {
  if (!API_KEY) {
    throw new Error(
      "No Open Cloud API key configured. Open the Supertool widget in Studio, paste your key into the API Key field, and click Save. Get a key from https://create.roblox.com/dashboard/credentials with asset:read + asset:write permissions and IP allowlist 0.0.0.0/0.",
    );
  }
  return API_KEY;
}

export function setCreator(userId?: string | null, groupId?: string | null): void {
  CREATOR_USER_ID = userId ? String(userId) : null;
  CREATOR_GROUP_ID = groupId ? String(groupId) : null;
}

export function getCreator(): { userId: string | null; groupId: string | null } {
  return { userId: CREATOR_USER_ID, groupId: CREATOR_GROUP_ID };
}

// ── Freesound API key ──────────────────────────────────────────────────────

export function setFreesoundKey(key: string | null | undefined): void {
  if (!key || key.trim().length === 0) {
    FREESOUND_KEY = null;
    return;
  }
  FREESOUND_KEY = key.trim();
}

export function getFreesoundKey(): string | null {
  return FREESOUND_KEY;
}

export function requireFreesoundKey(): string {
  if (!FREESOUND_KEY) {
    throw new Error(
      "No Freesound API key configured. Open the Supertool widget in Studio, paste your key into the Freesound API Key field, and click Save. Get a free key at https://freesound.org/apiv2/apply.",
    );
  }
  return FREESOUND_KEY;
}

// ── CraftPix session cookie ────────────────────────────────────────────────
//
// CraftPix freebies require a logged-in WordPress session to download the
// zip. The user pastes their `wordpress_logged_in_*` cookie value (or the
// full `Cookie:` header if they want to be safe) into the plugin widget; we
// pass it through verbatim on every craftpix download request. Never logged
// or returned by the status endpoint.

export function setCraftpixCookie(cookie: string | null | undefined): void {
  if (!cookie || cookie.trim().length === 0) {
    CRAFTPIX_COOKIE = null;
    return;
  }
  CRAFTPIX_COOKIE = cookie.trim();
}

export function getCraftpixCookie(): string | null {
  return CRAFTPIX_COOKIE;
}

type KeyStatus = { isConfigured: boolean; lastFour?: string };

function statusFor(key: string | null): KeyStatus {
  if (!key) return { isConfigured: false };
  return {
    isConfigured: true,
    lastFour: key.length >= 4 ? key.slice(-4) : "****",
  };
}

/** Public-safe representation for /status and the widget. Never reveals the key itself. */
export function getApiKeyStatus(): {
  isConfigured: boolean;
  lastFour?: string;
  creatorUserId?: string;
  creatorGroupId?: string;
  freesound: KeyStatus;
  craftpix: KeyStatus;
} {
  const oc = statusFor(API_KEY);
  return {
    isConfigured: oc.isConfigured,
    lastFour: oc.lastFour,
    creatorUserId: CREATOR_USER_ID ?? undefined,
    creatorGroupId: CREATOR_GROUP_ID ?? undefined,
    freesound: statusFor(FREESOUND_KEY),
    craftpix: statusFor(CRAFTPIX_COOKIE),
  };
}

export function getFreesoundKeyStatus(): KeyStatus {
  return statusFor(FREESOUND_KEY);
}

export function getCraftpixCookieStatus(): KeyStatus {
  return statusFor(CRAFTPIX_COOKIE);
}
