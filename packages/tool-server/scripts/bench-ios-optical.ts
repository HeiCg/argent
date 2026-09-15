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
 */

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
