import type { DeviceInfo, DeviceKind, Platform } from "@argent/registry";

/**
 * iOS simulator UDID format: 8-4-4-4-12 hex with dashes. Chromium devices use the
 * `chromium-cdp-<port>` prefix and Vega devices the `amazon-` prefix, so both are
 * told apart from iOS UUIDs and Android adb serials by shape alone. A physical
 * iPhone has its own shape (see IOS_PHYSICAL_UDID_SHAPE below); anything that
 * matches none of these is treated as an Android serial. Classification is shape-based because
 * `xcrun simctl list` and `adb devices` are slow enough that listing on every hot
 * tool call would dominate its latency.
 */
const IOS_UDID_SHAPE =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * Physical iPhone/iPad UDID shape on A12-and-later hardware: an 8-hex ECID
 * prefix, a single dash, then 16 hex — e.g. `00008120-000E6D0C0ABBA01E`. This is
 * distinct from the simulator UUID (four dashes) so a real device can be told
 * apart from a simulator by shape alone, the same way Android emulators vs
 * phones are distinguished. Older 40-hex UDIDs belong to pre-A12 hardware, which
 * tops out well below the iOS 26 floor the CoreDevice accessibility read needs,
 * so they are intentionally not matched.
 */
const IOS_PHYSICAL_UDID_SHAPE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$/;

/**
 * Prefix used on device ids that route through `sim-remote` to a remote iOS
 * simulator. The raw UUID after the prefix is the same RFC-4122 shape as a
 * local iOS UDID — the prefix is the only thing that disambiguates a remote
 * sim from a local one.
 */
export const REMOTE_PREFIX = "remote:";

export function stripRemotePrefix(id: string): string {
  return id.startsWith(REMOTE_PREFIX) ? id.slice(REMOTE_PREFIX.length) : id;
}

export function withRemotePrefix(udid: string): string {
  return udid.startsWith(REMOTE_PREFIX) ? udid : `${REMOTE_PREFIX}${udid}`;
}

export const CHROMIUM_ID_PREFIX = "chromium-cdp-";

/** Whether a udid is a physical iOS device (vs a simulator UUID), by shape. */
export function isPhysicalIosUdid(udid: string): boolean {
  return IOS_PHYSICAL_UDID_SHAPE.test(udid);
}

/**
 * `vega device list` reports VVD / Fire-TV serials as `amazon-<id>` (e.g.
 * `amazon-4a27df03c9777152`). No known Android adb serial starts with it, but
 * `ro.serialno` is vendor-defined, so a colliding Android serial would be
 * misrouted to the Vega paths.
 */
export const VEGA_SERIAL_PREFIX = "amazon-";

export function classifyDevice(udid: string): Platform {
  if (udid.startsWith(REMOTE_PREFIX)) return "ios-remote";
  if (udid.startsWith(VEGA_SERIAL_PREFIX)) return "vega";
  if (udid.startsWith(CHROMIUM_ID_PREFIX)) return "chromium";
  if (IOS_UDID_SHAPE.test(udid) || IOS_PHYSICAL_UDID_SHAPE.test(udid)) return "ios";
  return "android";
}

/**
 * Local emulators always register with adb as `emulator-<port>`, so any other
 * Android serial — a USB hardware serial, or an `ip:port` from wireless
 * debugging — is a physical device.
 *
 * The distinction picks the simulator-server controller: emulators go through
 * the emulator gRPC bridge (`android` subcommand), physical devices through the
 * screen-sharing agent over adb (`android_device`).
 */
export function isAndroidEmulatorSerial(serial: string): boolean {
  return serial.startsWith("emulator-");
}

/**
 * Build a `DeviceInfo` from a raw udid, by shape. Kind defaults per platform:
 * 'simulator' for an iOS simulator or ios-remote ('device' for a physical
 * iPhone/iPad by UDID shape), 'vvd' for Vega, 'emulator'/'device' for Android
 * by serial shape, 'app' for Chromium — platform impls can enrich with
 * name/state/sdkLevel via simctl/adb/sim-remote if needed.
 *
 * Vega is VVD-only: the tool-server neither connects to nor detects physical
 * Fire TV hardware, so every `amazon-` serial resolves to kind `vvd` and never
 * hits the `device` rejection in the `vega: { vvd: true }` capability gate.
 */
export function resolveDevice(udid: string): DeviceInfo {
  const platform = classifyDevice(udid);
  const kind: DeviceKind =
    platform === "ios"
      ? isPhysicalIosUdid(udid)
        ? "device"
        : "simulator"
      : platform === "ios-remote"
        ? "simulator"
        : platform === "vega"
          ? "vvd"
          : platform === "android"
            ? isAndroidEmulatorSerial(udid)
              ? "emulator"
              : "device"
            : "app";
  return { id: udid, platform, kind };
}

/** A physical iOS device (driven over CoreDevice by the simulator-server's ios_device controller). */
export function isPhysicalIos(device: DeviceInfo): boolean {
  return device.platform === "ios" && device.kind === "device";
}

/** Parses the CDP port out of a chromium device id. Returns null if the id is malformed. */
export function parseChromiumCdpPort(udid: string): number | null {
  if (!udid.startsWith(CHROMIUM_ID_PREFIX)) return null;
  const tail = udid.slice(CHROMIUM_ID_PREFIX.length);
  if (!/^\d+$/.test(tail)) return null;
  const port = Number.parseInt(tail, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return port;
}

export function chromiumIdFromPort(port: number): string {
  return `${CHROMIUM_ID_PREFIX}${port}`;
}
