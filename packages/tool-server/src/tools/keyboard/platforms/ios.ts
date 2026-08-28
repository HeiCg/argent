import type { DeviceInfo, Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { isTvOsSimulator } from "../../../utils/ios-devices";
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
  params: KeyboardParams
): Promise<KeyboardResult> {
  return params.clear === true
    ? clearSimulatorServer(registry, device)
    : typeSimulatorServer(registry, device, params);
}

// A tvOS sim is `platform: "ios"` by UDID shape; the TV/mobile split lives in
// `runtimeKind`, which only an async runtime probe can resolve.
export function makeIosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device) =>
      (await isTvOsSimulator(device.id))
        ? typeTv(registry, device, params)
        : runSimulatorServer(registry, device, params),
  };
}

export function makeIosRemoteImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device) => runSimulatorServer(registry, device, params),
  };
}
