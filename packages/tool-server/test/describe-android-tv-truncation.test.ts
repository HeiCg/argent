// The partial-capture notice has a producer and a consumer, and each of their
// own tests stubs the other one out: `describe-android-truncation.test.ts`
// drives `describeAndroid` with `isTv=false`, so it never joins two hints, and
// `describe-tv.test.ts` mocks `describeAndroid` away and hand-feeds
// `truncated: true`, so it never proves anything sets that field.
//
// This file joins them with nothing mocked in between: one registry serves the
// Android TV control API an empty focus view and the android-devtools helper a
// truncated capture, so `describeTv` reaches the real `describeAndroid` and
// reads the real flag.
import { describe, it, expect, vi } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";
import { describeTv } from "../src/tools/describe/platforms/tv";
import { describeAndroid } from "../src/tools/describe/platforms/android";
import { ANDROID_DEVTOOLS_NAMESPACE } from "../src/blueprints/android-devtools";
import type { AndroidDevtoolsApi } from "../src/blueprints/android-devtools";
import type { TvControlApi } from "../src/blueprints/tv-control";

// An Android serial, so `resolveDevice` classifies it as an Android emulator
// and `describeTv` takes the leanback path.
const SERIAL = "emulator-5554";
const ANDROID_TV_DEVICE: DeviceInfo = { id: SERIAL, platform: "android", kind: "emulator" };

const XML =
  `<hierarchy rotation="0">` +
  `<node class="android.widget.FrameLayout" bounds="[0,0][1920,1080]">` +
  `<node text="Continue watching" class="android.widget.Button" clickable="true" bounds="[100,200][900,320]" />` +
  `</node></hierarchy>`;

function registryWith(truncated: boolean): Registry {
  const devtools = {
    getHierarchy: async () => ({
      xml: XML,
      captureMode: "helper",
      windowCount: 1,
      nodeCount: 5000,
      truncated,
      elapsedMs: 1,
    }),
    getScreenSize: async () => ({ width: 1920, height: 1080, rotation: 0 }),
  } as unknown as AndroidDevtoolsApi;

  // A leanback screen whose focus engine reports nothing — the state that sends
  // `describeTv` into the uiautomator fallback.
  const tv = {
    describe: async () => ({ bundleId: "com.acme.tv", focused: null, focusable: [] }),
    recycleAx: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn(),
    type: vi.fn(),
  } as unknown as TvControlApi;

  return {
    resolveService: vi.fn(async (urn: string) =>
      urn.startsWith(`${ANDROID_DEVTOOLS_NAMESPACE}:`) ? devtools : tv
    ),
  } as unknown as Registry;
}

describe("partial capture — Android TV producer to consumer", () => {
  it("sets the truncated flag the TV fallback reads", async () => {
    const data = await describeAndroid(registryWith(true), SERIAL, undefined, true);
    expect(data.truncated).toBe(true);
    // Two hints on one call: the Android TV notice and the partial-capture one.
    // This is the only caller that reaches `joinHints` with more than one.
    expect(data.hint).toMatch(/Android TV \(leanback\)/i);
    expect(data.hint).toContain("PARTIAL");
  });

  it("leaves the flag off when the whole screen fit", async () => {
    const data = await describeAndroid(registryWith(false), SERIAL, undefined, true);
    expect(data.truncated).toBeUndefined();
    expect(data.hint).toMatch(/Android TV \(leanback\)/i);
    expect(data.hint).not.toContain("PARTIAL");
  });

  it("carries the notice through the TV focus fallback, hint and rendering", async () => {
    const res = await describeTv(registryWith(true), ANDROID_TV_DEVICE);

    expect(res.source).toBe("android-devtools");
    expect(res.hint).toMatch(/Android TV focus engine/i);
    expect(res.hint).toContain("PARTIAL");
    // The agent reads the rendering, so the notice has to be in it too.
    expect(res.description).toContain("PARTIAL");
    // The tree the fallback captured is still there — a partial read beats none.
    expect(res.description).toContain("Continue watching");
  });

  it("says nothing about a partial tree when the capture was complete", async () => {
    const res = await describeTv(registryWith(false), ANDROID_TV_DEVICE);

    expect(res.hint).toMatch(/Android TV focus engine/i);
    expect(res.hint).not.toContain("PARTIAL");
    expect(res.description).not.toContain("PARTIAL");
  });
});
