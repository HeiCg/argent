import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as resolvePath } from "node:path";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { assertPhysicalIosEnabled } from "../../../blueprints/simulator-server";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<ReinstallAppServices, ReinstallAppParams, ReinstallAppResult> = {
  requires: ["xcrun"],
  handler: async (_services, params, device) => {
    const { udid, bundleId, appPath } = params;
    const absolute = resolvePath(appPath);

    if (device.kind === "device") {
      // Physical iPhones install through devicectl rather than simctl. Like
      // every devicectl-backed tool, this enforces the opt-in itself, since no
      // simulator-server ref is built on this path to run the gate.
      assertPhysicalIosEnabled();
      try {
        await execFileAsync("xcrun", [
          "devicectl",
          "device",
          "uninstall",
          "app",
          "--device",
          udid,
          bundleId,
        ]);
      } catch {
        // App may not be installed — continue to install
      }
      try {
        await execFileAsync("xcrun", [
          "devicectl",
          "device",
          "install",
          "app",
          "--device",
          udid,
          absolute,
        ]);
      } catch (err) {
        throw new FailureError(
          // The dominant failure here is a bundle that is not signed for this
          // device: a simulator .app, or one whose provisioning profile does
          // not list the device's UDID. devicectl says so, but only several
          // lines in, so name it up front.
          `Failed to install ${bundleId} on physical iOS device ${udid}. The bundle must be built for iOS (not the simulator) and signed with a provisioning profile that includes this device.`,
          {
            error_code: FAILURE_CODES.IOS_REINSTALL_INSTALL_FAILED,
            failure_stage: "ios_reinstall_app_devicectl_install",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...subprocessFailureMetadata(err, "xcrun_devicectl"),
          },
          { cause: err instanceof Error ? err : new Error(String(err)) }
        );
      }
      return { reinstalled: true, bundleId };
    }

    try {
      await execFileAsync("xcrun", ["simctl", "uninstall", udid, bundleId]);
    } catch {
      // App may not be installed — continue to install
    }
    try {
      await execFileAsync("xcrun", ["simctl", "install", udid, absolute]);
    } catch (err) {
      throw new FailureError(
        `Failed to install iOS app bundle on ${udid}.`,
        {
          error_code: FAILURE_CODES.IOS_REINSTALL_INSTALL_FAILED,
          failure_stage: "ios_reinstall_app_simctl_install",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata(err, "xcrun_simctl"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    return { reinstalled: true, bundleId };
  },
};
