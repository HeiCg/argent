import { describe, expect, it, vi } from "vitest";
import { getDescribeTapPoint } from "../src/tools/describe/contract";
import {
  captureSnapshot,
  getViewport,
  toPoints,
  type RunnerViewport,
} from "../src/utils/ios-device/runner-commands";
import type { IosDeviceRunnerApi } from "../src/blueprints/ios-device-runner";

const APP_FRAME: RunnerViewport = { x: 0, y: 0, width: 390, height: 844 };

describe("toPoints (physical iOS 0-1 contract)", () => {
  it("inverts describe's Application-frame normalization", () => {
    // A button at the bottom of the FULL app (where a CTA sits). Describe
    // reports 0-1 against this frame; the tap must land on the same point.
    const frame = {
      x: 16 / APP_FRAME.width,
      y: 760 / APP_FRAME.height,
      width: 358 / APP_FRAME.width,
      height: 52 / APP_FRAME.height,
    };
    const centre = getDescribeTapPoint(frame);
    const point = toPoints(APP_FRAME, centre.x, centre.y);
    expect(point.x).toBeCloseTo(16 + 358 / 2, 6);
    expect(point.y).toBeCloseTo(760 + 52 / 2, 6);
  });

  it("maps y=0.84 onto the full app, not a keyboard-trimmed band", () => {
    // The old viewport cut the keyboard off (~500pt usable). 0.84 of 500 is
    // ~420; 0.84 of 844 is ~709. Those are different pixels.
    const point = toPoints(APP_FRAME, 0.5, 0.84);
    expect(point.x).toBeCloseTo(195, 6);
    expect(point.y).toBeCloseTo(844 * 0.84, 6);
    expect(point.y).toBeGreaterThan(600);
  });

  it("keeps a non-zero Application origin (offset is applied once, in Swift)", () => {
    const inset: RunnerViewport = { x: 0, y: 20, width: 390, height: 824 };
    const point = toPoints(inset, 0.5, 0.5);
    expect(point).toEqual({ x: 195, y: 20 + 412 });
  });
});

describe("captureSnapshot single-flight", () => {
  it("coalesces identical concurrent requests onto one runner command", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => (release = resolve));
    const run = vi.fn().mockImplementation(() => gate);
    const api: IosDeviceRunnerApi = { udid: "00008110-000978540290401E", run };

    const first = captureSnapshot(api, "com.example.app");
    const second = captureSnapshot(api, "com.example.app");
    release({ nodes: [], quality: null });

    expect(await first).toEqual({ nodes: [], quality: null });
    expect(await second).toEqual({ nodes: [], quality: null });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps different bundle ids and sequential calls separate", async () => {
    const run = vi.fn().mockResolvedValue({ nodes: [], quality: null });
    const api: IosDeviceRunnerApi = { udid: "00008110-000978540290401E", run };

    await Promise.all([
      captureSnapshot(api, "com.example.app"),
      captureSnapshot(api, "com.example.other"),
    ]);
    await captureSnapshot(api, "com.example.app");

    expect(run).toHaveBeenCalledTimes(3);
  });
});

describe("getViewport", () => {
  it("reads the runner on every call (no stale keyboard/rotation cache)", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ x: 0, y: 0, width: 390, height: 844 })
      .mockResolvedValueOnce({ x: 0, y: 0, width: 844, height: 390 });
    const api: IosDeviceRunnerApi = { udid: "00008110-000978540290401E", run };

    const first = await getViewport(api, "com.example.app");
    const second = await getViewport(api, "com.example.app");

    expect(run).toHaveBeenCalledTimes(2);
    expect(first).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    expect(second).toEqual({ x: 0, y: 0, width: 844, height: 390 });
  });
});
