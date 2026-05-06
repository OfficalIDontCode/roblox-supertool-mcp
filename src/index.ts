#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { startHttpBridge } from "./http-bridge.js";
import { TOOLS, callTool, isRichResult } from "./tools/registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Zod → JSON Schema converter (covers what our tool registry uses)
// ─────────────────────────────────────────────────────────────────────────────

function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = describe(value as z.ZodTypeAny);
    if (!isOptional(value as z.ZodTypeAny)) required.push(key);
  }

  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function isOptional(t: z.ZodTypeAny): boolean {
  if (t instanceof z.ZodOptional) return true;
  if (t instanceof z.ZodDefault) return true;
  if (t instanceof z.ZodNullable) return true;
  return false;
}

function describe(t: z.ZodTypeAny): Record<string, unknown> {
  const def = (t as { _def: { typeName?: string; description?: string } })._def;
  const desc = def.description;
  const base: Record<string, unknown> = desc ? { description: desc } : {};

  if (t instanceof z.ZodOptional) return describe((t as unknown as { unwrap: () => z.ZodTypeAny }).unwrap());
  if (t instanceof z.ZodNullable) return describe((t as unknown as { unwrap: () => z.ZodTypeAny }).unwrap());
  if (t instanceof z.ZodDefault) {
    const inner = (t as unknown as { _def: { innerType: z.ZodTypeAny; defaultValue: () => unknown } })._def;
    return { ...describe(inner.innerType), default: inner.defaultValue() };
  }

  if (t instanceof z.ZodString)  return { ...base, type: "string" };
  if (t instanceof z.ZodNumber)  return { ...base, type: "number" };
  if (t instanceof z.ZodBoolean) return { ...base, type: "boolean" };

  if (t instanceof z.ZodLiteral) {
    const v = (t as unknown as { _def: { value: unknown } })._def.value;
    return { ...base, const: v };
  }

  if (t instanceof z.ZodEnum) {
    return { ...base, type: "string", enum: (t as unknown as { options: string[] }).options };
  }

  if (t instanceof z.ZodArray) {
    const inner = (t as unknown as { _def: { type: z.ZodTypeAny; minLength?: { value: number }; maxLength?: { value: number } } })._def;
    const out: Record<string, unknown> = { ...base, type: "array", items: describe(inner.type) };
    if (inner.minLength) out.minItems = inner.minLength.value;
    if (inner.maxLength) out.maxItems = inner.maxLength.value;
    return out;
  }

  if (t instanceof z.ZodTuple) {
    const items = (t as unknown as { _def: { items: z.ZodTypeAny[] } })._def.items.map(describe);
    return { ...base, type: "array", prefixItems: items, minItems: items.length, maxItems: items.length };
  }

  if (t instanceof z.ZodUnion) {
    const opts = (t as unknown as { _def: { options: z.ZodTypeAny[] } })._def.options.map(describe);
    return { ...base, oneOf: opts };
  }

  if (t instanceof z.ZodRecord) {
    return { ...base, type: "object", additionalProperties: true };
  }

  if (t instanceof z.ZodObject) {
    return { ...base, ...zodToJsonSchema(t as z.ZodObject<z.ZodRawShape>) };
  }

  if (t instanceof z.ZodUnknown || t instanceof z.ZodAny) return base;

  return base;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP server
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  startHttpBridge();

  const server = new Server(
    { name: "roblox-supertool", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description + (t.mutates ? " [MUTATES]" : " [READ-ONLY]"),
      inputSchema: zodToJsonSchema(t.schema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const data = await callTool(name, (args ?? {}) as Record<string, unknown>);
      // Rich content (text + image blocks) — used by asset_search_visual etc.
      if (isRichResult(data)) {
        return { content: data.__mcpContent };
      }
      return {
        content: [
          {
            type: "text",
            text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[supertool] mcp server connected via stdio (${TOOLS.length} tools)\n`);
}

main().catch((err) => {
  process.stderr.write(`[supertool] fatal: ${err}\n`);
  process.exit(1);
});
