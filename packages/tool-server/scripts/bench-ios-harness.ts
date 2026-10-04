/**
 * Pure, importable pieces of the iOS open-vs-proprietary bench (2026-10-04 harness
 * repair, run 37213144359). Kept out of bench-ios-open-vs-proprietary.ts, which runs
 * `main()` on import, so they can be unit-tested without a simulator.
 *
 *   - ONE runner per simulator: the backend-independent oracle reads the tree
 *     through the tool layer's OWN XCUITest runner, resolved from the registry
 *     ({@link toolLayerRunner}). The bench starts no resident runner. Run
 *     37213144359 had two instances of the same xctrunner on one simulator (the
 *     workflow's resident one and the tool layer's), which killed each other.
 *   - A target app before any tree read: the runner's app-scoped calls fail with
 *     "no target app set; call launchApp first" until `launchApp` ran
 *     ({@link RunnerOracle}).
 *   - The serving path of each gesture: the tool result does not name it, so the
 *     tool layer's own fallback note is the record ({@link FallbackNotes},
 *     {@link gesturePath}).
 *   - A stable-frame settle before the swipe "before" capture
 *     ({@link waitForStableFrame}), replacing a fixed 900 ms sleep that left the
 *     "before" frames blank.
 */
import { readFileSync } from "node:fs";
import { ServiceState, type Registry } from "@argent/registry";
import { iosOpenServerRef, type IosOpenDeviceServerApi } from "../src/blueprints/ios-open-server";
import { resolveDevice } from "../src/utils/device-info";
import type { IosOpenServerNode, IosOpenServerState } from "../src/utils/ios-open-server-client";

export const SETTINGS_BUNDLE_ID = "com.apple.Preferences";

/** A connection-class RPC failure: the runner process or socket died. */
export function isConnectionError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|socket closed|not connected|write after end|read ECONN/i.test(
    m
  );
}

/* -------------------------------------------------------------------------- */
/* the tool layer's runner                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The tool layer's open iOS runner for `udid`, resolved through the registry the
 * measured tools use. The registry caches the instance by URN, so this returns
 * the SAME runner `describe` / `gesture-*` drive with the flag on, and starts it
 * (build-for-testing cached + `test-without-building`) when nothing has yet. With
 * the flag off the measured tools never touch it; it serves only the oracle.
 */
export function toolLayerRunner(
  reg: Pick<Registry, "resolveService">,
  udid: string
): Promise<IosOpenDeviceServerApi> {
  const ref = iosOpenServerRef(resolveDevice(udid));
  return reg.resolveService<IosOpenDeviceServerApi>(ref.urn, ref.options);
}

/** Starts and mid-block terminations of the tool layer's runner on `reg`. A block
 * expects exactly one start and no termination before its own dispose. */
export function watchRunnerLifecycle(
  reg: Pick<Registry, "events">,
  udid: string
): { starts(): number; terminations(): string[]; dispose(): void } {
  const urn = iosOpenServerRef(resolveDevice(udid)).urn;
  let starts = 0;
  const terminations: string[] = [];
  const listener = (id: string, from: ServiceState, to: ServiceState): void => {
    if (id !== urn) return;
    if (to === ServiceState.STARTING) starts++;
    if (from === ServiceState.RUNNING && to !== ServiceState.RUNNING) {
      terminations.push(`${from}→${to}`);
    }
  };
  reg.events.on("serviceStateChange", listener);
  return {
    starts: () => starts,
    terminations: () => terminations.slice(),
    dispose: () => {
      reg.events.off("serviceStateChange", listener);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* the oracle                                                                 */
/* -------------------------------------------------------------------------- */

/** Normalized 0..1 point on screen. */
export interface NPoint {
  x: number;
  y: number;
}

export interface StageSample {
  snapshotMs: number;
  serializeMs: number;
  encodeMs: number;
  captureMs: number;
  sum: number;
  delta: number;
}

/** The runner calls the oracle makes. */
export type OracleRunner = Pick<
  IosOpenDeviceServerApi,
  "launchApp" | "getNestedState" | "getScreenSize"
>;

function walk(
  nodes: IosOpenServerNode[],
  fn: (n: IosOpenServerNode, dfsIndex: number) => void
): void {
  let i = 0;
  const rec = (ns: IosOpenServerNode[]): void => {
    for (const n of ns) {
      fn(n, i++);
      rec(n.children);
    }
  };
  rec(nodes);
}

/**
 * The best HITTABLE match for `label`, computed host-side (IOS2-H2/H3): center on
 * screen (not under the status bar or the home strip), the runner's `hittable`
 * flag (isEnabled && hasArea), and among those the last painted in DFS order (a
 * best-effort topmost). Falls back to on-screen matches, then any match.
 */
function findTappableByLabel(
  nodes: IosOpenServerNode[],
  label: string,
  screenW: number,
  screenH: number
): IosOpenServerNode | undefined {
  const matches: Array<{ node: IosOpenServerNode; dfs: number }> = [];
  walk(nodes, (n, dfs) => {
    if (n.label === label) matches.push({ node: n, dfs });
  });
  if (matches.length === 0) return undefined;
  const onScreen = (n: IosOpenServerNode): boolean => {
    const cy = (n.bounds.y1 + n.bounds.y2) / 2 / (screenH || 1);
    const cx = (n.bounds.x1 + n.bounds.x2) / 2 / (screenW || 1);
    return cy > 0.03 && cy < 0.93 && cx > 0 && cx < 1;
  };
  const enabledOnScreen = matches.filter((m) => m.node.hittable && onScreen(m.node));
  const pool = enabledOnScreen.length ? enabledOnScreen : matches.filter((m) => onScreen(m.node));
  return (pool.length ? pool : matches).slice().sort((a, b) => b.dfs - a.dfs)[0]?.node;
}

function findScrollContainer(nodes: IosOpenServerNode[]): IosOpenServerNode | undefined {
  for (const t of ["Table", "CollectionView", "ScrollView"]) {
    let hit: IosOpenServerNode | undefined;
    walk(nodes, (n) => {
      if (!hit && n.type === t) hit = n;
    });
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The backend-independent oracle, the SAME instrument in all four blocks: the
 * coordinate every arm taps, the scroll region, the screen height in points and
 * the G3 stage timings, all read from the tool layer's runner, untimed.
 *
 * Target app (B): `launchApp(bundleId)` runs once per block before the first tree
 * read; it also sets the runner's stored target, which the product `describe` /
 * `gesture-*` calls (no bundleId) rely on with the flag on. Every tree read then
 * passes `bundleId` explicitly, so a simctl relaunch between iterations can never
 * leave a read without a target. A second `launchApp` per relaunch is not used:
 * XCUIApplication.launch() terminates and relaunches the app, doubling every
 * root restore.
 */
export class RunnerOracle {
  private readonly runner: () => Promise<OracleRunner>;
  private readonly bundleId: string;
  private readonly onConnectionError?: (message: string) => void;
  private targetSet = false;
  private relaunches = 0;
  private cachedHeightPoints: number | null = null;

  constructor(opts: {
    runner: () => Promise<OracleRunner>;
    bundleId?: string;
    onConnectionError?: (message: string) => void;
  }) {
    this.runner = opts.runner;
    this.bundleId = opts.bundleId ?? SETTINGS_BUNDLE_ID;
    this.onConnectionError = opts.onConnectionError;
  }

  private async call<T>(fn: (r: OracleRunner) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.runner());
    } catch (e) {
      if (isConnectionError(e))
        this.onConnectionError?.(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /** `launchApp(bundleId)` on the runner, once per block. */
  async ensureTarget(): Promise<void> {
    if (this.targetSet) return;
    await this.call((r) => r.launchApp(this.bundleId));
    this.targetSet = true;
  }

  /** The app was relaunched outside the runner (simctl). Reads keep naming it. */
  noteRelaunch(): void {
    this.relaunches++;
  }

  relaunchesSeen(): number {
    return this.relaunches;
  }

  private async tree(): Promise<IosOpenServerState> {
    await this.ensureTarget();
    return this.call((r) => r.getNestedState({ bundleId: this.bundleId }));
  }

  async locate(label: string): Promise<NPoint | null> {
    const st = await this.tree();
    const hit = findTappableByLabel(st.tree, label, st.info.screenWidth, st.info.screenHeight);
    if (!hit) return null;
    const cxPt = (hit.bounds.x1 + hit.bounds.x2) / 2;
    const cyPt = (hit.bounds.y1 + hit.bounds.y2) / 2;
    return { x: cxPt / st.info.screenWidth, y: cyPt / st.info.screenHeight };
  }

  async scrollRegion(): Promise<{ y1: number; y2: number }> {
    const st = await this.tree();
    const c = findScrollContainer(st.tree);
    if (!c) return { y1: 0.2, y2: 0.85 };
    // Clamp to [0,1]: a Table can report a content-sized frame taller than the
    // window (IOS2-H5 item 5), which would put a swipe endpoint off-screen.
    const y1 = Math.max(0, Math.min(1, c.bounds.y1 / st.info.screenHeight));
    const y2 = Math.max(0, Math.min(1, c.bounds.y2 / st.info.screenHeight));
    return y1 < y2 ? { y1, y2 } : { y1: 0.2, y2: 0.85 };
  }

  async stages(): Promise<StageSample> {
    const t = (await this.tree()).timings;
    const sum = t.snapshotMs + t.serializeMs + t.encodeMs;
    return {
      snapshotMs: t.snapshotMs,
      serializeMs: t.serializeMs,
      encodeMs: t.encodeMs,
      captureMs: t.captureMs,
      sum: Number(sum.toFixed(3)),
      delta: Number(Math.abs(sum - t.captureMs).toFixed(3)),
    };
  }

  async screenHeightPoints(): Promise<number> {
    if (this.cachedHeightPoints !== null) return this.cachedHeightPoints;
    const s = await this.call((r) => r.getScreenSize());
    this.cachedHeightPoints = s.screenHeight;
    return s.screenHeight;
  }

  async screenSize(): Promise<{ w: number; h: number }> {
    const s = await this.call((r) => r.getScreenSize());
    return { w: s.screenWidth, h: s.screenHeight };
  }
}

/* -------------------------------------------------------------------------- */
/* serving path                                                               */
/* -------------------------------------------------------------------------- */

// The notes the tool layer logs (console.debug) when the open iOS path fails and
// it falls back: `[describe-ios] … falling back to ax-service: …`,
// `[gesture-tap] / [gesture-swipe] … falling back to simulator-server: …`.
const FALLBACK_NOTE =
  /^\[(describe-ios|gesture-tap|gesture-swipe)\].*falling back to (ax-service|simulator-server)/;

/** Records the tool layer's fallback notes while forwarding every console.debug. */
export class FallbackNotes {
  private notes: string[] = [];

  install(target: { debug: (...args: unknown[]) => void } = console): () => void {
    const original = target.debug;
    target.debug = (...args: unknown[]): void => {
      const line = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
      if (FALLBACK_NOTE.test(line)) this.notes.push(line);
      original.apply(target, args);
    };
    return () => {
      target.debug = original;
    };
  }

  /** The notes recorded since the previous call. */
  take(): string[] {
    const out = this.notes;
    this.notes = [];
    return out;
  }
}

/** The injector a `gesture-tap` / `gesture-swipe` tool call was served by: with
 * the flag on, the open runner unless the tool logged a fallback note during the
 * call; with the flag off, simulator-server. */
export function gesturePath(
  flagOn: boolean,
  notes: string[]
): "open-device-server" | "simulator-server" {
  if (!flagOn) return "simulator-server";
  return notes.some((n) => /^\[gesture-(tap|swipe)\].*falling back to simulator-server/.test(n))
    ? "simulator-server"
    : "open-device-server";
}

/* -------------------------------------------------------------------------- */
/* settle                                                                     */
/* -------------------------------------------------------------------------- */

interface StableFrame {
  /** True when two consecutive frames were identical within the bound. */
  stable: boolean;
  /** The last captured frame (the stable one when `stable`). */
  frame: string;
  /** Frames captured. */
  frames: number;
  /** Time spent waiting (sleeps between captures). */
  waitedMs: number;
}

/**
 * Capture frames `intervalMs` apart until two consecutive ones are the same, or
 * `timeoutMs` elapses. Every frame but the returned one is discarded. Runs before
 * the timed region of a verb; the caller records the result.
 */
export async function waitForStableFrame(opts: {
  capture: () => Promise<string>;
  same: (a: string, b: string) => boolean | Promise<boolean>;
  discard?: (frame: string) => void;
  intervalMs?: number;
  timeoutMs?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<StableFrame> {
  const interval = opts.intervalMs ?? 250;
  const timeout = opts.timeoutMs ?? 5000;
  const clock = opts.clock ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = clock();
  let prev = await opts.capture();
  let frames = 1;
  while (clock() - t0 < timeout) {
    await sleep(interval);
    const cur = await opts.capture();
    frames++;
    const same = await opts.same(prev, cur);
    opts.discard?.(prev);
    prev = cur;
    if (same) return { stable: true, frame: cur, frames, waitedMs: clock() - t0 };
  }
  return { stable: false, frame: prev, frames, waitedMs: clock() - t0 };
}

/** Byte-identical PNG files (simctl encodes identical pixels identically). */
export function sameFileBytes(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}
