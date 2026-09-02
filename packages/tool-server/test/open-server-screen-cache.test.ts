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
import { __resetOpenServerScreenSizeCache } from "../src/utils/open-server-input";
import {
  getCachedScreenSize,
  setCachedScreenSize,
  invalidateScreenSize,
} from "../src/utils/open-server-screen-cache";

const ANDROID_SERIAL = "emulator-5554";

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

describe("open-server screen-size cache (F21)", () => {
  it("a mid-session rotation refreshes the cached size, so pixels are correct after rotation", async () => {
    // Portrait first, then landscape (dims swapped, rotation 0 → 1).
    let call = 0;
    const openApi = {
      getScreenSize: vi.fn(async () => {
        call += 1;
        return call === 1
          ? { screenWidth: 1000, screenHeight: 2000, displayRotation: 0 }
          : { screenWidth: 2000, screenHeight: 1000, displayRotation: 1 };
      }),
      tapWithOutcome: vi.fn(async () => ({
        success: true,
        before: { version: 1, hash: "a", stateHash: "a" },
        after: { version: 1, hash: "a", stateHash: "a" },
        changed: false,
        newScreen: false,
        idleMs: 0,
      })),
    };
    const tool = makeTool(openApi);

    await tool.execute({}, { udid: ANDROID_SERIAL, x: 0.5, y: 0.5 });
    // Portrait: 0.5 * 1000 = 500, 0.5 * 2000 = 1000.
    expect(openApi.tapWithOutcome.mock.calls[0]!.slice(0, 2)).toEqual([500, 1000]);

    await tool.execute({}, { udid: ANDROID_SERIAL, x: 0.5, y: 0.5 });
    // Landscape: the cache must NOT reuse the portrait size — 0.5 * 2000 = 1000,
    // 0.5 * 1000 = 500. (The pre-fix bug converted against the stale portrait size.)
    expect(openApi.tapWithOutcome.mock.calls[1]!.slice(0, 2)).toEqual([1000, 500]);
  });

  it("reuses the cached size while the rotation is unchanged", async () => {
    // Same rotation both calls; the second reply's (bogus) dims must be ignored
    // in favour of the cached ones, proving the cache is consulted per rotation.
    let call = 0;
    const openApi = {
      getScreenSize: vi.fn(async () => {
        call += 1;
        return call === 1
          ? { screenWidth: 1000, screenHeight: 2000, displayRotation: 0 }
          : { screenWidth: 4444, screenHeight: 5555, displayRotation: 0 };
      }),
      tapWithOutcome: vi.fn(async () => ({
        success: true,
        before: { version: 1, hash: "a", stateHash: "a" },
        after: { version: 1, hash: "a", stateHash: "a" },
        changed: false,
        newScreen: false,
        idleMs: 0,
      })),
    };
    const tool = makeTool(openApi);

    await tool.execute({}, { udid: ANDROID_SERIAL, x: 0.5, y: 0.5 });
    await tool.execute({}, { udid: ANDROID_SERIAL, x: 0.5, y: 0.5 });
    expect(openApi.tapWithOutcome.mock.calls[0]!.slice(0, 2)).toEqual([500, 1000]);
    expect(openApi.tapWithOutcome.mock.calls[1]!.slice(0, 2)).toEqual([500, 1000]);
  });

  it("invalidateScreenSize (called on service dispose) clears the device entry", () => {
    setCachedScreenSize(ANDROID_SERIAL, { width: 1000, height: 2000, rotation: 0 });
    expect(getCachedScreenSize(ANDROID_SERIAL)).toEqual({
      width: 1000,
      height: 2000,
      rotation: 0,
    });
    invalidateScreenSize(ANDROID_SERIAL);
    expect(getCachedScreenSize(ANDROID_SERIAL)).toBeUndefined();
  });
});
