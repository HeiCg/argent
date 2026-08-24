import type { IosDeviceRunnerApi } from "../../blueprints/ios-device-runner";

/**
 * Typed helpers over the Argent runner's wire commands (see
 * packages/ios-device-runner/PROTOCOL.md). Every interaction/snapshot command
 * carries `appBundleId` — the runner refuses app commands without an explicit
 * target (see app-session.ts for how the current app is tracked).
 *
 * Coordinates on the wire are absolute POINTS in `XCUIApplication.frame`
 * (the same rect describe normalizes against). Argent tools speak normalized
 * 0-1 of that full frame — including the keyboard band, matching the
 * simulator HID contract — and convert through `getViewport` + `toPoints`.
 */

export interface RunnerViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ViewportData {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/**
 * Application-frame viewport used to invert describe's 0-1 frames.
 *
 * Not cached: a stale size (keyboard shown/hidden, rotation) would map the
 * same 0-1 point onto different pixels than the last `describe`.
 */
export async function getViewport(
  api: IosDeviceRunnerApi,
  bundleId: string
): Promise<RunnerViewport> {
  const data = (await api.run(
    { command: "viewport", appBundleId: bundleId },
    { readOnly: true }
  )) as ViewportData;
  const viewport: RunnerViewport = {
    x: data.x ?? 0,
    y: data.y ?? 0,
    width: data.width ?? 0,
    height: data.height ?? 0,
  };
  if (!(viewport.width > 0) || !(viewport.height > 0)) {
    throw new Error("The app's interaction viewport is unavailable; is the app foregrounded?");
  }
  return viewport;
}

/**
 * Invert describe's normalization: `nx/ny` are fractions of `viewport`
 * (Application frame), result is an absolute point in that same space.
 */
export function toPoints(
  viewport: RunnerViewport,
  nx: number,
  ny: number
): { x: number; y: number } {
  return {
    x: viewport.x + Math.max(0, Math.min(1, nx)) * viewport.width,
    y: viewport.y + Math.max(0, Math.min(1, ny)) * viewport.height,
  };
}

/**
 * Gesture calls carry a 90s client window: the runner grants gestures a 75s
 * main-thread budget (XCTest's pre-event idle wait can legitimately stall for
 * ~60s on a screen that never reports quiescent), and the client must outlast
 * the runner's verdict rather than abandon a command that will still land.
 */
const GESTURE_TIMEOUT_MS = 90_000;

export async function tapAt(
  api: IosDeviceRunnerApi,
  bundleId: string,
  point: { x: number; y: number }
): Promise<void> {
  await api.run(
    { command: "tap", appBundleId: bundleId, x: point.x, y: point.y },
    { timeoutMs: GESTURE_TIMEOUT_MS }
  );
}

/** Press-and-hold at a point for `durationMs` (XCUICoordinate press). */
export async function longPressAt(
  api: IosDeviceRunnerApi,
  bundleId: string,
  point: { x: number; y: number },
  durationMs: number
): Promise<void> {
  await api.run(
    { command: "longPress", appBundleId: bundleId, x: point.x, y: point.y, durationMs },
    { timeoutMs: GESTURE_TIMEOUT_MS }
  );
}

/**
 * Coordinate-to-coordinate drag; duration is honored through drag velocity.
 * `settle` rests the touch at the destination before lifting, so the scroll
 * view reads ~0 release velocity and skips its fling — the hardware analogue
 * of the simulator's ease-out swipe.
 */
export async function dragBetween(
  api: IosDeviceRunnerApi,
  bundleId: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs?: number,
  settle?: boolean
): Promise<void> {
  await api.run(
    {
      command: "drag",
      appBundleId: bundleId,
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      ...(durationMs != null ? { durationMs } : {}),
      ...(settle ? { settle: true } : {}),
    },
    { timeoutMs: GESTURE_TIMEOUT_MS }
  );
}

/** Press the hardware Home button (device-scoped; no app target needed). */
export async function pressHome(api: IosDeviceRunnerApi): Promise<void> {
  await api.run({ command: "home" });
}

export async function typeText(
  api: IosDeviceRunnerApi,
  bundleId: string,
  text: string
): Promise<void> {
  await api.run({ command: "type", appBundleId: bundleId, text }, { timeoutMs: 60_000 });
}

export async function pressKeyboardReturn(
  api: IosDeviceRunnerApi,
  bundleId: string
): Promise<void> {
  await api.run({ command: "keyboardReturn", appBundleId: bundleId });
}

export interface RunnerSnapshotNode {
  index: number;
  type: string;
  label: string | null;
  identifier: string | null;
  value: string | null;
  rect: { x: number; y: number; width: number; height: number };
  enabled: boolean;
  focused: boolean | null;
  selected: boolean | null;
  hittable: boolean;
  depth: number;
  parentIndex: number | null;
  hiddenContentAbove: boolean | null;
  hiddenContentBelow: boolean | null;
}

export interface RunnerSnapshotQuality {
  state?: string;
  backend?: string;
  reason?: string;
  reasonCode?: string;
}

interface SnapshotData {
  nodes?: RunnerSnapshotNode[];
  quality?: RunnerSnapshotQuality;
}

/**
 * Identical snapshot requests in flight at once share one runner command.
 * Snapshots are the runner's heaviest read, and callers can overlap — a wait
 * tool's poll abandons a slow fetch client-side while the runner is still
 * chewing on it, then issues the next. Without coalescing those stack up on
 * the runner's serial queue and pile heavy AX work onto an already-struggling
 * process; with it, concurrent identical reads ride the same reply.
 */
const inFlightSnapshots = new Map<
  string,
  Promise<{ nodes: RunnerSnapshotNode[]; quality: RunnerSnapshotQuality | null }>
>();

export async function captureSnapshot(
  api: IosDeviceRunnerApi,
  bundleId: string,
  opts: { interactiveOnly?: boolean; depth?: number } = {}
): Promise<{ nodes: RunnerSnapshotNode[]; quality: RunnerSnapshotQuality | null }> {
  const key = `${api.udid}|${bundleId}|${opts.interactiveOnly ?? false}|${opts.depth ?? ""}`;
  const pending = inFlightSnapshots.get(key);
  if (pending) return pending;
  const request = (async () => {
    const data = (await api.run(
      {
        command: "snapshot",
        appBundleId: bundleId,
        interactiveOnly: opts.interactiveOnly ?? false,
        ...(opts.depth != null ? { depth: opts.depth } : {}),
      },
      { readOnly: true, timeoutMs: 45_000 }
    )) as SnapshotData;
    return { nodes: data.nodes ?? [], quality: data.quality ?? null };
  })();
  inFlightSnapshots.set(key, request);
  try {
    return await request;
  } finally {
    inFlightSnapshots.delete(key);
  }
}
