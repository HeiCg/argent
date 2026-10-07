import type { ToolMeta } from "@argent/tools-client";
import { SESSION_DEVICE_HINT, deviceArgSpec, useDeviceTool } from "./session-device.js";

export type McpTool = {
  name: string;
  description: string;
  inputSchema: { type: "object" } & Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

/**
 * Maps a tool-server `ToolMeta` to the MCP `tools/list` shape. `alwaysLoad` opts the
 * tool out of Claude Code's progressive tool loading; `searchHint` feeds its ToolSearch
 * BM25 ranker.
 */
export function toMcpTool(t: ToolMeta): McpTool {
  const meta: Record<string, unknown> = {};
  if (t.alwaysLoad) meta["anthropic/alwaysLoad"] = true;
  if (t.searchHint) meta["anthropic/searchHint"] = t.searchHint;
  return {
    name: t.name,
    description: t.description,
    inputSchema: exposeSessionDevice(t.name, { type: "object", ...t.inputSchema }),
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  };
}

/** The `tools/list` payload: every tool-server tool plus the MCP-local ones. */
export function toMcpToolList(tools: ToolMeta[]): McpTool[] {
  return [...tools.map(toMcpTool), useDeviceTool];
}

/**
 * The MCP layer fills a tool's required device arg from the session default
 * (see session-device.ts), so the schema shown to the agent marks it optional:
 * out of `required`, with a hint in its description. The tool-server schema keeps
 * it required; the object passed in is copied, never mutated.
 */
function exposeSessionDevice(
  toolName: string,
  schema: McpTool["inputSchema"]
): McpTool["inputSchema"] {
  const spec = deviceArgSpec(toolName, schema);
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  // Only a required device arg is filled (see injectIfMissing); an optional
  // one keeps its schema as the tool-server wrote it.
  const prop = spec?.required ? properties?.[spec.key] : undefined;
  if (!spec || !prop) return schema;
  const description =
    typeof prop.description === "string" && prop.description.length > 0
      ? `${prop.description} ${SESSION_DEVICE_HINT}`
      : SESSION_DEVICE_HINT;
  const out: McpTool["inputSchema"] = {
    ...schema,
    properties: { ...properties, [spec.key]: { ...prop, description } },
  };
  if (Array.isArray(schema.required)) {
    const required = schema.required.filter((k) => k !== spec.key);
    if (required.length > 0) out.required = required;
    else delete out.required;
  }
  return out;
}
