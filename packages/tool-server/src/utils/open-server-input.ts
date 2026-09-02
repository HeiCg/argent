import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { isFlagEnabled } from "@argent/configuration-core";
import type { DeviceInfo, Registry } from "@argent/registry";
import {
  openDeviceServerRef,
  type GesturePointerPath,
  type OpenDeviceServerApi,
} from "../blueprints/android-open-server";
import { openDeviceServerMutex } from "./device-mutex";

/**
 * Open-source input backend: routes touch gestures through
 * `@argent/android-device-server` instead of the proprietary simulator-server,
 * when the `open-device-server` flag is on. This is argent's first fully
 * open-source Android control path.
 *
 * Every entry point here throws on any failure (flag off, server unreachable,
 * RPC error). Callers catch and fall back to the existing simulator-server path,
 * so the open backend is strictly additive.
 */

/** Whether the open-device-server input backend applies to this device. */
export function shouldUseOpenServer(device: DeviceInfo): boolean {
  return device.platform === "android" && isFlagEnabled("open-device-server");
}

async function withServer<T>(
  registry: Registry,
  device: DeviceInfo,
  fn: (api: OpenDeviceServerApi, size: { width: number; height: number }) => Promise<T>
): Promise<T> {
  const ref = openDeviceServerRef(device);
  // Serialize against describe / other input on the same device.
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    const info = await server.getInfo();
    return fn(server, { width: info.screenWidth, height: info.screenHeight });
  });
}

function toPixels(
  size: { width: number; height: number },
  xNorm: number,
  yNorm: number
): { x: number; y: number } {
  return {
    x: Math.round(Math.max(0, Math.min(1, xNorm)) * size.width),
    y: Math.round(Math.max(0, Math.min(1, yNorm)) * size.height),
  };
}

/** Tap `clickCount` times at normalized coordinates via the open server. */
export function openServerTap(
  registry: Registry,
  device: DeviceInfo,
  xNorm: number,
  yNorm: number,
  clickCount: number
): Promise<void> {
  return withServer(registry, device, async (server, size) => {
    const { x, y } = toPixels(size, xNorm, yNorm);
    for (let i = 0; i < clickCount; i++) {
      await server.tap(x, y);
    }
  });
}

/**
 * Swipe between two normalized points via the open server. The server runs its
 * own UiAutomator interpolation (`steps`), so this is one RPC rather than the
 * per-frame Move loop the simulator-server path drives host-side.
 *
 * `holdEndMs > 0` asks the server to hold the last pointer position that long
 * before the lift, so the release velocity decays to ~0 (a momentum-free swipe);
 * omit it for a plain flinging swipe.
 */
export function openServerSwipe(
  registry: Registry,
  device: DeviceInfo,
  fromXNorm: number,
  fromYNorm: number,
  toXNorm: number,
  toYNorm: number,
  steps: number,
  holdEndMs?: number
): Promise<void> {
  return withServer(registry, device, async (server, size) => {
    const from = toPixels(size, fromXNorm, fromYNorm);
    const to = toPixels(size, toXNorm, toYNorm);
    await server.swipe(from.x, from.y, to.x, to.y, steps, holdEndMs);
  });
}

/**
 * Type text via the open server's `typeText` RPC. Backs the Android `paste`
 * tool's open path: phase 2 accepts typing the text over injecting the device
 * clipboard + KEYCODE_PASTE (same observable end — the text lands in the focused
 * field). Throws on any failure; the caller falls back to the clipboard path.
 */
export function openServerTypeText(
  registry: Registry,
  device: DeviceInfo,
  text: string
): Promise<void> {
  const ref = openDeviceServerRef(device);
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    await server.typeText(text);
  });
}

/** One pointer's path in normalized 0–1 coordinates for [openServerGesture]. */
export interface NormalizedPointerPath {
  id?: number;
  points: Array<{ x: number; y: number; tMs: number }>;
}

/**
 * Multi-pointer gesture via the open server: converts each pointer's normalized
 * path to device pixels against the live screen size and injects it in one RPC.
 * Backs the pinch / rotate / custom tools, which `swipe` (a single straight
 * line) cannot express.
 */
export function openServerGesture(
  registry: Registry,
  device: DeviceInfo,
  pointers: NormalizedPointerPath[]
): Promise<void> {
  return withServer(registry, device, async (server, size) => {
    const pixelPointers: GesturePointerPath[] = pointers.map((p) => ({
      ...(p.id !== undefined ? { id: p.id } : {}),
      points: p.points.map((pt) => {
        const { x, y } = toPixels(size, pt.x, pt.y);
        return { x, y, tMs: pt.tMs };
      }),
    }));
    await server.gesture(pixelPointers);
  });
}

/**
 * Capture a screenshot via the open server, written to a temp PNG on the host.
 * Shared by the `screenshot` and `screenshot-diff` tools so neither duplicates
 * the branch. Requests PNG so the callers keep their image/png output contract.
 * Throws on any failure (flag off is the caller's own gate); callers fall back
 * to the simulator-server capture.
 */
export function captureAndroidScreenshot(
  registry: Registry,
  device: DeviceInfo,
  scale?: number
): Promise<{ path: string; width: number; height: number }> {
  const ref = openDeviceServerRef(device);
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    const shot = await server.screenshot({
      format: "png",
      ...(scale !== undefined ? { scale } : {}),
    });
    const bytes = Buffer.from(shot.data, "base64");
    const file = path.join(
      os.tmpdir(),
      `argent-open-screenshot-${device.id.slice(0, 12)}-${crypto.randomBytes(6).toString("hex")}.png`
    );
    await fs.writeFile(file, bytes);
    return { path: file, width: shot.width, height: shot.height };
  });
}
