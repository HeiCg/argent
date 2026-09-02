/**
 * Per-device screen-geometry cache for the open-server gesture hot path (F21).
 *
 * The gesture tools convert normalized coordinates to pixels against the display
 * size. That size is stable within an orientation but changes on rotation, so the
 * cache is keyed by `(deviceId, displayRotation)`: every gesture peeks the cheap
 * `getScreenSize` RPC (display metrics only, ~1 ms even mid-animation, unlike the
 * ~400 ms `getInfo`) and, when the reported rotation no longer matches the cached
 * entry, refreshes the stored width/height. A mid-session rotation therefore
 * self-corrects instead of converting against the pre-rotation dimensions (the
 * bug this fixes: a landscape gesture landing at portrait pixels).
 *
 * Kept in its own module so the blueprint can invalidate an entry on `dispose`
 * without importing `open-server-input` (which imports the blueprint — a cycle).
 */

export interface CachedScreenSize {
  width: number;
  height: number;
  rotation: number;
}

const screenSizeCache = new Map<string, CachedScreenSize>();

/** Cached geometry for a device, or undefined if none is stored. */
export function getCachedScreenSize(deviceId: string): CachedScreenSize | undefined {
  return screenSizeCache.get(deviceId);
}

/** Store the geometry observed for a device at its current rotation. */
export function setCachedScreenSize(deviceId: string, size: CachedScreenSize): void {
  screenSizeCache.set(deviceId, size);
}

/** Drop a device's cached geometry — called on service dispose. */
export function invalidateScreenSize(deviceId: string): void {
  screenSizeCache.delete(deviceId);
}

/** Clear the whole cache — test-only seam. */
export function __resetOpenServerScreenSizeCache(): void {
  screenSizeCache.clear();
}
