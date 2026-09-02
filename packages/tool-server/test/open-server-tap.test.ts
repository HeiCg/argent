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

import { createGestureTapTool } from "../src/tools/gesture-tap";
import { sendCommand } from "../src/utils/simulator-client";
import { __resetOpenServerScreenSizeCache } from "../src/utils/open-server-input";

const ANDROID_SERIAL = "emulator-5554";
const SCREEN = { width: 1000, height: 2000 };

function makeOpenApi() {
  return {
    getScreenSize: vi.fn(async () => ({
      screenWidth: SCREEN.width,
      screenHeight: SCREEN.height,
      displayRotation: 0,
    })),
    tap: vi.fn(async () => ({ success: true })),
  };
}

function makeTool(openApi: unknown) {
  const registry = {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("OpenDeviceServer:")) return openApi;
      throw new Error(`unexpected urn ${urn}`);
    }),
  } as never;
  return createGestureTapTool(registry);
}

beforeEach(() => {
  flagEnabledMock = (n) => n === "open-device-server";
  __resetOpenServerScreenSizeCache();
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("gesture-tap → open-device-server multi-tap timeline (F1/F8/F9)", () => {
  it("single tap: ONE tap RPC carrying holdMs (a real 50ms press), no gap", async () => {
    const openApi = makeOpenApi();
    const tool = makeTool(openApi);

    await tool.execute({}, { udid: ANDROID_SERIAL, x: 0.5, y: 0.5 });

    // One RPC, not a per-click host loop; server builds the DOWN@0/UP@holdMs pair.
    expect(openApi.tap).toHaveBeenCalledTimes(1);
    const [x, y, opts] = openApi.tap.mock.calls[0] as unknown as [
      number,
      number,
      { clickCount: number; holdMs: number; gapMs?: number },
    ];
    expect([x, y]).toEqual([500, 1000]);
    expect(opts.clickCount).toBe(1);
    expect(opts.holdMs).toBe(50);
    expect(opts.gapMs).toBeUndefined();
    expect(vi.mocked(sendCommand)).not.toHaveBeenCalled();
  });

  it("double tap: ONE tap RPC with clickCount 2 + the multi-tap gap, so the server builds the whole timeline", async () => {
    const openApi = makeOpenApi();
    const tool = makeTool(openApi);

    await tool.execute({}, { udid: ANDROID_SERIAL, x: 0.5, y: 0.5, clickCount: 2 });

    // Still ONE RPC — the four events (DOWN@0, UP@50, DOWN@150, UP@200) are built
    // server-side from these params, which a host-side loop of taps could not time.
    expect(openApi.tap).toHaveBeenCalledTimes(1);
    const [, , opts] = openApi.tap.mock.calls[0] as unknown as [
      number,
      number,
      { clickCount: number; holdMs: number; gapMs: number },
    ];
    expect(opts.clickCount).toBe(2);
    expect(opts.holdMs).toBe(50);
    expect(opts.gapMs).toBe(100);
  });
});
