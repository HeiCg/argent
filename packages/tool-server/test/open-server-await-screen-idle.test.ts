import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let flagEnabledMock: (name: string) => boolean;
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, isFlagEnabled: (name: string) => flagEnabledMock(name) };
});
vi.mock("../src/utils/check-deps", () => ({
  ensureDeps: vi.fn(async () => {}),
  __primeDepCacheForTests: vi.fn(),
  __resetDepCacheForTests: vi.fn(),
}));
vi.mock("../src/utils/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/adb")>();
  return { ...actual, isAndroidTv: vi.fn(async () => false) };
});
vi.mock("../src/utils/ios-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ios-devices")>();
  return { ...actual, isTvOsSimulator: vi.fn(async () => false) };
});

import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";

const ANDROID_SERIAL = "emulator-5554";

const CONTENT = [
  { index: 1, className: "android.widget.Button", text: "OK", bounds: { x1: 0, y1: 0, x2: 100, y2: 50 } },
];
const INFO = {
  screenWidth: 1000,
  screenHeight: 2000,
  currentPackage: "",
  keyboardVisible: false,
  displayRotation: 0,
};
const stateReply = (tree: unknown[], version: number) => ({
  tree,
  info: INFO,
  screenshot: "",
  waitedMs: 0,
  captureMs: 0,
  version,
  hash: "h" + version,
  stateHash: "s" + version,
});

function makeTool(openApi: unknown) {
  const registry = {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("OpenDeviceServer:")) return openApi;
      throw new Error(`unexpected urn ${urn}`);
    }),
  } as never;
  return createAwaitScreenIdleTool(registry);
}

beforeEach(() => {
  flagEnabledMock = (n) => n === "open-device-server";
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("await-screen-idle → open-device-server awaitChange (Screen-graph Phase A)", () => {
  it("settles when content is present and awaitChange times out (no event)", async () => {
    const openApi = {
      getState: vi.fn(async () => stateReply(CONTENT, 5)),
      awaitChange: vi.fn(async () => ({
        version: 5,
        hash: "h5",
        stateHash: "s5",
        changed: false,
        timedOut: true,
      })),
    };
    const tool = makeTool(openApi);

    const result = await tool.execute(
      {},
      { udid: ANDROID_SERIAL, timeoutMs: 2000, minStableMs: 100 } as never
    );

    expect(result.settled).toBe(true);
    expect(openApi.awaitChange).toHaveBeenCalledTimes(1);
    // Waited on the stability window, from the version getState reported.
    expect(openApi.awaitChange).toHaveBeenCalledWith(
      expect.objectContaining({ fromVersion: 5, timeoutMs: 100 })
    );
  });

  it("keeps waiting while the screen keeps changing, then settles when it goes quiet", async () => {
    let awaitCalls = 0;
    const openApi = {
      getState: vi.fn(async () => stateReply(CONTENT, 10)),
      awaitChange: vi.fn(async () => {
        awaitCalls += 1;
        // First window: a change fired; second window: quiet → settled.
        return awaitCalls === 1
          ? { version: 11, hash: "h11", stateHash: "s11", changed: true, timedOut: false }
          : { version: 11, hash: "h11", stateHash: "s11", changed: false, timedOut: true };
      }),
    };
    const tool = makeTool(openApi);

    const result = await tool.execute(
      {},
      { udid: ANDROID_SERIAL, timeoutMs: 2000, minStableMs: 50 } as never
    );

    expect(result.settled).toBe(true);
    expect(openApi.awaitChange).toHaveBeenCalledTimes(2);
    expect(openApi.getState.mock.calls.length).toBeGreaterThanOrEqual(2); // initial + re-read after change
  });

  it("does not settle on a blank screen that never renders (awaitChange times out with no content)", async () => {
    const openApi = {
      getState: vi.fn(async () => stateReply([], 1)),
      awaitChange: vi.fn(async () => ({
        version: 1,
        hash: "h1",
        stateHash: "s1",
        changed: false,
        timedOut: true,
      })),
    };
    const tool = makeTool(openApi);

    const result = await tool.execute(
      {},
      { udid: ANDROID_SERIAL, timeoutMs: 300, minStableMs: 50 } as never
    );

    expect(result.settled).toBe(false);
  });
});
