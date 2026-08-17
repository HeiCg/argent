import { describe, expect, it, vi } from "vitest";
import { getFailureSignal } from "@argent/registry";

const runHdcShell = vi.fn(async (_key: string, _cmd: string, _timeoutMs?: number) => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
}));

vi.mock("../src/utils/harmony-hdc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-hdc")>()),
  runHdcShell: (...args: Parameters<typeof runHdcShell>) => runHdcShell(...args),
}));

import { harmonyDisplay } from "../src/utils/harmony-uitest";

const CONNECT_KEY = "127.0.0.1:5557";

/**
 * The real `hidumper -s RenderService -a screen` output, captured off a booted
 * HarmonyOS 6.1.1 emulator — including the lines around the one that matters,
 * since `supportedMode[0]: 1320x2856` is a size on its own line and a looser
 * parse would read it as the panel.
 */
function dump(...screens: string[]): string {
  return [
    "",
    "-------------------------------[ability]-------------------------------",
    "",
    "----------------------------------RenderService----------------------------------",
    "-- ScreenInfo",
    ...screens,
    "supportedMode[0]: 1320x2856, refreshRate=60",
    "activeMode: 1320x2856, refreshRate=60",
    "name=express_display, phyWidth=78, phyHeight=163, supportLayers=10, virtualDispCount=1",
    "isSamplingOn=0, samplingScale=1.00, samplingTranslateX=0.00, samplingTranslateY=0.00",
    "",
  ].join("\n");
}

/** One panel's line, in the field order the render service prints it. */
function screenLine(index: number, power: string, size: string): string {
  return (
    `screen[${index}]: id=${index}, powerStatus=${power}, backlight=1, ` +
    `screenType=EXTERNAL_TYPE, render resolution=${size}, physical resolution=${size}, ` +
    `isVirtual=false, skipFrameInterval=1, expectedRefreshRate=-1, skipFrameStrategy=0`
  );
}

const AWAKE = screenLine(0, "POWER_STATUS_ON", "1320x2856");

function answer(stdout: string): void {
  runHdcShell.mockReset();
  runHdcShell.mockResolvedValue({ stdout, stderr: "", exitCode: 0 });
}

// Every HarmonyOS input tool gates on this one read, and `uitest uiInput`
// answers `No Error` for a touch that landed nowhere — so a misparse here is a
// tool reporting input it never delivered, or refusing input it could have.
describe("harmonyDisplay", () => {
  it("reads the size and the power state a booted device reports", async () => {
    answer(dump(AWAKE));

    // Literals, not a re-derivation of the fixture: the emulator was measured at
    // 1320x2856, and `physical resolution` on the same line is the same numbers,
    // so a parse that took the wrong field would still look right against itself.
    await expect(harmonyDisplay(CONNECT_KEY)).resolves.toEqual({
      width: 1320,
      height: 2856,
      screenOn: true,
    });
  });

  it("reports a suspended panel from the same dump", async () => {
    // Measured: `power-shell suspend` flips this field and leaves every other
    // one — the resolution included — exactly as it was. So the size is still
    // readable while the screen is off, and the two states are distinguished by
    // this field alone.
    answer(dump(screenLine(0, "POWER_STATUS_OFF", "1320x2856")));

    await expect(harmonyDisplay(CONNECT_KEY)).resolves.toEqual({
      width: 1320,
      height: 2856,
      screenOn: false,
    });
  });

  it("takes the size and the power state off the SAME panel", async () => {
    // A foldable's second half, or a cast display, sleeping while the panel
    // being driven is awake. Scanning the whole dump for `POWER_STATUS_OFF`
    // reports this device asleep and refuses every gesture on it, with advice
    // ("wake it with `button` (power)") that changes nothing.
    answer(dump(AWAKE, screenLine(1, "POWER_STATUS_OFF", "720x1200")));

    await expect(harmonyDisplay(CONNECT_KEY)).resolves.toEqual({
      width: 1320,
      height: 2856,
      screenOn: true,
    });
  });

  it("refuses a dump whose panel line carries no power state", async () => {
    // Both fields or neither. Defaulting an unparsed power state to "on" is the
    // one answer that lets a suspended panel through every input tool, so a
    // dump this parser does not understand is an error rather than a guess.
    answer(dump("screen[0]: id=0, render resolution=1320x2856"));

    const err = await harmonyDisplay(CONNECT_KEY).then(
      () => {
        throw new Error("expected a power-less dump to be refused");
      },
      (e: unknown) => e as Error
    );
    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_display_size");
    expect(err.message).toContain(CONNECT_KEY);
  });

  it("refuses a dump with no panel line at all", async () => {
    // `supportedMode[0]: 1320x2856` and `activeMode: 1320x2856` are sizes on
    // their own lines; neither is a panel, and neither carries a power state.
    answer(dump());

    await expect(harmonyDisplay(CONNECT_KEY)).rejects.toThrow(
      /Could not read the display size and power state/
    );
  });
});
