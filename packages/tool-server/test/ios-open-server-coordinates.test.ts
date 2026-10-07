import { describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";
import type { IosOpenDeviceServerApi } from "../src/blueprints/ios-open-server";
import type { IosOpenServerNode } from "../src/utils/ios-open-server-client";
import {
  describeIosViaOpenServer,
  iosOpenServerSwipe,
  iosOpenServerTap,
} from "../src/utils/ios-open-server-input";
import { resolveDevice } from "../src/utils/device-info";

/**
 * Normalized 0–1 → screen POINTS in the open iOS tool layer, against the size the
 * runner reports. The runner reports the target app's point size (402×874 @3 on
 * an iPhone 17); run 37572773799's runner reported its own compatibility-mode
 * 480 pt height instead, so every converted point landed on the wrong row.
 */

const UDID = "DE624B9E-8175-406B-93D4-FC65B7FC39F3";
const IPHONE_17 = { screenWidth: 402, screenHeight: 874, scale: 3 };

function node(
  type: string,
  label: string,
  b: IosOpenServerNode["bounds"],
  children: IosOpenServerNode[] = []
): IosOpenServerNode {
  return {
    type,
    label,
    bounds: b,
    enabled: true,
    hittable: true,
    selected: false,
    focused: false,
    children,
  };
}

function fakeRunner(): IosOpenDeviceServerApi {
  const general = node("Cell", "General", { x1: 16, y1: 558, x2: 386, y2: 606 });
  return {
    isReady: () => true,
    getInfo: vi.fn(async () => ({
      bundleId: "com.apple.Preferences",
      orientation: "portrait",
      keyboardVisible: false,
      ...IPHONE_17,
      version: 0,
    })),
    getScreenSize: vi.fn(async () => ({ ...IPHONE_17 })),
    getNestedState: vi.fn(async () => ({
      tree: [node("Application", "Settings", { x1: 0, y1: 0, x2: 402, y2: 874 }, [general])],
      truncated: false,
      info: {
        bundleId: "com.apple.Preferences",
        orientation: "portrait",
        keyboardVisible: false,
        ...IPHONE_17,
      },
      version: 1,
      timings: { snapshotMs: 1, serializeMs: 1, encodeMs: 1, captureMs: 3 },
    })),
    tap: vi.fn(async () => ({ success: true, dropped: false, dropReporting: "unsupported" })),
    swipe: vi.fn(async () => ({ success: true })),
  } as unknown as IosOpenDeviceServerApi;
}

function stubRegistry(runner: IosOpenDeviceServerApi): Registry {
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("IosOpenDeviceServer:")) return runner;
      throw new Error(`unexpected service ${urn}`);
    }),
  } as unknown as Registry;
}

describe("open iOS tool layer: normalized → points against the runner's 402×874 @3", () => {
  it("tap converts against getScreenSize's point size", async () => {
    const runner = fakeRunner();
    await iosOpenServerTap(stubRegistry(runner), resolveDevice(UDID), 0.2516, 0.6656, 1);
    const [x, y, opts] = vi.mocked(runner.tap).mock.calls[0]!;
    expect(x).toBeCloseTo(0.2516 * 402, 6);
    expect(y).toBeCloseTo(0.6656 * 874, 6);
    // 581.7 pt: the General row (558–606), not the row a 480 pt height would hit.
    expect(y).toBeGreaterThan(558);
    expect(y).toBeLessThan(606);
    expect(opts).toEqual({});
  });

  it("clamps out-of-range normalized input to the screen edges", async () => {
    const runner = fakeRunner();
    await iosOpenServerTap(stubRegistry(runner), resolveDevice(UDID), 1.4, -0.2, 2);
    expect(vi.mocked(runner.tap).mock.calls[0]).toEqual([402, 0, { clickCount: 2 }]);
  });

  it("swipe converts both endpoints", async () => {
    const runner = fakeRunner();
    await iosOpenServerSwipe(stubRegistry(runner), resolveDevice(UDID), 0.5, 0.75, 0.5, 0.25, 250);
    const [fx, fy, tx, ty, opts] = vi.mocked(runner.swipe).mock.calls[0]!;
    expect([fx, fy, tx, ty]).toEqual([201, 655.5, 201, 218.5]);
    expect(opts).toEqual({ durationMs: 250 });
  });

  it("describe normalizes node bounds by the reported point size", async () => {
    const runner = fakeRunner();
    const { tree } = await describeIosViaOpenServer(stubRegistry(runner), resolveDevice(UDID));
    let general: { x: number; y: number; width: number; height: number } | undefined;
    const visit = (n: {
      label?: string;
      frame: { x: number; y: number; width: number; height: number };
      children?: unknown[];
    }): void => {
      if (n.label === "General") general = n.frame;
      for (const c of (n.children ?? []) as (typeof n)[]) visit(c);
    };
    visit(tree as Parameters<typeof visit>[0]);
    expect(general).toBeDefined();
    expect(general!.y).toBeCloseTo(558 / 874, 6);
    expect(general!.x).toBeCloseTo(16 / 402, 6);
  });
});
