import type { DeviceInfo, Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { isTvOsSimulator } from "../../../utils/ios-devices";
import { isRemoteTvOsSimulator } from "../../../utils/sim-remote";
import type { KeyboardParams, KeyboardResult } from "../types";
import { clearSimulatorServer, typeSimulatorServer } from "../simulator-server-keys";
import { typeTv } from "./tv";

// `text`, `key` and `clear` are at-most-one (rejected in ../index.ts), so the
// branch here is a routing choice, not an ordering one. Shared by the simulator
// and ios-remote impls: both drive the same `pressKey` transport (MoQ for the
// remote one), so a clear that only reached one of them would be a silent
// platform gap.
function runSimulatorServer(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams,
  signal?: AbortSignal
): Promise<KeyboardResult> {
  return params.clear === true
    ? clearSimulatorServer(registry, device, signal)
    : typeSimulatorServer(registry, device, params);
}

// A tvOS sim is `platform: "ios"` by UDID shape; the TV/mobile split lives in
// `runtimeKind`, which only an async runtime probe can resolve.
export function makeIosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device, options) =>
      (await isTvOsSimulator(device.id))
        ? typeTv(registry, device, params)
        : runSimulatorServer(registry, device, params, options?.signal),
  };
}

// A remote tvOS sim is `platform: "ios-remote"` by UDID shape too, exactly as a
// local one is `"ios"`, so without a probe here a remote Apple TV took the
// 400-event clear burst — the one thing `platforms/tv.ts` documents as
// unsupported on a TV — and a named key it also rejects.
//
// Narrower than `makeIosImpl`'s branch on purpose: only `key` and `clear` are
// routed to `typeTv`, which refuses both before resolving anything. `text`
// keeps the MoQ HID path it already had, rather than being moved onto the TV
// daemon's channel by a fix aimed at the burst. The probe therefore runs only
// for the two shapes that need it.
export function makeIosRemoteImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device, options) =>
      (params.key !== undefined || params.clear === true) &&
      (await isRemoteTvOsSimulator(device.id))
        ? typeTv(registry, device, params)
        : runSimulatorServer(registry, device, params, options?.signal),
  };
}
