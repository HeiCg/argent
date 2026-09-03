/**
 * Per-device "clipboard unsupported" cache for the open-server paste path (R3,
 * phase 3e; hardened phase 3g).
 *
 * On API 35 a background instrumentation's `ClipboardManager.setPrimaryClip` is
 * silently dropped, so the open `paste` tool's genuine-clipboard attempt
 * (`setClipboard` → KEYCODE_PASTE) never round-trips and it falls back to typing.
 * That failed `setClipboard` costs a full RPC on EVERY paste. Once a device has
 * reported the write does not round-trip, remember it for the rest of the server
 * session and skip straight to typing on subsequent pastes.
 *
 * The phase-3e bug this fixes: the on-device handler swallowed a transient
 * EXCEPTION into `ok=false`, so a single Looper hiccup or a momentary
 * SecurityException (another app owning the primary clip) permanently marked the
 * device "clipboard unsupported" for the session. Phase 3g distinguishes the two:
 *
 * - `"ok"` — the write round-tripped; reset the counter (the clipboard works).
 * - `"transient"` — a `false` that carried an on-device `error`; a blip, NOT
 *   proof the clipboard is unsupported. Reset the counter; never mark.
 * - `"definitive-false"` — a `false` with no error (the API-level silent drop).
 *   Only these count, and only after TWO CONSECUTIVE ones is the device marked
 *   unsupported, so a lone definitive false still gets a second chance.
 *
 * Keyed by device id and invalidated on the open server's `dispose` (a new
 * `am instrument` session may run on a device where the clipboard behaves
 * differently — e.g. a different API level), mirroring the screen-geometry cache
 * (F21). Kept in its own module so the blueprint can invalidate an entry on
 * dispose without importing `open-server-input` (which imports the blueprint — a
 * cycle).
 */

/** Consecutive definitive falses required before a device is marked unsupported. */
const DEFINITIVE_FALSES_TO_MARK = 2;

const clipboardUnsupported = new Set<string>();
const consecutiveDefiniteFalses = new Map<string, number>();

/** Outcome of one on-device `setClipboard` attempt. */
export type ClipboardOutcome = "ok" | "transient" | "definitive-false";

/** Whether this device has already proven `setClipboard` does not round-trip. */
export function isClipboardUnsupported(deviceId: string): boolean {
  return clipboardUnsupported.has(deviceId);
}

/**
 * Fold one `setClipboard` outcome into the per-device cache and return whether the
 * device is now considered clipboard-unsupported. A success or a transient
 * (error-carrying) false resets the run; only a run of [DEFINITIVE_FALSES_TO_MARK]
 * consecutive definitive falses marks the device.
 */
export function recordClipboardOutcome(deviceId: string, outcome: ClipboardOutcome): boolean {
  if (outcome === "ok" || outcome === "transient") {
    consecutiveDefiniteFalses.delete(deviceId);
    return clipboardUnsupported.has(deviceId);
  }
  const next = (consecutiveDefiniteFalses.get(deviceId) ?? 0) + 1;
  if (next >= DEFINITIVE_FALSES_TO_MARK) {
    consecutiveDefiniteFalses.delete(deviceId);
    clipboardUnsupported.add(deviceId);
    return true;
  }
  consecutiveDefiniteFalses.set(deviceId, next);
  return false;
}

/**
 * Record that `setClipboard` did not round-trip on this device. Retained for
 * back-compat; prefer [recordClipboardOutcome], which enforces the transient /
 * two-consecutive rule. This marks immediately.
 */
export function markClipboardUnsupported(deviceId: string): void {
  consecutiveDefiniteFalses.delete(deviceId);
  clipboardUnsupported.add(deviceId);
}

/** Drop a device's cached clipboard-support result — called on service dispose. */
export function invalidateClipboardSupport(deviceId: string): void {
  clipboardUnsupported.delete(deviceId);
  consecutiveDefiniteFalses.delete(deviceId);
}

/** Clear the whole cache — test-only seam. */
export function __resetOpenServerClipboardCache(): void {
  clipboardUnsupported.clear();
  consecutiveDefiniteFalses.clear();
}
