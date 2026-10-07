import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ABBA run 37609765062: an immediate describe (`settle:false`) right after a tap
// that changes screen read a root with 0 elements in 35-45 % of the samples (the
// read lands between the destination's first frame and the end of the
// transition, and the trimmed tree is empty). The server's `treeEmpty` marker
// never fired (it means "no active window"), so the agent got an empty screen
// with no hint. In 26/26 cases the next read, 265-433 ms later, was the
// destination. The open path now re-reads a root-without-elements up to twice,
// 50 ms apart, and hints when all three reads are empty.

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

import {
  describeAndroid,
  openServerEmptyRootRetryCount,
  openServerEmptyTreeCount,
} from "../src/tools/describe/platforms/android";

const ANDROID_SERIAL = "emulator-5554";

const info = {
  screenWidth: 1080,
  screenHeight: 2400,
  currentPackage: "com.android.settings",
  keyboardVisible: false,
  displayRotation: 0,
};

// A window root is present, but nothing in it survives the trim: a bare
// full-screen FrameLayout with no label, id or interactivity (the transition
// frame). `treeEmpty` is absent, as the server reported it in the run.
const rootWithoutElements = () => ({
  tree: [
    {
      className: "android.widget.FrameLayout",
      packageName: "com.android.settings",
      bounds: { x1: 0, y1: 0, x2: 1080, y2: 2400 },
      children: [],
    },
  ],
  info,
  waitedMs: 0,
  captureMs: 3,
});

const destination = () => ({
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
  captureMs: 4,
});

// Records the host clock of each read so the gap between reads can be checked.
function scripted(replies: Array<() => unknown>) {
  const readAt: number[] = [];
  let i = 0;
  const getNestedState = vi.fn(async () => {
    readAt.push(performance.now());
    const reply = replies[Math.min(i, replies.length - 1)]!;
    i += 1;
    return reply();
  });
  const resolveService = vi.fn(async (urn: string) => {
    if (urn.startsWith("OpenDeviceServer:")) return { getNestedState };
    throw new Error(`unexpected urn ${urn}`);
  });
  return { registry: { resolveService } as never, getNestedState, readAt };
}

beforeEach(() => {
  flagEnabledMock = (n) => n === "open-device-server";
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("describe (open path): root with no elements", () => {
  it("re-reads once when the first read is a root with no elements, returning the second", async () => {
    const { registry, getNestedState } = scripted([rootWithoutElements, destination]);
    const before = openServerEmptyRootRetryCount();

    const data = await describeAndroid(registry, ANDROID_SERIAL);

    expect(getNestedState).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(data.tree)).toContain("Network & internet");
    expect(data.hint).toBeUndefined();
    expect(data.treeEmpty).toBeUndefined();
    expect(openServerEmptyRootRetryCount() - before).toBe(1);
    // One 50 ms pause before the returned read lands in waitedMs.
    expect(data.waitedMs).toBeGreaterThanOrEqual(49);
  });

  it("reads three times when every read is a root with no elements, and hints", async () => {
    const { registry, getNestedState } = scripted([rootWithoutElements]);
    const before = openServerEmptyRootRetryCount();
    const emptyBefore = openServerEmptyTreeCount();

    const data = await describeAndroid(registry, ANDROID_SERIAL);

    expect(getNestedState).toHaveBeenCalledTimes(3);
    expect(data.source).toBe("open-device-server");
    expect(data.tree.children).toEqual([]);
    expect(data.hint).toMatch(/root with no elements/);
    expect(data.hint).toMatch(/await-screen-idle/);
    // A window was present: not the server's no-active-window marker.
    expect(data.treeEmpty).toBeUndefined();
    expect(openServerEmptyTreeCount()).toBe(emptyBefore);
    expect(openServerEmptyRootRetryCount() - before).toBe(2);
    // Every read reports waitedMs 0, so waitedMs is the host re-read time: two
    // 50 ms pauses (Date.now resolution and an early timer can shave ~1 ms each).
    expect(data.waitedMs).toBeGreaterThanOrEqual(98);
  });

  it("settle: 0 is an immediate read and re-reads a root with no elements", async () => {
    const { registry, getNestedState } = scripted([rootWithoutElements, destination]);
    const before = openServerEmptyRootRetryCount();

    const data = await describeAndroid(registry, ANDROID_SERIAL, undefined, false, 0);

    expect(getNestedState).toHaveBeenCalledTimes(2);
    expect(getNestedState).toHaveBeenNthCalledWith(1, { waitTimeoutMs: 0, compact: false });
    expect(JSON.stringify(data.tree)).toContain("Network & internet");
    expect(openServerEmptyRootRetryCount() - before).toBe(1);
  });

  it("settle: 300 keeps one read and adds no empty-root hint", async () => {
    const { registry, getNestedState } = scripted([rootWithoutElements, destination]);
    const before = openServerEmptyRootRetryCount();

    const data = await describeAndroid(registry, ANDROID_SERIAL, undefined, false, 300);

    expect(getNestedState).toHaveBeenCalledTimes(1);
    expect(getNestedState).toHaveBeenCalledWith({ waitTimeoutMs: 300, compact: false });
    expect(data.tree.children).toEqual([]);
    expect(data.hint).toBeUndefined();
    expect(openServerEmptyRootRetryCount() - before).toBe(0);
  });

  it("reads once when the first read has elements", async () => {
    const { registry, getNestedState } = scripted([destination]);
    const before = openServerEmptyRootRetryCount();

    const data = await describeAndroid(registry, ANDROID_SERIAL);

    expect(getNestedState).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(data.tree)).toContain("Network & internet");
    expect(data.hint).toBeUndefined();
    expect(openServerEmptyRootRetryCount() - before).toBe(0);
  });

  it("keeps the no-active-window case (treeEmpty) at one read with its own hint", async () => {
    const { registry, getNestedState } = scripted([
      () => ({
        tree: [],
        info,
        waitedMs: 0,
        captureMs: 480,
        treeEmpty: true,
        treeEmptyReason: "no_active_window",
      }),
    ]);
    const before = openServerEmptyRootRetryCount();

    const data = await describeAndroid(registry, ANDROID_SERIAL);

    expect(getNestedState).toHaveBeenCalledTimes(1);
    expect(data.treeEmpty).toBe(true);
    expect(data.treeEmptyReason).toBe("no_active_window");
    expect(data.hint).toMatch(/no accessibility tree/);
    expect(data.hint).not.toMatch(/root with no elements/);
    expect(openServerEmptyRootRetryCount() - before).toBe(0);
  });

  it("leaves settle:true alone: one read, no retry", async () => {
    const { registry, getNestedState } = scripted([rootWithoutElements, destination]);
    const before = openServerEmptyRootRetryCount();

    const data = await describeAndroid(registry, ANDROID_SERIAL, undefined, false, true);

    expect(getNestedState).toHaveBeenCalledTimes(1);
    expect(getNestedState).toHaveBeenCalledWith({ waitTimeoutMs: 500, compact: false });
    expect(data.tree.children).toEqual([]);
    expect(openServerEmptyRootRetryCount() - before).toBe(0);
  });

  it("waits about 50 ms between reads", async () => {
    const { registry, readAt } = scripted([rootWithoutElements]);

    await describeAndroid(registry, ANDROID_SERIAL);

    expect(readAt).toHaveLength(3);
    for (let k = 1; k < readAt.length; k++) {
      const gap = readAt[k]! - readAt[k - 1]!;
      // setTimeout(50) may fire a hair early on some hosts; the upper bound
      // catches a missing or much longer wait without flaking on a busy CI.
      expect(gap).toBeGreaterThanOrEqual(45);
      expect(gap).toBeLessThan(250);
    }
  });
});
