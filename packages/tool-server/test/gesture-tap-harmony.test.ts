import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFailureSignal } from "@argent/registry";

// Only the two transport calls are stubbed; `toDevicePoint` stays real so the
// asserted pixel values are the ones a device would actually be handed.
vi.mock("../src/utils/harmony-uitest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-uitest")>()),
  harmonyDisplay: vi.fn(),
  harmonyTouch: vi.fn(async () => {}),
}));

// The harmony branch preflights hdc; stub it so the tests don't need the
// HarmonyOS toolchain on the test host.
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDep: vi.fn(async () => {}),
}));

import { gestureTapTool } from "../src/tools/gesture-tap";
import { harmonyDisplay, harmonyTouch } from "../src/utils/harmony-uitest";
import { ensureDep } from "../src/utils/check-deps";

const CONNECT_KEY = "025DEK236V035771";
const HARMONY_UDID = `harmony-${CONNECT_KEY}`;

/** A Mate 60's render resolution — portrait, so a swapped axis is visible. */
const DISPLAY = { width: 1216, height: 2688, screenOn: true };

/** No service is resolved for a HarmonyOS tap; see the `services` block below. */
const noServices = {} as never;

const touchCalls = () => vi.mocked(harmonyTouch).mock.calls.map((c) => [c[1], c[2]] as const);

beforeEach(() => {
  vi.mocked(harmonyTouch).mockClear();
  vi.mocked(ensureDep).mockClear();
  vi.mocked(harmonyDisplay).mockReset();
  vi.mocked(harmonyDisplay).mockResolvedValue(DISPLAY);
});

describe("gesture-tap on HarmonyOS", () => {
  it("taps once with the plain `click` verb by default", async () => {
    await expect(
      gestureTapTool.execute(noServices, { udid: HARMONY_UDID, x: 0.5, y: 0.5 })
    ).resolves.toMatchObject({ tapped: true });
    expect(touchCalls()).toEqual([["click", { x: 608, y: 1344 }]]);
    // Preflighted so a missing connector fails with a 424 install hint rather
    // than a generic 500 from deeper in the hdc path.
    expect(ensureDep).toHaveBeenCalledWith("hdc");
  });

  it("sends clickCount 2 as ONE native doubleClick, not two clicks", async () => {
    await gestureTapTool.execute(noServices, {
      udid: HARMONY_UDID,
      x: 0.5,
      y: 0.5,
      clickCount: 2,
    });
    // Two timed `click` injections are not guaranteed to land inside the OS
    // double-tap window, which is the whole reason `clickCount` exists — a
    // degradation to the generic loop would still resolve `{ tapped: true }`
    // while never producing a double-tap on-device.
    expect(touchCalls()).toEqual([["doubleClick", { x: 608, y: 1344 }]]);
  });

  it("falls back to that many `click` injections above 2, paced apart", async () => {
    const startedAt = Date.now();
    await gestureTapTool.execute(noServices, {
      udid: HARMONY_UDID,
      x: 0.5,
      y: 0.5,
      clickCount: 3,
    });
    // `uitest` has no native triple-click; three clicks on the same point are
    // the only available form. A `doubleClick` slipping in here (or a dropped
    // iteration) would send the app a different gesture than was asked for.
    expect(touchCalls()).toEqual([
      ["click", { x: 608, y: 1344 }],
      ["click", { x: 608, y: 1344 }],
      ["click", { x: 608, y: 1344 }],
    ]);
    // Lower bound on the two inter-tap gaps: back-to-back injections are not a
    // multi-tap the OS can count. Load only widens this, never narrows it.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    // One display read for the whole gesture. Reading per click would insert a
    // 50-190ms hidumper round trip between taps, on top of the gap the OS
    // multi-tap window is being paced against.
    expect(harmonyDisplay).toHaveBeenCalledTimes(1);
  });

  it("converts normalized coordinates to pixels of the display it just read", async () => {
    await gestureTapTool.execute(noServices, { udid: HARMONY_UDID, x: 0.6, y: 0.35 });
    // 0.6*1216 and 0.35*2688, each rounded. The fractions are chosen so a
    // swapped axis (941, 730), a width/height mix-up (1613, 426) and a scale
    // off by one pixel (729, 940) all differ from the expected pair.
    expect(touchCalls()).toEqual([["click", { x: 730, y: 941 }]]);
  });

  it("addresses the device by its hdc connect key, not the `harmony-` prefixed id", async () => {
    await gestureTapTool.execute(noServices, { udid: HARMONY_UDID, x: 0.5, y: 0.5 });
    // `hdc -t` only knows the key it reported in `list targets`; the prefix is
    // argent's own, and passing it through reaches no device at all.
    expect(harmonyDisplay).toHaveBeenCalledWith(CONNECT_KEY);
    expect(vi.mocked(harmonyTouch).mock.calls[0][0]).toBe(CONNECT_KEY);
  });

  it("refuses to tap while the display is suspended, injecting nothing", async () => {
    // `uitest uiInput click` answers `No Error` and exits 0 against a suspended
    // panel (measured), so without this guard the tap resolves `{tapped: true}`
    // for input that landed nowhere — and the agent goes on to assert against a
    // screen it believes it just touched. `button` pins the same refusal for
    // its own presses; the two must not drift apart.
    vi.mocked(harmonyDisplay).mockResolvedValue({ ...DISPLAY, screenOn: false });

    const err = await gestureTapTool
      .execute(noServices, { udid: HARMONY_UDID, x: 0.5, y: 0.5 })
      .then(
        () => {
          throw new Error("expected the tap to reject, but it resolved");
        },
        (e: unknown) => e
      );

    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_screen_off");
    expect((err as Error).message).toMatch(/Wake it with `button` \(power\)/);
    expect(harmonyTouch).not.toHaveBeenCalled();
  });
});

describe("gesture-tap service declaration", () => {
  it("declares no simulator-server for a HarmonyOS target", () => {
    // There is no simulator-server controller behind a HarmonyOS device, so
    // declaring the blueprint would spawn a backend the tap never uses and
    // block on its ready-wait before the hdc path ever runs.
    expect(gestureTapTool.services({ udid: HARMONY_UDID, x: 0.5, y: 0.5 })).toEqual({});
  });

  it("still declares the simulator-server for an Android target", () => {
    expect(gestureTapTool.services({ udid: "emulator-5554", x: 0.5, y: 0.5 })).toHaveProperty(
      "simulatorServer"
    );
  });
});
