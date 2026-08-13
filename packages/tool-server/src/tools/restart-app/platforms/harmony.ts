import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { harmonyConnectKey } from "../../../utils/device-info";
import {
  isHarmonyAppNotRunning,
  launchHarmonyApp,
  terminateHarmonyApp,
} from "../../../utils/harmony-apps";
import type { RestartAppParams, RestartAppResult, RestartAppHarmonyServices } from "../types";

/**
 * Restart on HarmonyOS is `aa force-stop` then a resolved `aa start`.
 *
 * The stop is tolerated only when the app was not running — a restart of an
 * app that was never launched is a start, and that is what the caller asked
 * for. Every other stop failure propagates: `restart-app` exists to guarantee
 * a fresh process, so a refused stop followed by a launch that no-ops on the
 * still-running app must not read as `restarted: true`. `activity` is
 * Android-only and ignored — the HarmonyOS entry ability is resolved from the
 * bundle.
 */
export const harmonyImpl: PlatformImpl<
  RestartAppHarmonyServices,
  RestartAppParams,
  RestartAppResult
> = {
  requires: ["hdc"],
  handler: async (_services, params, device) => {
    const connectKey = harmonyConnectKey(device.id);
    await terminateHarmonyApp(connectKey, params.bundleId).catch((err: unknown) => {
      if (isHarmonyAppNotRunning(err)) return;
      throw err;
    });
    await launchHarmonyApp(connectKey, params.bundleId);
    return { restarted: true, bundleId: params.bundleId };
  },
};
