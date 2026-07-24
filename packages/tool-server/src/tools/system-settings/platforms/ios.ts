import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type {
  SystemSetting,
  SystemSettingsParams,
  SystemSettingsResult,
  SystemSettingsServices,
} from "../types";

const execFileAsync = promisify(execFile);

// Abstract setting → the `xcrun simctl ui <udid> <option> <arg>` option name.
// The tool's `value` is already the exact argument simctl expects for all three
// (light/dark, enabled/disabled, and the content-size categories are simctl's
// own vocabulary), so it is passed through unchanged — no per-value mapping.
const IOS_UI_OPTION: Record<SystemSetting, string> = {
  "appearance": "appearance",
  "increase-contrast": "increase_contrast",
  "text-size": "content_size",
};

export const iosImpl: PlatformImpl<
  SystemSettingsServices,
  SystemSettingsParams,
  SystemSettingsResult
> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    const { udid, setting, value } = params;
    const option = IOS_UI_OPTION[setting];

    try {
      await execFileAsync("xcrun", ["simctl", "ui", udid, option, value], { timeout: 30_000 });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // `simctl ui` requires a booted simulator; its "Unable to lookup in
      // current state: Shutdown" doesn't tell an agent what to do about it.
      const shutdownHint = /current state:\s*shutdown/i.test(detail)
        ? " The simulator must be booted first — use boot-device."
        : "";
      // Some runtimes don't model a given setting (e.g. increase_contrast on an
      // older iOS runtime), which simctl reports as `unsupported`.
      const unsupportedHint =
        !shutdownHint && /unsupported/i.test(detail)
          ? ` The '${setting}' setting isn't supported by this simulator's iOS runtime; try a newer runtime.`
          : "";
      throw new FailureError(
        `Failed to set '${setting}' to '${value}' on ${udid}: ${detail.trim()}${shutdownHint}${unsupportedHint}`,
        {
          error_code: FAILURE_CODES.IOS_SYSTEM_SETTING_FAILED,
          failure_stage: "ios_system_setting_simctl_ui",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata(err, "xcrun_simctl"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }

    return { setting, value, applied: `${option}=${value}` };
  },
};
