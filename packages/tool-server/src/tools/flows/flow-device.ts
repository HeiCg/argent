import type { DeviceInfo, Registry, ToolContext } from "@argent/registry";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { isPhysicalIos, resolveDevice } from "../../utils/device-info";
import { invokeSubTool } from "../../utils/sub-invoke";
import type { WhenPlatform } from "./flow-utils";

/**
 * Device resolution + binding for the flow runner. Flows store no device id
 * (they are portable); the runner resolves one from explicit input, a platform
 * hint, or the single booted device — mirroring the SDK's `device()` binding —
 * and injects it schema-aware into each step's tool args.
 */

// One platform set for the whole flows directory — see LAUNCH_PLATFORMS in
// flow-utils, which this aliases via WhenPlatform.
export type FlowPlatform = WhenPlatform;

const DEVICE_BIND_KEYS = ["udid", "device_id"] as const;

interface RawDevice {
  platform: FlowPlatform;
  state?: string;
  udid?: string;
  serial?: string;
  id?: string;
}

function deviceEntryId(d: RawDevice): string | undefined {
  if (d.platform === "ios") return d.udid;
  if (d.platform === "chromium") return d.id;
  return d.serial; // android, vega
}

function isBooted(d: RawDevice): boolean {
  switch (d.platform) {
    case "ios":
      // "Booted" is a simulator; a connected physical iPhone reports
      // "connected", the same way `list-devices` ranks both as ready. The second
      // arm keeps an attached iPhone in the candidate set so it is named by
      // `assertFlowCapableDevice`'s reason rather than by "no booted device
      // found" alongside a list that plainly contains one.
      return d.state === "Booted" || d.state === "connected";
    case "android":
      return d.state === "device";
    case "vega":
      return d.state === "running" || d.state === "device";
    case "chromium":
      return true; // a discovered chromium device is, by definition, reachable
    default:
      return false;
  }
}

function describeDevice(d: RawDevice): string {
  return `${deviceEntryId(d) ?? "?"} (${d.platform}${d.state ? `, ${d.state}` : ""})`;
}

function deviceResolutionError(message: string, all: RawDevice[]): FailureError {
  const list = all.length ? all.map(describeDevice).join(", ") : "none";
  return new FailureError(`${message} Available devices: ${list}.`, {
    error_code: FAILURE_CODES.FLOW_DEVICE_RESOLUTION,
    failure_stage: "flow_device_resolution",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

/**
 * Reject a target the flow runner cannot resolve selectors against.
 *
 * A physical iPhone is listed and reachable, but `fetchFlowTree` sends every
 * iOS device to the native view hierarchy, which is served by a dylib injected
 * with `simctl spawn` — no physical-device equivalent, and `nativeDevtoolsBlueprint`
 * refuses `kind: "device"` outright. The CoreDevice accessibility tree is not a
 * substitute: it carries no testIDs, no geometry, and an order that rotates
 * between reads, so selector matching and `visible`/`hidden` would answer from
 * placeholders (the same reason `flow-tree.ts` allows no fallback to a trimmed
 * tree). Say that once, here, instead of letting every selector step fail with a
 * devtools error and a "restart the argent server" hint that cannot help.
 */
function assertFlowCapableDevice(device: DeviceInfo): DeviceInfo {
  if (isPhysicalIos(device)) {
    throw new FailureError(
      `Flows cannot run against the physical iPhone "${device.id}": selectors resolve against the native view hierarchy, which needs argent's devtools dylib injected into the app — there is no physical-device equivalent. Drive it with describe + gesture-tap / gesture-swipe, or run the flow on a simulator.`,
      {
        error_code: FAILURE_CODES.FLOW_DEVICE_RESOLUTION,
        failure_stage: "flow_device_resolution",
        failure_area: "tool_server",
        error_kind: "unsupported",
      }
    );
  }
  return device;
}

/**
 * Resolve the device a flow runs against. Order: explicit `device` id → the
 * single booted device of `platform` → the single booted device overall →
 * throw, enumerating what is available.
 */
export async function resolveFlowDevice(
  registry: Registry,
  ctx: ToolContext | undefined,
  opts: { device?: string; platform?: FlowPlatform }
): Promise<DeviceInfo> {
  if (opts.device) return assertFlowCapableDevice(resolveDevice(opts.device));

  const { devices } = (await invokeSubTool(registry, ctx, "list-devices", {})) as {
    devices: RawDevice[];
  };
  const booted = devices.filter(isBooted);
  const scoped = opts.platform ? booted.filter((d) => d.platform === opts.platform) : booted;

  if (scoped.length === 1) {
    const id = deviceEntryId(scoped[0]);
    if (id) return assertFlowCapableDevice(resolveDevice(id));
  }
  if (scoped.length === 0) {
    const what = opts.platform
      ? `No booted ${opts.platform} device found.`
      : "No booted device found.";
    throw deviceResolutionError(`${what} Pass a device id or platform explicitly.`, devices);
  }
  throw deviceResolutionError(
    `${scoped.length} booted devices matched — pass --device or --platform to disambiguate.`,
    scoped
  );
}

/** Strip the device-id keys from a set of args (so a flow stores none). */
export function stripDeviceKeys(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  for (const k of DEVICE_BIND_KEYS) delete out[k];
  return out;
}

/**
 * Bind the resolved device id into a tool's args. The runner is **authoritative**
 * on device: any device id stored in the step is dropped and replaced with the
 * resolved one — so a flow recorded on one device stays portable to another and
 * a stale baked-in udid can't override the run target. The id is injected only
 * for the device-id keys the tool's input schema declares (so `.strict()`
 * schemas stay valid).
 */
export function bindDeviceArgs(
  registry: Registry,
  toolName: string,
  deviceId: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const toolDef = registry.getTool(toolName);
  const props = (toolDef?.inputSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  const out = stripDeviceKeys(args);
  if (props) {
    for (const k of DEVICE_BIND_KEYS) if (k in props) out[k] = deviceId;
  }
  return out;
}
