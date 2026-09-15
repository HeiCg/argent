import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import {
  framebufferPxToPoints,
  framebufferScale,
  pngDimensions,
} from "../scripts/bench-ios-optical";

/**
 * Unit tests for the iOS bench optical-metric unit conversion (IOS2-H5). The old
 * metric reported rows of a downscaled 160-px BMP and CALLED them pixels; the fix
 * reports the offset in SCREEN POINTS with the framebuffer→points scale stated.
 * These are pure host-side helpers (no simulator), so they run on any runner.
 */
describe("bench-ios optical unit conversion (IOS2-H5)", () => {
  it("framebufferScale is framebuffer pixels per screen point", () => {
    // A 3x device: 2556 px tall framebuffer over an 852 pt screen.
    expect(framebufferScale(2556, 852)).toBeCloseTo(3, 10);
    expect(framebufferScale(1200, 400)).toBeCloseTo(3, 10);
    expect(framebufferScale(800, 400)).toBeCloseTo(2, 10);
  });

  it("returns NaN for a degenerate scale", () => {
    expect(framebufferScale(0, 852)).toBeNaN();
    expect(framebufferScale(2556, 0)).toBeNaN();
    expect(framebufferPxToPoints(300, 0, 852)).toBeNaN();
    expect(framebufferPxToPoints(Number.NaN, 1200, 400)).toBeNaN();
  });

  it("converts a framebuffer-px offset to screen points by dividing out the scale", () => {
    // 600 px at 3x = 200 pt.
    expect(framebufferPxToPoints(600, 1200, 400)).toBeCloseTo(200, 10);
    // A real navigation swipe: ~38 px offset the iOS-2 review said was mislabelled
    // — at 3x that is ~12.7 pt, NOT "~38 px of screen".
    expect(framebufferPxToPoints(38, 2556, 852)).toBeCloseTo(38 / 3, 6);
    // A downward (negative) offset keeps its sign.
    expect(framebufferPxToPoints(-150, 900, 300)).toBeCloseTo(-50, 10);
  });

  it("scale × points round-trips the pixel offset", () => {
    const px = 471;
    const fb = 2556;
    const pts = 852;
    const asPoints = framebufferPxToPoints(px, fb, pts);
    expect(asPoints * framebufferScale(fb, pts)).toBeCloseTo(px, 6);
  });

  it("reads PNG dimensions from the IHDR", () => {
    const png = new PNG({ width: 1179, height: 2556 });
    const buf = PNG.sync.write(png);
    expect(pngDimensions(buf)).toEqual({ width: 1179, height: 2556 });
  });

  it("returns NaN dimensions for a non-PNG buffer", () => {
    const d = pngDimensions(Buffer.from("not a png at all............", "utf8"));
    expect(d.width).toBeNaN();
    expect(d.height).toBeNaN();
  });
});
