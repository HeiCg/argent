import { describe, it, expect, vi } from "vitest";
import { Registry, FAILURE_CODES, getFailureSignal, type DeviceInfo } from "@argent/registry";
import { InvalidToolInputError, UnsupportedOperationError } from "../src/utils/capability";
import { typeTv } from "../src/tools/keyboard/platforms/tv";
import { vegaImpl } from "../src/tools/keyboard/platforms/vega";
import { typeSimulatorServer } from "../src/tools/keyboard/simulator-server-keys";
import { makeChromiumImpl } from "../src/tools/keyboard/platforms/chromium";
import { injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";
import { injectAndroidNamedKey, injectAndroidText } from "../src/utils/android-input";

// The `keyboard` tool's `key` is a free `z.string()` and its `text` is a free
// string, so an unknown named key or an un-typeable character passes zod
// validation but is a *caller* mistake, not an internal fault. The HTTP layer
// maps InvalidToolInputError → 400 and anything else → 500. Before this, the
// non-Android backends threw a plain `Error` (pre-#420) / a `FailureError`
// (post-#420) — both surfaced as 500, so `key: "pageup"` returned 400 on Android
// but 500 on iOS / chromium / vega (hubgan review). These pins keep every
// keyboard backend's input-rejection uniform: a 400-mapping InvalidToolInputError
// that STILL carries #420's granular telemetry code (the 400 mapping keys off the
// error class, not the code — see InvalidToolInputError in utils/capability.ts).

/** Assert the error is a 400-class input error carrying the given telemetry code. */
async function expectInvalidInput(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => {
      throw new Error("expected the call to reject, but it resolved");
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(InvalidToolInputError);
  expect(getFailureSignal(err)?.error_code).toBe(code);
}

function iosRegistry(): Registry {
  const registry = new Registry();
  vi.spyOn(registry, "resolveService").mockResolvedValue({ pressKey: vi.fn() } as never);
  return registry;
}
function chromiumRegistry(): Registry {
  const registry = new Registry();
  vi.spyOn(registry, "resolveService").mockResolvedValue({
    dispatchKeyEvent: vi.fn(async () => {}),
  } as never);
  return registry;
}
const iosDevice = { id: "AAAA", platform: "ios", kind: "simulator" } as unknown as DeviceInfo;
const chromiumDevice = {
  id: "chromium-cdp-9222",
  platform: "chromium",
  kind: "app",
} as unknown as DeviceInfo;

describe("keyboard backends — input rejection is a 400 with a uniform telemetry taxonomy", () => {
  it("iOS: unknown key → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    await expectInvalidInput(
      typeSimulatorServer(iosRegistry(), iosDevice, { udid: iosDevice.id, key: "pageup" }),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("iOS: un-typeable character → 400 + KEYBOARD_CHARACTER_UNSUPPORTED", async () => {
    await expectInvalidInput(
      typeSimulatorServer(iosRegistry(), iosDevice, { udid: iosDevice.id, text: "😀" }),
      FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED
    );
  });

  it("chromium: unknown key → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    const impl = makeChromiumImpl(chromiumRegistry());
    await expectInvalidInput(
      impl.handler({}, { udid: chromiumDevice.id, key: "pageup" }, chromiumDevice),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("chromium: un-typeable character → 400 + KEYBOARD_CHARACTER_UNSUPPORTED", async () => {
    const impl = makeChromiumImpl(chromiumRegistry());
    await expectInvalidInput(
      impl.handler({}, { udid: chromiumDevice.id, text: "😀" }, chromiumDevice),
      FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED
    );
  });

  it("vega: unknown key → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    await expectInvalidInput(injectVegaNamedKey("pageup"), FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED);
  });

  it("vega: newline in text → 400 + VEGA_TEXT_INVALID", async () => {
    await expectInvalidInput(injectVegaText("a\nb"), FAILURE_CODES.VEGA_TEXT_INVALID);
  });

  it("android: unknown key → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    // adbShell is never reached — the unknown key is rejected before injection.
    await expectInvalidInput(
      injectAndroidNamedKey("emulator-5554", "pageup"),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("android: un-typeable character → 400 + KEYBOARD_CHARACTER_UNSUPPORTED", async () => {
    // Same granular bucket as the iOS/chromium un-typeable-character
    // rejections above — not the generic TOOL_INPUT_INVALID (hubgan review).
    // adbShell is never reached: the guard rejects before injection.
    await expectInvalidInput(
      injectAndroidText("emulator-5554", "café"),
      FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED
    );
  });

  it("android: newline in text → 400 + KEYBOARD_CHARACTER_UNSUPPORTED", async () => {
    // A newline is a character this backend can't type, so it buckets with the
    // un-typeable-character rejections.
    await expectInvalidInput(
      injectAndroidText("emulator-5554", "a\nb"),
      FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED
    );
  });

  // `key` is a free string, so a prototype-chain name ("constructor",
  // "__proto__", …) must be rejected as an unknown key on every backend rather
  // than slipping through an object lookup with a garbage value and going over
  // the wire as a broken press. Pin the 400 + KEYBOARD_KEY_UNSUPPORTED bucket
  // for a representative prototype key on each backend.
  it("iOS: prototype-chain key name → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    await expectInvalidInput(
      typeSimulatorServer(iosRegistry(), iosDevice, { udid: iosDevice.id, key: "constructor" }),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("chromium: prototype-chain key name → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    const impl = makeChromiumImpl(chromiumRegistry());
    await expectInvalidInput(
      impl.handler({}, { udid: chromiumDevice.id, key: "constructor" }, chromiumDevice),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("vega: prototype-chain key name → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    await expectInvalidInput(
      injectVegaNamedKey("constructor"),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("android: prototype-chain key name → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    await expectInvalidInput(
      injectAndroidNamedKey("emulator-5554", "constructor"),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });
});

// `clear` adds two rejection shapes of its own, and they are deliberately
// different classes. A target that cannot clear at all is a CAPABILITY refusal
// (`UnsupportedOperationError`, the same shape a TV `key` gets); a page with
// nothing editable focused is a caller mistake whose repair is one `gesture-tap`
// (`InvalidToolInputError`). Both map to HTTP 400, so only the code separates
// them in telemetry — an agent that retried a Vega clear forever and one that
// forgot to focus the field must not land in the same bucket.
describe("keyboard `clear` — refusal taxonomy", () => {
  const APPLE_TV: DeviceInfo = { id: "TV-UDID", platform: "ios", kind: "simulator" };
  const ANDROID_TV: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };
  const VEGA: DeviceInfo = { id: "vega-serial", platform: "vega", kind: "vvd" };

  /** Assert the error is the capability refusal, carrying its telemetry code. */
  async function expectUnsupported(p: Promise<unknown>): Promise<Error> {
    const err = await p.then(
      () => {
        throw new Error("expected the call to reject, but it resolved");
      },
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(UnsupportedOperationError);
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.TOOL_CAPABILITY_UNSUPPORTED_OPERATION
    );
    return err;
  }

  it.each([
    ["Apple TV", APPLE_TV],
    ["Android TV", ANDROID_TV],
  ])("%s: clear → capability refusal, before the TV service is resolved", async (_l, device) => {
    // `resolveTvApi` is NOT stubbed in this file, so a backend that fell through
    // to the daemon would try to spawn it and fail with something else — which
    // is itself the observation that the rejection came first.
    const err = await expectUnsupported(
      typeTv({} as Registry, device, { udid: device.id, clear: true })
    );
    // The remedy has to be TV-shaped: there is no `clear` on a TV, and the way a
    // person empties a field there is the app's own on-screen keyboard.
    expect(err.message).toMatch(/`clear` is not supported on a TV target/);
    expect(err.message).toMatch(/tv-remote/);
  });

  it("vega: clear → capability refusal naming the on-screen keyboard", async () => {
    const err = await expectUnsupported(vegaImpl.handler({}, { udid: VEGA.id, clear: true }, VEGA));
    expect(err.message).toMatch(/`clear` is not supported on Vega/);
  });

  it("chromium: nothing editable focused → 400 + KEYBOARD_CLEAR_NO_EDITABLE_FOCUS", async () => {
    // Its own code, not KEYBOARD_KEY_UNSUPPORTED / CHARACTER_UNSUPPORTED: this
    // is the only keyboard rejection about the state of the PAGE rather than
    // about the request, and the repair is a tap, not a different argument.
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      evaluate: vi.fn(async () => ({ cleared: false, focus: "body" })),
    } as never);
    await expectInvalidInput(
      makeChromiumImpl(registry).handler(
        {},
        { udid: chromiumDevice.id, clear: true },
        chromiumDevice
      ),
      FAILURE_CODES.KEYBOARD_CLEAR_NO_EDITABLE_FOCUS
    );
  });

  it("chromium: the refusal names what holds focus and how to fix it", async () => {
    // The two halves an agent acts on. Without the focused tag it cannot tell
    // "I never tapped the field" from "my tap landed on the label"; without the
    // tap instruction the obvious move is to retry the same call.
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      evaluate: vi.fn(async () => ({ cleared: false, focus: "button" })),
    } as never);
    const err = await makeChromiumImpl(registry)
      .handler({}, { udid: chromiumDevice.id, clear: true }, chromiumDevice)
      .then(
        () => {
          throw new Error("expected the clear to reject");
        },
        (e: unknown) => e as Error
      );
    expect(err.message).toMatch(/<button>/);
    expect(err.message).toMatch(/gesture-tap/);
    // The iframe blind spot is named in the same message, because `iframe` is
    // the one `focus` value whose repair is NOT "tap harder".
    expect(err.message).toMatch(/iframe/);
  });

  it("chromium: a null focus reads as no focus at all, not as an element", async () => {
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      evaluate: vi.fn(async () => ({ cleared: false, focus: null })),
    } as never);
    const err = await makeChromiumImpl(registry)
      .handler({}, { udid: chromiumDevice.id, clear: true }, chromiumDevice)
      .then(
        () => {
          throw new Error("expected the clear to reject");
        },
        (e: unknown) => e as Error
      );
    expect(err.message).toMatch(/no element has keyboard focus/);
    expect(err.message).not.toMatch(/<null>/);
  });

  it("chromium: a field that kept its value → 400 + KEYBOARD_CLEAR_UNSUPPORTED_FIELD", async () => {
    // A different code from the focus refusal, because the repair is different:
    // the caller DID focus the right field, and no amount of tapping fixes it.
    // Chromium's date/time inputs pass every editability signal the script can
    // read and still keep their value, so `execCommand("delete")` answering
    // false is the only evidence — and it must not be reported as a success.
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      evaluate: vi.fn(async () => ({
        cleared: false,
        focus: "input type=date",
        reason: "delete-refused",
      })),
    } as never);
    await expectInvalidInput(
      makeChromiumImpl(registry).handler(
        {},
        { udid: chromiumDevice.id, clear: true },
        chromiumDevice
      ),
      FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_FIELD
    );
  });

  it("chromium: the kept-value refusal names the field and a repair that works", async () => {
    // "Tap the field first" is the WRONG advice here and would loop an agent
    // forever. The repair measured on Chrome 151 is one backspace on the field
    // that already has focus, so that is what the message has to say.
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      evaluate: vi.fn(async () => ({
        cleared: false,
        focus: "input type=date",
        reason: "delete-refused",
      })),
    } as never);
    const err = await makeChromiumImpl(registry)
      .handler({}, { udid: chromiumDevice.id, clear: true }, chromiumDevice)
      .then(
        () => {
          throw new Error("expected the clear to reject");
        },
        (e: unknown) => e as Error
      );
    expect(err.message).toMatch(/<input type=date>/);
    expect(err.message).toMatch(/kept its value/);
    expect(err.message).toMatch(/{ key: "backspace" }/);
    // ...and NOT the focus remedy, which is what the other refusal prescribes.
    expect(err.message).not.toMatch(/gesture-tap/);
  });

  it("chromium: a renderer answer with no `cleared` is a refusal, not a success", async () => {
    // `evaluate` resolves `undefined` when the expression throws under
    // `returnByValue`, or when the page navigates mid-call. Reading that as a
    // success would report `cleared: true` for a field that still holds its
    // value — the exact failure mode the whole design refuses to have.
    for (const answer of [undefined, null, {}, { cleared: "yes" }]) {
      const registry = new Registry();
      vi.spyOn(registry, "resolveService").mockResolvedValue({
        evaluate: vi.fn(async () => answer),
      } as never);
      await expectInvalidInput(
        makeChromiumImpl(registry).handler(
          {},
          { udid: chromiumDevice.id, clear: true },
          chromiumDevice
        ),
        FAILURE_CODES.KEYBOARD_CLEAR_NO_EDITABLE_FOCUS
      );
    }
  });
});
