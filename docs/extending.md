# Extending Supertool

## Adding a new tool — two files, ~15 lines

### 1. Register on the server side

Edit `src/tools/registry.ts`. Add to the `TOOLS` array:

```ts
{
  name: "explode_part",
  description: "Detach a BasePart and apply outward velocity to nearby parts.",
  mutates: true,
  schema: z.object({
    path: z.string(),
    radius: z.number().positive().default(20),
    force: z.number().positive().default(500),
  }),
},
```

### 2. Implement on the plugin side

Edit `plugin/RobloxSupertool.server.lua`. Add to the `handlers` table:

```lua
handlers.explode_part = function(args)
    local part = resolvePath(args.path)
    if not part:IsA("BasePart") then error("Not a BasePart") end
    local center = part.Position
    part.Anchored = false

    local count = 0
    for _, p in ipairs(workspace:GetDescendants()) do
        if p:IsA("BasePart") and p ~= part then
            local d = (p.Position - center).Magnitude
            if d <= args.radius then
                local dir = (p.Position - center).Unit
                p:ApplyImpulse(dir * args.force)
                count = count + 1
            end
        end
    end
    return { affected = count }
end
```

Rebuild the server (`npm run build`), restart Studio (or reload the plugin),
and the tool is live.

## Available helpers in the plugin

| Helper | What it does |
|--------|--------------|
| `resolvePath(path)` | Resolve `"game.Workspace.Foo"` → Instance, errors if missing |
| `instancePath(inst)` | Get full dot path of an Instance |
| `serializeValue(v)` | Roblox value → JSON-safe (Vector3, CFrame, Color3, etc) |
| `deserializeValue(v)` | JSON → Roblox value (handles `{x,y,z}` and `__t`-tagged forms) |
| `readableProps(inst)` | Best-effort property read for an Instance |

`ChangeHistoryService:SetWaypoint(label)` before/after mutations gives Ctrl+Z support.

## Schema → JSON Schema → MCP

The Zod schema in `registry.ts` is converted to JSON Schema and exposed to
Claude via the MCP `list_tools` response. The minimal converter in `index.ts`
handles: string, number, boolean, array, enum, object, record, optional,
default. If you need a type it doesn't handle (union, refine, etc.), extend
`describe()` in `src/index.ts`.

## Adding categories

Tools are flat in the registry today. If you grow past ~30 tools, split them:

```ts
// src/tools/scripts.ts
export const SCRIPT_TOOLS: ToolDef[] = [ ... ];

// src/tools/registry.ts
import { SCRIPT_TOOLS } from "./scripts.js";
export const TOOLS = [ ...CORE_TOOLS, ...SCRIPT_TOOLS, ...ANIMATION_TOOLS ];
```

## Plugin-side patterns

**Long-running tools** — wrap in `task.spawn` if they shouldn't block the
poll loop. Send `{ ok = true, async = true }` immediately and post the real
result later via the same `id` (you'd need to add a way to defer results in
`queue.ts`).

**Mutating selection / undo** — always `ChangeHistoryService:SetWaypoint`
before and after a batch of changes. Otherwise users can't undo your tool's
effects.

**Bulk operations on huge trees** — use `:GetDescendants()` once, filter in
Lua, then mutate. Don't recurse if the tree has > 50k descendants.

**Returning Instances** — never return Instances directly. Convert to paths
with `instancePath(inst)` first; instances aren't JSON-serializable.

## Testing without Claude

Hit the server directly:

```sh
# Get pending commands (will be empty unless something queued one)
curl -X POST http://localhost:7977/poll -d '{}'

# Check status
curl http://localhost:7977/status
```

To trigger a tool from outside without going through MCP, you'd add a small
HTTP `/exec` endpoint to `http-bridge.ts` that calls `enqueue` directly.
