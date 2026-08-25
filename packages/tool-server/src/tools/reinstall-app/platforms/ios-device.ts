import { resolve as resolvePath } from "node:path";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import {
  clearCurrentIosDeviceApp,
  isSessionOnlySystemUi,
} from "../../../utils/ios-device/app-session";
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
    // Pre-flight before any device contact: system UI is not an installed
    // bundle, so an uninstall attempt could only fail (or worse).
    if (isSessionOnlySystemUi(params.bundleId)) {
      throw new InvalidToolInputError(
        `${params.bundleId} is system UI: it is always running and cannot be reinstalled. ` +
          "Use launch-app to put it under automation."
      );
    }
    await ensureDeviceReady(params.udid);
    await uninstallApp(params.udid, params.bundleId);
    // Uninstall killed the process; the session is stale from here even if
    // the install below fails.
    clearCurrentIosDeviceApp(params.udid, params.bundleId);
    await installApp(params.udid, resolvePath(params.appPath));
    return { reinstalled: true, bundleId: params.bundleId };
  },
};
