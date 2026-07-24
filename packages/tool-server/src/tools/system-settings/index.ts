import { z } from "zod";
import { FAILURE_CODES } from "@argent/registry";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../utils/capability";
import { SETTING_VALUES, SYSTEM_SETTINGS } from "./types";
import type { SystemSettingsParams, SystemSettingsResult, SystemSettingsServices } from "./types";
import { iosImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS simulator UDID or Android serial)."),
  setting: z
    .enum(SYSTEM_SETTINGS)
    .describe(
      "Which system setting to change: `appearance` (light/dark theme), `increase-contrast` (accessibility high-contrast), or `text-size` (Dynamic Type / font size)."
    ),
  value: z
    .string()
    .min(1)
    .describe(
      "The value to set — valid values depend on `setting`: " +
        "`appearance` → light | dark; " +
        "`increase-contrast` → enabled | disabled; " +
        "`text-size` → extra-small | small | medium | large | extra-large | extra-extra-large | extra-extra-extra-large | accessibility-medium | accessibility-large | accessibility-extra-large | accessibility-extra-extra-large | accessibility-extra-extra-extra-large (smallest to largest; `large` is the default)."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  // `simctl ui` edits the simulator's UI settings — physical iPhones have no
  // host-side equivalent, so no `device: true` on apple.
  apple: { simulator: true },
  // `adb shell cmd uimode` / `settings put` work on emulators and real Android
  // devices alike.
  android: { emulator: true, device: true, unknown: true },
};

// Reject a `value` that isn't legal for the chosen `setting` before dispatch, so
// a bad argument never reaches a platform command. Runs for every platform, so
// it lives here rather than duplicated in each handler.
function assertValidValue(params: SystemSettingsParams): void {
  const allowed = SETTING_VALUES[params.setting];
  if (!allowed.includes(params.value)) {
    // An out-of-set value is a caller input error, not an internal fault — throw
    // InvalidToolInputError so the HTTP layer maps it to 400 (matching the
    // keyboard backends' un-typeable-character rejections), while the signal
    // override keeps the granular SYSTEM_SETTING_UNSUPPORTED telemetry bucket.
    throw new InvalidToolInputError(
      `'${params.value}' is not a valid value for '${params.setting}'. Valid values: ${allowed.join(", ")}.`,
      {
        error_code: FAILURE_CODES.SYSTEM_SETTING_UNSUPPORTED,
        failure_stage: "system_setting_validate_value",
      }
    );
  }
}

const dispatch = dispatchByPlatform<
  SystemSettingsServices,
  SystemSettingsServices,
  Params,
  SystemSettingsResult
>({
  toolId: "system-settings",
  capability,
  ios: iosImpl,
  android: androidImpl,
});

export const systemSettingsTool: ToolDefinition<Params, SystemSettingsResult> = {
  id: "system-settings",
  description: `Change a device-wide display or accessibility setting directly, without navigating the system Settings UI. Use during test setup to put the device in a specific state — dark mode, a larger text size, or increased contrast — before or while exercising an app.
Settings and their values:
- \`appearance\`: \`light\` | \`dark\` — the system color theme.
- \`increase-contrast\`: \`enabled\` | \`disabled\` — the accessibility high-contrast mode.
- \`text-size\`: one of the 12 Dynamic Type categories from \`extra-small\` to \`accessibility-extra-extra-extra-large\` (\`large\` is the default).
iOS simulator: sets it via \`simctl ui\` (appearance / increase_contrast / content_size). The simulator must be booted. A setting a given iOS runtime doesn't model returns an unsupported error.
Android: sets the dark theme via \`cmd uimode night\`, high-contrast text via the \`high_text_contrast_enabled\` accessibility flag, and text size via \`font_scale\` (each iOS category maps to the nearest scale). Works on emulators and real devices; dark mode needs Android 10 (API 29)+.
This is a device-wide toggle, not per-app — no bundleId. Some apps only re-read a setting on next launch, so relaunch the app afterwards if the change doesn't appear live.
Returns { setting, value, applied }, where \`applied\` is the concrete platform-level change (e.g. \`content_size=large\`, \`night_mode=yes\`, \`font_scale=1.0\`). Fails if the value is invalid for the setting, the device isn't booted, or the platform command errors.`,
  searchHint:
    "dark light mode appearance theme color scheme text size font dynamic type increase contrast accessibility system settings toggle",
  zodSchema,
  capability,
  services: () => ({}),
  async execute(services, params, options) {
    assertValidValue(params);
    return dispatch(services, params, options);
  },
};
