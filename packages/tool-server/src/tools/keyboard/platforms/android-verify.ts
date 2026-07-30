import type { DeviceInfo, Registry } from "@argent/registry";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../../../blueprints/android-devtools";
import {
  attrIsTrue,
  parseUiAutomatorXml,
} from "../../describe/platforms/android/uiautomator-parser";
import {
  injectAndroidKeycodeRepeated,
  injectAndroidText,
  ANDROID_NAMED_KEYCODES,
} from "../../../utils/android-input";
import type { KeyboardVerification } from "../types";

/**
 * Read-back verification for the Android phone / tablet typing path.
 *
 * `adb shell input text` converts the string to KeyEvents through the virtual
 * KeyCharacterMap and injects them back-to-back with no cadence. A field whose
 * owner re-renders per keystroke — a controlled React Native `TextInput`, a
 * search box that re-queries on every change — drops events out of that burst,
 * and the transport gives no signal that it happened: `adb` exits 0 having
 * "typed" the whole string. Reproduced on a Pixel 6 / API 34 emulator against
 * the Settings search box: one `input text` of a 76-character sentence landed
 * 45 characters ("The quick brown fox jumps over the lazy dog. ") and the tool
 * reported full success. The same sentence injected in 8-character chunks
 * landed all 76.
 *
 * So the only way to know what a `keyboard` call actually did is to look: read
 * the focused field before injecting, read it again after, and compare. Only
 * this backend needs it — the iOS / Chromium / Vega transports do not
 * synthesise a KeyEvent burst through a KeyCharacterMap and are not exposed to
 * this failure.
 *
 * Cost, and why it is not gated on anything: two `getHierarchy` calls over the
 * helper's already-open socket, each a 500 ms settle plus the tree walk. Measured
 * on the same emulator, screen and string, typing 76 characters into the Settings
 * search box costs 1.6-1.8 s unverified and 3.5-4.0 s verified. That is real
 * latency on a hot path (the flow `type` directive routes through this tool), and
 * it is still the right default, because the corruption is a property of the
 * *field*, not of the text: QA saw one sentence land perfectly in one field and
 * corrupt in another on the same screen at the same moment, and a field that
 * re-renders per keystroke can lose a single character. A length threshold or an
 * opt-in flag would make the guarantee depend on a magic number and leave the
 * silent-success bug reachable on everything under it. What IS gated is the
 * transport: when the android-devtools helper cannot be resolved, the only
 * remaining read-back is `uiautomator dump`, a fresh shell-out with no
 * persistent connection to amortise — so verification is skipped and said to be
 * skipped, rather than charging a locked-down device (exactly the device where
 * `adb install -t` is blocked) two dumps per typed string.
 *
 * The settle is deliberately kept on both reads. Dropping it from the "before"
 * read would save 500 ms, but that read runs right after the agent's own tap on
 * the field, and reading before the framework has published `focused="true"`
 * turns a healthy call into a spurious "no editable field had focus" note.
 */

/**
 * Classes whose focused instance receives the KeyEvents `input text` generates.
 * `EditText` covers React Native `TextInput`, Compose `TextField` (the
 * semantics delegate reports `android.widget.EditText`) and WebView inputs;
 * `AutoComplete` catches the `EditText` subclasses whose simple name does not
 * contain "EditText" (`AutoCompleteTextView`, `SearchView$SearchAutoComplete`).
 *
 * Broader than the `/EditText/` probe in `blueprints/android-tv-control.ts`
 * deliberately: there the verdict only labels an element `textfield` for the
 * agent to read, while here it decides whether a correctness check runs at all,
 * so a missed subclass would silently disable verification.
 */
const EDITABLE_CLASS_RE = /EditText|AutoComplete/;

// Derived from the shared keycode map rather than re-hardcoded, so the undo
// deletes with the same key the tool's own `key: "backspace"` presses.
const KEYCODE_BACKSPACE = ANDROID_NAMED_KEYCODES.backspace;

/**
 * Re-injection cadence for the repair. Empirically the whole point: 8-character
 * chunks with a pause between them landed a 76-character sentence in full on a
 * field where a single `input text` call landed 45 characters. The dominant gap
 * is actually the per-call `app_process` spawn `input` pays (~200-400 ms); the
 * explicit delay makes the cadence independent of how fast adb happens to be.
 */
const REPAIR_CHUNK_CHARS = 8;
const REPAIR_CHUNK_DELAY_MS = 100;

/**
 * `input keyevent` accepts several keycodes per call and injects them from one
 * `app_process` boot, so the undo runs as a handful of calls instead of one per
 * character. Capped so the device-side command line stays short.
 */
const DELETE_KEYCODES_PER_CALL = 64;

interface FocusedField {
  /**
   * The field's `text` as the accessibility tree reports it. NOTE: for an empty
   * `EditText` with a hint this is the HINT, not "" — `TextView`'s
   * `getTextForAccessibility()` falls back to the hint, confirmed on API 34
   * (the empty Settings search box reports `text="Search settings"`). The
   * comparison and repair below are written so that reading a hint as the
   * baseline can neither pass a corrupt result nor delete real content.
   */
  text: string;
  /**
   * `resource-id` + class — enough to notice focus moving to a different field
   * between the two reads (typing that triggers navigation), which makes the
   * before/after comparison meaningless.
   */
  identity: string;
  /** uiautomator masks a password field's contents, so it can never be read back. */
  password: boolean;
}

/**
 * The focused editable view in a uiautomator-schema hierarchy, or null when
 * nothing editable holds input focus. Document order, first match wins —
 * exactly one view holds input focus per window.
 */
export function findFocusedTextField(xml: string): FocusedField | null {
  const root = parseUiAutomatorXml(xml);
  if (!root) return null;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    // Push children in reverse so they pop back in document order.
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
    const attrs = node.attrs;
    if (!attrIsTrue(attrs, "focused")) continue;
    const className = attrs.class ?? "";
    if (!EDITABLE_CLASS_RE.test(className)) continue;
    return {
      text: attrs.text ?? "",
      identity: `${attrs["resource-id"] ?? ""}|${className}`,
      password: attrIsTrue(attrs, "password"),
    };
  }
  return null;
}

/**
 * Whether the field now holds the text we asked to type.
 *
 * Two accepting shapes, both of which a dropped keystroke breaks:
 *
 *  - *inserted*: `text` appears contiguously and the field grew by exactly
 *    `text.length`. Holds wherever the cursor sat and whatever the field already
 *    contained. A dropped character breaks the contiguous-substring half; a
 *    doubled injection breaks the length half.
 *  - *replaced*: the field now holds precisely `text` and its content changed.
 *    This is the empty-field case — the baseline read was the hint (see
 *    `FocusedField.text`), so the length arithmetic does not apply — and equally
 *    the case where the field's content was selected and `input text` replaced
 *    it. Requiring `after !== before` is load-bearing: without it, typing a
 *    string into a field that ALREADY held exactly that string would report
 *    success for an injection that landed nothing.
 */
export function typedTextLanded(before: string, after: string, text: string): boolean {
  const inserted = after.includes(text) && after.length === before.length + text.length;
  const replaced = after === text && after !== before;
  return inserted || replaced;
}

/**
 * How many trailing characters to delete to undo a failed injection, or null
 * when no deletion can be proven safe — in which case the field is left exactly
 * as the injection left it and the caller reports the failure instead of
 * gambling with the user's content.
 *
 * `input text` inserts at the cursor and advances it, so whatever landed sits
 * immediately before the cursor and N backspaces remove the last N characters.
 * The question is only how many of those are ours. Two independent proofs, the
 * conservative one first:
 *
 *  A. The field grew by `added` characters and `before` is recoverable from
 *     `after` by deleting one contiguous run of `added` characters (the common
 *     prefix and common suffix together cover `before`). Then `added`
 *     backspaces restore `before` exactly. Preferred, because it never deletes
 *     more than the observed growth and so cannot eat pre-existing content.
 *  B. Every character in the field is accounted for by this injection: `after`
 *     is a subsequence of `text`. Dropped-keystroke corruption only ever
 *     deletes events, never reorders or invents them, so a field holding only a
 *     subsequence of what we just typed held nothing before it — the baseline
 *     read was a hint. Then `after.length` backspaces empty the field, which is
 *     its true prior state. This is the shape the reported bug takes, and A
 *     cannot cover it: a hint shares no prefix or suffix with the typed text.
 *
 * B is only consulted when A fails, i.e. when `before` did not survive into
 * `after` at all. Both proofs bound the count by `text.length` — we can never
 * have added more characters than we asked to type — which is asserted rather
 * than assumed.
 */
export function plannedUndoDeletions(before: string, after: string, text: string): number | null {
  const added = after.length - before.length;
  if (added >= 0 && coversByEdges(before, after, added)) {
    return added <= text.length ? added : null;
  }
  if (isSubsequence(after, text)) return after.length;
  return null;
}

/**
 * Whether deleting one contiguous run of `gap` characters from `long` yields
 * `short`. Equivalent to the common prefix and common suffix of the two strings
 * together spanning `short`, which is the standard single-block-insertion test.
 */
function coversByEdges(short: string, long: string, gap: number): boolean {
  if (long.length !== short.length + gap) return false;
  let prefix = 0;
  while (prefix < short.length && short[prefix] === long[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < short.length - prefix &&
    short[short.length - 1 - suffix] === long[long.length - 1 - suffix]
  ) {
    suffix++;
  }
  return prefix + suffix >= short.length;
}

/** Whether `candidate` can be obtained from `source` by deleting characters only. */
function isSubsequence(candidate: string, source: string): boolean {
  let i = 0;
  for (const char of source) {
    if (i < candidate.length && candidate[i] === char) i++;
  }
  return i === candidate.length;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Re-inject `text` in small chunks — a different cadence, not a blind repeat. */
async function injectInChunks(serial: string, text: string): Promise<void> {
  for (let i = 0; i < text.length; i += REPAIR_CHUNK_CHARS) {
    if (i > 0) await sleep(REPAIR_CHUNK_DELAY_MS);
    await injectAndroidText(serial, text.slice(i, i + REPAIR_CHUNK_CHARS));
  }
}

async function deleteTrailing(serial: string, count: number): Promise<void> {
  for (let remaining = count; remaining > 0; remaining -= DELETE_KEYCODES_PER_CALL) {
    await injectAndroidKeycodeRepeated(
      serial,
      KEYCODE_BACKSPACE,
      Math.min(remaining, DELETE_KEYCODES_PER_CALL)
    );
  }
}

/**
 * Advisory prose for the cases where the read-back could not run. Every note is
 * value-free by construction — structural facts and character counts only,
 * never the field's contents — so a `keyboard` call that typed a resolved
 * `{{secret:…}}` cannot echo the plaintext back through the result. See
 * `../index.ts`, which additionally scrubs the note on the secret-bearing path.
 */
const UNVERIFIED_PREFIX = "The typed text was not verified against the screen";

const HELPER_UNAVAILABLE_NOTE =
  `${UNVERIFIED_PREFIX}: the android-devtools helper is not available on this device, and the ` +
  "only other way to read the field back is a full `uiautomator dump` per call. Android typing " +
  "can silently drop characters on a field that re-renders per keystroke, so confirm the field's " +
  "contents with `describe` before relying on them.";

const NO_FOCUSED_FIELD_NOTE =
  `${UNVERIFIED_PREFIX}: no editable field held input focus, so there was nothing to read back — ` +
  "the characters may have gone nowhere. Tap the field first (or check `describe` for a focused " +
  "text field), then type.";

const PASSWORD_FIELD_NOTE =
  `${UNVERIFIED_PREFIX}: the focused field is a password field, whose contents the accessibility ` +
  "tree masks. Android typing can silently drop characters, so a credential that fails to " +
  "authenticate may simply have been typed incompletely — clear the field and retype rather than " +
  "assuming the credential is wrong.";

const READ_FAILED_NOTE =
  `${UNVERIFIED_PREFIX}: reading the focused field back failed. The text was typed, but Android ` +
  "typing can silently drop characters — confirm the field's contents with `describe`.";

/**
 * Two causes produce this, and the read-back cannot tell them apart, so the note
 * names both rather than asserting the likelier one: the key-event burst lost
 * characters on a field that re-renders per keystroke, or the field itself
 * rejected or reformatted what arrived (a digits-only field, an input mask, a
 * maxLength — the dialer's number field silently drops every letter typed into
 * it). Retyping in chunks fixes the first and cannot fix the second, which is why
 * the advice covers both.
 */
function mismatchNote(expected: number, actual: number, repaired: boolean): string {
  return (
    "The typed text did NOT land in the focused field: it holds " +
    `${actual} character${actual === 1 ? "" : "s"} where ${expected} ` +
    `${expected === 1 ? "was" : "were"} expected` +
    (repaired
      ? ", and retyping it in smaller chunks did not fix it either"
      : ", and the field could not be safely restored to retry") +
    ". Either Android's key-event burst lost characters on a field that re-renders " +
    "per keystroke, or the field rejects or reformats what is typed into it (a " +
    "digits-only field, an input mask, a maxLength). Read the field with `describe` " +
    "to see what it holds, then either type in shorter pieces or send a value the " +
    "field accepts."
  );
}

async function resolveDevtools(
  registry: Registry,
  device: DeviceInfo
): Promise<AndroidDevtoolsApi | null> {
  try {
    const ref = androidDevtoolsRef(device);
    return await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
  } catch (err) {
    // Every failure here is recoverable by degrading to an unverified type: the
    // helper needs `adb install -t`, which locked-down devices refuse. Surface it
    // at debug level, the way the describe adapter does for the same fallback.
    console.debug(
      `[keyboard.android] devtools unavailable, typing without read-back verification: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

/**
 * `clearCache: true` is mandatory. The helper holds one long-lived
 * UiAutomation connection whose `AccessibilityNodeInfo` cache serves stale text
 * — the exact reason `flows/flow-android-tree.ts` passes it as well. Without it
 * the "after" read can return the pre-typing value and the verification would be
 * theatre.
 */
function readFocusedField(devtools: AndroidDevtoolsApi): Promise<FocusedField | null> {
  return devtools.getHierarchy({ clearCache: true }).then(({ xml }) => findFocusedTextField(xml));
}

/**
 * Type `text` into the focused field and prove it landed.
 *
 * Injects exactly once on every path — the text is typed whether or not it can
 * be verified — plus at most one chunked re-injection when the first attempt is
 * caught having dropped characters. Two attempts total: each one costs a
 * hierarchy read, and a field that drops events under both a single burst and a
 * slow chunked cadence is not failing for cadence reasons (an input mask,
 * autocorrect, a maxLength, a field rejecting characters), so a third identical
 * retry would only add latency to the same wrong answer.
 *
 * Never throws for a verification problem: by the time anything can go wrong the
 * keystrokes are already on the device, so a thrown error would tell the agent
 * the typing failed when it may well have succeeded. Failures come back as
 * `verified: false` or as an absent `verified` with a note.
 */
export async function typeAndroidTextVerified(
  registry: Registry,
  device: DeviceInfo,
  text: string
): Promise<KeyboardVerification> {
  const serial = device.id;
  const devtools = await resolveDevtools(registry, device);
  if (!devtools) {
    await injectAndroidText(serial, text);
    return { note: HELPER_UNAVAILABLE_NOTE };
  }

  let before: FocusedField | null;
  try {
    before = await readFocusedField(devtools);
  } catch {
    await injectAndroidText(serial, text);
    return { note: READ_FAILED_NOTE };
  }
  if (!before) {
    await injectAndroidText(serial, text);
    return { note: NO_FOCUSED_FIELD_NOTE };
  }
  if (before.password) {
    await injectAndroidText(serial, text);
    return { note: PASSWORD_FIELD_NOTE };
  }

  await injectAndroidText(serial, text);

  let after: FocusedField | null;
  try {
    after = await readFocusedField(devtools);
  } catch {
    return { note: READ_FAILED_NOTE };
  }
  // Focus moved (or the field vanished) while typing — most likely the text
  // triggered navigation. The baseline no longer describes the same field, so
  // neither the comparison nor a deletion-based repair means anything.
  if (!after || after.identity !== before.identity) return { note: READ_FAILED_NOTE };
  if (typedTextLanded(before.text, after.text, text)) return { verified: true };

  const deletions = plannedUndoDeletions(before.text, after.text, text);
  if (deletions === null) {
    return { verified: false, note: mismatchNote(text.length, after.text.length, false) };
  }

  await deleteTrailing(serial, deletions);
  await injectInChunks(serial, text);

  let repaired: FocusedField | null;
  try {
    repaired = await readFocusedField(devtools);
  } catch {
    return { note: READ_FAILED_NOTE };
  }
  if (!repaired || repaired.identity !== before.identity) return { note: READ_FAILED_NOTE };
  if (typedTextLanded(before.text, repaired.text, text)) return { verified: true };
  return { verified: false, note: mismatchNote(text.length, repaired.text.length, true) };
}
