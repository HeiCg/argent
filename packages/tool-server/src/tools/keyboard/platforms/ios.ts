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
  iosOpenServerFallback,
} from "../../../utils/ios-open-server-input";
import {
  shouldUseIosSimInput,
  isSimInputText,
  iosSimInputTypeText,
  simInputResultFields,
  simInputFallbackReason,
  simInputMayHaveTyped,
  chainFallbackReason,
} from "../../../blueprints/ios-sim-input";

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
      // Behind the flag: printable-ASCII text goes to sim-input first; then
      // the open iOS server (named keys, other text, or a sim-input failure);
      // then the simulator-server. Each fallback is marked on the result.
      if (shouldUseIosOpenServer(device)) {
        let simInputReason: string | undefined;
        let partialTextPossible = false;
        // Text resolved from a `{{secret:...}}` placeholder never goes to
        // sim-input: it stays on the runner, which has no per-key process log.
        if (
          params.text !== undefined &&
          params.containsSecret !== true &&
          isSimInputText(params.text) &&
          shouldUseIosSimInput(device)
        ) {
          try {
            const ack = await iosSimInputTypeText(registry, device, params.text);
            return {
              typed: params.text,
              keys: 0,
              inputBackend: "sim-input",
              simInput: simInputResultFields(ack),
            };
          } catch (err) {
            // A failure after the command reached sim-input (a timeout kills the
            // process, an ack error) can follow some typed characters; the next
            // backend types the whole text again. The result says so.
            simInputReason = simInputFallbackReason("keyboard", err);
            partialTextPossible = simInputMayHaveTyped(err);
          }
        }
        const partial = partialTextPossible ? { partialTextPossible: true as const } : {};
        try {
          return {
            ...(await typeIosOpenServer(registry, device, params)),
            inputBackend: "runner",
            ...(simInputReason !== undefined ? { fallbackReason: simInputReason } : {}),
            ...partial,
          };
        } catch (err) {
          const marker = iosOpenServerFallback("keyboard", err, "simulator-server");
          return {
            ...(await typeSimulatorServer(registry, device, params)),
            ...marker,
            fallbackReason: chainFallbackReason(simInputReason, marker.fallbackReason),
            inputBackend: "simulator-server",
            ...partial,
          };
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
