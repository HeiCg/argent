import { resolve as resolvePath } from "node:path";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { ensureDeviceReady, installApp, uninstallApp } from "../../../utils/ios-device/devicectl";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

/**
 * Physical-iOS reinstall via devicectl. The .app must be a DEVICE build
 * (arm64, signed for this device's provisioning) — a simulator build fails at
 * install time with a CoreDevice error naming the platform mismatch.
 */
export const iosDeviceImpl: PlatformImpl<
  ReinstallAppServices,
  ReinstallAppParams,
  ReinstallAppResult
> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    await ensureDeviceReady(params.udid);
    await uninstallApp(params.udid, params.bundleId);
    await installApp(params.udid, resolvePath(params.appPath));
    return { reinstalled: true, bundleId: params.bundleId };
  },
};
