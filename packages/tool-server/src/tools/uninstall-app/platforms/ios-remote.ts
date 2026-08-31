import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlUninstall } from "../../../utils/sim-remote";
import type { UninstallAppParams, UninstallAppResult, UninstallAppServices } from "../types";

// Same already-absent handling as the local iOS branch: sim-remote forwards
// simctl's own error text.
const NOT_INSTALLED = /not installed|No such|failed to lookup|found nothing/i;

/** Remote analogue of the iOS impl: `sim-remote simctl uninstall` on the orchestrator. */
export const iosRemoteImpl: PlatformImpl<
  UninstallAppServices,
  UninstallAppParams,
  UninstallAppResult
> = {
  requires: ["sim-remote"],
  handler: async (_services, params) => {
    const { udid, bundleId } = params;
    try {
      await simctlUninstall(udid, bundleId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (NOT_INSTALLED.test(message)) {
        return { uninstalled: false, bundleId };
      }
      throw new FailureError(
        `Failed to uninstall ${bundleId} on remote simulator ${udid}.`,
        {
          error_code: FAILURE_CODES.IOS_UNINSTALL_APP_FAILED,
          failure_stage: "ios_remote_uninstall_app_simctl",
          failure_area: "tool_server",
          error_kind: "subprocess",
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    return { uninstalled: true, bundleId };
  },
};
