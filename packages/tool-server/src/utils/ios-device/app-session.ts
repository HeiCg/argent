/**
 * Tracks the app under automation per physical device.
 *
 * The XCUITest runner requires an explicit `appBundleId` on interaction and
 * snapshot commands and refuses them otherwise (APP_BUNDLE_ID_REQUIRED) — it
 * never redirects an app command to its own host app. Argent's gesture and
 * describe tools don't carry a bundle id in their params; instead, launch-app
 * / restart-app record the launched app here and the tool layer injects it
 * into every runner command.
 */
const currentAppByUdid = new Map<string, string>();

export function setCurrentIosDeviceApp(udid: string, bundleId: string): void {
  currentAppByUdid.set(udid, bundleId);
}

export function requireCurrentIosDeviceApp(udid: string): string {
  const bundleId = currentAppByUdid.get(udid);
  if (!bundleId) {
    throw new Error(
      "No app is under automation on this device. Launch the target app first with " +
        "launch-app (or restart-app) so interactions and describe have a target; " +
        "on physical iOS devices XCUITest interactions are app-scoped."
    );
  }
  return bundleId;
}
