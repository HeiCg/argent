import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell } from "../../../utils/adb";
import { TEXT_SIZE_VALUES } from "../types";
import type { SystemSettingsParams, SystemSettingsResult, SystemSettingsServices } from "../types";

// appearance → `cmd uimode night <mode>` (the immediate, applies-now switch for
// the system dark/light theme; API 29+).
const NIGHT_MODE: Record<string, string> = { light: "no", dark: "yes" };

// increase-contrast → the "high contrast text" accessibility toggle, Android's
// closest analogue to iOS's Increase Contrast. A Settings.Secure 0/1 flag.
const HIGH_CONTRAST: Record<string, string> = { enabled: "1", disabled: "0" };

// text-size → a `system.font_scale` float. iOS names 12 Dynamic Type categories
// where Android takes a continuous multiplier, so each category maps to the
// scale factor of that category's body-text point size relative to `large`
// (17pt) — iOS body sizes 14/15/16/17/19/21/23 then the AX range 28/33/40/47/53.
// This keeps the visual step between categories close to what iOS renders.
const FONT_SCALE: Record<(typeof TEXT_SIZE_VALUES)[number], string> = {
  "extra-small": "0.82",
  "small": "0.88",
  "medium": "0.94",
  "large": "1.0",
  "extra-large": "1.12",
  "extra-extra-large": "1.24",
  "extra-extra-extra-large": "1.35",
  "accessibility-medium": "1.65",
  "accessibility-large": "1.94",
  "accessibility-extra-large": "2.35",
  "accessibility-extra-extra-large": "2.76",
  "accessibility-extra-extra-extra-large": "3.12",
};

export const androidImpl: PlatformImpl<
  SystemSettingsServices,
  SystemSettingsParams,
  SystemSettingsResult
> = {
  requires: ["adb"],
  handler: async (_services, params) => {
    const { udid, setting, value } = params;

    // Central validation already guaranteed `value` is legal for `setting`, so
    // these lookups are always defined; build the concrete `adb` command and a
    // human-readable `applied` description per setting.
    let shellCommand: string;
    let applied: string;
    if (setting === "appearance") {
      const mode = NIGHT_MODE[value]!;
      shellCommand = `cmd uimode night ${mode}`;
      applied = `night_mode=${mode}`;
    } else if (setting === "increase-contrast") {
      const flag = HIGH_CONTRAST[value]!;
      shellCommand = `settings put secure high_text_contrast_enabled ${flag}`;
      applied = `high_text_contrast_enabled=${flag}`;
    } else {
      const scale = FONT_SCALE[value as (typeof TEXT_SIZE_VALUES)[number]]!;
      shellCommand = `settings put system font_scale ${scale}`;
      applied = `font_scale=${scale}`;
    }

    try {
      // `settings put` is silent on success and `cmd uimode night` echoes the
      // new mode; both exit non-zero (→ adbShell throws) on a real failure, so
      // the exit code — not the output — is the success signal.
      await adbShell(udid, shellCommand, { timeoutMs: 15_000 });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new FailureError(
        `Failed to set '${setting}' to '${value}' on ${udid}: ${detail.trim()}`,
        {
          error_code: FAILURE_CODES.ANDROID_SYSTEM_SETTING_FAILED,
          failure_stage: "android_system_setting_adb",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata(err, "adb"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }

    return { setting, value, applied };
  },
};
