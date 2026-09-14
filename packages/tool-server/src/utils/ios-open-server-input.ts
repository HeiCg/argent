import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { isFlagEnabled } from "@argent/configuration-core";
import type { DeviceInfo, Registry } from "@argent/registry";
import { iosOpenServerRef, type IosOpenDeviceServerApi } from "../blueprints/ios-open-server";
import { openDeviceServerMutex } from "./device-mutex";
import { openServerIosNestedToDescribeNode } from "../tools/describe/platforms/ios/open-server-tree";
import type { DescribeTreeData } from "../tools/describe/contract";

/**
 * Open iOS server host backend: routes iOS describe / screenshot / gesture / text
 * through `@argent/ios-device-server` when the `open-ios-device-server` flag is
 * on. Coordinates arrive normalized 0–1 and convert to SCREEN POINTS against the
 * runner's `getScreenSize`. Every entry throws on any failure (flag off, runner
 * unreachable, RPC error); callers catch and fall back to the proprietary path,
 * so the open backend is strictly additive.
 */

/** Whether the open iOS backend applies to this device. */
export function shouldUseIosOpenServer(device: DeviceInfo): boolean {
  return device.platform === "ios" && isFlagEnabled("open-ios-device-server");
}

function withServer<T>(
  registry: Registry,
  device: DeviceInfo,
  fn: (api: IosOpenDeviceServerApi, size: { width: number; height: number }) => Promise<T>
): Promise<T> {
  const ref = iosOpenServerRef(device);
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<IosOpenDeviceServerApi>(ref.urn, ref.options);
    const s = await server.getScreenSize();
    return fn(server, { width: s.screenWidth, height: s.screenHeight });
  });
}

function toPoints(size: { width: number; height: number }, xNorm: number, yNorm: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(1, xNorm)) * size.width,
    y: Math.max(0, Math.min(1, yNorm)) * size.height,
  };
}

/** Tap at normalized coordinates via the open iOS server. */
export function iosOpenServerTap(
  registry: Registry,
  device: DeviceInfo,
  xNorm: number,
  yNorm: number,
  clickCount: number
): Promise<void> {
  return withServer(registry, device, async (server, size) => {
    const { x, y } = toPoints(size, xNorm, yNorm);
    const res = await server.tap(x, y, clickCount > 1 ? { clickCount } : {});
    if (res.success === false) {
      throw new Error("open ios-device-server tap failed");
    }
  });
}

/** Long-press at normalized coordinates. */
export function iosOpenServerLongPress(
  registry: Registry,
  device: DeviceInfo,
  xNorm: number,
  yNorm: number,
  durationMs?: number
): Promise<void> {
  return withServer(registry, device, async (server, size) => {
    const { x, y } = toPoints(size, xNorm, yNorm);
    await server.longPress(x, y, durationMs !== undefined ? { durationMs } : {});
  });
}

/** Swipe between two normalized points; `holdEndMs > 0` suppresses the fling. */
export function iosOpenServerSwipe(
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
    const from = toPoints(size, fromXNorm, fromYNorm);
    const to = toPoints(size, toXNorm, toYNorm);
    await server.swipe(from.x, from.y, to.x, to.y, {
      steps,
      ...(holdEndMs && holdEndMs > 0 ? { holdEndMs } : {}),
    });
  });
}

/** Type text into the focused input via the open iOS server. */
export function iosOpenServerTypeText(registry: Registry, device: DeviceInfo, text: string): Promise<void> {
  const ref = iosOpenServerRef(device);
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<IosOpenDeviceServerApi>(ref.urn, ref.options);
    await server.typeText(text);
  });
}

/** Press a named key (return/delete/escape) or hardware button. */
export function iosOpenServerKey(registry: Registry, device: DeviceInfo, key: string): Promise<void> {
  const ref = iosOpenServerRef(device);
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<IosOpenDeviceServerApi>(ref.urn, ref.options);
    await server.key(key);
  });
}

/**
 * Capture a screenshot via the open iOS server, written to a temp PNG. Throws on
 * any failure; the caller falls back to `xcrun simctl io screenshot` or the
 * proprietary path.
 */
export function captureIosScreenshotViaOpenServer(
  registry: Registry,
  device: DeviceInfo,
  scale?: number
): Promise<{ path: string; width: number; height: number }> {
  const ref = iosOpenServerRef(device);
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<IosOpenDeviceServerApi>(ref.urn, ref.options);
    const shot = await server.screenshot({ format: "png", ...(scale !== undefined ? { scale } : {}) });
    const bytes = Buffer.from(shot.data, "base64");
    const file = path.join(
      os.tmpdir(),
      `argent-ios-open-screenshot-${device.id.slice(0, 12)}-${crypto.randomBytes(6).toString("hex")}.png`
    );
    await fs.writeFile(file, bytes);
    return { path: file, width: shot.width, height: shot.height };
  });
}

/**
 * Describe the current iOS screen via the open server's `getNestedState`,
 * lowered through the same `openServerIosNestedToDescribeNode` adapter the
 * describe tool uses. Throws on any failure; the caller falls back to the
 * ax-service / native-devtools describe chain.
 */
export function describeIosViaOpenServer(registry: Registry, device: DeviceInfo): Promise<DescribeTreeData> {
  const ref = iosOpenServerRef(device);
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<IosOpenDeviceServerApi>(ref.urn, ref.options);
    const state = await server.getNestedState({});
    const tree = openServerIosNestedToDescribeNode(state.tree, state.info.screenWidth, state.info.screenHeight);
    return { tree, source: "xcuitest-runner" };
  });
}
