import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFailureSignal } from "@argent/registry";

// Only the hdc transport is faked. Everything between the tool and the wire -
// the render-service parse, the normalized-to-pixel conversion, the duration-to-
// velocity conversion and the velocity clamp - runs for real and is read back
// off the `uitest` command line these tests capture.
vi.mock("../src/utils/harmony-hdc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-hdc")>()),
  runHdcShell: vi.fn(),
}));

// Keep the real module (blueprints import from it too) but neutralise the
// fire-and-forget WebSocket send, so a HarmonyOS swipe that wrongly reached this
// transport shows up as an unexpected call rather than a socket error.
vi.mock("../src/utils/simulator-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/simulator-client")>()),
  sendCommand: vi.fn(),
}));

// The HarmonyOS branch preflights `hdc`; stub it so these tests don't depend on
// a HarmonyOS toolchain being installed on the test host.
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDep: vi.fn(async () => {}),
}));

import { gestureSwipeTool } from "../src/tools/gesture-swipe";
import { ensureDep } from "../src/utils/check-deps";
import { runHdcShell as realRunHdcShell } from "../src/utils/harmony-hdc";
import { sendCommand } from "../src/utils/simulator-client";

const runHdcShell = vi.mocked(realRunHdcShell);

const CONNECT_KEY = "025DEK236V035771";
const HARMONY_UDID = `harmony-${CONNECT_KEY}`;
const services = {} as never;

// Deliberately non-square: a transposed width/height moves all four coordinates
// below, so a `toDevicePoint` fed the wrong axis cannot pass.
const DISPLAY_WIDTH = 1200;
const DISPLAY_HEIGHT = 2000;

// 0.25/0.9 lands on (300, 1800) and 0.75/0.5 on (900, 1000) - four distinct
// values, so a swapped x/y is visible too. The 600x800 leg makes the travel
// exactly 1000px, which keeps every expected velocity below a whole number.
const base = { udid: HARMONY_UDID, fromX: 0.25, fromY: 0.9, toX: 0.75, toY: 0.5 };

beforeEach(() => {
  vi.mocked(sendCommand).mockClear();
  vi.mocked(ensureDep).mockClear();
  runHdcShell.mockReset();
  runHdcShell.mockImplementation(async (_connectKey, command) =>
    command.startsWith("hidumper")
      ? {
          stdout: `render resolution=${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}\npowerStatus=POWER_STATUS_ON`,
          exitCode: 0,
        }
      : { stdout: "No Error", exitCode: 0 }
  );
});

/** The single `uitest uiInput …` line the swipe put on the wire, and who it went to. */
function uiInput(): { connectKey: string; command: string } {
  const calls = runHdcShell.mock.calls.filter(([, cmd]) => cmd.startsWith("uitest uiInput"));
  expect(calls).toHaveLength(1);
  return { connectKey: calls[0][0], command: calls[0][1] };
}

/** The trailing velocity argument, which `uitest` takes in place of a duration. */
function velocity(): number {
  return Number(uiInput().command.split(" ").at(-1));
}

describe("gesture-swipe on HarmonyOS", () => {
  it("sends the `fling` verb when not settling, at the converted pixel endpoints", async () => {
    await expect(
      gestureSwipeTool.execute(services, { ...base, durationMs: 500 })
    ).resolves.toMatchObject({ swiped: true });

    // 1000px of travel in 0.5s is 2000px/s. The whole line is asserted because
    // `uitest` validates almost nothing: a swapped from/to, a transposed display
    // axis or a reordered velocity argument all still exit 0 on-device.
    expect(uiInput().command).toBe("uitest uiInput fling 300 1800 900 1000 2000");

    runHdcShell.mockClear();
    await gestureSwipeTool.execute(services, { ...base, durationMs: 500, settle: false });
    expect(uiInput().command).toBe("uitest uiInput fling 300 1800 900 1000 2000");
  });

  it("sends the `swipe` verb when settling - the momentum-free one, despite the name", async () => {
    await gestureSwipeTool.execute(services, { ...base, durationMs: 500, settle: true });

    // The mapping reads backwards at a glance, so it is pinned rather than left
    // to review: `settle` asks for no fling, so it takes `swipe` (a drag ending
    // where it ends) and leaves `fling` (which hands the scroller a release
    // velocity to coast on) as the default. Inverting the ternary is silent -
    // both verbs exist, both exit 0, and only the coast distance differs.
    expect(uiInput().command).toBe("uitest uiInput swipe 300 1800 900 1000 2000");
  });

  it("clamps a too-fast swipe to uitest's velocity ceiling", async () => {
    // 1000px in 10ms is 100_000px/s. Unclamped, `uitest` answers `Invalid
    // parameters.` and the gesture does not happen at all - so this is the
    // difference between a swipe that is merely capped and one that fails.
    await gestureSwipeTool.execute(services, { ...base, durationMs: 10 });

    expect(velocity()).toBe(40_000);
  });

  it("clamps a too-slow swipe to uitest's velocity floor", async () => {
    // The other rejected end: 1000px over 20s is 50px/s. A clamp written with
    // only one bound leaves this one out of range.
    await gestureSwipeTool.execute(services, { ...base, durationMs: 20_000 });

    expect(velocity()).toBe(200);
  });

  it("addresses the device by its hdc connect key, and never over the sim-server", async () => {
    await gestureSwipeTool.execute(services, { ...base, durationMs: 500 });

    // `hdc -t` takes what `hdc list targets` reports, not argent's `harmony-`
    // prefixed id - passing the id through reaches no target at all.
    expect(uiInput().connectKey).toBe(CONNECT_KEY);
    // Preflighted, so a missing connector is a 424 install hint rather than a
    // 500 from deeper in the hdc path.
    expect(ensureDep).toHaveBeenCalledWith("hdc");
    // Dropping the branch's `return` would fall through to the interpolation
    // loop and push a Down/Move/Up train at a `services.simulatorServer` no
    // HarmonyOS device is behind, while still resolving `{ swiped: true }`.
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("refuses to swipe while the display is suspended, injecting nothing", async () => {
    // `uitest uiInput` answers `No Error` and exits 0 against a suspended panel
    // (measured), so without the guard the swipe resolves `{swiped: true}` for a
    // gesture that landed nowhere — and a scroll-until-found loop runs to its
    // limit against a screen that never moved. Driven through the real
    // `powerStatus` parse rather than a stubbed struct, since that string is the
    // only thing standing between the two outcomes.
    runHdcShell.mockImplementation(async (_connectKey, command) =>
      command.startsWith("hidumper")
        ? {
            stdout: `render resolution=${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}\npowerStatus=POWER_STATUS_SUSPEND`,
            exitCode: 0,
          }
        : { stdout: "No Error", exitCode: 0 }
    );

    const err = await gestureSwipeTool.execute(services, base).then(
      () => {
        throw new Error("expected the swipe to reject, but it resolved");
      },
      (e: unknown) => e
    );

    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_screen_off");
    expect((err as Error).message).toMatch(/Wake it with `button` \(power\)/);
    expect(runHdcShell.mock.calls.filter(([, c]) => c.startsWith("uitest uiInput"))).toHaveLength(
      0
    );
  });

  it("does not declare the simulator-server service for a HarmonyOS target", () => {
    // Resolving the blueprint would spawn a backend this path never uses and
    // block on its ready-wait before the hdc call could start.
    expect(gestureSwipeTool.services(base)).toEqual({});
  });
});
