import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import type { UninstallAppResult, UninstallAppServices } from "./types";
import { iosImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";
import { iosRemoteImpl } from "./platforms/ios-remote";
import { vegaImpl } from "./platforms/vega";

// Mirrors reinstall-app: the restricted head keeps a value like `--user` from
// masquerading as a flag. Every branch execs via an argv array (no shell), so
// this is a consistency guard, not an injection fix.
const BUNDLE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  bundleId: z
    .string()
    .regex(BUNDLE_ID_PATTERN, "bundleId may only contain letters, digits, '.', '_' and '-'")
    .describe(
      "App to remove. iOS: bundle id (e.g. com.example.app). Android: package name. Vega: interactive component app id (e.g. com.example.app.main)."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  // simctl uninstall targets the simulator's app container; a physical iPhone
  // has no equivalent host-side removal.
  apple: { simulator: true },
  // sim-remote exposes the same `simctl uninstall` verb.
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  vega: { vvd: true },
};

export const uninstallAppTool: ToolDefinition<Params, UninstallAppResult> = {
  id: "uninstall-app",
  interaction: {
    startedMsg: ({ params }) => `Uninstalling ${params.bundleId}`,
    completedMsg: ({ params, result }) =>
      result.uninstalled ? `Uninstalled ${params.bundleId}` : `${params.bundleId} was not installed`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to uninstall ${params.bundleId}: ${failureSignal.error_code}`,
  },
  description: `Uninstall an app from the device, removing its app data and runtime permissions.
Use during test teardown to remove an app the test installed, or to get a device back to a clean state without a full reinstall.
Android: \`adb uninstall\`. iOS simulator: \`simctl uninstall\` (local or remote). Vega: \`uninstall-app\`.
Returns { uninstalled, bundleId }: \`uninstalled\` is true when the app was removed, false when it was already absent (a no-op, not an error) so teardown is idempotent. Fails if the removal command itself errors — a wedged or disconnected device, or a package manager that rejects the request. To install or replace an app instead, use \`reinstall-app\`.`,
  searchHint: "uninstall remove delete app package apk teardown clean bundle",
  zodSchema,
  capability,
  services: () => ({}),
  execute: dispatchByPlatform<
    UninstallAppServices,
    UninstallAppServices,
    Params,
    UninstallAppResult,
    // No chromium branch; placeholder so the vega/ios-remote slots line up.
    Record<string, unknown>,
    UninstallAppServices,
    UninstallAppServices
  >({
    toolId: "uninstall-app",
    capability,
    ios: iosImpl,
    android: androidImpl,
    iosRemote: iosRemoteImpl,
    vega: vegaImpl,
  }),
};
