import type { DeviceInfo, Registry } from "@argent/registry";
import { UnsupportedOperationError } from "../../../utils/capability";
import { resolveTvApi } from "../../tv/tv-service";
import type { KeyboardParams, KeyboardResult } from "../types";

// Shared by the ios (Apple TV) and android (Android TV) branches. Named keys are
// navigation on a TV, which belongs to `tv-remote` — so they're rejected here.
export async function typeTv(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams
): Promise<KeyboardResult> {
  if (params.key) {
    throw new UnsupportedOperationError(
      "keyboard",
      device,
      "named keys are not supported on a TV target — move focus with `tv-remote` " +
        "(up/down/left/right/select) instead"
    );
  }
  if (params.clear === true) {
    // The clear burst is `backspace` + `forward-delete` HID/adb key events, and
    // a TV target has no hardware keyboard focus to send them to: text reaches
    // it through the focus daemon's own typing channel (`api.type`), which has
    // no delete verb. Emptying a field on a TV goes through the on-screen
    // keyboard, which is D-pad navigation.
    throw new UnsupportedOperationError(
      "keyboard",
      device,
      "`clear` is not supported on a TV target — empty the field with the app's " +
        "on-screen keyboard, driven with `tv-remote` (move focus to its delete key " +
        "and press select)"
    );
  }
  const text = params.text ?? "";
  if (text) {
    const api = await resolveTvApi(registry, device.id);
    await api.type(text);
  }
  // Codepoints, not UTF-16 units: a non-BMP char reports `keys: 1`, matching the
  // vega and simulator-server backends.
  return { typed: text, keys: [...text].length };
}
