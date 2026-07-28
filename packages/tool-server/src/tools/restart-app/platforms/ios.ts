import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  FAILURE_CODES,
  FailureError,
  subprocessFailureMetadata,
  type Registry,
} from "@argent/registry";
import {
  nativeDevtoolsRef,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
} from "../../../blueprints/native-devtools";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { UnsupportedOperationError } from "../../../utils/capability";
import type { RestartAppParams, RestartAppResult } from "../types";

const execFileAsync = promisify(execFile);

// native-devtools is resolved lazily (through `registry`) rather than declared
// as an eager service. It is iOS *and* tvOS capable: the blueprint's ensureEnv
// picks the platform-matched DYLD_INSERT_LIBRARIES slice (the TVOSSIMULATOR
// bootstrap for Apple TV sims), so resolving it here injects correctly on both.
export function makeIosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, RestartAppParams, RestartAppResult> {
  return {
    requires: ["xcrun"],
    handler: async (_services, params, device) => {
      const { udid, bundleId } = params;
      if (device.kind === "device") {
        // The simulator path restarts *through* native-devtools so the relaunched
        // process comes back injected; that injection is simulator-only, so there
        // is nothing for this tool to preserve on hardware and it is not wired up
        // for physical iOS. (`devicectl device process launch --terminate-existing`
        // would relaunch a plain, uninjected app — see launch-app.)
        // UnsupportedOperationError maps to a clean 400 (a plain Error would
        // surface as a generic 500).
        throw new UnsupportedOperationError(
          "restart-app",
          device,
          "restarting an app on a physical iPhone is not implemented yet — use launch-app to bring " +
            "it back to the foreground"
        );
      }
      const ndRef = nativeDevtoolsRef(device);
      const nativeDevtools = await registry.resolveService<NativeDevtoolsApi>(
        ndRef.urn,
        ndRef.options
      );
      const blocked = await precheckNativeDevtools(nativeDevtools, udid);
      if (blocked) return blocked;
      try {
        await execFileAsync("xcrun", ["simctl", "terminate", udid, bundleId]);
      } catch {
        // App may not be running — ignore
      }
      try {
        await execFileAsync("xcrun", ["simctl", "launch", udid, bundleId]);
      } catch (err) {
        throw new FailureError(
          `Failed to restart iOS app ${bundleId} on ${udid}.`,
          {
            error_code: FAILURE_CODES.IOS_RESTART_LAUNCH_FAILED,
            failure_stage: "ios_restart_app_simctl_launch",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...subprocessFailureMetadata(err, "xcrun_simctl"),
          },
          { cause: err instanceof Error ? err : new Error(String(err)) }
        );
      }
      return { restarted: true, bundleId };
    },
  };
}
