import { FAILURE_CODES, withFailureSignal } from "@argent/registry";

/**
 * Tracks the app under automation per physical device.
 *
 * The XCUITest runner requires an explicit `appBundleId` on interaction and
 * snapshot commands and refuses them otherwise (APP_BUNDLE_ID_REQUIRED) — it
 * never redirects an app command to its own host app. Argent's gesture and
 * describe tools don't carry a bundle id in their params; instead, launch-app
 * / restart-app record the launched app here and the tool layer injects it
 * into every runner command.
 *
 * Lifecycle: an entry means this bundle was started (or attached, for system
 * UI) under automation and has not been knowingly killed by us. It
 * deliberately survives runner respawn and cable unplug — runner death does
 * not kill the app, and commands re-attach per call via `appBundleId`. It is
 * invalidated only when we kill the process, which today means reinstall.
 */
const currentAppByUdid = new Map<string, string>();

/**
 * System-UI processes that are not devicectl-launchable (and never need
 * launching — they are always running). launch-app accepts them as launch
 * targets and just registers the automation session, which lets
 * describe/gestures drive their UI through the runner's XCUIApplication
 * attach: SpringBoard owns the home screen, App Library, and many system
 * alerts; Spotlight owns the pull-down search overlay (a separate process,
 * invisible to a SpringBoard-scoped snapshot). The runner's foreground gate
 * even gives `activate()` a useful meaning here: activating SpringBoard
 * dismisses the foreground app to the home screen. restart-app and
 * reinstall-app reject these ids up front — there is no process to restart
 * and no bundle to reinstall.
 */
const SESSION_ONLY_SYSTEM_UI_BUNDLE_IDS = new Set(["com.apple.springboard", "com.apple.Spotlight"]);

/** Exact, case-sensitive bundle-id match (the ids above are the canonical spellings). */
export function isSessionOnlySystemUi(bundleId: string): boolean {
  return SESSION_ONLY_SYSTEM_UI_BUNDLE_IDS.has(bundleId);
}

export function setCurrentIosDeviceApp(udid: string, bundleId: string): void {
  currentAppByUdid.set(udid, bundleId);
}

/** Delete the entry when it matches `bundleId`, or unconditionally when omitted. */
export function clearCurrentIosDeviceApp(udid: string, bundleId?: string): void {
  if (bundleId === undefined || currentAppByUdid.get(udid) === bundleId) {
    currentAppByUdid.delete(udid);
  }
}

export function requireCurrentIosDeviceApp(udid: string): string {
  const bundleId = currentAppByUdid.get(udid);
  if (!bundleId) {
    // Signal shape mirrors native-target-app.ts's no-target analog; the code
    // follows the branch's precondition-rejection precedent (device-info.ts's
    // flag gate): the call is rejected up front with a do-this-then-retry
    // recovery, and the stage names this site for telemetry.
    throw withFailureSignal(
      new Error(
        "No app is under automation on this device. Launch the target app first with " +
          "launch-app (or restart-app) so interactions and describe have a target; " +
          "on physical iOS devices XCUITest interactions are app-scoped."
      ),
      {
        error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
        failure_stage: "ios_device_app_session",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  return bundleId;
}
