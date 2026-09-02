import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../src/utils/ios-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ios-devices")>();
  return { ...actual, isTvOsSimulator: vi.fn(async () => false) };
});

import { describeAndroidViaOpenState } from "../src/utils/open-server-describe";
import {
  describeAndroid,
  settleToWaitTimeoutMs,
} from "../src/tools/describe/platforms/android";
import { createAwaitUiElementTool } from "../src/tools/await-ui-element";
import { resolveDevice } from "../src/utils/device-info";
import { formatDescribeTree } from "../src/tools/describe/format-tree";
import type { OpenServerNestedElement } from "../src/tools/describe/platforms/android/open-server-tree";

const ANDROID_SERIAL = "emulator-5554";
const device = resolveDevice(ANDROID_SERIAL);
const SCREEN = { width: 1080, height: 2400 };

// A nested window root the same shape `getAccessibilityTree({ nested: true })`
// and `getState({ nested: true })` both return: raw class names, package-
// qualified resource ids, one nested `children` tree.
function nestedRoots(): OpenServerNestedElement[] {
  return [
    {
      className: "android.widget.FrameLayout",
      packageName: "com.android.settings",
      bounds: { x1: 0, y1: 0, x2: 1080, y2: 2400 },
      children: [
        {
          className: "android.widget.Button",
          resourceId: "com.android.settings:id/login",
          text: "Login",
          clickable: true,
          bounds: { x1: 0, y1: 0, x2: 400, y2: 200 },
        },
        {
          className: "android.widget.TextView",
          resourceId: "com.android.settings:id/title",
          text: "Battery",
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

function makeOpenApi() {
  return {
    // The await poll path (T8 + F12) uses getNestedState (one round-trip).
    getNestedState: vi.fn(async () => ({
      tree: nestedRoots(),
      info,
      waitedMs: 5,
      captureMs: 8,
    })),
    // The describe tool's own open path uses these two.
    getNestedAccessibilityTree: vi.fn(async () => ({ tree: nestedRoots() })),
    getInfo: vi.fn(async () => info),
  };
}

function makeRegistry(openApi: unknown) {
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
afterEach(() => vi.restoreAllMocks());

describe("describeAndroidViaOpenState (T8 helper, F12)", () => {
  it("fetches the tree via getNestedState in one round-trip and tags the open source", async () => {
    const openApi = makeOpenApi();
    const data = await describeAndroidViaOpenState(makeRegistry(openApi), device);

    expect(openApi.getNestedState).toHaveBeenCalledTimes(1);
    expect(data.source).toBe("open-device-server");
    // Rendered through the SAME nested v2 trim: the Button keeps its label + id.
    const labels = data.tree.children.map((c) => c.label);
    expect(labels).toContain("Login");
  });

  it("F12: await path and describe path render an IDENTICAL tree from the same fixture", async () => {
    const openApi = makeOpenApi();
    const viaState = await describeAndroidViaOpenState(makeRegistry(openApi), device);
    const viaDescribe = await describeAndroid(makeRegistry(openApi), ANDROID_SERIAL);

    // Same nested trim, same size → byte-identical DescribeNode tree and source,
    // so labels and id forms match across the two tools (no flat-vs-nested gap).
    expect(viaState.source).toBe("open-device-server");
    expect(viaDescribe.source).toBe("open-device-server");
    expect(viaState.tree).toEqual(viaDescribe.tree);

    const ids = viaState.tree.children.map((c) => c.identifier).filter(Boolean);
    // Package-qualified id form, identical on both paths.
    expect(ids).toContain("com.android.settings:id/login");
  });

  it("rejects when getNestedState fails, so the caller can fall back", async () => {
    const openApi = makeOpenApi();
    openApi.getNestedState.mockRejectedValueOnce(new Error("boom"));
    await expect(describeAndroidViaOpenState(makeRegistry(openApi), device)).rejects.toThrow("boom");
  });
});

describe("describe open path — one RPC, settle idle policy (P3d)", () => {
  it("default (no settle) issues exactly one getNestedState with waitTimeoutMs:0 (immediate, matches the proprietary path) and never the two-call path", async () => {
    const openApi = makeOpenApi();
    const data = await describeAndroid(makeRegistry(openApi), ANDROID_SERIAL);

    expect(data.source).toBe("open-device-server");
    // Single combined round-trip …
    expect(openApi.getNestedState).toHaveBeenCalledTimes(1);
    expect(openApi.getNestedState).toHaveBeenCalledWith({ waitTimeoutMs: 0 });
    // … not the old fake-parallel getNestedAccessibilityTree + getInfo pair.
    expect(openApi.getNestedAccessibilityTree).not.toHaveBeenCalled();
    expect(openApi.getInfo).not.toHaveBeenCalled();
  });

  it("settle:false reads immediately (waitTimeoutMs:0)", async () => {
    const openApi = makeOpenApi();
    await describeAndroid(makeRegistry(openApi), ANDROID_SERIAL, undefined, false, false);
    expect(openApi.getNestedState).toHaveBeenCalledWith({ waitTimeoutMs: 0 });
  });

  it("settle:true waits the 500 ms quiescence (the settled read)", async () => {
    const openApi = makeOpenApi();
    await describeAndroid(makeRegistry(openApi), ANDROID_SERIAL, undefined, false, true);
    expect(openApi.getNestedState).toHaveBeenCalledWith({ waitTimeoutMs: 500 });
  });

  it("settle:<number> passes the custom cap through as waitTimeoutMs", async () => {
    const openApi = makeOpenApi();
    await describeAndroid(makeRegistry(openApi), ANDROID_SERIAL, undefined, false, 250);
    expect(openApi.getNestedState).toHaveBeenCalledWith({ waitTimeoutMs: 250 });
  });

  it("settleToWaitTimeoutMs maps the policy: absent/false/0/negative/NaN → 0, true → 500, positive → floor", () => {
    expect(settleToWaitTimeoutMs(undefined)).toBe(0);
    expect(settleToWaitTimeoutMs(false)).toBe(0);
    expect(settleToWaitTimeoutMs(0)).toBe(0);
    expect(settleToWaitTimeoutMs(-100)).toBe(0);
    expect(settleToWaitTimeoutMs(Number.NaN)).toBe(0);
    expect(settleToWaitTimeoutMs(true)).toBe(500);
    expect(settleToWaitTimeoutMs(250)).toBe(250);
    expect(settleToWaitTimeoutMs(300.9)).toBe(300);
  });

  it("surfaces the server's waitedMs/captureMs split as result metadata (not rendered text)", async () => {
    const openApi = makeOpenApi();
    openApi.getNestedState.mockResolvedValueOnce({
      tree: nestedRoots(),
      info,
      waitedMs: 42,
      captureMs: 17,
    });
    const data = await describeAndroid(makeRegistry(openApi), ANDROID_SERIAL);
    expect(data.waitedMs).toBe(42);
    expect(data.captureMs).toBe(17);
    // Metadata only — the timings must not leak into the rendered tree.
    const rendered = formatDescribeTree(data.tree, { source: data.source });
    expect(rendered).not.toContain("waitedMs");
    expect(rendered).not.toContain("captureMs");
  });
});

describe("describe open path — truncation hint (F13)", () => {
  it("adds a hint when a window root reports it was truncated at the element cap", async () => {
    const openApi = makeOpenApi();
    openApi.getNestedState.mockResolvedValueOnce({
      tree: nestedRoots().map((r) => ({ ...r, truncated: true })),
      info,
      waitedMs: 5,
      captureMs: 8,
    });
    const data = await describeAndroid(makeRegistry(openApi), ANDROID_SERIAL);
    expect(data.source).toBe("open-device-server");
    expect(data.hint ?? "").toContain("truncated");
  });

  it("no truncation hint when the tree fits", async () => {
    const openApi = makeOpenApi();
    const data = await describeAndroid(makeRegistry(openApi), ANDROID_SERIAL);
    expect(data.hint ?? "").not.toContain("truncated");
  });
});

describe("await-ui-element → open-device-server getNestedState (T8)", () => {
  it("flag on: polls the tree through getNestedState, not describe's two RPCs", async () => {
    const openApi = makeOpenApi();
    const tool = createAwaitUiElementTool(makeRegistry(openApi));

    const result = await tool.execute(
      {},
      {
        udid: ANDROID_SERIAL,
        selector: { text: "Login" },
        condition: "visible",
        timeoutMs: 1000,
        pollIntervalMs: 50,
      } as never
    );

    expect(result.success).toBe(true);
    expect(openApi.getNestedState).toHaveBeenCalled();
  });
});
