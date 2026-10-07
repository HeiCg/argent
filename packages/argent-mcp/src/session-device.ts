/**
 * Per-session default device. Each Claude session runs its own `argent mcp`
 * process over stdio, while every session shares one tool-server; so the
 * default lives here, in the MCP process, and the tool-server contract (an
 * explicit device id on every device tool) stays as it is.
 */

import { normalizeToolName } from "./auto-capture.js";
import type { McpTool } from "./tool-mapping.js";

/** Arg names that mean "the device to act on" (same set as flow-device.ts DEVICE_BIND_KEYS). */
export type DeviceKey = "udid" | "device_id" | "device";

const DEVICE_KEYS: readonly DeviceKey[] = ["udid", "device_id", "device"];

/** What set the current default. No precedence: the last event wins. */
export type DeviceSource = "use-device" | "boot-device" | "last-call";

export type SessionDeviceState =
  | { defaultDeviceId: string; source: DeviceSource }
  | { defaultDeviceId?: undefined; source?: undefined };

/** The device arg a tool declares, read from its JSON schema. */
export interface DeviceArgSpec {
  key: DeviceKey;
  required: boolean;
}

export type InjectOutcome = { ok: true; args: unknown } | { ok: false; error: string };

export const USE_DEVICE_TOOL_NAME = "use-device";

export const NO_DEVICE_ERROR =
  "No device selected. Call use-device {udid} or pass udid explicitly; list-devices shows the ids.";

/** Appended to the description of a device arg that the MCP layer fills in. */
export const SESSION_DEVICE_HINT = "Optional: defaults to the session device set by use-device.";

/**
 * Arg keys an explicit call teaches the default from. Not `device_id` or
 * `device`: debugger, profiler and network tools accept a Metro
 * logicalDeviceId there, which no device tool takes.
 */
const LEARN_KEYS = ["udid", "serial"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The device arg of a tool, from its schema: the first of udid / device_id /
 * device that is required, else the first that is declared. A tool may declare
 * two (debugger-component-tree: required `device_id`, optional secondary
 * `udid`), and the required one is the target.
 */
export function deviceArgSpec(_toolName: string, inputSchema: unknown): DeviceArgSpec | undefined {
  if (!isRecord(inputSchema) || !isRecord(inputSchema.properties)) return undefined;
  const properties = inputSchema.properties;
  const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
  const declared = DEVICE_KEYS.filter((k) => k in properties);
  const key = declared.find((k) => required.includes(k)) ?? declared[0];
  return key ? { key, required: required.includes(key) } : undefined;
}

/** The device id a successful boot-device returns: `udid` (iOS), `serial` (Android, Vega), `id` (Chromium). */
function bootedDeviceId(result: unknown): string | undefined {
  if (!isRecord(result) || result.booted !== true) return undefined;
  return nonEmptyString(result.udid) ?? nonEmptyString(result.serial) ?? nonEmptyString(result.id);
}

export class SessionDevice {
  private state: SessionDeviceState = {};

  get(): SessionDeviceState {
    return { ...this.state };
  }

  set(id: string, source: DeviceSource = "use-device"): void {
    this.state = { defaultDeviceId: id, source };
  }

  clear(): void {
    this.state = {};
  }

  /** An explicit `udid` (or `serial`) on a successful call becomes the default. */
  learnFromArgs(_toolName: string, args: unknown, _inputSchema?: unknown): void {
    if (!isRecord(args)) return;
    for (const key of LEARN_KEYS) {
      const id = nonEmptyString(args[key]);
      if (id) {
        this.set(id, "last-call");
        return;
      }
    }
  }

  /** A successful boot-device makes the booted device the default. */
  learnFromResult(toolName: string, result: unknown): void {
    if (normalizeToolName(toolName) !== "boot-device") return;
    const id = bootedDeviceId(result);
    if (id) this.set(id, "boot-device");
  }

  /**
   * After a successful stop, forget a default that the stop took down: a
   * `stop-*` tool that names it (in udid / device_id / device or `devices`), or
   * an unscoped `stop-all-simulator-servers`, which stops every device.
   */
  forgetIfStopped(toolName: string, args: unknown): void {
    const name = normalizeToolName(toolName);
    const id = this.state.defaultDeviceId;
    if (!id || !name.startsWith("stop-")) return;
    const record = isRecord(args) ? args : {};
    const devices = Array.isArray(record.devices) ? record.devices : undefined;
    const named = DEVICE_KEYS.some((k) => record[k] === id) || (devices?.includes(id) ?? false);
    const unscopedStopAll = name === "stop-all-simulator-servers" && devices === undefined;
    if (named || unscopedStopAll) this.clear();
  }

  /**
   * Fill the tool's device arg with the default when the call omits it. Only a
   * REQUIRED device arg is filled: an optional one switches a branch of the
   * tool (flow-execute's `device` gates Chromium self-boot, auto-detect and the
   * `platform` filter; boot-device's `udid` is one of four boot selectors). With
   * no default, a required device arg is an error.
   */
  injectIfMissing(toolName: string, args: unknown, inputSchema?: unknown): InjectOutcome {
    const spec = deviceArgSpec(toolName, inputSchema);
    if (!spec?.required) return { ok: true, args };
    const record = isRecord(args) ? args : {};
    if (nonEmptyString(record[spec.key])) return { ok: true, args };
    const id = this.state.defaultDeviceId;
    if (id) return { ok: true, args: { ...record, [spec.key]: id } };
    return { ok: false, error: NO_DEVICE_ERROR };
  }
}

/** The MCP-local tool that sets the session default. The tool-server never sees it. */
export const useDeviceTool: McpTool = {
  name: USE_DEVICE_TOOL_NAME,
  description:
    "Set the default device for this session. A device tool called without its required device " +
    "id (udid, device_id or device) then acts on this device. An id passed explicitly always " +
    "wins for that call. Pass { clear: true } to remove the default. Get the ids from " +
    "list-devices; its last line names the default. The last event sets the default: " +
    "use-device, a successful boot-device, or a successful call that names a udid. A successful " +
    "stop of the default device clears it. The default belongs to this session only: other " +
    "sessions on the same tool-server keep their own.",
  inputSchema: {
    type: "object",
    properties: {
      udid: {
        type: "string",
        description:
          "Device id from list-devices: iOS UDID, Android or Vega serial, or Chromium id.",
      },
      clear: {
        type: "boolean",
        description: "true removes the session default. Do not combine with udid.",
      },
    },
  },
  _meta: {
    "anthropic/alwaysLoad": true,
    "anthropic/searchHint": "default device session select target multi device udid",
  },
};

export function runUseDevice(
  session: SessionDevice,
  args: unknown
): { text: string; isError?: boolean } {
  const record = isRecord(args) ? args : {};
  const udid = nonEmptyString(record.udid);
  const clear = record.clear === true;
  if (udid && !clear) {
    session.set(udid, "use-device");
    return { text: `Default device set to ${udid}` };
  }
  if (clear && record.udid === undefined) {
    session.clear();
    return { text: "Default device cleared" };
  }
  return {
    text: "use-device takes either { udid } or { clear: true }. list-devices shows the ids.",
    isError: true,
  };
}

function listedIds(result: unknown): Set<string> {
  const ids = new Set<string>();
  const devices = isRecord(result) && Array.isArray(result.devices) ? result.devices : [];
  for (const d of devices) {
    if (!isRecord(d)) continue;
    for (const key of ["udid", "serial", "id"]) {
      const id = nonEmptyString(d[key]);
      if (id) ids.add(id);
    }
  }
  return ids;
}

/**
 * The line appended after list-devices' JSON text, naming the session default
 * and what set it. The JSON itself stays valid and unchanged.
 */
export function defaultDeviceLine(result: unknown, state: SessionDeviceState): string | undefined {
  if (!state.defaultDeviceId) return undefined;
  const line = `Default device: ${state.defaultDeviceId} (${state.source})`;
  return listedIds(result).has(state.defaultDeviceId) ? line : `${line} — not in this list`;
}
