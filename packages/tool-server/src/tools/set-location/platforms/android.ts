import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { runAdb } from "../../../utils/adb";
import type { SetLocationParams, SetLocationResult, SetLocationServices } from "../types";

export const androidImpl: PlatformImpl<
  SetLocationServices,
  SetLocationParams,
  SetLocationResult
> = {
  requires: ["adb"],
  handler: async (_services, params) => {
    const { udid, latitude, longitude } = params;

    // The emulator console takes `geo fix <longitude> <latitude>` — longitude
    // first, the reverse of the lat/long order everywhere else. Passed as argv
    // to `adb`, not a device shell, so no quoting is needed.
    const { stdout, stderr } = await runAdb(
      ["-s", udid, "emu", "geo", "fix", String(longitude), String(latitude)],
      { timeoutMs: 15_000 }
    );
    // The console answers `OK` on success and `KO: <reason>` when it rejects the
    // fix (out-of-range coordinate, console not ready). adb's exit code stays 0
    // either way, so the verdict is in the text.
    const output = `${stdout}\n${stderr}`;
    if (/\bKO\b/i.test(output)) {
      throw new FailureError(`emulator console rejected the location: ${output.trim()}`, {
        error_code: FAILURE_CODES.ANDROID_SET_LOCATION_FAILED,
        failure_stage: "android_set_location_emu_geo_fix",
        failure_area: "tool_server",
        error_kind: "subprocess",
      });
    }
    return { located: true, latitude, longitude };
  },
};
