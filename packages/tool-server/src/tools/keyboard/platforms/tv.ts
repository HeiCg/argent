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
    // Text reaches a TV through the focus daemon's typing channel (`api.type`),
    // and `TvControlApi` exposes no delete verb at all — so there is nothing
    // here to send a clear through, on either backend.
    //
    // That is a gap in the API, not a property of the transport, and the two
    // backends differ underneath: on Android TV `api.type` IS `adb shell input`
    // (../../../blueprints/android-tv-control.ts), the same channel and the same
    // view `injectAndroidClear`'s burst would ride, so a clear there is
    // implementable; on Apple TV the channel is the injected tvOS daemon.
    // Neither is measured on a TV, and a clear that half-empties a field is
    // worse than a refusal, so both are refused until one is.
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
