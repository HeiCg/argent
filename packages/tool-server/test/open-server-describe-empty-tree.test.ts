import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bench run 37561512651: the open server returned an empty nested tree (no active
// window: a freshly started activity whose process died before its first frame)
// and describe threw, falling back to android-devtools, then to `uiautomator
// dump`, which cannot connect while the open server holds UiAutomation. The open
// path now returns the empty tree with a marker instead of leaving the open path;
// any other open-path failure still falls back, and the result says so.

let flagEnabledMock: (name: string) => boolean;
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, isFlagEnabled: (name: string) => flagEnabledMock(name) };
});
vi.mock("../src/utils/check-deps", () => ({ ensureDeps: vi.fn(async () => {}) }));
vi.mock("../src/utils/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/adb")>();
  return {
    ...actual,
    isAndroidTv: vi.fn(async () => false),
    adbExecOutBinary: vi.fn(async () => {
      throw new Error("uiautomator dump must not run");
    }),
  };
});

import { describeAndroid, openServerEmptyTreeCount } from "../src/tools/describe/platforms/android";

const ANDROID_SERIAL = "emulator-5554";

const info = {
  screenWidth: 1080,
  screenHeight: 2400,
  currentPackage: "",
  keyboardVisible: false,
  displayRotation: 0,
};

const settingsXml =
  '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">' +
  '<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.settings" content-desc="" clickable="false" bounds="[0,0][1080,2400]">' +
  '<node index="0" text="Network &amp; internet" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="true" bounds="[0,300][1080,420]" />' +
  "</node></hierarchy>";

function makeRegistry(
  getNestedState: ReturnType<typeof vi.fn>,
  devtools?: {
    getHierarchy: () => Promise<{ xml: string }>;
    getScreenSize: () => Promise<{ width: number; height: number }>;
  }
) {
  const resolveService = vi.fn(async (urn: string) => {
    if (urn.startsWith("OpenDeviceServer:")) return { getNestedState };
    if (devtools && urn.startsWith("AndroidDevtools:")) return devtools;
    throw new Error(`unexpected urn ${urn}`);
  });
  return { registry: { resolveService } as never, resolveService };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  flagEnabledMock = (n) => n === "open-device-server";
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("describe (open path): empty tree", () => {
  it("returns the device-reported empty tree with a marker and does not fall back", async () => {
    const getNestedState = vi.fn(async () => ({
      tree: [],
      info,
      waitedMs: 0,
      captureMs: 480,
      treeEmpty: true,
      treeEmptyReason: "no_active_window",
      timings: {
        idleMs: 0,
        rootMs: 470,
        windowsMs: 0,
        rootsMs: [],
        serializeMs: 0,
        encodeMs: 0,
        rootAttempts: 11,
        rootRetryMs: 470,
      },
    }));
    const { registry, resolveService } = makeRegistry(getNestedState);
    const before = openServerEmptyTreeCount();

    const data = await describeAndroid(registry, ANDROID_SERIAL);

    expect(data.source).toBe("open-device-server");
    expect(data.tree.children).toEqual([]);
    expect(data.treeEmpty).toBe(true);
    expect(data.treeEmptyReason).toBe("no_active_window");
    expect(data.backend).toBeUndefined();
    expect(data.hint).toMatch(/empty/i);
    expect(data.timings?.rootAttempts).toBe(11);
    // One read, no other backend asked.
    expect(getNestedState).toHaveBeenCalledTimes(1);
    expect(resolveService.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/^OpenDeviceServer:/),
    ]);
    expect(openServerEmptyTreeCount()).toBe(before + 1);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain("empty accessibility tree");
    expect(line).toContain("no_active_window");
    // Not a fallback: the bench's fallback counter must not match this line.
    expect(line).not.toMatch(/falling back/i);
  });

  it("treats an empty tree from a server without the marker the same way", async () => {
    const getNestedState = vi.fn(async () => ({ tree: [], info, waitedMs: 0, captureMs: 2 }));
    const { registry, resolveService } = makeRegistry(getNestedState);

    const data = await describeAndroid(registry, ANDROID_SERIAL);

    expect(data.source).toBe("open-device-server");
    expect(data.treeEmpty).toBe(true);
    expect(data.treeEmptyReason).toBe("empty_tree");
    expect(resolveService).toHaveBeenCalledTimes(1);
  });

  it("a non-empty tree carries no empty-tree marker and logs nothing", async () => {
    const getNestedState = vi.fn(async () => ({
      tree: [
        {
          className: "android.widget.FrameLayout",
          packageName: "com.android.settings",
          bounds: { x1: 0, y1: 0, x2: 1080, y2: 2400 },
          children: [
            {
              className: "android.widget.TextView",
              text: "Network & internet",
              clickable: true,
              bounds: { x1: 0, y1: 300, x2: 1080, y2: 420 },
            },
          ],
        },
      ],
      info,
      waitedMs: 0,
      captureMs: 5,
    }));
    const { registry } = makeRegistry(getNestedState);

    const data = await describeAndroid(registry, ANDROID_SERIAL);

    expect(data.treeEmpty).toBeUndefined();
    expect(data.treeEmptyReason).toBeUndefined();
    expect(JSON.stringify(data.tree)).toContain("Network & internet");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("describe (open path): fallback marker", () => {
  it("an open-path error still falls back, marked and logged at warn", async () => {
    const getNestedState = vi.fn(async () => {
      throw new Error("socket closed");
    });
    const { registry } = makeRegistry(getNestedState, {
      getHierarchy: async () => ({ xml: settingsXml }),
      getScreenSize: async () => ({ width: 1080, height: 2400 }),
    });

    const data = await describeAndroid(registry, ANDROID_SERIAL);

    expect(data.source).toBe("android-devtools");
    expect(data.backend).toBe("proprietary-fallback");
    expect(data.fallbackReason).toBe("socket closed");
    expect(data.treeEmpty).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(
      /^\[describe\.android\] open-device-server failed, falling back: socket closed$/
    );
  });

  it("the flag off takes the proprietary path with no marker", async () => {
    flagEnabledMock = () => false;
    const getNestedState = vi.fn();
    const { registry } = makeRegistry(getNestedState, {
      getHierarchy: async () => ({ xml: settingsXml }),
      getScreenSize: async () => ({ width: 1080, height: 2400 }),
    });

    const data = await describeAndroid(registry, ANDROID_SERIAL);

    expect(data.source).toBe("android-devtools");
    expect(data.backend).toBeUndefined();
    expect(getNestedState).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
