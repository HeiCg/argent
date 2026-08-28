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
// That last property is also why `delete`'s return value alone cannot be
// trusted. `beforeinput` is the hook an editor with its own document model
// reconciles on, so Lexical and CKEditor 5 answer `true` and then restore every
// character from that model — Lexical before the DOM ever changes, CKEditor on
// the next microtask. `clearChromium` therefore reads the field back in a SECOND
// evaluate, which runs in a later renderer task, after those microtasks, and
// refuses when the value survived.
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
  const tag = el ? String(el.tagName).toLowerCase() : null;
  // Read \`.type\` only off an <input>: a textarea reflects the constant
  // "textarea" and a contenteditable has none. An omitted attribute reflects
  // as "text", so a bare <input> is a text field here as it is in the page.
  const type = tag === "input" ? String(el.type || "text").toLowerCase() : null;
  const focus = tag === null ? null : type === null ? tag : tag + " type=" + type;
  // \`document.designMode = "on"\` and <body contenteditable> make the DOCUMENT
  // its own editing host, and document.activeElement defaults to <body> — so a
  // clear that has been aimed at nothing passes every editability test below and
  // selects and deletes the entire page. Nothing bounds an editing host, and
  // this one needs no prior interaction at all, so it is refused by identity
  // before anything is selected.
  if (el && (el === document.body || el === document.documentElement) && el.isContentEditable === true) {
    return { cleared: false, focus: focus, reason: "document-editable" };
  }
  const editable =
    !!el &&
    !el.disabled &&
    !el.readOnly &&
    ((tag === "input" &&
      !/^(button|checkbox|radio|file|submit|reset|image|range|color)$/.test(type)) ||
      tag === "textarea" ||
      el.isContentEditable === true);
  if (!editable) return { cleared: false, focus: focus, reason: "not-editable" };
  document.execCommand("selectAll");
  // The cheap half of the check, and it is exact for the fields it does answer
  // for. Measured on Chrome 151: \`delete\` answers true for every element that
  // ends up empty — including one that was ALREADY empty, where \`selectAll\`
  // answers false — and false for exactly the five date/time input types, which
  // hold a structured value execCommand cannot touch while classifying as
  // editable by every other signal (they are not in the denylist above, and
  // nothing else distinguishes them). What it does NOT answer for is an editor
  // that restores the value afterwards, which is what the read-back below is for.
  if (!document.execCommand("delete")) {
    return { cleared: false, focus: focus, reason: "delete-refused" };
  }
  return { cleared: true, focus: focus };
})()`;

// Run as a SECOND evaluate, so the microtask checkpoint that ends the clear
// script has passed and an editor that restores its model from a
// MutationObserver has already put the characters back. (Measured on Chrome 151
// against CKEditor's shape: a read-back inside the clear script itself sees the
// emptied field and is fooled; this one sees the restored value.)
//
// Re-derives the focused element rather than holding a reference: `evaluate`
// returns by value, so nothing survives between the two calls — and re-deriving
// is also what detects a page that moved focus in its own `input` handler.
const CLEAR_READBACK_SCRIPT = `(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  const tag = el ? String(el.tagName).toLowerCase() : null;
  const type = tag === "input" ? String(el.type || "text").toLowerCase() : null;
  const focus = tag === null ? null : type === null ? tag : tag + " type=" + type;
  if (tag === "input" || tag === "textarea") {
    return { focus: focus, remaining: String(el.value == null ? "" : el.value).length };
  }
  if (el && el.isContentEditable === true) {
    // A cleared contenteditable keeps a placeholder <br> or an empty <p>, and an
    // editor may seed a zero-width space — none of which is a surviving value.
    // Trimmed at the ends only: interior whitespace is part of the text, and the
    // count is quoted back to the caller.
    const text = String(el.textContent == null ? "" : el.textContent).replace(/[\\u200b\\ufeff]/g, "").trim();
    return { focus: focus, remaining: text.length };
  }
  // Nothing readable holds focus any more. The delete already reported success,
  // so there is nothing here to contradict it.
  return { focus: focus, remaining: null };
})()`;

// The renderer answers the scripts above. Nothing else in the tool depends on
// the shape, so a missing field reads as a refusal rather than a crash.
interface ClearOutcome {
  cleared?: boolean;
  focus?: string | null;
  reason?: string;
}

interface ReadbackOutcome {
  focus?: string | null;
  remaining?: number | null;
}

async function clearChromium(api: ChromiumCdpApi): Promise<KeyboardResult> {
  const outcome = (await api.evaluate(CLEAR_FOCUSED_EDITABLE_SCRIPT, {
    returnByValue: true,
  })) as ClearOutcome | null;
  const focus = outcome?.focus;
  if (outcome?.cleared !== true) {
    // Two different refusals, two different repairs, so two codes. This one is
    // about the KIND of field, not about focus: the element is editable by
    // every signal the script can read, and the delete still did not land.
    if (outcome?.reason === "delete-refused") {
      throw new InvalidToolInputError(
        `the focused <${focus ?? "input"}> kept its value — nothing was cleared. Chromium's ` +
          "date and time inputs (date, datetime-local, month, week, time) hold a structured " +
          "value that a select-and-delete cannot remove. Clear that one with `keyboard` " +
          '`{ key: "backspace" }` while it has focus — one press empties it — or set it ' +
          "through the app's own control.",
        {
          error_code: FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_FIELD,
          failure_stage: "keyboard_clear_chromium_refused",
          error_kind: "unsupported",
        }
      );
    }
    // Caller input error → 400: the fix is a `gesture-tap` on the field, not a
    // retry of this call. The page is untouched either way — the script returns
    // before it selects anything, so no page-wide selection is left behind.
    // Same code and same repair for a document-wide editing host, which is a
    // clear that has not been aimed at a field yet.
    throw new InvalidToolInputError(
      (outcome?.reason === "document-editable"
        ? "the whole document is editable here (`designMode` is on, or <body> carries " +
          "`contenteditable`) and keyboard focus is still on it rather than on a field, so " +
          "clearing would have emptied the ENTIRE page"
        : focus
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
  const readback = (await api.evaluate(CLEAR_READBACK_SCRIPT, {
    returnByValue: true,
  })) as ReadbackOutcome | null;
  // Only a field that is still the focused one, and still readable, can
  // contradict the delete. `remaining: null` means focus moved to something with
  // no value to read, which is not evidence of anything.
  const remaining = readback?.remaining;
  if (typeof remaining === "number" && remaining > 0 && readback?.focus === focus) {
    // The KIND of field again, not focus: a retry of this same call reaches the
    // same editor and is restored the same way.
    throw new InvalidToolInputError(
      `the focused <${focus ?? "element"}> still holds ${remaining} character${remaining === 1 ? "" : "s"} ` +
        "after the delete — nothing was cleared. A rich-text editor that keeps its own document model " +
        "(Lexical, CKEditor) accepts the delete and then restores the text from that model, and a page can " +
        "do the same from an `input` listener. Typing now would APPEND to the value the field still holds: " +
        "empty it through the app's own control, or select the text with `gesture-drag` and type over the " +
        "selection instead.",
      {
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_FIELD,
        failure_stage: "keyboard_clear_chromium_restored",
        error_kind: "unsupported",
      }
    );
  }
  // No key events are dispatched at all, hence `keys: 0`. `cleared` reports a
  // field read back empty — on this backend alone, not merely what was sent.
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
