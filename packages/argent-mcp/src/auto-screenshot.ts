/**
 * Tunables and predicates for the screenshot the MCP layer appends after a
 * successful interaction tool call.
 */

import { isFlagEnabled, type FlagsPathOptions } from "@argent/configuration-core";
import { toMcpContent, type ContentBlock, type ContentContext } from "./content.js";

export const AUTO_SCREENSHOT_TOOLS = new Set([
  "gesture-tap",
  "gesture-swipe",
  "gesture-scroll",
  "gesture-drag",
  "gesture-custom",
  "gesture-pinch",
  "gesture-rotate",
  "button",
  "keyboard",
  "paste",
  "rotate",
  "launch-app",
  "restart-app",
  "open-url",
  "describe",
  "run-sequence",
]);

/**
 * Per-tool cap (ms) on the `await-screen-idle` wait before capturing; the poll
 * usually returns well under it. Doubles as a blind sleep when the tool-server
 * offers no `await-screen-idle`.
 */
export const AUTO_SCREENSHOT_DELAY_MS_BY_TOOL: Record<string, number> = {
  "launch-app": 3000,
  "restart-app": 3000,
  "open-url": 2000,
  "gesture-swipe": 1500,
  "gesture-scroll": 1500,
  "gesture-drag": 1500,
  "gesture-custom": 1500,
  "gesture-tap": 1500,
  "gesture-pinch": 1500,
  "gesture-rotate": 1500,
  "run-sequence": 15000,
  "button": 1500,
  "rotate": 1000,
  "keyboard": 300,
  "paste": 300,
  "describe": 100,
};

const DEFAULT_DELAY_MS = 1400;

// Opt-out only: the `disable-auto-screenshot` flag is off by default.
// `options` lets tests point flag storage at a temp dir.
export function autoScreenshotEnabled(options?: FlagsPathOptions): boolean {
  return !isFlagEnabled("disable-auto-screenshot", options);
}

/**
 * Marker of a server-side secret placeholder (`{{secret:NAME}}`, resolved by
 * the tool-server before typing). Copy of SECRET_PLACEHOLDER_MARKER in
 * packages/tool-server/src/utils/secrets.ts, which argent-mcp does not depend
 * on.
 */
export const SECRET_PLACEHOLDER_MARKER = "{{secret:";

/**
 * Deep-scan tool args for a secret placeholder; when one is present the
 * auto-screenshot must be skipped, because a non-secure-entry field would hand
 * the resolved plaintext back to the model as pixels. JSON.stringify reaches
 * nested shapes (run-sequence steps) without knowing each tool's schema.
 */
export function containsSecretPlaceholder(args: unknown): boolean {
  try {
    return JSON.stringify(args)?.includes(SECRET_PLACEHOLDER_MARKER) ?? false;
  } catch {
    // Unserializable args can't have come from an MCP request; fail safe.
    return true;
  }
}

export function getUdidFromArgs(args: unknown): string | undefined {
  if (
    args &&
    typeof args === "object" &&
    "udid" in args &&
    typeof (args as { udid: unknown }).udid === "string"
  ) {
    return (args as { udid: string }).udid;
  }
  return undefined;
}

/** Strip the client's `mcp__server__` prefix so the allow-list sees canonical names. */
export function normalizeToolName(name: string): string {
  const idx = name.lastIndexOf("__");
  return idx === -1 ? name : name.slice(idx + 2);
}

export function shouldAutoScreenshot(toolName: string): boolean {
  const canonical = normalizeToolName(toolName);
  return canonical !== "screenshot" && AUTO_SCREENSHOT_TOOLS.has(canonical);
}

/**
 * Content context for rendering the screenshot appended after an interaction.
 *
 * `transient` is the load-bearing field: the `screenshot` tool tags its output
 * to be saved durably under the project's `.argent/screenshots/`, which is what
 * a caller who asked for a screenshot wants and the opposite of what this one
 * does. An auto-screenshot rides along on most tool calls in a session and is
 * shown inline once, never referred to by path again, so persisting it would
 * accumulate hundreds of PNGs in the user's working tree. The tool-server cannot
 * make the distinction — an auto-screenshot reaches it as the same
 * `POST /tools/screenshot` an agent's own call does — so it is drawn here, in
 * the layer that synthesized the invocation.
 */
export function autoScreenshotContext(opts: {
  toolsUrl: string;
  authToken?: string;
  udid: string;
}): ContentContext {
  return {
    toolsUrl: opts.toolsUrl,
    authToken: opts.authToken,
    deviceId: opts.udid,
    transient: true,
  };
}

/**
 * Render the auto-screenshot's tool result into content blocks.
 *
 * The rendering is here rather than at the call site so the context above is
 * the only one this path can be given: a context assembled beside the render
 * would be a plain object literal in `mcp-server.ts`, where dropping
 * `transient` costs nothing that any test can see, and the cost of dropping it
 * is a PNG written into the user's project after every interaction.
 */
export function renderAutoScreenshot(
  result: unknown,
  opts: { toolsUrl: string; authToken?: string; udid: string }
): Promise<ContentBlock[]> {
  return toMcpContent(result, "image", autoScreenshotContext(opts));
}

export function getAutoScreenshotDelayMs(toolName: string): number {
  const canonical = normalizeToolName(toolName);
  const base = AUTO_SCREENSHOT_DELAY_MS_BY_TOOL[canonical] ?? DEFAULT_DELAY_MS;
  const envOverride = process.env.ARGENT_AUTO_SCREENSHOT_DELAY_MS;
  if (envOverride) {
    const envMs = parseInt(envOverride, 10);
    if (!Number.isNaN(envMs)) return Math.max(base, envMs);
  }
  return base;
}
