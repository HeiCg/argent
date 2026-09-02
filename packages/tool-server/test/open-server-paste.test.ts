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
vi.mock("../src/utils/android-input", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/android-input")>();
  return { ...actual, injectAndroidKeycode: vi.fn(async () => {}) };
});
vi.mock("../src/utils/simulator-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/simulator-client")>();
  return { ...actual, setSimulatorClipboardText: vi.fn(async () => {}) };
});

import { createPasteTool } from "../src/tools/paste";
import { injectAndroidKeycode } from "../src/utils/android-input";
import { setSimulatorClipboardText } from "../src/utils/simulator-client";

const ANDROID_SERIAL = "emulator-5554";

function makeOpenApi() {
  return { typeText: vi.fn(async () => ({ success: true, charsTyped: 3 })) };
}

function makeTool(openApi: unknown, onSimulatorServer?: () => Promise<unknown>) {
  const registry = {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("OpenDeviceServer:")) return openApi;
      if (urn.startsWith("SimulatorServer:")) return onSimulatorServer ? onSimulatorServer() : {};
      throw new Error(`unexpected urn ${urn}`);
    }),
  } as never;
  return createPasteTool(registry);
}

beforeEach(() => {
  flagEnabledMock = () => false;
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("paste (android) → open-device-server (T4)", () => {
  it("flag on: types via the open server, never sets the clipboard or injects a keycode", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    const tool = makeTool(openApi);

    const result = await tool.execute({}, { udid: ANDROID_SERIAL, text: "otp-42" });

    expect(result).toEqual({ pasted: true });
    expect(openApi.typeText).toHaveBeenCalledWith("otp-42");
    expect(vi.mocked(setSimulatorClipboardText)).not.toHaveBeenCalled();
    expect(vi.mocked(injectAndroidKeycode)).not.toHaveBeenCalled();
  });

  it("flag off: never touches the open server, sets clipboard + KEYCODE_PASTE", async () => {
    flagEnabledMock = () => false;
    const openApi = makeOpenApi();
    const tool = makeTool(openApi);

    await tool.execute({}, { udid: ANDROID_SERIAL, text: "hi" });

    expect(openApi.typeText).not.toHaveBeenCalled();
    expect(vi.mocked(setSimulatorClipboardText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(injectAndroidKeycode)).toHaveBeenCalledWith(ANDROID_SERIAL, 279);
  });

  it("open server throws: warns and falls back to the clipboard + keycode path", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    openApi.typeText.mockRejectedValueOnce(new Error("open boom"));
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const tool = makeTool(openApi);

    const result = await tool.execute({}, { udid: ANDROID_SERIAL, text: "z" });

    expect(result).toEqual({ pasted: true });
    expect(openApi.typeText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setSimulatorClipboardText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(injectAndroidKeycode)).toHaveBeenCalledWith(ANDROID_SERIAL, 279);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("[paste.android] open-device-server"));
  });
});
