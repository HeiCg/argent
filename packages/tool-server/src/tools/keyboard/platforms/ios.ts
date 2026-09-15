import type { DeviceInfo, Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { isTvOsSimulator } from "../../../utils/ios-devices";
import type { KeyboardParams, KeyboardResult } from "../types";
import { typeSimulatorServer } from "../simulator-server-keys";
import { typeTv } from "./tv";
import {
  shouldUseIosOpenServer,
  iosOpenServerTypeText,
  iosOpenServerKey,
} from "../../../utils/ios-open-server-input";

// Named keys the open iOS server's `key` method supports; others fall back to
// the proprietary simulator-server path.
const OPEN_SERVER_KEY_MAP: Record<string, string> = {
  enter: "return",
  return: "return",
  escape: "escape",
  backspace: "delete",
  delete: "delete",
};

/**
 * Text / key entry via the open iOS XCUITest server. Throws (so the caller falls
 * back to the simulator-server path) when the key is one the runner does not
 * support (tab, space, arrows, …).
 */
async function typeIosOpenServer(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams
): Promise<KeyboardResult> {
  if (params.text !== undefined) {
    await iosOpenServerTypeText(registry, device, params.text);
    return { typed: params.text, keys: 0 };
  }
  if (params.key !== undefined) {
    const mapped = OPEN_SERVER_KEY_MAP[params.key.toLowerCase()];
    if (!mapped) {
      throw new Error(`open ios-device-server does not support key '${params.key}'`);
    }
    await iosOpenServerKey(registry, device, mapped);
    return { typed: "", keys: 1 };
  }
  throw new Error("keyboard requires text or key");
}

// A tvOS sim is `platform: "ios"` by UDID shape; the TV/mobile split lives in
// `runtimeKind`, which only an async runtime probe can resolve.
export function makeIosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device) => {
      if (await isTvOsSimulator(device.id)) {
        return typeTv(registry, device, params);
      }
      // Open iOS server behind the flag; falls back on any failure or an
      // unsupported key.
      if (shouldUseIosOpenServer(device)) {
        try {
          return await typeIosOpenServer(registry, device, params);
        } catch (err) {
          console.debug(
            `[keyboard] open ios-device-server failed, falling back to simulator-server: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
      return typeSimulatorServer(registry, device, params);
    },
  };
}

export function makeIosRemoteImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device) => typeSimulatorServer(registry, device, params),
  };
}
