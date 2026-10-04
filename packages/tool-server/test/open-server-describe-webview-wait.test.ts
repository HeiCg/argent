import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The open Android describe path waits for a cold WebView's DOM the same way the
// android-devtools and uiautomator paths do (upstream #1052): re-read every
// 250 ms, up to 1.5 s, while the tree holds a childless WebView. A tree without
// a WebView must cost exactly one read and no delay.

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
  return { ...actual, isAndroidTv: vi.fn(async () => false) };
});

import { describeAndroid, hasUnreadWebView } from "../src/tools/describe/platforms/android";
import type { OpenServerNestedElement } from "../src/tools/describe/platforms/android/open-server-tree";

const ANDROID_SERIAL = "emulator-5554";
const SCREEN = { width: 1080, height: 2400 };

const info = {
  screenWidth: SCREEN.width,
  screenHeight: SCREEN.height,
  currentPackage: "com.example.web",
  keyboardVisible: false,
  displayRotation: 0,
};

function root(children: OpenServerNestedElement[]): OpenServerNestedElement[] {
  return [
    {
      className: "android.widget.FrameLayout",
      packageName: "com.example.web",
      bounds: { x1: 0, y1: 0, x2: 1080, y2: 2400 },
      children,
    },
  ];
}

const title: OpenServerNestedElement = {
  className: "android.widget.TextView",
  resourceId: "com.example.web:id/title",
  text: "Inbox",
  clickable: true,
  bounds: { x1: 0, y1: 100, x2: 1080, y2: 200 },
};

// A WebView before Chromium publishes its page: the node with nothing under it.
const coldWebView: OpenServerNestedElement = {
  className: "android.webkit.WebView",
  packageName: "com.example.web",
  bounds: { x1: 0, y1: 200, x2: 1080, y2: 2400 },
};

// The same WebView once the DOM is published.
const warmWebView: OpenServerNestedElement = {
  ...coldWebView,
  children: [
    {
      className: "android.widget.Button",
      packageName: "com.example.web",
      text: "Sign in",
      clickable: true,
      bounds: { x1: 100, y1: 400, x2: 980, y2: 520 },
    },
  ],
};

function state(tree: OpenServerNestedElement[], waitedMs = 0) {
  return { tree, info, waitedMs, captureMs: 3 };
}

function makeRegistry(getNestedState: ReturnType<typeof vi.fn>) {
  const openApi = { getNestedState };
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("OpenDeviceServer:")) return openApi;
      throw new Error(`unexpected urn ${urn}`);
    }),
  } as never;
}

beforeEach(() => {
  flagEnabledMock = (n) => n === "open-device-server";
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("describe (open path): cold WebView wait", () => {
  it("re-reads until the WebView publishes its DOM, then returns the published tree", async () => {
    vi.useFakeTimers();
    const getNestedState = vi
      .fn()
      .mockResolvedValueOnce(state(root([title, coldWebView])))
      .mockResolvedValueOnce(state(root([title, coldWebView])))
      .mockResolvedValueOnce(state(root([title, warmWebView]), 7));

    const pending = describeAndroid(makeRegistry(getNestedState), ANDROID_SERIAL);
    await vi.advanceTimersByTimeAsync(1_000);
    const data = await pending;

    expect(data.source).toBe("open-device-server");
    expect(getNestedState).toHaveBeenCalledTimes(3);
    expect(hasUnreadWebView(data.tree)).toBe(false);
    expect(JSON.stringify(data.tree)).toContain("Sign in");
    // The wait is counted: the returned waitedMs covers the two 250 ms steps on
    // top of the final read's own idle gate.
    expect(data.waitedMs).toBeGreaterThanOrEqual(7 + 500);
    // captureMs stays the final read's serialization cost.
    expect(data.captureMs).toBe(3);
  });

  it("stops re-reading at the 1.5 s bound when the WebView never publishes", async () => {
    vi.useFakeTimers();
    const getNestedState = vi.fn(async () => state(root([title, coldWebView])));

    const pending = describeAndroid(makeRegistry(getNestedState), ANDROID_SERIAL);
    await vi.advanceTimersByTimeAsync(3_000);
    const data = await pending;

    expect(data.source).toBe("open-device-server");
    // First read + 6 re-reads (1500 / 250).
    expect(getNestedState).toHaveBeenCalledTimes(7);
    expect(hasUnreadWebView(data.tree)).toBe(true);
  });

  it("a tree without a WebView costs exactly one read and no delay", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const getNestedState = vi.fn(async () => state(root([title]), 4));

    const data = await describeAndroid(makeRegistry(getNestedState), ANDROID_SERIAL);

    expect(data.source).toBe("open-device-server");
    expect(getNestedState).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    // No wait was added on top of the server's own idle gate.
    expect(data.waitedMs).toBe(4);
  });
});
