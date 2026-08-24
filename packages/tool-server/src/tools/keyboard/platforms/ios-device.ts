import type { Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../../blueprints/ios-device-runner";
import { requireCurrentIosDeviceApp } from "../../../utils/ios-device/app-session";
import { pressKeyboardReturn, typeText } from "../../../utils/ios-device/runner-commands";
import type { KeyboardParams, KeyboardResult } from "../types";

/**
 * Physical-iOS typing: the XCUITest runner types into the currently-focused
 * element (tap a field first with gesture-tap). Only `enter` is available as a
 * named key — XCTest exposes no per-keycode HID surface on hardware, unlike
 * the simulator-server's stdin HID channel.
 */
export function makeIosDeviceImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    requires: ["xcrun"],
    handler: async (_services, params, device) => {
      const key = params.key?.trim().toLowerCase();
      if (key && key !== "enter") {
        throw new InvalidToolInputError(
          `Named key '${params.key}' is not supported on physical iOS devices — only 'enter'. ` +
            "Type text into the focused field, or use gesture-tap to press on-screen keys."
        );
      }
      // The empty request is the tool's documented no-op (see ../index.ts).
      // Return before requiring a tracked app or resolving the runner, so it
      // touches no device — matching the simulator and Android branches.
      if (!params.text && !key) return { typed: "", keys: 0 };
      const bundleId = requireCurrentIosDeviceApp(device.id);
      const ref = iosDeviceRunnerRef(device);
      const api = await registry.resolveService<IosDeviceRunnerApi>(ref.urn, ref.options);

      // Secret placeholders are already resolved by the tool's execute wrapper
      // (and the placeholder form restored in its reply) — type text verbatim.
      let keys = 0;
      if (params.text) {
        await typeText(api, bundleId, params.text);
        keys += params.text.length;
      }
      if (key === "enter") {
        await pressKeyboardReturn(api, bundleId);
        keys += 1;
      }
      return { typed: params.text ?? params.key ?? "", keys };
    },
  };
}
