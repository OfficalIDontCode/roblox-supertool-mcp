import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { enqueue, isReadOnly, ReadOnlyError, tailOutput, clearOutput } from "../queue.js";
import { startFileSync, stopFileSync, getFileSyncState } from "../file-watcher.js";
import {
  loadProject,
  findProjectFile,
  setCurrentProject,
  getCurrentProject,
  resolveStudioPathToFile,
  resolveLocalFileToStudio,
  maybeFindTsSourceForBinding,
  serveStart,
  serveStop,
  serveStatus,
  type RojoProject,
} from "../rojo.js";
import {
  search as scraperSearch,
  fetchDetails as scraperFetchDetails,
  fetchThumbnailBase64,
  fetchThumbnailsBatch,
  listPresets,
  runPreset,
  CATEGORY_IDS,
  SORT_TYPES,
  type Item as ScraperItem,
  type ThumbnailSize,
} from "../scraper.js";
import { uploadAsset } from "../uploader.js";
import { getApiKeyStatus } from "../auth.js";
import * as polyhaven from "../scrapers/polyhaven.js";
import * as kenney from "../scrapers/kenney.js";
import * as freesound from "../scrapers/freesound.js";
import * as gameicons from "../scrapers/gameicons.js";
import * as craftpix from "../scrapers/craftpix.js";
import { fetchBase64 } from "../scrapers/common.js";
import { captureStudioWindow, listStudioWindows } from "../screenshot.js";
import { promises as fsp } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Rich content envelope — when a tool wants to return text+images to the AI,
// it returns { __mcpContent: ContentBlock[] } instead of plain data.
// index.ts detects this shape and forwards as MCP tool result content.
// ─────────────────────────────────────────────────────────────────────────────

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type RichResult = { __mcpContent: ContentBlock[] };
export function isRichResult(x: unknown): x is RichResult {
  return !!x && typeof x === "object" && "__mcpContent" in (x as object);
}

function trimDescription(desc: string, n = 120): string {
  if (desc.length <= n) return desc;
  return desc.slice(0, n - 1) + "…";
}

function summarizeItem(it: ScraperItem, idx: number): string {
  const net = it.upVotes - it.downVotes;
  const verified = it.isVerifiedCreator ? "✓" : it.creatorType === "Roblox" ? "★" : " ";
  return [
    `${idx + 1}. [${it.id}] ${it.name}`,
    `   creator: ${it.creator} ${verified} (${it.creatorType})`,
    `   votes: ${net >= 0 ? "+" : ""}${net} (${it.upVotes}/${it.downVotes}, ${it.voteRatio.toFixed(0)}%)  free: ${it.isFree ? "yes" : "NO"}`,
    `   keyword: "${it.keyword}"  rbx: ${it.rbxAssetId}`,
    it.description ? `   ${trimDescription(it.description)}` : "",
  ].filter(Boolean).join("\n");
}

export type ToolDef = {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  /** If true, this tool mutates the place. Skipped in read-only mode. */
  mutates: boolean;
  /** Optional override: if set, runs locally instead of forwarding to plugin */
  local?: (args: Record<string, unknown>) => Promise<unknown> | unknown;
};

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────

export const TOOLS: ToolDef[] = [
  // ─── Workspace / Instance tree ───────────────────────────────────────────
  {
    name: "get_workspace_tree",
    description:
      "Return a JSON tree of the DataModel under a given path (default: 'game'). Includes ClassName, Name, child counts. Lazy by depth. Use cursor pagination for huge places.",
    mutates: false,
    schema: z.object({
      path: z.string().default("game").describe("Dot path, e.g. 'game.Workspace.Map'"),
      maxDepth: z.number().int().min(1).max(8).default(3),
      includeProperties: z.boolean().default(false),
      cursor: z.string().optional().describe("Pagination cursor returned from previous call"),
      maxNodes: z.number().int().min(10).max(5000).default(800),
    }),
  },
  {
    name: "get_instance",
    description:
      "Return a single Instance with all readable properties (and a list of children names + classes).",
    mutates: false,
    schema: z.object({ path: z.string().describe("Dot path to the Instance") }),
  },
  {
    name: "set_property",
    description: "Set a property on an Instance. Supports JSON-tagged Roblox values (Vector3, CFrame, Color3 etc).",
    mutates: true,
    schema: z.object({
      path: z.string(),
      property: z.string(),
      value: z.unknown(),
    }),
  },
  {
    name: "create_instance",
    description: "Instance.new(class, parent) with optional initial properties.",
    mutates: true,
    schema: z.object({
      className: z.string(),
      parentPath: z.string().default("game.Workspace"),
      name: z.string().optional(),
      properties: z.record(z.unknown()).default({}),
    }),
  },
  {
    name: "delete_instance",
    description: "Destroy() an Instance at the given path.",
    mutates: true,
    schema: z.object({ path: z.string() }),
  },

  // ─── Scripts ─────────────────────────────────────────────────────────────
  {
    name: "get_script_source",
    description: "Read the Source of a Script/LocalScript/ModuleScript.",
    mutates: false,
    schema: z.object({ path: z.string() }),
  },
  {
    name: "set_script_source",
    description:
      "Replace the Source of a script. Rojo-aware: if a Rojo project is loaded and the path is mapped from disk, this writes the FILE (Rojo will sync it back to Studio) — pass `direct: true` to bypass and write to Studio directly. For roblox-ts projects, refuses to write into compiled output (out/) and tells you the source .ts file instead.",
    mutates: true,
    schema: z.object({
      path: z.string(),
      source: z.string(),
      createIfMissing: z.boolean().default(false),
      className: z.enum(["Script", "LocalScript", "ModuleScript"]).default("Script"),
      direct: z.boolean().default(false).describe("Force direct Studio write, ignoring Rojo mapping"),
    }),
  },
  {
    name: "search_scripts",
    description: "Grep across all scripts in the place. Returns matching scripts with line numbers.",
    mutates: false,
    schema: z.object({
      pattern: z.string().describe("Lua pattern (or substring if literal=true)"),
      literal: z.boolean().default(true),
      caseSensitive: z.boolean().default(false),
      maxResults: z.number().int().min(1).max(500).default(100),
    }),
  },

  // ─── Run Luau ────────────────────────────────────────────────────────────
  {
    name: "run_luau",
    description:
      "Execute arbitrary Luau in Studio's Edit context. Returns return-value(s), printed output, and any error. The escape hatch — anything no typed tool covers, do here.",
    mutates: true,
    schema: z.object({
      code: z.string().describe("Luau source. Use `return X, Y` to get values back."),
      timeoutMs: z.number().int().min(100).max(20000).default(5000),
    }),
  },
  {
    name: "run_test",
    description:
      "Execute Luau with a built-in `expect(cond, msg)` assertion collector. Returns pass/fail counts and detailed failure messages. Use for ad-hoc unit testing.",
    mutates: true,
    schema: z.object({
      code: z.string(),
      timeoutMs: z.number().int().min(100).max(20000).default(5000),
    }),
  },
  {
    name: "profile_luau",
    description: "Run Luau N times, return mean/min/max execution time. For perf testing.",
    mutates: true,
    schema: z.object({
      code: z.string(),
      iterations: z.number().int().min(1).max(10000).default(100),
    }),
  },

  // ─── Output panel capture ────────────────────────────────────────────────
  {
    name: "tail_output",
    description:
      "Read recent messages from Studio's Output panel (print, warn, error). Captured continuously from LogService while plugin runs.",
    mutates: false,
    local: async (args) => {
      const lines = (args.lines as number) ?? 100;
      const sinceTs = args.sinceTs as number | undefined;
      return { messages: tailOutput(lines, sinceTs) };
    },
    schema: z.object({
      lines: z.number().int().min(1).max(2000).default(100),
      sinceTs: z.number().optional().describe("Unix ms — only return messages newer than this"),
    }),
  },
  {
    name: "clear_output_buffer",
    description: "Clear the captured Output buffer.",
    mutates: false,
    local: async () => { clearOutput(); return { ok: true }; },
    schema: z.object({}),
  },

  // ─── Assets ──────────────────────────────────────────────────────────────
  {
    name: "insert_asset",
    description: "Insert a free asset (model/mesh/decal) by Asset ID via InsertService:LoadAsset.",
    mutates: true,
    schema: z.object({
      assetId: z.number().int().positive(),
      parentPath: z.string().default("game.Workspace"),
    }),
  },

  // ─── Bulk / spatial ──────────────────────────────────────────────────────
  {
    name: "bulk_set_property",
    description:
      "Set the same property on every Instance matching a class/name filter under a root. Single undo waypoint. Returns count modified.",
    mutates: true,
    schema: z.object({
      rootPath: z.string().default("game.Workspace"),
      className: z.string().optional(),
      nameMatch: z.string().optional().describe("Lua pattern, optional"),
      property: z.string(),
      value: z.unknown(),
    }),
  },
  {
    name: "bulk_call",
    description:
      "Run many supertool calls in a single poll cycle (avoids per-call latency). Returns results in order.",
    mutates: true,
    schema: z.object({
      calls: z.array(z.object({
        tool: z.string(),
        args: z.record(z.unknown()).default({}),
      })),
    }),
  },
  {
    name: "find_in_radius",
    description:
      "Find all BaseParts whose Position is within `radius` studs of a center point. Returns paths + distances.",
    mutates: false,
    schema: z.object({
      center: z.array(z.number()).length(3),
      radius: z.number().positive(),
      classFilter: z.string().default("BasePart"),
      maxResults: z.number().int().min(1).max(1000).default(200),
    }),
  },

  // ─── Selection / camera / playtest ───────────────────────────────────────
  {
    name: "get_selection",
    description: "Return paths of currently selected Instances in Studio's Explorer.",
    mutates: false,
    schema: z.object({}),
  },
  {
    name: "set_selection",
    description: "Set Studio's Explorer selection to the given list of Instance paths.",
    mutates: false,
    schema: z.object({ paths: z.array(z.string()) }),
  },
  {
    name: "set_camera",
    description: "Set the Studio viewport camera CFrame (position + look-at).",
    mutates: false,
    schema: z.object({
      position: z.array(z.number()).length(3),
      lookAt: z.array(z.number()).length(3),
    }),
  },
  {
    name: "camera_get",
    description: "Read current viewport camera state: position, look vector, focus, FOV, camera type.",
    mutates: false,
    schema: z.object({}),
  },
  {
    name: "camera_focus_on",
    description: "Frame the viewport camera on a target instance (BasePart or Model). Computes a sensible distance from the bounding box.",
    mutates: false,
    schema: z.object({
      path: z.string(),
      distance: z.number().positive().optional(),
      angle: z.number().default(35).describe("Horizontal orbit angle in degrees"),
    }),
  },
  {
    name: "camera_orbit",
    description: "Orbit the camera around a center point (or instance) by an angle delta. Keeps current distance unless overridden.",
    mutates: false,
    schema: z.object({
      center: z.array(z.number()).length(3).optional(),
      path: z.string().optional(),
      angleDelta: z.number().default(30),
      distance: z.number().positive().optional(),
    }),
  },
  {
    name: "camera_zoom_selection",
    description: "Frame the camera on the current Studio selection (uses combined bounding box).",
    mutates: false,
    schema: z.object({
      distance: z.number().positive().optional(),
      angle: z.number().default(35),
    }),
  },
  {
    name: "camera_set_fov",
    description: "Set the viewport camera FieldOfView (1-120, default 70).",
    mutates: false,
    schema: z.object({ fov: z.number().min(1).max(120) }),
  },
  {
    name: "screenshot_studio",
    description:
      "Capture a PNG screenshot of the Roblox Studio window (entire window including viewport, panels, ribbon). Returns the saved file path AND inlines the image so the AI can see it. Requires Studio to be open and visible.",
    mutates: false,
    local: async (args): Promise<RichResult | { ok: false; error: string }> => {
      const result = await captureStudioWindow({
        outputPath: args.outputPath as string | undefined,
        windowTitleMatch: (args.windowTitleMatch as string | undefined) ?? "Roblox Studio",
      });
      if (!result.ok || !result.path) {
        return { ok: false, error: result.error ?? "Screenshot failed" };
      }
      const includeImage = (args.includeImage as boolean | undefined) ?? true;
      const blocks: ContentBlock[] = [
        {
          type: "text",
          text: `Captured ${result.width}x${result.height} from "${result.windowTitle}" → ${result.path}`,
        },
      ];
      if (includeImage) {
        try {
          const buf = await fsp.readFile(result.path);
          blocks.push({ type: "image", data: buf.toString("base64"), mimeType: "image/png" });
        } catch (err) {
          blocks.push({ type: "text", text: `(image read failed: ${(err as Error).message})` });
        }
      }
      return { __mcpContent: blocks };
    },
    schema: z.object({
      outputPath: z.string().optional().describe("Override save path (default: temp dir)"),
      windowTitleMatch: z.string().default("Roblox Studio"),
      includeImage: z.boolean().default(true).describe("Inline the PNG bytes in the tool result so the AI can see it"),
    }),
  },
  {
    name: "screenshot_list_windows",
    description: "List candidate Roblox Studio windows currently open (for picking a windowTitleMatch).",
    mutates: false,
    local: async () => await listStudioWindows(),
    schema: z.object({}),
  },

  // ─── Tween (animation playback) ──────────────────────────────────────────
  {
    name: "tween",
    description:
      "Tween properties of an Instance over time using TweenService. Returns when the tween starts (does not block). Property values support type-aware coercion: [r,g,b] for Color3, '#RRGGBB' hex strings for Color3, '[xs,xo,ys,yo]' arrays for UDim2, instance paths for Instance refs.",
    mutates: true,
    schema: z.object({
      path: z.string(),
      properties: z.record(z.unknown()).describe("Property → target value (type-coerced based on property type)"),
      duration: z.number().positive().default(1.0),
      easingStyle: z.enum([
        "Linear", "Sine", "Quad", "Cubic", "Quart", "Quint", "Bounce", "Elastic", "Back", "Exponential", "Circular",
      ]).default("Quad"),
      easingDirection: z.enum(["In", "Out", "InOut"]).default("Out"),
      repeatCount: z.number().int().min(0).default(0),
      reverses: z.boolean().default(false),
      delayTime: z.number().min(0).default(0),
    }),
  },
  {
    name: "tween_async",
    description:
      "Tween properties of an Instance and BLOCK until the tween's Completed event fires (or timeout). Returns the final PlaybackState ('Completed', 'Cancelled', etc.) plus a tween id usable with tween_cancel.",
    mutates: true,
    schema: z.object({
      path: z.string(),
      properties: z.record(z.unknown()),
      duration: z.number().positive().default(1.0),
      easingStyle: z.enum([
        "Linear", "Sine", "Quad", "Cubic", "Quart", "Quint", "Bounce", "Elastic", "Back", "Exponential", "Circular",
      ]).default("Quad"),
      easingDirection: z.enum(["In", "Out", "InOut"]).default("Out"),
      repeatCount: z.number().int().min(0).default(0),
      reverses: z.boolean().default(false),
      delayTime: z.number().min(0).default(0),
      timeoutS: z.number().positive().optional().describe("Bail out after N seconds. Defaults to duration*1.2 + 0.5"),
    }),
  },
  {
    name: "tween_cancel",
    description: "Cancel an in-flight tween started by tween_async, by id.",
    mutates: true,
    schema: z.object({ id: z.string() }),
  },

  // ─── Rigging & welding helpers ───────────────────────────────────────────
  {
    name: "weld_model",
    description:
      "Take a Model with one or more BaseParts, choose a handle (largest BasePart by volume, or named via handleName), set it as PrimaryPart, then WeldConstraint every other BasePart to it. Un-anchors all parts. Use after assembling a tool/prop from individual parts so it moves as one rigid body.",
    mutates: true,
    schema: z.object({
      path: z.string(),
      handleName: z.string().optional().describe("Name of a child BasePart to use as the handle. If omitted, the largest BasePart by volume is chosen."),
    }),
  },
  {
    name: "set_primary_part",
    description: "Set a Model's PrimaryPart by path. Both modelPath and partPath must resolve.",
    mutates: true,
    schema: z.object({
      modelPath: z.string(),
      partPath: z.string(),
    }),
  },
  {
    name: "create_constraint",
    description:
      "Factory for physics constraints. Auto-creates Attachment0/1 on the parts when the kind needs them (HingeConstraint, BallSocketConstraint, RopeConstraint, SpringConstraint, RodConstraint, AlignPosition, AlignOrientation, LinearVelocity, AngularVelocity). WeldConstraint and Motor6D use Part0/Part1 directly. Pass extra config via properties (e.g. {Length: 8, Restitution: 0.5} for a RopeConstraint).",
    mutates: true,
    schema: z.object({
      kind: z.enum([
        "WeldConstraint", "HingeConstraint", "BallSocketConstraint", "RopeConstraint",
        "SpringConstraint", "RodConstraint", "Motor6D",
        "AlignPosition", "AlignOrientation", "LinearVelocity", "AngularVelocity",
      ]),
      part0Path: z.string(),
      part1Path: z.string(),
      attachment0: z.string().optional(),
      attachment1: z.string().optional(),
      properties: z.record(z.unknown()).optional(),
      name: z.string().optional(),
    }),
  },

  // ─── GUI introspection ───────────────────────────────────────────────────
  {
    name: "gui_get_bounds",
    description:
      "Return post-layout AbsolutePosition and AbsoluteSize of a GuiObject, plus visibility, ZIndex, BackgroundTransparency, and Text/Image where applicable. Use to verify what's actually rendered after UI layout calculation.",
    mutates: false,
    schema: z.object({ path: z.string() }),
  },
  {
    name: "gui_read_state",
    description:
      "Recursively walk a ScreenGui (or any GuiObject root) and return every descendant GuiObject's bounds, visibility, and key properties. Use to map an entire UI surface — e.g. verify all tabs, buttons, and text in an inventory panel are positioned correctly.",
    mutates: false,
    schema: z.object({
      path: z.string(),
      maxNodes: z.number().int().positive().default(200),
    }),
  },
  {
    name: "gui_simulate_click",
    description:
      "Fire MouseButton1Click and Activated on a TextButton or ImageButton, simulating a click without manual interaction. Validates the button is effectively visible (visible AND has visible ancestor chain AND ScreenGui.Enabled), or pass force=true to override.",
    mutates: true,
    schema: z.object({
      path: z.string(),
      force: z.boolean().default(false),
    }),
  },

  // ─── Lighting & atmosphere ───────────────────────────────────────────────
  {
    name: "lighting_set_effect",
    description:
      "Create or update a Lighting effect (Bloom, Blur, ColorCorrection, DepthOfField, SunRays, Atmosphere, Sky). If an effect of the kind already exists under Lighting, updates it; otherwise creates one. Properties are coerced based on the effect's expected types.",
    mutates: true,
    schema: z.object({
      kind: z.enum([
        "Bloom", "BloomEffect",
        "Blur", "BlurEffect",
        "ColorCorrection", "ColorCorrectionEffect",
        "DepthOfField", "DepthOfFieldEffect",
        "SunRays", "SunRaysEffect",
        "Atmosphere",
        "Sky",
      ]),
      properties: z.record(z.unknown()).optional(),
      name: z.string().optional(),
    }),
  },
  {
    name: "lighting_set_props",
    description: "Bulk-set properties on the Lighting service (Brightness, Ambient, OutdoorAmbient, ClockTime, FogColor, FogStart, FogEnd, ShadowSoftness, etc.). Returns which properties were set.",
    mutates: true,
    schema: z.object({
      properties: z.record(z.unknown()),
    }),
  },
  {
    name: "lighting_clear_effects",
    description: "Remove all Lighting effects (Bloom, Blur, ColorCorrection, DepthOfField, SunRays, Atmosphere, Sky).",
    mutates: true,
    schema: z.object({}),
  },

  // ─── HumanoidDescription / Avatar ────────────────────────────────────────
  {
    name: "humanoid_description_build",
    description:
      "Build a HumanoidDescription server-side and parent it to ServerStorage.HDLibrary (or specified parentPath/HDLibrary). All fields are optional — pass any subset of clothing assetIds, body part ids, body colors, scale factors, animation ids, and accessories. Returns the new description's path.",
    mutates: true,
    schema: z.object({
      shirt: z.number().int().nonnegative().optional(),
      pants: z.number().int().nonnegative().optional(),
      tshirt: z.number().int().nonnegative().optional(),
      face: z.number().int().nonnegative().optional(),
      head: z.number().int().nonnegative().optional(),
      torso: z.number().int().nonnegative().optional(),
      leftArm: z.number().int().nonnegative().optional(),
      rightArm: z.number().int().nonnegative().optional(),
      leftLeg: z.number().int().nonnegative().optional(),
      rightLeg: z.number().int().nonnegative().optional(),
      headColor: z.unknown().optional().describe("Color3 ([r,g,b] or '#RRGGBB' or {r,g,b})"),
      torsoColor: z.unknown().optional(),
      leftArmColor: z.unknown().optional(),
      rightArmColor: z.unknown().optional(),
      leftLegColor: z.unknown().optional(),
      rightLegColor: z.unknown().optional(),
      heightScale: z.number().positive().optional(),
      widthScale: z.number().positive().optional(),
      depthScale: z.number().positive().optional(),
      headScale: z.number().positive().optional(),
      bodyTypeScale: z.number().min(0).max(1).optional(),
      proportionScale: z.number().min(0).max(1).optional(),
      idleAnimation: z.number().int().nonnegative().optional(),
      walkAnimation: z.number().int().nonnegative().optional(),
      runAnimation: z.number().int().nonnegative().optional(),
      jumpAnimation: z.number().int().nonnegative().optional(),
      climbAnimation: z.number().int().nonnegative().optional(),
      swimAnimation: z.number().int().nonnegative().optional(),
      fallAnimation: z.number().int().nonnegative().optional(),
      accessories: z.array(z.object({
        assetId: z.number().int().positive(),
        accessoryType: z.string().optional().describe("Hat, HairAccessory, FaceAccessory, NeckAccessory, ShoulderAccessory, FrontAccessory, BackAccessory, WaistAccessory, TShirt, Shirt, Pants, Jacket, Sweater, Shorts, LeftShoe, RightShoe, DressSkirt"),
        isLayered: z.boolean().optional(),
        order: z.number().int().optional(),
        puffiness: z.number().optional(),
      })).optional(),
      parentPath: z.string().default("game.ServerStorage"),
      name: z.string().optional(),
    }),
  },
  {
    name: "humanoid_description_apply",
    description: "Apply a HumanoidDescription to a character's Humanoid. Either pass descriptionPath (an existing HD) or description (an inline build spec — same shape as humanoid_description_build).",
    mutates: true,
    schema: z.object({
      characterPath: z.string(),
      descriptionPath: z.string().optional(),
      description: z.record(z.unknown()).optional(),
    }),
  },

  // ─── Line-level script editing (token-efficient) ─────────────────────────
  {
    name: "edit_script_lines",
    description:
      "Replace a range of lines in a script's source. Token-efficient alternative to set_script_source — sends only the replacement, not the full file. startLine and endLine are 1-indexed, inclusive. Use replacement='' to delete (or use delete_script_lines).",
    mutates: true,
    schema: z.object({
      path: z.string(),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive().optional().describe("Defaults to startLine"),
      replacement: z.string().describe("New content for the range. Can be empty (deletes lines) or multiple lines."),
    }),
  },
  {
    name: "insert_script_lines",
    description: "Insert lines at a given position in a script (1-indexed). Existing lines at and after that position shift down. Pass atLine=1 to prepend, atLine=999999 to append.",
    mutates: true,
    schema: z.object({
      path: z.string(),
      atLine: z.number().int().positive(),
      content: z.string(),
    }),
  },
  {
    name: "delete_script_lines",
    description: "Delete a range of lines from a script (inclusive, 1-indexed).",
    mutates: true,
    schema: z.object({
      path: z.string(),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive().optional(),
    }),
  },

  // ─── Property search ─────────────────────────────────────────────────────
  {
    name: "search_by_property",
    description:
      "Find descendants of rootPath whose property matches a predicate. Predicates: equals (exact match), contains (substring), gt/lt (numeric). Optional className filter. Returns paths + values. Truncated to maxResults (default 200).",
    mutates: false,
    schema: z.object({
      rootPath: z.string().default("game.Workspace"),
      className: z.string().optional(),
      property: z.string(),
      equals: z.unknown().optional(),
      contains: z.string().optional(),
      gt: z.number().optional(),
      lt: z.number().optional(),
      maxResults: z.number().int().positive().default(200),
    }),
  },

  // ─── Undo / Redo ─────────────────────────────────────────────────────────
  {
    name: "undo",
    description: "Trigger Studio's undo (Ctrl+Z) one or more times. Reverts the last N waypoints set by ChangeHistoryService.",
    mutates: true,
    schema: z.object({ steps: z.number().int().positive().default(1) }),
  },
  {
    name: "redo",
    description: "Trigger Studio's redo (Ctrl+Y) one or more times.",
    mutates: true,
    schema: z.object({ steps: z.number().int().positive().default(1) }),
  },

  // ─── Playtest control + introspection ────────────────────────────────────
  {
    name: "playtest_status",
    description: "Return current play state: isRunning, isServer, isClient, isStudio, isEdit. Use to know whether scripts will run in play context.",
    mutates: false,
    schema: z.object({}),
  },
  {
    name: "playtest_log_listen",
    description:
      "Subscribe to LogService.MessageOut and buffer all play-mode log messages (Info/Warning/Error). Returns an id. Pair with playtest_log_drain to read accumulated logs.",
    mutates: true,
    schema: z.object({
      maxBufferSize: z.number().int().positive().default(500),
      levels: z.array(z.enum(["Info", "Warning", "Error"])).default(["Info", "Warning", "Error"]),
    }),
  },
  {
    name: "playtest_log_drain",
    description: "Read and clear the buffer from playtest_log_listen. Pass stop=true to disconnect the listener.",
    mutates: true,
    schema: z.object({
      id: z.string(),
      stop: z.boolean().default(false),
    }),
  },
  {
    name: "playtest_inject_script",
    description:
      "Create or overwrite a Script/LocalScript under target (default ServerScriptService) with the given Luau source. Auto-runs when play starts. Use for automated test scenarios — spawn near object, gather, equip, etc. Targets: ServerScriptService, StarterPlayerScripts, StarterCharacterScripts, ReplicatedFirst, or any path.",
    mutates: true,
    schema: z.object({
      source: z.string(),
      name: z.string().optional(),
      target: z.string().default("ServerScriptService"),
      scriptClass: z.enum(["Script", "LocalScript", "ModuleScript"]).optional(),
      disabled: z.boolean().default(false),
    }),
  },
  {
    name: "play_start",
    description: "Best-effort attempt to start play mode programmatically. Roblox plugins are restricted from this — usually returns isRunning=false with a note to press F5 manually.",
    mutates: true,
    schema: z.object({}),
  },
  {
    name: "play_stop",
    description: "Best-effort attempt to stop play mode. Plugins are restricted; usually requires manual Shift+F5.",
    mutates: true,
    schema: z.object({}),
  },
  {
    name: "wait_for_play_state",
    description:
      "Block until RunService:IsRunning() matches target ('running' or 'stopped'). Returns once state is reached or timeout fires. Use after asking the user to press F5 — wait for play to start, then run test scripts.",
    mutates: false,
    schema: z.object({
      target: z.enum(["running", "stopped"]),
      timeoutS: z.number().positive().default(30),
    }),
  },
  {
    name: "simulate_key_press",
    description:
      "Send a keyboard event via VirtualInputManager (best-effort — works in Studio play mode). holdS controls how long the key is held before release.",
    mutates: true,
    schema: z.object({
      key: z.string().describe("Enum.KeyCode name, e.g. 'W', 'Space', 'E'"),
      holdS: z.number().nonnegative().default(0.05),
    }),
  },
  {
    name: "simulate_mouse_click",
    description: "Send a mouse click event at screen coordinates (x, y) via VirtualInputManager. button: 0 = left, 1 = right, 2 = middle.",
    mutates: true,
    schema: z.object({
      x: z.number(),
      y: z.number(),
      button: z.number().int().min(0).max(2).default(0),
      holdS: z.number().nonnegative().default(0.04),
    }),
  },

  // ─── HOME TAB — selection-based bulk ops + file ops ──────────────────────
  {
    name: "group_selection",
    description: "Wrap selected instances (or supplied paths) in a new Model. The largest BasePart becomes PrimaryPart. Equivalent to Studio Home tab > Group.",
    mutates: true,
    schema: z.object({
      paths: z.array(z.string()).optional(),
      name: z.string().default("Group"),
    }),
  },
  {
    name: "ungroup_model",
    description: "Reparent a Model's children to the Model's parent and destroy the Model.",
    mutates: true,
    schema: z.object({ path: z.string().optional() }),
  },
  {
    name: "anchor_selection",
    description: "Set Anchored on all BaseParts in selection (or supplied paths). recursive=true (default) anchors descendants too.",
    mutates: true,
    schema: z.object({
      paths: z.array(z.string()).optional(),
      anchored: z.boolean().default(true),
      recursive: z.boolean().default(true),
    }),
  },
  {
    name: "lock_selection",
    description: "Set Locked on all BaseParts in selection.",
    mutates: true,
    schema: z.object({
      paths: z.array(z.string()).optional(),
      locked: z.boolean().default(true),
      recursive: z.boolean().default(true),
    }),
  },
  {
    name: "set_material_selection",
    description: "Set Material on all BaseParts in selection. material is an Enum.Material name (Plastic, Wood, Slate, Metal, etc.)",
    mutates: true,
    schema: z.object({
      paths: z.array(z.string()).optional(),
      material: z.string(),
      recursive: z.boolean().default(true),
    }),
  },
  {
    name: "set_color_selection",
    description: "Set Color on all BaseParts in selection. Accepts [r,g,b] (0-1 or 0-255) or '#RRGGBB' hex string.",
    mutates: true,
    schema: z.object({
      paths: z.array(z.string()).optional(),
      color: z.unknown(),
      recursive: z.boolean().default(true),
    }),
  },
  {
    name: "duplicate_selection",
    description: "Clone all selected instances (or supplied paths) into the same parent. Returns the new clone paths.",
    mutates: true,
    schema: z.object({ paths: z.array(z.string()).optional() }),
  },
  {
    name: "save_place",
    description: "Save the current place file (game:Save). Returns ok=true on success.",
    mutates: true,
    schema: z.object({}),
  },

  // ─── AVATAR TAB — rig builder ────────────────────────────────────────────
  {
    name: "build_rig",
    description: "Create a default R6 or R15 character rig in workspace. Equivalent to Avatar tab > Rig Builder.",
    mutates: true,
    schema: z.object({
      rigType: z.enum(["R6", "R15"]).default("R15"),
      name: z.string().optional(),
      parentPath: z.string().optional(),
      position: z.array(z.number()).length(3).optional(),
    }),
  },

  // ─── MODEL TAB — transform helpers ───────────────────────────────────────
  {
    name: "move_selection",
    description: "Translate selected BaseParts/Models by a delta Vector3 ([dx, dy, dz]).",
    mutates: true,
    schema: z.object({
      paths: z.array(z.string()).optional(),
      delta: z.array(z.number()).length(3),
    }),
  },
  {
    name: "rotate_selection",
    description: "Rotate selected instances around an axis by N degrees.",
    mutates: true,
    schema: z.object({
      paths: z.array(z.string()).optional(),
      axis: z.enum(["X", "Y", "Z"]).default("Y"),
      degrees: z.number().default(90),
    }),
  },
  {
    name: "scale_selection",
    description: "Multiply Size of selected BaseParts (or use Model:ScaleTo) by a scalar factor.",
    mutates: true,
    schema: z.object({
      paths: z.array(z.string()).optional(),
      scale: z.number().positive().default(1),
    }),
  },
  {
    name: "snap_to_grid",
    description: "Round Position of selected parts to the nearest grid unit.",
    mutates: true,
    schema: z.object({
      paths: z.array(z.string()).optional(),
      grid: z.number().positive().default(1),
    }),
  },
  {
    name: "pivot_to",
    description: "Move a Model to a position (and optional rotation in degrees) via Model:PivotTo.",
    mutates: true,
    schema: z.object({
      path: z.string(),
      position: z.array(z.number()).length(3),
      rotation: z.array(z.number()).length(3).optional(),
    }),
  },
  {
    name: "get_pivot",
    description: "Get the pivot CFrame of a Model or BasePart.",
    mutates: false,
    schema: z.object({ path: z.string() }),
  },

  // ─── UI TAB — convenience factories ──────────────────────────────────────
  {
    name: "ui_create_layout",
    description: "Create a UI layout/constraint helper inside a parent GuiObject. kinds: UIListLayout, UIGridLayout, UIPadding, UIAspectRatioConstraint, UISizeConstraint, UICorner, UIStroke, UIGradient, UIScale.",
    mutates: true,
    schema: z.object({
      kind: z.enum([
        "UIListLayout", "UIGridLayout", "UIPadding", "UIAspectRatioConstraint",
        "UISizeConstraint", "UICorner", "UIStroke", "UIGradient", "UIScale",
      ]),
      parentPath: z.string(),
      properties: z.record(z.unknown()).optional(),
    }),
  },
  {
    name: "ui_create_widget",
    description: "Create a UI element (Frame, ScrollingFrame, ImageLabel, ImageButton, TextLabel, TextButton, TextBox, ViewportFrame, VideoFrame, ScreenGui, BillboardGui, SurfaceGui).",
    mutates: true,
    schema: z.object({
      kind: z.enum([
        "Frame", "ScrollingFrame", "ImageLabel", "ImageButton",
        "TextLabel", "TextButton", "TextBox", "ViewportFrame", "VideoFrame",
        "ScreenGui", "BillboardGui", "SurfaceGui",
      ]),
      parentPath: z.string(),
      name: z.string().optional(),
      properties: z.record(z.unknown()).optional(),
    }),
  },

  // ─── SCRIPT TAB — analysis ───────────────────────────────────────────────
  {
    name: "script_find_references",
    description: "Find every line in every script under rootPath (default game) that contains the given symbol. Returns { path, line, text } for each match.",
    mutates: false,
    schema: z.object({
      symbol: z.string(),
      rootPath: z.string().optional(),
    }),
  },
  {
    name: "script_count_lines",
    description: "Count total scripts and total lines under rootPath.",
    mutates: false,
    schema: z.object({ rootPath: z.string().optional() }),
  },

  // ─── PLUGINS TAB ─────────────────────────────────────────────────────────
  {
    name: "list_plugins",
    description: "List installed plugins. Plugin enumeration from inside another plugin is restricted by the Studio API — currently returns an informational error.",
    mutates: false,
    schema: z.object({}),
  },
  {
    name: "studio_info",
    description: "Return Studio environment info: place ID, name, gameId, jobId, creator, streaming flag.",
    mutates: false,
    schema: z.object({}),
  },

  // ─── TERRAIN — full Weppy parity (cylinder, wedge, replace) ──────────────
  {
    name: "terrain_fill_cylinder",
    description: "Fill a cylinder of terrain with material. Equivalent to Studio Terrain Editor > Fill > Cylinder.",
    mutates: true,
    schema: z.object({
      position: z.array(z.number()).length(3).describe("Center XYZ"),
      cframe: z.array(z.number()).length(12).optional().describe("Full CFrame override (12 components)"),
      height: z.number().positive(),
      radius: z.number().positive(),
      material: z.string(),
    }),
  },
  {
    name: "terrain_fill_wedge",
    description: "Fill a wedge of terrain with material.",
    mutates: true,
    schema: z.object({
      cframe: z.array(z.number()).length(12),
      size: z.array(z.number()).length(3),
      material: z.string(),
    }),
  },
  {
    name: "terrain_replace_material",
    description: "Replace one material with another in a Region3 box. Resolution defaults to 4 (terrain voxel size).",
    mutates: true,
    schema: z.object({
      min: z.array(z.number()).length(3),
      max: z.array(z.number()).length(3),
      sourceMaterial: z.string(),
      targetMaterial: z.string(),
      resolution: z.number().positive().default(4),
    }),
  },

  // ─── SPATIAL ANALYSIS — raycast, find_ground, region queries ─────────────
  {
    name: "raycast",
    description:
      "workspace:Raycast wrapper. Pass either direction ([dx,dy,dz]) or target ([x,y,z]). filterType: 'exclude' (default) or 'include' with filterPaths. Returns hit info: position, normal, material, instance path, distance.",
    mutates: false,
    schema: z.object({
      origin: z.array(z.number()).length(3),
      direction: z.array(z.number()).length(3).optional(),
      target: z.array(z.number()).length(3).optional(),
      maxDistance: z.number().positive().optional(),
      filterPaths: z.array(z.string()).optional(),
      filterType: z.enum(["include", "exclude"]).default("exclude"),
      ignoreWater: z.boolean().default(false),
      collisionGroup: z.string().optional(),
    }),
  },
  {
    name: "find_ground",
    description: "Cast a ray downward from origin (lifted by skyOffset, default 100) to find ground beneath. Returns hit position + groundY.",
    mutates: false,
    schema: z.object({
      origin: z.array(z.number()).length(3),
      maxDistance: z.number().positive().default(1000),
      skyOffset: z.number().nonnegative().default(100),
      filterPaths: z.array(z.string()).optional(),
      filterType: z.enum(["include", "exclude"]).default("exclude"),
    }),
  },
  {
    name: "region_query",
    description: "Find all BaseParts whose bounding box intersects a Region3 box. Returns paths.",
    mutates: false,
    schema: z.object({
      min: z.array(z.number()).length(3),
      max: z.array(z.number()).length(3),
      excludePaths: z.array(z.string()).optional(),
      maxParts: z.number().int().positive().default(200),
    }),
  },
  {
    name: "touching_parts",
    description: "Get all parts currently touching the given BasePart (BasePart:GetTouchingParts).",
    mutates: false,
    schema: z.object({ path: z.string() }),
  },

  // ─── ROBLOX CATALOG search (Toolbox parity) ──────────────────────────────
  {
    name: "catalog_search",
    description:
      "Search the Roblox catalog via AvatarEditorService:SearchCatalog. Returns matching items with id, name, price, creator. Use the asset id to insert via insert_asset.",
    mutates: false,
    schema: z.object({
      searchKeyword: z.string().optional(),
      minPrice: z.number().int().nonnegative().optional(),
      maxPrice: z.number().int().nonnegative().optional(),
      assetTypes: z.array(z.string()).optional().describe("Enum.AvatarAssetType or AssetType names"),
      bundleTypes: z.array(z.string()).optional(),
      sortType: z.string().optional().describe("Enum.CatalogSortType name (Relevance, MostFavorited, etc.)"),
      maxResults: z.number().int().positive().default(25),
    }),
  },

  // ─── PLAY pause/resume ───────────────────────────────────────────────────
  {
    name: "play_pause",
    description: "Best-effort attempt to pause Studio play mode. Plugin restrictions may apply.",
    mutates: true,
    schema: z.object({}),
  },
  {
    name: "play_resume",
    description: "Best-effort attempt to resume play mode after pause.",
    mutates: true,
    schema: z.object({}),
  },

  // ─── COLLISION GROUPS (PhysicsService) ───────────────────────────────────
  {
    name: "collision_group_create",
    description: "Register a new collision group via PhysicsService:RegisterCollisionGroup.",
    mutates: true,
    schema: z.object({ name: z.string() }),
  },
  {
    name: "collision_group_set_collidable",
    description: "Set whether two collision groups can collide.",
    mutates: true,
    schema: z.object({
      group1: z.string(),
      group2: z.string(),
      collidable: z.boolean(),
    }),
  },
  {
    name: "collision_group_assign",
    description: "Assign a BasePart to a named collision group.",
    mutates: true,
    schema: z.object({ path: z.string(), group: z.string() }),
  },

  // ─── Studio command bar ──────────────────────────────────────────────────
  {
    name: "command_bar",
    description:
      "Execute Luau code with full Edit-mode privileges (access to Selection, ChangeHistoryService, etc.) and capture print/warn output. Returns {ok, result, error, stdout, stderr}. Different env from run_luau which has play-mode constraints.",
    mutates: true,
    schema: z.object({
      code: z.string().describe("Luau source. Last expression's value is returned as 'result'."),
    }),
  },

  // ─── Animation editing (read/edit existing KeyframeSequences) ────────────
  {
    name: "get_keyframe_sequence",
    description: "Read an existing KeyframeSequence's frames. Returns array of {time, name, poses: { boneName: [12 cframe components] }}.",
    mutates: false,
    schema: z.object({ path: z.string() }),
  },
  {
    name: "edit_keyframe_sequence",
    description:
      "Replace (or merge) keyframes in an existing KeyframeSequence. Pass merge=true to overlay onto existing frames; default replaces all keyframes.",
    mutates: true,
    schema: z.object({
      path: z.string(),
      frames: z.array(z.object({
        time: z.number().min(0),
        name: z.string().optional(),
        poses: z.record(z.array(z.number()).length(12)),
      })),
      merge: z.boolean().default(false),
      loop: z.boolean().optional(),
    }),
  },
  {
    name: "humanoid_play_animation",
    description:
      "Load an animation onto a character's Humanoid (or AnimationController) and play it. Returns an id that can be passed to humanoid_stop_animation.",
    mutates: true,
    schema: z.object({
      characterPath: z.string(),
      animationId: z.union([z.string(), z.number()]),
      looped: z.boolean().optional(),
      speed: z.number().positive().default(1),
      weight: z.number().positive().default(1),
      fadeTime: z.number().nonnegative().default(0.1),
      priority: z.enum(["Idle", "Movement", "Action", "Action2", "Action3", "Action4", "Core"]).optional(),
    }),
  },
  {
    name: "humanoid_stop_animation",
    description: "Stop a single animation track started via humanoid_play_animation.",
    mutates: true,
    schema: z.object({
      id: z.string(),
      fadeTime: z.number().nonnegative().default(0.1),
    }),
  },
  {
    name: "humanoid_stop_all",
    description: "Stop all currently-playing animation tracks on a character's Humanoid.",
    mutates: true,
    schema: z.object({ characterPath: z.string() }),
  },

  // ─── EditableImage / EditableMesh ────────────────────────────────────────
  {
    name: "editable_image_create",
    description:
      "Create an EditableImage instance with optional pixel data (RGBA byte array, length = width*height*4). Use to procedurally generate textures without uploading them.",
    mutates: true,
    schema: z.object({
      size: z.array(z.number().int().positive()).length(2).default([256, 256]),
      pixelsRGBA: z.array(z.number().int().min(0).max(255)).optional(),
      parentPath: z.string().optional(),
    }),
  },
  {
    name: "editable_image_set_pixels",
    description: "Write RGBA pixel data to an existing EditableImage at offset (default [0,0]) with size (default the full image).",
    mutates: true,
    schema: z.object({
      path: z.string(),
      pixelsRGBA: z.array(z.number().int().min(0).max(255)),
      offset: z.array(z.number().int().nonnegative()).length(2).optional(),
      size: z.array(z.number().int().positive()).length(2).optional(),
    }),
  },
  {
    name: "editable_mesh_create",
    description:
      "Create an EditableMesh from vertex and face arrays. Vertices are [x,y,z] triples, faces are [v1,v2,v3] triangle indexes (1-based).",
    mutates: true,
    schema: z.object({
      vertices: z.array(z.array(z.number()).length(3)),
      faces: z.array(z.array(z.number().int().positive()).length(3)),
      parentPath: z.string().optional(),
    }),
  },

  // ─── Pathfinding ─────────────────────────────────────────────────────────
  {
    name: "pathfind",
    description:
      "Compute a path from startPos to endPos via PathfindingService. Returns waypoints with positions and actions (Walk, Jump, Custom). agentParams accepts {AgentRadius, AgentHeight, AgentCanJump, AgentCanClimb, WaypointSpacing}.",
    mutates: false,
    schema: z.object({
      startPos: z.array(z.number()).length(3),
      endPos: z.array(z.number()).length(3),
      agentParams: z.record(z.unknown()).optional(),
    }),
  },
  {
    name: "pathfind_visualize",
    description: "Same as pathfind but also spawns colored marker parts at each waypoint in workspace, auto-cleanup via Debris after lifetimeS (default 8).",
    mutates: true,
    schema: z.object({
      startPos: z.array(z.number()).length(3),
      endPos: z.array(z.number()).length(3),
      agentParams: z.record(z.unknown()).optional(),
      lifetimeS: z.number().positive().default(8),
    }),
  },

  // ─── Remote events / functions ───────────────────────────────────────────
  {
    name: "remote_fire",
    description:
      "Fire a RemoteEvent or BindableEvent. For RemoteEvent: target='client' (with optional player path) fires to a specific player or all clients. For BindableEvent, fires the event.",
    mutates: true,
    schema: z.object({
      path: z.string(),
      args: z.array(z.unknown()).default([]),
      target: z.enum(["client"]).optional(),
      player: z.string().optional().describe("Path to a Player instance for FireClient"),
    }),
  },
  {
    name: "remote_invoke",
    description:
      "Invoke a RemoteFunction:InvokeClient (requires player path) or BindableFunction:Invoke. Returns the result.",
    mutates: true,
    schema: z.object({
      path: z.string(),
      args: z.array(z.unknown()).default([]),
      player: z.string().optional(),
    }),
  },
  {
    name: "remote_listen",
    description:
      "Subscribe to a RemoteEvent or BindableEvent and buffer fires. Pair with remote_drain to read buffered calls. Use to verify the game's RPC layer fires what you expect.",
    mutates: true,
    schema: z.object({
      path: z.string(),
      maxBufferSize: z.number().int().positive().default(100),
    }),
  },
  {
    name: "remote_drain",
    description: "Read and clear the buffer from a remote_listen subscription. Pass stop=true to disconnect the listener.",
    mutates: true,
    schema: z.object({
      path: z.string().optional(),
      key: z.string().optional(),
      stop: z.boolean().default(false),
    }),
  },

  // ─── Particle presets ────────────────────────────────────────────────────
  {
    name: "particle_preset_apply",
    description:
      "Add a curated ParticleEmitter preset to a BasePart or Attachment. Presets: 'blood' (red splatter), 'dust' (gray puff), 'sparkle' (golden glow), 'smoke' (rising gray), 'fire' (yellow→red flame), 'magic' (purple→blue), 'chips' (debris from breaking). Optional emit=N triggers a one-shot burst; cleanupS=N destroys the emitter after N seconds.",
    mutates: true,
    schema: z.object({
      partPath: z.string(),
      preset: z.enum(["blood", "dust", "sparkle", "smoke", "fire", "magic", "chips"]),
      color: z.unknown().optional().describe("Override the preset's main color (Color3)"),
      scale: z.number().positive().optional().describe("Multiply the size sequence by this factor"),
      rate: z.number().nonnegative().optional().describe("Override Rate"),
      emit: z.number().int().positive().optional().describe("If set, fires :Emit(N) once after creation"),
      cleanupS: z.number().positive().optional().describe("Auto-destroy emitter after N seconds"),
    }),
  },

  // ─── Tags / CollectionService ────────────────────────────────────────────
  {
    name: "tags_add",
    description: "Add a CollectionService tag to an instance.",
    mutates: true,
    schema: z.object({ path: z.string(), tag: z.string() }),
  },
  {
    name: "tags_remove",
    description: "Remove a CollectionService tag from an instance.",
    mutates: true,
    schema: z.object({ path: z.string(), tag: z.string() }),
  },
  {
    name: "tags_get",
    description: "Get all CollectionService tags on an instance.",
    mutates: false,
    schema: z.object({ path: z.string() }),
  },
  {
    name: "tags_query",
    description: "Get all instances tagged with a given tag.",
    mutates: false,
    schema: z.object({ tag: z.string() }),
  },

  // ─── Marketplace ─────────────────────────────────────────────────────────
  {
    name: "marketplace_get_product_info",
    description: "MarketplaceService:GetProductInfo wrapper. infoType: 'Asset', 'Product' (DevProduct), 'GamePass', 'Bundle', 'Subscription'.",
    mutates: false,
    schema: z.object({
      id: z.number().int().positive(),
      infoType: z.enum(["Asset", "Product", "GamePass", "Bundle", "Subscription"]).default("Asset"),
    }),
  },
  {
    name: "marketplace_user_owns_gamepass",
    description: "Check if a player owns a specific GamePass.",
    mutates: false,
    schema: z.object({
      player: z.string().describe("Path to a Player instance, e.g. 'Players.username'"),
      gamePassId: z.number().int().positive(),
    }),
  },

  // ─── Sound utilities ─────────────────────────────────────────────────────
  {
    name: "sound_play",
    description:
      "Play a one-shot sound at a world position via a temp anchored part. Auto-cleanup after cleanupS (default 5). Supports volume, pitch, rollOffMaxDistance, rollOffMode.",
    mutates: true,
    schema: z.object({
      soundId: z.union([z.string(), z.number()]).describe("Numeric asset ID or rbxassetid:// URI"),
      position: z.array(z.number()).length(3).optional(),
      volume: z.number().nonnegative().default(1),
      pitch: z.number().positive().default(1),
      rollOffMaxDistance: z.number().positive().default(100),
      rollOffMode: z.enum(["Inverse", "Linear", "InverseTapered", "LinearSquare"]).optional(),
      cleanupS: z.number().positive().default(5),
    }),
  },

  // ─── Avatar utilities ────────────────────────────────────────────────────
  {
    name: "humanoid_unequip_all",
    description: "Unequip all Tools currently equipped on a character's Humanoid.",
    mutates: true,
    schema: z.object({ characterPath: z.string() }),
  },
  {
    name: "humanoid_set_state_enabled",
    description: "Toggle a HumanoidStateType (e.g. 'Climbing', 'Jumping', 'Swimming') on a character.",
    mutates: true,
    schema: z.object({
      characterPath: z.string(),
      state: z.string().describe("HumanoidStateType name"),
      enabled: z.boolean(),
    }),
  },

  // ─── Plugin self ─────────────────────────────────────────────────────────
  {
    name: "plugin_reload",
    description: "Reload the supertool plugin. Currently returns instructions — Studio plugins can't safely re-execute themselves from inside.",
    mutates: false,
    schema: z.object({}),
  },

  // ─── Animation editor ────────────────────────────────────────────────────
  {
    name: "create_animation",
    description:
      "Build a KeyframeSequence from an array of frames (each frame: time + bone CFrames). Drops it into ServerStorage with the given name. Use save_animation_to_workspace to inspect, or get its assetId by saving via Studio.",
    mutates: true,
    schema: z.object({
      name: z.string(),
      frames: z.array(z.object({
        time: z.number().min(0),
        poses: z.record(z.array(z.number()).length(12).describe("CFrame as 12 components")),
      })),
      parentPath: z.string().default("game.ServerStorage"),
      loop: z.boolean().default(false),
    }),
  },
  {
    name: "apply_pose",
    description:
      "Set bone CFrames on a rigged Model directly (instant pose, no animation). Useful for testing rig deformation.",
    mutates: true,
    schema: z.object({
      modelPath: z.string(),
      poses: z.record(z.array(z.number()).length(12)),
    }),
  },

  // ─── Terrain ─────────────────────────────────────────────────────────────
  {
    name: "terrain_fill_block",
    description: "Fill a region with terrain material via Terrain:FillBlock.",
    mutates: true,
    schema: z.object({
      cframe: z.array(z.number()).length(12).describe("Block CFrame as 12 components"),
      size: z.array(z.number()).length(3),
      material: z.string().describe("Enum.Material name, e.g. 'Grass', 'Rock', 'Sand', 'Water'"),
    }),
  },
  {
    name: "terrain_fill_ball",
    description: "Fill a sphere with terrain material via Terrain:FillBall.",
    mutates: true,
    schema: z.object({
      center: z.array(z.number()).length(3),
      radius: z.number().positive(),
      material: z.string(),
    }),
  },
  {
    name: "terrain_clear_region",
    description: "Clear terrain in a region (set to Air).",
    mutates: true,
    schema: z.object({
      min: z.array(z.number()).length(3),
      max: z.array(z.number()).length(3),
    }),
  },
  {
    name: "terrain_set_material_color",
    description: "Set the color used to render a specific terrain material (Terrain:SetMaterialColor).",
    mutates: true,
    schema: z.object({
      material: z.string(),
      color: z.array(z.number()).length(3).describe("[r, g, b] in 0..1"),
    }),
  },

  // ─── DataStore ───────────────────────────────────────────────────────────
  {
    name: "datastore_get",
    description: "Read a value from a DataStore. Only works in play mode (DataStores aren't accessible in Edit mode).",
    mutates: false,
    schema: z.object({ store: z.string(), key: z.string() }),
  },
  {
    name: "datastore_set",
    description: "Write a value to a DataStore. Play mode only.",
    mutates: true,
    schema: z.object({ store: z.string(), key: z.string(), value: z.unknown() }),
  },
  {
    name: "datastore_increment",
    description: "Increment a numeric DataStore value. Play mode only.",
    mutates: true,
    schema: z.object({ store: z.string(), key: z.string(), delta: z.number().default(1) }),
  },

  // ─── Service introspection ──────────────────────────────────────────────
  {
    name: "list_services",
    description: "List all Studio services available under `game` with their child counts.",
    mutates: false,
    schema: z.object({}),
  },
  {
    name: "class_info",
    description: "List the methods and properties of an Instance class (best-effort introspection).",
    mutates: false,
    schema: z.object({ className: z.string() }),
  },

  // ─── File sync (Rojo-lite) ──────────────────────────────────────────────
  {
    name: "file_sync_start",
    description:
      "Watch a local folder; mirror script files into Studio under a given root path. File extensions: .server.lua=Script, .client.lua=LocalScript, .module.lua=ModuleScript. Initial push syncs every file.",
    mutates: true,
    local: async (args) => {
      const opts = args as {
        localDir: string;
        scriptRoot: string;
        classMap?: Record<string, "Script" | "LocalScript" | "ModuleScript">;
        ignore?: string[];
      };
      return await startFileSync(opts);
    },
    schema: z.object({
      localDir: z.string().describe("Absolute path to local folder"),
      scriptRoot: z.string().describe("Studio path to mirror under, e.g. 'game.ServerScriptService.Synced'"),
      classMap: z.record(z.enum(["Script", "LocalScript", "ModuleScript"])).optional(),
      ignore: z.array(z.string()).optional(),
    }),
  },
  {
    name: "file_sync_stop",
    description: "Stop the active file watcher.",
    mutates: false,
    local: async () => await stopFileSync(),
    schema: z.object({}),
  },
  {
    name: "file_sync_status",
    description: "Report current file-sync state.",
    mutates: false,
    local: async () => getFileSyncState(),
    schema: z.object({}),
  },

  // ─── Rojo integration ───────────────────────────────────────────────────
  {
    name: "rojo_load_project",
    description:
      "Load a Rojo project (default.project.json) and build the Studio↔file path map. If projectPath is omitted, walks up from CWD looking for default.project.json. Required before set_script_source's Rojo routing kicks in.",
    mutates: false,
    local: async (args) => {
      const provided = args.projectPath as string | undefined;
      const projectPath = provided ?? findProjectFile(process.cwd());
      if (!projectPath) throw new Error("No projectPath given and no default.project.json found by walking up from CWD");
      const project = loadProject(projectPath);
      setCurrentProject(project);
      return summarizeProject(project);
    },
    schema: z.object({
      projectPath: z.string().optional(),
    }),
  },
  {
    name: "rojo_get_project",
    description: "Return info about the currently loaded Rojo project (or null).",
    mutates: false,
    local: async () => {
      const p = getCurrentProject();
      return p ? summarizeProject(p) : null;
    },
    schema: z.object({}),
  },
  {
    name: "rojo_resolve_studio_path",
    description:
      "Given a Studio dot-path, return the local file Rojo would sync from (if any), plus the TS source file when applicable.",
    mutates: false,
    local: async (args) => {
      const studioPath = args.studioPath as string;
      const binding = resolveStudioPathToFile(studioPath);
      if (!binding) return { mapped: false };
      const tsSource = maybeFindTsSourceForBinding(binding);
      return {
        mapped: true,
        studioPath: binding.studioPath,
        localFile: binding.localFile,
        className: binding.className,
        tsSource: tsSource ?? undefined,
        warning: tsSource
          ? "This path maps to compiled TypeScript output. Edit the .ts source instead."
          : undefined,
      };
    },
    schema: z.object({ studioPath: z.string() }),
  },
  {
    name: "rojo_resolve_local_file",
    description: "Given a local file path, return the Studio path Rojo maps it to (if any).",
    mutates: false,
    local: async (args) => {
      const localPath = args.localPath as string;
      const binding = resolveLocalFileToStudio(localPath);
      if (!binding) return { mapped: false };
      return {
        mapped: true,
        studioPath: binding.studioPath,
        localFile: binding.localFile,
        className: binding.className,
      };
    },
    schema: z.object({ localPath: z.string() }),
  },
  {
    name: "rojo_serve_start",
    description: "Spawn `rojo serve` (using Aftman binary if available). Connect Rojo's Studio plugin to the same port.",
    mutates: true,
    local: async (args) => await serveStart(args.projectPath as string | undefined, args.port as number | undefined),
    schema: z.object({
      projectPath: z.string().optional(),
      port: z.number().int().positive().default(34872).optional(),
    }),
  },
  {
    name: "rojo_serve_stop",
    description: "Kill the running `rojo serve` child process.",
    mutates: false,
    local: async () => await serveStop(),
    schema: z.object({}),
  },
  {
    name: "rojo_serve_status",
    description: "Report whether `rojo serve` is running, and the binary path used.",
    mutates: false,
    local: async () => serveStatus(),
    schema: z.object({}),
  },

  // ─── Asset search (Roblox Marketplace / Toolbox) ────────────────────────
  {
    name: "asset_search",
    description:
      "Search the Roblox Creator Marketplace (Toolbox) for free assets. Categories: audio, decal, model, meshpart, animation, plugin. Returns metadata only (fast). For visual selection use asset_search_visual.",
    mutates: false,
    local: async (args) => {
      const items = await scraperSearch({
        category: args.category as keyof typeof CATEGORY_IDS,
        keywords: args.keywords as string[],
        limit: args.limit as number,
        pages: args.pages as number,
        sort: args.sort as keyof typeof SORT_TYPES,
        freeOnly: args.freeOnly as boolean,
        minVotes: args.minVotes as number | undefined,
        minRatio: args.minRatio as number | undefined,
        officialOnly: args.officialOnly as boolean | undefined,
      });
      const top = items.slice(0, args.maxResults as number);
      return {
        totalFound: items.length,
        returned: top.length,
        items: top,
      };
    },
    schema: z.object({
      category: z.enum(["audio", "decal", "model", "meshpart", "animation", "plugin"]),
      keywords: z.array(z.string()).min(1),
      limit: z.number().int().min(1).max(30).default(20).describe("results per keyword per page"),
      pages: z.number().int().min(1).max(5).default(1),
      sort: z.enum(["relevance", "recent", "oldest", "downloads", "votes"]).default("relevance"),
      freeOnly: z.boolean().default(true),
      minVotes: z.number().int().min(0).optional(),
      minRatio: z.number().min(0).max(100).optional(),
      officialOnly: z.boolean().default(false),
      maxResults: z.number().int().min(1).max(100).default(30),
    }),
  },
  {
    name: "asset_search_visual",
    description:
      "Search Toolbox AND return inline thumbnail images for the top N hits, so you can VISUALLY pick the best one. Returns text summary + image content blocks. Heavier than asset_search — use when you need to see the assets.",
    mutates: false,
    local: async (args) => {
      const items = await scraperSearch({
        category: args.category as keyof typeof CATEGORY_IDS,
        keywords: args.keywords as string[],
        limit: args.limit as number,
        pages: args.pages as number,
        sort: args.sort as keyof typeof SORT_TYPES,
        freeOnly: args.freeOnly as boolean,
        minVotes: args.minVotes as number | undefined,
        minRatio: args.minRatio as number | undefined,
        officialOnly: args.officialOnly as boolean | undefined,
      });
      const top = items.slice(0, args.previewCount as number);
      // For decals, the thumbnail uses the textureId; for everything else, the asset id
      const thumbIds = top.map((it) =>
        it.typeId === 13 && it.textureId ? it.textureId : it.id,
      );
      const thumbs = await fetchThumbnailsBatch(thumbIds, args.size as ThumbnailSize);

      const content: ContentBlock[] = [
        {
          type: "text",
          text: `Found ${items.length} assets, showing top ${top.length} with thumbnails:\n\n` +
            top.map((it, i) => summarizeItem(it, i)).join("\n\n"),
        },
      ];
      for (let i = 0; i < top.length; i++) {
        const t = thumbs[i];
        if (t?.base64) {
          content.push({
            type: "text",
            text: `\n— Thumbnail #${i + 1}: [${top[i]!.id}] ${top[i]!.name}`,
          });
          content.push({ type: "image", data: t.base64, mimeType: "image/png" });
        }
      }
      return { __mcpContent: content };
    },
    schema: z.object({
      category: z.enum(["audio", "decal", "model", "meshpart", "animation", "plugin"]),
      keywords: z.array(z.string()).min(1),
      limit: z.number().int().min(1).max(30).default(20),
      pages: z.number().int().min(1).max(5).default(1),
      sort: z.enum(["relevance", "recent", "oldest", "downloads", "votes"]).default("relevance"),
      freeOnly: z.boolean().default(true),
      minVotes: z.number().int().min(0).optional(),
      minRatio: z.number().min(0).max(100).optional(),
      officialOnly: z.boolean().default(false),
      previewCount: z.number().int().min(1).max(20).default(8).describe("Top N to render as inline images"),
      size: z.enum(["150x150", "420x420", "700x700"]).default("420x420"),
    }),
  },
  {
    name: "asset_get_thumbnail",
    description: "Fetch a single asset's thumbnail as inline PNG so you can see it.",
    mutates: false,
    local: async (args) => {
      const id = args.assetId as string;
      const b64 = await fetchThumbnailBase64(id, args.size as ThumbnailSize);
      if (!b64) throw new Error(`Thumbnail not available for asset ${id}`);
      return {
        __mcpContent: [
          { type: "text", text: `Thumbnail for asset ${id}:` },
          { type: "image", data: b64, mimeType: "image/png" },
        ] satisfies ContentBlock[],
      };
    },
    schema: z.object({
      assetId: z.string().describe("Asset ID (numeric, as string)"),
      size: z.enum(["150x150", "420x420", "700x700"]).default("420x420"),
    }),
  },
  {
    name: "asset_get_details",
    description: "Fetch full metadata for one or more asset IDs (no images).",
    mutates: false,
    local: async (args) => {
      const items = await scraperFetchDetails(args.assetIds as string[]);
      return { items, count: items.length };
    },
    schema: z.object({
      assetIds: z.array(z.string()).min(1),
    }),
  },
  {
    name: "asset_list_presets",
    description: "List the curated search presets in C:\\Dev\\roblox-scraper\\presets.",
    mutates: false,
    local: async () => ({ presets: listPresets() }),
    schema: z.object({}),
  },
  {
    name: "asset_run_preset",
    description:
      "Run a curated search preset (multi-keyword, multi-tag bundle). Returns results grouped by tag.",
    mutates: false,
    local: async (args) => {
      const results = await runPreset(args.name as string);
      // Summarize per-tag
      const summary: Record<string, { count: number; topItems: ScraperItem[] }> = {};
      for (const [tag, items] of Object.entries(results)) {
        summary[tag] = { count: items.length, topItems: items.slice(0, 5) };
      }
      return { preset: args.name, summary };
    },
    schema: z.object({
      name: z.string().describe("Preset name (without .json) — e.g. 'lego-bricks', 'morphs', 'ui-feedback'"),
    }),
  },

  // ─── Open Cloud asset upload (requires API key) ──────────────────────────
  {
    name: "asset_upload_image",
    description:
      "Upload a local image file (PNG/JPG/BMP/TGA) to Roblox as a Decal. Returns the new asset ID and rbxassetid:// URL. Requires an Open Cloud API key with asset:write permission, configured in the Supertool widget.",
    mutates: true,
    local: async (args) => {
      const result = await uploadAsset({
        filePath: args.filePath as string,
        assetType: "Decal",
        displayName: args.name as string,
        description: args.description as string | undefined,
        pollTimeoutMs: args.timeoutMs as number | undefined,
      });
      if (!result.ok) throw new Error(result.error ?? "upload failed");
      return result;
    },
    schema: z.object({
      filePath: z.string().describe("Absolute path to local image file"),
      name: z.string().describe("Display name on Roblox"),
      description: z.string().optional(),
      timeoutMs: z.number().int().min(5000).max(120000).default(30000),
    }),
  },
  {
    name: "asset_upload_audio",
    description:
      "Upload a local audio file (MP3/OGG/WAV) to Roblox as an Audio asset. Returns asset ID + rbxassetid:// URL. Requires API key.",
    mutates: true,
    local: async (args) => {
      const result = await uploadAsset({
        filePath: args.filePath as string,
        assetType: "Audio",
        displayName: args.name as string,
        description: args.description as string | undefined,
        pollTimeoutMs: args.timeoutMs as number | undefined,
      });
      if (!result.ok) throw new Error(result.error ?? "upload failed");
      return result;
    },
    schema: z.object({
      filePath: z.string(),
      name: z.string(),
      description: z.string().optional(),
      timeoutMs: z.number().int().min(5000).max(120000).default(30000),
    }),
  },
  {
    name: "asset_upload_model",
    description: "Upload a local Model file (.rbxm/.rbxmx) to Roblox. Requires API key.",
    mutates: true,
    local: async (args) => {
      const result = await uploadAsset({
        filePath: args.filePath as string,
        assetType: "Model",
        displayName: args.name as string,
        description: args.description as string | undefined,
        pollTimeoutMs: args.timeoutMs as number | undefined,
      });
      if (!result.ok) throw new Error(result.error ?? "upload failed");
      return result;
    },
    schema: z.object({
      filePath: z.string(),
      name: z.string(),
      description: z.string().optional(),
      timeoutMs: z.number().int().min(5000).max(120000).default(60000),
    }),
  },
  {
    name: "asset_upload_shirt",
    description:
      "Upload a local image file as a Roblox Shirt (clothing template). Requires the image to use the standard Roblox shirt template UV layout (585×559 PNG). Returns the new asset ID for use as ShirtTemplate URL.",
    mutates: true,
    local: async (args) => {
      const result = await uploadAsset({
        filePath: args.filePath as string,
        assetType: "Shirt",
        displayName: args.name as string,
        description: args.description as string | undefined,
        pollTimeoutMs: args.timeoutMs as number | undefined,
      });
      if (!result.ok) throw new Error(result.error ?? "upload failed");
      return result;
    },
    schema: z.object({
      filePath: z.string(),
      name: z.string(),
      description: z.string().optional(),
      timeoutMs: z.number().int().min(5000).max(120000).default(60000),
    }),
  },
  {
    name: "asset_upload_pants",
    description: "Upload a local image file as a Roblox Pants (clothing template). Standard Roblox pants template UV layout. Returns asset ID for PantsTemplate URL.",
    mutates: true,
    local: async (args) => {
      const result = await uploadAsset({
        filePath: args.filePath as string,
        assetType: "Pants",
        displayName: args.name as string,
        description: args.description as string | undefined,
        pollTimeoutMs: args.timeoutMs as number | undefined,
      });
      if (!result.ok) throw new Error(result.error ?? "upload failed");
      return result;
    },
    schema: z.object({
      filePath: z.string(),
      name: z.string(),
      description: z.string().optional(),
      timeoutMs: z.number().int().min(5000).max(120000).default(60000),
    }),
  },
  {
    name: "asset_upload_tshirt",
    description: "Upload a local image file as a Roblox T-Shirt (front-only torso decal).",
    mutates: true,
    local: async (args) => {
      const result = await uploadAsset({
        filePath: args.filePath as string,
        assetType: "TShirt",
        displayName: args.name as string,
        description: args.description as string | undefined,
        pollTimeoutMs: args.timeoutMs as number | undefined,
      });
      if (!result.ok) throw new Error(result.error ?? "upload failed");
      return result;
    },
    schema: z.object({
      filePath: z.string(),
      name: z.string(),
      description: z.string().optional(),
      timeoutMs: z.number().int().min(5000).max(120000).default(30000),
    }),
  },
  {
    name: "asset_apikey_status",
    description: "Check whether an Open Cloud API key is configured. Returns lastFour digits only — never the full key.",
    mutates: false,
    local: async () => getApiKeyStatus(),
    schema: z.object({}),
  },
  {
    name: "asset_status_check",
    description:
      "Query an uploaded asset's moderation status via Open Cloud. Returns {state: 'Pending'|'Approved'|'Rejected', metadata}. Useful after asset_upload_* to verify the asset cleared moderation before referencing it in a place file.",
    mutates: false,
    local: async (args) => {
      const apiKey = (await import("../auth.js")).requireApiKey();
      const id = args.id as string | number;
      const url = `https://apis.roblox.com/assets/v1/assets/${id}`;
      const res = await fetch(url, { headers: { "x-api-key": apiKey } });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`asset_status_check HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const json = await res.json();
      return { ok: true, asset: json };
    },
    schema: z.object({
      id: z.union([z.string(), z.number()]).describe("Roblox asset ID (numeric)"),
    }),
  },

  // ─── AI image generation (FLUX via local ComfyUI) ────────────────────────
  {
    name: "image_generate",
    description:
      "Generate an image via the user's local ComfyUI server (FLUX models) by spawning their gen-image.ts script. Returns the local PNG path. Pass scriptPath if your script lives outside the default location.",
    mutates: true,
    local: async (args) => {
      const child = await import("node:child_process");
      const path = await import("node:path");
      const fs = await import("node:fs/promises");
      const os = await import("node:os");

      const scriptPath = (args.scriptPath as string | undefined) ?? "C:/Dev/primal-islands/tools/gen-image.ts";
      const exists = await fs.stat(scriptPath).catch(() => null);
      if (!exists) throw new Error(`image_generate: script not found at ${scriptPath}. Pass scriptPath explicitly.`);

      const outPath = (args.outPath as string | undefined) ?? path.join(os.tmpdir(), `gen-${Date.now()}.png`);

      const cliArgs: string[] = ["tsx", scriptPath, args.prompt as string];
      if (args.aspect) cliArgs.push("--aspect", args.aspect as string);
      if (args.quality) cliArgs.push("--quality", args.quality as string);
      if (args.steps) cliArgs.push("--steps", String(args.steps));
      if (args.seed) cliArgs.push("--seed", String(args.seed));
      if (args.init) cliArgs.push("--init", args.init as string);
      if (args.denoise !== undefined) cliArgs.push("--denoise", String(args.denoise));
      cliArgs.push("--out", outPath);

      const cwd = (args.cwd as string | undefined) ?? path.dirname(scriptPath).replace(/\/tools$/, "");

      const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
        const proc = child.spawn("npx", cliArgs, { cwd, shell: true });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => { stdout += d.toString(); });
        proc.stderr.on("data", (d) => { stderr += d.toString(); });
        proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
        proc.on("error", reject);
        const timeout = (args.timeoutMs as number | undefined) ?? 600_000;
        const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("image_generate timed out")); }, timeout);
        proc.on("close", () => clearTimeout(timer));
      });

      if (result.code !== 0) {
        throw new Error(`image_generate failed (exit ${result.code}): ${result.stderr.slice(-500) || result.stdout.slice(-500)}`);
      }
      const fileExists = await fs.stat(outPath).catch(() => null);
      if (!fileExists) throw new Error(`image_generate: output file missing at ${outPath}`);
      return { ok: true, path: outPath, stdout: result.stdout.trim() };
    },
    schema: z.object({
      prompt: z.string(),
      aspect: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional(),
      quality: z.enum(["fast", "high"]).default("fast"),
      steps: z.number().int().positive().optional(),
      seed: z.number().int().nonnegative().optional(),
      init: z.string().optional().describe("Path to init image for img2img"),
      denoise: z.number().min(0).max(1).optional(),
      outPath: z.string().optional(),
      scriptPath: z.string().optional().describe("Path to gen-image.ts. Defaults to C:/Dev/primal-islands/tools/gen-image.ts"),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().default(600000),
    }),
  },
  {
    name: "image_generate_and_upload",
    description:
      "Generate an image via local FLUX (image_generate) and immediately upload it to Roblox as a Decal. Returns the local PNG path AND the Roblox asset ID/URL. One-shot for procedural icon/texture creation.",
    mutates: true,
    local: async (args) => {
      // Reuse image_generate via direct call since it's local
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const os = await import("node:os");
      const child = await import("node:child_process");

      const scriptPath = (args.scriptPath as string | undefined) ?? "C:/Dev/primal-islands/tools/gen-image.ts";
      const outPath = (args.outPath as string | undefined) ?? path.join(os.tmpdir(), `gen-${Date.now()}.png`);

      const cliArgs: string[] = ["tsx", scriptPath, args.prompt as string];
      if (args.aspect) cliArgs.push("--aspect", args.aspect as string);
      if (args.quality) cliArgs.push("--quality", args.quality as string);
      cliArgs.push("--out", outPath);

      const cwd = path.dirname(scriptPath).replace(/\/tools$/, "");

      await new Promise<void>((resolve, reject) => {
        const proc = child.spawn("npx", cliArgs, { cwd, shell: true });
        let err = "";
        proc.stderr.on("data", (d) => { err += d.toString(); });
        proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`gen failed: ${err.slice(-400)}`)));
        proc.on("error", reject);
      });

      await fs.stat(outPath);
      const upload = await uploadAsset({
        filePath: outPath,
        assetType: "Decal",
        displayName: (args.name as string) ?? `Generated ${Date.now()}`,
        description: args.description as string | undefined,
      });
      if (!upload.ok) throw new Error(upload.error ?? "upload failed");
      return { localPath: outPath, ...upload };
    },
    schema: z.object({
      prompt: z.string(),
      aspect: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional(),
      quality: z.enum(["fast", "high"]).default("fast"),
      name: z.string().optional(),
      description: z.string().optional(),
      outPath: z.string().optional(),
      scriptPath: z.string().optional(),
    }),
  },

  // ─── Poly Haven (CC0 textures, HDRIs, models — no API key required) ──────
  {
    name: "polyhaven_search",
    description:
      "Search Poly Haven's CC0 library (textures, HDRIs, 3D models). No API key required. Returns metadata only — for thumbnails use polyhaven_search_visual.",
    mutates: false,
    local: async (args) => {
      const items = await polyhaven.search({
        type: args.type as polyhaven.PolyHavenType,
        search: args.search as string | undefined,
        categories: args.categories as string[] | undefined,
        limit: args.limit as number,
      });
      return { count: items.length, items };
    },
    schema: z.object({
      type: z.enum(["textures", "hdris", "models"]),
      search: z.string().optional().describe("Free-text query"),
      categories: z.array(z.string()).optional().describe("Category slugs (e.g. 'wood', 'metal')"),
      limit: z.number().int().min(1).max(100).default(30),
    }),
  },
  {
    name: "polyhaven_search_visual",
    description:
      "Search Poly Haven and return inline thumbnail images for the top N hits — pick visually, then call polyhaven_upload_*.",
    mutates: false,
    local: async (args) => {
      const items = await polyhaven.search({
        type: args.type as polyhaven.PolyHavenType,
        search: args.search as string | undefined,
        categories: args.categories as string[] | undefined,
        limit: args.previewCount as number,
      });
      const content: ContentBlock[] = [
        {
          type: "text",
          text: `Found ${items.length} Poly Haven ${args.type} matches:\n\n` +
            items.map((it, i) => `${i + 1}. ${it.name}  [${it.slug}]  tags: ${it.tags.slice(0, 6).join(", ")}`).join("\n"),
        },
      ];
      for (const it of items) {
        if (!it.thumbnail_url) continue;
        try {
          const b64 = await fetchBase64(it.thumbnail_url);
          content.push({ type: "text", text: `${it.name} [${it.slug}]` });
          content.push({ type: "image", data: b64, mimeType: "image/png" });
        } catch { /* skip on fetch failure */ }
      }
      return { __mcpContent: content };
    },
    schema: z.object({
      type: z.enum(["textures", "hdris", "models"]),
      search: z.string().optional(),
      categories: z.array(z.string()).optional(),
      previewCount: z.number().int().min(1).max(20).default(8),
    }),
  },
  {
    name: "polyhaven_get_files",
    description: "Show the available file map for a Poly Haven asset (resolutions, formats, sizes).",
    mutates: false,
    local: async (args) => polyhaven.getFiles(args.slug as string),
    schema: z.object({ slug: z.string().describe("Asset slug from polyhaven_search") }),
  },
  {
    name: "polyhaven_download_texture",
    description:
      "Download a Poly Haven texture's diffuse/albedo map (JPG) to a local temp file. Returns the path — feed to asset_upload_image.",
    mutates: false,
    local: async (args) => polyhaven.downloadTextureDiffuse(args.slug as string, {
      resolution: args.resolution as polyhaven.DownloadOpts["resolution"],
    }),
    schema: z.object({
      slug: z.string(),
      resolution: z.enum(["1k", "2k", "4k", "8k"]).default("1k"),
    }),
  },
  {
    name: "polyhaven_download_model",
    description: "Download a Poly Haven 3D model as FBX. Returns the local path — open it in Studio via File → Import 3D (more reliable than Open Cloud Model uploads, which Roblox often rejects for third-party FBX).",
    mutates: false,
    local: async (args) => polyhaven.downloadModelFbx(args.slug as string, {
      resolution: args.resolution as polyhaven.DownloadOpts["resolution"],
    }),
    schema: z.object({
      slug: z.string(),
      resolution: z.enum(["1k", "2k", "4k"]).default("1k"),
    }),
  },
  {
    name: "polyhaven_upload_texture_as_decal",
    description:
      "One-shot: download a Poly Haven texture and upload it to Roblox as a Decal. Returns the rbxassetid:// URL ready for use in code or the plugin's insert_asset. Requires Open Cloud API key.",
    mutates: true,
    local: async (args) => {
      const dl = await polyhaven.downloadTextureDiffuse(args.slug as string, {
        resolution: args.resolution as polyhaven.DownloadOpts["resolution"],
      });
      const result = await uploadAsset({
        filePath: dl.filePath,
        assetType: "Decal",
        displayName: (args.name as string | undefined) ?? `polyhaven_${args.slug}`,
        description: `Poly Haven CC0 texture: ${args.slug}`,
        pollTimeoutMs: 30000,
      });
      if (!result.ok) throw new Error(result.error ?? "upload failed");
      return { ...result, source: { provider: "polyhaven", slug: args.slug, sourceUrl: dl.sourceUrl } };
    },
    schema: z.object({
      slug: z.string(),
      resolution: z.enum(["1k", "2k", "4k", "8k"]).default("1k"),
      name: z.string().optional(),
    }),
  },
  // Note: no `polyhaven_upload_model` tool — Roblox Open Cloud's Model upload
  // accepts FBX in theory but in practice rejects most third-party FBX with
  // "Unknown Error". Use `polyhaven_download_model` then File → Import 3D in
  // Studio (Studio's importer is more forgiving and gives you a UI to fix
  // axis/scale/material issues).

  // ─── Kenney.nl (CC0 game asset packs — no API key required) ──────────────
  {
    name: "kenney_search",
    description:
      "Search the curated catalog of popular Kenney CC0 packs by name/tag/content type. All packs are public domain (CC0).",
    mutates: false,
    local: async (args) => {
      const packs = kenney.searchCatalog({
        query: args.query as string | undefined,
        contentType: args.contentType as kenney.KenneyContentType | undefined,
      });
      return { count: packs.length, packs: packs.map((p) => ({ ...p, pageUrl: kenney.packPageUrl(p.slug) })) };
    },
    schema: z.object({
      query: z.string().optional(),
      contentType: z.enum(["3d", "2d", "ui", "audio", "fonts"]).optional(),
    }),
  },
  {
    name: "kenney_download_pack",
    description:
      "Download a Kenney pack zip to a local temp file. Returns the zip path — extract it manually, then upload individual files via asset_upload_image / asset_upload_audio / asset_upload_model.",
    mutates: false,
    local: async (args) => kenney.downloadPackZip(args.slug as string),
    schema: z.object({ slug: z.string().describe("Pack slug from kenney_search") }),
  },
  {
    name: "kenney_search_all",
    description:
      "Scrape Kenney's FULL site (~280+ packs across all pages) and return matching packs with thumbnails + tags. Cached for 6h. Use this when kenney_search's curated 30-pack catalog misses what you need.",
    mutates: false,
    local: async (args) => {
      const packs = await kenney.searchAll(
        args.query as string | undefined,
        args.contentType as kenney.KenneyContentType | undefined,
      );
      const limit = (args.limit as number | undefined) ?? 30;
      return { count: packs.length, packs: packs.slice(0, limit) };
    },
    schema: z.object({
      query: z.string().optional(),
      contentType: z.enum(["3d", "2d", "ui", "audio", "fonts"]).optional(),
      limit: z.number().int().min(1).max(200).default(30),
    }),
  },
  {
    name: "kenney_search_visual",
    description:
      "Scrape Kenney's full site and return inline thumbnails for the top N matches so the AI can pick visually before calling kenney_get_pack_detail or kenney_download_pack.",
    mutates: false,
    local: async (args) => {
      const all = await kenney.searchAll(
        args.query as string | undefined,
        args.contentType as kenney.KenneyContentType | undefined,
      );
      const previewCount = (args.previewCount as number | undefined) ?? 8;
      const top = all.slice(0, previewCount);
      const content: ContentBlock[] = [
        {
          type: "text",
          text: `Found ${all.length} Kenney packs (showing top ${top.length}):\n\n` +
            top.map((p, i) => `${i + 1}. ${p.name}  [${p.slug}]  tags: ${p.tags.slice(0, 4).join(", ")}`).join("\n"),
        },
      ];
      for (const p of top) {
        if (!p.thumbnailUrl) continue;
        try {
          const buf = await kenney.fetchImageBuffer(p.thumbnailUrl);
          content.push({ type: "text", text: `${p.name} [${p.slug}]` });
          content.push({ type: "image", data: buf.toString("base64"), mimeType: "image/png" });
        } catch { /* skip on fetch failure */ }
      }
      return { __mcpContent: content };
    },
    schema: z.object({
      query: z.string().optional(),
      contentType: z.enum(["3d", "2d", "ui", "audio", "fonts"]).optional(),
      previewCount: z.number().int().min(1).max(20).default(8),
    }),
  },
  {
    name: "kenney_get_pack_detail",
    description:
      "Scrape full details for a Kenney pack: description, file count, license, screenshot URLs, current zip URL. Use before downloading to verify content + see what's inside.",
    mutates: false,
    local: async (args) => kenney.getPackDetail(args.slug as string),
    schema: z.object({ slug: z.string() }),
  },

  // ─── Game-icons.net (3000+ CC-BY icons, no API key) ──────────────────────
  {
    name: "gameicons_status",
    description:
      "Report the size of the cached game-icons.net catalog (3000+ icons across 40+ authors). First call seeds the cache via the GitHub repo's recursive tree API.",
    mutates: false,
    local: async () => gameicons.getCatalogStats(),
    schema: z.object({}),
  },
  {
    name: "gameicons_search",
    description:
      "Search 3000+ game-icons.net icons by name and/or author. Returns metadata only — for thumbnails use gameicons_search_visual. All icons are CC-BY 3.0 (attribution required).",
    mutates: false,
    local: async (args) => {
      const icons = await gameicons.search({
        query: args.query as string | undefined,
        author: args.author as string | undefined,
        limit: args.limit as number | undefined,
      });
      return { count: icons.length, icons };
    },
    schema: z.object({
      query: z.string().optional().describe("Free-text query matched against icon name (e.g. 'sword', 'fire'). Hyphens treated as spaces."),
      author: z.string().optional().describe("Filter by author (e.g. 'lorc', 'delapouite')"),
      limit: z.number().int().min(1).max(200).default(30),
    }),
  },
  {
    name: "gameicons_search_visual",
    description:
      "Search game-icons.net and return inline rasterized PNG previews of the top N hits (white-on-black 96px) so the AI can visually pick the best one.",
    mutates: false,
    local: async (args) => {
      const icons = await gameicons.search({
        query: args.query as string | undefined,
        author: args.author as string | undefined,
        limit: args.previewCount as number,
      });
      const content: ContentBlock[] = [
        {
          type: "text",
          text: `Found ${icons.length} game-icons matches:\n\n` +
            icons.map((it, i) => `${i + 1}. ${it.id}`).join("\n"),
        },
      ];
      for (const it of icons) {
        try {
          const b64 = await gameicons.thumbnailBase64(it.id, { size: 96 });
          content.push({ type: "text", text: it.id });
          content.push({ type: "image", data: b64, mimeType: "image/png" });
        } catch { /* skip on render failure */ }
      }
      return { __mcpContent: content };
    },
    schema: z.object({
      query: z.string().optional(),
      author: z.string().optional(),
      previewCount: z.number().int().min(1).max(20).default(12),
    }),
  },
  {
    name: "gameicons_download_png",
    description:
      "Rasterize a game-icons SVG to a PNG with custom foreground/background colors. Returns local path — feed to asset_upload_image. Default: white icon on black background, 512px.",
    mutates: false,
    local: async (args) => gameicons.rasterize(args.id as string, {
      size: args.size as number | undefined,
      fg: args.fg as string | undefined,
      bg: args.transparent ? null : (args.bg as string | undefined),
    }),
    schema: z.object({
      id: z.string().describe("Icon id from gameicons_search, format '<author>/<name>'"),
      size: z.number().int().min(16).max(2048).default(512),
      fg: z.string().regex(/^[0-9a-fA-F]{6}$/).default("ffffff").describe("Foreground hex (no #)"),
      bg: z.string().regex(/^[0-9a-fA-F]{6}$/).default("000000").describe("Background hex (no #) — ignored if transparent=true"),
      transparent: z.boolean().default(false).describe("If true, background is transparent and `bg` is ignored"),
    }),
  },
  {
    name: "gameicons_download_svg",
    description:
      "Download a game-icons SVG (raw, no color transform). Roblox doesn't accept SVG directly — prefer gameicons_download_png unless you have your own pipeline.",
    mutates: false,
    local: async (args) => gameicons.downloadSvg(args.id as string),
    schema: z.object({ id: z.string() }),
  },
  {
    name: "gameicons_upload_as_decal",
    description:
      "One-shot: rasterize a game-icons SVG and upload the PNG to Roblox as a Decal. Returns rbxassetid:// URL. Requires Open Cloud API key. CC-BY 3.0 — credit the author in your game's description.",
    mutates: true,
    local: async (args) => {
      const dl = await gameicons.rasterize(args.id as string, {
        size: args.size as number | undefined,
        fg: args.fg as string | undefined,
        bg: args.transparent ? null : (args.bg as string | undefined),
      });
      const icon = await gameicons.getIcon(args.id as string);
      const result = await uploadAsset({
        filePath: dl.filePath,
        assetType: "Decal",
        displayName: (args.name as string | undefined) ?? `gameicons_${icon.author}_${icon.name}`,
        description: `game-icons.net (${icon.author}) — CC-BY 3.0`,
        pollTimeoutMs: 30000,
      });
      if (!result.ok) throw new Error(result.error ?? "upload failed");
      return {
        ...result,
        source: { provider: "gameicons", id: args.id, author: icon.author, name: icon.name, sourceUrl: dl.sourceUrl, license: "CC-BY 3.0" },
      };
    },
    schema: z.object({
      id: z.string(),
      size: z.number().int().min(64).max(1024).default(512),
      fg: z.string().regex(/^[0-9a-fA-F]{6}$/).default("ffffff"),
      bg: z.string().regex(/^[0-9a-fA-F]{6}$/).default("000000"),
      transparent: z.boolean().default(true),
      name: z.string().optional(),
    }),
  },

  // ─── CraftPix.net (free 2D game art — needs login cookie for downloads) ──
  {
    name: "craftpix_status",
    description:
      "Check whether the CraftPix login cookie is configured. Browsing/previews work without it; downloading freebie zips requires it.",
    mutates: false,
    local: async () => {
      const status = getApiKeyStatus();
      return {
        configured: status.craftpix.isConfigured,
        hint: status.craftpix.isConfigured
          ? "OK — CraftPix freebie downloads available."
          : "Log into craftpix.net in your browser, open DevTools → Application → Cookies → craftpix.net, copy the value of `wordpress_logged_in_*` (or the full Cookie header), and paste into the CraftPix field in the Supertool widget.",
      };
    },
    schema: z.object({}),
  },
  {
    name: "craftpix_list_freebies",
    description:
      "Scrape one page of CraftPix's freebies listing. ~30 items per page; total ~280 pages. Returns slug, name, thumbnail URL, category. No login required.",
    mutates: false,
    local: async (args) => {
      const items = await craftpix.listFreebies({
        page: args.page as number | undefined,
        query: args.query as string | undefined,
      });
      return { page: (args.page as number | undefined) ?? 1, count: items.length, items };
    },
    schema: z.object({
      page: z.number().int().min(1).max(300).default(1),
      query: z.string().optional().describe("Optional client-side filter applied to this page's results"),
    }),
  },
  {
    name: "craftpix_search_visual",
    description:
      "Browse CraftPix freebies with inline thumbnails so the AI can pick visually. Optionally pre-filter by query (matched on names within the listed pages).",
    mutates: false,
    local: async (args) => {
      const pages = (args.pagesToScan as number | undefined) ?? 1;
      const query = args.query as string | undefined;
      let collected: craftpix.CraftpixListItem[] = [];
      for (let p = 1; p <= pages; p++) {
        const items = await craftpix.listFreebies({ page: p, query });
        collected = collected.concat(items);
        if (collected.length >= ((args.previewCount as number | undefined) ?? 8) * 2) break;
      }
      const previewCount = (args.previewCount as number | undefined) ?? 8;
      const top = collected.slice(0, previewCount);
      const content: ContentBlock[] = [
        {
          type: "text",
          text: `CraftPix freebies (scanned ${pages} page${pages > 1 ? "s" : ""}, showing top ${top.length} of ${collected.length}):\n\n` +
            top.map((it, i) => `${i + 1}. ${it.name}  [${it.slug}]${it.category ? "  in: " + it.category : ""}`).join("\n"),
        },
      ];
      for (const it of top) {
        if (!it.thumbnailUrl) continue;
        try {
          const buf = await craftpix.fetchThumbnailBuffer(it.thumbnailUrl);
          // CraftPix serves WebP for thumbnails — MCP image blocks accept any
          // mimeType the client supports, but most clients want png/jpg.
          // We pass through the original mime since Claude renders WebP fine.
          const mime = it.thumbnailUrl.endsWith(".webp")
            ? "image/webp"
            : it.thumbnailUrl.match(/\.(jpe?g)(\?|$)/i) ? "image/jpeg" : "image/png";
          content.push({ type: "text", text: `${it.name} [${it.slug}]` });
          content.push({ type: "image", data: buf.toString("base64"), mimeType: mime });
        } catch { /* skip */ }
      }
      return { __mcpContent: content };
    },
    schema: z.object({
      query: z.string().optional(),
      pagesToScan: z.number().int().min(1).max(10).default(1),
      previewCount: z.number().int().min(1).max(20).default(8),
    }),
  },
  {
    name: "craftpix_get_detail",
    description:
      "Scrape a CraftPix freebie's full detail page: name, description, all preview images, file formats (AI/EPS/PNG/...), download URL. No login required for metadata.",
    mutates: false,
    local: async (args) => craftpix.getDetail(args.slug as string),
    schema: z.object({ slug: z.string().describe("Freebie slug from craftpix_list_freebies") }),
  },
  {
    name: "craftpix_download_preview",
    description:
      "Download a single preview image from a CraftPix freebie page (PNG/JPG/WebP). No login required. Returns local path — feed to asset_upload_image (note Roblox doesn't accept WebP — convert first if needed).",
    mutates: false,
    local: async (args) => craftpix.downloadPreview(args.slug as string, (args.index as number | undefined) ?? 0),
    schema: z.object({
      slug: z.string(),
      index: z.number().int().min(0).default(0).describe("0-based index into the preview images array (see craftpix_get_detail)"),
    }),
  },
  {
    name: "craftpix_download_freebie",
    description:
      "Download the full freebie zip from CraftPix. Requires the login cookie set in the Supertool widget. Returns local zip path — extract and upload individual files via asset_upload_image / asset_upload_audio.",
    mutates: false,
    local: async (args) => craftpix.downloadFreebie(args.slug as string),
    schema: z.object({ slug: z.string() }),
  },
  {
    name: "craftpix_upload_preview_as_decal",
    description:
      "One-shot: download a CraftPix preview image and upload to Roblox as a Decal. Skips WebP previews (not Open Cloud-compatible). Returns rbxassetid:// URL. Requires Open Cloud API key but NOT a CraftPix cookie (previews are public).",
    mutates: true,
    local: async (args) => {
      const detail = await craftpix.getDetail(args.slug as string);
      // Pick the first non-webp preview, or fail with a clear message.
      const idx = (args.index as number | undefined) ?? 0;
      const previews = detail.previewImages.filter((u) => !/\.webp(\?|$)/i.test(u));
      if (!previews.length) {
        throw new Error(`No PNG/JPG previews available for ${args.slug} (all are WebP). Use craftpix_download_freebie + extract manually.`);
      }
      if (idx < 0 || idx >= previews.length) {
        throw new Error(`Preview index ${idx} out of range (have ${previews.length} non-webp previews).`);
      }
      const dl = await craftpix.downloadPreview(args.slug as string, detail.previewImages.indexOf(previews[idx]));
      const result = await uploadAsset({
        filePath: dl.filePath,
        assetType: "Decal",
        displayName: (args.name as string | undefined) ?? `craftpix_${args.slug}`,
        description: `CraftPix preview: ${detail.name} (${detail.pageUrl})`,
        pollTimeoutMs: 30000,
      });
      if (!result.ok) throw new Error(result.error ?? "upload failed");
      return { ...result, source: { provider: "craftpix", slug: args.slug, sourceUrl: dl.sourceUrl, pageUrl: detail.pageUrl } };
    },
    schema: z.object({
      slug: z.string(),
      index: z.number().int().min(0).default(0),
      name: z.string().optional(),
    }),
  },

  // ─── Freesound (CC-licensed audio — requires FREESOUND_API_KEY env var) ──
  {
    name: "freesound_status",
    description: "Check whether FREESOUND_API_KEY is configured on the MCP server.",
    mutates: false,
    local: async () => ({
      configured: freesound.isConfigured(),
      hint: freesound.isConfigured()
        ? "OK — Freesound search and preview download are available."
        : "Get a free key at https://freesound.org/apiv2/apply, then set FREESOUND_API_KEY=... in the MCP server's environment and restart.",
    }),
    schema: z.object({}),
  },
  {
    name: "freesound_search",
    description:
      "Search Freesound.org for sounds. License options: cc0 (public domain), by (attribution required), by-nc (non-commercial only — avoid for monetized games), sampling+ (allows derivatives).",
    mutates: false,
    local: async (args) => {
      return freesound.search({
        query: args.query as string,
        licenses: args.licenses as Array<"cc0" | "by" | "by-nc" | "sampling+"> | undefined,
        minDuration: args.minDuration as number | undefined,
        maxDuration: args.maxDuration as number | undefined,
        sort: args.sort as freesound.FreesoundSearchOpts["sort"],
        pageSize: args.pageSize as number,
        page: args.page as number,
      });
    },
    schema: z.object({
      query: z.string(),
      licenses: z.array(z.enum(["cc0", "by", "by-nc", "sampling+"])).optional(),
      minDuration: z.number().min(0).optional(),
      maxDuration: z.number().min(0).optional(),
      sort: z.enum(["score", "duration_desc", "duration_asc", "downloads_desc", "rating_desc", "created_desc"]).default("score"),
      pageSize: z.number().int().min(1).max(150).default(15),
      page: z.number().int().min(1).default(1),
    }),
  },
  {
    name: "freesound_download_preview",
    description:
      "Download Freesound's HQ MP3 preview (~22kHz, 128kbps) to a temp file. Suitable for asset_upload_audio. The preview is a public CDN URL — no OAuth needed.",
    mutates: false,
    local: async (args) => freesound.downloadPreview(args.id as number, args.format as "mp3" | "ogg"),
    schema: z.object({
      id: z.number().int().positive(),
      format: z.enum(["mp3", "ogg"]).default("mp3"),
    }),
  },
  {
    name: "freesound_upload_as_audio",
    description:
      "One-shot: download a Freesound HQ preview and upload to Roblox as Audio. Returns rbxassetid:// URL. Requires both FREESOUND_API_KEY (env) and Open Cloud API key (widget).",
    mutates: true,
    local: async (args) => {
      const dl = await freesound.downloadPreview(args.id as number, "mp3");
      const result = await uploadAsset({
        filePath: dl.filePath,
        assetType: "Audio",
        displayName: (args.name as string | undefined) ?? dl.meta.name,
        description: `Freesound: ${dl.meta.name} by ${dl.meta.username} (${dl.meta.license})`,
        pollTimeoutMs: 30000,
      });
      if (!result.ok) throw new Error(result.error ?? "upload failed");
      return {
        ...result,
        source: {
          provider: "freesound",
          id: args.id,
          name: dl.meta.name,
          username: dl.meta.username,
          license: dl.meta.license,
          sourceUrl: dl.sourceUrl,
          duration: dl.meta.duration,
        },
      };
    },
    schema: z.object({
      id: z.number().int().positive().describe("Freesound sound id from freesound_search"),
      name: z.string().optional(),
    }),
  },

  // ─── Status ──────────────────────────────────────────────────────────────
  {
    name: "ping",
    description: "Round-trip check that the Studio plugin is connected and responding.",
    mutates: false,
    schema: z.object({}),
  },
  {
    name: "plugin_check_updates",
    description:
      "Compare the running plugin version with the bundled plugin file shipped alongside the server. Returns whether a re-install is recommended.",
    mutates: false,
    schema: z.object({}),
  },
];

function summarizeProject(p: RojoProject): Record<string, unknown> {
  return {
    name: p.name,
    projectPath: p.projectPath,
    projectDir: p.projectDir,
    isRobloxTs: p.isRobloxTs,
    tsSourceDir: p.tsSourceDir,
    tsOutputDir: p.tsOutputDir,
    bindingCount: p.bindings.length,
    samples: p.bindings.slice(0, 8).map((b) => ({
      studioPath: b.studioPath,
      localFile: b.localFile,
      className: b.className,
    })),
  };
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);

  const parsed = tool.schema.parse(args) as Record<string, unknown>;

  if (tool.mutates && isReadOnly()) {
    throw new ReadOnlyError(name);
  }

  // ─── Rojo-aware routing for set_script_source ──────────────────────────
  // If a Rojo project is loaded and the target Studio path is mapped from
  // disk, write to the file (Rojo will sync it back). Bypass with `direct: true`.
  if (name === "set_script_source" && !parsed.direct) {
    const project = getCurrentProject();
    if (project) {
      const studioPath = parsed.path as string;
      const binding = resolveStudioPathToFile(studioPath);
      if (binding) {
        // Refuse to write to compiled TypeScript output
        const tsSource = maybeFindTsSourceForBinding(binding);
        if (tsSource) {
          throw new Error(
            `'${studioPath}' maps to compiled roblox-ts output (${binding.localFile}). ` +
              `Edit the TypeScript source instead: ${tsSource}. ` +
              `Pass 'direct: true' to override and write to Studio anyway (Rojo will overwrite on next sync).`,
          );
        }
        // Write to disk
        fs.mkdirSync(path.dirname(binding.localFile), { recursive: true });
        fs.writeFileSync(binding.localFile, parsed.source as string, "utf8");
        return {
          path: studioPath,
          bytes: (parsed.source as string).length,
          routedTo: "file",
          file: binding.localFile,
          note: "Rojo will sync this to Studio. If serve isn't running, start with rojo_serve_start.",
        };
      }
      // Path isn't Rojo-mapped — fall through to direct Studio write
    }
  }

  // Local-only tools (output capture, file sync, rojo) don't touch the plugin
  if (tool.local) {
    return await tool.local(parsed);
  }

  const result = await enqueue(name, parsed);
  if (!result.ok) {
    throw new Error(result.error ?? "Plugin returned an error with no message");
  }
  return result.data;
}
