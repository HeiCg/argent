import { describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";
import type { AndroidDevtoolsApi, GetHierarchyOptions } from "../src/blueprints/android-devtools";
import { getHierarchyRequestParams } from "../src/blueprints/android-devtools";
import { describeAndroid } from "../src/tools/describe/platforms/android";
import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import { createAwaitUiElementTool } from "../src/tools/await-ui-element";
import { fetchTree } from "../src/utils/ui-tree-match";
import { resolveDevice } from "../src/utils/device-info";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

// The wait tools resolve the target's form factor before polling; isAndroidTv()
// costs real adb round-trips against a serial that is never listed. Pin it so
// these tests exercise the phone path without shelling out.
vi.mock("../src/utils/adb", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/adb")>("../src/utils/adb");
  return { ...actual, isAndroidTv: async () => false };
});

const ANDROID_SERIAL = "emulator-5554";

// One labelled, clickable node — enough for `describe` to return a non-empty
// tree, for a selector to match, and for await-screen-idle to see content.
const XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<hierarchy rotation="0">` +
  `<node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">` +
  `<node text="Sign in" resource-id="com.demo:id/signin" class="android.widget.Button" ` +
  `clickable="true" bounds="[100,200][980,320]" />` +
  `</node>` +
  `</hierarchy>`;

/**
 * Registry serving a stub android-devtools whose getHierarchy records the
 * options each caller passed. `optionsSeen` is what these tests assert on: the
 * helper only bypasses its AccessibilityNodeInfo cache when asked to, so the
 * request is the observable behaviour.
 */
function makeRecordingRegistry(): {
  registry: Registry;
  optionsSeen: () => (GetHierarchyOptions | undefined)[];
} {
  const optionsSeen: (GetHierarchyOptions | undefined)[] = [];
  const android = {
    isReady: () => true,
    getHierarchy: vi.fn(async (opts?: GetHierarchyOptions) => {
      optionsSeen.push(opts);
      return {
        xml: XML,
        captureMode: "interactive-windows",
        windowCount: 1,
        nodeCount: 2,
        truncated: false,
        elapsedMs: 1,
      };
    }),
    getScreenSize: async () => ({ width: 1080, height: 2400, rotation: 0 }),
    ping: async () => ({ ok: true, idleMs: 0, protocol: "1" }),
  } as unknown as AndroidDevtoolsApi;

  const registry = {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("AndroidDevtools:")) return android;
      throw new Error(`unexpected service ${urn}`);
    }),
  } as unknown as Registry;

  return { registry, optionsSeen: () => optionsSeen };
}

describe("Android describe reads bypass the helper's node cache", () => {
  it("describeAndroid asks getHierarchy for an uncached capture", async () => {
    const { registry, optionsSeen } = makeRecordingRegistry();

    await describeAndroid(registry, ANDROID_SERIAL, undefined, false);

    expect(optionsSeen()).toHaveLength(1);
    // Assert the EFFECTIVE request, so this holds whether the reader states
    // `clearCache` itself or inherits the blueprint default — and fails if
    // either the reader opts out or that default stops being coherent.
    expect(getHierarchyRequestParams(optionsSeen()[0]).clearCache).toBe(true);
  });

  // The defect this pins: the helper's cache serves a node's first-seen text
  // once its event-driven invalidation stops (observed after the inspected app
  // restarts under the long-lived connection), so a cached read reports a screen
  // that has already moved on. Every agent-facing reader below turns this tree
  // into an answer about the current screen — a settled verdict, a selector
  // match, tap coordinates — so each one must request coherence.
  it("await-screen-idle polls uncached trees", async () => {
    const { registry, optionsSeen } = makeRecordingRegistry();
    __primeDepCacheForTests(["adb"]);
    try {
      const tool = createAwaitScreenIdleTool(registry);
      await tool.execute(
        {},
        { udid: ANDROID_SERIAL, timeoutMs: 300, pollIntervalMs: 10, minStableMs: 0 }
      );
    } finally {
      __resetDepCacheForTests();
    }

    const seen = optionsSeen();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((o) => getHierarchyRequestParams(o).clearCache === true)).toBe(true);
  });

  it("await-ui-element polls uncached trees", async () => {
    const { registry, optionsSeen } = makeRecordingRegistry();
    __primeDepCacheForTests(["adb"]);
    try {
      const tool = createAwaitUiElementTool(registry);
      await tool.execute(
        {},
        {
          udid: ANDROID_SERIAL,
          condition: "visible",
          selector: { text: "Sign in" },
          timeoutMs: 300,
          pollIntervalMs: 10,
        }
      );
    } finally {
      __resetDepCacheForTests();
    }

    const seen = optionsSeen();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((o) => getHierarchyRequestParams(o).clearCache === true)).toBe(true);
  });

  // The shared selector-matching fetch behind the Lens/preview describe route
  // and `match-element-frame`, which converts a matched node into a tap point.
  it("the shared ui-tree fetchTree reads uncached", async () => {
    const { registry, optionsSeen } = makeRecordingRegistry();

    await fetchTree(registry, resolveDevice(ANDROID_SERIAL));

    expect(optionsSeen()).toHaveLength(1);
    // Assert the EFFECTIVE request, so this holds whether the reader states
    // `clearCache` itself or inherits the blueprint default — and fails if
    // either the reader opts out or that default stops being coherent.
    expect(getHierarchyRequestParams(optionsSeen()[0]).clearCache).toBe(true);
  });
});

/**
 * The stale read this suite guards against is silent: a caller that omits
 * `clearCache` gets a plausible-looking tree, no error and no failing test. So
 * the coherent capture is the default and a caller must opt out of it — these
 * pin that default, and fail if it is ever flipped back.
 */
describe("getHierarchy request defaults", () => {
  it("defaults clearCache to true when no options are given", () => {
    expect(getHierarchyRequestParams().clearCache).toBe(true);
    expect(getHierarchyRequestParams({}).clearCache).toBe(true);
  });

  it("keeps clearCache on when an unrelated option is set", () => {
    // The device-side helper reads `params.optBoolean("clearCache", false)`, so
    // an options object that omits the key must still put `true` on the wire
    // rather than letting the request fall through to that device-side default.
    const params = getHierarchyRequestParams({ maxNodes: 1200 });
    expect(params.clearCache).toBe(true);
    expect(params.maxNodes).toBe(1200);
  });

  it("sends every field the helper understands, so no device-side default applies", () => {
    expect(Object.keys(getHierarchyRequestParams()).sort()).toEqual([
      "clearCache",
      "maxDepth",
      "maxNodes",
      "waitForIdleMs",
    ]);
    expect(getHierarchyRequestParams()).toEqual({
      waitForIdleMs: 500,
      maxDepth: 128,
      maxNodes: 5000,
      clearCache: true,
    });
  });

  it("still honours an explicit opt-out", () => {
    expect(getHierarchyRequestParams({ clearCache: false }).clearCache).toBe(false);
  });
});
