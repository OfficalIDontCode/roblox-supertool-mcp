# Roblox Supertool MCP — v0.5

## What's new in 0.5 — Asset scraping expansion

Three new scrapers, all with **visual search** (inline thumbnails) so the AI picks based on what assets actually look like, not blind text matching.

### Game-icons.net (~17 tools added across all scrapers)
- 4,239 CC-BY 3.0 game icons across 37 authors. Sourced from the upstream GitHub repo and rasterized locally with @resvg/resvg-js (no native deps).
- Tools: `gameicons_status`, `gameicons_search`, `gameicons_search_visual`, `gameicons_download_png`, `gameicons_download_svg`, `gameicons_upload_as_decal`.
- Color customizable: foreground / background hex, transparent backgrounds, any size from 16-2048px.

### CraftPix.net freebies
- 280+ pages of free 2D game art (sprites, tilesets, GUI, icons).
- Tools: `craftpix_status`, `craftpix_list_freebies`, `craftpix_search_visual`, `craftpix_get_detail`, `craftpix_download_preview`, `craftpix_download_freebie`, `craftpix_upload_preview_as_decal`.
- Browse + previews work without auth. Downloading the full zip needs a CraftPix login cookie (paste in the Supertool widget — see API keys section).

### Kenney.nl full-site enhancement
- Old `kenney_search` covered ~30 curated packs. New tools scrape the **entire** /assets pagination (~280 packs across 13 pages) with thumbnails and per-pack details.
- Tools: `kenney_search_all`, `kenney_search_visual`, `kenney_get_pack_detail` (description, screenshots, file count, license).

---

# Roblox Supertool MCP — v0.3

## What's new in 0.3

Massive capability expansion. Added **30+ new tools** across rigging, GUI introspection, lighting, avatar/HumanoidDescription, animation editing, EditableImage/Mesh, pathfinding, remote events, particle presets, tags/CollectionService, marketplace queries, sound playback, asset upload (Shirts/Pants/TShirts), asset moderation status, and AI image generation via local FLUX.

**Type-aware property coercion**: setting Color3 properties accepts `[r,g,b]` arrays (auto-detects 0–1 vs 0–255), `"#RRGGBB"` hex strings, or `{r,g,b}` objects. Vector3/Vector2 accept `[x,y,z]`/`{x,y,z}`. UDim2 accepts `[xs,xo,ys,yo]`. Instance reference properties (PrimaryPart, Adornee) accept string paths. EnumItem accepts `"Enum.Material.Wood"` form.

### Tier 1 — game dev productivity
- `weld_model`, `set_primary_part`, `create_constraint` — auto-rig multi-part props
- `tween_async`, `tween_cancel` — block until tween completes (returns PlaybackState)
- `gui_get_bounds`, `gui_read_state`, `gui_simulate_click` — read post-layout pixel positions, fire button clicks
- `lighting_set_effect`, `lighting_set_props`, `lighting_clear_effects` — Bloom/Blur/CC/DOF/Sun/Atmosphere/Sky factory
- `humanoid_description_build`, `humanoid_description_apply` — clothing+body+animations in one call
- `command_bar` — Edit-mode Luau exec with full plugin privileges

### Tier 2 — advanced
- `get_keyframe_sequence`, `edit_keyframe_sequence`, `humanoid_play_animation`, `humanoid_stop_animation`, `humanoid_stop_all` — animation read/edit/playback
- `editable_image_create`, `editable_image_set_pixels`, `editable_mesh_create` — procgen textures + meshes
- `pathfind`, `pathfind_visualize` — NPC waypoint generation with optional debug markers
- `remote_fire`, `remote_invoke`, `remote_listen`, `remote_drain` — RPC layer integration
- `particle_preset_apply` — curated emitters (blood, dust, sparkle, smoke, fire, magic, chips)
- `tags_add`, `tags_remove`, `tags_get`, `tags_query` — CollectionService wrappers
- `marketplace_get_product_info`, `marketplace_user_owns_gamepass`
- `sound_play` — one-shot positional sound with auto-cleanup

### Tier 3 — asset pipeline
- `asset_upload_shirt`, `asset_upload_pants`, `asset_upload_tshirt` — Open Cloud clothing upload
- `asset_status_check` — moderation status query
- `image_generate`, `image_generate_and_upload` — FLUX via local ComfyUI subprocess

### Avatar & misc
- `humanoid_unequip_all`, `humanoid_set_state_enabled`
- `plugin_reload` (informational — Studio plugins can't safely re-execute themselves)

---

# Roblox Supertool MCP — v0.2

A unified Model Context Protocol server that gives Claude (or any MCP client)
deep, structured control over a running Roblox Studio session. Built as a
single-file Studio plugin + Node.js MCP server.

Designed to complement Roblox's official built-in Studio MCP — use both
simultaneously for full coverage.

## What it does (v0.2 — 37 tools)

- **Workspace** — DataModel tree (paginated), get/set properties, create/delete instances, expanded property serializer (Vector3, CFrame, Color3, NumberSequence, ColorSequence, BrickColor, Rect, Region3, TweenInfo, Faces, PhysicalProperties, NumberRange, UDim)
- **Scripts** — read/write source, grep across all scripts, create scripts
- **Run Luau** — `run_luau` (with timeout enforced via coroutine), `run_test` (built-in `expect` assertions), `profile_luau` (perf benchmarking)
- **Output panel capture** — `tail_output` reads recent Studio Output messages (print/warn/error) captured continuously via LogService
- **Bulk ops** — `bulk_set_property` (single undo waypoint), `bulk_call` (many tools per poll cycle)
- **Spatial queries** — find parts within a radius
- **Assets** — insert from Creator Store by Asset ID
- **Animation** — `create_animation` builds KeyframeSequence from frame data; `apply_pose` snaps bones directly
- **Tween** — `tween` runs `TweenService:Create():Play()` with full options
- **Terrain** — `terrain_fill_block`, `terrain_fill_ball`, `terrain_clear_region`, `terrain_set_material_color`
- **DataStore** — `datastore_get/set/increment` (play mode only)
- **Service introspection** — `list_services`, `class_info`
- **File sync (Rojo-lite)** — watch a local folder, mirror script files into Studio
- **Selection / camera** — read & set Explorer selection, set viewport CFrame
- **Read-only mode** — toolbar button blocks all `[MUTATES]` tools server-side
- **Optional auth** — `SUPERTOOL_TOKEN` env var for shared-secret HTTP auth
- **Status widget** — dock panel: connection status, read-only indicator, recent commands log

All operations register undo waypoints via `ChangeHistoryService`, so Ctrl+Z works.

## Architecture

```
Claude  ──MCP/stdio──►  Node MCP server  ──HTTP (localhost:7977)──►  Studio plugin
                              ▲                                              │
                              └──────── results posted back ─────────────────┘
```

The plugin polls every 200ms. Commands are queued on the server; the plugin
grabs them, runs them in Luau against the DataModel, and posts results back.

## Setup (one-time)

### 1. Build the MCP server

```sh
cd C:\Dev\roblox-supertool-mcp
npm install
npm run build
```

### 2. Install the Studio plugin

Copy `plugin/RobloxSupertool.server.lua` to your Roblox plugins folder:

```
%LOCALAPPDATA%\Roblox\Plugins\
```

PowerShell one-liner:

```powershell
Copy-Item .\plugin\RobloxSupertool.server.lua "$env:LOCALAPPDATA\Roblox\Plugins\"
```

Open / restart Studio. You should see a **Supertool** button in the Plugins
toolbar — click it to open the dock widget.

### 3. Register with Claude Code

```sh
claude mcp add roblox-supertool --scope user -- node C:\Dev\roblox-supertool-mcp\build\index.js
```

Restart your Claude Code session. The supertool's tools will appear under the
`mcp__roblox-supertool__*` namespace.

## Usage

With Studio open and the MCP server running, ask Claude things like:

- *"Show me the workspace tree under game.Workspace"*
- *"Find every Part named 'Tree' in the map and recolor them dark green"*
- *"Read the source of game.ServerScriptService.GameLogic and tell me what it does"*
- *"Create a Folder named 'Spawns' in Workspace and add 5 SpawnLocations in a circle"*
- *"Run this Luau: `return #workspace:GetDescendants()`"*

## Tools (66, organized by category)

### Workspace (5)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `get_workspace_tree` | no | DataModel tree as JSON, paginated, lazy by depth |
| `get_instance` | no | Single Instance + readable properties + children |
| `set_property` | yes | Set any property on any Instance |
| `create_instance` | yes | `Instance.new` + properties + parenting |
| `delete_instance` | yes | `:Destroy()` |

### Scripts (3)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `get_script_source` | no | Read script source by path |
| `set_script_source` | yes | Replace script source (creates if missing) |
| `search_scripts` | no | Grep all scripts (split-once optimized) |

### Code execution (3)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `run_luau` | yes | Execute arbitrary Luau with enforced timeout |
| `run_test` | yes | Run Luau with built-in `expect()` assertions, return pass/fail |
| `profile_luau` | yes | Run code N times, return mean/min/max timing |

### Output panel (2)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `tail_output` | no | Read recent Studio Output (print/warn/error) — server-side buffer fed continuously by plugin |
| `clear_output_buffer` | no | Clear the captured Output buffer |

### Bulk operations (3)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `bulk_set_property` | yes | Set same property on many matches; one undo waypoint |
| `bulk_call` | yes | Run many supertool calls in one poll cycle |
| `find_in_radius` | no | Spatial query: parts within N studs |

### Animation & tween (3)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `tween` | yes | TweenService:Create():Play() with full options |
| `create_animation` | yes | Build KeyframeSequence from frame array |
| `apply_pose` | yes | Snap bone CFrames on a rigged Model |

### Terrain (4)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `terrain_fill_block` | yes | Fill block region with material |
| `terrain_fill_ball` | yes | Fill spherical region with material |
| `terrain_clear_region` | yes | Clear terrain in a region (set Air) |
| `terrain_set_material_color` | yes | Override material's render color |

### DataStore (3, play mode only)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `datastore_get` | no | GetAsync from a DataStore |
| `datastore_set` | yes | SetAsync to a DataStore |
| `datastore_increment` | yes | IncrementAsync |

### Assets / Insert (1)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `insert_asset` | yes | InsertService:LoadAsset by Asset ID |

### Open Cloud asset upload (4)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `asset_upload_image` | yes | Upload a local PNG/JPG/BMP/TGA → Roblox Decal, returns rbxassetid |
| `asset_upload_audio` | yes | Upload a local MP3/OGG/WAV → Roblox Audio, returns rbxassetid |
| `asset_upload_model` | yes | Upload a local .rbxm/.rbxmx → Roblox Model (FBX is unreliable, Studio's File → Import 3D is better for FBX) |
| `asset_apikey_status` | no | Check whether the Open Cloud key is configured (returns lastFour only — never the full key) |

Requires an Open Cloud API key entered in the **Supertool widget** in Studio
(persisted via `plugin:SetSetting`, sent to the server every poll, stored only
in memory on the server). See **API keys** below.

### Roblox Marketplace / Toolbox (6, no API key)
| Tool | Returns | Use for |
|------|---------|---------|
| `asset_search` | metadata only | Fast text search of free Toolbox assets |
| `asset_search_visual` | text + inline thumbnails | Visual selection in chat |
| `asset_get_thumbnail` | inline PNG | Preview a known public asset ID |
| `asset_get_details` | metadata for IDs | Look up specific public assets |
| `asset_list_presets` | preset list | Curated multi-tag query packs in `roblox-scraper/presets/` |
| `asset_run_preset` | grouped results | Run a preset (lego-bricks, morphs, ui-feedback, …) |

### Poly Haven — CC0 textures + models (6, no API key)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `polyhaven_search` | no | Search api.polyhaven.com for textures / hdris / models |
| `polyhaven_search_visual` | no | Same + inline thumbnails for visual selection |
| `polyhaven_get_files` | no | Show available resolutions & formats for an asset |
| `polyhaven_download_texture` | no | Download diffuse JPG to a local temp file |
| `polyhaven_download_model` | no | Download FBX to a local temp file (use Studio's File → Import 3D) |
| `polyhaven_upload_texture_as_decal` | yes | One-shot: download Poly Haven texture → upload as Roblox Decal |

### Kenney.nl — CC0 game asset packs (2, no API key)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `kenney_search` | no | Search the curated catalog of popular Kenney CC0 packs |
| `kenney_download_pack` | no | Scrape pack page for current zip URL, download the zip |

### Freesound — CC-licensed audio (4, free API key in widget)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `freesound_status` | no | Check whether the Freesound key is configured |
| `freesound_search` | no | Search freesound.org/apiv2 with license + duration filters |
| `freesound_download_preview` | no | Download HQ MP3 / OGG preview to local temp file |
| `freesound_upload_as_audio` | yes | One-shot: download preview → upload as Roblox Audio |

### Rojo integration (7)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `rojo_load_project` | no | Parse default.project.json, build Studio↔file path map |
| `rojo_get_project` | no | Return loaded project info + sample bindings |
| `rojo_resolve_studio_path` | no | Studio dot-path → local file (+ TS source if applicable) |
| `rojo_resolve_local_file` | no | Local file → Studio dot-path |
| `rojo_serve_start` | yes | Spawn `rojo serve` (Aftman binary preferred) |
| `rojo_serve_stop` | yes | Kill running serve process |
| `rojo_serve_status` | no | Running? port? binary path? |

See [Rojo integration](#rojo-integration) below for the full workflow.

### Selection & camera (3)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `get_selection` / `set_selection` | no | Explorer selection control |
| `set_camera` | no | Studio viewport camera CFrame |

### Service introspection (2)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `list_services` | no | List all Studio services with child counts |
| `class_info` | no | Best-effort property/method introspection of a class |

### File sync — Rojo-lite (3)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `file_sync_start` | yes | Watch local folder, mirror scripts into Studio |
| `file_sync_stop` | no | Stop the file watcher |
| `file_sync_status` | no | Report current sync state |

### Status (3)
| Tool | Mutates? | What it does |
|------|----------|--------------|
| `ping` | no | Round-trip connection check |
| `plugin_check_updates` | no | Compare plugin version vs server's bundled version |
| `bulk_call` (above) | yes | (also lets you batch any of the above) |

## Asset search (Roblox Marketplace / Toolbox)

Search the Roblox Creator Marketplace for free assets and **see them as
inline thumbnails** so the AI can visually pick the best one. No API keys
required — uses the same public `apis.roblox.com/toolbox-service/v1` endpoints
the official Marketplace UI calls.

### Tools

| Tool | Returns | Use for |
|------|---------|---------|
| `asset_search` | metadata only | Fast text search when you already know what you want |
| `asset_search_visual` | text + inline PNG thumbnails | When the AI needs to SEE assets to pick the best one |
| `asset_get_thumbnail` | inline PNG | Preview a known asset ID |
| `asset_get_details` | metadata for IDs | Look up specific assets you've seen elsewhere |
| `asset_list_presets` | preset list | See curated search packs in `C:\Dev\roblox-scraper\presets\` |
| `asset_run_preset` | grouped results | Run a multi-tag preset bundle (lego-bricks, morphs, ui-feedback, etc.) |

### Categories

- `audio` — sound effects, music
- `decal` — 2D images. The returned `rbxAssetId` correctly uses `textureId` (what `ImageLabel.Image` expects), not the wrapper Decal id.
- `model` — 3D models / rigs
- `meshpart` — single MeshParts
- `animation` — KeyframeSequence / Animation assets
- `plugin` — Studio plugins

### Sort options

`relevance`, `recent`, `oldest`, `downloads`, `votes` (default for finding good content).

### One-shot search → insert flow

```
asset_search_visual({
  category: "model",
  keywords: ["medieval sword"],
  sort: "votes",
  previewCount: 8,
  size: "420x420"
})
```

AI sees 8 inline thumbnails + metadata, picks one (say asset id `123456789`), then:

```
insert_asset({ assetId: 123456789, parentPath: "game.Workspace" })
```

Done — model is in your game with one tool call after picking.

### Filters

- `freeOnly: true` (default) — only items with `isFree=true`
- `minVotes: N` — net votes (up minus down) ≥ N
- `minRatio: 80` — vote ratio ≥ 80%
- `officialOnly: true` — only Roblox-verified or Roblox-official creators

### API keys / tokens

| What you want to do | Keys needed? |
|---|---|
| Search Toolbox / get details / get thumbnails | **No** |
| Insert free public asset into game | **No** (uses InsertService inside Studio) |
| Upload your own asset from disk | **Yes** — Open Cloud API key from Creator Hub |
| Edit/manage your own published assets | **Yes** — Open Cloud API key |
| Read DataStore / MemoryStore in production | **Yes** — Open Cloud API key |

For the search→insert workflow you asked about: zero keys.

## Rojo integration

If you already use Rojo, the supertool **autoroutes around it**. Once you load
your project, `set_script_source` writes to the FILE Rojo is watching instead
of writing directly to Studio — so Rojo + supertool never fight over scripts.

### Setup (once per session)

```
rojo_load_project()                 # walks up from CWD looking for default.project.json
# or
rojo_load_project({projectPath: "C:\\Dev\\primal-islands\\default.project.json"})
```

### What you get

After loading:
- Every `set_script_source` against a Rojo-mapped Studio path → writes to disk
- For **roblox-ts projects** (auto-detected via `tsconfig.json` + `@rbxts/` deps),
  writes into `out/` are **refused** with an error pointing at the matching
  `src/*.ts` file — so the AI can never edit compiled output by mistake
- Pass `direct: true` to `set_script_source` to bypass and write to Studio anyway

### Path resolution helpers

| Tool | What it does |
|------|--------------|
| `rojo_load_project(path?)` | Parse default.project.json, build the path map |
| `rojo_get_project()` | Return loaded project info + first 8 sample bindings |
| `rojo_resolve_studio_path(studioPath)` | Studio dot-path → local file (+ TS source if applicable) |
| `rojo_resolve_local_file(localPath)` | Local file → Studio dot-path |

### Managing rojo serve

| Tool | What it does |
|------|--------------|
| `rojo_serve_start(projectPath?, port?)` | Spawn `rojo serve` (Aftman binary preferred, falls back to PATH) |
| `rojo_serve_stop()` | Kill the running serve process |
| `rojo_serve_status()` | Is it running, what port, what binary path |

### Example flow (your survival game)

```
> rojo_load_project({projectPath: "C:\\Dev\\primal-islands\\default.project.json"})
{
  name: "primal-islands",
  isRobloxTs: true,
  tsSourceDir: "C:\\Dev\\primal-islands\\src",
  tsOutputDir: "C:\\Dev\\primal-islands\\out",
  bindingCount: 61,
  ...
}

> rojo_serve_start()
{ pid: 12345, port: 34872, projectPath: "..." }

# Now your AI can edit scripts
> set_script_source({
    path: "game.ServerScriptService.TS.services.GatheringSystemService",
    source: "..."
  })
ERROR: 'game.ServerScriptService.TS.services.GatheringSystemService' maps to compiled
roblox-ts output (out\server\services\GatheringSystemService.luau).
Edit the TypeScript source instead: src\server\services\GatheringSystemService.ts.
```

The AI sees the redirect immediately and goes to the source file via the Edit/Write
tools. Rojo recompiles + syncs, supertool's plugin sees the resulting Studio change.

For non-TS Rojo projects (plain Luau), the routing just writes the `.lua`/`.luau`
file directly and Rojo picks it up.

## Authentication (optional)

Set `SUPERTOOL_TOKEN` env var on the server side to require Bearer auth on the
HTTP bridge (`Authorization: Bearer <token>`). Plugin needs the same token —
edit `AUTH_TOKEN` at the top of `RobloxSupertool.server.lua`.

If unset, the bridge is open to localhost only (default behavior).

## Read-only mode

Click the **Read-Only** button in the toolbar (or `POST /readonly {value:true}`).
All tools marked `[MUTATES]` are blocked server-side until disabled.

## File sync (Rojo-lite) workflow

```
# Start syncing C:\Dev\my-game\src to game.ServerScriptService.Synced
file_sync_start({
  localDir: "C:\\Dev\\my-game\\src",
  scriptRoot: "game.ServerScriptService.Synced"
})
```

File extensions auto-classify:
- `.server.lua` → Script
- `.client.lua` → LocalScript
- `.module.lua` → ModuleScript
- `.lua` / `.luau` → Script (server) by default

Edit files in your favorite editor; changes push to Studio after a 150ms debounce.

## Extending

Adding a new tool is two files:

1. **`src/tools/registry.ts`** — add an entry to the `TOOLS` array with name,
   description, Zod schema, and `mutates` flag.
2. **`plugin/RobloxSupertool.server.lua`** — add a function to the `handlers`
   table with the same name.

The MCP server forwards by name; the plugin dispatches by name. No other
plumbing needed.

## Combining with the official Studio MCP

Roblox 2026+ ships an MCP server inside Studio itself. Enable it via
**Studio → Assistant settings → MCP**, then quick-connect to Claude.

The official one covers viewport screenshots, keyboard/mouse simulation, and
play mode — things this plugin intentionally does not duplicate. Run both
simultaneously and Claude will see all tools from both.

## Troubleshooting

- **"Plugin did not respond within 30s"** — Studio isn't running, or the
  plugin failed to load. Check the Studio Output window for `[Supertool]` logs.
- **Widget shows "Disconnected"** — The MCP server isn't running. Start it:
  `node C:\Dev\roblox-supertool-mcp\build\index.js` (or just call any MCP tool;
  Claude Code launches it on demand).
- **HTTP errors in Studio** — Make sure HttpService is allowed for plugins.
  In `File → Game Settings → Security`, "Allow HTTP Requests" applies to game
  runtime, not plugins. Plugins can always make HTTP calls.
- **Path resolution errors** — Use full paths starting with `game.` or
  `workspace.`. Example: `game.ServerScriptService.MyScript`.

## License

MIT, do whatever.
