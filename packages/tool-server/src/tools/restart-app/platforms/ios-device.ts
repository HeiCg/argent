import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { ensureDeviceReady, launchApp } from "../../../utils/ios-device/devicectl";
import { setCurrentIosDeviceApp } from "../../../utils/ios-device/app-session";
import type { RestartAppParams, RestartAppResult } from "../types";

/**
 * Physical-iOS restart: devicectl's `--terminate-existing` makes this a single
 * launch call — no separate terminate + pid-join round trip needed.
 */
export const iosDeviceImpl: PlatformImpl<
  Record<string, unknown>,
  RestartAppParams,
  RestartAppResult
> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    await ensureDeviceReady(params.udid);
    await launchApp(params.udid, params.bundleId, { terminateExisting: true });
    setCurrentIosDeviceApp(params.udid, params.bundleId);
    return { restarted: true, bundleId: params.bundleId };
  },
};
