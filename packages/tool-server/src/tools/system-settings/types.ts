// The device-wide display / accessibility settings this tool can toggle. Each
// maps to a single `xcrun simctl ui` option on iOS and a single `adb` command
// on Android (see `platforms/`), so the abstract name here is the vocabulary
// the agent uses and the platform files own the translation.
export const SYSTEM_SETTINGS = ["appearance", "increase-contrast", "text-size"] as const;

export type SystemSetting = (typeof SYSTEM_SETTINGS)[number];

// Allowed values per setting. These abstract values are ALSO the exact
// `simctl ui` argument strings on iOS (light/dark, enabled/disabled, and the
// content-size categories are simctl's own vocabulary), so the iOS handler
// passes them straight through; the Android handler maps them to `adb`
// arguments (night yes/no, high_text_contrast_enabled 1/0, a font_scale float).
export const APPEARANCE_VALUES = ["light", "dark"] as const;

export const CONTRAST_VALUES = ["enabled", "disabled"] as const;

// The 12 Dynamic Type content-size categories `simctl ui content_size` accepts,
// smallest to largest (the 5 `accessibility-*` sizes are the AX range). Kept in
// this order so a human reading the list sees a monotonic scale.
export const TEXT_SIZE_VALUES = [
  "extra-small",
  "small",
  "medium",
  "large",
  "extra-large",
  "extra-extra-large",
  "extra-extra-extra-large",
  "accessibility-medium",
  "accessibility-large",
  "accessibility-extra-large",
  "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large",
] as const;

// The legal abstract values for each setting, used to validate `value` before
// dispatch (an out-of-range value fails with SYSTEM_SETTING_UNSUPPORTED and this
// list, rather than reaching a platform command with a bad argument).
export const SETTING_VALUES: Record<SystemSetting, readonly string[]> = {
  "appearance": APPEARANCE_VALUES,
  "increase-contrast": CONTRAST_VALUES,
  "text-size": TEXT_SIZE_VALUES,
};

export interface SystemSettingsParams {
  udid: string;
  setting: SystemSetting;
  value: string;
}

export interface SystemSettingsResult {
  setting: SystemSetting;
  value: string;
  /**
   * The concrete platform-level change that was applied, so the caller can see
   * exactly what the abstract (setting, value) translated to: on iOS the
   * `simctl ui` option and argument (e.g. `content_size=large`), on Android the
   * `adb` change (e.g. `night_mode=yes`, `font_scale=1.00`).
   */
  applied: string;
}

export type SystemSettingsServices = Record<string, never>;
