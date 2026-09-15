import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Ticket A1 (part B): the open Android `describe` path prepends ONE execution-
// incident line while an incident is active on the device.

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

import { describeAndroid } from "../src/tools/describe/platforms/android";
import type { OpenServerNestedElement } from "../src/tools/describe/platforms/android/open-server-tree";
import {
  recordIncident,
  clearIncident,
  incidentHeaderLine,
  __resetIncidents,
} from "../src/utils/open-server-incident";

const ANDROID_SERIAL = "emulator-5554";
const SCREEN = { width: 1080, height: 2400 };

function nestedRoots(): OpenServerNestedElement[] {
  return [
    {
      className: "android.widget.FrameLayout",
      packageName: "com.android.settings",
      bounds: { x1: 0, y1: 0, x2: 1080, y2: 2400 },
      children: [
        {
          className: "android.widget.TextView",
          resourceId: "com.android.settings:id/title",
          text: "Battery",
          clickable: true,
          bounds: { x1: 0, y1: 300, x2: 500, y2: 400 },
        },
      ],
    },
  ];
}

const info = {
  screenWidth: SCREEN.width,
  screenHeight: SCREEN.height,
  currentPackage: "com.android.settings",
  keyboardVisible: false,
  displayRotation: 0,
};

function makeRegistry() {
  const openApi = {
    getNestedState: vi.fn(async () => ({ tree: nestedRoots(), info, waitedMs: 0, captureMs: 3 })),
  };
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("OpenDeviceServer:")) return openApi;
      throw new Error(`unexpected urn ${urn}`);
    }),
  } as never;
}

beforeEach(() => {
  flagEnabledMock = (n) => n === "open-device-server";
  __resetIncidents();
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("describe (open path) — incident line", () => {
  it("no incident -> no incidentLine on the describe data", async () => {
    const data = await describeAndroid(makeRegistry(), ANDROID_SERIAL);
    expect(data.source).toBe("open-device-server");
    expect(data.incidentLine).toBeUndefined();
  });

  it("active incident -> incidentLine equals the header line for this device", async () => {
    const inc = recordIncident(ANDROID_SERIAL, {
      tool: "gesture-tap",
      code: "verify_not_found",
      message: "x",
    });
    const data = await describeAndroid(makeRegistry(), ANDROID_SERIAL);
    expect(data.incidentLine).toBe(incidentHeaderLine(inc));
    expect(data.incidentLine).toBe(
      "incident: gesture-tap verify_not_found ×1 — re-describe and pick a visible label"
    );
  });

  it("an incident on ANOTHER device does not leak into this describe", async () => {
    recordIncident("emulator-9999", { tool: "gesture-tap", code: "timeout", message: "x" });
    const data = await describeAndroid(makeRegistry(), ANDROID_SERIAL);
    expect(data.incidentLine).toBeUndefined();
  });

  it("cleared incident -> no line again", async () => {
    recordIncident(ANDROID_SERIAL, { tool: "gesture-tap", code: "verify_ambiguous", message: "x" });
    clearIncident(ANDROID_SERIAL);
    const data = await describeAndroid(makeRegistry(), ANDROID_SERIAL);
    expect(data.incidentLine).toBeUndefined();
  });
});
