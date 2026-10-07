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
 *
 * Runner lifetime (run 37223296646): the first start of a block missed the
 * runner's 120 s ready budget in OFF-1, ON-siminput and OFF-2, and the oracle's
 * next call made the registry start a second runner, reported as "restarted
 * mid-block (starts=2, terminations=none)". Now the oracle goes through ONE
 * {@link RunnerLease} per block (a failed start stays failed), retries a
 * transient connection error on the same runner instead of resolving it again,
 * and {@link watchRunnerLifecycle} records which call started each runner.
 */
import { readFileSync } from "node:fs";
import { ServiceState, type Registry } from "@argent/registry";
import { iosOpenServerRef, type IosOpenDeviceServerApi } from "../src/blueprints/ios-open-server";
import { resolveDevice } from "../src/utils/device-info";
import type {
  IosOpenServerInfo,
  IosOpenServerNode,
  IosOpenServerState,
} from "../src/utils/ios-open-server-client";

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

/**
 * ONE start of the tool layer's runner per block: the first `ensure()` runs
 * `start`, every later call (concurrent or not) shares that promise. A failed
 * start stays failed: later calls reject with the same error and never start a
 * second runner, so the oracle cannot restart the measured instrument mid-block.
 */
export class RunnerLease<T> {
  private pending: Promise<T> | null = null;
  private failure: Error | null = null;

  constructor(private readonly start: () => Promise<T>) {}

  ensure(): Promise<T> {
    if (!this.pending) {
      this.pending = this.start().catch((e: unknown) => {
        this.failure = e instanceof Error ? e : new Error(String(e));
        throw this.failure;
      });
    }
    return this.pending;
  }

  /** The start's error message, or null when it has not failed. */
  startFailure(): string | null {
    return this.failure?.message ?? null;
  }
}

/** One start of the tool layer's runner: the call that triggered it and how it
 * ended (`pending` while starting). */
export interface RunnerStart {
  n: number;
  trigger: string;
  outcome: "pending" | "running" | "error";
  ms: number | null;
  error?: string;
}

interface RunnerTermination {
  edge: string;
  trigger: string;
  error?: string;
}

/** The registry's ERROR event wraps the cause; keep the cause's own message. */
function errorText(err: Error): string {
  const cause = (err as Error & { cause?: unknown }).cause;
  return cause instanceof Error ? cause.message : err.message;
}

/**
 * Starts and mid-block terminations of the tool layer's runner on `reg`. A block
 * expects exactly one start and no termination before its own dispose. Each
 * start and termination records `trigger()` (the call in flight: `prepare`,
 * `oracle:<op>`, `tool:<name>`), so a second start names who caused it.
 */
export function watchRunnerLifecycle(
  reg: Pick<Registry, "events">,
  udid: string,
  opts: { trigger?: () => string; clock?: () => number } = {}
): {
  starts(): number;
  terminations(): string[];
  startLog(): RunnerStart[];
  /** Null for one start and no termination; otherwise what happened, by whom. */
  restartCause(): string | null;
  dispose(): void;
} {
  const urn = iosOpenServerRef(resolveDevice(udid)).urn;
  const trigger = opts.trigger ?? (() => "unattributed");
  const clock = opts.clock ?? Date.now;
  const starts: RunnerStart[] = [];
  const terminations: RunnerTermination[] = [];
  let startedAt = 0;
  // Where the registry's ERROR event (emitted right after the transition) lands.
  let awaitingError: { error?: string } | null = null;

  const onState = (id: string, from: ServiceState, to: ServiceState): void => {
    if (id !== urn) return;
    awaitingError = null;
    if (to === ServiceState.STARTING) {
      startedAt = clock();
      starts.push({ n: starts.length + 1, trigger: trigger(), outcome: "pending", ms: null });
      return;
    }
    const last = starts[starts.length - 1];
    if (from === ServiceState.STARTING && last) {
      last.outcome = to === ServiceState.RUNNING ? "running" : "error";
      last.ms = clock() - startedAt;
      if (to === ServiceState.ERROR) awaitingError = last;
    }
    if (from === ServiceState.RUNNING && to !== ServiceState.RUNNING) {
      const t: RunnerTermination = { edge: `${from}→${to}`, trigger: trigger() };
      terminations.push(t);
      awaitingError = t;
    } else if (to === ServiceState.ERROR && from === ServiceState.TERMINATING) {
      awaitingError = terminations[terminations.length - 1] ?? null;
    }
  };
  const onError = (id: string, err: Error): void => {
    if (id !== urn || !awaitingError || awaitingError.error) return;
    awaitingError.error = errorText(err);
  };
  reg.events.on("serviceStateChange", onState);
  reg.events.on("serviceError", onError);

  return {
    starts: () => starts.length,
    terminations: () => terminations.map((t) => t.edge),
    startLog: () => starts.map((s) => ({ ...s })),
    restartCause: () => {
      if (starts.length <= 1 && terminations.length === 0) return null;
      const startText = starts
        .map(
          (s) =>
            `#${s.n} by ${s.trigger}: ${s.outcome}` +
            `${s.ms !== null ? ` after ${s.ms} ms` : ""}${s.error ? ` (${s.error})` : ""}`
        )
        .join("; ");
      const termText = terminations.length
        ? terminations
            .map((t) => `${t.edge} during ${t.trigger}${t.error ? ` (${t.error})` : ""}`)
            .join(", ")
        : "none";
      return `tool-layer runner: ${starts.length} starts in the block [${startText}]; terminations=${termText}`;
    },
    dispose: () => {
      reg.events.off("serviceStateChange", onState);
      reg.events.off("serviceError", onError);
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
  "getInfo" | "launchApp" | "getNestedState" | "getScreenSize"
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

/**
 * The screen in POINTS for a tree read: the Application root's frame (the target
 * app, the same space as every node's bounds), else the runner's `info` size.
 * Normalized oracle points are fractions of the REAL screen because the OFF and
 * sim-input arms interpret them that way; a runner whose `info` reported its own
 * compatibility-mode 320×480 size (run 37572773799) skewed every oracle point.
 */
export function screenOf(st: IosOpenServerState): { w: number; h: number } {
  const root = st.tree.length === 1 ? st.tree[0] : undefined;
  if (root?.type === "Application") {
    const w = root.bounds.x2 - root.bounds.x1;
    const h = root.bounds.y2 - root.bounds.y1;
    if (w > 0 && h > 0) return { w, h };
  }
  return { w: st.info.screenWidth, h: st.info.screenHeight };
}

/** Titles of the navigation bars in a tree (identifier, else label), in DFS order. */
export function navigationTitles(nodes: IosOpenServerNode[]): string[] {
  const titles: string[] = [];
  walk(nodes, (n) => {
    if (n.type !== "NavigationBar") return;
    const t = n.identifier ?? n.label;
    if (t) titles.push(t);
  });
  return titles;
}

/**
 * Whether the screen in `nodes` is the destination titled `title`: a navigation
 * bar carries it (UIKit sets a bar's identifier to its title). The root's "General"
 * cell does not count, and a tree with no navigation bar is undecidable, so it is
 * NOT landed (fail closed). A pixel diff alone counted any row's push as landed.
 */
export function landedOn(nodes: IosOpenServerNode[], title: string): boolean {
  return navigationTitles(nodes).includes(title);
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
 * Target app (B): before the first tree read, once per block, the runner's
 * stored target is set to `bundleId` the way the product `launch-app` sets it
 * (`iosOpenServerSetTarget`): `getInfo`, and `launchApp` only when the runner
 * does not already target the app. The product `describe` / `gesture-*` calls
 * (no bundleId) rely on that stored target with the flag on. Every tree read then
 * passes `bundleId` explicitly, so a simctl relaunch between iterations can never
 * leave a read without a target. A second `launchApp` per relaunch is not used:
 * XCUIApplication.launch() terminates and relaunches the app, doubling every
 * root restore.
 *
 * Runner lifetime: `runner` should be one {@link RunnerLease}'s `ensure`, so the
 * oracle never starts a second runner. A connection-class error on an RPC is
 * retried on the same runner (`retries` times, `retryDelayMs` apart; the oracle
 * is untimed) and reported only once the retries are spent.
 */
export class RunnerOracle {
  private readonly runner: () => Promise<OracleRunner>;
  private readonly bundleId: string;
  private readonly onConnectionError?: (message: string) => void;
  private readonly onCall?: (op: string) => void;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private targetSet = false;
  private relaunches = 0;
  private retried = 0;
  private cachedHeightPoints: number | null = null;

  constructor(opts: {
    runner: () => Promise<OracleRunner>;
    bundleId?: string;
    onConnectionError?: (message: string) => void;
    /** Called with the oracle operation before each runner call. */
    onCall?: (op: string) => void;
    retries?: number;
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.runner = opts.runner;
    this.bundleId = opts.bundleId ?? SETTINGS_BUNDLE_ID;
    this.onConnectionError = opts.onConnectionError;
    this.onCall = opts.onCall;
    this.retries = opts.retries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
    this.sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  private report(e: unknown): void {
    if (isConnectionError(e)) this.onConnectionError?.(e instanceof Error ? e.message : String(e));
  }

  private async call<T>(op: string, fn: (r: OracleRunner) => Promise<T>): Promise<T> {
    this.onCall?.(op);
    let runner: OracleRunner;
    try {
      runner = await this.runner();
    } catch (e) {
      // No runner (a failed start): not retried, the lease keeps it failed.
      this.report(e);
      throw e;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(runner);
      } catch (e) {
        if (!isConnectionError(e) || attempt >= this.retries) {
          this.report(e);
          throw e;
        }
        this.retried++;
        await this.sleep(this.retryDelayMs);
      }
    }
  }

  /** The runner targets `bundleId`, once per block (launchApp only if needed). */
  async ensureTarget(): Promise<void> {
    if (this.targetSet) return;
    const info: IosOpenServerInfo = await this.call("getInfo", (r) => r.getInfo());
    if (info.bundleId !== this.bundleId) {
      await this.call("launchApp", (r) => r.launchApp(this.bundleId));
    }
    this.targetSet = true;
  }

  /** Connection errors that succeeded on a retry (same runner, no restart). */
  transientRetries(): number {
    return this.retried;
  }

  /** The app was relaunched outside the runner (simctl). Reads keep naming it. */
  noteRelaunch(): void {
    this.relaunches++;
  }

  relaunchesSeen(): number {
    return this.relaunches;
  }

  private async tree(op: string): Promise<IosOpenServerState> {
    await this.ensureTarget();
    return this.call(op, (r) => r.getNestedState({ bundleId: this.bundleId }));
  }

  async locate(label: string): Promise<NPoint | null> {
    const st = await this.tree("locate");
    const screen = screenOf(st);
    const hit = findTappableByLabel(st.tree, label, screen.w, screen.h);
    if (!hit) return null;
    const cxPt = (hit.bounds.x1 + hit.bounds.x2) / 2;
    const cyPt = (hit.bounds.y1 + hit.bounds.y2) / 2;
    return { x: cxPt / screen.w, y: cyPt / screen.h };
  }

  async scrollRegion(): Promise<{ y1: number; y2: number }> {
    const st = await this.tree("scrollRegion");
    const c = findScrollContainer(st.tree);
    if (!c) return { y1: 0.2, y2: 0.85 };
    const { h } = screenOf(st);
    // Clamp to [0,1]: a Table can report a content-sized frame taller than the
    // window (IOS2-H5 item 5), which would put a swipe endpoint off-screen.
    const y1 = Math.max(0, Math.min(1, c.bounds.y1 / h));
    const y2 = Math.max(0, Math.min(1, c.bounds.y2 / h));
    return y1 < y2 ? { y1, y2 } : { y1: 0.2, y2: 0.85 };
  }

  /** Whether the current screen is the one titled `title` ({@link landedOn}),
   * with the navigation titles seen (for the record). One tree read, untimed. */
  async destination(title: string): Promise<{ landed: boolean; titles: string[] }> {
    const st = await this.tree("destination");
    return { landed: landedOn(st.tree, title), titles: navigationTitles(st.tree) };
  }

  async stages(): Promise<StageSample> {
    const t = (await this.tree("stages")).timings;
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
    const s = await this.call("getScreenSize", (r) => r.getScreenSize());
    this.cachedHeightPoints = s.screenHeight;
    return s.screenHeight;
  }

  async screenSize(): Promise<{ w: number; h: number }> {
    const s = await this.call("getScreenSize", (r) => r.getScreenSize());
    return { w: s.screenWidth, h: s.screenHeight };
  }
}

/* -------------------------------------------------------------------------- */
/* serving path                                                               */
/* -------------------------------------------------------------------------- */

// The notes the tool layer logs when an open iOS path fails and it falls back.
// Before PR #16 at console.debug (`[gesture-tap] ios open-device-server failed,
// falling back to simulator-server: …`); since PR #16 at console.warn
// (`[<tool>] open ios-device-server failed, falling back to <path>: …`, also for
// launch-app, keyboard and screenshot). Both levels and both wordings count.
const FALLBACK_NOTE =
  /^\[(describe-ios|gesture-tap|gesture-swipe|launch-app|keyboard|screenshot)\].*falling back to /;

type ConsoleLike = {
  debug: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

/** Records the tool layer's fallback notes while forwarding every console.debug
 * and console.warn line. */
export class FallbackNotes {
  private notes: string[] = [];

  install(target: ConsoleLike = console): () => void {
    const restore: Array<() => void> = [];
    for (const level of ["debug", "warn"] as const) {
      const original = target[level];
      if (typeof original !== "function") continue;
      target[level] = (...args: unknown[]): void => {
        const line = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
        if (FALLBACK_NOTE.test(line)) this.notes.push(line);
        original.apply(target, args);
      };
      restore.push(() => {
        target[level] = original;
      });
    }
    return () => {
      for (const r of restore) r();
    };
  }

  /** The notes recorded since the previous call. */
  take(): string[] {
    const out = this.notes;
    this.notes = [];
    return out;
  }
}

/** A tool result's fallback marker (PR #16): `backend: "proprietary-fallback"`. */
export function isFallbackResult(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { backend?: unknown }).backend === "proprietary-fallback"
  );
}

/** The injector a `gesture-tap` / `gesture-swipe` tool call was served by: with
 * the flag on, the open runner unless the tool logged a fallback note during the
 * call or marked its result as a fallback; with the flag off, simulator-server. */
export function gesturePath(
  flagOn: boolean,
  notes: string[],
  result?: unknown
): "open-device-server" | "simulator-server" {
  if (!flagOn) return "simulator-server";
  if (isFallbackResult(result)) return "simulator-server";
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
