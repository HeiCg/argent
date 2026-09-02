import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let flagEnabledMock: (name: string) => boolean;
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, isFlagEnabled: (name: string) => flagEnabledMock(name) };
});
vi.mock("../src/utils/gesture-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/gesture-utils")>();
  return { ...actual, sendTouchEvent: vi.fn(async () => {}) };
});

import { createGesturePinchTool } from "../src/tools/gesture-pinch";
import { __resetOpenServerScreenSizeCache } from "../src/utils/open-server-input";

const ANDROID_SERIAL = "emulator-5554";

function makeOpenApi() {
  return {
    getScreenSize: vi.fn(async () => ({
      screenWidth: 1000,
      screenHeight: 2000,
      displayRotation: 0,
    })),
    gesture: vi.fn(async () => ({ success: true })),
  };
}

function makeTool(openApi: unknown) {
  const registry = {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("OpenDeviceServer:")) return openApi;
      throw new Error(`unexpected urn ${urn}`);
    }),
  } as never;
  return createGesturePinchTool(registry);
}

beforeEach(() => {
  flagEnabledMock = (n) => n === "open-device-server";
  __resetOpenServerScreenSizeCache();
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("gesture-pinch → open-device-server honours the authored duration (F2)", () => {
  it("holds the full timeline (no 180ms cap) — the last frame's tMs equals durationMs", async () => {
    const openApi = makeOpenApi();
    const tool = makeTool(openApi);

    // 400ms would previously be compressed to the removed 180ms cap.
    await tool.execute(
      {},
      {
        udid: ANDROID_SERIAL,
        centerX: 0.5,
        centerY: 0.5,
        startDistance: 0.1,
        endDistance: 0.4,
        durationMs: 400,
      }
    );

    expect(openApi.gesture).toHaveBeenCalledTimes(1);
    const [pointers] = openApi.gesture.mock.calls[0] as unknown as [
      Array<{ points: Array<{ tMs: number }> }>,
    ];
    const lastTMs = pointers[0]!.points.at(-1)!.tMs;
    // steps = round(400/16) = 25 → last frame at 25*16 = 400ms, well past 180.
    expect(lastTMs).toBe(400);
    expect(lastTMs).toBeGreaterThan(180);
  });
});
