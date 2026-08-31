import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { deviceSetForUdid, simctlPrefix } from "../../../utils/ios-device-sets";
import type { UninstallAppParams, UninstallAppResult, UninstallAppServices } from "../types";

const execFileAsync = promisify(execFile);

// simctl surfaces an already-absent app as an error, not a silent no-op on every
// runtime; treat that as a teardown no-op rather than a failure.
const NOT_INSTALLED = /not installed|No such|failed to lookup|found nothing/i;

export const iosImpl: PlatformImpl<UninstallAppServices, UninstallAppParams, UninstallAppResult> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    const { udid, bundleId } = params;
    const prefix = simctlPrefix(await deviceSetForUdid(udid));
    try {
      await execFileAsync("xcrun", [...prefix, "uninstall", udid, bundleId]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (NOT_INSTALLED.test(message)) {
        return { uninstalled: false, bundleId };
      }
      throw new FailureError(
        `Failed to uninstall ${bundleId} on ${udid}.`,
        {
          error_code: FAILURE_CODES.IOS_UNINSTALL_APP_FAILED,
          failure_stage: "ios_uninstall_app_simctl",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata(err, "xcrun_simctl"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    return { uninstalled: true, bundleId };
  },
};
