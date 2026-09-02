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
import { createAwaitUiElementTool } from "../src/tools/await-ui-element";
import { resolveDevice } from "../src/utils/device-info";

const ANDROID_SERIAL = "emulator-5554";
const device = resolveDevice(ANDROID_SERIAL);

function stateReply() {
  return {
    tree: [
      {
        index: 1,
        className: "android.widget.Button",
        text: "Login",
        bounds: { x1: 0, y1: 0, x2: 200, y2: 100 },
      },
    ],
    info: {
      screenWidth: 1000,
      screenHeight: 2000,
      currentPackage: "",
      keyboardVisible: false,
      displayRotation: 0,
    },
    screenshot: "",
    waitedMs: 5,
    captureMs: 8,
  };
}

function makeOpenApi() {
  return { getState: vi.fn(async () => stateReply()) };
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

describe("describeAndroidViaOpenState (T8 helper)", () => {
  it("fetches the tree via getState in one round-trip and tags the open source", async () => {
    const openApi = makeOpenApi();
    const data = await describeAndroidViaOpenState(makeRegistry(openApi), device);

    expect(openApi.getState).toHaveBeenCalledTimes(1);
    expect(data.source).toBe("open-device-server");
    expect(data.tree.children).toHaveLength(1);
    expect(data.tree.children[0]!.label).toBe("Login");
  });

  it("rejects when getState fails, so the caller can fall back", async () => {
    const openApi = makeOpenApi();
    openApi.getState.mockRejectedValueOnce(new Error("boom"));
    await expect(describeAndroidViaOpenState(makeRegistry(openApi), device)).rejects.toThrow("boom");
  });
});

describe("await-ui-element → open-device-server getState (T8)", () => {
  it("flag on: polls the tree through getState, not describe's two RPCs", async () => {
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
    expect(openApi.getState).toHaveBeenCalled();
  });
});
