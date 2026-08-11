import { FAILURE_CODES } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import { harmonyConnectKey } from "../../../utils/device-info";
import { harmonyKeyEvent, harmonyTypeText } from "../../../utils/harmony-uitest";
import type { KeyboardParams, KeyboardResult } from "../types";

/**
 * Named keys this backend will press, and the `uitest uiInput keyEvent` keyID
 * each maps to.
 *
 * Every entry was confirmed against a physical HarmonyOS 6.0.1 handset by
 * typing into a real text field and reading the value back out of the layout
 * dump: `backspace` turned `abc` into `ab`; `space` turned `ab` into `ab `;
 * `arrow-left` then `X` produced `abX `, and `arrow-right` then `Y` produced
 * `abX Y`, which pins both directions; `enter` submitted the search and
 * replaced the screen.
 *
 * `tab`, `escape` and the vertical arrows are deliberately absent. `uitest`
 * accepts their documented keycodes and reports `No Error`, but nothing
 * observable happened in a text field, so there is no evidence they do the
 * right thing — and a key that silently does nothing while the tool reports
 * `{ keys: 1 }` is worse than one that is refused. They belong here the moment
 * someone can watch them work.
 */
const HARMONY_KEYCODES: Record<string, number> = {
  "enter": 2054,
  "backspace": 2055,
  "space": 2050,
  "arrow-left": 2014,
  "arrow-right": 2015,
};

function resolveHarmonyKeycode(key: string): number {
  const lower = key.toLowerCase();
  // Own-property check, and case-folded like every other backend: `key` is a
  // free string, so a prototype key like "constructor" would otherwise pass the
  // nullish guard with a garbage value and be interpolated into the remote shell
  // line (`harmonyKeyEvent` builds `uiInput keyEvent ${key}`) instead of
  // rejecting as an unknown key.
  const code = Object.hasOwn(HARMONY_KEYCODES, lower) ? HARMONY_KEYCODES[lower] : undefined;
  if (code === undefined) {
    throw new InvalidToolInputError(
      `Key '${key}' is not available on HarmonyOS. Supported: ` +
        `${Object.keys(HARMONY_KEYCODES).join(", ")}.`,
      {
        error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
        failure_stage: "harmony_keyboard_resolve_key",
      }
    );
  }
  return code;
}

async function typeHarmony(connectKey: string, params: KeyboardParams): Promise<KeyboardResult> {
  // Resolve before injecting anything: a combined key+text call with an unknown
  // key name must reject having typed nothing, not type the text and then 400.
  const keycode = params.key ? resolveHarmonyKeycode(params.key) : null;
  let keysPressed = 0;
  if (params.text) {
    // `uitest uiInput text` types into whatever holds focus, in one shot — there
    // is no per-character injection, so `delayMs` has nothing to pace (the tool
    // description already lists the platforms that ignore it).
    await harmonyTypeText(connectKey, params.text);
    keysPressed += [...params.text].length;
  }
  // Key after text, so a combined call means "type, then submit". Pressing first
  // would submit an empty field.
  if (keycode !== null) {
    await harmonyKeyEvent(connectKey, String(keycode));
    keysPressed++;
  }
  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}

/**
 * HarmonyOS has no simulator-server controller; typing goes to the device's own
 * `uitest`, reached over `hdc`. Declaring the dependency here lets
 * `dispatchByPlatform` preflight it and return a clean 424 install hint.
 */
export const harmonyImpl: PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> = {
  requires: ["hdc"],
  handler: (_services, params, device) => typeHarmony(harmonyConnectKey(device.id), params),
};
