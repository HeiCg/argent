import type { DeviceInfo } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { UnsupportedOperationError } from "../../../utils/capability";
import { ensureDep } from "../../../utils/check-deps";
import { injectVegaNamedKey, injectVegaText } from "../../../utils/vega-input";
import type { KeyboardParams, KeyboardResult } from "../types";

// Input is injected over `adb` (on-device `inputd-cli`), so a missing adb must
// fail with a 424 install hint rather than a spawn ENOENT.
//
// Checked HERE rather than declared as `requires: ["adb"]`, which
// `dispatchByPlatform` preflights before the handler runs: `clear` is refused on
// Vega whatever the host has installed, and on a host without adb that refusal
// came back as "install adb" instead of the documented UnsupportedOperationError
// — a caller told to install a binary for a capability that will never exist.
async function runVega(params: KeyboardParams, device: DeviceInfo): Promise<KeyboardResult> {
  if (params.clear === true) {
    // The other two backends clear by bursting `backspace` + `forward-delete`;
    // on-device `inputd-cli` may well be able to send KEY_BACKSPACE, but nothing
    // has measured it on a VVD, and a clear that silently deletes one character
    // is worse than a rejection. Left for a follow-up.
    throw new UnsupportedOperationError(
      "keyboard",
      device,
      "`clear` is not supported on Vega — empty the field with the app's on-screen " +
        "keyboard, driven with `tv-remote`"
    );
  }
  await ensureDep("adb");
  let keysPressed = 0;
  // ../index.ts rejects a request carrying more than one of `text` / `key` /
  // `clear`, so at most one of these two branches runs.
  if (params.text) {
    await injectVegaText(params.text);
    keysPressed += [...params.text].length;
  }
  if (params.key) {
    await injectVegaNamedKey(params.key);
    keysPressed++;
  }
  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}

export const vegaImpl: PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> = {
  // No `requires` — see `runVega`: the adb check runs after the `clear` refusal,
  // which must not depend on what the host has installed.
  handler: (_services, params, device) => runVega(params, device),
};
