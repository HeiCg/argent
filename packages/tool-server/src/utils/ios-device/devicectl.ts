import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { FAILURE_CODES, subprocessFailureMetadata, withFailureSignal } from "@argent/registry";
import { appendHintToMessage } from "./usbmux-protocol";

const execFileAsync = promisify(execFile);

/**
 * Wrappers around `xcrun devicectl`, Apple's CoreDevice CLI (Xcode 15+) and
 * the control plane for physical iPhones/iPads: discovery, app lifecycle, and
 * connection readiness. The XCUITest runner (interaction/snapshot path) is
 * separate; see runner-build.ts / the ios-device-runner blueprint.
 *
 * One invariant that follows from how devicectl actually behaves (verified
 * against real devices): JSON output goes to a FILE (`--json-output <tmp>`),
 * never stdout. stdout/stderr are only good for error-hint matching.
 */

/** Default timeout for one-shot devicectl calls. Installs get a longer one. */
const DEVICECTL_TIMEOUT_MS = 20_000;
const DEVICECTL_INSTALL_TIMEOUT_MS = 120_000;
const DEVICECTL_LIST_TIMEOUT_MS = 8_000;

interface IosPhysicalDevice {
  /** Dashed hardware UDID (e.g. `00008110-000978540290401E`). */
  udid: string;
  name: string;
  /** Marketing name when available (e.g. "iPhone 13"). */
  model: string | null;
  osVersion: string | null;
  developerModeEnabled: boolean | null;
  /** CoreDevice pairing state, e.g. "paired". */
  pairingState: string | null;
  /**
   * How CoreDevice currently reaches the device: "wired" while cabled,
   * "localNetwork" once unplugged (live-verified values, devicectl 518.x).
   * Reachability for argent's usbmux transport gates on "wired" alone.
   */
  transportType: string | null;
  tunnelState: string | null;
}

class IosDeviceControlError extends Error {
  /** Kept for callers that branch on it; the message carries the same text. */
  readonly hint: string | null;
  constructor(message: string, opts?: { hint?: string; cause?: unknown }) {
    super(appendHintToMessage(message, opts?.hint));
    this.name = "IosDeviceControlError";
    this.hint = opts?.hint ?? null;
    if (opts?.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** Map devicectl failure output to an actionable hint; the matched strings are
 * stable across recent Xcodes. */
function resolveDevicectlHint(output: string): string {
  const lower = output.toLowerCase();
  // CoreDeviceError 10002 "The application failed to launch" is what a locked
  // screen produces (seen live on iOS 26). Surface unlock first: it is by far
  // the most common cause on an otherwise healthy paired device.
  if (lower.includes("failed to launch") || lower.includes("10002")) {
    return "Unlock the device and keep the screen awake, then retry; a locked iPhone refuses app launches.";
  }
  if (lower.includes("developer disk image") || lower.includes("developer mode is disabled")) {
    return (
      "Enable Developer Mode on the device (Settings > Privacy & Security > " +
      "Developer Mode), restart it when prompted, then retry."
    );
  }
  if (lower.includes("must be paired") || lower.includes("pairing")) {
    return "Connect the device by cable, accept the Trust prompt, enter the device passcode, then retry.";
  }
  if (lower.includes("device is busy") || lower.includes("connecting")) {
    return "Keep the device unlocked and connected until it shows as available in Xcode > Devices, then retry.";
  }
  if (lower.includes("timed out")) {
    return "Reconnect the cable, unlock the device, and retry; restarting Xcode's device services can help.";
  }
  return "Ensure the device is unlocked, trusted, and visible in Xcode > Devices, then retry.";
}

interface RunDevicectlOptions {
  timeoutMs?: number;
  /** When set, appends `--json-output <tmpfile>` and returns the parsed JSON. */
  json?: boolean;
}

async function runDevicectl(
  args: string[],
  action: string,
  opts: RunDevicectlOptions = {}
): Promise<{ stdout: string; stderr: string; json: unknown | null }> {
  const timeoutMs = opts.timeoutMs ?? DEVICECTL_TIMEOUT_MS;
  let jsonPath: string | null = null;
  const argv = ["devicectl", ...args];
  if (opts.json) {
    jsonPath = path.join(os.tmpdir(), `argent-devicectl-${process.pid}-${randomUUID()}.json`);
    argv.push("--json-output", jsonPath);
  }
  try {
    const { stdout, stderr } = await execFileAsync("xcrun", argv, {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
    });
    let json: unknown | null = null;
    if (jsonPath) {
      try {
        json = JSON.parse(await fs.readFile(jsonPath, "utf8"));
      } catch {
        json = null;
      }
    }
    return { stdout, stderr, json };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout ?? "", e.stderr ?? "", e.message ?? ""].join("\n");
    // Error payloads are still written to --json-output; keep them for callers
    // that need structured error details beyond the message text.
    let errorJson: unknown | null = null;
    if (jsonPath) {
      try {
        errorJson = JSON.parse(await fs.readFile(jsonPath, "utf8"));
      } catch {
        errorJson = null;
      }
    }
    throw withFailureSignal(
      new IosDeviceControlError(`Failed to ${action}: ${firstLine(e.stderr || e.message)}`, {
        hint: resolveDevicectlHint(output),
        cause: Object.assign(error as Error, { devicectlJson: errorJson }),
      }),
      {
        error_code: FAILURE_CODES.IOS_DEVICECTL_COMMAND_FAILED,
        failure_stage: "ios_devicectl_command",
        failure_area: "tool_server",
        error_kind: "subprocess",
        // devicectl has no FAILURE_COMMANDS entry; keep the exit-code/signal
        // metadata and let the command category read "unknown".
        ...subprocessFailureMetadata(error, "unknown"),
      }
    );
  } finally {
    if (jsonPath) await fs.rm(jsonPath, { force: true }).catch(() => {});
  }
}

function firstLine(text: string | undefined): string {
  return (text ?? "").trim().split("\n")[0] ?? "";
}

interface DevicectlListPayload {
  result?: {
    devices?: Array<{
      identifier?: string;
      hardwareProperties?: {
        udid?: string;
        platform?: string;
        productType?: string;
        marketingName?: string;
        reality?: string;
      };
      deviceProperties?: {
        name?: string;
        osVersionNumber?: string;
        developerModeStatus?: string;
      };
      connectionProperties?: {
        pairingState?: string;
        transportType?: string;
        tunnelState?: string;
      };
    }>;
  };
}

/**
 * List physical iOS-family devices CoreDevice can currently see. Rows can
 * include devices CoreDevice only remembers or reaches over the network;
 * callers gate reachability on `transportType === "wired"`. Returns [] when
 * devicectl is missing or fails, so discovery composes with the other
 * platform listers on non-mac hosts, same contract as `listIosSimulators`.
 */
export async function listIosPhysicalDevices(): Promise<IosPhysicalDevice[]> {
  if (process.platform !== "darwin") return [];
  try {
    const { json } = await runDevicectl(["list", "devices"], "list devices", {
      json: true,
      timeoutMs: DEVICECTL_LIST_TIMEOUT_MS,
    });
    const payload = json as DevicectlListPayload | null;
    const devices = payload?.result?.devices ?? [];
    const out: IosPhysicalDevice[] = [];
    for (const d of devices) {
      const hw = d.hardwareProperties ?? {};
      const udid = hw.udid ?? d.identifier;
      if (!udid) continue;
      // iPhone/iPad only for now; tvOS/visionOS hardware is untested here.
      const platform = (hw.platform ?? "").toLowerCase();
      const productType = hw.productType ?? null;
      if (platform !== "ios" && !/^(iphone|ipad|ipod)/i.test(productType ?? "")) continue;
      // Physical hardware only. Live-verified payloads: real phones report
      // reality "physical"; simulators, when CoreDevice lists them, report
      // "simulated" with otherwise-passing platform/productType. The field is
      // absent on older toolchains, so only an explicit non-physical value
      // skips the row.
      if (hw.reality != null && hw.reality !== "physical") continue;
      out.push({
        udid,
        name: d.deviceProperties?.name ?? productType ?? udid,
        model: hw.marketingName ?? productType ?? null,
        osVersion: d.deviceProperties?.osVersionNumber ?? null,
        developerModeEnabled:
          d.deviceProperties?.developerModeStatus == null
            ? null
            : d.deviceProperties.developerModeStatus === "enabled",
        pairingState: d.connectionProperties?.pairingState ?? null,
        transportType: d.connectionProperties?.transportType ?? null,
        tunnelState: d.connectionProperties?.tunnelState ?? null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Install a .app / .ipa onto the device. */
export async function installApp(udid: string, installablePath: string): Promise<void> {
  await runDevicectl(
    ["device", "install", "app", "--device", udid, installablePath],
    "install app",
    {
      timeoutMs: DEVICECTL_INSTALL_TIMEOUT_MS,
    }
  );
}

/** Uninstall by bundle id; "not installed" counts as success (idempotent). */
export async function uninstallApp(udid: string, bundleId: string): Promise<void> {
  try {
    await runDevicectl(["device", "uninstall", "app", "--device", udid, bundleId], "uninstall app");
  } catch (error) {
    const text = String((error as Error & { cause?: { stderr?: string } }).cause?.stderr ?? error);
    if (/not installed|not found|no such file/i.test(text)) return;
    throw error;
  }
}

interface LaunchAppOptions {
  terminateExisting?: boolean;
}

/** Launch an installed app by bundle id. */
export async function launchApp(
  udid: string,
  bundleId: string,
  opts: LaunchAppOptions = {}
): Promise<void> {
  const args = ["device", "process", "launch", "--device", udid];
  if (opts.terminateExisting) args.push("--terminate-existing");
  args.push(bundleId);
  await runDevicectl(args, `launch ${bundleId}`);
}

interface DeviceConnectionInfo {
  transportType: string | null;
  tunnelState: string | null;
}

interface DevicectlDetailsPayload {
  result?: {
    connectionProperties?: { transportType?: string; tunnelState?: string };
    device?: { connectionProperties?: { transportType?: string; tunnelState?: string } };
  };
}

/**
 * Read the device's CoreDevice connection details. `tunnelState: "connecting"`
 * means NOT ready; commands issued in that window time out. (The tunnel is
 * CoreDevice's own control channel and exists over USB too; this is a
 * readiness probe, not a Wi-Fi route.) `transportType` reports the same wired/
 * localNetwork values as `list devices` (live-verified, devicectl 518.33).
 */
async function deviceInfoDetails(
  udid: string,
  opts: { timeoutSeconds?: number } = {}
): Promise<DeviceConnectionInfo> {
  const timeoutSeconds = opts.timeoutSeconds ?? 10;
  const { json } = await runDevicectl(
    ["device", "info", "details", "--device", udid, "--timeout", String(timeoutSeconds)],
    "read device details",
    { json: true, timeoutMs: (timeoutSeconds + 5) * 1000 }
  );
  const payload = json as DevicectlDetailsPayload | null;
  const conn =
    payload?.result?.connectionProperties ?? payload?.result?.device?.connectionProperties;
  return {
    transportType: conn?.transportType ?? null,
    tunnelState: conn?.tunnelState ?? null,
  };
}

const READY_MEMO_TTL_MS = 5_000;
const readyMemo = new Map<string, number>();

/**
 * Ensure the device is cabled and its CoreDevice tunnel is not mid-handshake.
 * The cable check is not redundant with the tunnel one: an unplugged paired
 * device keeps a connected tunnel over localNetwork (live-verified), yet
 * argent drives it over usbmux, which needs the cable. Without this gate the
 * failure surfaces minutes later, after a full runner build. transportType is
 * absent on older toolchains, so only an explicit non-wired value rejects.
 * Memoized for 5s per device: callers sprinkle this before commands, and a
 * fresh probe per call would dominate hot-path latency.
 */
export async function ensureDeviceReady(udid: string): Promise<void> {
  const at = readyMemo.get(udid);
  if (at != null && Date.now() - at < READY_MEMO_TTL_MS) return;
  const info = await deviceInfoDetails(udid, { timeoutSeconds: 15 });
  if (info.transportType != null && info.transportType !== "wired") {
    throw new IosDeviceControlError(`Device transport is ${info.transportType}, not wired`, {
      hint: "Connect the device by USB cable and unlock it, then retry.",
    });
  }
  if (info.tunnelState === "connecting") {
    throw new IosDeviceControlError("Device tunnel is still connecting", {
      hint: "Keep the device unlocked and connected; retry in a few seconds.",
    });
  }
  readyMemo.set(udid, Date.now());
}
