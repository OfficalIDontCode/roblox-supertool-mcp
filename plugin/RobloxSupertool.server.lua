--!nocheck
--[[
    Roblox Supertool MCP — Studio Plugin
    Drop into:  %LOCALAPPDATA%\Roblox\Plugins\RobloxSupertool.server.lua

    Polls the local supertool MCP server (default http://127.0.0.1:7977),
    executes commands against the place's DataModel, returns results.
    Captures Output panel messages and pushes them up.

    v0.4.0
]]

local PLUGIN_VERSION = "0.4.0"
local SERVER_URL     = "http://127.0.0.1:7977"
local POLL_INTERVAL  = 0.2
local OUTPUT_FLUSH_INTERVAL = 0.5
local AUTH_TOKEN     = ""  -- set if SUPERTOOL_TOKEN env var is used by server

local HttpService          = game:GetService("HttpService")
local Selection            = game:GetService("Selection")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local InsertService        = game:GetService("InsertService")
local Workspace            = game:GetService("Workspace")
local LogService           = game:GetService("LogService")
local TweenService         = game:GetService("TweenService")
local ServerStorage        = game:GetService("ServerStorage")
local DataStoreService_ok, DataStoreService = pcall(game.GetService, game, "DataStoreService")

if not plugin then return end

local STUDIO_SERVICES = {
    "Workspace", "Players", "Lighting", "ReplicatedFirst", "ReplicatedStorage",
    "ServerScriptService", "ServerStorage", "StarterGui", "StarterPack",
    "StarterPlayer", "Teams", "SoundService", "Chat", "TextChatService",
    "MaterialService", "PhysicsService", "RunService", "TweenService",
    "UserInputService", "VRService", "HttpService", "ScriptContext",
    "InsertService", "MarketplaceService", "BadgeService", "GamePassService",
    "AnalyticsService", "MessagingService", "MemoryStoreService",
}

------------------------------------------------------------------------------
-- HTTP helpers
------------------------------------------------------------------------------
local function authHeaders()
    local h = { ["Content-Type"] = "application/json" }
    if AUTH_TOKEN ~= "" then h["Authorization"] = "Bearer " .. AUTH_TOKEN end
    return h
end

local function http(method, path, body)
    local ok, response = pcall(function()
        return HttpService:RequestAsync({
            Url = SERVER_URL .. path,
            Method = method,
            Headers = authHeaders(),
            Body = body and HttpService:JSONEncode(body) or nil,
        })
    end)
    if not ok or not response then return false, tostring(response) end
    if not response.Success then return false, response.StatusCode end
    if response.Body and #response.Body > 0 then
        local jOk, parsed = pcall(HttpService.JSONDecode, HttpService, response.Body)
        if jOk then return true, parsed end
    end
    return true, {}
end

------------------------------------------------------------------------------
-- Persisted settings (per-plugin, per-user — stored by Studio, never on disk
-- in this repo). Used for the Open Cloud API key + creator IDs so the user
-- only enters them once.
------------------------------------------------------------------------------
local SETTING_API_KEY         = "supertool_api_key"
local SETTING_CREATOR_USER    = "supertool_creator_user_id"
local SETTING_CREATOR_GROUP   = "supertool_creator_group_id"
local SETTING_FREESOUND_KEY   = "supertool_freesound_api_key"

local function loadSetting(name)
    local ok, value = pcall(plugin.GetSetting, plugin, name)
    if ok and type(value) == "string" then return value end
    return ""
end

local function saveSetting(name, value)
    pcall(plugin.SetSetting, plugin, name, value or "")
end

local apiKey          = loadSetting(SETTING_API_KEY)
local creatorUserId   = loadSetting(SETTING_CREATOR_USER)
local creatorGroupId  = loadSetting(SETTING_CREATOR_GROUP)
local freesoundApiKey = loadSetting(SETTING_FREESOUND_KEY)
local apiKeyStatus    = { isConfigured = false, freesound = { isConfigured = false } }

------------------------------------------------------------------------------
-- Path resolution
------------------------------------------------------------------------------
local function splitPath(path)
    local parts = {}
    for chunk in string.gmatch(path, "[^%.]+") do table.insert(parts, chunk) end
    return parts
end

local function resolvePath(path)
    local parts = splitPath(path)
    if #parts == 0 then error("empty path") end

    local cursor
    if parts[1] == "game" or parts[1] == "DataModel" then
        cursor = game
        table.remove(parts, 1)
    elseif parts[1] == "workspace" or parts[1] == "Workspace" then
        cursor = Workspace
        table.remove(parts, 1)
    else
        cursor = game:FindFirstChild(parts[1])
        if not cursor then error(string.format("Could not resolve root: %s", parts[1])) end
        table.remove(parts, 1)
    end

    for _, name in ipairs(parts) do
        local child = cursor:FindFirstChild(name)
        if not child then
            error(string.format("Path not found: %s (failed at '%s' under %s)", path, name, cursor:GetFullName()))
        end
        cursor = child
    end
    return cursor
end

local function instancePath(inst)
    if inst == game then return "game" end
    return inst:GetFullName()
end

------------------------------------------------------------------------------
-- Property serialization (extended)
------------------------------------------------------------------------------
local function serializeValue(v)
    local t = typeof(v)
    if t == "Vector3"          then return { __t = "Vector3", x = v.X, y = v.Y, z = v.Z } end
    if t == "Vector2"          then return { __t = "Vector2", x = v.X, y = v.Y } end
    if t == "Vector3int16"     then return { __t = "Vector3int16", x = v.X, y = v.Y, z = v.Z } end
    if t == "Color3"           then return { __t = "Color3", r = v.R, g = v.G, b = v.B } end
    if t == "BrickColor"       then return { __t = "BrickColor", name = v.Name } end
    if t == "CFrame"           then return { __t = "CFrame", components = { v:GetComponents() } } end
    if t == "UDim"             then return { __t = "UDim", scale = v.Scale, offset = v.Offset } end
    if t == "UDim2"            then return { __t = "UDim2", xs = v.X.Scale, xo = v.X.Offset, ys = v.Y.Scale, yo = v.Y.Offset } end
    if t == "Rect"             then return { __t = "Rect", min = { v.Min.X, v.Min.Y }, max = { v.Max.X, v.Max.Y } } end
    if t == "Region3"          then
        local cf, sz = v.CFrame, v.Size
        local pos = cf.Position
        return { __t = "Region3", min = { pos.X - sz.X/2, pos.Y - sz.Y/2, pos.Z - sz.Z/2 },
                                  max = { pos.X + sz.X/2, pos.Y + sz.Y/2, pos.Z + sz.Z/2 } }
    end
    if t == "NumberRange"      then return { __t = "NumberRange", min = v.Min, max = v.Max } end
    if t == "NumberSequence"   then
        local kp = {}
        for _, k in ipairs(v.Keypoints) do
            table.insert(kp, { time = k.Time, value = k.Value, envelope = k.Envelope })
        end
        return { __t = "NumberSequence", keypoints = kp }
    end
    if t == "ColorSequence"    then
        local kp = {}
        for _, k in ipairs(v.Keypoints) do
            table.insert(kp, { time = k.Time, color = { k.Value.R, k.Value.G, k.Value.B } })
        end
        return { __t = "ColorSequence", keypoints = kp }
    end
    if t == "Faces"            then
        return { __t = "Faces", top = v.Top, bottom = v.Bottom, left = v.Left,
                                right = v.Right, front = v.Front, back = v.Back }
    end
    if t == "PhysicalProperties" then
        return { __t = "PhysicalProperties", density = v.Density, friction = v.Friction,
                 elasticity = v.Elasticity, frictionWeight = v.FrictionWeight,
                 elasticityWeight = v.ElasticityWeight }
    end
    if t == "TweenInfo"        then
        return { __t = "TweenInfo", time = v.Time, easingStyle = v.EasingStyle.Name,
                 easingDirection = v.EasingDirection.Name, repeatCount = v.RepeatCount,
                 reverses = v.Reverses, delayTime = v.DelayTime }
    end
    if t == "Instance"         then return { __t = "Instance", path = instancePath(v), className = v.ClassName } end
    if t == "EnumItem"         then return { __t = "EnumItem", enumType = tostring(v.EnumType), name = v.Name, value = v.Value } end
    if t == "table" or t == "string" or t == "number" or t == "boolean" then return v end
    if v == nil then return nil end
    return tostring(v)
end

local function deserializeValue(v, expectedType)
    -- Type-aware coercion based on the destination property type. Lets callers
    -- pass simple JSON shapes ([r,g,b] for Color3, "path.to.Inst" for Instance refs)
    -- without having to wrap everything in __t tags.
    if expectedType ~= nil then
        if expectedType == "Instance" and type(v) == "string" then
            local ok, resolved = pcall(resolvePath, v)
            if ok and resolved then return resolved end
        elseif expectedType == "Color3" then
            if type(v) == "table" and not v.__t and #v == 3 and type(v[1]) == "number" then
                -- raw [r, g, b] — assume 0–1 if all <=1, otherwise treat as 0–255 ints
                if v[1] <= 1 and v[2] <= 1 and v[3] <= 1 then
                    return Color3.new(v[1], v[2], v[3])
                end
                return Color3.fromRGB(v[1], v[2], v[3])
            end
            if type(v) == "string" then
                -- Support "#RRGGBB" or "RRGGBB"
                local hex = v:gsub("^#", "")
                if #hex == 6 then
                    local r = tonumber(hex:sub(1, 2), 16)
                    local g = tonumber(hex:sub(3, 4), 16)
                    local b = tonumber(hex:sub(5, 6), 16)
                    if r and g and b then return Color3.fromRGB(r, g, b) end
                end
            end
            if type(v) == "table" and not v.__t and v.r ~= nil and v.g ~= nil and v.b ~= nil then
                return Color3.new(v.r, v.g, v.b)
            end
        elseif expectedType == "Vector2" then
            if type(v) == "table" and not v.__t and #v == 2 and type(v[1]) == "number" then
                return Vector2.new(v[1], v[2])
            end
            if type(v) == "table" and not v.__t and v.x ~= nil and v.y ~= nil then
                return Vector2.new(v.x, v.y)
            end
        elseif expectedType == "Vector3" then
            if type(v) == "table" and not v.__t and #v == 3 and type(v[1]) == "number" then
                return Vector3.new(v[1], v[2], v[3])
            end
            if type(v) == "table" and not v.__t and v.x ~= nil and v.y ~= nil and v.z ~= nil then
                return Vector3.new(v.x, v.y, v.z)
            end
        elseif expectedType == "UDim2" then
            if type(v) == "table" and not v.__t and #v == 4 and type(v[1]) == "number" then
                return UDim2.new(v[1], v[2], v[3], v[4])
            end
        elseif expectedType == "UDim" then
            if type(v) == "table" and not v.__t and #v == 2 and type(v[1]) == "number" then
                return UDim.new(v[1], v[2])
            end
        elseif expectedType == "BrickColor" and type(v) == "string" then
            return BrickColor.new(v)
        elseif expectedType == "EnumItem" and type(v) == "string" then
            -- caller may pass "Enum.Material.Wood" or just "Wood" if the enum is implied
            local enumName, itemName = string.match(v, "^Enum%.([^.]+)%.(.+)$")
            if enumName and Enum[enumName] then
                local ok, item = pcall(function() return Enum[enumName][itemName] end)
                if ok and item then return item end
            end
        end
    end
    if type(v) ~= "table" then return v end
    if v.__t == "Vector3"        then return Vector3.new(v.x, v.y, v.z) end
    if v.__t == "Vector2"        then return Vector2.new(v.x, v.y) end
    if v.__t == "Color3"         then return Color3.new(v.r, v.g, v.b) end
    if v.__t == "BrickColor"     then return BrickColor.new(v.name) end
    if v.__t == "CFrame"         then return CFrame.new(table.unpack(v.components)) end
    if v.__t == "UDim"           then return UDim.new(v.scale, v.offset) end
    if v.__t == "UDim2"          then return UDim2.new(v.xs, v.xo, v.ys, v.yo) end
    if v.__t == "Rect"           then return Rect.new(v.min[1], v.min[2], v.max[1], v.max[2]) end
    if v.__t == "Region3"        then return Region3.new(Vector3.new(table.unpack(v.min)), Vector3.new(table.unpack(v.max))) end
    if v.__t == "NumberRange"    then return NumberRange.new(v.min, v.max) end
    if v.__t == "NumberSequence" then
        local kp = {}
        for _, k in ipairs(v.keypoints) do
            table.insert(kp, NumberSequenceKeypoint.new(k.time, k.value, k.envelope or 0))
        end
        return NumberSequence.new(kp)
    end
    if v.__t == "ColorSequence" then
        local kp = {}
        for _, k in ipairs(v.keypoints) do
            table.insert(kp, ColorSequenceKeypoint.new(k.time, Color3.new(k.color[1], k.color[2], k.color[3])))
        end
        return ColorSequence.new(kp)
    end
    if v.__t == "Faces"            then return Faces.new(v.top and Enum.NormalId.Top, v.bottom and Enum.NormalId.Bottom, v.left and Enum.NormalId.Left, v.right and Enum.NormalId.Right, v.front and Enum.NormalId.Front, v.back and Enum.NormalId.Back) end
    if v.__t == "PhysicalProperties" then return PhysicalProperties.new(v.density, v.friction, v.elasticity, v.frictionWeight or 1, v.elasticityWeight or 1) end
    if v.__t == "TweenInfo"      then return TweenInfo.new(v.time, Enum.EasingStyle[v.easingStyle], Enum.EasingDirection[v.easingDirection], v.repeatCount or 0, v.reverses or false, v.delayTime or 0) end
    if v.__t == "EnumItem" then
        local enumType = string.match(v.enumType, "Enum%.(.+)")
        if enumType and Enum[enumType] then return Enum[enumType][v.name] end
    end
    -- Plain JSON arrays for vectors/colors as a convenience: [x,y,z]
    if #v == 3 and type(v[1]) == "number" then return Vector3.new(v[1], v[2], v[3]) end
    return v
end

------------------------------------------------------------------------------
-- Property reading per class (expanded)
------------------------------------------------------------------------------
local function readableProps(inst)
    local out = {
        Name = inst.Name,
        ClassName = inst.ClassName,
        Parent = inst.Parent and instancePath(inst.Parent) or nil,
    }

    local function tryGet(propName)
        local ok, val = pcall(function() return inst[propName] end)
        if ok then out[propName] = serializeValue(val) end
    end

    if inst:IsA("BasePart") then
        for _, p in ipairs({ "Position","Size","CFrame","Color","Material","Anchored","CanCollide",
                             "Transparency","Massless","Reflectance","TopSurface","BottomSurface",
                             "Orientation","Velocity","RotVelocity","Friction","Elasticity" }) do tryGet(p) end
    end
    if inst:IsA("LuaSourceContainer") then tryGet("Source") end
    if inst:IsA("Humanoid") then
        for _, p in ipairs({ "Health","MaxHealth","WalkSpeed","JumpPower","JumpHeight","HipHeight",
                             "RigType","UseJumpPower","DisplayName","DisplayDistanceType" }) do tryGet(p) end
    end
    if inst:IsA("Camera") then
        for _, p in ipairs({ "CFrame","Focus","FieldOfView","CameraType","CameraSubject" }) do tryGet(p) end
    end
    if inst:IsA("Light") then
        for _, p in ipairs({ "Brightness","Color","Range","Shadows","Enabled" }) do tryGet(p) end
        if inst:IsA("SpotLight") or inst:IsA("SurfaceLight") then
            for _, p in ipairs({ "Angle","Face" }) do tryGet(p) end
        end
    end
    if inst:IsA("Sound") then
        for _, p in ipairs({ "SoundId","Volume","Pitch","PlaybackSpeed","Looped","Playing","TimePosition","RollOffMode","RollOffMaxDistance" }) do tryGet(p) end
    end
    if inst:IsA("ParticleEmitter") then
        for _, p in ipairs({ "Texture","Rate","Lifetime","Speed","Rotation","RotSpeed","Drag","Acceleration",
                             "EmissionDirection","Color","Size","Transparency","Squash","SpreadAngle","Enabled","LightEmission","LightInfluence" }) do tryGet(p) end
    end
    if inst:IsA("GuiObject") then
        for _, p in ipairs({ "Position","Size","AnchorPoint","BackgroundColor3","BackgroundTransparency",
                             "BorderSizePixel","Visible","ZIndex","Rotation","ClipsDescendants","Active","Selectable" }) do tryGet(p) end
        if inst:IsA("TextLabel") or inst:IsA("TextButton") or inst:IsA("TextBox") then
            for _, p in ipairs({ "Text","TextColor3","TextSize","Font","TextScaled","TextXAlignment","TextYAlignment","RichText" }) do tryGet(p) end
        end
        if inst:IsA("ImageLabel") or inst:IsA("ImageButton") then
            for _, p in ipairs({ "Image","ImageColor3","ImageTransparency","ScaleType","SliceCenter" }) do tryGet(p) end
        end
    end
    if inst:IsA("Attachment") then
        for _, p in ipairs({ "Position","Orientation","Visible","WorldPosition","WorldOrientation" }) do tryGet(p) end
    end
    if inst:IsA("Constraint") then
        for _, p in ipairs({ "Enabled","Visible","Attachment0","Attachment1","Color" }) do tryGet(p) end
    end
    if inst:IsA("Texture") or inst:IsA("Decal") then
        for _, p in ipairs({ "Texture","Color3","Transparency","Face","StudsPerTileU","StudsPerTileV" }) do tryGet(p) end
    end
    if inst:IsA("DataModelMesh") or inst:IsA("MeshPart") or inst:IsA("SpecialMesh") then
        for _, p in ipairs({ "MeshId","TextureID","TextureId","Scale","Offset","VertexColor","MeshType" }) do tryGet(p) end
    end
    if inst:IsA("Animation") then tryGet("AnimationId") end
    if inst:IsA("Folder") or inst:IsA("Model") then
        if inst:IsA("Model") then for _, p in ipairs({ "PrimaryPart","WorldPivot" }) do tryGet(p) end end
    end

    return out
end

------------------------------------------------------------------------------
-- Tool handlers
------------------------------------------------------------------------------
local handlers = {}

handlers.ping = function(args)
    return {
        ok = true,
        pluginVersion = PLUGIN_VERSION,
        placeId = game.PlaceId,
        placeName = game.Name,
    }
end

handlers.get_workspace_tree = function(args)
    local path = args.path or "game"
    local maxDepth = args.maxDepth or 3
    local maxNodes = args.maxNodes or 800
    local includeProperties = args.includeProperties == true
    local root = resolvePath(path)

    local nodeCount = 0
    local truncated = false

    local function walk(inst, depth)
        if nodeCount >= maxNodes then truncated = true; return nil end
        nodeCount = nodeCount + 1
        local node = {
            name = inst.Name,
            className = inst.ClassName,
            path = instancePath(inst),
            childCount = #inst:GetChildren(),
        }
        if includeProperties then node.properties = readableProps(inst) end
        if depth < maxDepth then
            local children = {}
            for _, c in ipairs(inst:GetChildren()) do
                local child = walk(c, depth + 1)
                if child then table.insert(children, child) end
                if nodeCount >= maxNodes then break end
            end
            if #children > 0 then node.children = children end
        end
        return node
    end

    local tree = walk(root, 0)
    return { tree = tree, truncated = truncated, nodesReturned = nodeCount, maxNodes = maxNodes }
end

handlers.get_instance = function(args)
    local inst = resolvePath(args.path)
    local children = {}
    for _, c in ipairs(inst:GetChildren()) do
        table.insert(children, { name = c.Name, className = c.ClassName, path = instancePath(c) })
    end
    return {
        path = instancePath(inst),
        properties = readableProps(inst),
        children = children,
    }
end

handlers.set_property = function(args)
    local inst = resolvePath(args.path)
    local expectedType
    local typeOk, existing = pcall(function() return inst[args.property] end)
    if typeOk then expectedType = typeof(existing) end
    local value = deserializeValue(args.value, expectedType)
    ChangeHistoryService:SetWaypoint("supertool: set_property " .. args.property)
    inst[args.property] = value
    ChangeHistoryService:SetWaypoint("supertool: set_property done")
    return { ok = true, path = instancePath(inst), property = args.property }
end

handlers.create_instance = function(args)
    local parent = resolvePath(args.parentPath or "game.Workspace")
    ChangeHistoryService:SetWaypoint("supertool: create_instance " .. args.className)
    local inst = Instance.new(args.className)
    if args.name then inst.Name = args.name end
    if args.properties then
        for k, v in pairs(args.properties) do
            local expectedType
            local typeOk, existing = pcall(function() return inst[k] end)
            if typeOk then expectedType = typeof(existing) end
            local ok, err = pcall(function() inst[k] = deserializeValue(v, expectedType) end)
            if not ok then inst:Destroy(); error("Failed to set property " .. k .. ": " .. tostring(err)) end
        end
    end
    inst.Parent = parent
    ChangeHistoryService:SetWaypoint("supertool: create_instance done")
    return { path = instancePath(inst), className = inst.ClassName }
end

handlers.delete_instance = function(args)
    local inst = resolvePath(args.path)
    local path = instancePath(inst)
    ChangeHistoryService:SetWaypoint("supertool: delete " .. path)
    inst:Destroy()
    return { deleted = path }
end

handlers.get_script_source = function(args)
    local inst = resolvePath(args.path)
    if not inst:IsA("LuaSourceContainer") then error("Not a script: " .. args.path .. " (got " .. inst.ClassName .. ")") end
    return { path = instancePath(inst), className = inst.ClassName, source = inst.Source }
end

handlers.set_script_source = function(args)
    local ok, inst = pcall(resolvePath, args.path)
    if not ok or not inst then
        if not args.createIfMissing then error("Script not found: " .. args.path .. " (use createIfMissing=true)") end
        local parts = splitPath(args.path)
        local scriptName = table.remove(parts)
        local parent = resolvePath(table.concat(parts, "."))
        inst = Instance.new(args.className or "Script")
        inst.Name = scriptName
        inst.Parent = parent
    end
    if not inst:IsA("LuaSourceContainer") then error("Not a script container: " .. args.path) end
    ChangeHistoryService:SetWaypoint("supertool: edit script " .. args.path)
    inst.Source = args.source
    ChangeHistoryService:SetWaypoint("supertool: edit done")
    return { path = instancePath(inst), bytes = #args.source }
end

handlers.search_scripts = function(args)
    local pattern = args.pattern
    local literal = args.literal ~= false
    local caseSensitive = args.caseSensitive == true
    local maxResults = args.maxResults or 100
    local needle = caseSensitive and pattern or string.lower(pattern)

    local results = {}
    local function scan(inst)
        if #results >= maxResults then return end
        if inst:IsA("LuaSourceContainer") then
            local src = inst.Source
            local lines = src:split("\n")  -- split ONCE
            for lineNum, line in ipairs(lines) do
                local hay = caseSensitive and line or string.lower(line)
                local hit = literal and (string.find(hay, needle, 1, true) ~= nil) or (string.find(hay, needle) ~= nil)
                if hit then
                    table.insert(results, {
                        path = instancePath(inst),
                        line = lineNum,
                        text = string.sub(line, 1, 200),
                    })
                    if #results >= maxResults then return end
                end
            end
        end
        for _, c in ipairs(inst:GetChildren()) do scan(c) end
    end
    scan(game)
    return { matches = results, total = #results }
end

------------------------------------------------------------------------------
-- run_luau with timeout (coroutine + killswitch via task.delay)
------------------------------------------------------------------------------
local function runLuauWithTimeout(code, timeoutMs)
    local outputs = {}
    local function captureOutput(...)
        local args = { ... }
        local strs = {}
        for i = 1, select("#", ...) do strs[i] = tostring(args[i]) end
        table.insert(outputs, table.concat(strs, "\t"))
    end

    local env = setmetatable({
        print = captureOutput,
        warn = captureOutput,
        game = game, workspace = workspace,
    }, { __index = getfenv(0) })

    local fn, compileErr = loadstring(code)
    if not fn then
        return { ok = false, error = "compile error: " .. tostring(compileErr) }
    end
    setfenv(fn, env)

    local startedAt = tick()
    local done = false
    local results
    local ok, err

    local co = coroutine.create(function()
        results = { pcall(fn) }
        ok = table.remove(results, 1)
        if not ok then err = results[1] end
        done = true
    end)

    coroutine.resume(co)

    -- Poll for completion or timeout
    local timeoutS = timeoutMs / 1000
    local pollStart = tick()
    while not done and (tick() - pollStart) < timeoutS do
        task.wait(0.01)
    end

    local elapsed = (tick() - startedAt) * 1000

    if not done then
        return { ok = false, error = string.format("timeout after %dms", timeoutMs), output = outputs, elapsedMs = elapsed }
    end
    if not ok then
        return { ok = false, error = tostring(err), output = outputs, elapsedMs = elapsed }
    end

    local serialized = {}
    for i, r in ipairs(results) do serialized[i] = serializeValue(r) end
    return { ok = true, returns = serialized, output = outputs, elapsedMs = elapsed }
end

handlers.run_luau = function(args)
    return runLuauWithTimeout(args.code or "", args.timeoutMs or 5000)
end

handlers.run_test = function(args)
    -- Inject an `expect` helper that records pass/fail
    local prelude = [[
local _passes, _failures = 0, {}
local function expect(cond, msg)
    if cond then _passes = _passes + 1
    else table.insert(_failures, msg or "assertion failed") end
end
_G.expect = expect
]]
    local epilogue = [[
return _passes, _failures
]]
    local result = runLuauWithTimeout(prelude .. (args.code or "") .. "\n" .. epilogue, args.timeoutMs or 5000)
    if not result.ok then return result end
    local passes = result.returns[1] or 0
    local failures = result.returns[2] or {}
    -- failures is serialized as a table; need to extract array
    if type(failures) == "table" then
        local list = {}
        for _, f in ipairs(failures) do table.insert(list, f) end
        failures = list
    end
    return {
        ok = true,
        passes = passes,
        failures = failures,
        failureCount = #failures,
        output = result.output,
        elapsedMs = result.elapsedMs,
    }
end

handlers.profile_luau = function(args)
    local code = args.code or ""
    local iterations = args.iterations or 100
    local fn, compileErr = loadstring(code)
    if not fn then return { ok = false, error = "compile error: " .. tostring(compileErr) } end

    local samples = {}
    for i = 1, iterations do
        local s = tick()
        pcall(fn)
        table.insert(samples, (tick() - s) * 1000)
    end

    local total, mn, mx = 0, math.huge, 0
    for _, t in ipairs(samples) do
        total = total + t
        if t < mn then mn = t end
        if t > mx then mx = t end
    end
    local mean = total / iterations
    return { iterations = iterations, meanMs = mean, minMs = mn, maxMs = mx, totalMs = total }
end

handlers.insert_asset = function(args)
    ChangeHistoryService:SetWaypoint("supertool: insert_asset " .. tostring(args.assetId))
    local model = InsertService:LoadAsset(args.assetId)
    local parent = resolvePath(args.parentPath or "game.Workspace")
    local children = model:GetChildren()
    for _, c in ipairs(children) do c.Parent = parent end
    model:Destroy()
    local paths = {}
    for _, c in ipairs(children) do table.insert(paths, instancePath(c)) end
    return { inserted = paths, count = #paths }
end

handlers.bulk_set_property = function(args)
    local root = resolvePath(args.rootPath or "game.Workspace")
    local property = args.property
    local value = deserializeValue(args.value)
    local className = args.className
    local nameMatch = args.nameMatch

    -- SINGLE waypoint pair for the whole batch
    ChangeHistoryService:SetWaypoint("supertool: bulk " .. property)
    local count, errors = 0, 0
    local function visit(inst)
        local matchesClass = (not className) or inst:IsA(className)
        local matchesName = (not nameMatch) or (string.match(inst.Name, nameMatch) ~= nil)
        if matchesClass and matchesName then
            local ok = pcall(function() inst[property] = value end)
            if ok then count = count + 1 else errors = errors + 1 end
        end
        for _, c in ipairs(inst:GetChildren()) do visit(c) end
    end
    visit(root)
    ChangeHistoryService:SetWaypoint("supertool: bulk done")
    return { modified = count, errors = errors, property = property, root = instancePath(root) }
end

handlers.bulk_call = function(args)
    local results = {}
    for _, call in ipairs(args.calls or {}) do
        local handler = handlers[call.tool]
        if not handler then
            table.insert(results, { ok = false, error = "Unknown tool: " .. call.tool })
        else
            local ok, res = pcall(handler, call.args or {})
            if ok then
                table.insert(results, { ok = true, data = res })
            else
                table.insert(results, { ok = false, error = tostring(res) })
            end
        end
    end
    return { results = results, count = #results }
end

handlers.find_in_radius = function(args)
    local center = Vector3.new(args.center[1], args.center[2], args.center[3])
    local radius = args.radius
    local classFilter = args.classFilter or "BasePart"
    local maxResults = args.maxResults or 200

    local results = {}
    local function visit(inst)
        if #results >= maxResults then return end
        if inst:IsA(classFilter) and inst:IsA("BasePart") then
            local d = (inst.Position - center).Magnitude
            if d <= radius then table.insert(results, { path = instancePath(inst), distance = d }) end
        end
        for _, c in ipairs(inst:GetChildren()) do visit(c) end
    end
    visit(Workspace)
    table.sort(results, function(a, b) return a.distance < b.distance end)
    return { count = #results, results = results }
end

handlers.get_selection = function(args)
    local sel = Selection:Get()
    local paths = {}
    for _, inst in ipairs(sel) do table.insert(paths, instancePath(inst)) end
    return { paths = paths, count = #paths }
end

handlers.set_selection = function(args)
    local objs = {}
    for _, p in ipairs(args.paths or {}) do
        local ok, inst = pcall(resolvePath, p)
        if ok then table.insert(objs, inst) end
    end
    Selection:Set(objs)
    return { selected = #objs }
end

handlers.set_camera = function(args)
    local cam = Workspace.CurrentCamera
    if not cam then error("No CurrentCamera") end
    local pos = Vector3.new(args.position[1], args.position[2], args.position[3])
    local look = Vector3.new(args.lookAt[1], args.lookAt[2], args.lookAt[3])
    cam.CFrame = CFrame.lookAt(pos, look)
    return { ok = true }
end

handlers.camera_get = function()
    local cam = Workspace.CurrentCamera
    if not cam then error("No CurrentCamera") end
    local cf = cam.CFrame
    local pos = cf.Position
    local look = cf.LookVector
    return {
        position = { pos.X, pos.Y, pos.Z },
        lookVector = { look.X, look.Y, look.Z },
        focus = { cam.Focus.Position.X, cam.Focus.Position.Y, cam.Focus.Position.Z },
        fieldOfView = cam.FieldOfView,
        cameraType = tostring(cam.CameraType),
    }
end

handlers.camera_focus_on = function(args)
    local cam = Workspace.CurrentCamera
    if not cam then error("No CurrentCamera") end
    local target = resolvePath(args.path)
    local center, radius
    if target:IsA("BasePart") then
        center = target.Position
        radius = target.Size.Magnitude * 0.5
    elseif target:IsA("Model") then
        local cf, size = target:GetBoundingBox()
        center = cf.Position
        radius = size.Magnitude * 0.5
    else
        error("Target must be BasePart or Model: " .. tostring(target.ClassName))
    end
    local distance = math.max((args.distance or radius * 2.5), 6)
    local angle = args.angle or 35
    local rad = math.rad(angle)
    local offset = Vector3.new(math.sin(rad) * distance, distance * 0.5, math.cos(rad) * distance)
    cam.CFrame = CFrame.lookAt(center + offset, center)
    cam.Focus = CFrame.new(center)
    return {
        ok = true,
        target = instancePath(target),
        center = { center.X, center.Y, center.Z },
        distance = distance,
    }
end

handlers.camera_orbit = function(args)
    local cam = Workspace.CurrentCamera
    if not cam then error("No CurrentCamera") end
    local cur = cam.CFrame.Position
    local center
    if args.center then
        center = Vector3.new(args.center[1], args.center[2], args.center[3])
    elseif args.path then
        local target = resolvePath(args.path)
        if target:IsA("BasePart") then
            center = target.Position
        elseif target:IsA("Model") then
            center = target:GetBoundingBox().Position
        end
    else
        center = cam.Focus.Position
    end
    if not center then error("orbit needs center or path") end
    local delta = cur - center
    local distance = args.distance or delta.Magnitude
    local angleDeg = args.angleDelta or 30
    local rad = math.rad(angleDeg)
    local cosA, sinA = math.cos(rad), math.sin(rad)
    local rotated = Vector3.new(
        delta.X * cosA - delta.Z * sinA,
        delta.Y,
        delta.X * sinA + delta.Z * cosA
    )
    if distance ~= delta.Magnitude and rotated.Magnitude > 0 then
        rotated = rotated.Unit * distance
    end
    cam.CFrame = CFrame.lookAt(center + rotated, center)
    cam.Focus = CFrame.new(center)
    return { ok = true, position = { (center + rotated).X, (center + rotated).Y, (center + rotated).Z } }
end

handlers.camera_zoom_selection = function(args)
    local cam = Workspace.CurrentCamera
    if not cam then error("No CurrentCamera") end
    local sel = Selection:Get()
    if #sel == 0 then return { ok = false, error = "No selection" } end
    local minP, maxP
    local function expand(p)
        if not minP then minP = p; maxP = p; return end
        minP = Vector3.new(math.min(minP.X, p.X), math.min(minP.Y, p.Y), math.min(minP.Z, p.Z))
        maxP = Vector3.new(math.max(maxP.X, p.X), math.max(maxP.Y, p.Y), math.max(maxP.Z, p.Z))
    end
    for _, inst in ipairs(sel) do
        if inst:IsA("BasePart") then
            expand(inst.Position - inst.Size * 0.5)
            expand(inst.Position + inst.Size * 0.5)
        elseif inst:IsA("Model") then
            local cf, size = inst:GetBoundingBox()
            expand(cf.Position - size * 0.5)
            expand(cf.Position + size * 0.5)
        end
    end
    if not minP then return { ok = false, error = "Selection has no parts" } end
    local center = (minP + maxP) * 0.5
    local size = maxP - minP
    local radius = size.Magnitude * 0.5
    local distance = math.max((args and args.distance) or radius * 2.2, 8)
    local angle = (args and args.angle) or 35
    local rad = math.rad(angle)
    local offset = Vector3.new(math.sin(rad) * distance, distance * 0.5, math.cos(rad) * distance)
    cam.CFrame = CFrame.lookAt(center + offset, center)
    cam.Focus = CFrame.new(center)
    return { ok = true, center = { center.X, center.Y, center.Z }, distance = distance }
end

handlers.camera_set_fov = function(args)
    local cam = Workspace.CurrentCamera
    if not cam then error("No CurrentCamera") end
    cam.FieldOfView = math.clamp(tonumber(args.fov) or 70, 1, 120)
    return { ok = true, fov = cam.FieldOfView }
end

------------------------------------------------------------------------------
-- Tween
------------------------------------------------------------------------------
handlers.tween = function(args)
    local inst = resolvePath(args.path)
    local props = {}
    for k, v in pairs(args.properties) do
        local existingOk, existing = pcall(function() return inst[k] end)
        local expectedType = existingOk and typeof(existing) or nil
        props[k] = deserializeValue(v, expectedType)
    end
    local info = TweenInfo.new(
        args.duration or 1.0,
        Enum.EasingStyle[args.easingStyle or "Quad"],
        Enum.EasingDirection[args.easingDirection or "Out"],
        args.repeatCount or 0,
        args.reverses or false,
        args.delayTime or 0
    )
    local tw = TweenService:Create(inst, info, props)
    tw:Play()
    return { ok = true, path = instancePath(inst), durationS = args.duration }
end

-- Active tween registry for tween_async / tween_cancel
local activeTweens = {}
local nextTweenId = 0

handlers.tween_async = function(args)
    local inst = resolvePath(args.path)
    local props = {}
    for k, v in pairs(args.properties) do
        local existingOk, existing = pcall(function() return inst[k] end)
        local expectedType = existingOk and typeof(existing) or nil
        props[k] = deserializeValue(v, expectedType)
    end
    local info = TweenInfo.new(
        args.duration or 1.0,
        Enum.EasingStyle[args.easingStyle or "Quad"],
        Enum.EasingDirection[args.easingDirection or "Out"],
        args.repeatCount or 0,
        args.reverses or false,
        args.delayTime or 0
    )
    local tw = TweenService:Create(inst, info, props)
    nextTweenId = nextTweenId + 1
    local id = "tw_" .. nextTweenId
    activeTweens[id] = tw

    local timeout = args.timeoutS or math.max(2.0, (args.duration or 1.0) * 1.2 + 0.5)
    local resultState
    local conn
    conn = tw.Completed:Connect(function(state)
        resultState = state
        conn:Disconnect()
    end)
    tw:Play()

    local elapsed = 0
    while resultState == nil and elapsed < timeout do
        task.wait(0.05)
        elapsed = elapsed + 0.05
    end
    activeTweens[id] = nil
    if resultState == nil then
        return { ok = false, error = "tween timed out", id = id }
    end
    return { ok = true, id = id, state = resultState.Name, durationS = elapsed }
end

handlers.tween_cancel = function(args)
    local id = args.id
    local tw = activeTweens[id]
    if not tw then return { ok = false, error = "unknown tween id" } end
    tw:Cancel()
    activeTweens[id] = nil
    return { ok = true }
end

------------------------------------------------------------------------------
-- Rigging & welding helpers
------------------------------------------------------------------------------
handlers.weld_model = function(args)
    local model = resolvePath(args.path)
    if not model:IsA("Model") then error("weld_model: target is not a Model: " .. tostring(args.path)) end

    local parts = {}
    for _, d in ipairs(model:GetDescendants()) do
        if d:IsA("BasePart") then table.insert(parts, d) end
    end
    if #parts == 0 then error("weld_model: model has no BaseParts") end

    local handle
    if args.handleName then
        for _, p in ipairs(parts) do
            if p.Name == args.handleName then handle = p; break end
        end
        if not handle then error("weld_model: no part named '" .. args.handleName .. "' in model") end
    elseif model.PrimaryPart then
        handle = model.PrimaryPart
    else
        local maxVol = -1
        for _, p in ipairs(parts) do
            local v = p.Size.X * p.Size.Y * p.Size.Z
            if v > maxVol then maxVol = v; handle = p end
        end
    end

    ChangeHistoryService:SetWaypoint("supertool: weld_model " .. model.Name)
    model.PrimaryPart = handle
    local welded = 0
    for _, p in ipairs(parts) do
        p.Anchored = false
        if p ~= handle then
            -- Avoid duplicate welds
            local hasWeld = false
            for _, c in ipairs(handle:GetChildren()) do
                if c:IsA("WeldConstraint") and ((c.Part0 == handle and c.Part1 == p) or (c.Part0 == p and c.Part1 == handle)) then
                    hasWeld = true; break
                end
            end
            if not hasWeld then
                local w = Instance.new("WeldConstraint")
                w.Part0 = handle
                w.Part1 = p
                w.Parent = handle
                welded = welded + 1
            end
        end
    end
    ChangeHistoryService:SetWaypoint("supertool: weld_model done")
    return { ok = true, handle = handle.Name, welded = welded, totalParts = #parts }
end

handlers.set_primary_part = function(args)
    local model = resolvePath(args.modelPath)
    local part = resolvePath(args.partPath)
    if not model:IsA("Model") then error("set_primary_part: target is not a Model") end
    if not part:IsA("BasePart") then error("set_primary_part: partPath does not resolve to a BasePart") end
    ChangeHistoryService:SetWaypoint("supertool: set_primary_part")
    model.PrimaryPart = part
    return { ok = true, model = instancePath(model), primaryPart = instancePath(part) }
end

handlers.create_constraint = function(args)
    local kind = args.kind
    local validKinds = {
        WeldConstraint = true, HingeConstraint = true, BallSocketConstraint = true,
        RopeConstraint = true, SpringConstraint = true, RodConstraint = true,
        Motor6D = true, AlignPosition = true, AlignOrientation = true,
        LinearVelocity = true, AngularVelocity = true,
    }
    if not validKinds[kind] then
        error("create_constraint: unknown kind '" .. tostring(kind) .. "'")
    end
    local part0 = resolvePath(args.part0Path)
    local part1 = resolvePath(args.part1Path)
    if not part0:IsA("BasePart") or not part1:IsA("BasePart") then
        error("create_constraint: part0 and part1 must be BaseParts")
    end

    ChangeHistoryService:SetWaypoint("supertool: create_constraint " .. kind)
    local constraint = Instance.new(kind)
    constraint.Name = args.name or kind

    if kind == "WeldConstraint" then
        constraint.Part0 = part0
        constraint.Part1 = part1
    elseif kind == "Motor6D" then
        constraint.Part0 = part0
        constraint.Part1 = part1
    else
        -- Constraint-based kinds need Attachment0/1
        local function ensureAttachment(part, suppliedPath)
            if suppliedPath then return resolvePath(suppliedPath) end
            local a = Instance.new("Attachment")
            a.Name = kind .. "_Attachment"
            a.Parent = part
            return a
        end
        constraint.Attachment0 = ensureAttachment(part0, args.attachment0)
        constraint.Attachment1 = ensureAttachment(part1, args.attachment1)
    end

    if args.properties then
        for k, v in pairs(args.properties) do
            local existingOk, existing = pcall(function() return constraint[k] end)
            local expectedType = existingOk and typeof(existing) or nil
            local ok, err = pcall(function() constraint[k] = deserializeValue(v, expectedType) end)
            if not ok then warn("create_constraint: failed to set " .. k .. ": " .. tostring(err)) end
        end
    end

    constraint.Parent = part0
    if part0.Anchored and part1.Anchored then
        warn("create_constraint: both parts are Anchored — constraint will have no effect")
    end
    ChangeHistoryService:SetWaypoint("supertool: create_constraint done")
    return { ok = true, path = instancePath(constraint), kind = kind }
end

------------------------------------------------------------------------------
-- GUI introspection
------------------------------------------------------------------------------
local function isEffectivelyVisible(g)
    local cur = g
    while cur and cur:IsA("GuiObject") do
        if not cur.Visible then return false end
        cur = cur.Parent
    end
    if cur and cur:IsA("ScreenGui") then return cur.Enabled end
    if cur and cur:IsA("SurfaceGui") then return cur.Enabled end
    if cur and cur:IsA("BillboardGui") then return cur.Enabled end
    return true
end

local function readGuiNode(node)
    local out = {
        path = instancePath(node),
        className = node.ClassName,
        name = node.Name,
        visible = node.Visible,
        effectiveVisible = isEffectivelyVisible(node),
        zIndex = node.ZIndex,
        backgroundTransparency = node.BackgroundTransparency,
        absolutePosition = { x = node.AbsolutePosition.X, y = node.AbsolutePosition.Y },
        absoluteSize = { x = node.AbsoluteSize.X, y = node.AbsoluteSize.Y },
    }
    if node:IsA("TextLabel") or node:IsA("TextButton") or node:IsA("TextBox") then
        out.text = node.Text
        out.textSize = node.TextSize
    end
    if node:IsA("ImageLabel") or node:IsA("ImageButton") then
        out.image = node.Image
    end
    return out
end

handlers.gui_get_bounds = function(args)
    local inst = resolvePath(args.path)
    if not inst:IsA("GuiObject") then error("gui_get_bounds: target is not a GuiObject") end
    return readGuiNode(inst)
end

handlers.gui_read_state = function(args)
    local root = resolvePath(args.path)
    local maxNodes = args.maxNodes or 200
    local results = {}
    local count = 0
    local function visit(n)
        if count >= maxNodes then return end
        if n:IsA("GuiObject") then
            count = count + 1
            table.insert(results, readGuiNode(n))
        end
        for _, child in ipairs(n:GetChildren()) do visit(child) end
    end
    visit(root)
    return { count = count, nodes = results }
end

handlers.gui_simulate_click = function(args)
    local inst = resolvePath(args.path)
    if not (inst:IsA("TextButton") or inst:IsA("ImageButton")) then
        error("gui_simulate_click: target is not a TextButton or ImageButton")
    end
    if not isEffectivelyVisible(inst) then
        if not args.force then
            return { ok = false, error = "button is not effectively visible (use force=true to override)" }
        end
    end
    -- Fire both Activated and MouseButton1Click for compatibility
    local ok1, err1 = pcall(function() inst.Activated:Fire(0) end)
    if not ok1 then warn("gui_simulate_click Activated: " .. tostring(err1)) end
    local ok2, err2 = pcall(function() inst.MouseButton1Click:Fire() end)
    if not ok2 then warn("gui_simulate_click MouseButton1Click: " .. tostring(err2)) end
    return { ok = true, path = instancePath(inst) }
end

------------------------------------------------------------------------------
-- Lighting & atmosphere
------------------------------------------------------------------------------
local LIGHTING_EFFECT_KINDS = {
    Bloom = "BloomEffect",
    BloomEffect = "BloomEffect",
    Blur = "BlurEffect",
    BlurEffect = "BlurEffect",
    ColorCorrection = "ColorCorrectionEffect",
    ColorCorrectionEffect = "ColorCorrectionEffect",
    DepthOfField = "DepthOfFieldEffect",
    DepthOfFieldEffect = "DepthOfFieldEffect",
    SunRays = "SunRaysEffect",
    SunRaysEffect = "SunRaysEffect",
    Atmosphere = "Atmosphere",
    Sky = "Sky",
}

handlers.lighting_set_effect = function(args)
    local resolvedKind = LIGHTING_EFFECT_KINDS[args.kind]
    if not resolvedKind then
        error("lighting_set_effect: unknown kind '" .. tostring(args.kind) .. "'")
    end
    local Lighting = game:GetService("Lighting")
    ChangeHistoryService:SetWaypoint("supertool: lighting_set_effect " .. resolvedKind)
    local existing = Lighting:FindFirstChildOfClass(resolvedKind)
    local inst = existing or Instance.new(resolvedKind)
    inst.Name = args.name or resolvedKind
    if args.properties then
        for k, v in pairs(args.properties) do
            local existingOk, existingValue = pcall(function() return inst[k] end)
            local expectedType = existingOk and typeof(existingValue) or nil
            local ok, err = pcall(function() inst[k] = deserializeValue(v, expectedType) end)
            if not ok then warn("lighting_set_effect: failed to set " .. k .. ": " .. tostring(err)) end
        end
    end
    inst.Parent = Lighting
    return { ok = true, path = instancePath(inst), kind = resolvedKind, created = existing == nil }
end

handlers.lighting_set_props = function(args)
    local Lighting = game:GetService("Lighting")
    ChangeHistoryService:SetWaypoint("supertool: lighting_set_props")
    local set = {}
    for k, v in pairs(args.properties or {}) do
        local existingOk, existing = pcall(function() return Lighting[k] end)
        local expectedType = existingOk and typeof(existing) or nil
        local ok, err = pcall(function() Lighting[k] = deserializeValue(v, expectedType) end)
        if ok then table.insert(set, k) else warn("lighting_set_props: " .. k .. ": " .. tostring(err)) end
    end
    return { ok = true, set = set }
end

handlers.lighting_clear_effects = function(args)
    local Lighting = game:GetService("Lighting")
    ChangeHistoryService:SetWaypoint("supertool: lighting_clear_effects")
    local removed = 0
    for _, child in ipairs(Lighting:GetChildren()) do
        if child:IsA("PostEffect") or child:IsA("BloomEffect") or child:IsA("BlurEffect")
           or child:IsA("ColorCorrectionEffect") or child:IsA("DepthOfFieldEffect")
           or child:IsA("SunRaysEffect") or child:IsA("Atmosphere") or child:IsA("Sky") then
            child:Destroy()
            removed = removed + 1
        end
    end
    return { ok = true, removed = removed }
end

------------------------------------------------------------------------------
-- HumanoidDescription
------------------------------------------------------------------------------
handlers.humanoid_description_build = function(args)
    local hd = Instance.new("HumanoidDescription")
    local function setIfGiven(key, val)
        if val == nil then return end
        local ok, err = pcall(function() hd[key] = val end)
        if not ok then warn("humanoid_description_build: failed to set " .. key .. ": " .. tostring(err)) end
    end
    setIfGiven("Shirt", args.shirt)
    setIfGiven("Pants", args.pants)
    setIfGiven("GraphicTShirt", args.tshirt)
    setIfGiven("Face", args.face)
    setIfGiven("Head", args.head)
    setIfGiven("Torso", args.torso)
    setIfGiven("LeftArm", args.leftArm)
    setIfGiven("RightArm", args.rightArm)
    setIfGiven("LeftLeg", args.leftLeg)
    setIfGiven("RightLeg", args.rightLeg)
    setIfGiven("HeadColor", args.headColor and deserializeValue(args.headColor, "Color3"))
    setIfGiven("TorsoColor", args.torsoColor and deserializeValue(args.torsoColor, "Color3"))
    setIfGiven("LeftArmColor", args.leftArmColor and deserializeValue(args.leftArmColor, "Color3"))
    setIfGiven("RightArmColor", args.rightArmColor and deserializeValue(args.rightArmColor, "Color3"))
    setIfGiven("LeftLegColor", args.leftLegColor and deserializeValue(args.leftLegColor, "Color3"))
    setIfGiven("RightLegColor", args.rightLegColor and deserializeValue(args.rightLegColor, "Color3"))
    setIfGiven("HeightScale", args.heightScale)
    setIfGiven("WidthScale", args.widthScale)
    setIfGiven("DepthScale", args.depthScale)
    setIfGiven("HeadScale", args.headScale)
    setIfGiven("BodyTypeScale", args.bodyTypeScale)
    setIfGiven("ProportionScale", args.proportionScale)
    setIfGiven("IdleAnimation", args.idleAnimation)
    setIfGiven("WalkAnimation", args.walkAnimation)
    setIfGiven("RunAnimation", args.runAnimation)
    setIfGiven("JumpAnimation", args.jumpAnimation)
    setIfGiven("ClimbAnimation", args.climbAnimation)
    setIfGiven("SwimAnimation", args.swimAnimation)
    setIfGiven("FallAnimation", args.fallAnimation)
    if args.accessories then
        local accList = {}
        for _, acc in ipairs(args.accessories) do
            table.insert(accList, {
                AssetId = acc.assetId,
                AccessoryType = acc.accessoryType and Enum.AccessoryType[acc.accessoryType] or Enum.AccessoryType.Hat,
                IsLayered = acc.isLayered or false,
                Order = acc.order,
                Puffiness = acc.puffiness,
            })
        end
        local ok, err = pcall(function() hd:SetAccessories(accList, true) end)
        if not ok then warn("humanoid_description_build SetAccessories: " .. tostring(err)) end
    end

    local parent = resolvePath(args.parentPath or "game.ServerStorage")
    if not parent:FindFirstChild("HDLibrary") then
        local lib = Instance.new("Folder"); lib.Name = "HDLibrary"; lib.Parent = parent
    end
    hd.Parent = parent:FindFirstChild("HDLibrary")
    if args.name then hd.Name = args.name end
    return { ok = true, path = instancePath(hd) }
end

handlers.humanoid_description_apply = function(args)
    local character = resolvePath(args.characterPath)
    local humanoid = character:FindFirstChildOfClass("Humanoid")
    if not humanoid then error("humanoid_description_apply: character has no Humanoid") end
    local hd
    if args.descriptionPath then
        hd = resolvePath(args.descriptionPath)
    elseif args.description then
        -- Build inline
        local inlineRes = handlers.humanoid_description_build(args.description)
        hd = resolvePath(inlineRes.path)
    else
        error("humanoid_description_apply: need descriptionPath or description")
    end
    humanoid:ApplyDescription(hd)
    return { ok = true, character = instancePath(character) }
end

------------------------------------------------------------------------------
-- Studio command bar
------------------------------------------------------------------------------
------------------------------------------------------------------------------
-- Animation editing & Humanoid playback
------------------------------------------------------------------------------
local function readKeyframeSequence(seq)
    local frames = {}
    for _, kf in ipairs(seq:GetChildren()) do
        if kf:IsA("Keyframe") then
            local poses = {}
            local function walkPoses(node, prefix)
                for _, child in ipairs(node:GetChildren()) do
                    if child:IsA("Pose") then
                        local name = (prefix and prefix ~= "") and (prefix .. "." .. child.Name) or child.Name
                        local cf = child.CFrame
                        poses[name] = { cf:GetComponents() }
                        walkPoses(child, name)
                    end
                end
            end
            walkPoses(kf, "")
            table.insert(frames, { time = kf.Time, poses = poses, name = kf.Name })
        end
    end
    table.sort(frames, function(a, b) return a.time < b.time end)
    return frames
end

handlers.get_keyframe_sequence = function(args)
    local seq = resolvePath(args.path)
    if not seq:IsA("KeyframeSequence") then
        error("get_keyframe_sequence: target is not a KeyframeSequence")
    end
    return {
        ok = true,
        path = instancePath(seq),
        loop = seq.Loop,
        priority = seq.Priority and seq.Priority.Name or nil,
        frames = readKeyframeSequence(seq),
    }
end

handlers.edit_keyframe_sequence = function(args)
    local seq = resolvePath(args.path)
    if not seq:IsA("KeyframeSequence") then
        error("edit_keyframe_sequence: target is not a KeyframeSequence")
    end
    ChangeHistoryService:SetWaypoint("supertool: edit_keyframe_sequence")
    if not args.merge then
        for _, c in ipairs(seq:GetChildren()) do
            if c:IsA("Keyframe") then c:Destroy() end
        end
    end
    if args.loop ~= nil then seq.Loop = args.loop end
    for _, frame in ipairs(args.frames or {}) do
        local kf = Instance.new("Keyframe")
        kf.Time = frame.time
        if frame.name then kf.Name = frame.name end
        for boneName, components in pairs(frame.poses or {}) do
            local pose = Instance.new("Pose")
            pose.Name = boneName
            pose.CFrame = CFrame.new(table.unpack(components))
            pose.Parent = kf
        end
        kf.Parent = seq
    end
    return { ok = true, frames = #(args.frames or {}) }
end

local activeAnimationTracks = {}
local nextAnimTrackId = 0

handlers.humanoid_play_animation = function(args)
    local character = resolvePath(args.characterPath)
    local humanoid = character:FindFirstChildOfClass("Humanoid") or character:FindFirstChildOfClass("AnimationController")
    if not humanoid then error("humanoid_play_animation: no Humanoid or AnimationController under " .. tostring(args.characterPath)) end
    local anim = Instance.new("Animation")
    anim.AnimationId = "rbxassetid://" .. tostring(args.animationId):gsub("rbxassetid://", "")
    if anim.AnimationId == "rbxassetid://" then
        anim:Destroy()
        error("humanoid_play_animation: invalid animationId")
    end
    local track = humanoid:LoadAnimation(anim)
    if args.looped ~= nil then track.Looped = args.looped end
    if args.priority then
        local prio = Enum.AnimationPriority[args.priority]
        if prio then track.Priority = prio end
    end
    track:Play(args.fadeTime or 0.1, args.weight or 1.0, args.speed or 1.0)
    nextAnimTrackId = nextAnimTrackId + 1
    local id = "anim_" .. nextAnimTrackId
    activeAnimationTracks[id] = track
    return { ok = true, id = id }
end

handlers.humanoid_stop_animation = function(args)
    local track = activeAnimationTracks[args.id]
    if not track then return { ok = false, error = "unknown anim id" } end
    track:Stop(args.fadeTime or 0.1)
    activeAnimationTracks[args.id] = nil
    return { ok = true }
end

handlers.humanoid_stop_all = function(args)
    local character = resolvePath(args.characterPath)
    local humanoid = character:FindFirstChildOfClass("Humanoid") or character:FindFirstChildOfClass("AnimationController")
    if not humanoid then error("humanoid_stop_all: no Humanoid") end
    local stopped = 0
    for _, track in ipairs(humanoid:GetPlayingAnimationTracks()) do
        track:Stop(0.1)
        stopped = stopped + 1
    end
    -- Also clear our id registry of anything tied to this character
    for id, t in pairs(activeAnimationTracks) do
        if t and not t.IsPlaying then activeAnimationTracks[id] = nil end
    end
    return { ok = true, stopped = stopped }
end

------------------------------------------------------------------------------
-- EditableImage / EditableMesh
------------------------------------------------------------------------------
handlers.editable_image_create = function(args)
    local size = args.size or { 256, 256 }
    local AssetService = game:GetService("AssetService")
    local image = AssetService:CreateEditableImage({ Size = Vector2.new(size[1], size[2]) })
    if args.pixelsRGBA then
        local buffer = buffer.create(size[1] * size[2] * 4)
        for i, byte in ipairs(args.pixelsRGBA) do
            buffer.writeu8(buffer, i - 1, byte)
        end
        image:WritePixelsBuffer(Vector2.zero, Vector2.new(size[1], size[2]), buffer)
    end
    if args.parentPath then
        local parent = resolvePath(args.parentPath)
        image.Parent = parent
    end
    return { ok = true, path = instancePath(image), size = size }
end

handlers.editable_image_set_pixels = function(args)
    local image = resolvePath(args.path)
    if not image:IsA("EditableImage") then error("editable_image_set_pixels: target is not an EditableImage") end
    local size = args.size or { image.Size.X, image.Size.Y }
    local offset = args.offset or { 0, 0 }
    local buffer = buffer.create(size[1] * size[2] * 4)
    for i, byte in ipairs(args.pixelsRGBA) do
        buffer.writeu8(buffer, i - 1, byte)
    end
    image:WritePixelsBuffer(Vector2.new(offset[1], offset[2]), Vector2.new(size[1], size[2]), buffer)
    return { ok = true }
end

handlers.editable_mesh_create = function(args)
    local AssetService = game:GetService("AssetService")
    local mesh = AssetService:CreateEditableMesh()
    local vertexIds = {}
    for i, v in ipairs(args.vertices or {}) do
        vertexIds[i] = mesh:AddVertex(Vector3.new(v[1], v[2], v[3]))
    end
    for _, face in ipairs(args.faces or {}) do
        mesh:AddTriangle(vertexIds[face[1]], vertexIds[face[2]], vertexIds[face[3]])
    end
    if args.parentPath then
        local parent = resolvePath(args.parentPath)
        mesh.Parent = parent
    end
    return { ok = true, path = instancePath(mesh), vertices = #(args.vertices or {}), faces = #(args.faces or {}) }
end

------------------------------------------------------------------------------
-- Pathfinding
------------------------------------------------------------------------------
handlers.pathfind = function(args)
    local PathfindingService = game:GetService("PathfindingService")
    local startPos = Vector3.new(args.startPos[1], args.startPos[2], args.startPos[3])
    local endPos = Vector3.new(args.endPos[1], args.endPos[2], args.endPos[3])
    local agentParams = args.agentParams or {}
    local path = PathfindingService:CreatePath(agentParams)
    local ok, err = pcall(function() path:ComputeAsync(startPos, endPos) end)
    if not ok then
        return { ok = false, error = "ComputeAsync failed: " .. tostring(err) }
    end
    if path.Status ~= Enum.PathStatus.Success then
        return { ok = false, status = path.Status.Name, waypoints = {} }
    end
    local waypoints = {}
    for _, wp in ipairs(path:GetWaypoints()) do
        table.insert(waypoints, {
            position = { wp.Position.X, wp.Position.Y, wp.Position.Z },
            action = wp.Action.Name,
            label = wp.Label,
        })
    end
    return { ok = true, status = path.Status.Name, waypoints = waypoints }
end

handlers.pathfind_visualize = function(args)
    local result = handlers.pathfind(args)
    if not result.ok then return result end
    local Debris = game:GetService("Debris")
    local lifetime = args.lifetimeS or 8
    for i, wp in ipairs(result.waypoints) do
        local part = Instance.new("Part")
        part.Anchored = true
        part.CanCollide = false
        part.CanQuery = false
        part.Size = Vector3.new(0.5, 0.5, 0.5)
        part.Material = Enum.Material.Neon
        part.Color = Color3.fromRGB(255, 195, 85)
        part.Position = Vector3.new(wp.position[1], wp.position[2] + 0.5, wp.position[3])
        part.Shape = Enum.PartType.Ball
        part.Name = "PathWaypoint_" .. i
        part.Parent = workspace
        Debris:AddItem(part, lifetime)
    end
    return result
end

------------------------------------------------------------------------------
-- Remote events / functions
------------------------------------------------------------------------------
local remoteListeners = {}

handlers.remote_fire = function(args)
    local remote = resolvePath(args.path)
    if remote:IsA("RemoteEvent") then
        if args.target == "client" then
            local player
            if args.player then player = resolvePath(args.player) end
            if player then
                remote:FireClient(player, table.unpack(args.args or {}))
            else
                remote:FireAllClients(table.unpack(args.args or {}))
            end
        else
            -- Default: server-side firing isn't a thing for RemoteEvent (Server Event always to clients)
            -- But a script in the plugin context can:
            remote:FireAllClients(table.unpack(args.args or {}))
        end
        return { ok = true, fired = remote.Name }
    elseif remote:IsA("BindableEvent") then
        remote:Fire(table.unpack(args.args or {}))
        return { ok = true, fired = remote.Name }
    elseif remote:IsA("RemoteFunction") then
        return { ok = false, error = "use remote_invoke for RemoteFunction" }
    else
        error("remote_fire: target is not a RemoteEvent or BindableEvent")
    end
end

handlers.remote_invoke = function(args)
    local remote = resolvePath(args.path)
    if not (remote:IsA("RemoteFunction") or remote:IsA("BindableFunction")) then
        error("remote_invoke: target is not a RemoteFunction or BindableFunction")
    end
    if remote:IsA("BindableFunction") then
        local result = remote:Invoke(table.unpack(args.args or {}))
        return { ok = true, result = serializeValue(result) }
    end
    -- RemoteFunction:InvokeClient requires a player target (only callable from server-side player code)
    local player = args.player and resolvePath(args.player) or nil
    if not player then error("remote_invoke: RemoteFunction requires player path for InvokeClient") end
    local result = remote:InvokeClient(player, table.unpack(args.args or {}))
    return { ok = true, result = serializeValue(result) }
end

handlers.remote_listen = function(args)
    local remote = resolvePath(args.path)
    if not (remote:IsA("RemoteEvent") or remote:IsA("BindableEvent")) then
        error("remote_listen: target is not a RemoteEvent or BindableEvent")
    end
    local key = instancePath(remote)
    if remoteListeners[key] then
        return { ok = true, alreadyListening = true, key = key }
    end
    local buffer = {}
    local conn
    if remote:IsA("RemoteEvent") then
        conn = remote.OnServerEvent:Connect(function(player, ...)
            local args_serialized = {}
            local n = select("#", ...)
            for i = 1, n do args_serialized[i] = serializeValue((select(i, ...))) end
            table.insert(buffer, {
                time = os.clock(),
                player = player and player.Name or nil,
                args = args_serialized,
            })
            if #buffer > (args.maxBufferSize or 100) then table.remove(buffer, 1) end
        end)
    else
        conn = remote.Event:Connect(function(...)
            local args_serialized = {}
            local n = select("#", ...)
            for i = 1, n do args_serialized[i] = serializeValue((select(i, ...))) end
            table.insert(buffer, { time = os.clock(), args = args_serialized })
            if #buffer > (args.maxBufferSize or 100) then table.remove(buffer, 1) end
        end)
    end
    remoteListeners[key] = { conn = conn, buffer = buffer }
    return { ok = true, key = key }
end

handlers.remote_drain = function(args)
    local key = args.key or args.path
    if args.path and not args.key then key = instancePath(resolvePath(args.path)) end
    local listener = remoteListeners[key]
    if not listener then return { ok = false, error = "no listener for key: " .. tostring(key) } end
    local drained = listener.buffer
    listener.buffer = {}
    if args.stop then
        listener.conn:Disconnect()
        remoteListeners[key] = nil
    end
    return { ok = true, count = #drained, events = drained }
end

------------------------------------------------------------------------------
-- Particle presets
------------------------------------------------------------------------------
local PARTICLE_PRESETS = {
    blood = {
        Texture = "rbxassetid://6435090644",
        Color = ColorSequence.new(Color3.fromRGB(180, 20, 20), Color3.fromRGB(70, 8, 8)),
        Size = NumberSequence.new(0.8, 0),
        Transparency = NumberSequence.new(0, 1),
        Lifetime = NumberRange.new(0.4, 0.7),
        Speed = NumberRange.new(8, 16),
        SpreadAngle = Vector2.new(180, 180),
        Acceleration = Vector3.new(0, -28, 0),
        Drag = 1.5,
        Rate = 0,
    },
    dust = {
        Texture = "rbxasset://textures/particles/smoke_main.dds",
        Color = ColorSequence.new(Color3.fromRGB(180, 160, 130), Color3.fromRGB(110, 100, 80)),
        Size = NumberSequence.new(1.0, 0),
        Transparency = NumberSequence.new(0.4, 1),
        Lifetime = NumberRange.new(0.6, 1.2),
        Speed = NumberRange.new(2, 6),
        SpreadAngle = Vector2.new(180, 180),
        Acceleration = Vector3.new(0, 2, 0),
        Drag = 2.5,
        LightEmission = 0.2,
        Rate = 0,
    },
    sparkle = {
        Texture = "rbxasset://textures/particles/sparkles_main.dds",
        Color = ColorSequence.new(Color3.fromRGB(255, 240, 180), Color3.fromRGB(255, 195, 85)),
        Size = NumberSequence.new(0.6, 0),
        Transparency = NumberSequence.new(0, 1),
        Lifetime = NumberRange.new(0.3, 0.8),
        Speed = NumberRange.new(4, 10),
        SpreadAngle = Vector2.new(180, 180),
        LightEmission = 1.0,
        Rate = 0,
    },
    smoke = {
        Texture = "rbxasset://textures/particles/smoke_main.dds",
        Color = ColorSequence.new(Color3.fromRGB(60, 60, 60), Color3.fromRGB(20, 20, 20)),
        Size = NumberSequence.new(1.2, 4.0),
        Transparency = NumberSequence.new(0.4, 1),
        Lifetime = NumberRange.new(1.5, 3.0),
        Speed = NumberRange.new(2, 5),
        Acceleration = Vector3.new(0, 4, 0),
        Drag = 1,
        Rate = 8,
    },
    fire = {
        Texture = "rbxasset://textures/particles/fire_main.dds",
        Color = ColorSequence.new({
            ColorSequenceKeypoint.new(0, Color3.fromRGB(255, 220, 100)),
            ColorSequenceKeypoint.new(0.5, Color3.fromRGB(255, 120, 30)),
            ColorSequenceKeypoint.new(1, Color3.fromRGB(120, 30, 10)),
        }),
        Size = NumberSequence.new(1.0, 0.2),
        Transparency = NumberSequence.new(0, 1),
        Lifetime = NumberRange.new(0.4, 0.8),
        Speed = NumberRange.new(2, 5),
        Acceleration = Vector3.new(0, 6, 0),
        LightEmission = 1.0,
        Rate = 25,
    },
    magic = {
        Texture = "rbxasset://textures/particles/sparkles_main.dds",
        Color = ColorSequence.new({
            ColorSequenceKeypoint.new(0, Color3.fromRGB(180, 140, 255)),
            ColorSequenceKeypoint.new(0.5, Color3.fromRGB(120, 220, 255)),
            ColorSequenceKeypoint.new(1, Color3.fromRGB(80, 60, 180)),
        }),
        Size = NumberSequence.new(0.7, 0),
        Transparency = NumberSequence.new(0.2, 1),
        Lifetime = NumberRange.new(0.6, 1.4),
        Speed = NumberRange.new(3, 8),
        SpreadAngle = Vector2.new(180, 180),
        LightEmission = 0.8,
        Rate = 0,
    },
    chips = {
        Texture = "rbxasset://textures/particles/smoke_main.dds",
        Color = ColorSequence.new(Color3.fromRGB(180, 160, 130), Color3.fromRGB(80, 70, 50)),
        Size = NumberSequence.new(0.5, 0),
        Transparency = NumberSequence.new(0, 1),
        Lifetime = NumberRange.new(0.4, 0.7),
        Speed = NumberRange.new(8, 18),
        SpreadAngle = Vector2.new(180, 180),
        Acceleration = Vector3.new(0, -32, 0),
        Drag = 1.5,
        Rate = 0,
    },
}

handlers.particle_preset_apply = function(args)
    local preset = PARTICLE_PRESETS[args.preset]
    if not preset then
        error("particle_preset_apply: unknown preset '" .. tostring(args.preset) .. "'. Available: blood, dust, sparkle, smoke, fire, magic, chips")
    end
    local part = resolvePath(args.partPath)
    if not part:IsA("BasePart") and not part:IsA("Attachment") then
        error("particle_preset_apply: target must be a BasePart or Attachment")
    end
    ChangeHistoryService:SetWaypoint("supertool: particle_preset_apply " .. args.preset)
    local emitter = Instance.new("ParticleEmitter")
    for k, v in pairs(preset) do emitter[k] = v end
    if args.color then
        local c = deserializeValue(args.color, "Color3")
        if typeof(c) == "Color3" then emitter.Color = ColorSequence.new(c, c) end
    end
    if args.scale then
        local seq = preset.Size
        local kps = {}
        for _, kp in ipairs(seq.Keypoints) do
            table.insert(kps, NumberSequenceKeypoint.new(kp.Time, kp.Value * args.scale, kp.Envelope))
        end
        emitter.Size = NumberSequence.new(kps)
    end
    if args.rate then emitter.Rate = args.rate end
    emitter.Parent = part
    if args.emit then emitter:Emit(args.emit) end
    if args.cleanupS then
        local Debris = game:GetService("Debris")
        Debris:AddItem(emitter, args.cleanupS)
    end
    return { ok = true, path = instancePath(emitter), preset = args.preset }
end

------------------------------------------------------------------------------
-- Tags / CollectionService
------------------------------------------------------------------------------
handlers.tags_add = function(args)
    local CollectionService = game:GetService("CollectionService")
    local inst = resolvePath(args.path)
    CollectionService:AddTag(inst, args.tag)
    return { ok = true, path = instancePath(inst), tag = args.tag }
end

handlers.tags_remove = function(args)
    local CollectionService = game:GetService("CollectionService")
    local inst = resolvePath(args.path)
    CollectionService:RemoveTag(inst, args.tag)
    return { ok = true }
end

handlers.tags_get = function(args)
    local CollectionService = game:GetService("CollectionService")
    local inst = resolvePath(args.path)
    return { ok = true, tags = CollectionService:GetTags(inst) }
end

handlers.tags_query = function(args)
    local CollectionService = game:GetService("CollectionService")
    local instances = CollectionService:GetTagged(args.tag)
    local paths = {}
    for _, inst in ipairs(instances) do table.insert(paths, instancePath(inst)) end
    return { ok = true, count = #paths, paths = paths }
end

------------------------------------------------------------------------------
-- Marketplace queries
------------------------------------------------------------------------------
handlers.marketplace_get_product_info = function(args)
    local MarketplaceService = game:GetService("MarketplaceService")
    local infoTypeName = args.infoType or "Asset"
    local infoType = Enum.InfoType[infoTypeName]
    if not infoType then error("marketplace_get_product_info: unknown infoType '" .. tostring(infoTypeName) .. "'") end
    local ok, info = pcall(function() return MarketplaceService:GetProductInfo(args.id, infoType) end)
    if not ok then return { ok = false, error = tostring(info) } end
    return { ok = true, info = info }
end

handlers.marketplace_user_owns_gamepass = function(args)
    local MarketplaceService = game:GetService("MarketplaceService")
    local player = resolvePath(args.player)
    if not player:IsA("Player") then error("marketplace_user_owns_gamepass: player must resolve to a Player") end
    local ok, owns = pcall(function() return MarketplaceService:UserOwnsGamePassAsync(player.UserId, args.gamePassId) end)
    if not ok then return { ok = false, error = tostring(owns) } end
    return { ok = true, owns = owns }
end

------------------------------------------------------------------------------
-- Sound utilities
------------------------------------------------------------------------------
handlers.sound_play = function(args)
    local Debris = game:GetService("Debris")
    local part = Instance.new("Part")
    part.Anchored = true
    part.CanCollide = false
    part.CanQuery = false
    part.Size = Vector3.new(0.1, 0.1, 0.1)
    part.Transparency = 1
    if args.position then
        part.Position = Vector3.new(args.position[1], args.position[2], args.position[3])
    end
    part.Parent = workspace

    local sound = Instance.new("Sound")
    sound.SoundId = tostring(args.soundId):find("rbx") and args.soundId or ("rbxassetid://" .. tostring(args.soundId))
    sound.Volume = args.volume or 1
    sound.PlaybackSpeed = args.pitch or args.speed or 1
    sound.RollOffMaxDistance = args.rollOffMaxDistance or 100
    sound.RollOffMode = args.rollOffMode and Enum.RollOffMode[args.rollOffMode] or Enum.RollOffMode.InverseTapered
    sound.Parent = part
    sound:Play()
    Debris:AddItem(part, args.cleanupS or 5)
    return { ok = true, soundId = sound.SoundId }
end

------------------------------------------------------------------------------
-- Plugin self-reload (re-installs from %LOCALAPPDATA%\Roblox\Plugins)
------------------------------------------------------------------------------
------------------------------------------------------------------------------
-- Avatar utilities
------------------------------------------------------------------------------
handlers.humanoid_unequip_all = function(args)
    local character = resolvePath(args.characterPath)
    local humanoid = character:FindFirstChildOfClass("Humanoid")
    if not humanoid then error("humanoid_unequip_all: no Humanoid") end
    humanoid:UnequipTools()
    return { ok = true }
end

handlers.humanoid_set_state_enabled = function(args)
    local character = resolvePath(args.characterPath)
    local humanoid = character:FindFirstChildOfClass("Humanoid")
    if not humanoid then error("humanoid_set_state_enabled: no Humanoid") end
    local state = Enum.HumanoidStateType[args.state]
    if not state then error("humanoid_set_state_enabled: unknown state '" .. tostring(args.state) .. "'") end
    humanoid:SetStateEnabled(state, args.enabled)
    return { ok = true }
end

------------------------------------------------------------------------------
-- save_selection_as_model — write selected instances to a .rbxm file
------------------------------------------------------------------------------
handlers.save_selection_as_model = function(args)
    -- Plugin-side limitation: the only safe path is to use plugin:CreateModel?
    -- Roblox plugins don't have direct filesystem access. We instead emit a
    -- packed string the MCP server can save to disk via the response payload.
    local Selection = game:GetService("Selection")
    local paths = args.paths
    local instances
    if paths and #paths > 0 then
        instances = {}
        for _, p in ipairs(paths) do
            local inst = resolvePath(p)
            if inst then table.insert(instances, inst) end
        end
    else
        instances = Selection:Get()
    end
    if #instances == 0 then return { ok = false, error = "nothing to save" } end
    -- We can't write to disk; tell the user.
    return {
        ok = false,
        error = "Plugin can't write to disk directly. Use Studio's File > Save as Model UI, or use Rojo to source-control instead.",
        note = "Selection contained " .. #instances .. " instance(s)",
    }
end

handlers.plugin_reload = function(args)
    -- Studio plugins reload when the file is touched. We can't fully re-execute
    -- our script from inside, but we can request the server to push a fresh
    -- version. For now, just signal and let user manually restart.
    return { ok = true, note = "Plugin reload from inside the plugin is not safe — close and reopen Studio, or right-click the plugin in the Plugins ribbon and disable+re-enable." }
end

------------------------------------------------------------------------------
-- Line-level script editing (token-efficient — avoids re-sending full source)
------------------------------------------------------------------------------
local function splitLines(s)
    local lines = {}
    for line in (s .. "\n"):gmatch("(.-)\n") do
        table.insert(lines, line)
    end
    if lines[#lines] == "" then table.remove(lines) end
    return lines
end

local function joinLines(lines) return table.concat(lines, "\n") end

handlers.edit_script_lines = function(args)
    local script = resolvePath(args.path)
    if not script:IsA("LuaSourceContainer") then error("edit_script_lines: target is not a script") end
    local lines = splitLines(script.Source)
    local startLine = math.max(1, args.startLine)
    local endLine = math.min(#lines, args.endLine or args.startLine)
    if startLine > endLine then error("edit_script_lines: startLine > endLine") end
    local replacement = args.replacement or ""
    local replacementLines = splitLines(replacement)
    ChangeHistoryService:SetWaypoint("supertool: edit_script_lines " .. script.Name)
    local newLines = {}
    for i = 1, startLine - 1 do table.insert(newLines, lines[i]) end
    for _, l in ipairs(replacementLines) do table.insert(newLines, l) end
    for i = endLine + 1, #lines do table.insert(newLines, lines[i]) end
    script.Source = joinLines(newLines)
    return {
        ok = true,
        path = instancePath(script),
        oldLineCount = #lines,
        newLineCount = #newLines,
        replacedRange = { startLine, endLine },
    }
end

handlers.insert_script_lines = function(args)
    local script = resolvePath(args.path)
    if not script:IsA("LuaSourceContainer") then error("insert_script_lines: target is not a script") end
    local lines = splitLines(script.Source)
    local at = math.max(1, math.min(#lines + 1, args.atLine))
    local content = splitLines(args.content or "")
    ChangeHistoryService:SetWaypoint("supertool: insert_script_lines " .. script.Name)
    local newLines = {}
    for i = 1, at - 1 do table.insert(newLines, lines[i]) end
    for _, l in ipairs(content) do table.insert(newLines, l) end
    for i = at, #lines do table.insert(newLines, lines[i]) end
    script.Source = joinLines(newLines)
    return { ok = true, path = instancePath(script), insertedAt = at, insertedLines = #content }
end

handlers.delete_script_lines = function(args)
    local script = resolvePath(args.path)
    if not script:IsA("LuaSourceContainer") then error("delete_script_lines: target is not a script") end
    local lines = splitLines(script.Source)
    local startLine = math.max(1, args.startLine)
    local endLine = math.min(#lines, args.endLine or args.startLine)
    ChangeHistoryService:SetWaypoint("supertool: delete_script_lines " .. script.Name)
    local newLines = {}
    for i = 1, startLine - 1 do table.insert(newLines, lines[i]) end
    for i = endLine + 1, #lines do table.insert(newLines, lines[i]) end
    script.Source = joinLines(newLines)
    return { ok = true, path = instancePath(script), deletedRange = { startLine, endLine }, newLineCount = #newLines }
end

------------------------------------------------------------------------------
-- search_by_property — find descendants matching property predicates
------------------------------------------------------------------------------
handlers.search_by_property = function(args)
    local root = resolvePath(args.rootPath or "game.Workspace")
    local className = args.className
    local property = args.property
    local equals = args.equals
    local contains = args.contains
    local gt = args.gt
    local lt = args.lt
    local maxResults = args.maxResults or 200

    local results = {}
    local function visit(inst)
        if #results >= maxResults then return end
        local matchesClass = (not className) or inst:IsA(className)
        if matchesClass then
            local ok, val = pcall(function() return inst[property] end)
            if ok then
                local match = false
                if equals ~= nil then
                    match = val == deserializeValue(equals)
                elseif contains ~= nil and type(val) == "string" then
                    match = string.find(val, contains, 1, true) ~= nil
                elseif gt ~= nil and type(val) == "number" then
                    match = val > gt
                elseif lt ~= nil and type(val) == "number" then
                    match = val < lt
                else
                    match = val ~= nil and val ~= "" and val ~= false
                end
                if match then
                    table.insert(results, {
                        path = instancePath(inst),
                        className = inst.ClassName,
                        name = inst.Name,
                        value = serializeValue(val),
                    })
                end
            end
        end
        for _, c in ipairs(inst:GetChildren()) do visit(c) end
    end
    visit(root)
    return { count = #results, results = results, truncated = #results >= maxResults }
end

------------------------------------------------------------------------------
-- Undo / Redo
------------------------------------------------------------------------------
handlers.undo = function(args)
    local steps = args.steps or 1
    for _ = 1, steps do ChangeHistoryService:Undo() end
    return { ok = true, steps = steps }
end

handlers.redo = function(args)
    local steps = args.steps or 1
    for _ = 1, steps do ChangeHistoryService:Redo() end
    return { ok = true, steps = steps }
end

------------------------------------------------------------------------------
-- Playtest control + introspection
------------------------------------------------------------------------------
local RunService = game:GetService("RunService")
local LogService = game:GetService("LogService")

handlers.playtest_status = function(args)
    return {
        ok = true,
        isRunning = RunService:IsRunning(),
        isServer = RunService:IsServer(),
        isClient = RunService:IsClient(),
        isStudio = RunService:IsStudio(),
        isEdit = RunService:IsEdit(),
    }
end

local logBuffers = {}
local logConnections = {}
local nextLogId = 0

handlers.playtest_log_listen = function(args)
    nextLogId = nextLogId + 1
    local id = "log_" .. nextLogId
    local buffer = {}
    local maxBuffer = args.maxBufferSize or 500
    local levels = {}
    for _, lvl in ipairs(args.levels or { "Info", "Warning", "Error" }) do
        levels[lvl] = true
    end
    local conn = LogService.MessageOut:Connect(function(message, messageType)
        local levelName = messageType.Name
        if not levels[levelName] then return end
        table.insert(buffer, {
            time = os.clock(),
            level = levelName,
            message = message,
        })
        if #buffer > maxBuffer then table.remove(buffer, 1) end
    end)
    logBuffers[id] = buffer
    logConnections[id] = conn
    return { ok = true, id = id }
end

handlers.playtest_log_drain = function(args)
    local id = args.id
    if not id then error("playtest_log_drain: missing id") end
    local buffer = logBuffers[id]
    if not buffer then return { ok = false, error = "unknown log id: " .. tostring(id) } end
    local drained = buffer
    logBuffers[id] = {}
    if args.stop then
        local conn = logConnections[id]
        if conn then conn:Disconnect() end
        logConnections[id] = nil
        logBuffers[id] = nil
    end
    return { ok = true, count = #drained, messages = drained }
end

handlers.playtest_inject_script = function(args)
    local target = args.target or "ServerScriptService"
    local parent
    if target == "ServerScriptService" then
        parent = game:GetService("ServerScriptService")
    elseif target == "StarterPlayerScripts" then
        parent = game:GetService("StarterPlayer"):FindFirstChild("StarterPlayerScripts")
    elseif target == "StarterCharacterScripts" then
        parent = game:GetService("StarterPlayer"):FindFirstChild("StarterCharacterScripts")
    elseif target == "ReplicatedFirst" then
        parent = game:GetService("ReplicatedFirst")
    else
        parent = resolvePath(target)
    end
    if not parent then error("playtest_inject_script: cannot resolve target '" .. tostring(target) .. "'") end

    local scriptName = args.name or ("InjectedTest_" .. os.time())
    local existing = parent:FindFirstChild(scriptName)
    ChangeHistoryService:SetWaypoint("supertool: playtest_inject_script " .. scriptName)
    local script
    if existing and (existing:IsA("Script") or existing:IsA("LocalScript") or existing:IsA("ModuleScript")) then
        script = existing
    else
        local className = (target == "StarterPlayerScripts" or target == "StarterCharacterScripts" or target == "ReplicatedFirst")
            and "LocalScript" or "Script"
        if args.scriptClass then className = args.scriptClass end
        script = Instance.new(className)
        script.Name = scriptName
        script.Parent = parent
    end
    script.Source = args.source
    if args.disabled and (script:IsA("Script") or script:IsA("LocalScript")) then script.Disabled = true end
    return { ok = true, path = instancePath(script), className = script.ClassName }
end

handlers.play_start = function(args)
    -- Plugins can't directly press play in Studio. Try via Studio command if available.
    local ok, err = pcall(function()
        if game:GetService("RunService"):IsRunning() then return end
        -- Studio internal: not a public API. We try and fall back to a hint.
        ---@diagnostic disable-next-line: undefined-field
        if game.Run then game:Run() end
    end)
    return {
        ok = ok,
        isRunning = RunService:IsRunning(),
        note = "Studio plugins can't reliably trigger play mode. If this returned isRunning=false, press F5 in Studio to start play, then call playtest_status.",
        error = (not ok) and tostring(err) or nil,
    }
end

handlers.play_stop = function(args)
    local ok, err = pcall(function()
        if not RunService:IsRunning() then return end
        ---@diagnostic disable-next-line: undefined-field
        if game.Stop then game:Stop() end
    end)
    return {
        ok = ok,
        isRunning = RunService:IsRunning(),
        note = "Studio plugins can't reliably stop play mode. If this returned isRunning=true, press Shift+F5 in Studio.",
        error = (not ok) and tostring(err) or nil,
    }
end

handlers.simulate_key_press = function(args)
    local ok, VIM = pcall(function() return game:GetService("VirtualInputManager") end)
    if not ok or not VIM then
        return { ok = false, error = "VirtualInputManager not available in this Studio context" }
    end
    local keyCode = Enum.KeyCode[args.key]
    if not keyCode then error("simulate_key_press: unknown key '" .. tostring(args.key) .. "'") end
    local duration = args.holdS or 0.05
    local sentDown = pcall(function() VIM:SendKeyEvent(true, keyCode, false, game) end)
    task.wait(duration)
    local sentUp = pcall(function() VIM:SendKeyEvent(false, keyCode, false, game) end)
    return { ok = sentDown and sentUp, key = args.key, durationS = duration }
end

handlers.simulate_mouse_click = function(args)
    local ok, VIM = pcall(function() return game:GetService("VirtualInputManager") end)
    if not ok or not VIM then
        return { ok = false, error = "VirtualInputManager not available" }
    end
    local x = args.x or 0
    local y = args.y or 0
    local button = args.button or 0
    pcall(function() VIM:SendMouseButtonEvent(x, y, button, true, game, 0) end)
    task.wait(args.holdS or 0.04)
    pcall(function() VIM:SendMouseButtonEvent(x, y, button, false, game, 0) end)
    return { ok = true, x = x, y = y, button = button }
end

handlers.wait_for_play_state = function(args)
    local target = args.target == "running"
    local timeout = args.timeoutS or 30
    local elapsed = 0
    while RunService:IsRunning() ~= target and elapsed < timeout do
        task.wait(0.2)
        elapsed = elapsed + 0.2
    end
    return {
        ok = RunService:IsRunning() == target,
        isRunning = RunService:IsRunning(),
        waitedS = elapsed,
        timedOut = RunService:IsRunning() ~= target,
    }
end

------------------------------------------------------------------------------
-- HOME TAB — selection-based bulk operations + file ops
------------------------------------------------------------------------------
local Selection = game:GetService("Selection")

local function getTargetInstances(args)
    if args.paths and #args.paths > 0 then
        local out = {}
        for _, p in ipairs(args.paths) do
            local inst = resolvePath(p)
            if inst then table.insert(out, inst) end
        end
        return out
    end
    return Selection:Get()
end

handlers.group_selection = function(args)
    local insts = getTargetInstances(args)
    if #insts == 0 then return { ok = false, error = "nothing to group" } end
    ChangeHistoryService:SetWaypoint("supertool: group_selection")
    local model = Instance.new("Model")
    model.Name = args.name or "Group"
    local parent = insts[1].Parent
    -- Pick the largest BasePart as PrimaryPart
    local biggest, vol = nil, -1
    for _, inst in ipairs(insts) do
        if inst:IsA("BasePart") then
            local v = inst.Size.X * inst.Size.Y * inst.Size.Z
            if v > vol then biggest, vol = inst, v end
        end
    end
    for _, inst in ipairs(insts) do inst.Parent = model end
    if biggest then model.PrimaryPart = biggest end
    model.Parent = parent
    Selection:Set({ model })
    return { ok = true, path = instancePath(model), grouped = #insts }
end

handlers.ungroup_model = function(args)
    local model = args.path and resolvePath(args.path) or (Selection:Get()[1])
    if not model or not model:IsA("Model") then return { ok = false, error = "not a Model" } end
    ChangeHistoryService:SetWaypoint("supertool: ungroup_model")
    local parent = model.Parent
    local children = model:GetChildren()
    for _, c in ipairs(children) do c.Parent = parent end
    model:Destroy()
    Selection:Set(children)
    return { ok = true, ungrouped = #children }
end

handlers.anchor_selection = function(args)
    local insts = getTargetInstances(args)
    ChangeHistoryService:SetWaypoint("supertool: anchor_selection")
    local count = 0
    local anchored = args.anchored
    if anchored == nil then anchored = true end
    local function visit(inst)
        if inst:IsA("BasePart") then
            inst.Anchored = anchored
            count = count + 1
        end
        if args.recursive ~= false then
            for _, c in ipairs(inst:GetChildren()) do visit(c) end
        end
    end
    for _, inst in ipairs(insts) do visit(inst) end
    return { ok = true, anchored = anchored, count = count }
end

handlers.lock_selection = function(args)
    local insts = getTargetInstances(args)
    ChangeHistoryService:SetWaypoint("supertool: lock_selection")
    local count = 0
    local locked = args.locked
    if locked == nil then locked = true end
    local function visit(inst)
        if inst:IsA("BasePart") then
            inst.Locked = locked
            count = count + 1
        end
        if args.recursive ~= false then
            for _, c in ipairs(inst:GetChildren()) do visit(c) end
        end
    end
    for _, inst in ipairs(insts) do visit(inst) end
    return { ok = true, locked = locked, count = count }
end

handlers.set_material_selection = function(args)
    local material = Enum.Material[args.material]
    if not material then error("set_material_selection: unknown material '" .. tostring(args.material) .. "'") end
    local insts = getTargetInstances(args)
    ChangeHistoryService:SetWaypoint("supertool: set_material_selection")
    local count = 0
    local function visit(inst)
        if inst:IsA("BasePart") then inst.Material = material; count = count + 1 end
        if args.recursive ~= false then
            for _, c in ipairs(inst:GetChildren()) do visit(c) end
        end
    end
    for _, inst in ipairs(insts) do visit(inst) end
    return { ok = true, material = args.material, count = count }
end

handlers.set_color_selection = function(args)
    local color = deserializeValue(args.color, "Color3")
    if typeof(color) ~= "Color3" then error("set_color_selection: invalid color") end
    local insts = getTargetInstances(args)
    ChangeHistoryService:SetWaypoint("supertool: set_color_selection")
    local count = 0
    local function visit(inst)
        if inst:IsA("BasePart") then inst.Color = color; count = count + 1 end
        if args.recursive ~= false then
            for _, c in ipairs(inst:GetChildren()) do visit(c) end
        end
    end
    for _, inst in ipairs(insts) do visit(inst) end
    return { ok = true, color = serializeValue(color), count = count }
end

handlers.duplicate_selection = function(args)
    local insts = getTargetInstances(args)
    if #insts == 0 then return { ok = false, error = "nothing to duplicate" } end
    ChangeHistoryService:SetWaypoint("supertool: duplicate_selection")
    local clones = {}
    for _, inst in ipairs(insts) do
        if inst.Archivable then
            local c = inst:Clone()
            c.Parent = inst.Parent
            table.insert(clones, c)
        end
    end
    local clonePaths = {}
    for _, c in ipairs(clones) do table.insert(clonePaths, instancePath(c)) end
    Selection:Set(clones)
    return { ok = true, count = #clones, paths = clonePaths }
end

handlers.save_place = function(args)
    local ok, err = pcall(function() game:Save() end)
    return { ok = ok, error = (not ok) and tostring(err) or nil }
end

------------------------------------------------------------------------------
-- AVATAR TAB — rig builder
------------------------------------------------------------------------------
handlers.build_rig = function(args)
    local rigType = args.rigType or "R15"
    local name = args.name
    local Players = game:GetService("Players")
    ChangeHistoryService:SetWaypoint("supertool: build_rig " .. rigType)
    local model
    local hd = Instance.new("HumanoidDescription")
    local enumType = (rigType == "R6") and Enum.HumanoidRigType.R6 or Enum.HumanoidRigType.R15
    local ok, result = pcall(function() return Players:CreateHumanoidModelFromDescription(hd, enumType) end)
    if not ok then error("build_rig: " .. tostring(result)) end
    model = result
    model.Name = name or ("Dummy" .. rigType)
    if args.parentPath then
        model.Parent = resolvePath(args.parentPath)
    else
        model.Parent = workspace
    end
    if args.position then
        local pos = Vector3.new(args.position[1], args.position[2], args.position[3])
        if model.PrimaryPart then
            model:PivotTo(CFrame.new(pos))
        end
    end
    Selection:Set({ model })
    return { ok = true, path = instancePath(model), rigType = rigType }
end

------------------------------------------------------------------------------
-- MODEL TAB — transform helpers
------------------------------------------------------------------------------
handlers.move_selection = function(args)
    local insts = getTargetInstances(args)
    local delta = Vector3.new(args.delta[1], args.delta[2], args.delta[3])
    ChangeHistoryService:SetWaypoint("supertool: move_selection")
    local count = 0
    for _, inst in ipairs(insts) do
        if inst:IsA("Model") then
            inst:PivotTo(inst:GetPivot() + delta); count = count + 1
        elseif inst:IsA("BasePart") then
            inst.CFrame = inst.CFrame + delta; count = count + 1
        end
    end
    return { ok = true, moved = count, delta = args.delta }
end

handlers.rotate_selection = function(args)
    local insts = getTargetInstances(args)
    local axis = args.axis or "Y"
    local degrees = args.degrees or 90
    local rad = math.rad(degrees)
    local rot
    if axis == "X" then rot = CFrame.Angles(rad, 0, 0)
    elseif axis == "Y" then rot = CFrame.Angles(0, rad, 0)
    elseif axis == "Z" then rot = CFrame.Angles(0, 0, rad)
    else error("rotate_selection: axis must be X, Y, or Z") end
    ChangeHistoryService:SetWaypoint("supertool: rotate_selection")
    local count = 0
    for _, inst in ipairs(insts) do
        if inst:IsA("Model") then
            local pivot = inst:GetPivot()
            inst:PivotTo(pivot * rot); count = count + 1
        elseif inst:IsA("BasePart") then
            inst.CFrame = inst.CFrame * rot; count = count + 1
        end
    end
    return { ok = true, rotated = count, axis = axis, degrees = degrees }
end

handlers.scale_selection = function(args)
    local insts = getTargetInstances(args)
    local scale = args.scale or 1
    ChangeHistoryService:SetWaypoint("supertool: scale_selection")
    local count = 0
    for _, inst in ipairs(insts) do
        if inst:IsA("BasePart") then
            inst.Size = inst.Size * scale; count = count + 1
        elseif inst:IsA("Model") then
            inst:ScaleTo(inst:GetScale() * scale); count = count + 1
        end
    end
    return { ok = true, scaled = count, factor = scale }
end

handlers.snap_to_grid = function(args)
    local insts = getTargetInstances(args)
    local grid = args.grid or 1
    ChangeHistoryService:SetWaypoint("supertool: snap_to_grid")
    local count = 0
    local function snap(v) return math.floor(v / grid + 0.5) * grid end
    for _, inst in ipairs(insts) do
        if inst:IsA("BasePart") then
            inst.Position = Vector3.new(snap(inst.Position.X), snap(inst.Position.Y), snap(inst.Position.Z))
            count = count + 1
        elseif inst:IsA("Model") and inst.PrimaryPart then
            local p = inst:GetPivot().Position
            local snapped = Vector3.new(snap(p.X), snap(p.Y), snap(p.Z))
            inst:PivotTo(inst:GetPivot() + (snapped - p))
            count = count + 1
        end
    end
    return { ok = true, snapped = count, grid = grid }
end

handlers.pivot_to = function(args)
    local model = resolvePath(args.path)
    if not model:IsA("Model") then error("pivot_to: target is not a Model") end
    local pos = Vector3.new(args.position[1], args.position[2], args.position[3])
    local rot = args.rotation
    local cf = CFrame.new(pos)
    if rot then cf = cf * CFrame.Angles(math.rad(rot[1] or 0), math.rad(rot[2] or 0), math.rad(rot[3] or 0)) end
    ChangeHistoryService:SetWaypoint("supertool: pivot_to")
    model:PivotTo(cf)
    return { ok = true, path = instancePath(model) }
end

handlers.get_pivot = function(args)
    local model = resolvePath(args.path)
    local pivot
    if model:IsA("Model") then pivot = model:GetPivot()
    elseif model:IsA("BasePart") then pivot = model.CFrame
    else error("get_pivot: target is not a Model or BasePart") end
    return { ok = true, cframe = serializeValue(pivot) }
end

------------------------------------------------------------------------------
-- UI TAB — convenience factories
------------------------------------------------------------------------------
handlers.ui_create_layout = function(args)
    local kind = args.kind
    if not (kind == "UIListLayout" or kind == "UIGridLayout" or kind == "UIPadding"
         or kind == "UIAspectRatioConstraint" or kind == "UISizeConstraint" or kind == "UICorner"
         or kind == "UIStroke" or kind == "UIGradient" or kind == "UIScale") then
        error("ui_create_layout: unsupported kind '" .. tostring(kind) .. "'")
    end
    local parent = resolvePath(args.parentPath)
    ChangeHistoryService:SetWaypoint("supertool: ui_create_layout " .. kind)
    local inst = Instance.new(kind)
    if args.properties then
        for k, v in pairs(args.properties) do
            local existingOk, existing = pcall(function() return inst[k] end)
            local expectedType = existingOk and typeof(existing) or nil
            local ok, err = pcall(function() inst[k] = deserializeValue(v, expectedType) end)
            if not ok then warn("ui_create_layout: failed to set " .. k .. ": " .. tostring(err)) end
        end
    end
    inst.Parent = parent
    return { ok = true, path = instancePath(inst), kind = kind }
end

handlers.ui_create_widget = function(args)
    local kind = args.kind
    local validKinds = {
        Frame = true, ScrollingFrame = true, ImageLabel = true, ImageButton = true,
        TextLabel = true, TextButton = true, TextBox = true, ViewportFrame = true,
        VideoFrame = true, ScreenGui = true, BillboardGui = true, SurfaceGui = true,
    }
    if not validKinds[kind] then error("ui_create_widget: unsupported kind '" .. tostring(kind) .. "'") end
    local parent = resolvePath(args.parentPath)
    ChangeHistoryService:SetWaypoint("supertool: ui_create_widget " .. kind)
    local inst = Instance.new(kind)
    if args.name then inst.Name = args.name end
    if args.properties then
        for k, v in pairs(args.properties) do
            local existingOk, existing = pcall(function() return inst[k] end)
            local expectedType = existingOk and typeof(existing) or nil
            local ok, err = pcall(function() inst[k] = deserializeValue(v, expectedType) end)
            if not ok then warn("ui_create_widget: failed to set " .. k .. ": " .. tostring(err)) end
        end
    end
    inst.Parent = parent
    return { ok = true, path = instancePath(inst), kind = kind }
end

------------------------------------------------------------------------------
-- SCRIPT TAB — analysis
------------------------------------------------------------------------------
handlers.script_find_references = function(args)
    local symbol = args.symbol
    if not symbol or symbol == "" then error("script_find_references: empty symbol") end
    local results = {}
    local total = 0
    local function visit(inst)
        if inst:IsA("LuaSourceContainer") then
            local source = inst.Source or ""
            local lineNo = 0
            for line in (source .. "\n"):gmatch("(.-)\n") do
                lineNo = lineNo + 1
                if string.find(line, symbol, 1, true) then
                    total = total + 1
                    table.insert(results, {
                        path = instancePath(inst),
                        line = lineNo,
                        text = line:gsub("^%s+", ""):sub(1, 200),
                    })
                end
            end
        end
        for _, c in ipairs(inst:GetChildren()) do visit(c) end
    end
    visit(args.rootPath and resolvePath(args.rootPath) or game)
    return { ok = true, count = total, references = results }
end

handlers.script_count_lines = function(args)
    local total = 0
    local scripts = 0
    local function visit(inst)
        if inst:IsA("LuaSourceContainer") then
            scripts = scripts + 1
            local source = inst.Source or ""
            local lines = 0
            for _ in (source .. "\n"):gmatch("(.-)\n") do lines = lines + 1 end
            total = total + lines
        end
        for _, c in ipairs(inst:GetChildren()) do visit(c) end
    end
    visit(args.rootPath and resolvePath(args.rootPath) or game)
    return { ok = true, scripts = scripts, totalLines = total }
end

------------------------------------------------------------------------------
-- PLUGINS TAB — meta
------------------------------------------------------------------------------
handlers.list_plugins = function(args)
    -- Plugin enumeration from within another plugin is not supported by the public API.
    return {
        ok = false,
        error = "Plugin enumeration is not available from within a plugin. Use the Studio Plugins tab UI to manage plugins.",
        note = "From within Studio: Plugins tab > 'Manage Plugins' to see installed plugins.",
    }
end

handlers.studio_info = function(args)
    return {
        ok = true,
        placeId = game.PlaceId,
        placeName = game.Name,
        gameId = game.GameId,
        jobId = game.JobId,
        creatorId = game.CreatorId,
        creatorType = game.CreatorType.Name,
        workspaceStreamingEnabled = workspace.StreamingEnabled,
        ribbonTabsAvailable = { "Home", "Avatar", "Model", "Test", "View", "Plugins", "Script" },
    }
end

------------------------------------------------------------------------------
-- TERRAIN — cylinder, wedge, material replace (parity with Weppy Pro)
------------------------------------------------------------------------------
handlers.terrain_fill_cylinder = function(args)
    local terrain = workspace.Terrain
    if not terrain then error("terrain_fill_cylinder: no Terrain in Workspace") end
    local cframe = CFrame.new(args.position[1], args.position[2], args.position[3])
    if args.cframe then cframe = CFrame.new(table.unpack(args.cframe)) end
    local mat = Enum.Material[args.material] or Enum.Material.Grass
    ChangeHistoryService:SetWaypoint("supertool: terrain_fill_cylinder " .. args.material)
    terrain:FillCylinder(cframe, args.height, args.radius, mat)
    return { ok = true, height = args.height, radius = args.radius, material = args.material }
end

handlers.terrain_fill_wedge = function(args)
    local terrain = workspace.Terrain
    if not terrain then error("terrain_fill_wedge: no Terrain in Workspace") end
    local cframe = CFrame.new(table.unpack(args.cframe))
    local size = Vector3.new(args.size[1], args.size[2], args.size[3])
    local mat = Enum.Material[args.material] or Enum.Material.Grass
    ChangeHistoryService:SetWaypoint("supertool: terrain_fill_wedge " .. args.material)
    terrain:FillWedge(cframe, size, mat)
    return { ok = true, size = args.size, material = args.material }
end

handlers.terrain_replace_material = function(args)
    local terrain = workspace.Terrain
    if not terrain then error("terrain_replace_material: no Terrain in Workspace") end
    local minV = Vector3.new(args.min[1], args.min[2], args.min[3])
    local maxV = Vector3.new(args.max[1], args.max[2], args.max[3])
    local region = Region3.new(minV, maxV):ExpandToGrid(4)
    local sourceMat = Enum.Material[args.sourceMaterial]
    local targetMat = Enum.Material[args.targetMaterial]
    if not sourceMat or not targetMat then error("terrain_replace_material: invalid material name") end
    local resolution = args.resolution or 4
    ChangeHistoryService:SetWaypoint("supertool: terrain_replace_material")
    terrain:ReplaceMaterial(region, resolution, sourceMat, targetMat)
    return { ok = true, source = args.sourceMaterial, target = args.targetMaterial }
end

------------------------------------------------------------------------------
-- SPATIAL — raycast, find ground, collision checks
------------------------------------------------------------------------------
local function buildRaycastParams(args)
    local p = RaycastParams.new()
    if args.filterType == "include" then
        p.FilterType = Enum.RaycastFilterType.Include
    else
        p.FilterType = Enum.RaycastFilterType.Exclude
    end
    if args.filterPaths then
        local instances = {}
        for _, path in ipairs(args.filterPaths) do
            local inst = resolvePath(path)
            if inst then table.insert(instances, inst) end
        end
        p.FilterDescendantsInstances = instances
    end
    p.IgnoreWater = args.ignoreWater or false
    if args.collisionGroup then p.CollisionGroup = args.collisionGroup end
    return p
end

handlers.raycast = function(args)
    local origin = Vector3.new(args.origin[1], args.origin[2], args.origin[3])
    local direction
    if args.direction then
        direction = Vector3.new(args.direction[1], args.direction[2], args.direction[3])
    elseif args.target then
        direction = Vector3.new(args.target[1], args.target[2], args.target[3]) - origin
    else
        error("raycast: need direction or target")
    end
    if args.maxDistance then
        direction = direction.Unit * args.maxDistance
    end
    local params = buildRaycastParams(args)
    local result = workspace:Raycast(origin, direction, params)
    if not result then
        return { ok = true, hit = false, end_position = serializeValue(origin + direction) }
    end
    return {
        ok = true,
        hit = true,
        position = serializeValue(result.Position),
        normal = serializeValue(result.Normal),
        material = result.Material.Name,
        instance = instancePath(result.Instance),
        distance = (result.Position - origin).Magnitude,
    }
end

handlers.find_ground = function(args)
    local origin = Vector3.new(args.origin[1], args.origin[2] + (args.skyOffset or 100), args.origin[3])
    local maxDistance = args.maxDistance or 1000
    local direction = Vector3.new(0, -maxDistance, 0)
    local params = buildRaycastParams(args)
    local result = workspace:Raycast(origin, direction, params)
    if not result then
        return { ok = false, error = "no ground hit within " .. maxDistance .. " studs" }
    end
    return {
        ok = true,
        position = serializeValue(result.Position),
        normal = serializeValue(result.Normal),
        material = result.Material.Name,
        instance = instancePath(result.Instance),
        groundY = result.Position.Y,
    }
end

handlers.region_query = function(args)
    -- Find all BaseParts whose bounding box intersects the given region.
    local minV = Vector3.new(args.min[1], args.min[2], args.min[3])
    local maxV = Vector3.new(args.max[1], args.max[2], args.max[3])
    local region = Region3.new(minV, maxV)
    local params = OverlapParams.new()
    params.FilterType = Enum.RaycastFilterType.Exclude
    params.FilterDescendantsInstances = {}
    if args.excludePaths then
        local insts = {}
        for _, p in ipairs(args.excludePaths) do
            local inst = resolvePath(p)
            if inst then table.insert(insts, inst) end
        end
        params.FilterDescendantsInstances = insts
    end
    params.MaxParts = args.maxParts or 200
    local size = region.Size
    local center = (minV + maxV) / 2
    local parts = workspace:GetPartBoundsInBox(CFrame.new(center), size, params)
    local out = {}
    for _, part in ipairs(parts) do
        table.insert(out, instancePath(part))
    end
    return { ok = true, count = #out, paths = out }
end

handlers.touching_parts = function(args)
    local part = resolvePath(args.path)
    if not part:IsA("BasePart") then error("touching_parts: target is not a BasePart") end
    local touching = part:GetTouchingParts()
    local out = {}
    for _, p in ipairs(touching) do table.insert(out, instancePath(p)) end
    return { ok = true, count = #out, paths = out }
end

------------------------------------------------------------------------------
-- ROBLOX MARKETPLACE / TOOLBOX search
------------------------------------------------------------------------------
handlers.catalog_search = function(args)
    local AvatarEditorService = game:GetService("AvatarEditorService")
    local sp = CatalogSearchParams.new()
    if args.searchKeyword then sp.SearchKeyword = args.searchKeyword end
    if args.minPrice then sp.MinPrice = args.minPrice end
    if args.maxPrice then sp.MaxPrice = args.maxPrice end
    if args.assetTypes then
        local types = {}
        for _, t in ipairs(args.assetTypes) do
            local enumItem = Enum.AvatarAssetType[t] or Enum.AssetType[t]
            if enumItem then table.insert(types, enumItem) end
        end
        sp.AssetTypes = types
    end
    if args.bundleTypes then
        local bts = {}
        for _, t in ipairs(args.bundleTypes) do
            local enumItem = Enum.BundleType[t]
            if enumItem then table.insert(bts, enumItem) end
        end
        sp.BundleTypes = bts
    end
    if args.sortType then
        local enumItem = Enum.CatalogSortType[args.sortType]
        if enumItem then sp.SortType = enumItem end
    end

    local pages
    local ok, err = pcall(function() pages = AvatarEditorService:SearchCatalog(sp) end)
    if not ok then return { ok = false, error = "SearchCatalog failed: " .. tostring(err) } end
    if not pages then return { ok = false, error = "SearchCatalog returned nil" } end

    local items = pages:GetCurrentPage()
    local results = {}
    local maxResults = args.maxResults or 25
    for i, item in ipairs(items) do
        if i > maxResults then break end
        table.insert(results, {
            id = item.Id,
            itemType = item.ItemType and item.ItemType.Name or nil,
            assetType = item.AssetType and item.AssetType.Name or nil,
            name = item.Name,
            description = item.Description,
            price = item.Price,
            creatorName = item.CreatorName,
            creatorType = item.CreatorType and item.CreatorType.Name or nil,
        })
    end
    return { ok = true, count = #results, items = results }
end

------------------------------------------------------------------------------
-- PLAY pause/resume (best effort — Studio restrictions apply)
------------------------------------------------------------------------------
handlers.play_pause = function(args)
    local ok, err = pcall(function()
        ---@diagnostic disable-next-line: undefined-field
        if RunService.Pause then RunService:Pause() end
    end)
    return {
        ok = ok,
        isRunning = RunService:IsRunning(),
        note = "Plugins can't always pause play. If unchanged, use Studio's pause button.",
        error = (not ok) and tostring(err) or nil,
    }
end

handlers.play_resume = function(args)
    local ok, err = pcall(function()
        ---@diagnostic disable-next-line: undefined-field
        if RunService.Run then RunService:Run() end
    end)
    return {
        ok = ok,
        isRunning = RunService:IsRunning(),
        error = (not ok) and tostring(err) or nil,
    }
end

------------------------------------------------------------------------------
-- COLLISION GROUPS (PhysicsService)
------------------------------------------------------------------------------
handlers.collision_group_create = function(args)
    local PhysicsService = game:GetService("PhysicsService")
    local ok, err = pcall(function() PhysicsService:RegisterCollisionGroup(args.name) end)
    return { ok = ok, group = args.name, error = (not ok) and tostring(err) or nil }
end

handlers.collision_group_set_collidable = function(args)
    local PhysicsService = game:GetService("PhysicsService")
    local ok, err = pcall(function()
        PhysicsService:CollisionGroupSetCollidable(args.group1, args.group2, args.collidable)
    end)
    return { ok = ok, error = (not ok) and tostring(err) or nil }
end

handlers.collision_group_assign = function(args)
    local PhysicsService = game:GetService("PhysicsService")
    local part = resolvePath(args.path)
    if not part:IsA("BasePart") then error("collision_group_assign: target is not a BasePart") end
    part.CollisionGroup = args.group
    return { ok = true, path = instancePath(part), group = args.group }
end

handlers.command_bar = function(args)
    local code = args.code
    if not code or code == "" then error("command_bar: empty code") end
    local capturedOut = {}
    local capturedErr = {}
    local origPrint = print
    local origWarn = warn
    _G.print = function(...)
        local parts = { ... }
        for i = 1, select("#", ...) do parts[i] = tostring(parts[i]) end
        table.insert(capturedOut, table.concat(parts, "\t"))
        return origPrint(...)
    end
    _G.warn = function(...)
        local parts = { ... }
        for i = 1, select("#", ...) do parts[i] = tostring(parts[i]) end
        table.insert(capturedErr, table.concat(parts, "\t"))
        return origWarn(...)
    end
    local fn, loadErr = loadstring(code)
    _G.print = origPrint
    _G.warn = origWarn
    if not fn then return { ok = false, error = "load: " .. tostring(loadErr) } end
    _G.print = function(...)
        local parts = { ... }
        for i = 1, select("#", ...) do parts[i] = tostring(parts[i]) end
        table.insert(capturedOut, table.concat(parts, "\t"))
        return origPrint(...)
    end
    _G.warn = function(...)
        local parts = { ... }
        for i = 1, select("#", ...) do parts[i] = tostring(parts[i]) end
        table.insert(capturedErr, table.concat(parts, "\t"))
        return origWarn(...)
    end
    local ok, runResult = pcall(fn)
    _G.print = origPrint
    _G.warn = origWarn
    return {
        ok = ok,
        result = ok and (runResult ~= nil and tostring(runResult) or nil) or nil,
        error = (not ok) and tostring(runResult) or nil,
        stdout = capturedOut,
        stderr = capturedErr,
    }
end

------------------------------------------------------------------------------
-- Animation
------------------------------------------------------------------------------
handlers.create_animation = function(args)
    local name = args.name
    local frames = args.frames or {}
    local parent = resolvePath(args.parentPath or "game.ServerStorage")
    local loop = args.loop == true

    ChangeHistoryService:SetWaypoint("supertool: create_animation " .. name)
    local seq = Instance.new("KeyframeSequence")
    seq.Name = name
    seq.Loop = loop

    for _, frame in ipairs(frames) do
        local kf = Instance.new("Keyframe")
        kf.Time = frame.time
        for boneName, cframeComponents in pairs(frame.poses or {}) do
            local pose = Instance.new("Pose")
            pose.Name = boneName
            pose.CFrame = CFrame.new(table.unpack(cframeComponents))
            pose.Parent = kf
        end
        kf.Parent = seq
    end
    seq.Parent = parent
    ChangeHistoryService:SetWaypoint("supertool: create_animation done")
    return { path = instancePath(seq), keyframeCount = #frames }
end

handlers.apply_pose = function(args)
    local model = resolvePath(args.modelPath)
    ChangeHistoryService:SetWaypoint("supertool: apply_pose " .. model.Name)
    local applied = 0
    for boneName, cframeComponents in pairs(args.poses or {}) do
        local part = model:FindFirstChild(boneName, true)
        if part and part:IsA("BasePart") then
            part.CFrame = CFrame.new(table.unpack(cframeComponents))
            applied = applied + 1
        end
    end
    ChangeHistoryService:SetWaypoint("supertool: apply_pose done")
    return { applied = applied, model = instancePath(model) }
end

------------------------------------------------------------------------------
-- Terrain
------------------------------------------------------------------------------
local function getTerrain()
    local t = Workspace:FindFirstChildOfClass("Terrain")
    if not t then error("No Terrain in Workspace") end
    return t
end

handlers.terrain_fill_block = function(args)
    local terrain = getTerrain()
    ChangeHistoryService:SetWaypoint("supertool: terrain_fill_block")
    local cf = CFrame.new(table.unpack(args.cframe))
    local size = Vector3.new(args.size[1], args.size[2], args.size[3])
    local mat = Enum.Material[args.material or "Grass"]
    terrain:FillBlock(cf, size, mat)
    ChangeHistoryService:SetWaypoint("supertool: terrain_fill_block done")
    return { ok = true }
end

handlers.terrain_fill_ball = function(args)
    local terrain = getTerrain()
    ChangeHistoryService:SetWaypoint("supertool: terrain_fill_ball")
    local center = Vector3.new(args.center[1], args.center[2], args.center[3])
    local mat = Enum.Material[args.material or "Grass"]
    terrain:FillBall(center, args.radius, mat)
    ChangeHistoryService:SetWaypoint("supertool: terrain_fill_ball done")
    return { ok = true }
end

handlers.terrain_clear_region = function(args)
    local terrain = getTerrain()
    ChangeHistoryService:SetWaypoint("supertool: terrain_clear")
    local minV = Vector3.new(args.min[1], args.min[2], args.min[3])
    local maxV = Vector3.new(args.max[1], args.max[2], args.max[3])
    local size = maxV - minV
    local cf = CFrame.new((minV + maxV) / 2)
    terrain:FillBlock(cf, size, Enum.Material.Air)
    ChangeHistoryService:SetWaypoint("supertool: terrain_clear done")
    return { ok = true }
end

handlers.terrain_set_material_color = function(args)
    local terrain = getTerrain()
    local mat = Enum.Material[args.material]
    local color = Color3.new(args.color[1], args.color[2], args.color[3])
    terrain:SetMaterialColor(mat, color)
    return { ok = true }
end

------------------------------------------------------------------------------
-- DataStore (play mode only)
------------------------------------------------------------------------------
handlers.datastore_get = function(args)
    if not DataStoreService_ok then error("DataStoreService unavailable in this context") end
    local store = DataStoreService:GetDataStore(args.store)
    local val = store:GetAsync(args.key)
    return { value = serializeValue(val) }
end

handlers.datastore_set = function(args)
    if not DataStoreService_ok then error("DataStoreService unavailable in this context") end
    local store = DataStoreService:GetDataStore(args.store)
    store:SetAsync(args.key, deserializeValue(args.value))
    return { ok = true }
end

handlers.datastore_increment = function(args)
    if not DataStoreService_ok then error("DataStoreService unavailable in this context") end
    local store = DataStoreService:GetDataStore(args.store)
    local newVal = store:IncrementAsync(args.key, args.delta or 1)
    return { value = newVal }
end

------------------------------------------------------------------------------
-- Service introspection
------------------------------------------------------------------------------
handlers.list_services = function(args)
    local out = {}
    for _, name in ipairs(STUDIO_SERVICES) do
        local ok, svc = pcall(game.GetService, game, name)
        if ok and svc then
            table.insert(out, {
                name = name,
                className = svc.ClassName,
                childCount = #svc:GetChildren(),
                path = instancePath(svc),
            })
        end
    end
    return { services = out }
end

handlers.class_info = function(args)
    local className = args.className
    -- Best-effort: try to instantiate and inspect properties via known methods/events
    local ok, inst = pcall(Instance.new, className)
    if not ok then return { ok = false, error = "Cannot instantiate: " .. tostring(inst) } end

    local methods, events = {}, {}
    -- Walk metatable - in Luau plugins this is restricted; provide a curated fallback
    -- For now, list common "ABS" properties readable on the instance
    local props = readableProps(inst)
    inst:Destroy()
    return { className = className, properties = props, methods = methods, events = events }
end

handlers.plugin_check_updates = function(args)
    -- Simple version-mismatch check; the server pushes its expected version via /poll if newer.
    -- For now return current plugin version - the server will compare.
    return { pluginVersion = PLUGIN_VERSION }
end

------------------------------------------------------------------------------
-- Output panel capture (LogService.MessageOut)
------------------------------------------------------------------------------
local outputBuffer = {}
local OUTPUT_BUFFER_MAX = 500

local function recordOutput(message, msgType)
    local level = "info"
    if msgType == Enum.MessageType.MessageWarning then level = "warn"
    elseif msgType == Enum.MessageType.MessageError then level = "error" end
    table.insert(outputBuffer, { ts = os.time() * 1000, level = level, text = message })
    while #outputBuffer > OUTPUT_BUFFER_MAX do table.remove(outputBuffer, 1) end
end

LogService.MessageOut:Connect(recordOutput)

local function flushOutput()
    if #outputBuffer == 0 then return end
    local toSend = outputBuffer
    outputBuffer = {}
    pcall(function()
        http("POST", "/output", { messages = toSend })
    end)
end

------------------------------------------------------------------------------
-- Polling loop
------------------------------------------------------------------------------
local stopped = false
local lastConnected = false
local commandLog = {}
local MAX_LOG = 30

local function logCommand(tool, ok, durationMs, errMsg)
    table.insert(commandLog, 1, {
        time = os.date("%H:%M:%S"),
        tool = tool, ok = ok, durationMs = durationMs,
        err = errMsg and string.sub(errMsg, 1, 80) or nil,
    })
    while #commandLog > MAX_LOG do table.remove(commandLog) end
end

local function executeCommand(cmd)
    local startedAt = tick()
    local handler = handlers[cmd.tool]
    if not handler then
        return { id = cmd.id, ok = false, error = "Unknown tool: " .. tostring(cmd.tool), durationMs = 0 }
    end
    local ok, result = pcall(handler, cmd.args or {})
    local durationMs = (tick() - startedAt) * 1000
    logCommand(cmd.tool, ok, durationMs, not ok and result or nil)
    if ok then return { id = cmd.id, ok = true, data = result, durationMs = durationMs }
    else return { id = cmd.id, ok = false, error = tostring(result), durationMs = durationMs } end
end

local function postResult(result)
    pcall(function() http("POST", "/result", result) end)
end

local function pollOnce()
    -- Send credentials on every poll so the server (which holds them only in
    -- memory) repopulates after restart. Empty string clears server-side.
    local ok, body = http("POST", "/poll", {
        pluginVersion    = PLUGIN_VERSION,
        studioPlace      = game.Name,
        apiKey           = apiKey,
        creatorUserId    = creatorUserId,
        creatorGroupId   = creatorGroupId,
        freesoundApiKey  = freesoundApiKey,
    })
    if not ok then
        if lastConnected then print("[Supertool] disconnected from server") end
        lastConnected = false
        return
    end
    if not lastConnected then
        print("[Supertool] connected at " .. SERVER_URL)
        lastConnected = true
    end
    if body.commands then
        for _, cmd in ipairs(body.commands) do
            local result = executeCommand(cmd)
            postResult(result)
        end
    end
end

local function refreshApiKeyStatus()
    local ok, body = http("GET", "/apikey", nil)
    if ok and type(body) == "table" then apiKeyStatus = body end
end

------------------------------------------------------------------------------
-- Dock Widget UI
------------------------------------------------------------------------------
local toolbar = plugin:CreateToolbar("Supertool")
local toggleBtn = toolbar:CreateButton(
    "Supertool", "Open the Roblox Supertool MCP control panel",
    "rbxasset://textures/loading/robloxTilt.png"
)
local readonlyBtn = toolbar:CreateButton(
    "Read-Only", "Toggle read-only mode (blocks all mutating tools)",
    "rbxasset://textures/loading/robloxTilt.png"
)

local widgetInfo = DockWidgetPluginGuiInfo.new(
    Enum.InitialDockState.Right, false, false, 340, 660, 320, 560
)
local widget = plugin:CreateDockWidgetPluginGui("RobloxSupertool", widgetInfo)
widget.Title = "Roblox Supertool v" .. PLUGIN_VERSION

local frame = Instance.new("Frame")
frame.Size = UDim2.fromScale(1, 1)
frame.BackgroundColor3 = Color3.fromRGB(36, 36, 40)
frame.BorderSizePixel = 0
frame.Parent = widget

local function makeLabel(name, text, y, height, color)
    local lbl = Instance.new("TextLabel")
    lbl.Name = name
    lbl.Size = UDim2.new(1, -16, 0, height)
    lbl.Position = UDim2.new(0, 8, 0, y)
    lbl.BackgroundTransparency = 1
    lbl.Text = text
    lbl.Font = Enum.Font.Code
    lbl.TextSize = 13
    lbl.TextColor3 = color or Color3.fromRGB(220, 220, 220)
    lbl.TextXAlignment = Enum.TextXAlignment.Left
    lbl.TextYAlignment = Enum.TextYAlignment.Top
    lbl.Parent = frame
    return lbl
end

local function makeTextBox(name, placeholder, value, y)
    local tb = Instance.new("TextBox")
    tb.Name = name
    tb.Size = UDim2.new(1, -16, 0, 24)
    tb.Position = UDim2.new(0, 8, 0, y)
    tb.BackgroundColor3 = Color3.fromRGB(24, 24, 28)
    tb.BorderColor3 = Color3.fromRGB(70, 70, 80)
    tb.BorderSizePixel = 1
    tb.ClearTextOnFocus = false
    tb.Font = Enum.Font.Code
    tb.TextSize = 12
    tb.TextColor3 = Color3.fromRGB(220, 220, 220)
    tb.PlaceholderText = placeholder
    tb.PlaceholderColor3 = Color3.fromRGB(110, 110, 120)
    tb.Text = value or ""
    tb.TextXAlignment = Enum.TextXAlignment.Left
    tb.TextTruncate = Enum.TextTruncate.AtEnd
    tb.Parent = frame
    return tb
end

local function makeButton(name, text, x, width, y, color)
    local btn = Instance.new("TextButton")
    btn.Name = name
    btn.Size = UDim2.new(0, width, 0, 24)
    btn.Position = UDim2.new(0, x, 0, y)
    btn.BackgroundColor3 = color or Color3.fromRGB(60, 90, 140)
    btn.BorderSizePixel = 0
    btn.Font = Enum.Font.Code
    btn.TextSize = 13
    btn.TextColor3 = Color3.fromRGB(240, 240, 240)
    btn.Text = text
    btn.AutoButtonColor = true
    btn.Parent = frame
    return btn
end

local statusLbl  = makeLabel("Status",   "● Connecting...",          8,  20, Color3.fromRGB(255, 200, 80))
local serverLbl  = makeLabel("Server",   "Server: " .. SERVER_URL,  32,  20, Color3.fromRGB(160, 160, 180))
local versionLbl = makeLabel("Version",  "Plugin v" .. PLUGIN_VERSION, 56, 20, Color3.fromRGB(140, 140, 160))
local roLbl     = makeLabel("ReadOnly", "Read-only: OFF",            80,  20, Color3.fromRGB(140, 200, 140))

-- Open Cloud credentials section
makeLabel("OpenCloudHdr", "Open Cloud", 108, 18, Color3.fromRGB(180, 180, 200))
local apiKeyLbl = makeLabel("ApiKeyStatus", "API key: not configured", 128, 18, Color3.fromRGB(200, 140, 140))

local apiKeyBox       = makeTextBox("ApiKey",       "Open Cloud API key (asset:read + asset:write)",                  apiKey,         150)
local creatorUserBox  = makeTextBox("CreatorUser",  "Creator user ID (your numeric Roblox user id)",                  creatorUserId,  180)
local creatorGroupBox = makeTextBox("CreatorGroup", "Creator group ID (optional, leave blank for user uploads)",      creatorGroupId, 210)

-- Freesound credentials section
makeLabel("FreesoundHdr", "Freesound", 246, 18, Color3.fromRGB(180, 180, 200))
local freesoundLbl = makeLabel("FreesoundStatus", "Freesound: not configured", 266, 18, Color3.fromRGB(200, 140, 140))
local freesoundBox = makeTextBox("FreesoundKey", "Freesound API key (free at freesound.org/apiv2/apply)", freesoundApiKey, 288)

local saveBtn  = makeButton("Save",  "Save",  8,   80, 322, Color3.fromRGB(60, 110, 70))
local clearBtn = makeButton("Clear", "Clear", 92,  80, 322, Color3.fromRGB(120, 60, 60))

local divider = Instance.new("Frame")
divider.Size = UDim2.new(1, -16, 0, 1)
divider.Position = UDim2.new(0, 8, 0, 358)
divider.BackgroundColor3 = Color3.fromRGB(70, 70, 80)
divider.BorderSizePixel = 0
divider.Parent = frame

makeLabel("LogTitle", "Recent commands:", 368, 18, Color3.fromRGB(180, 180, 200))

local logScroll = Instance.new("ScrollingFrame")
logScroll.Size = UDim2.new(1, -16, 1, -402)
logScroll.Position = UDim2.new(0, 8, 0, 392)
logScroll.BackgroundColor3 = Color3.fromRGB(24, 24, 28)
logScroll.BorderSizePixel = 0
logScroll.ScrollBarThickness = 6
logScroll.CanvasSize = UDim2.new(0, 0, 0, 0)
logScroll.Parent = frame

local function pushAllToServer()
    pcall(function()
        http("POST", "/poll", {
            pluginVersion    = PLUGIN_VERSION,
            studioPlace      = game.Name,
            apiKey           = apiKey,
            creatorUserId    = creatorUserId,
            creatorGroupId   = creatorGroupId,
            freesoundApiKey  = freesoundApiKey,
        })
    end)
end

saveBtn.MouseButton1Click:Connect(function()
    apiKey          = apiKeyBox.Text
    creatorUserId   = creatorUserBox.Text
    creatorGroupId  = creatorGroupBox.Text
    freesoundApiKey = freesoundBox.Text
    saveSetting(SETTING_API_KEY,       apiKey)
    saveSetting(SETTING_CREATOR_USER,  creatorUserId)
    saveSetting(SETTING_CREATOR_GROUP, creatorGroupId)
    saveSetting(SETTING_FREESOUND_KEY, freesoundApiKey)
    pushAllToServer()
    refreshApiKeyStatus()
end)

clearBtn.MouseButton1Click:Connect(function()
    apiKey, creatorUserId, creatorGroupId, freesoundApiKey = "", "", "", ""
    apiKeyBox.Text, creatorUserBox.Text, creatorGroupBox.Text, freesoundBox.Text = "", "", "", ""
    saveSetting(SETTING_API_KEY,       "")
    saveSetting(SETTING_CREATOR_USER,  "")
    saveSetting(SETTING_CREATOR_GROUP, "")
    saveSetting(SETTING_FREESOUND_KEY, "")
    pushAllToServer()
    refreshApiKeyStatus()
end)

local logLayout = Instance.new("UIListLayout")
logLayout.Padding = UDim.new(0, 2)
logLayout.SortOrder = Enum.SortOrder.LayoutOrder
logLayout.Parent = logScroll

local readonlyLocal = false
toggleBtn.Click:Connect(function() widget.Enabled = not widget.Enabled end)
readonlyBtn.Click:Connect(function()
    readonlyLocal = not readonlyLocal
    pcall(function() http("POST", "/readonly", { value = readonlyLocal }) end)
end)

local function updateUI()
    if lastConnected then
        statusLbl.Text = "● Connected"
        statusLbl.TextColor3 = Color3.fromRGB(100, 220, 130)
    else
        statusLbl.Text = "● Disconnected — start MCP server"
        statusLbl.TextColor3 = Color3.fromRGB(220, 100, 100)
    end
    if readonlyLocal then
        roLbl.Text = "Read-only: ON"
        roLbl.TextColor3 = Color3.fromRGB(255, 180, 80)
    else
        roLbl.Text = "Read-only: OFF"
        roLbl.TextColor3 = Color3.fromRGB(140, 200, 140)
    end

    if apiKeyStatus.isConfigured then
        local suffix = apiKeyStatus.lastFour and ("••••" .. apiKeyStatus.lastFour) or "configured"
        local creatorBits = {}
        if apiKeyStatus.creatorUserId  then table.insert(creatorBits, "user " .. apiKeyStatus.creatorUserId) end
        if apiKeyStatus.creatorGroupId then table.insert(creatorBits, "group " .. apiKeyStatus.creatorGroupId) end
        local creatorTxt = #creatorBits > 0 and ("  [" .. table.concat(creatorBits, ", ") .. "]") or ""
        apiKeyLbl.Text = "API key: " .. suffix .. creatorTxt
        apiKeyLbl.TextColor3 = Color3.fromRGB(140, 200, 140)
    else
        apiKeyLbl.Text = "API key: not configured"
        apiKeyLbl.TextColor3 = Color3.fromRGB(200, 140, 140)
    end

    local fs = apiKeyStatus.freesound
    if fs and fs.isConfigured then
        local suffix = fs.lastFour and ("••••" .. fs.lastFour) or "configured"
        freesoundLbl.Text = "Freesound: " .. suffix
        freesoundLbl.TextColor3 = Color3.fromRGB(140, 200, 140)
    else
        freesoundLbl.Text = "Freesound: not configured"
        freesoundLbl.TextColor3 = Color3.fromRGB(200, 140, 140)
    end

    for _, child in ipairs(logScroll:GetChildren()) do
        if child:IsA("TextLabel") then child:Destroy() end
    end
    for i, entry in ipairs(commandLog) do
        local color = entry.ok and Color3.fromRGB(180, 220, 180) or Color3.fromRGB(240, 140, 140)
        local symbol = entry.ok and "✓" or "✗"
        local text = string.format("%s %s  %s  (%dms)%s",
            entry.time, symbol, entry.tool, math.floor(entry.durationMs),
            entry.err and "\n      " .. entry.err or "")
        local lbl = Instance.new("TextLabel")
        lbl.Name = "Log_" .. i
        lbl.Size = UDim2.new(1, -8, 0, entry.err and 32 or 16)
        lbl.LayoutOrder = i
        lbl.BackgroundTransparency = 1
        lbl.Text = text
        lbl.Font = Enum.Font.Code
        lbl.TextSize = 11
        lbl.TextColor3 = color
        lbl.TextXAlignment = Enum.TextXAlignment.Left
        lbl.TextYAlignment = Enum.TextYAlignment.Top
        lbl.TextWrapped = true
        lbl.Parent = logScroll
    end
    logScroll.CanvasSize = UDim2.new(0, 0, 0, logLayout.AbsoluteContentSize.Y + 8)
end

------------------------------------------------------------------------------
-- Main loop
------------------------------------------------------------------------------
print(string.format("[Supertool] plugin v%s loaded — server at %s", PLUGIN_VERSION, SERVER_URL))

task.spawn(function()
    local lastUI, lastFlush, lastKey = 0, 0, 0
    while not stopped do
        pollOnce()
        if tick() - lastKey > 2.0 then pcall(refreshApiKeyStatus); lastKey = tick() end
        if tick() - lastUI > 0.5 then pcall(updateUI); lastUI = tick() end
        if tick() - lastFlush > OUTPUT_FLUSH_INTERVAL then pcall(flushOutput); lastFlush = tick() end
        task.wait(POLL_INTERVAL)
    end
end)

plugin.Unloading:Connect(function() stopped = true; flushOutput() end)
