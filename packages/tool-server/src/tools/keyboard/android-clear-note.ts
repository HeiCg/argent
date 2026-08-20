import type { AndroidClearOutcome } from "../../utils/android-input";
import type { SetTextReason } from "../../blueprints/android-devtools";

/**
 * Why the atomic accessibility replace did not run, on top of the reasons the
 * helper itself reports.
 *
 * - `helper_unavailable` — nothing was holding the devtools connection and it
 *   could not be started inside the attempt's budget.
 * - `helper_outdated` — the helper answering on this device predates `setText`.
 *   Reachable even with a current bundle: the process holding the connection is
 *   whatever started first, possibly from another argent install.
 * - `rpc_failed` — a round trip to the helper rejected: a severed socket, a
 *   helper that died after the service resolved, or one that stopped answering
 *   and hit the RPC client's own timeout.
 *
 * Not exported: it exists to give these three their own docblock, and the union
 * below is what every caller actually names.
 */
type AtomicClearSkip = "helper_unavailable" | "helper_outdated" | "rpc_failed";

export type AndroidClearSkipReason = AtomicClearSkip | SetTextReason;

const WHY: Record<AndroidClearSkipReason, string> = {
  helper_unavailable:
    "argent's Android devtools helper is not running on this device and could not be started",
  helper_outdated: "the devtools helper answering on this device is too old to know the method",
  rpc_failed: "the call to the devtools helper failed",
  no_focused_input: "the helper found no focused input field",
  not_editable: "the focused element is not an editable text field",
  action_refused: "the focused field refused the accessibility replace",
  action_threw: "the focused field went away while the replace was being applied",
  unverifiable: "the replace was applied but the field could not be read back to confirm it",
  value_mismatch: "the replace was applied but the field read back holding something else",
};

/**
 * What the caller says when the atomic write MAY ALREADY BE IN THE FIELD, so the
 * injected path that follows is a second write rather than the first.
 *
 * Decided from the helper's own `applied` flag rather than from the reason's
 * NAME. The two are the same for the reasons this build knows — `unverifiable`
 * and `value_mismatch` are exactly the pair the helper sets `applied` on — but
 * not for the two shapes that reach here from outside that table: a reply that
 * carries `applied: true` with no reason at all, and a reason from a helper
 * newer than this build. A name-keyed set answers "nothing was written" for
 * both, which is the one answer that must not be guessed.
 *
 * It also needs a SECOND write to exist. A clear-only call has none — the
 * fallback deletes — and the accepted replace wrote the empty string, so both
 * writes agree and there is nothing to double. Saying it anyway put "the
 * fallback's text added to it" on a call that carried no text.
 */
const DOUBLED =
  " The accessibility replace had already been ACCEPTED by the widget when this ran, so if it " +
  "landed after all, the field may now hold that value with the fallback's text added to it.";

/**
 * What the injected path did, and what it therefore cannot promise.
 *
 * Each arm names the WEAKNESS of that path rather than restating the mechanics:
 * the caller is being told this because the verified path did not run, so the
 * only useful content is what is now unverified and how it can be wrong.
 */
const WHAT: Record<AndroidClearOutcome["path"], string> = {
  "select-all":
    "the select-all chord followed by a delete. The field was read back afterwards and nothing " +
    "was left to remove — though a screen `uiautomator` cannot capture reads the same way as an " +
    "empty one",
  "select-all-kept":
    "the select-all chord alone, with the `text` replacing the selection so the field was never " +
    "observed empty mid-call. Nothing verified that the chord took: with text following there is " +
    "no residue to check, and a widget that swallows the chord (a Flutter `TextField` does) keeps " +
    "its whole value with the new text spliced in at the caret",
  "select-all-rescued":
    "the select-all chord, a delete, and then a backspace run over what the chord had failed to " +
    "select — the chord did NOT take on this field",
  "delete-run":
    "a backspace run, because this Android level has no `input keycombination`. That deletes " +
    "backwards from end-of-LINE, so a multi-line field keeps whatever sits below the caret",
};

const BLIND =
  " The field's length could not be read, so a fixed run of backspaces was sent instead of a " +
  "sized one; a longer field keeps its head.";

/**
 * The `note` an Android `keyboard` result carries when the atomic clear was not
 * the one that ran.
 *
 * Called only on that path, so it always returns a string; the backend omits the
 * field entirely when the atomic clear DID run. A verified replace has nothing
 * to warn about, and a note on every clear is a note nobody reads — which is
 * what makes its absence worth something.
 *
 * Deliberately never quotes the field's contents or its length. A `{{secret:…}}`
 * request is typed into the box that already holds a credential, and this string
 * travels into the agent's transcript and the tool-server's logs;
 * `redactSecretsFromError` substitutes the resolved value and could not redact a
 * count. Everything here is derived from WHICH path ran, never from what it read.
 */
export function androidClearNote(
  reason: AndroidClearSkipReason,
  outcome: AndroidClearOutcome,
  { applied = false, fallbackText = false }: { applied?: boolean; fallbackText?: boolean } = {}
): string {
  // `WHY` is keyed by a closed union, but the reason crosses an RPC boundary
  // from a helper that may be NEWER than this tool-server — a protocol-3 reason
  // this build has never heard of would otherwise render as literal
  // "(undefined)". The gate upstream only checks the helper is not too OLD.
  //
  // Own-property check, not `??`: `reason` is a free string off the wire, so an
  // inherited key resolves through `Object.prototype` and never reaches the
  // fallback — `constructor` rendered the whole native function into the note.
  // Same guard, for the same reason, as `resolveAndroidNamedKeycode`.
  const why = Object.hasOwn(WHY, reason)
    ? WHY[reason]
    : "the helper declined it for a reason this version does not recognise";
  return (
    `keyboard clear: the atomic accessibility replace was not used (${why}), so the ` +
    `field was cleared with ${WHAT[outcome.path]}.` +
    (outcome.blindDeleteRun ? BLIND : "") +
    (applied && fallbackText ? DOUBLED : "") +
    ` Read the field back if the exact value matters.`
  );
}
