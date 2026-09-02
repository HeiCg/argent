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
const KEYCODE_PASTE = 279;

// Merged (phase-3b clipboard-first + Screen-graph Phase A outcomes): the open
// path first tries a genuine device-clipboard write + KEYCODE_PASTE; when the
// clipboard write is dropped it types the text via `typeTextWithOutcome` and
// surfaces the before/after fingerprint delta additively on the result.
const OUTCOME = {
  before: { version: 1, hash: "aaaa", stateHash: "aaaa" },
  after: { version: 2, hash: "aaaa", stateHash: "bbbb" },
  changed: true,
  newScreen: false,
  idleMs: 12,
};

function makeOpenApi() {
  return {
    setClipboard: vi.fn(async (text: string) => ({ success: true, text })),
    typeTextWithOutcome: vi.fn(async (text: string) => ({
      success: true,
      charsTyped: text.length,
      ...OUTCOME,
    })),
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
    expect(openApi.typeTextWithOutcome).not.toHaveBeenCalled();
    expect(vi.mocked(setSimulatorClipboardText)).not.toHaveBeenCalled();
  });

  it("clipboard unavailable (API 35), typeable text: falls back to typing on the open server and returns the outcome", async () => {
    flagEnabledMock = (n) => n === "open-device-server";
    const openApi = makeOpenApi();
    // ClipboardManager silently dropped the background write.
    openApi.setClipboard.mockResolvedValue({ success: false, text: "" });
    const tool = makeTool(openApi);

    const url = "https://example.com/reset?token=abcdef0123456789";
    const result = await tool.execute({}, { udid: ANDROID_SERIAL, text: url });

    expect(result).toEqual({ pasted: true, outcome: OUTCOME });
    expect(openApi.setClipboard).toHaveBeenCalledWith(url);
    expect(openApi.typeTextWithOutcome).toHaveBeenCalledWith(url, undefined);
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
    expect(openApi.typeTextWithOutcome).not.toHaveBeenCalled();
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
    expect(openApi.typeTextWithOutcome).not.toHaveBeenCalled();
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

    // Fallback path carries no outcome (the clipboard+keycode path has no fingerprint).
    expect(result).toEqual({ pasted: true });
    expect(openApi.setClipboard).toHaveBeenCalledTimes(1);
    expect(openApi.typeTextWithOutcome).not.toHaveBeenCalled();
    expect(vi.mocked(setSimulatorClipboardText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(injectAndroidKeycode)).toHaveBeenCalledWith(ANDROID_SERIAL, KEYCODE_PASTE);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("[paste.android] open-device-server"));
  });
});
