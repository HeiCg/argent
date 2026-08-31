import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { runAdb } from "../../../utils/adb";
import type { UninstallAppParams, UninstallAppResult, UninstallAppServices } from "../types";

// A missing package is a teardown no-op, not a failure. `adb uninstall` signals
// it two ways depending on the platform-tools version: an exit-0 `Failure […]`
// line in stdout, or a non-zero exit (so runAdb throws) carrying the same text.
// Both are matched here.
const NOT_INSTALLED = /not installed for|DELETE_FAILED_INTERNAL_ERROR|Unknown package/i;

export const androidImpl: PlatformImpl<
  UninstallAppServices,
  UninstallAppParams,
  UninstallAppResult
> = {
  requires: ["adb"],
  handler: async (_services, params) => {
    const { udid, bundleId } = params;

    let output: string;
    try {
      const { stdout, stderr } = await runAdb(["-s", udid, "uninstall", bundleId], {
        timeoutMs: 30_000,
      });
      output = `${stdout}\n${stderr}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (NOT_INSTALLED.test(message)) {
        return { uninstalled: false, bundleId };
      }
      // A genuine failure (device offline, transport error) — surface it under
      // this tool's code while keeping adb's own message as the cause.
      throw new FailureError(`adb uninstall failed: ${message.trim()}`, {
        error_code: FAILURE_CODES.ANDROID_UNINSTALL_APP_FAILED,
        failure_stage: "android_uninstall_adb_uninstall",
        failure_area: "tool_server",
        error_kind: "subprocess",
      });
    }

    if (/\bSuccess\b/i.test(output)) {
      return { uninstalled: true, bundleId };
    }
    if (NOT_INSTALLED.test(output)) {
      return { uninstalled: false, bundleId };
    }
    throw new FailureError(`adb uninstall failed: ${output.trim()}`, {
      error_code: FAILURE_CODES.ANDROID_UNINSTALL_APP_FAILED,
      failure_stage: "android_uninstall_adb_uninstall",
      failure_area: "tool_server",
      error_kind: "subprocess",
    });
  },
};
