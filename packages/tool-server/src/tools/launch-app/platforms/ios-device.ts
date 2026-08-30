import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { ensureDeviceReady, launchApp } from "../../../utils/ios-device/devicectl";
import {
  isSessionOnlySystemUi,
  setCurrentIosDeviceApp,
} from "../../../utils/ios-device/app-session";
import type { LaunchAppParams, LaunchAppResult } from "../types";

/**
 * Launch an app on a physical iOS device with devicectl.
 */
export const iosDeviceImpl: PlatformImpl<
  Record<string, unknown>,
  LaunchAppParams,
  LaunchAppResult
> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    await ensureDeviceReady(params.udid);
    // System UI is always running. Register the session only. Do not launch.
    if (!isSessionOnlySystemUi(params.bundleId)) {
      await launchApp(params.udid, params.bundleId);
    }
    setCurrentIosDeviceApp(params.udid, params.bundleId);
    return { launched: true, bundleId: params.bundleId };
  },
};
