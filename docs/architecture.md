# Architecture

## Why two processes

Roblox Studio plugins run inside Studio's Luau VM. They can use `HttpService`
freely (no permission needed for plugins, unlike runtime scripts), but they
can't expose themselves as an MCP server directly because:

- MCP transport is stdio or HTTP/SSE on the host process — the plugin isn't a
  separate OS process you can spawn from Claude
- Studio itself isn't a long-running daemon you can attach to
- Claude Code launches MCP servers on-demand via `npm`, `uvx`, or direct
  `node` commands

So we run a tiny Node MCP server on the user's machine. The plugin polls it.

## Lifecycle

1. User runs `claude mcp add roblox-supertool ...` once → registered
2. Claude Code starts a session, sees the registration, spawns
   `node build/index.js` via stdio
3. The MCP server stands up an HTTP listener on `127.0.0.1:7977`
4. The Studio plugin (already loaded in Studio) polls `POST /poll` every 200ms
5. Claude calls a tool → server pushes a `Command` onto the queue → next plugin
   poll picks it up → plugin executes → posts to `POST /result` → server
   resolves the awaiting Promise → Claude sees the result

## Why polling instead of WebSockets

`HttpService:RequestAsync` is reliable, well-supported, and trivially
debuggable with `curl`. WebSockets via Roblox plugins require third-party
libraries and add complexity. 200ms polling is well within human
perception of "responsive" and adds ~5 RPS of empty traffic — negligible.

## Single-file plugin choice

Could be modularized via Rojo. We chose single-file for:

- **Zero install friction** — drop one `.lua` into the plugins folder
- **No extra tooling** — user doesn't need Rojo, aftman, or rokit
- **Easier to debug** — open one file in Studio's script editor, set
  breakpoints, see everything

When the file passes ~1500 lines, split into `init.lua` + a sibling module
folder; Studio loads `init.lua` from a folder named `RobloxSupertool` in
the plugins dir.

## Tool naming convention

`<verb>_<object>` — `get_workspace_tree`, `set_property`, `bulk_set_property`,
`find_in_radius`. Mirrors typical CLI conventions; reads cleanly in tool-call
logs.

## Read-only mode (planned)

The `mutates` flag on each `ToolDef` exists so the server can refuse mutating
tools when read-only is on (toggle via `POST /readonly` from the widget).
Currently the plugin doesn't enforce — the next iteration will gate every
handler that mutates and return a clear error.

## What's NOT in this MCP (and why)

- **Viewport screenshots** — the official Studio MCP captures these via an
  internal API plugins can't reach. Use the official MCP for screenshots.
- **Play mode triggering** — `StudioService:Play()` is internal. Official MCP
  has it. Until Roblox exposes it to plugins, manual F5 or official MCP only.
- **Animation editor timeline scrubbing** — same deal: editor UI is plugin-opaque.
  We *can* generate `KeyframeSequence` data programmatically (see TODO).

The complementary approach: run the official Studio MCP **and** this one. They
don't conflict — they expose different tool namespaces. Claude sees the union.
