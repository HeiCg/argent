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
import { __resetOpenServerClipboardCache } from "../src/utils/open-server-clipboard-cache";

const ANDROID_SERIAL = "emulator-5554";
const KEYCODE_PASTE = 279;

function makeOpenApi() {
  return {
    setClipboard: vi.fn(async (text: string) => ({ success: true, text })),
    typeText: vi.fn(async (text: string) => ({ success: true, charsTyped: text.length })),
  };
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
  // The clipboard-unsupported cache (R3) is module-level and persists across
  // tests; reset it so each test starts with the clipboard un-probed.
  __resetOpenServerClipboardCache();
});
afterEach(() => vi.restoreAllMocks());

describe("paste (android) → open-device-server (F20)", () => {
  it("clipboard write succeeds: pastes via KEYCODE_PASTE, never types, never touches the proprietary path", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    const tool = makeTool(openApi);

    const url = "https://example.com/reset?token=abcdef0123456789";
    const result = await tool.execute({}, { udid: ANDROID_SERIAL, text: url });

    expect(result).toEqual({ pasted: true });
    expect(openApi.setClipboard).toHaveBeenCalledWith(url);
    expect(vi.mocked(injectAndroidKeycode)).toHaveBeenCalledWith(ANDROID_SERIAL, KEYCODE_PASTE);
    expect(openApi.typeText).not.toHaveBeenCalled();
    expect(vi.mocked(setSimulatorClipboardText)).not.toHaveBeenCalled();
  });

  it("clipboard unavailable (API 35), typeable text: falls back to typing on the open server", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    // ClipboardManager silently dropped the background write.
    openApi.setClipboard.mockResolvedValue({ success: false, text: "" });
    const tool = makeTool(openApi);

    const url = "https://example.com/reset?token=abcdef0123456789";
    const result = await tool.execute({}, { udid: ANDROID_SERIAL, text: url });

    expect(result).toEqual({ pasted: true });
    expect(openApi.setClipboard).toHaveBeenCalledWith(url);
    expect(openApi.typeText).toHaveBeenCalledWith(url);
    // No keycode paste (nothing on the clipboard) and no proprietary fallback.
    expect(vi.mocked(injectAndroidKeycode)).not.toHaveBeenCalled();
    expect(vi.mocked(setSimulatorClipboardText)).not.toHaveBeenCalled();
  });

  it("clipboard unavailable + emoji (not typeable): falls back to the proprietary clipboard path", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    openApi.setClipboard.mockResolvedValue({ success: false, text: "" });
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const tool = makeTool(openApi);

    const result = await tool.execute({}, { udid: ANDROID_SERIAL, text: "party 🎉 time" });

    expect(result).toEqual({ pasted: true });
    expect(openApi.setClipboard).toHaveBeenCalledTimes(1);
    // Emoji can't be typed on the open server, so it goes to the proprietary path.
    expect(openApi.typeText).not.toHaveBeenCalled();
    expect(vi.mocked(setSimulatorClipboardText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(injectAndroidKeycode)).toHaveBeenCalledWith(ANDROID_SERIAL, KEYCODE_PASTE);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("[paste.android] open-device-server"));
  });

  it("flag off: never touches the open server, sets clipboard + KEYCODE_PASTE", async () => {
    flagEnabledMock = () => false;
    const openApi = makeOpenApi();
    const tool = makeTool(openApi);

    await tool.execute({}, { udid: ANDROID_SERIAL, text: "hi" });

    expect(openApi.setClipboard).not.toHaveBeenCalled();
    expect(openApi.typeText).not.toHaveBeenCalled();
    expect(vi.mocked(setSimulatorClipboardText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(injectAndroidKeycode)).toHaveBeenCalledWith(ANDROID_SERIAL, KEYCODE_PASTE);
  });

  it("open server setClipboard throws: warns and falls back to the proprietary path", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    openApi.setClipboard.mockRejectedValueOnce(new Error("open boom"));
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const tool = makeTool(openApi);

    const result = await tool.execute({}, { udid: ANDROID_SERIAL, text: "z" });

    expect(result).toEqual({ pasted: true });
    expect(openApi.setClipboard).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setSimulatorClipboardText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(injectAndroidKeycode)).toHaveBeenCalledWith(ANDROID_SERIAL, KEYCODE_PASTE);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("[paste.android] open-device-server"));
  });

  it("R3: after clipboard proves unsupported, a later paste skips setClipboard and types directly", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    // ClipboardManager silently drops the background write on this device.
    openApi.setClipboard.mockResolvedValue({ success: false, text: "" });
    const tool = makeTool(openApi);

    const first = "https://example.com/a?token=abcdef0123456789";
    const second = "https://example.com/b?token=9876543210fedcba";

    // First paste probes the clipboard (one RPC), learns it does not round-trip.
    await tool.execute({}, { udid: ANDROID_SERIAL, text: first });
    expect(openApi.setClipboard).toHaveBeenCalledTimes(1);
    expect(openApi.typeText).toHaveBeenCalledWith(first);

    // Second paste on the SAME device must not re-attempt setClipboard.
    await tool.execute({}, { udid: ANDROID_SERIAL, text: second });
    expect(openApi.setClipboard).toHaveBeenCalledTimes(1); // still 1 — cached
    expect(openApi.typeText).toHaveBeenCalledWith(second);
    expect(vi.mocked(setSimulatorClipboardText)).not.toHaveBeenCalled();
  });

  it("R3: a successful clipboard write never marks the device unsupported", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi(); // setClipboard succeeds by default
    const tool = makeTool(openApi);

    const first = "https://example.com/a";
    const second = "https://example.com/b";

    await tool.execute({}, { udid: ANDROID_SERIAL, text: first });
    await tool.execute({}, { udid: ANDROID_SERIAL, text: second });

    // Both pastes attempt (and win) the clipboard; neither falls back to typing.
    expect(openApi.setClipboard).toHaveBeenCalledTimes(2);
    expect(openApi.typeText).not.toHaveBeenCalled();
    expect(vi.mocked(injectAndroidKeycode)).toHaveBeenCalledTimes(2);
  });

  it("R3: a transport error (reject) does NOT mark unsupported — next paste re-attempts the clipboard", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const tool = makeTool(openApi);

    // First paste: setClipboard throws (transport), falls back to proprietary.
    openApi.setClipboard.mockRejectedValueOnce(new Error("open boom"));
    await tool.execute({}, { udid: ANDROID_SERIAL, text: "one" });
    expect(openApi.setClipboard).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setSimulatorClipboardText)).toHaveBeenCalledTimes(1);

    // Second paste: clipboard was NOT marked unsupported, so it re-attempts and,
    // this time round-tripping, pastes via KEYCODE_PASTE on the open path.
    await tool.execute({}, { udid: ANDROID_SERIAL, text: "two" });
    expect(openApi.setClipboard).toHaveBeenCalledTimes(2);
    expect(openApi.setClipboard).toHaveBeenLastCalledWith("two");
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("[paste.android] open-device-server"));
  });
});
