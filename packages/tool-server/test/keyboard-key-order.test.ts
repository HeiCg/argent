import { describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import { typeSimulatorServer } from "../src/tools/keyboard/simulator-server-keys";
import { makeChromiumImpl } from "../src/tools/keyboard/platforms/chromium";
import { vegaImpl } from "../src/tools/keyboard/platforms/vega";
import { harmonyImpl } from "../src/tools/keyboard/platforms/harmony";

vi.mock("../src/utils/vega-input", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/vega-input")>();
  return {
    ...actual,
    injectVegaText: vi.fn(async () => {}),
    injectVegaNamedKey: vi.fn(async () => {}),
  };
});

vi.mock("../src/utils/harmony-uitest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-uitest")>()),
  harmonyTypeText: vi.fn(async () => {}),
  harmonyKeyEvent: vi.fn(async () => {}),
}));

import { injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";
import { harmonyKeyEvent, harmonyTypeText } from "../src/utils/harmony-uitest";

const IOS_SIM: DeviceInfo = { id: "TEST-UDID", platform: "ios", kind: "simulator" };
const CHROMIUM: DeviceInfo = { id: "chromium-cdp-9222", platform: "chromium", kind: "app" };
const VEGA: DeviceInfo = { id: "vega-serial", platform: "vega", kind: "vvd" };
const HARMONY_CONNECT_KEY = "025DEK236V035771";
const HARMONY: DeviceInfo = {
  id: `harmony-${HARMONY_CONNECT_KEY}`,
  platform: "harmony",
  kind: "device",
};

/** `uitest uiInput keyEvent` keyID for `enter`, watched submitting a real field. */
const HARMONY_ENTER_KEYID = "2054";

const ENTER_HID_KEYCODE = 40;

function registryWith(api: unknown) {
  return { resolveService: vi.fn(async () => api) } as any;
}

// A combined text+key call means "type, then submit". Pressing the key first
// fires enter into the still-empty field, which blurs it and leaks the text to
// app-level key commands (the React Native dev menu opens on a bare "d" when
// nothing is focused) — the regression behind these tests.
describe("keyboard text+key ordering", () => {
  it("simulator-server: presses the named key after the text", async () => {
    const downs: number[] = [];
    const api = {
      pressKey: (direction: "Down" | "Up", keyCode: number) => {
        if (direction === "Down") downs.push(keyCode);
      },
    };

    const result = await typeSimulatorServer(registryWith(api), IOS_SIM, {
      udid: IOS_SIM.id,
      text: "hi",
      key: "enter",
      delayMs: 0,
    });

    expect(downs).toHaveLength(3);
    expect(downs[downs.length - 1]).toBe(ENTER_HID_KEYCODE);
    expect(result.keys).toBe(3);
  });

  it("simulator-server: rejects an unknown key before typing any text", async () => {
    const pressKey = vi.fn();

    await expect(
      typeSimulatorServer(registryWith({ pressKey }), IOS_SIM, {
        udid: IOS_SIM.id,
        text: "hi",
        key: "bogus",
        delayMs: 0,
      })
    ).rejects.toThrow(/Unknown key "bogus"/);
    expect(pressKey).not.toHaveBeenCalled();
  });

  it("chromium: dispatches the named key after the text", async () => {
    const events: Array<{ type: string; key?: string }> = [];
    const api = {
      dispatchKeyEvent: async (event: { type: string; key?: string }) => {
        events.push(event);
      },
    };

    await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, text: "hi", key: "enter", delayMs: 0 },
      CHROMIUM
    );

    const keyDowns = events.filter((e) => e.type === "keyDown").map((e) => e.key);
    expect(keyDowns).toEqual(["h", "i", "Enter"]);
  });

  it("chromium: rejects an unknown key before typing any text", async () => {
    const dispatchKeyEvent = vi.fn(async () => {});

    await expect(
      makeChromiumImpl(registryWith({ dispatchKeyEvent })).handler(
        {},
        { udid: CHROMIUM.id, text: "hi", key: "bogus", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/Unknown key "bogus"/);
    expect(dispatchKeyEvent).not.toHaveBeenCalled();
  });

  it("vega: injects the named key after the text", async () => {
    const order: string[] = [];
    vi.mocked(injectVegaText).mockImplementationOnce(async () => {
      order.push("text");
    });
    vi.mocked(injectVegaNamedKey).mockImplementationOnce(async () => {
      order.push("key");
    });

    await vegaImpl.handler({}, { udid: VEGA.id, text: "hi", key: "enter" }, VEGA);

    expect(order).toEqual(["text", "key"]);
  });

  it("vega: rejects an unknown key before typing any text", async () => {
    vi.mocked(injectVegaText).mockClear();
    vi.mocked(injectVegaNamedKey).mockClear();

    await expect(
      vegaImpl.handler({}, { udid: VEGA.id, text: "hi", key: "bogus" }, VEGA)
    ).rejects.toThrow(/Unknown Vega key "bogus"/);
    expect(injectVegaText).not.toHaveBeenCalled();
    expect(injectVegaNamedKey).not.toHaveBeenCalled();
  });

  it("harmony: injects the named key after the text, addressed by connect key", async () => {
    const order: string[] = [];
    vi.mocked(harmonyTypeText)
      .mockClear()
      .mockImplementationOnce(async () => {
        order.push("text");
      });
    vi.mocked(harmonyKeyEvent)
      .mockClear()
      .mockImplementationOnce(async () => {
        order.push("key");
      });

    const result = await harmonyImpl.handler(
      {},
      { udid: HARMONY.id, text: "hi", key: "enter" },
      HARMONY
    );

    expect(order).toEqual(["text", "key"]);
    expect(harmonyTypeText).toHaveBeenCalledWith(HARMONY_CONNECT_KEY, "hi");
    // The keyID, not the key name — `uitest` names only Home/Back/Power and
    // takes a raw number for everything else.
    expect(harmonyKeyEvent).toHaveBeenCalledWith(HARMONY_CONNECT_KEY, HARMONY_ENTER_KEYID);
    // Two characters plus the key press.
    expect(result.keys).toBe(3);
  });

  it("harmony: rejects an unknown key before typing any text", async () => {
    vi.mocked(harmonyTypeText).mockClear();
    vi.mocked(harmonyKeyEvent).mockClear();

    await expect(
      harmonyImpl.handler({}, { udid: HARMONY.id, text: "hi", key: "bogus" }, HARMONY)
    ).rejects.toThrow(/'bogus' is not available on HarmonyOS/);
    expect(harmonyTypeText).not.toHaveBeenCalled();
    expect(harmonyKeyEvent).not.toHaveBeenCalled();
  });

  it("harmony: case-folds the named key, like every other backend", async () => {
    vi.mocked(harmonyKeyEvent).mockClear();

    await harmonyImpl.handler({}, { udid: HARMONY.id, key: "Enter" }, HARMONY);

    expect(harmonyKeyEvent).toHaveBeenCalledWith(HARMONY_CONNECT_KEY, HARMONY_ENTER_KEYID);
  });
});
