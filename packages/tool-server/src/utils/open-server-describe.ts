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
  return readAndroidOpenState(registry, device).then((r) => r.data);
}

/**
 * As [describeAndroidViaOpenState], but also returns the AX version clock at
 * capture. `await-ui-element`'s open path (Phase A.1) needs the version to arm
 * `awaitChange({ fromVersion })` after an immediate trusted read, so it blocks
 * on the device's AX clock instead of host-polling describe.
 *
 * Phase 3m.1 (3M-H5): pass `fingerprints: true` on that FIRST read. Since 3m the
 * device AX event listener is armed lazily (on the first fingerprints /
 * awaitChange / outcome request), so a plain `getNestedState` leaves the clock
 * unarmed and `version` absent; an event landing between this read and the first
 * `awaitChange` (which arms the clock itself) would then be invisible and the
 * wait would block to the full timeout. Requesting fingerprints here registers
 * the listener and returns a live `version`, exactly like
 * `awaitScreenIdleViaOpenServer`. The re-read helpers keep the fingerprint-free
 * default so the plain describe latency path never arms the listener (C2). On a
 * pre-0.2.0 server `version` is 0 and the caller just waits for the next event —
 * still correct.
 */
export function readAndroidOpenState(
  registry: Registry,
  device: DeviceInfo,
  opts: { fingerprints?: boolean } = {}
): Promise<{ data: DescribeTreeData; version: number }> {
  const ref = openDeviceServerRef(device);
  // Serialize against describe / input on the same device, exactly as the
  // describe and gesture open paths do.
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    const state = await server.getNestedState(opts.fingerprints ? { fingerprints: true } : {});
    const tree = openServerNestedToDescribeNode(
      state.tree,
      state.info.screenWidth,
      state.info.screenHeight
    );
    return { data: { tree, source: "open-device-server" }, version: state.version ?? 0 };
  });
}
