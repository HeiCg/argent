import { FAILURE_CODES, type Registry } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../../blueprints/chromium-cdp";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import { CHROMIUM_NAMED_KEYS, charToChromiumKey } from "../chromium-keys";
import type { KeyboardParams, KeyboardResult } from "../types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Clearing over the DOM, not over key events. A modifier-only `Meta+A` /
// `Ctrl+A` selects nothing in a Chromium renderer on macOS, and a 200-key delete
// burst would deliver 200 keydowns to a page whose own shortcut handler may
// cancel them. `execCommand` reaches neither: it fires one `input` event with
// `inputType: "deleteContentBackward"` — what React's value tracker and
// rich-text editors listen to — and no keydown at all. (Measured on Chrome 151:
// `input` fires for `<input>`, `<textarea>` and a contenteditable alike;
// `beforeinput` does NOT, so a page cannot pre-empt the delete either.)
//
// Reading the focus first is what the key backends cannot do: the DOM says
// outright whether anything editable holds focus, so a clear aimed at nothing
// fails loudly instead of deleting from whatever the page focuses by default.
//
// Exported for test/keyboard-clear-chromium-script.test.ts, which evals it
// against a mock document to lock in the editable/refusal classification.
export const CLEAR_FOCUSED_EDITABLE_SCRIPT = `(() => {
  let el = document.activeElement;
  // A custom element hands focus down into its shadow root, where the real
  // <input> lives; document.activeElement only ever names the host.
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  const editable =
    !!el &&
    !el.disabled &&
    !el.readOnly &&
    ((el.tagName === "INPUT" &&
      !/^(button|checkbox|radio|file|submit|reset|image|range|color)$/i.test(el.type)) ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable === true);
  if (!editable) {
    return { cleared: false, focus: el ? String(el.tagName).toLowerCase() : null };
  }
  document.execCommand("selectAll");
  document.execCommand("delete");
  return { cleared: true };
})()`;

// The renderer answers the script above. Nothing else in the tool depends on
// the shape, so a missing field reads as a refusal rather than a crash.
interface ClearOutcome {
  cleared?: boolean;
  focus?: string | null;
}

async function clearChromium(api: ChromiumCdpApi): Promise<KeyboardResult> {
  const outcome = (await api.evaluate(CLEAR_FOCUSED_EDITABLE_SCRIPT, {
    returnByValue: true,
  })) as ClearOutcome | null;
  if (outcome?.cleared !== true) {
    const focus = outcome?.focus;
    // Caller input error → 400: the fix is a `gesture-tap` on the field, not a
    // retry of this call. The page is untouched either way — the script returns
    // before it selects anything, so no page-wide selection is left behind.
    throw new InvalidToolInputError(
      (focus
        ? `nothing editable has keyboard focus (it is on <${focus}>)`
        : "no element has keyboard focus") +
        " — nothing was cleared. Tap the field first (`gesture-tap`), then clear it. " +
        "A field inside an <iframe> reports as `iframe` here: the page's active element is " +
        "the frame, and this clear does not reach into it — for that one, select the text " +
        "with `gesture-drag` and type over the selection instead.",
      {
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_NO_EDITABLE_FOCUS,
        failure_stage: "keyboard_clear_chromium",
        error_kind: "validation",
      }
    );
  }
  // No key events are dispatched at all, hence `keys: 0`. `cleared` reports what
  // was sent, not what the field now holds — the value is never read back.
  return { typed: "", keys: 0, cleared: true };
}

async function runChromium(api: ChromiumCdpApi, params: KeyboardParams): Promise<KeyboardResult> {
  const delay = params.delayMs ?? 50;
  let keysPressed = 0;

  // ../index.ts rejects a request carrying more than one of `text` / `key` /
  // `clear`, so at most one of the two blocks below runs.
  if (params.text) {
    for (const char of params.text) {
      const desc = charToChromiumKey(char);
      if (!desc) {
        // Caller input error → 400, in the cross-backend
        // KEYBOARD_CHARACTER_UNSUPPORTED telemetry bucket (#420).
        throw new InvalidToolInputError(`No CDP key descriptor for character "${char}"`, {
          error_code: FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED,
          failure_stage: "keyboard_char_chromium",
          error_kind: "unsupported",
        });
      }
      await api.dispatchKeyEvent({
        type: "keyDown",
        key: desc.key,
        code: desc.code,
        windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
      });
      // Without the `char` event the focused input receives no value.
      await api.dispatchKeyEvent({ type: "char", text: desc.text });
      await api.dispatchKeyEvent({
        type: "keyUp",
        key: desc.key,
        code: desc.code,
        windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
      });
      keysPressed++;
      await sleep(delay);
    }
  }

  if (params.key) {
    const lower = params.key.toLowerCase();
    // Own-property check: "constructor" would otherwise pass the falsy guard
    // with a garbage value and dispatch a broken CDP event.
    const named = Object.hasOwn(CHROMIUM_NAMED_KEYS, lower)
      ? CHROMIUM_NAMED_KEYS[lower]
      : undefined;
    if (!named) {
      // `key` is a free string, so an unknown name is a caller mistake → 400
      // (as on Android), in the KEYBOARD_KEY_UNSUPPORTED bucket (#420).
      throw new InvalidToolInputError(
        `Unknown key "${params.key}". Supported: ${Object.keys(CHROMIUM_NAMED_KEYS).join(", ")}`,
        {
          error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
          failure_stage: "keyboard_named_key_chromium",
          error_kind: "unsupported",
        }
      );
    }
    await api.dispatchKeyEvent({
      type: "keyDown",
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.windowsVirtualKeyCode,
    });
    await sleep(delay);
    await api.dispatchKeyEvent({
      type: "keyUp",
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.windowsVirtualKeyCode,
    });
    keysPressed++;
  }

  return { typed: params.text ?? params.key ?? "", keys: keysPressed };
}

export function makeChromiumImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device) => {
      const ref = chromiumCdpRef(device);
      const chromium = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
      return params.clear === true ? clearChromium(chromium) : runChromium(chromium, params);
    },
  };
}
