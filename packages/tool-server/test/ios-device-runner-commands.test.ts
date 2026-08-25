import { describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { getDescribeTapPoint } from "../src/tools/describe/contract";
import {
  captureSnapshot,
  getViewport,
  tapAt,
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

describe("tapAt wire shape", () => {
  it("keeps the single-tap request identical to the pre-numberOfTaps shape", async () => {
    const run = vi.fn().mockResolvedValue({});
    const api: IosDeviceRunnerApi = { udid: "00008110-000978540290401E", run };

    await tapAt(api, "com.example.app", { x: 195, y: 422 });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual({
      command: "tap",
      appBundleId: "com.example.app",
      x: 195,
      y: 422,
    });
  });

  it("carries a multi-tap as ONE command with numberOfTaps", async () => {
    const run = vi.fn().mockResolvedValue({});
    const api: IosDeviceRunnerApi = { udid: "00008110-000978540290401E", run };

    await tapAt(api, "com.example.app", { x: 10, y: 20 }, 3);

    // The runner owns the inter-tap timing; the client sends exactly one
    // command, never a per-tap round-trip.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual({
      command: "tap",
      appBundleId: "com.example.app",
      x: 10,
      y: 20,
      numberOfTaps: 3,
    });
  });

  it("normalizes an explicit numberOfTaps of 1 back to the legacy shape", async () => {
    const run = vi.fn().mockResolvedValue({});
    const api: IosDeviceRunnerApi = { udid: "00008110-000978540290401E", run };

    await tapAt(api, "com.example.app", { x: 1, y: 2 }, 1);

    expect(run.mock.calls[0][0]).toEqual({
      command: "tap",
      appBundleId: "com.example.app",
      x: 1,
      y: 2,
    });
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

  it("stamps the viewport-unavailable rejection with a failure signal", async () => {
    const run = vi.fn().mockResolvedValue({ x: 0, y: 0, width: 0, height: 0 });
    const api: IosDeviceRunnerApi = { udid: "00008110-000978540290401E", run };

    const error = await getViewport(api, "com.example.app").catch((caught: unknown) => caught);

    expect((error as Error).message).toContain("Bring the app to the foreground");
    // Telemetry classification (T44): a degenerate viewport is a per-request
    // rejection, not an unclassified infra fault.
    const signal = getFailureSignal(error);
    expect(signal?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
    expect(signal?.failure_stage).toBe("ios_device_viewport");
  });
});
