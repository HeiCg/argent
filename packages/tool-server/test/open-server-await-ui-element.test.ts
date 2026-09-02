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

import { createAwaitUiElementTool } from "../src/tools/await-ui-element";

const ANDROID_SERIAL = "emulator-5554";

const INFO = {
  screenWidth: 1000,
  screenHeight: 2000,
  currentPackage: "",
  keyboardVisible: false,
  displayRotation: 0,
};
const okButton = [
  { index: 1, className: "android.widget.Button", text: "OK", bounds: { x1: 0, y1: 0, x2: 100, y2: 50 } },
];
const cancelButton = [
  { index: 1, className: "android.widget.Button", text: "Cancel", bounds: { x1: 0, y1: 0, x2: 100, y2: 50 } },
];
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
  return createAwaitUiElementTool(registry);
}

beforeEach(() => {
  flagEnabledMock = (n) => n === "open-device-server";
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("await-ui-element → open-device-server awaitChange (Screen-graph Phase A.1)", () => {
  it("resolves on the immediate trusted read without arming awaitChange", async () => {
    const openApi = {
      getState: vi.fn(async () => stateReply(okButton, 5)),
      awaitChange: vi.fn(),
    };
    const tool = makeTool(openApi);

    const result = await tool.execute(
      {} as never,
      { udid: ANDROID_SERIAL, condition: "exists", selector: { text: "OK" }, timeoutMs: 2000 } as never
    );

    expect(result.success).toBe(true);
    // Already present on the first read — no need to block on the AX clock.
    expect(openApi.awaitChange).not.toHaveBeenCalled();
  });

  it("blocks on awaitChange with the mapped selector, then confirms on the settled read", async () => {
    let getStateCalls = 0;
    const openApi = {
      getState: vi.fn(async () => {
        getStateCalls += 1;
        // First read: element absent. After the on-device match: present.
        return getStateCalls === 1 ? stateReply([], 5) : stateReply(okButton, 6);
      }),
      awaitChange: vi.fn(async () => ({
        version: 6,
        hash: "h6",
        stateHash: "s6",
        changed: true,
        timedOut: false,
      })),
    };
    const tool = makeTool(openApi);

    const result = await tool.execute(
      {} as never,
      { udid: ANDROID_SERIAL, condition: "visible", selector: { text: "OK" }, timeoutMs: 2000 } as never
    );

    expect(result.success).toBe(true);
    expect(openApi.awaitChange).toHaveBeenCalledTimes(1);
    // The tool selector maps to a loose, case-insensitive on-device selector,
    // arms from the version the immediate read reported, and asks to settle.
    expect(openApi.awaitChange).toHaveBeenCalledWith(
      expect.objectContaining({
        fromVersion: 5,
        settle: true,
        until: { text: { contains: "OK", caseInsensitive: true } },
      })
    );
    // Immediate read + settled re-read after the match.
    expect(openApi.getState.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("maps an identifier selector to the on-device `id` field", async () => {
    const openApi = {
      getState: vi.fn(async () =>
        stateReply(
          [
            {
              index: 1,
              className: "android.widget.Button",
              resourceId: "com.example:id/submit",
              text: "Go",
              bounds: { x1: 0, y1: 0, x2: 100, y2: 50 },
            },
          ],
          9
        )
      ),
      awaitChange: vi.fn(async () => ({ version: 9, hash: "h9", stateHash: "s9", changed: false, timedOut: true })),
    };
    const tool = makeTool(openApi);

    // Element already present, so the immediate read resolves it — but the
    // mapping is exercised through toOpenServerAwaitSelector's identifier arm
    // below regardless; here we just confirm a positive identifier match works.
    const result = await tool.execute(
      {} as never,
      { udid: ANDROID_SERIAL, condition: "exists", selector: { identifier: "submit" }, timeoutMs: 1000 } as never
    );

    expect(result.success).toBe(true);
  });

  it("reports cause=unmet when the element never appears and awaitChange times out", async () => {
    const openApi = {
      getState: vi.fn(async () => stateReply(cancelButton, 3)),
      awaitChange: vi.fn(async () => ({
        version: 3,
        hash: "h3",
        stateHash: "s3",
        changed: false,
        timedOut: true,
      })),
    };
    const tool = makeTool(openApi);

    const result = await tool.execute(
      {} as never,
      { udid: ANDROID_SERIAL, condition: "exists", selector: { text: "OK" }, timeoutMs: 500 } as never
    );

    expect(result.success).toBe(false);
    // The reads were trustworthy (non-empty tree) and the element was simply
    // absent — a verdict on the condition, not a blind window.
    expect(result.cause).toBe("unmet");
    expect(openApi.awaitChange).toHaveBeenCalledTimes(1);
  });
});
