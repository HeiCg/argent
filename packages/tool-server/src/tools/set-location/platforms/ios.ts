import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { deviceSetForUdid, simctlPrefix } from "../../../utils/ios-device-sets";
import type { SetLocationParams, SetLocationResult, SetLocationServices } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<SetLocationServices, SetLocationParams, SetLocationResult> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    const { udid, latitude, longitude } = params;
    const prefix = simctlPrefix(await deviceSetForUdid(udid));
    try {
      // `simctl location <udid> set <lat>,<lon>` — latitude first here, unlike
      // the emulator console.
      await execFileAsync("xcrun", [
        ...prefix,
        "location",
        udid,
        "set",
        `${latitude},${longitude}`,
      ]);
    } catch (err) {
      throw new FailureError(
        `Failed to set the simulated location on ${udid}.`,
        {
          error_code: FAILURE_CODES.IOS_SET_LOCATION_FAILED,
          failure_stage: "ios_set_location_simctl",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata(err, "xcrun_simctl"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    return { located: true, latitude, longitude };
  },
};
