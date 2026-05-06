# Supertool Roadmap — v0.2 buildout

Honest plan + execution log. Order is by impact, not difficulty.

## Half-done fixes (carried over from v0.1)

- [x] Read-only mode enforcement (server-side, gates `mutates: true` tools)
- [x] `run_luau` timeout actually enforced (coroutine + killswitch)
- [x] Bulk operations as single undo waypoint
- [x] `search_scripts` quadratic fix (split source once, index by line)
- [x] Property serializer extended: NumberSequence, ColorSequence, BrickColor, Rect, Region3, TweenInfo, Faces, PhysicalProperties, NumberRange, UDim
- [x] Schema converter: `z.union`, `z.literal`, `z.tuple`
- [x] `readableProps()` covers Camera, Light, Sound, ParticleEmitter, GuiObject, Attachment, Constraint, Texture, Decal, Mesh
- [x] Pagination: `get_workspace_tree` supports `cursor` for huge places
- [x] Optional shared-secret auth (`SUPERTOOL_TOKEN` env var)

## Tier 1 features

- [x] **Output panel capture** — plugin subscribes to `LogService.MessageOut`, ring buffer, `tail_output(lines)` tool. Critical for AI to see runtime errors.
- [x] **Animation tools** — `create_animation` (build `KeyframeSequence` from frame data), `save_animation_to_workspace` (drop as Animation Instance for inspection), `apply_pose` (set bone CFrames directly).
- [x] **Tween creation** — `tween(path, properties, duration, easing)` runs `TweenService:Create():Play()`.
- [x] **Terrain tools** — `terrain_fill_block`, `terrain_fill_ball`, `terrain_clear_region`, `terrain_set_material_color`.
- [x] **File watcher / Rojo-lite** — server watches a local folder; on change, pushes `set_script_source` to plugin. `start_file_sync(localDir, scriptRootPath)`, `stop_file_sync`.

## Tier 2 features

- [x] **DataStore tools** — `datastore_get`, `datastore_set`, `datastore_increment` (game testing only; only works in play mode).
- [x] **Service introspection** — `list_services`, `get_class_methods(className)`.
- [x] **Bulk-call** — `bulk_call({calls: [...]})` runs many tools in one poll cycle.

## Tier 3 features

- [x] **Performance profiler** — `profile_luau(code, iterations)` runs N times, returns mean/min/max.
- [x] **Test harness** — `run_test(code)` runs Luau with a built-in `assert(cond, msg)` collector, returns pass/fail counts.
- [x] **Plugin auto-update check** — `plugin_check_updates` returns server's bundled plugin version vs. running plugin's version, so user knows when to reinstall.

## Cut from this round (low priority, deferred)

- Local web dashboard — dock widget covers it
- Multi-Studio session targeting — needs internal Studio API anyway
- Rich MCP content returns (images embedded in tool results) — nice but not blocking
- GUI element builders — `create_instance` already works
- Asset upload pipeline — needs Roblox auth dance, separate project

## Acceptance bar

- TypeScript compiles clean
- `node build/index.js` boots, HTTP bridge listens
- Plugin loads in Studio without errors in Output
- `ping` round-trips successfully
- New tools appear in `claude mcp list` after restart
- README + extending docs updated to reflect the new surface
