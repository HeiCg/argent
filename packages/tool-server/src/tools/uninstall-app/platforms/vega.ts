import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { vegaDevice } from "../../../utils/vega-cli";
import type { UninstallAppParams, UninstallAppResult, UninstallAppServices } from "../types";

// `bundleId` is the Vega interactive component app id (e.g. com.example.app.main).
const NOT_INSTALLED = /not installed|not found|no such|unknown app/i;

export const vegaImpl: PlatformImpl<UninstallAppServices, UninstallAppParams, UninstallAppResult> = {
  requires: ["vega"],
  handler: async (_services, params) => {
    const { udid, bundleId } = params;
    try {
      await vegaDevice(udid, ["uninstall-app", "-a", bundleId], { timeoutMs: 60_000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (NOT_INSTALLED.test(message)) {
        return { uninstalled: false, bundleId };
      }
      throw new FailureError(`vega uninstall-app failed: ${message.trim()}`, {
        error_code: FAILURE_CODES.VEGA_CLI_COMMAND_FAILED,
        failure_stage: "vega_uninstall_app",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "vega",
      });
    }
    return { uninstalled: true, bundleId };
  },
};
