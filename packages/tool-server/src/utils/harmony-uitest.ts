import { readFile } from "node:fs/promises";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { hdcFileRecv, runHdcShell, shellQuote } from "./harmony-hdc";

/**
 * Driver for `uitest`, the on-device binary that is HarmonyOS' entire UI
 * automation surface — `uiautomator`, `screencap` and `input` in one:
 *
 *   uitest dumpLayout -p <path>                    the accessibility tree, as JSON
 *   uitest screenCap  -p <path>                    a PNG of the display
 *   uitest uiInput click|doubleClick|longClick     touch
 *   uitest uiInput swipe|drag|fling|dircFling      gestures
 *   uitest uiInput keyEvent <id|Back|Home|Power>   hardware keys
 *   uitest uiInput text|inputText                  typing
 *
 * Two measured properties of the tool shape everything here (hdc 3.2.0d /
 * HarmonyOS 6.0.1, on a physical Mate 60):
 *
 * - **Its exit status is trustworthy, unlike its transport's.** `hdc` exits 0
 *   for everything (see `harmony-hdc.ts`), but `uitest` itself exits 1 and names
 *   the problem — `Invalid parameters.`, `Please confirm that the coordinate
 *   values are correct.`, `The number of parameters is incorrect.` — so the
 *   status recovered by `runHdcShell` is the success signal, and `No Error` on
 *   stdout is not needed to confirm it.
 *
 * - **It validates almost nothing.** A click at `99999 99999`, far outside a
 *   1216x2688 display, returns `No Error` and exit 0 having done nothing
 *   observable. Only *negative* and non-numeric coordinates are rejected. So
 *   out-of-range coordinates are argent's to catch: `toDevicePoint` clamps into
 *   the display, which is what keeps a normalized 0-1 rounding error at the
 *   right edge from silently becoming a no-op tap.
 *
 * **Why not the simulator-server**, which is how iOS and Android reach a
 * device: neither of its controllers has a counterpart here. An Android
 * emulator is driven over the emulator's own gRPC console, and DevEco's
 * `Emulator` 6.1.1.200 is stock `ohos-qemu` behind a Qt UI — no gRPC anywhere
 * in the binary, no QEMU passthrough in its CLI, `hdc` the only host-side
 * channel it ships. An Android phone is driven by a screen-sharing agent pushed
 * over adb, which HarmonyOS has no equivalent of. What is left either way is
 * `hdc`, reaching this same `uitest` one contact at a time, from Rust instead.
 */

/** Where on-device artifacts are staged before being copied to the host. */
const REMOTE_TMP = "/data/local/tmp";

const UITEST_TIMEOUT_MS = 20_000;

/**
 * `uitest` prints its multi-line usage block after every failure. Only the
 * leading line names the actual problem, so surface that and drop the rest —
 * pasting 12 lines of usage into an agent's context buries the diagnostic.
 */
function uitestDiagnostic(stdout: string): string {
  const first = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
  return first?.trim() ?? "uitest failed without a diagnostic";
}

/** Run a `uitest` subcommand, throwing with its own diagnostic if it exits non-zero. */
async function runUitest(
  connectKey: string,
  args: string,
  timeoutMs = UITEST_TIMEOUT_MS
): Promise<string> {
  const { stdout, exitCode } = await runHdcShell(connectKey, `uitest ${args}`, timeoutMs);
  if (exitCode !== 0) {
    throw new FailureError(`uitest ${args} failed on ${connectKey}: ${uitestDiagnostic(stdout)}`, {
      error_code: FAILURE_CODES.HARMONY_UITEST_FAILED,
      failure_stage: "harmony_uitest",
      failure_area: "tool_server",
      error_kind: "subprocess",
    });
  }
  return stdout;
}

interface HarmonyDisplay {
  width: number;
  height: number;
  /** False when the display is suspended — injected touches land nowhere. */
  screenOn: boolean;
}

/**
 * Display geometry and power state, read from the render service.
 *
 * Not cached. The obvious optimisation is wrong on this platform: HarmonyOS'
 * flagship form factors are foldables, whose resolution changes when the user
 * unfolds the device, and `powerStatus` changes on any screen timeout. A cached
 * width would silently misplace every subsequent tap on the other half of a
 * fold. The call is a local service dump measured at 50-190ms, cheap enough to
 * pay per gesture rather than risk that.
 */
export async function harmonyDisplay(connectKey: string): Promise<HarmonyDisplay> {
  const { stdout } = await runHdcShell(
    connectKey,
    "hidumper -s RenderService -a screen",
    UITEST_TIMEOUT_MS
  );
  const res = /render resolution=(\d+)x(\d+)/.exec(stdout);
  if (!res) {
    throw new FailureError(
      `Could not read the display size of HarmonyOS device '${connectKey}' from the render service.`,
      {
        error_code: FAILURE_CODES.HARMONY_UITEST_FAILED,
        failure_stage: "harmony_display_size",
        failure_area: "tool_server",
        error_kind: "subprocess",
      }
    );
  }
  return {
    width: Number.parseInt(res[1], 10),
    height: Number.parseInt(res[2], 10),
    screenOn: !/powerStatus=POWER_STATUS_(OFF|SUSPEND)/.test(stdout),
  };
}

/**
 * Convert argent's normalized 0-1 coordinates to device pixels.
 *
 * Clamped to the last addressable pixel rather than the bound itself: `uitest`
 * accepts an out-of-range coordinate silently (see the header), so `y = 1.0`
 * would otherwise inject at `height`, one row past the display, and report
 * success for a touch that never happened.
 */
export function toDevicePoint(
  x: number,
  y: number,
  display: { width: number; height: number }
): { x: number; y: number } {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, Math.round(v * max)));
  return { x: clamp(x, display.width), y: clamp(y, display.height) };
}

type HarmonyTouchCommand = "click" | "doubleClick" | "longClick";

export async function harmonyTouch(
  connectKey: string,
  command: HarmonyTouchCommand,
  point: { x: number; y: number }
): Promise<void> {
  await runUitest(connectKey, `uiInput ${command} ${point.x} ${point.y}`);
}

type HarmonySwipeCommand = "swipe" | "drag" | "fling";

/**
 * `uitest` rejects a velocity outside this range with `Invalid parameters.`, so
 * callers translating a duration into a velocity must land inside it.
 */
const HARMONY_VELOCITY_MIN = 200;
const HARMONY_VELOCITY_MAX = 40_000;

async function harmonySwipe(
  connectKey: string,
  command: HarmonySwipeCommand,
  from: { x: number; y: number },
  to: { x: number; y: number },
  velocity: number
): Promise<void> {
  const v = Math.max(HARMONY_VELOCITY_MIN, Math.min(HARMONY_VELOCITY_MAX, Math.round(velocity)));
  await runUitest(connectKey, `uiInput ${command} ${from.x} ${from.y} ${to.x} ${to.y} ${v}`);
}

/**
 * Swipe between two normalized points over `durationMs`.
 *
 * `uitest` takes a **velocity**, not a duration, so the duration argent's tools
 * speak is converted here: velocity = pixels travelled / seconds. Doing it the
 * other way — passing a fixed velocity — would make a short swipe and a
 * screen-length one take wildly different times, and the callers that pace a
 * scroll loop against `durationMs` would be pacing against nothing.
 *
 * `settle` picks the verb rather than reshaping the path. `uitest` exposes both
 * `swipe` (a drag that ends where it ends) and `fling` (which hands the scroller
 * a release velocity to coast on), so the momentum-free request maps onto the
 * one the platform already means by it. That is the vendor's own distinction
 * between the two commands; the resulting difference in coast distance was not
 * measured here.
 */
export async function harmonySwipeNormalized(
  connectKey: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs: number,
  settle: boolean
): Promise<void> {
  const display = await harmonyDisplay(connectKey);
  const fromPx = toDevicePoint(from.x, from.y, display);
  const toPx = toDevicePoint(to.x, to.y, display);
  const distance = Math.hypot(toPx.x - fromPx.x, toPx.y - fromPx.y);
  const seconds = Math.max(durationMs, 1) / 1000;
  await harmonySwipe(connectKey, settle ? "swipe" : "fling", fromPx, toPx, distance / seconds);
}

export async function harmonyKeyEvent(connectKey: string, key: string): Promise<void> {
  await runUitest(connectKey, `uiInput keyEvent ${key}`);
}

/** Type into whatever currently holds focus. */
export async function harmonyTypeText(connectKey: string, text: string): Promise<void> {
  await runUitest(connectKey, `uiInput text ${shellQuote(text)}`);
}

/**
 * Run `producer` against a freshly-named path under the device's tmp directory,
 * copy the result to `localPath`, then delete the on-device copy.
 *
 * The unique name matters for more than tidiness: two tool calls racing a fixed
 * path would have one overwrite the other's capture between write and fetch, and
 * the loser would silently receive the winner's screen. The delete runs even
 * when the fetch throws — otherwise a device accumulates a multi-hundred-KB PNG
 * per failed screenshot, on a partition nothing else prunes.
 */
async function viaDeviceTmp(
  connectKey: string,
  suffix: string,
  localPath: string,
  producer: (remotePath: string) => Promise<void>
): Promise<void> {
  const remotePath = `${REMOTE_TMP}/argent-${process.pid}-${process.hrtime.bigint()}${suffix}`;
  try {
    await producer(remotePath);
    await hdcFileRecv(connectKey, remotePath, localPath);
  } finally {
    await runHdcShell(connectKey, `rm -f ${shellQuote(remotePath)}`).catch(() => {});
  }
}

/** Capture the display to `localPath` as a PNG. */
export async function harmonyScreenCap(connectKey: string, localPath: string): Promise<void> {
  await viaDeviceTmp(connectKey, ".png", localPath, async (remotePath) => {
    await runUitest(connectKey, `screenCap -p ${shellQuote(remotePath)}`);
  });
}

/** A node of the tree `uitest dumpLayout` writes. */
export interface HarmonyLayoutNode {
  attributes: Record<string, string>;
  children?: HarmonyLayoutNode[];
}

/**
 * The current UI tree.
 *
 * `-i` is deliberately not passed: without it `uitest` merges the window stack
 * into one tree and filters invisible nodes, which is the view a caller asking
 * "what is on screen" wants. The unmerged form exposes every background window
 * of every app, including ones the user cannot see.
 */
export async function harmonyDumpLayout(
  connectKey: string,
  localPath: string
): Promise<HarmonyLayoutNode> {
  await viaDeviceTmp(connectKey, ".json", localPath, async (remotePath) => {
    await runUitest(connectKey, `dumpLayout -p ${shellQuote(remotePath)}`);
  });
  const raw = await readFile(localPath, "utf8");
  try {
    return JSON.parse(raw) as HarmonyLayoutNode;
  } catch (err) {
    throw new FailureError(
      `HarmonyOS device '${connectKey}' returned a layout dump that is not valid JSON ` +
        `(${raw.length} bytes).`,
      {
        error_code: FAILURE_CODES.HARMONY_UITEST_FAILED,
        failure_stage: "harmony_dump_layout",
        failure_area: "tool_server",
        error_kind: "subprocess",
      },
      { cause: err as Error }
    );
  }
}
