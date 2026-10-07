import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import {
  IOS_CHROME_FREE_BAND,
  deviceProfilePlist,
  framebufferPxToPoints,
  framebufferScale,
  opticalRegion,
  opticalScrollPx,
  pngDimensions,
} from "../scripts/bench-ios-optical";
import { estimateScrollPx } from "../scripts/optical-scroll";

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

/**
 * Run 37572773799 (iOS-4 ticket 2): the optical metric read ±0.02 pt on every
 * arm while the saved shots show a large scroll. The scroll container (Settings'
 * Table) spans the whole screen on iOS 26, so the region was y 0..1: the status
 * bar, the nav bar and the bottom search field do not move and pinned the NCC
 * peak at 0. Fixtures: ON-siminput `swipe-0-before.png` / `swipe-0-after.png`
 * and `swipe-1-after.png` from the run's artifact (`swipe-1-before.png` is
 * byte-identical to `swipe-0-before.png`), 1206×2622 px, iPhone 17 at 3x.
 */
describe("bench-ios optical scroll on run 37572773799 shots (iOS-4 ticket 2)", () => {
  const FIX = path.join(__dirname, "fixtures", "ios-optical-run-37572773799");
  const before = readFileSync(path.join(FIX, "ON-siminput-swipe-0-before.png"));
  const after0 = readFileSync(path.join(FIX, "ON-siminput-swipe-0-after.png"));
  const after1 = readFileSync(path.join(FIX, "ON-siminput-swipe-1-after.png"));
  const FULL = { y1: 0, y2: 1 }; // what scrollRegion() returned in the run

  it("the old full-screen region reads ~0 on these frames (the bug)", () => {
    const old = estimateScrollPx(before, after0, {
      y0: FULL.y1,
      y1: FULL.y2,
      minConfidence: 0.6,
      maxShiftFrac: 0.9,
    });
    expect(Math.abs(old.offsetPx ?? Number.NaN)).toBeLessThan(1);
  });

  it("the region excludes the fixed chrome even when the scroll container is full-screen", () => {
    expect(opticalRegion(FULL)).toEqual(IOS_CHROME_FREE_BAND);
    expect(opticalRegion({ y1: 0.2, y2: 0.85 })).toEqual({ y1: 0.2, y2: 0.85 });
    // A container too thin once clipped falls back to the chrome-free band.
    expect(opticalRegion({ y1: 0.88, y2: 1 })).toEqual(IOS_CHROME_FREE_BAND);
  });

  it("measures the half-screen scroll: nonzero, content moved up (positive)", () => {
    const e = opticalScrollPx(before, after0, FULL);
    expect(e.refused).toBe(false);
    expect(e.confidence).toBeGreaterThan(0.9);
    expect(e.offsetPx!).toBeGreaterThan(1500);
    expect(e.offsetPx!).toBeLessThan(1700);
    // 3x device: about 528 pt.
    expect(e.offsetPx! / 3).toBeGreaterThan(500);
  });

  it("measures a scroll longer than the old minimum overlap allowed", () => {
    const e = opticalScrollPx(before, after1, FULL);
    expect(e.refused).toBe(false);
    expect(e.confidence).toBeGreaterThan(0.9);
    expect(e.offsetPx!).toBeGreaterThan(1650);
    expect(e.offsetPx!).toBeLessThan(1750);
  });

  it("keeps the sign: the reversed pair reads content moved down (negative)", () => {
    const e = opticalScrollPx(after0, before, FULL);
    expect(e.refused).toBe(false);
    expect(e.offsetPx!).toBeLessThan(-1500);
  });
});

describe("bench-ios raster scale from the device type profile (iOS-4 ticket 2)", () => {
  // The runner reported a 480 pt screen height in run 37572773799 (raster scale
  // 2622/480 = 5.463 on a 3x iPhone 17), so px→pt now uses the device type's
  // `mainScreenScale` from its CoreSimulator profile.
  const devicetypes = {
    devicetypes: [
      {
        identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        bundlePath: "/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone 17.simdevicetype",
      },
    ],
  };
  it("finds the profile plist of the device type", () => {
    expect(deviceProfilePlist(devicetypes, "com.apple.CoreSimulator.SimDeviceType.iPhone-17")).toBe(
      "/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone 17.simdevicetype/Contents/Resources/profile.plist"
    );
  });
  it("returns null for an unknown device type or malformed JSON", () => {
    expect(
      deviceProfilePlist(devicetypes, "com.apple.CoreSimulator.SimDeviceType.iPad")
    ).toBeNull();
    expect(deviceProfilePlist({}, "x")).toBeNull();
    expect(deviceProfilePlist(null, "x")).toBeNull();
  });
});
