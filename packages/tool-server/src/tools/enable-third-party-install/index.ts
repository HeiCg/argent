import { z } from "zod";
import { FAILURE_CODES, FailureError, type ToolCapability, type ToolDefinition } from "@argent/registry";
import { adbShell, shellQuote } from "../../utils/adb";
import { assertSupported } from "../../utils/capability";
import { resolveDevice } from "../../utils/device-info";

// Mirrors reinstall-app / settings-permissions: the leading-letter rule stops a
// package name like `--user` masquerading as a flag. shellQuote is the real
// injection guard; this is defense in depth.
const PACKAGE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target Android device id (serial) from `list-devices`."),
  packageName: z
    .string()
    .regex(PACKAGE_NAME_PATTERN, "packageName may only contain letters, digits, '.', '_' and '-'")
    .describe(
      "Package name of the installer app to authorize (e.g. com.android.chrome, com.example.myapp) — the app that will install other APKs."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  enabled: boolean;
  packageName: string;
}

// Android-only: REQUEST_INSTALL_PACKAGES is an Android app-op with no iOS
// equivalent. No `apple` block, so the capability gate rejects iOS devices.
const capability: ToolCapability = {
  android: { emulator: true, device: true, unknown: true },
};

// appops mutating subcommands are silent on success; any output is an error
// (usage text after a bad argument, a SecurityException, "No operation").
const APPOPS_ERROR = /Error:|Exception|No operation|Usage:|Unknown/i;

export const enableThirdPartyInstallTool: ToolDefinition<Params, Result> = {
  id: "enable-third-party-install",
  interaction: {
    startedMsg: ({ params }) => `Allowing ${params.packageName} to install packages`,
    completedMsg: ({ params }) => `Allowed ${params.packageName} to install packages`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to allow ${params.packageName} to install packages: ${failureSignal.error_code}`,
  },
  description: `Grant an Android app the REQUEST_INSTALL_PACKAGES app-op so it can install other APKs without the "install unknown apps" system prompt blocking automation.
Use when testing a sideloading or self-update flow, or an in-app installer, on an emulator or device — the app-op is normally toggled by hand in Settings, which a test can't tap through.
Sets the op via \`appops set <package> REQUEST_INSTALL_PACKAGES allow\`. The app must already be installed. Android only — iOS has no equivalent, and the capability gate rejects non-Android devices.
Returns { enabled: true, packageName }. Fails if the package is not installed or the app-op could not be set (e.g. a wedged or disconnected device). This authorizes the installer app; to install an APK yourself use \`reinstall-app\`.`,
  searchHint: "install unknown apps sideload third party appops request_install_packages apk installer",
  zodSchema,
  capability,
  requires: ["adb"],
  services: () => ({}),
  async execute(_services, params) {
    const { udid, packageName } = params;
    assertSupported("enable-third-party-install", capability, resolveDevice(udid));

    const pkg = shellQuote(packageName);

    // `appops set` silently no-ops on a package that isn't installed, so a
    // typo'd name would report a false success. `pm list packages <pkg>` prints
    // a `package:<name>` line only when installed; a throw here is a
    // transport/timeout failure that must propagate, not a "not installed"
    // verdict.
    const listing = await adbShell(udid, `pm list packages ${pkg}`, { timeoutMs: 15_000 });
    const installed = listing.split("\n").some((line) => line.trim() === `package:${packageName}`);
    if (!installed) {
      throw new FailureError(
        `Package ${packageName} is not installed on ${udid} — install the app before enabling third-party install.`,
        {
          error_code: FAILURE_CODES.ANDROID_ENABLE_THIRD_PARTY_INSTALL_FAILED,
          failure_stage: "android_enable_third_party_install_package_missing",
          failure_area: "tool_server",
          error_kind: "not_found",
        }
      );
    }

    const out = await adbShell(
      udid,
      `appops set ${pkg} REQUEST_INSTALL_PACKAGES allow`,
      { timeoutMs: 15_000 }
    );
    const trimmed = out.trim();
    if (trimmed && APPOPS_ERROR.test(trimmed)) {
      throw new FailureError(`appops set failed: ${trimmed}`, {
        error_code: FAILURE_CODES.ANDROID_ENABLE_THIRD_PARTY_INSTALL_FAILED,
        failure_stage: "android_enable_third_party_install_appops",
        failure_area: "tool_server",
        error_kind: "subprocess",
      });
    }
    return { enabled: true, packageName };
  },
};
