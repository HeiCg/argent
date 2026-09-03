/**
 * Per-device "clipboard unsupported" cache for the open-server paste path (R3,
 * phase 3e).
 *
 * On API 35 a background instrumentation's `ClipboardManager.setPrimaryClip` is
 * silently dropped, so the open `paste` tool's genuine-clipboard attempt
 * (`setClipboard` → KEYCODE_PASTE) never round-trips and it falls back to typing.
 * That failed `setClipboard` costs a full RPC on EVERY paste. Once a device has
 * reported the write does not round-trip, remember it for the rest of the server
 * session and skip straight to typing on subsequent pastes.
 *
 * Keyed by device id and invalidated on the open server's `dispose` (a new
 * `am instrument` session may run on a device where the clipboard behaves
 * differently — e.g. a different API level), mirroring the screen-geometry cache
 * (F21). Kept in its own module so the blueprint can invalidate an entry on
 * dispose without importing `open-server-input` (which imports the blueprint — a
 * cycle).
 */

const clipboardUnsupported = new Set<string>();

/** Whether this device has already proven `setClipboard` does not round-trip. */
export function isClipboardUnsupported(deviceId: string): boolean {
  return clipboardUnsupported.has(deviceId);
}

/** Record that `setClipboard` did not round-trip on this device. */
export function markClipboardUnsupported(deviceId: string): void {
  clipboardUnsupported.add(deviceId);
}

/** Drop a device's cached clipboard-support result — called on service dispose. */
export function invalidateClipboardSupport(deviceId: string): void {
  clipboardUnsupported.delete(deviceId);
}

/** Clear the whole cache — test-only seam. */
export function __resetOpenServerClipboardCache(): void {
  clipboardUnsupported.clear();
}
