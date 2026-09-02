import type { DeviceInfo, Registry } from "@argent/registry";
import { openDeviceServerRef, type OpenDeviceServerApi } from "../blueprints/android-open-server";
import { openDeviceServerMutex } from "./device-mutex";
import { openServerElementsToDescribeNode } from "../tools/describe/platforms/android/open-server-tree";
import type { DescribeTreeData } from "../tools/describe/contract";

/**
 * Describe-tree fetch for the wait poll loops (`await-screen-idle`,
 * `await-ui-element`) via the open server's `getState`: waitForIdle + tree +
 * info in ONE round-trip, with the screenshot skipped. The describe tool's own
 * open path spends two round-trips on the serialized client socket
 * (`getAccessibilityTree` then `getInfo`); a poll loop pays that on every tick,
 * so folding them into `getState` is the latency win T8 asks for.
 *
 * The reply is lowered through the same `openServerElementsToDescribeNode`
 * adapter and carries the same `source`, so the produced `DescribeTreeData` is
 * identical to the describe tool's open path (the wait tools read only
 * `data.tree`). `getState` runs its own `waitForIdle` server-side before
 * serializing — the same settle the describe path already relies on — so no
 * separate pre-read `waitForIdle` RPC is needed.
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
    const state = await server.getState();
    const tree = openServerElementsToDescribeNode(
      state.tree,
      state.info.screenWidth,
      state.info.screenHeight
    );
    return { tree, source: "open-device-server" };
  });
}
