import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import { ensureDeviceReady, launchApp } from "../../../utils/ios-device/devicectl";
import {
  isSessionOnlySystemUi,
  setCurrentIosDeviceApp,
} from "../../../utils/ios-device/app-session";
import type { RestartAppParams, RestartAppResult } from "../types";

/**
 * Physical-iOS restart: devicectl's `--terminate-existing` makes this a single
 * launch call; no separate terminate + pid-join round trip needed.
 */
export const iosDeviceImpl: PlatformImpl<
  Record<string, unknown>,
  RestartAppParams,
  RestartAppResult
> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    // Pre-flight before any device contact: launching system UI with
    // --terminate-existing fails with a raw CoreDevice error whose generic
    // hint gives misleading locked-screen advice.
    if (isSessionOnlySystemUi(params.bundleId)) {
      throw new InvalidToolInputError(
        `${params.bundleId} is system UI: it is always running and cannot be restarted. ` +
          "Use launch-app to put it under automation."
      );
    }
    await ensureDeviceReady(params.udid);
    await launchApp(params.udid, params.bundleId, { terminateExisting: true });
    setCurrentIosDeviceApp(params.udid, params.bundleId);
    return { restarted: true, bundleId: params.bundleId };
  },
};
