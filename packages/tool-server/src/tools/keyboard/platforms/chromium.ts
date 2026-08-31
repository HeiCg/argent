import { FAILURE_CODES, FailureError, getFailureSignal, type Registry } from "@argent/registry";
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
  try {
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
  // Every refusal below carries its own \`reason\`, because the two repairs are
  // opposites and an agent given the wrong one loops: "tap the field" is the fix
  // ONLY where focus is on the wrong element. Where the focused element is the
  // right one and simply cannot be cleared — readonly, disabled, a non-text
  // input — tapping it again changes nothing.
  //
  // \`document.designMode = "on"\` and <body contenteditable> make the DOCUMENT
  // its own editing host. Nothing bounds an editing host, and this one needs no
  // prior interaction at all, so it is refused before anything is selected.
  //
  // The identity that decides it is the EDITING HOST's, not the focused node's.
  // Every element inside a document-wide host reports
  // \`isContentEditable === true\` (measured on Chrome 151), so a focused
  // <button>, link or <div tabindex> passes a test on the focused node and then
  // has the whole page selected and deleted under it — reachable with nothing
  // but \`autofocus\`. Walking up to the outermost editable ancestor returns
  // <body> (or <html> under designMode) for exactly those cases.
  //
  // <input> and <textarea> inherit the flag too (measured) and are exempt: they
  // hold their own value, which select-and-delete empties without reaching the
  // page around them — a real field on a designMode page stays clearable.
  let host = el;
  while (host && host.parentElement && host.parentElement.isContentEditable === true) {
    host = host.parentElement;
  }
  if (el && el.isContentEditable === true && tag !== "input" && tag !== "textarea" &&
      (host === document.body || host === document.documentElement)) {
    return { cleared: false, focus: focus, reason: "document-editable" };
  }
  // Checked before \`disabled\`/\`readOnly\`, so a \`<input type=checkbox readonly>\`
  // is reported by the thing that actually makes it unclearable.
  if (tag === "select" ||
      (tag === "input" && /^(button|checkbox|radio|file|submit|reset|image|range|color)$/.test(type))) {
    return { cleared: false, focus: focus, reason: "not-a-text-field" };
  }
  if (el && el.disabled === true) return { cleared: false, focus: focus, reason: "disabled" };
  if (el && el.readOnly === true) return { cleared: false, focus: focus, reason: "readonly" };
  const editable = !!el && (tag === "input" || tag === "textarea" || el.isContentEditable === true);
  if (!editable) {
    // A CLOSED shadow root is opaque to script: \`el.shadowRoot\` is null, so the
    // descent above stopped on the host and the tag test cannot see the <input>
    // that may hold focus. It is REFUSED rather than tried, because a blind
    // select-and-delete here cannot be told from a destructive one:
    //
    //   * \`execCommand\` acts on the document's SELECTION, not on the focused
    //     element. Measured on Chrome 151 with the standard rich-text toolbar
    //     shape (\`mousedown\` + \`preventDefault\` + \`focus()\`, which keeps the
    //     editor's selection alive): focus on the button, selection still in a
    //     neighbouring \`contenteditable\` — \`selectAll\` + \`delete\` emptied THAT
    //     editor and answered true.
    //   * \`delete\` answers true whether or not it removed anything, so its
    //     return value is not evidence, and an opaque host cannot be read back
    //     to get any. \`cleared\` on this backend means the field was SEEN empty;
    //     this path could never make that claim.
    //
    // The plain-light-DOM custom element (\`<my-field><input></my-field>\`, the
    // Stencil \`shadow: false\` / Lit \`createRenderRoot\` default) is the same
    // shape from outside and got the same gamble, which is why the hyphen alone
    // never made it safe. Its own repair — tap the inner field — is in the
    // message.
    //
    // \`childNodes.length === 0\` catches the same host on a NON-hyphenated tag
    // (\`<div>\` + \`attachShadow({mode:"closed"})\`): a closed root leaves the
    // light subtree empty, and "tap the field first" is a loop for an element
    // that already has focus.
    const opaque =
      !!el && !el.shadowRoot && tag !== null && (tag.indexOf("-") !== -1 || el.childNodes.length === 0);
    return { cleared: false, focus: focus, reason: opaque ? "host-opaque" : "not-editable" };
  }
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
    // \`selectAll\` has already run, and on a field it then refuses it selects the
    // WHOLE DOCUMENT (measured on Chrome 151 for a focused date input). Left
    // behind, that highlight reaches the next screenshot and every screenshot-diff.
    const sel = document.getSelection();
    if (sel) sel.removeAllRanges();
    return { cleared: false, focus: focus, reason: "delete-refused" };
  }
  return { cleared: true, focus: focus };
  } catch (err) {
    // A page can replace or delete \`document.execCommand\` — editors and
    // polyfills do. Without this the throw leaves \`result.value\` undefined,
    // which reads as a refusal: the wrong cause, with the wrong repair.
    return { cleared: false, reason: "script-error", detail: String((err && err.message) || err) };
  }
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
  detail?: string;
}

interface ReadbackOutcome {
  focus?: string | null;
  remaining?: number | null;
}

/**
 * The refusals whose repair is NOT "tap the field": the focused element is
 * already the one the caller meant, and it still cannot be cleared. They get
 * `KEYBOARD_CLEAR_UNSUPPORTED_FIELD` rather than `..._NO_EDITABLE_FOCUS`,
 * because an agent told to tap a field it has already tapped loops forever.
 *
 * Each entry completes the sentence `the focused <X> …`.
 */
const UNCLEARABLE_FIELD_MESSAGES: Record<string, string> = {
  "readonly":
    "is `readonly` — nothing was cleared, and nothing can be: a read-only field ignores every edit, " +
    "including this one. It already has keyboard focus, so tapping it again will not help. Change it " +
    "through the app's own control, or clear a different field.",
  "disabled":
    "is `disabled` — nothing was cleared, and nothing can be until the app enables it. It already has " +
    "keyboard focus, so tapping it again will not help.",
  "not-a-text-field":
    "holds no text to clear — nothing was cleared. It already has keyboard focus, so tapping it again " +
    "will not help; set it through the app's own control (`gesture-tap` an option, `gesture-drag` a " +
    "slider), or clear a different field.",
  "host-opaque":
    "is not editable itself and exposes no open shadow root, so this clear can see neither whether it " +
    "holds a field nor what that field contains — and it will not delete blind: `execCommand` acts on " +
    "the document's SELECTION rather than on the focused element, so a blind attempt can empty a " +
    "DIFFERENT editor and still report success. Nothing was cleared, and nothing was selected. Tap the " +
    "field inside it (`gesture-tap`) if it exposes one, or select the text with `gesture-drag` and type " +
    "over the selection instead.",
};

/**
 * Run one of the two clear scripts, re-stating a CDP wait that ran out.
 *
 * `clear` is the only `keyboard` operation that waits on the renderer main
 * thread: `text` and `key` go through `Input.dispatchKeyEvent`, which the
 * BROWSER process acknowledges in about 50ms whatever the renderer is doing. So
 * `clear` is the only one that meets the CDP client's 10s wait, and what happens
 * there is specific: the pending entry is dropped locally, but the request is
 * never cancelled on the renderer, so the delete still runs the moment the
 * renderer is free.
 *
 * The debugger taxonomy's own message for that ("restart the app, then reconnect
 * and retry once") is therefore the wrong move twice over — the app is fine, and
 * a retry lands a SECOND delete on a field the first one may already have
 * emptied. Re-stated as `KEYBOARD_CLEAR_UNCONFIRMED`, whose whole content is
 * "read the field back before doing anything else".
 */
async function evaluateClearStep(
  api: ChromiumCdpApi,
  script: string,
  stage: string
): Promise<unknown> {
  try {
    return await api.evaluate(script, { returnByValue: true });
  } catch (err) {
    if (getFailureSignal(err)?.error_kind !== "timeout") throw err;
    throw new FailureError(
      "the renderer did not answer the clear in time, so whether the field was emptied is unknown — " +
        "the delete is NOT cancelled by the timeout and can still land once the renderer is free. Do " +
        "not retry blind and do not type into the field: read it back first (`describe`), then clear " +
        "or type according to what it actually holds. A renderer this busy is ordinary during QA; it " +
        "is not a reason to restart the app.",
      {
        error_code: FAILURE_CODES.KEYBOARD_CLEAR_UNCONFIRMED,
        failure_stage: stage,
        failure_area: "tool_server",
        error_kind: "timeout",
        failure_command: "cdp",
      },
      { cause: err instanceof Error ? err : undefined }
    );
  }
}

function unclearableField(message: string, stage: string): InvalidToolInputError {
  return new InvalidToolInputError(message, {
    error_code: FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_FIELD,
    failure_stage: stage,
    error_kind: "unsupported",
  });
}

async function clearChromium(api: ChromiumCdpApi): Promise<KeyboardResult> {
  const outcome = (await evaluateClearStep(
    api,
    CLEAR_FOCUSED_EDITABLE_SCRIPT,
    "keyboard_clear_chromium_timeout"
  )) as ClearOutcome | null;
  const focus = outcome?.focus;
  if (outcome?.cleared !== true) {
    const reason = outcome?.reason;
    // Nothing was classified and nothing was sent: the page broke the script.
    // Bucketed with the field kinds because a retry of the same call on the same
    // page fails identically — it is not a focus problem.
    if (reason === "script-error") {
      throw unclearableField(
        "the page raised an error while clearing, so nothing was cleared: " +
          (outcome?.detail ?? "no detail") +
          ". A page that replaces or removes `document.execCommand` cannot be cleared this way — " +
          "select the text with `gesture-drag` and type over the selection instead.",
        "keyboard_clear_chromium_script_error"
      );
    }
    // Two different refusals, two different repairs, so two codes. This one is
    // about the KIND of field, not about focus: the element is editable by
    // every signal the script can read, and the delete still did not land.
    if (reason === "delete-refused") {
      throw unclearableField(
        `the focused <${focus ?? "input"}> kept its value — nothing was cleared. Chromium's ` +
          "date and time inputs (date, datetime-local, month, week, time) hold a structured " +
          "value that a select-and-delete cannot remove. Clear that one with `keyboard` " +
          '`{ key: "backspace" }` while it has focus — one press empties it — or set it ' +
          "through the app's own control.",
        "keyboard_clear_chromium_refused"
      );
    }
    const unclearable = reason === undefined ? undefined : UNCLEARABLE_FIELD_MESSAGES[reason];
    if (reason !== undefined && unclearable !== undefined) {
      throw unclearableField(
        `the focused <${focus ?? "element"}> ${unclearable}`,
        // One stage per reason, so the four are separable in telemetry — they
        // are four different app-side causes with four different repairs.
        `keyboard_clear_chromium_${reason.replace(/-/g, "_")}`
      );
    }
    // Caller input error → 400: the fix is a `gesture-tap` on the field, not a
    // retry of this call. The page is untouched either way — the script returns
    // before it selects anything, so no page-wide selection is left behind.
    // Same code and same repair for a document-wide editing host, which is a
    // clear that has not been aimed at a field yet.
    throw new InvalidToolInputError(
      (reason === "document-editable"
        ? "the whole document is editable here (`designMode` is on, or <body> carries " +
          "`contenteditable`) and keyboard focus is " +
          // Naming the focused element matters here: the editing host swallows
          // every descendant, so this refusal fires for a focused <button> or
          // link just as it does for <body> itself, and the two look nothing
          // alike from the caller's side.
          (focus ? `on <${focus}>, inside that editing host` : "on the host itself") +
          " rather than on a field, so clearing would have emptied the ENTIRE page"
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
  // Every accepted clear is read back — there is no path that reports `cleared`
  // on the delete's word alone, because `delete` answers true whether or not it
  // removed anything.
  const readback = (await evaluateClearStep(
    api,
    CLEAR_READBACK_SCRIPT,
    // Its own stage: here the delete has ALREADY been accepted, so the unknown
    // is what the field holds now, not whether anything happened.
    "keyboard_clear_chromium_readback_timeout"
  )) as ReadbackOutcome | null;
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
