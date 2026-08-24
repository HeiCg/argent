import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { ensureDeviceReady, launchApp } from "../../../utils/ios-device/devicectl";
import { setCurrentIosDeviceApp } from "../../../utils/ios-device/app-session";
import type { LaunchAppParams, LaunchAppResult } from "../types";

/**
 * System-UI processes that are not devicectl-launchable (and never need
 * launching — they are always running). Accepting them as launch targets just
 * registers the automation session, which lets describe/gestures drive their
 * UI through the runner's XCUIApplication attach: SpringBoard owns the home
 * screen, App Library, and many system alerts; Spotlight owns the pull-down
 * search overlay (a separate process, invisible to a SpringBoard-scoped
 * snapshot). The runner's foreground gate even gives `activate()` a useful
 * meaning here: activating SpringBoard dismisses the foreground app to the
 * home screen.
 */
const SESSION_ONLY_BUNDLE_IDS = new Set(["com.apple.springboard", "com.apple.Spotlight"]);

/**
 * Physical-iOS launch: `xcrun devicectl device process launch`. No
 * native-devtools env warm-up here — DYLD injection does not exist on
 * hardware, so the launch is a plain CoreDevice process start.
 */
export const iosDeviceImpl: PlatformImpl<
  Record<string, unknown>,
  LaunchAppParams,
  LaunchAppResult
> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    await ensureDeviceReady(params.udid);
    if (!SESSION_ONLY_BUNDLE_IDS.has(params.bundleId)) {
      await launchApp(params.udid, params.bundleId);
    }
    setCurrentIosDeviceApp(params.udid, params.bundleId);
    return { launched: true, bundleId: params.bundleId };
  },
};
