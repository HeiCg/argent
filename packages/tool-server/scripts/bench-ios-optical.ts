/**
 * Optical-metric unit helpers for the iOS bench (iOS-2.1, review IOS2-H5).
 *
 * The scroll offset is measured by {@link estimateScrollPx} (ticket 3o) on the
 * FULL-resolution simctl PNG framebuffer, so its result is in framebuffer PIXELS.
 * The runner reports the screen size in POINTS (`getScreenSize`). These pure
 * helpers convert between the two and expose the raster scale, so the bench can
 * publish the offset in screen POINTS with the scale stated (IOS2-H5 item 2: the
 * old metric reported downscaled-160-BMP rows and called them pixels). Kept in a
 * side-effect-free module so vitest can drive them without importing the bench
 * script (which throws at import when no simulator udid is set).
 *
 * iOS-4 ticket 2 (run 37572773799, dyPts ±0.02 on every arm while the saved
 * shots show a half-screen scroll): Settings' Table spans the whole screen on
 * iOS 26, so the region was y 0..1 and the static status bar, nav bar and bottom
 * search field pinned the NCC peak at 0. {@link opticalRegion} clips the region
 * to the chrome-free band, and {@link opticalScrollPx} scores shifts down to a
 * 10 % overlap so a scroll of up to ~90 % of the band (the ON arms flung ~1700 px
 * of a 2019 px band) is measurable. The runner also reported a 480 pt screen
 * height (scale 5.463 on a 3x device), so the raster scale comes from the device
 * type's CoreSimulator profile ({@link deviceProfilePlist}).
 */
import { estimateScrollPx, type ScrollEstimate } from "./optical-scroll";

/** Framebuffer pixels per screen point (≈ the device scale factor). */
export function framebufferScale(framebufferHeightPx: number, screenHeightPoints: number): number {
  if (!(framebufferHeightPx > 0) || !(screenHeightPoints > 0)) return NaN;
  return framebufferHeightPx / screenHeightPoints;
}

/**
 * Convert an optical offset from framebuffer pixels to screen POINTS. A positive
 * offset means the content moved by that many points along the scroll axis.
 */
export function framebufferPxToPoints(
  offsetPx: number,
  framebufferHeightPx: number,
  screenHeightPoints: number
): number {
  if (!Number.isFinite(offsetPx)) return NaN;
  const scale = framebufferScale(framebufferHeightPx, screenHeightPoints);
  if (!(scale > 0)) return NaN;
  return offsetPx / scale;
}

/** PNG width/height from the IHDR (bytes 16–24, big-endian); NaN on a bad header. */
export function pngDimensions(buf: Buffer): { width: number; height: number } {
  // 8-byte signature, then a length+"IHDR" chunk whose data starts at byte 16.
  if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") {
    return { width: NaN, height: NaN };
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** The rows of an iOS screenshot that scroll with the content: below the status
 * bar + collapsed nav bar (~0.12 on iPhone 17) and above the floating bottom
 * search field / tab bar (~0.91). Fractions of the framebuffer height. */
export const IOS_CHROME_FREE_BAND = { y1: 0.13, y2: 0.9 } as const;

/** Shortest region (fraction of height) worth correlating. */
const MIN_REGION = 0.2;

/** The optical region: the scroll container's span clipped to the chrome-free
 * band; the band itself when the clipped span is too thin to correlate. */
export function opticalRegion(scroll: { y1: number; y2: number }): { y1: number; y2: number } {
  const y1 = Math.max(scroll.y1, IOS_CHROME_FREE_BAND.y1);
  const y2 = Math.min(scroll.y2, IOS_CHROME_FREE_BAND.y2);
  if (!(y2 - y1 >= MIN_REGION)) return { ...IOS_CHROME_FREE_BAND };
  return { y1, y2 };
}

/** NCC options for the iOS bench: refuse below 0.6, shifts up to 0.9 of the
 * region, scored down to a 10 % overlap (the Android default is 20 %). */
export const IOS_OPTICAL_OPTIONS = {
  minConfidence: 0.6,
  maxShiftFrac: 0.9,
  minOverlapFrac: 0.1,
} as const;

/** Optical scroll offset in framebuffer px between two PNGs over
 * {@link opticalRegion}(scroll) — content moved up ⇒ positive. */
export function opticalScrollPx(
  before: Buffer,
  after: Buffer,
  scroll: { y1: number; y2: number }
): ScrollEstimate & { region: { y1: number; y2: number } } {
  const region = opticalRegion(scroll);
  const est = estimateScrollPx(before, after, {
    y0: region.y1,
    y1: region.y2,
    ...IOS_OPTICAL_OPTIONS,
  });
  return { ...est, region };
}

/**
 * The CoreSimulator profile plist of a device type, from `xcrun simctl list
 * devicetypes -j`. Its `mainScreenScale` is the framebuffer px per point. Null
 * when the device type is not listed or the JSON is not the expected shape.
 */
export function deviceProfilePlist(devicetypesJson: unknown, deviceTypeId: string): string | null {
  const list = (devicetypesJson as { devicetypes?: unknown } | null)?.devicetypes;
  if (!Array.isArray(list)) return null;
  const hit = list.find(
    (d): d is { identifier: string; bundlePath: string } =>
      typeof d === "object" &&
      d !== null &&
      (d as { identifier?: unknown }).identifier === deviceTypeId &&
      typeof (d as { bundlePath?: unknown }).bundlePath === "string"
  );
  return hit ? `${hit.bundlePath}/Contents/Resources/profile.plist` : null;
}
