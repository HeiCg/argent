import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";

// Flag forced ON: these tests drive the open iOS swipe path.
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, isFlagEnabled: (name: string) => name === "open-ios-device-server" };
});

import { iosOpenServerSwipe } from "../src/utils/ios-open-server-input";
import { resolveDevice } from "../src/utils/device-info";
import { createGestureSwipeTool } from "../src/tools/gesture-swipe";

/**
 * The open iOS runner turns `durationMs` into drag velocity. The host used to
 * send only `steps` (which XCUITest ignores), so every swipe ran at XCUITest's
 * default velocity whatever duration was asked for.
 */

const SIMULATOR_UDID = "00000000-0000-0000-0000-000000000000";

const calls: Array<{ args: number[]; opts: Record<string, unknown> }> = [];

const fakeRegistry = {
  resolveService: async () => ({
    getScreenSize: async () => ({ screenWidth: 400, screenHeight: 800, scale: 3 }),
    swipe: async (
      startX: number,
      startY: number,
      endX: number,
      endY: number,
      opts: Record<string, unknown> = {}
    ) => {
      calls.push({ args: [startX, startY, endX, endY], opts });
      return { success: true };
    },
  }),
} as unknown as Registry;

beforeEach(() => {
  calls.length = 0;
});

describe("iosOpenServerSwipe: durationMs reaches the runner", () => {
  it("sends durationMs in screen points space and no steps", async () => {
    await iosOpenServerSwipe(
      fakeRegistry,
      resolveDevice(SIMULATOR_UDID),
      0.5,
      0.75,
      0.5,
      0.25,
      900
    );

    expect(calls).toEqual([{ args: [200, 600, 200, 200], opts: { durationMs: 900 } }]);
  });

  it("adds holdEndMs only when it is positive", async () => {
    await iosOpenServerSwipe(fakeRegistry, resolveDevice(SIMULATOR_UDID), 0, 0, 1, 1, 300, 120);
    await iosOpenServerSwipe(fakeRegistry, resolveDevice(SIMULATOR_UDID), 0, 0, 1, 1, 300, 0);

    expect(calls.map((c) => c.opts)).toEqual([
      { durationMs: 300, holdEndMs: 120 },
      { durationMs: 300 },
    ]);
  });
});

describe("gesture-swipe on the open iOS path", () => {
  const tool = createGestureSwipeTool(fakeRegistry);
  const base = { udid: SIMULATOR_UDID, fromX: 0.5, fromY: 0.7, toX: 0.5, toY: 0.2 };

  it("a slow swipe and a fling carry different durations", async () => {
    await tool.execute({} as never, { ...base, durationMs: 1500 });
    await tool.execute({} as never, { ...base, durationMs: 80 });

    expect(calls.map((c) => c.opts.durationMs)).toEqual([1500, 80]);
    expect(calls.every((c) => !("steps" in c.opts))).toBe(true);
  });

  it("uses the tool's default duration when none is given", async () => {
    await tool.execute({} as never, base);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts.durationMs).toBe(300);
  });
});
