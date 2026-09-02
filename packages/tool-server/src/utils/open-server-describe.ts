import type { DeviceInfo, Registry } from "@argent/registry";
import { openDeviceServerRef, type OpenDeviceServerApi } from "../blueprints/android-open-server";
import { openDeviceServerMutex } from "./device-mutex";
import { openServerNestedToDescribeNode } from "../tools/describe/platforms/android/open-server-tree";
import type { DescribeTreeData } from "../tools/describe/contract";

/**
 * Describe-tree fetch for the wait poll loops (`await-screen-idle`,
 * `await-ui-element`) via the open server's `getNestedState`: waitForIdle + the
 * FULL nested multi-window tree + info in ONE round-trip, screenshot skipped. The
 * describe tool's own open path spends two round-trips on the serialized client
 * socket (`getAccessibilityTree` then `getInfo`); a poll loop pays that on every
 * tick, so folding them into one `getState` call is the latency win T8 asks for.
 *
 * Tree unification (F12). The reply is the SAME nested tree the describe tool's
 * open path fetches, lowered through the SAME `openServerNestedToDescribeNode`
 * (the v2 interactables-only trim), so the wait tools and describe render an
 * identical label set and identical id forms — no longer the flat, differently
 * compressed list this used to produce. `getState` runs its own `waitForIdle`
 * server-side before serializing, so no separate pre-read `waitForIdle` is needed.
 *
 * Throws on any failure; callers fall back to `describeAndroid`, which walks the
 * open → android-devtools → uiautomator-dump chain itself.
 */
export function describeAndroidViaOpenState(
  registry: Registry,
  device: DeviceInfo
): Promise<DescribeTreeData> {
  const ref = openDeviceServerRef(device);
  // Serialize against describe / input on the same device, exactly as the
  // describe and gesture open paths do.
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    const state = await server.getNestedState();
    const tree = openServerNestedToDescribeNode(
      state.tree,
      state.info.screenWidth,
      state.info.screenHeight
    );
    return { tree, source: "open-device-server" };
  });
}
