import type { DeviceInfo } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { UnsupportedOperationError } from "../../../utils/capability";
import { injectVegaNamedKey, injectVegaText } from "../../../utils/vega-input";
import type { KeyboardParams, KeyboardResult } from "../types";

// Input is injected over `adb` (on-device `inputd-cli`). `requires: ["adb"]` is
// preflighted by dispatchByPlatform before the handler runs, so a missing adb
// fails with a 424 install hint rather than a spawn ENOENT.
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
  requires: ["adb"],
  handler: (_services, params, device) => runVega(params, device),
};
