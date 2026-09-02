import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let flagEnabledMock: (name: string) => boolean;
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, isFlagEnabled: (name: string) => flagEnabledMock(name) };
});
vi.mock("../src/utils/simulator-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/simulator-client")>();
  return { ...actual, sendCommand: vi.fn(async () => {}) };
});

import { createGestureSwipeTool } from "../src/tools/gesture-swipe";

const ANDROID_SERIAL = "emulator-5554";

function makeOpenApi() {
  return {
    getInfo: vi.fn(async () => ({
      screenWidth: 1000,
      screenHeight: 2000,
      currentPackage: "",
      keyboardVisible: false,
      displayRotation: 0,
    })),
    swipe: vi.fn(async () => ({ success: true })),
  };
}

function makeTool(openApi: unknown) {
  const registry = {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("OpenDeviceServer:")) return openApi;
      throw new Error(`unexpected urn ${urn}`);
    }),
  } as never;
  return createGestureSwipeTool(registry);
}

const base = { udid: ANDROID_SERIAL, fromX: 0.5, fromY: 0.7, toX: 0.5, toY: 0.2, durationMs: 160 };

beforeEach(() => {
  flagEnabledMock = (n) => n === "open-device-server";
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("gesture-swipe momentum → open-device-server holdEndMs (T7)", () => {
  it("a plain swipe passes no holdEndMs (the lift keeps its fling)", async () => {
    const openApi = makeOpenApi();
    const tool = makeTool(openApi);

    await tool.execute({}, base);

    expect(openApi.swipe).toHaveBeenCalledTimes(1);
    // startX,startY,endX,endY,steps,holdEndMs — 500,1400,500,400,10,undefined
    expect(openApi.swipe).toHaveBeenCalledWith(500, 1400, 500, 400, 10, undefined);
  });

  it("momentum: false passes holdEndMs so the server holds before the lift", async () => {
    const openApi = makeOpenApi();
    const tool = makeTool(openApi);

    await tool.execute({}, { ...base, momentum: false });

    expect(openApi.swipe).toHaveBeenCalledTimes(1);
    const args = openApi.swipe.mock.calls[0] as unknown[];
    expect(args.slice(0, 5)).toEqual([500, 1400, 500, 400, 10]);
    expect(args[5]).toBeGreaterThan(0);
  });
});
