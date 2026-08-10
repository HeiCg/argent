import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { harmonyConnectKey } from "../../../utils/device-info";
import { launchHarmonyApp, terminateHarmonyApp } from "../../../utils/harmony-apps";
import type { RestartAppParams, RestartAppResult, RestartAppHarmonyServices } from "../types";

/**
 * Restart on HarmonyOS is `aa force-stop` then a resolved `aa start`.
 *
 * The stop is tolerated rather than required: force-stopping an app that is not
 * running is not an error worth failing a restart over, and the launch that
 * follows is what the caller actually asked for. `activity` is Android-only and
 * ignored — the HarmonyOS entry ability is resolved from the bundle.
 */
export const harmonyImpl: PlatformImpl<
  RestartAppHarmonyServices,
  RestartAppParams,
  RestartAppResult
> = {
  requires: ["hdc"],
  handler: async (_services, params, device) => {
    const connectKey = harmonyConnectKey(device.id);
    await terminateHarmonyApp(connectKey, params.bundleId).catch(() => {});
    await launchHarmonyApp(connectKey, params.bundleId);
    return { restarted: true, bundleId: params.bundleId };
  },
};
