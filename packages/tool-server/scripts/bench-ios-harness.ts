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
 * iOS-4 (run 37572773799, docs/open-server/2026-10-07-ios4-siminput-plan.md):
 *   - After each simctl relaunch the oracle re-checks the runner's target before
 *     its next read and relaunches it only when the runner lost it
 *     ({@link RunnerOracle.noteRelaunch}).
 *   - {@link decomposeSimInputAck} splits one sim-input command's host write→ack
 *     time into the sidecar's receive / per-message send / ack terms.
 *
 * Run 37595262694 (OFF-1 and ON-siminput self-test on "Siri"): every arm tapped
 * the same screen point for the same oracle point (y 0.3656 → Siri page, 0.4651 →
 * General, on all three arms), so the arms' spaces agreed; the oracle's single
 * early read had located "General" before Settings inserted a banner above it.
 *   - {@link RunnerOracle} `locateSettle`: a locate returns only once two
 *     consecutive reads agree.
 *   - {@link ScreenGeometry} and one conversion per arm ({@link proprietaryTapPoint},
 *     {@link openToolTapPoint}, {@link simInputTapPoint}) from the canonical
 *     device-screen fraction, so an app frame that does not start at (0, 0) maps
 *     to the same screen point on every arm.
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
import type { SimInputAck } from "../src/utils/ios-sim-input-service";
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

export interface RunnerLeaseOptions {
  /** Start attempts in the one ensure (1 = no retry; the default). */
  attempts?: number;
  /** Untimed host reset between a failed attempt and the next one. A throw here
   * is swallowed: the retry still runs. */
  beforeRetry?: (error: Error, failedAttempt: number) => Promise<void>;
  clock?: () => number;
}

/**
 * ONE start of the tool layer's runner per block: the first `ensure()` runs
 * `start`, every later call (concurrent or not) shares that promise. A failed
 * start stays failed: later calls reject with the same error and never start a
 * second runner, so the oracle cannot restart the measured instrument mid-block.
 *
 * Run 37840591012: ON-siminput's runner listened ~2 s after the 300 s budget
 * expired. With `attempts: 2` the one ensure retries a failed start once after
 * `beforeRetry` (kill the stale xcodebuild, `simctl bootstatus`), all inside the
 * same untimed promise, so the retry is never inside a measured window.
 */
export class RunnerLease<T> {
  private pending: Promise<T> | null = null;
  private failure: Error | null = null;
  private attemptsMade = 0;
  private elapsedMs: number | null = null;
  private readonly maxAttempts: number;
  private readonly clock: () => number;

  constructor(
    private readonly start: () => Promise<T>,
    private readonly opts: RunnerLeaseOptions = {}
  ) {
    this.maxAttempts = Math.max(1, Math.floor(opts.attempts ?? 1));
    this.clock = opts.clock ?? Date.now;
  }

  ensure(): Promise<T> {
    if (!this.pending) {
      this.pending = this.run().catch((e: unknown) => {
        this.failure = e instanceof Error ? e : new Error(String(e));
        throw this.failure;
      });
    }
    return this.pending;
  }

  private async run(): Promise<T> {
    const t0 = this.clock();
    for (;;) {
      this.attemptsMade++;
      try {
        const value = await this.start();
        this.elapsedMs = this.clock() - t0;
        return value;
      } catch (e) {
        if (this.attemptsMade >= this.maxAttempts) throw e;
        const err = e instanceof Error ? e : new Error(String(e));
        await this.opts.beforeRetry?.(err, this.attemptsMade).catch(() => undefined);
      }
    }
  }

  /** The start's error message, or null when it has not failed. */
  startFailure(): string | null {
    return this.failure?.message ?? null;
  }

  /** Start attempts made so far (0 before the first ensure). */
  startAttempts(): number {
    return this.attemptsMade;
  }

  /** Failed attempts that were retried (each one a registry start that ended in
   * ERROR before the block's runner came up). */
  retriedStarts(): number {
    return Math.max(0, this.attemptsMade - 1);
  }

  /** Wall time from the first attempt until the runner answered, retries and
   * resets included; null until it did (or when it never did). */
  startMs(): number | null {
    return this.elapsedMs;
  }
}

/** One step of {@link resetRunnerHost}, stamped with the wall clock. */
export interface RunnerResetStep {
  at: string;
  step: "term" | "gone" | "kill-9" | "bootstatus";
  detail?: string;
}

export interface RunnerResetHost {
  /** Run `cmd args` with a timeout; `code` is the exit status (-1: no status). */
  exec(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log?(line: string): void;
}

/** `pgrep -f` patterns of what a runner start leaves behind on the host. */
export function runnerProcessPatterns(udid: string): string[] {
  return [
    `xcodebuild test-without-building.*${udid}`,
    "ArgentRunnerUITests-Runner",
    // The simulator's testmanagerd (runtime path under CoreSimulator), not Xcode's.
    "CoreSimulator.*testmanagerd",
  ];
}

/**
 * Between a failed runner start and its retry (run 37686041333: a block collided
 * with the previous xcodebuild and timed out booting the simulator): SIGTERM the
 * runner processes, poll every `pollMs` up to `waitMs` until none is left,
 * SIGKILL the survivors, then `xcrun simctl bootstatus <udid> -b` (bounded).
 * Never throws; returns each step with a timestamp.
 */
export async function resetRunnerHost(
  udid: string,
  host: RunnerResetHost,
  opts: { waitMs?: number; pollMs?: number; bootTimeoutMs?: number } = {}
): Promise<RunnerResetStep[]> {
  const waitMs = opts.waitMs ?? 60_000;
  const pollMs = opts.pollMs ?? 2_000;
  const bootTimeoutMs = opts.bootTimeoutMs ?? 120_000;
  const steps: RunnerResetStep[] = [];
  const note = (step: RunnerResetStep["step"], detail?: string): void => {
    const s: RunnerResetStep = { at: new Date(host.now()).toISOString(), step, detail };
    steps.push(s);
    host.log?.(`${s.at} runner reset: ${step}${detail ? ` (${detail})` : ""}`);
  };
  const run = (cmd: string, args: string[], timeoutMs: number) =>
    host.exec(cmd, args, timeoutMs).catch(() => ({ code: -1, stdout: "" }));
  const patterns = runnerProcessPatterns(udid);

  for (const p of patterns) await run("pkill", ["-f", p], 10_000);
  note("term", patterns.join(" | "));

  const alive = async (): Promise<string[]> => {
    const out: string[] = [];
    for (const p of patterns) if ((await run("pgrep", ["-fl", p], 10_000)).code === 0) out.push(p);
    return out;
  };
  const t0 = host.now();
  let left = await alive();
  while (left.length > 0 && host.now() - t0 < waitMs) {
    await host.sleep(pollMs);
    left = await alive();
  }
  if (left.length === 0) note("gone", `after ${host.now() - t0} ms`);
  else {
    for (const p of left) await run("pkill", ["-9", "-f", p], 10_000);
    note("kill-9", `still alive after ${host.now() - t0} ms: ${left.join(" | ")}`);
  }

  const boot = await run("xcrun", ["simctl", "bootstatus", udid, "-b"], bootTimeoutMs);
  note("bootstatus", boot.code === 0 ? "booted" : `exit ${boot.code}`);
  return steps;
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
  /** Null for one start and no termination; otherwise what happened, by whom.
   * `retriedStarts`: leading starts that ended in ERROR and that the block's
   * {@link RunnerLease} retried (untimed) — they are not restarts. */
  restartCause(retriedStarts?: number): string | null;
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
    restartCause: (retriedStarts = 0) => {
      let exempt = 0;
      while (exempt < retriedStarts && starts[exempt]?.outcome === "error") exempt++;
      if (starts.length - exempt <= 1 && terminations.length === 0) return null;
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

/** Normalized 0..1 point of the DEVICE screen (the canonical oracle point; the
 * framebuffer's fraction, so also the screenshot's). Each arm converts it into
 * its own input space ({@link proprietaryTapPoint}, {@link openToolTapPoint},
 * {@link simInputTapPoint}). */
export interface NPoint {
  x: number;
  y: number;
}

/** A width × height in screen points. */
export interface PointSize {
  w: number;
  h: number;
}

/**
 * The block's screen geometry (run 37595262694), measured once per block,
 * untimed. Node bounds and the runner's wire `tap` / `swipe` are in SCREEN points
 * (absolute: the runner's `point()` cancels `withOffset`'s app-relative base).
 */
export interface ScreenGeometry {
  /** The device screen in points (framebuffer px / scale): the space the
   * proprietary `gesture-tap`'s 0..1 and sim-input's digitizer 0..1 cover. */
  screen: PointSize;
  /** The runner's `getScreenSize`: the target app's frame SIZE (no origin). The
   * open gesture tools multiply a 0..1 point by it and send the product to the
   * runner as screen points. */
  runner: PointSize;
}

/** The device screen in points from a framebuffer size in px and the device
 * scale; null when either is missing or unusable. */
export function deviceScreenPoints(
  framebufferPx: { width: number; height: number } | null,
  scale: number | null
): PointSize | null {
  if (!framebufferPx || scale === null || !(scale > 0)) return null;
  const w = framebufferPx.width / scale;
  const h = framebufferPx.height / scale;
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : null;
}

/** OFF arm: the proprietary `gesture-tap` / `gesture-swipe` (simulator-server
 * `touch`) take 0..1 of the device screen, the canonical point itself. */
export function proprietaryTapPoint(n: NPoint, _g: ScreenGeometry): NPoint {
  return { x: n.x, y: n.y };
}

/** ON-xcuitest arm: the open `gesture-tap` / `gesture-swipe` multiply by the
 * runner's `getScreenSize` (the app frame size), so the canonical point is
 * rescaled to land on the same screen point. Equal to the canonical point when
 * the app frame is the whole screen. */
export function openToolTapPoint(n: NPoint, g: ScreenGeometry): NPoint {
  return {
    x: (n.x * g.screen.w) / (g.runner.w || 1),
    y: (n.y * g.screen.h) / (g.runner.h || 1),
  };
}

/** ON-siminput arm: sim-input divides x / screenWidth into the digitizer's 0..1
 * of the device screen, so it gets screen points and the device screen size. */
export function simInputTapPoint(
  n: NPoint,
  g: ScreenGeometry
): { x: number; y: number; width: number; height: number } {
  return { x: n.x * g.screen.w, y: n.y * g.screen.h, width: g.screen.w, height: g.screen.h };
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

/**
 * The device screen as a tree read implies it, when none was measured: the
 * Application root's far corner (origin + size, so a frame that starts below the
 * top still spans to the screen's bottom), else the runner's `info` size.
 */
function extentOf(st: IosOpenServerState): PointSize {
  const root = st.tree.length === 1 ? st.tree[0] : undefined;
  if (root?.type === "Application" && root.bounds.x2 > 0 && root.bounds.y2 > 0) {
    return { w: root.bounds.x2, h: root.bounds.y2 };
  }
  return screenOf(st);
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
 * leave a read without a target. After a relaunch ({@link noteRelaunch}) the next
 * read re-runs that check (`getInfo`), so a runner that lost its target is
 * re-targeted; an unconditional `launchApp` per relaunch is not used:
 * XCUIApplication.launch() terminates and relaunches the app, doubling every
 * root restore.
 *
 * Runner lifetime: `runner` should be one {@link RunnerLease}'s `ensure`, so the
 * oracle never starts a second runner. A connection-class error on an RPC is
 * retried on the same runner (`retries` times, `retryDelayMs` apart; the oracle
 * is untimed) and reported only once the retries are spent.
 *
 * Points (run 37595262694): {@link locate} and {@link scrollRegion} are fractions
 * of the DEVICE screen ({@link setDeviceScreen}, else the root frame's extent),
 * from the node bounds in screen points; each arm converts them into its own
 * input space. With `locateSettle`, a locate re-reads the tree `stableMs` apart
 * until two consecutive reads put the label's centre at the same place: Settings
 * inserts its "Ready for Apple Intelligence" banner above "General" after launch,
 * so a single early read located "General" 87 pt high and every arm tapped the
 * banner (which opens the Siri page) in 16 to 19 of 20 samples.
 */
export class RunnerOracle {
  private readonly runner: () => Promise<OracleRunner>;
  private readonly bundleId: string;
  private readonly onConnectionError?: (message: string) => void;
  private readonly onCall?: (op: string) => void;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly locateSettle: { stableMs: number; maxReads: number; tolerancePt: number } | null;
  private deviceScreen: PointSize | null = null;
  private locateShifts = 0;
  private unsettledLocates = 0;
  private targetSet = false;
  /** The target was set once in this block (the first launchApp is not a re-target). */
  private targeted = false;
  private retargets = 0;
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
    /** Settled locate: re-read `stableMs` apart, at most `maxReads` reads, until
     * two consecutive centres agree within `tolerancePt` (default 1). Absent: one
     * read per locate. */
    locateSettle?: { stableMs: number; maxReads: number; tolerancePt?: number };
  }) {
    this.runner = opts.runner;
    this.locateSettle = opts.locateSettle
      ? {
          stableMs: opts.locateSettle.stableMs,
          maxReads: Math.max(2, opts.locateSettle.maxReads),
          tolerancePt: opts.locateSettle.tolerancePt ?? 1,
        }
      : null;
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

  /** The runner targets `bundleId`: checked once per block and again after each
   * relaunch (launchApp only if the runner does not target it). */
  async ensureTarget(): Promise<void> {
    if (this.targetSet) return;
    const info: IosOpenServerInfo = await this.call("getInfo", (r) => r.getInfo());
    if (info.bundleId !== this.bundleId) {
      await this.call("launchApp", (r) => r.launchApp(this.bundleId));
      if (this.targeted) this.retargets++;
    }
    this.targetSet = true;
    this.targeted = true;
  }

  /** launchApp calls after the block's first targeting: the runner lost its
   * target across a relaunch that many times. */
  retargetsSeen(): number {
    return this.retargets;
  }

  /** Connection errors that succeeded on a retry (same runner, no restart). */
  transientRetries(): number {
    return this.retried;
  }

  /** The app was relaunched outside the runner (simctl). Reads keep naming it,
   * and the next one re-checks the runner's target first. */
  noteRelaunch(): void {
    this.relaunches++;
    this.targetSet = false;
  }

  relaunchesSeen(): number {
    return this.relaunches;
  }

  private async tree(op: string): Promise<IosOpenServerState> {
    await this.ensureTarget();
    return this.call(op, (r) => r.getNestedState({ bundleId: this.bundleId }));
  }

  /** The device screen in points, measured by the caller (framebuffer / scale);
   * every later point is a fraction of it. */
  setDeviceScreen(screen: PointSize | null): void {
    this.deviceScreen = screen;
  }

  private screenFor(st: IosOpenServerState): PointSize {
    return this.deviceScreen ?? extentOf(st);
  }

  /** One read: the label's centre in screen points and as a device-screen fraction. */
  private async locateOnce(
    label: string
  ): Promise<{ pt: { x: number; y: number }; n: NPoint } | null> {
    const st = await this.tree("locate");
    const screen = this.screenFor(st);
    const hit = findTappableByLabel(st.tree, label, screen.w, screen.h);
    if (!hit) return null;
    const pt = { x: (hit.bounds.x1 + hit.bounds.x2) / 2, y: (hit.bounds.y1 + hit.bounds.y2) / 2 };
    return { pt, n: { x: pt.x / screen.w, y: pt.y / screen.h } };
  }

  /** The label's centre as a fraction of the device screen; with `locateSettle`,
   * only once two consecutive reads agree (null when the layout never settles). */
  async locate(label: string): Promise<NPoint | null> {
    const settle = this.locateSettle;
    let prev = await this.locateOnce(label);
    if (!settle) return prev?.n ?? null;
    for (let read = 1; read < settle.maxReads; read++) {
      await this.sleep(settle.stableMs);
      const cur = await this.locateOnce(label);
      if (
        prev &&
        cur &&
        Math.abs(prev.pt.x - cur.pt.x) <= settle.tolerancePt &&
        Math.abs(prev.pt.y - cur.pt.y) <= settle.tolerancePt
      ) {
        return cur.n;
      }
      if (prev || cur) this.locateShifts++;
      prev = cur;
    }
    this.unsettledLocates++;
    return null;
  }

  /** Consecutive locate reads that disagreed (the layout moved under a locate). */
  locateShiftsSeen(): number {
    return this.locateShifts;
  }

  /** Locates that never saw two agreeing reads within `maxReads` (returned null). */
  unsettledLocatesSeen(): number {
    return this.unsettledLocates;
  }

  async scrollRegion(): Promise<{ y1: number; y2: number }> {
    const st = await this.tree("scrollRegion");
    const c = findScrollContainer(st.tree);
    if (!c) return { y1: 0.2, y2: 0.85 };
    const { h } = this.screenFor(st);
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

  /** The runner's `getScreenSize`: the target app's frame size in points. */
  async screenSize(): Promise<PointSize> {
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
  if (typeof result !== "object" || result === null) return false;
  const r = result as { backend?: unknown; fallbackReason?: unknown };
  // iOS-4 ticket 6: a sim-input → runner fallback carries `fallbackReason` with
  // no proprietary marker.
  return r.backend === "proprietary-fallback" || typeof r.fallbackReason === "string";
}

/** The serving-path token of each `inputBackend` a tool result names. */
const INPUT_BACKEND_PATH = {
  "sim-input": "sim-input",
  "runner": "open-device-server",
  "simulator-server": "simulator-server",
} as const;

/** The injector a `gesture-tap` / `gesture-swipe` tool call was served by: the
 * result's `inputBackend` when it names one (iOS-4 ticket 6); else, with the
 * flag on, the open runner unless the tool logged a fallback note during the
 * call or marked its result as a fallback; with the flag off, simulator-server. */
export function gesturePath(
  flagOn: boolean,
  notes: string[],
  result?: unknown
): "open-device-server" | "simulator-server" | "sim-input" {
  if (!flagOn) return "simulator-server";
  const backend =
    typeof result === "object" && result !== null
      ? (result as { inputBackend?: unknown }).inputBackend
      : undefined;
  if (typeof backend === "string" && backend in INPUT_BACKEND_PATH) {
    return INPUT_BACKEND_PATH[backend as keyof typeof INPUT_BACKEND_PATH];
  }
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

/**
 * Run an untimed locate, and once more when it misses (null or a throw). A miss
 * on both tries excludes the sample (M4 still fails the block); one retry keeps a
 * single transient miss (run 37584719906: ON-siminput tap+describe locateFailed=1,
 * 19 of 20 samples) from costing a sample. `retried` is recorded per verb.
 */
export async function retryLocateOnce<T>(
  locate: () => Promise<T | null>
): Promise<{ value: T | null; retried: boolean }> {
  const first = await locate().catch(() => null);
  if (first !== null) return { value: first, retried: false };
  return { value: await locate().catch(() => null), retried: true };
}

/** Byte-identical PNG files (simctl encodes identical pixels identically). */
export function sameFileBytes(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* sim-input decomposition (iOS-4 ticket 1)                                    */
/* -------------------------------------------------------------------------- */

/** One sim-input command's time, split by where it went (ms). The host terms are
 * on the host clock, the rest on sim-input's own; only differences are used. */
export interface SimInputSample {
  /** Host `performance.now()` at the stdin write → at the ack line. */
  hostWriteToAck: number;
  /** sim-input read the line → started the first HID message (null: none sent). */
  recvToFirstSend: number | null;
  /** Each HID message's `sendWithMessage:` call, in order. */
  perMessageSendMs: number[];
  /** The last message returned → the ack was written (null: none sent). */
  lastSendToAck: number | null;
  /** sim-input read the line → wrote the ack. */
  sidecarMs: number;
  /** Time between messages inside sim-input (the gesture's sleeps): sidecar
   * minus the three terms above (null: none sent). */
  gapsMs: number | null;
  /** Host write→ack minus the sidecar time: pipes, JSON, event loop. */
  hostPipeMs: number;
}

const ms3 = (v: number): number => Number(v.toFixed(3));

/**
 * {@link SimInputSample} of a gesture tool result served by sim-input (its
 * `simInput` fields: the ack timing and the host round trip); null when the
 * result carries no sim-input timing.
 */
export function simInputSampleOfResult(result: unknown): SimInputSample | null {
  if (typeof result !== "object" || result === null) return null;
  const f = (result as { simInput?: { timing?: SimInputAck["timing"]; hostRoundTripMs?: number } })
    .simInput;
  if (!f || !f.timing || typeof f.hostRoundTripMs !== "number") return null;
  return decomposeSimInputAck({
    id: 0,
    hostWriteAt: 0,
    hostAckAt: f.hostRoundTripMs,
    timing: f.timing,
  });
}

/** Split one ack into {@link SimInputSample}; null when it carried no timing. */
export function decomposeSimInputAck(ack: SimInputAck): SimInputSample | null {
  const t = ack.timing;
  if (!t) return null;
  const hostWriteToAck = ack.hostAckAt - ack.hostWriteAt;
  const sidecarMs = t.ackAt - t.recvAt;
  const perMessageSendMs = t.sends.map((m) => ms3(m.sendEnd - m.sendStart));
  const first = t.sends[0];
  const last = t.sends[t.sends.length - 1];
  const recvToFirstSend = first ? first.sendStart - t.recvAt : null;
  const lastSendToAck = last ? t.ackAt - last.sendEnd : null;
  const sendSum = t.sends.reduce((a, m) => a + (m.sendEnd - m.sendStart), 0);
  const gapsMs =
    recvToFirstSend !== null && lastSendToAck !== null
      ? sidecarMs - recvToFirstSend - sendSum - lastSendToAck
      : null;
  return {
    hostWriteToAck: ms3(hostWriteToAck),
    recvToFirstSend: recvToFirstSend === null ? null : ms3(recvToFirstSend),
    perMessageSendMs,
    lastSendToAck: lastSendToAck === null ? null : ms3(lastSendToAck),
    sidecarMs: ms3(sidecarMs),
    gapsMs: gapsMs === null ? null : ms3(gapsMs),
    hostPipeMs: ms3(hostWriteToAck - sidecarMs),
  };
}
