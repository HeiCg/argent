import type { DeviceInfo, Registry } from "@argent/registry";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../../../blueprints/android-devtools";
import {
  attrIsTrue,
  parseUiAutomatorBounds,
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
 * search box costs 1.6-1.8 s unverified and 3.5-4.0 s verified. The FIRST typed
 * string on a device also pays for the helper itself — `adb install -t` of the
 * helper APK plus an `am instrument` spawn, bounded by that blueprint's 30 s ready
 * timeout, measured at 6.1 s including the install and 1.8 s when only the spawn
 * was needed. It is the same helper `describe` resolves, so an agent that has
 * described this device has already paid it. That is real
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
   * (the empty Settings search box reports `text="Search settings"`). So this is
   * not "the field's content" and the comparison cannot treat it as such — see
   * `classifyTypedText`, which accepts a hint baseline as a successful replace
   * and refuses to draw any conclusion when the two readings are ambiguous.
   */
  text: string;
  /**
   * Identity of the field, so focus moving to a DIFFERENT one between the two
   * reads is detectable — an auto-advancing form (an OTP code split across
   * boxes, a field that jumps on maxLength) does exactly that, and comparing
   * one field's baseline against another's text would then have the repair
   * retype into a field the caller never targeted.
   *
   * `resource-id` alone is not enough: it carries the React Native `testID`
   * (see `flows/flow-android-tree.ts`), so every untagged `TextInput` and
   * Compose `TextField` dumps `resource-id=""` and every one of them would look
   * like the same field. The bounds ORIGIN disambiguates them — distinct fields
   * sit at distinct positions — while surviving the growth that makes the full
   * bounds useless: typing into the Settings search box moved its right edge
   * from 1080 to 933 with the origin unchanged (measured, API 34). A field that
   * genuinely moves between the reads reads as a focus change, which only
   * declines the repair.
   */
  identity: string;
  /**
   * A password field's text is NOT masked in the dump — `uiautomator-parser.ts`
   * and `flows/flow-android-tree.ts` both redact it precisely because
   * `attrs.text` still holds the secret. That is the reason to skip
   * verification here rather than a reason it is impossible: reading a
   * credential back to compare it would put it one refactor away from the
   * result, and this tool's whole `{{secret:…}}` contract is that the plaintext
   * never travels back.
   */
  password: boolean;
}

/**
 * The focused editable view in a uiautomator-schema hierarchy, or null when
 * nothing editable holds input focus. Walked in document order so the first
 * match is the frontmost window's — a multi-window dump (see
 * `describe/platforms/android/index.ts`) can carry a stale `focused="true"` in a
 * background window behind the one actually taking input.
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
    const rect = parseUiAutomatorBounds(attrs.bounds ?? "");
    return {
      text: attrs.text ?? "",
      identity: [attrs["resource-id"] ?? "", className, rect ? `${rect.x},${rect.y}` : ""].join(
        "|"
      ),
      password: attrIsTrue(attrs, "password"),
    };
  }
  return null;
}

/**
 * What the before/after pair says about the injection.
 *
 * `indeterminate` is not hedging: two different events can leave the field in
 * byte-identical states, and acting on a guess is worse than saying so. Typing
 * "argent" into a `selectAllOnFocus` field that already reads "argent" succeeds
 * and changes nothing; typing it into the same field and having every key event
 * dropped also changes nothing. Retyping on that evidence enters the text twice.
 */
export type TypedTextVerdict = "landed" | "not-landed" | "indeterminate";

/**
 * Whether every character of `before` is still present in `after` as a single
 * run split by one inserted block — i.e. the prior content survived and this was
 * an insertion into it, not a replacement of it.
 */
function beforeSurvived(before: string, after: string): boolean {
  return (
    after.length >= before.length && coversByEdges(before, after, after.length - before.length)
  );
}

/**
 * Classify the injection from the field's text before and after it.
 *
 * Accepting shapes, each broken by a dropped keystroke:
 *
 *  - *inserted*: `text` appears contiguously and the field grew by exactly
 *    `text.length`. Holds wherever the cursor sat and whatever the field already
 *    contained. A dropped character breaks the contiguous-substring half; a
 *    doubled injection breaks the length half.
 *  - *replaced*: the field now holds precisely `text`, its content changed, and
 *    the prior content did NOT survive into it. That is the empty-field case —
 *    the baseline read was the hint (see `FocusedField.text`), which shares no
 *    prefix or suffix with the typed text, so the length arithmetic cannot apply
 *    — and equally a selection that `input text` replaced.
 *
 * Ambiguous shapes, reported as `indeterminate` and never repaired:
 *
 *  - The field did not change at all and already contains `text`: a correct type
 *    into a field that held the same value is indistinguishable from an injection
 *    that landed nothing.
 *  - The field now reads exactly `text` AND the prior content survived as edges:
 *    "abc" + a correct replacement by "abcdef" looks the same as "abc" plus a
 *    partial landing of "def" out of "abcdef".
 *
 * Known limitation, reported as `not-landed`: a selection that `input text`
 * replaced with a *shorter* string shrinks the field, which reads as a failure.
 * The undo declines that shape (see `plannedUndoDeletions`), so it costs a false
 * alarm in the note, never the field's content.
 */
export function classifyTypedText(before: string, after: string, text: string): TypedTextVerdict {
  if (after.includes(text) && after.length === before.length + text.length) return "landed";
  if (after === text && after !== before && !beforeSurvived(before, after)) return "landed";
  if (after === before && after.includes(text)) return "indeterminate";
  if (after === text && beforeSurvived(before, after)) return "indeterminate";
  return "not-landed";
}

/**
 * How many characters to delete to undo a failed injection, or null when no
 * deletion can be proven safe — in which case the field is left exactly as the
 * injection left it and the caller reports the failure instead of gambling with
 * the user's content.
 *
 * `input text` inserts at the cursor and advances it, and backspace deletes at
 * the cursor, so N backspaces remove exactly the N characters that landed —
 * wherever in the field the cursor sat, not only at the end. Verified on device
 * (Pixel 6 / API 34): with the cursor between the two characters of "ab",
 * injecting "XY" gives "aXYb", and two backspaces give "ab" back. The question
 * is therefore only how many of the characters present are ours. Two independent
 * proofs, the conservative one first:
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
 * Advisory prose for every outcome that needs a caveat. No note contains the
 * field's text, so a `keyboard` call that typed a resolved `{{secret:…}}` cannot
 * echo the plaintext back (`../index.ts` scrubs them as well, in case that ever
 * stops being true by construction). The character counts DO reveal the resolved
 * value's length — as `keys` already does for every secret type, verified or not
 * — so this bounds the leak at what the result already exposed, it does not
 * eliminate it.
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

// Same situation, but the capture hit its node cap, so "nothing had focus" is not
// a conclusion the read supports — a dense screen can truncate before the walk
// reaches the field. Saying "tap the field first" here would send the agent to
// re-tap a field that already had focus.
const TRUNCATED_READ_NOTE =
  `${UNVERIFIED_PREFIX}: the screen has more elements than one capture returns, so the read was ` +
  "truncated before any focused editable field was found. This says nothing about whether the " +
  "text landed — read the field with `describe` to confirm.";

const PASSWORD_FIELD_NOTE =
  `${UNVERIFIED_PREFIX}: the focused field is a password field, and reading it back would put the ` +
  "credential in this result — which is exactly what typing a `{{secret:…}}` placeholder exists to " +
  "avoid — so it is deliberately not read. Android typing can silently drop characters, so a " +
  "credential that fails to authenticate may simply have been typed incompletely: clear the field " +
  "and retype rather than assuming the credential is wrong.";

const READ_FAILED_NOTE =
  `${UNVERIFIED_PREFIX}: reading the focused field back failed. The text was typed, but Android ` +
  "typing can silently drop characters — confirm the field's contents with `describe`.";

// Distinct from a read failure: both reads succeeded and disagreed about WHICH
// field has focus. Telling the agent to hunt dropped characters would bury the
// actionable fact, which is that focus moved.
const FOCUS_MOVED_NOTE =
  `${UNVERIFIED_PREFIX}: input focus moved to a different field while the text was being typed, so ` +
  "the field it started in could not be checked and nothing was retyped. The text may have been " +
  "split across both fields. Read the screen with `describe` before continuing.";

// The observation is consistent with success AND with total failure (see
// `classifyTypedText`). Retyping here is what would double the text, so the only
// safe move is to say so.
const INDETERMINATE_NOTE =
  `${UNVERIFIED_PREFIX}: the field's contents are equally consistent with the text having landed ` +
  "and with it having been dropped — it either did not change at all and already matched, or it " +
  "now reads exactly as the typed text while its previous value could have been part of the " +
  "result. Nothing was retyped, because doing so on this evidence risks entering the text twice. " +
  "Read the field with `describe` to confirm.";

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
      : ", and the field could not be safely restored to retry, so nothing was retyped") +
    ". Either Android's key-event burst lost characters on a field that re-renders " +
    "per keystroke, or the field rejects or reformats what is typed into it (a " +
    "digits-only field, an input mask, a maxLength) — or the text replaced a " +
    "selection with a shorter value, which reads the same way. Read the field with " +
    "`describe` to see what it holds, then either type in shorter pieces or send a " +
    "value the field accepts."
  );
}

// The retry itself failed to reach the device. It runs backspaces before
// retyping, so the field can be left holding LESS than when the call started —
// the one path where that is possible, and it must be reported rather than
// swallowed into a generic transport error.
function repairFailedNote(expected: number): string {
  return (
    `The typed text did not land, and the retry could not be completed: the ${expected} ` +
    "characters were removed or partly removed before the retype failed to reach the device. " +
    "The field may now hold less than it did before this call. Read it with `describe` and " +
    "retype from a known state."
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
 *
 * `maxNodes` matches the flow tree's raised cap for the same reason it was
 * raised there: the helper's 5000 default truncates a dense screen mid-walk, and
 * a capture that stops before the focused field is reached is indistinguishable
 * from a screen with no focused field. `truncated` is returned so that case can
 * be reported as the unknown it is rather than as a diagnosis.
 */
const READ_MAX_NODES = 12_000;

async function readFocusedField(
  devtools: AndroidDevtoolsApi
): Promise<{ field: FocusedField | null; truncated: boolean }> {
  const { xml, truncated } = await devtools.getHierarchy({
    clearCache: true,
    maxNodes: READ_MAX_NODES,
  });
  return { field: findFocusedTextField(xml), truncated };
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
 * Never throws for a verification problem, including one raised by the retry
 * itself: by the time anything here can go wrong the original keystrokes are
 * already on the device, so a thrown error would tell the agent the typing failed
 * when it may well have succeeded. Every outcome comes back as `verified: true`,
 * `verified: false`, or an absent `verified` with a note explaining why the check
 * could not conclude. Errors from the injection the call is actually FOR still
 * propagate — a failed `input text` is a real failure, not a verification
 * problem.
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
  let beforeTruncated: boolean;
  try {
    ({ field: before, truncated: beforeTruncated } = await readFocusedField(devtools));
  } catch {
    await injectAndroidText(serial, text);
    return { note: READ_FAILED_NOTE };
  }
  if (!before) {
    await injectAndroidText(serial, text);
    return { note: beforeTruncated ? TRUNCATED_READ_NOTE : NO_FOCUSED_FIELD_NOTE };
  }
  if (before.password) {
    await injectAndroidText(serial, text);
    return { note: PASSWORD_FIELD_NOTE };
  }

  await injectAndroidText(serial, text);

  const after = await readAfter(devtools, before);
  if (after.blocked) return after.blocked;
  const verdict = classifyTypedText(before.text, after.field.text, text);
  if (verdict === "landed") return { verified: true };
  if (verdict === "indeterminate") return { note: INDETERMINATE_NOTE };

  const deletions = plannedUndoDeletions(before.text, after.field.text, text);
  if (deletions === null) {
    return { verified: false, note: mismatchNote(text.length, after.field.text.length, false) };
  }

  try {
    await deleteTrailing(serial, deletions);
    await injectInChunks(serial, text);
  } catch {
    // The undo runs before the retype, so a failure between them can leave the
    // field emptier than the call found it. Report that state instead of letting
    // an adb error imply nothing happened.
    return { verified: false, note: repairFailedNote(text.length) };
  }

  const repaired = await readAfter(devtools, before);
  if (repaired.blocked) return repaired.blocked;
  if (classifyTypedText(before.text, repaired.field.text, text) === "landed") {
    return { verified: true };
  }
  return { verified: false, note: mismatchNote(text.length, repaired.field.text.length, true) };
}

/**
 * Re-read the field the call started in, or the reason it cannot be compared:
 * the read failed, nothing editable has focus any more, or focus is on a
 * DIFFERENT field than the baseline (which makes both the comparison and a
 * deletion-based repair meaningless — see `FocusedField.identity`).
 */
async function readAfter(
  devtools: AndroidDevtoolsApi,
  before: FocusedField
): Promise<
  | { blocked?: undefined; field: FocusedField }
  | { blocked: KeyboardVerification; field?: undefined }
> {
  let field: FocusedField | null;
  try {
    ({ field } = await readFocusedField(devtools));
  } catch {
    return { blocked: { note: READ_FAILED_NOTE } };
  }
  if (!field || field.identity !== before.identity) {
    return { blocked: { note: FOCUS_MOVED_NOTE } };
  }
  return { field };
}
