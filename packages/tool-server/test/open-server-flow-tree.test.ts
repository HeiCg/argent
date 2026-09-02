import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let flagEnabledMock: (name: string) => boolean;
vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, isFlagEnabled: (name: string) => flagEnabledMock(name) };
});

import { queryAndroidFullHierarchy } from "../src/tools/flows/flow-android-tree";
import { resolveDevice } from "../src/utils/device-info";

const device = resolveDevice("emulator-5554");

function makeOpenApi() {
  return {
    getAccessibilityTree: vi.fn(async () => ({
      tree: [
        {
          index: 1,
          className: "android.widget.Button",
          resourceId: "submit",
          text: "Go",
          bounds: { x1: 0, y1: 0, x2: 200, y2: 100 },
        },
      ],
    })),
    getInfo: vi.fn(async () => ({
      screenWidth: 1000,
      screenHeight: 2000,
      currentPackage: "",
      keyboardVisible: false,
      displayRotation: 0,
    })),
  };
}

function makeRegistry(openApi: unknown, onDevtools?: () => Promise<unknown>) {
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("OpenDeviceServer:")) return openApi;
      if (urn.startsWith("AndroidDevtools:")) {
        if (onDevtools) return onDevtools();
        return {
          getHierarchy: vi.fn(async () => ({ xml: "<hierarchy></hierarchy>" })),
          getScreenSize: vi.fn(async () => ({ width: 1000, height: 2000 })),
        };
      }
      throw new Error(`unexpected urn ${urn}`);
    }),
  } as never;
}

beforeEach(() => {
  flagEnabledMock = () => false;
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("flow-android-tree → open-device-server (T6)", () => {
  it("flag on: reads the open server tree (source open-device-server) with the flow node budget", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    const result = await queryAndroidFullHierarchy(makeRegistry(openApi), device);

    expect(result.source).toBe("open-device-server");
    expect(result.screen).toEqual({ width: 1000, height: 2000 });
    expect(result.tree.children).toHaveLength(1);
    expect(result.tree.children[0]!.identifier).toBe("submit");
    // Flows keep far more of the tree than the trimmed describe read (200).
    expect(openApi.getAccessibilityTree).toHaveBeenCalledWith({ maxElements: 12_000 });
  });

  it("flag off: never touches the open server, reads the android-devtools hierarchy", async () => {
    flagEnabledMock = () => false;
    const openApi = makeOpenApi();
    const result = await queryAndroidFullHierarchy(makeRegistry(openApi), device);

    expect(openApi.getAccessibilityTree).not.toHaveBeenCalled();
    expect(result.source).toBe("android-devtools");
  });

  it("open server throws: warns and falls back to android-devtools", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    openApi.getAccessibilityTree.mockRejectedValueOnce(new Error("open boom"));
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    const result = await queryAndroidFullHierarchy(makeRegistry(openApi), device);

    expect(openApi.getAccessibilityTree).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("android-devtools");
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining("[flow-android-tree] open-device-server")
    );
  });
});
