import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { ensureDeviceReady, launchApp } from "../../../utils/ios-device/devicectl";
import { setCurrentIosDeviceApp } from "../../../utils/ios-device/app-session";
import type { LaunchAppParams, LaunchAppResult } from "../types";

/**
 * Physical-iOS launch: `xcrun devicectl device process launch`. No
 * native-devtools env warm-up here — DYLD injection does not exist on
 * hardware, so the launch is a plain CoreDevice process start.
 */
export const iosDeviceImpl: PlatformImpl<Record<string, unknown>, LaunchAppParams, LaunchAppResult> =
  {
    requires: ["xcrun"],
    handler: async (_services, params) => {
      await ensureDeviceReady(params.udid);
      await launchApp(params.udid, params.bundleId);
      setCurrentIosDeviceApp(params.udid, params.bundleId);
      return { launched: true, bundleId: params.bundleId };
    },
  };
