/**
 * iOS-2.1 like-for-like bench — OFF (closed simulator-server + ax-service) vs
 * ON-xcuitest (open XCUITest runner: tree from app.snapshot(), input via
 * XCUITest) vs ON-siminput (same XCUITest tree, input via the sim-input HID
 * digitizer). Mirrors the Android bench-open-vs-proprietary.ts block/verb/oracle/
 * per-sample structure, with the iOS drivers behind ONE {@link Arm} interface.
 *
 * LIKE-FOR-LIKE (iOS-2.1, review 2026-09-15-review-ios2-findings.md):
 *   - Every arm drives its `describe`, `gesture-tap` and `gesture-swipe` through
 *     the tool-server registry (`createRegistry()` + `invokeTool`), so every arm
 *     pays the host tool layer — the same axis the Android bench keeps identical
 *     (IOS2-H1). OFF blocks run with the `open-ios-device-server` flag OFF (closed
 *     simulator-server + ax-service). ON blocks run with the flag ON, so describe/
 *     gesture-tap/gesture-swipe route to the open XCUITest runner behind the tool.
 *   - ON-siminput is the ONE exception: its INPUT (tap/swipe) is the `sim-input`
 *     HID digitizer, which has no tool path by construction — those rows are
 *     labelled "bench-local (sim-input HID), no product path". Its `describe`
 *     still goes through `invokeTool` (flag ON → XCUITest runner tree).
 *   - The tap effect oracle and the optical scroll metric use backend-independent
 *     `xcrun simctl io screenshot` captures OUTSIDE every timed window (the README
 *     rule); they are the measurement instrument, not a measured verb, so they do
 *     not go through the `screenshot` tool.
 *   - `locate` is ONE implementation for all arms (IOS2-H3): the coordinate is read
 *     from the open XCUITest tree once per iteration (untimed) and the SAME
 *     normalised point is handed to every arm; the per-iteration coordinate is
 *     persisted so cross-arm agreement is auditable (merge asserts it).
 *   - `await-screen-idle` / `await-ui-element` have no open iOS product path
 *     (IOS2-M7): the ON arms report them `N/A`; only the OFF arms measure the real
 *     tools, with `ensureRoot()` inside the loop (IOS2-H7).
 *
 * Effect oracle for tap (IOS2-H4): neutral-pixel diff ratio per tap RECORDED (not
 * a boolean), the landing threshold DERIVED from the block's own G0 self-test
 * (`landed = ratio ≥ 0.5 × navDiff` AND the destination's navigation bar is the
 * target title, fail closed), and G0 requires `navDiff ≥ 0.10` with `rootDiff ≈ 0`
 * and the same title check. Optical scroll (IOS2-H5): full-resolution NCC via
 * `optical-scroll.ts` (no half-window clamp, refuse only on confidence < 0.6),
 * reported in screen POINTS with the raster scale stated, before/after PNGs kept
 * for a few samples per block.
 *
 * Memory-frugal per-block mode: BENCH_ONLY=<block> runs ONE block in a
 * short-lived process and writes `bench-block-<name>.json` ({env, block});
 * merge-blocks-ios.js assembles the four.
 *
 * Harness repair (2026-10-04, run 37213144359, see
 * docs/open-server/2026-10-04-ios-bench-harness-repair.md):
 *   - ONE XCUITest runner per simulator. The workflow starts no resident runner;
 *     the oracle reads the tree through the tool layer's own runner, resolved from
 *     the block's registry (bench-ios-harness.ts `toolLayerRunner`). With the flag
 *     off the measured tools stay on simulator-server + ax-service and the runner
 *     serves only the oracle, so the oracle is the same instrument in all blocks.
 *   - Target app: every block invokes the product `launch-app` tool, then
 *     `launchApp(Settings)` on the runner, before any tree read; oracle reads pass
 *     `bundleId` so a simctl relaunch never leaves them without a target.
 *   - Every measured describe / gesture sample records the path that served it
 *     (`servedBy`); the merge marks a block INVALID when any sample crossed to the
 *     other arm's path. `connectionErrors` (formerly `runnerCrashes`) counts
 *     connection-class runner failures, quoting the first.
 *   - The swipe "before" frame waits for two identical consecutive frames
 *     (bounded, untimed, recorded) instead of a fixed 900 ms.
 *   - OFF blocks check that simulator-server comes up (`proprietaryReady`).
 *   - BENCH_WARM_RUNNER=1 builds + launches + reads the tool-layer runner once and
 *     shuts it down (the workflow's pre-block check); no block runs.
 *
 * Runner lifetime (run 37223296646, OFF-1 / ON-siminput / OFF-2 "restarted
 * mid-block (starts=2, terminations=none)"): the block's first runner start
 * missed the 120 s ready budget and the oracle's next call started a second one.
 *   - ONE ensure path per block (`RunnerLease`): prepare starts the runner, the
 *     oracle shares that start, and a failed start stays failed (the block is
 *     INVALID with the start's error as its first connection error).
 *   - The oracle retries a transient connection error on the same runner
 *     (bounded) instead of resolving it again.
 *   - Every runner start / termination records the call that triggered it
 *     (`prepare`, `oracle:<op>`, `tool:<name>`); a second start or a termination
 *     invalidates the block with that record as the reason.
 *   - Same standard both arms: a timed describe with 0 elements (`emptyDescribes`)
 *     invalidates the block on either arm; a fallback inside a timed verb
 *     (`fallbacks`: a fallback note at console.debug / console.warn, or a result
 *     marked `proprietary-fallback`) invalidates an ON block. Counts per verb.
 *
 * iOS-4 tickets 1 + 2 (run 37572773799, docs/open-server/2026-10-07-ios4-siminput-plan.md):
 *   - Every arm's describe passes the bundleId the oracle reads (Settings); both
 *     ON arms returned 3 elements vs 30 on ax-service without it. After each simctl
 *     relaunch the oracle re-checks the runner's target (untimed, `ensureRoot`).
 *     Each timed describe records its element count (`elementsSamples`); the merge
 *     marks a block INVALID when > 10 % of them are < 10 while the other config's
 *     median on the same screen is ≥ 20 (`treeSuspect`, both arms).
 *   - Optical scroll: the region is clipped to the chrome-free band and shifts are
 *     scored down to a 10 % overlap (bench-ios-optical.ts); the px→pt scale is the
 *     device type's `mainScreenScale` (the runner reported a 480 pt screen).
 *   - ON-siminput: every measured tap / swipe stores the sim-input ack timing split
 *     (`inputTimings`: host write→ack, receive→first send, per-message send, last
 *     send→ack) for the scoreboard's decomposition table.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { createRegistry } from "../src/utils/setup-registry";
import { setFlag, unsetFlag } from "@argent/configuration-core";
import { resolveDevice } from "../src/utils/device-info";
import { simulatorServerRef } from "../src/blueprints/simulator-server";
import { IosSimInputService } from "../src/utils/ios-sim-input-service";
import {
  FallbackNotes,
  RunnerLease,
  RunnerOracle,
  SETTINGS_BUNDLE_ID,
  decomposeSimInputAck,
  deviceScreenPoints,
  gesturePath,
  isConnectionError,
  isFallbackResult,
  openToolTapPoint,
  proprietaryTapPoint,
  retryLocateOnce,
  sameFileBytes,
  simInputTapPoint,
  toolLayerRunner,
  waitForStableFrame,
  watchRunnerLifecycle,
  type NPoint,
  type RunnerStart,
  type ScreenGeometry,
  type SimInputSample,
  type StageSample,
} from "./bench-ios-harness";
import {
  deviceProfilePlist,
  framebufferScale,
  opticalScrollPx,
  pngDimensions,
} from "./bench-ios-optical";
import { getEncoding, type Tiktoken } from "js-tiktoken";

const execFileAsync = promisify(execFile);

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

const UDID = process.env.BENCH_UDID ?? process.env.IOS_OPEN_SERVER_UDID ?? "";
const N = Number(process.env.BENCH_N ?? 20);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 1);
const OUT_DIR = process.env.BENCH_OUT ?? join(process.cwd(), ".bench-results");
// G4: the equal element cap for the per-tree-backend token comparison.
const DESCRIBE_CAP = Number(process.env.BENCH_DESCRIBE_CAP ?? 400);
const SETTINGS = SETTINGS_BUNDLE_ID;
const TARGET_LABEL = process.env.BENCH_TAP_TARGET ?? "General";
// IOS2-H4: G0 requires a real navigation. The three healthy iOS-2 blocks measured
// 0.176–0.238; a touch highlight is ≈ 0.055. 0.10 rejects the highlight, admits
// the navigation. The per-block landing threshold is derived from the self-test.
const G0_NAV_MIN = Number(process.env.BENCH_G0_NAV_MIN ?? 0.1);
const LANDING_FRACTION_OF_NAV = 0.5;
// How many before/after screenshot pairs to KEEP per block in the artifact
// (IOS2-H4/H5 item 4). The rest are still deleted by rmShot.
const KEEP_SHOTS_PER_BLOCK = 3;
// D: the swipe "before" frame waits for two identical consecutive simctl frames,
// polled every SETTLE_INTERVAL_MS, at most SETTLE_TIMEOUT_MS (untimed, recorded).
const SETTLE_INTERVAL_MS = 250;
const SETTLE_TIMEOUT_MS = 5000;
// Settled locate (run 37595262694): the oracle re-reads the tree LOCATE_STABLE_MS
// apart, at most LOCATE_MAX_READS reads, until two consecutive reads put the
// label's centre at the same place (untimed). Settings inserts its "Ready for
// Apple Intelligence" banner above "General" ~0.3-0.6 s after the read a single
// locate made, moving the row 87 pt down.
const LOCATE_STABLE_MS = Number(process.env.BENCH_LOCATE_STABLE_MS ?? 1000);
const LOCATE_MAX_READS = Number(process.env.BENCH_LOCATE_MAX_READS ?? 5);

if (!UDID)
  throw new Error("BENCH_UDID / IOS_OPEN_SERVER_UDID must be set (the booted simulator udid)");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Reg = ReturnType<typeof createRegistry>;

// Gesture timing params driven identically across blocks (drift gate in the merge).
// `swipeMomentumFree` makes the swipe a controlled scroll (no fling), so the
// optical offset stays inside the search window and is symmetric across arms.
const GESTURE_PARAMS = {
  tapHoldMs: 0,
  swipeDurationMs: 250,
  swipeSteps: 12,
  swipeMomentumFree: true,
} as const;
export type BenchGestureParams = typeof GESTURE_PARAMS;

// The tool layer logs a note when the open iOS path fails and it falls back; each
// measured call reads the notes logged during it (C.1). Installed in main().
const NOTES = new FallbackNotes();

/* -------------------------------------------------------------------------- */
/* stats                                                                      */
/* -------------------------------------------------------------------------- */

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}
interface Summary {
  n: number;
  p50: number;
  p95: number;
  max: number;
  min: number;
  mean: number;
}
function summarize(xs: number[]): Summary {
  const s = xs.slice().sort((a, b) => a - b);
  const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  return {
    n: xs.length,
    p50: pct(s, 50),
    p95: pct(s, 95),
    max: s.length ? s[s.length - 1]! : NaN,
    min: s.length ? s[0]! : NaN,
    mean: Number.isFinite(mean) ? Number(mean.toFixed(1)) : NaN,
  };
}
function iqr(xs: number[]): { q1: number; q3: number; iqr: number; median: number } {
  const s = xs.slice().sort((a, b) => a - b);
  const q1 = pct(s, 25);
  const q3 = pct(s, 75);
  const median = pct(s, 50);
  return { q1, q3, iqr: q3 - q1, median };
}

// Token estimator: js-tiktoken o200k_base (primary) with chars/4 as a secondary
// sanity figure — the same recipe as the Android bench (G4 parity).
let o200k: Tiktoken | null = null;
try {
  o200k = getEncoding("o200k_base");
} catch {
  o200k = null;
}
const TOKENIZER = o200k
  ? "js-tiktoken o200k_base (primary), chars/4 (secondary)"
  : "chars/4 (js-tiktoken o200k_base failed to load)";
const estTokens = (s: string): number => (o200k ? o200k.encode(s).length : Math.ceil(s.length / 4));
const estTokensCharsDiv4 = (s: string): number => Math.ceil(s.length / 4);

/* -------------------------------------------------------------------------- */
/* describe text parsing (shared formatter → comparable per backend)          */
/* -------------------------------------------------------------------------- */

/** Element lines of a formatted describe tree (everything under the ROOT line). */
function describeBody(desc: string): string[] {
  const lines = desc.split("\n");
  const rootIdx = lines.findIndex((l) => l.startsWith("ROOT "));
  const from = rootIdx >= 0 ? rootIdx + 1 : 0;
  return lines.slice(from).filter((l) => l.trim().length > 0);
}
/** id:/text: identity set for the OFF-1 vs ON fidelity jaccard. */
function fidelitySetOf(desc: string): string[] {
  const set = new Set<string>();
  for (const line of describeBody(desc)) {
    const idM = line.match(/\bid="((?:[^"\\]|\\.)*)"/);
    const labelM = line.match(/(?<![=\w])"((?:[^"\\]|\\.)*)"/);
    if (idM?.[1]) set.add(`id:${idM[1]}`);
    if (labelM?.[1]) set.add(`text:${labelM[1]}`);
  }
  return [...set];
}
/** Truncate a formatted describe to the first `cap` element lines (keep ROOT). */
function capDescribe(desc: string, cap: number): string {
  const lines = desc.split("\n");
  const rootIdx = lines.findIndex((l) => l.startsWith("ROOT "));
  const head = rootIdx >= 0 ? lines.slice(0, rootIdx + 1) : [];
  const body = describeBody(desc).slice(0, cap);
  return [...head, ...body].join("\n");
}

/* -------------------------------------------------------------------------- */
/* simctl screenshots + optical metrics (backend-independent)                 */
/* -------------------------------------------------------------------------- */

let shotSeq = 0;
async function simctlScreenshot(tag: string): Promise<string> {
  const file = join(os.tmpdir(), `ios-bench-${tag}-${process.pid}-${shotSeq++}.png`);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await execFileAsync("xcrun", ["simctl", "io", UDID, "screenshot", file], { timeout: 20_000 });
      return file;
    } catch (e) {
      lastErr = e;
      await sleep(400);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Delete a screenshot PNG and its derived BMP. Best-effort, never throws. */
function rmShot(...pngs: string[]): void {
  for (const png of pngs) {
    try {
      rmSync(png, { force: true });
      rmSync(png.replace(/\.png$/, ".bmp"), { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Copy a screenshot into the artifact dir so it survives rmShot (IOS2-H4/H5
 * item 4: keep a few before/after pairs per block). Returns the persisted path. */
function persistShot(src: string, block: string, name: string): string {
  const dir = join(OUT_DIR, "shots", block);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, name);
  try {
    copyFileSync(src, dest);
  } catch {
    /* best effort */
  }
  return dest;
}

interface Bmp {
  width: number;
  height: number;
  data: Buffer;
  stride: number;
  offset: number;
  bpp: number;
}
/** Downscale a PNG to a small 24/32-bit BMP (longest side `longest`) via `sips`,
 * used ONLY by the neutral-pixel diff oracle (a coarse "did anything change"
 * instrument). The optical scroll metric reads the FULL-resolution PNG instead. */
async function toBmp(png: string, longest = 160): Promise<Bmp> {
  const bmp = png.replace(/\.png$/, ".bmp");
  await execFileAsync("sips", ["-s", "format", "bmp", "-Z", String(longest), png, "--out", bmp], {
    timeout: 20_000,
  });
  const buf = readFileSync(bmp);
  const offset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const height = Math.abs(buf.readInt32LE(22));
  const bpp = buf.readUInt16LE(28);
  if (bpp !== 24 && bpp !== 32) throw new Error(`expected 24/32-bit BMP, got ${bpp}`);
  const bytesPerPixel = bpp / 8;
  const stride = Math.floor((width * bytesPerPixel + 3) / 4) * 4;
  return { width, height, data: buf, stride, offset, bpp };
}
/** Fraction of pixels differing by more than `threshold` on any channel sum. */
async function neutralPixelDiffRatio(pngA: string, pngB: string, threshold = 14): Promise<number> {
  const a = await toBmp(pngA);
  const b = await toBmp(pngB);
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const bppA = a.bpp / 8;
  const bppB = b.bpp / 8;
  let changed = 0;
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = a.offset + y * a.stride + x * bppA;
      const ib = b.offset + y * b.stride + x * bppB;
      const d =
        Math.abs(a.data[ia]! - b.data[ib]!) +
        Math.abs(a.data[ia + 1]! - b.data[ib + 1]!) +
        Math.abs(a.data[ia + 2]! - b.data[ib + 2]!);
      if (d > threshold * 3) changed++;
      total++;
    }
  }
  return total === 0 ? 0 : changed / total;
}

interface OpticalPoints {
  /** Optical offset in screen POINTS (content moved up ⇒ positive); NaN if refused. */
  dyPoints: number;
  /** Raw offset in framebuffer PIXELS (diagnostic). */
  dyPx: number;
  /** Peak NCC confidence in [-1, 1]. */
  confidence: number;
  /** Framebuffer px per screen point (the raster scale). */
  rasterScale: number;
  /** The rows correlated (fractions of height): the scroll region clipped to the
   * chrome-free band. */
  opticalRegion: { y1: number; y2: number };
  refused: boolean;
}

/** Framebuffer px per point: the device type's `mainScreenScale` (set in main()),
 * else the framebuffer height over the runner's screen height. */
interface RasterScale {
  scale: number | null;
  source: "device-profile" | "runner-screen-height";
}
let DEVICE_SCALE: number | null = null;

/**
 * OPTICAL scroll offset in screen POINTS (IOS2-H5, iOS-4 ticket 2). Reads the
 * FULL-resolution pre/post-swipe PNGs and runs `opticalScrollPx` (the shared
 * `optical-scroll.ts` NCC over the scroll region clipped to the chrome-free band,
 * shifts up to 0.9 of it down to a 10 % overlap, refuse below confidence 0.6),
 * then converts framebuffer px → points with the raster scale.
 */
function opticalScrollPoints(
  pngBefore: string,
  pngAfter: string,
  region: { y1: number; y2: number },
  screenHeightPoints: number
): OpticalPoints {
  const beforeBuf = readFileSync(pngBefore);
  const afterBuf = readFileSync(pngAfter);
  const est = opticalScrollPx(beforeBuf, afterBuf, region);
  const raster = rasterScaleOf(pngDimensions(beforeBuf).height, screenHeightPoints);
  const dyPx = est.offsetPx ?? NaN;
  const dyPoints = est.refused || !(raster.scale! > 0) ? NaN : dyPx / raster.scale!;
  return {
    dyPoints: Number.isFinite(dyPoints) ? Number(dyPoints.toFixed(2)) : NaN,
    dyPx: Number.isFinite(dyPx) ? Number(dyPx.toFixed(2)) : NaN,
    confidence: est.confidence,
    rasterScale:
      raster.scale && Number.isFinite(raster.scale) ? Number(raster.scale.toFixed(3)) : NaN,
    opticalRegion: {
      y1: Number(est.region.y1.toFixed(4)),
      y2: Number(est.region.y2.toFixed(4)),
    },
    refused: est.refused,
  };
}

function rasterScaleOf(framebufferHeightPx: number, screenHeightPoints: number): RasterScale {
  if (DEVICE_SCALE !== null) return { scale: DEVICE_SCALE, source: "device-profile" };
  const s = framebufferScale(framebufferHeightPx, screenHeightPoints);
  return { scale: Number.isFinite(s) ? s : null, source: "runner-screen-height" };
}

/* -------------------------------------------------------------------------- */
/* Arm interface — the three iOS drivers behind one surface                    */
/* -------------------------------------------------------------------------- */

interface DescribeSample {
  /** The tree backend that actually served this describe (from `source`). */
  backend: string;
  source: string;
  text: string;
  elements: number;
  bytes: number;
  /** The tool layer fell back from the open path during this call. */
  fallback: boolean;
}

/** The path that served one tap / swipe, and whether the tool layer fell back
 * from the open path during it. */
interface Served {
  path: string;
  fallback: boolean;
}

/** The tree backend a describe `source` names. */
function treeOf(source: string): string {
  return source === "xcuitest-runner" ? "xcuitest" : source;
}

/** `proprietaryReady` (E): whether simulator-server came up for an OFF block. */
interface ProprietaryReady {
  checked: boolean;
  ready: boolean;
  error?: string;
}

interface Arm {
  readonly name: string;
  readonly config: "OFF" | "ON";
  /** The tree backend the arm INTENDS to measure. The block's reported backend is
   * derived from the sources its samples observed (C.2). */
  readonly treeBackend: "ax-service" | "xcuitest";
  /** True only when the arm's await-* verbs have a real product tool (OFF). The
   * open iOS path has no await-screen-idle / await-ui-element product (IOS2-M7),
   * so the ON arms report those verbs as N/A instead of a bench-local poll. */
  readonly hasAwaitProduct: boolean;
  /** Whether the tap/swipe input path is a product tool (true) or bench-local
   * sim-input HID (false, ON-siminput) — the row label depends on it (IOS2-H1). */
  readonly inputIsProductTool: boolean;
  /** Block start, untimed: start the tool-layer runner, check simulator-server
   * (OFF), restore the root, `launch-app` tool, runner `launchApp`. */
  prepare(): Promise<void>;
  /** Describe the current screen via `invokeTool` → formatted text (IOS2-H1). */
  describe(): Promise<DescribeSample>;
  /** Open-tree stage timings (G3), or null for the ax-service backend. */
  describeStages(): Promise<StageSample | null>;
  /** Tap a normalized point (host-timed by the caller); resolves to the path
   * that served it (C.1) and whether the tool layer fell back. */
  tap(p: NPoint): Promise<Served>;
  /** Swipe between normalized points over ~250 ms; resolves to the serving path. */
  swipe(from: NPoint, to: NPoint): Promise<Served>;
  /** Locate a label's center as a normalized point on the CURRENT screen — the
   * ONE shared oracle for every arm (IOS2-H3), untimed. */
  locate(label: string): Promise<NPoint | null>;
  /** Whether the CURRENT screen is the one titled `title` (a navigation bar carries
   * it), with the navigation titles seen — the same shared oracle, untimed. */
  destination(title: string): Promise<{ landed: boolean; titles: string[] }>;
  /** The scroll container's normalized vertical span (for the optical region). */
  scrollRegion(): Promise<{ y1: number; y2: number }>;
  /** The runner screen height in POINTS (cached per block; for px→points). */
  screenHeightPoints(): Promise<number>;
  /** Return to the Settings root (relaunch) — identical across arms (IOS2-M6). */
  ensureRoot(): Promise<void>;
  /** Go one screen back (best effort). */
  goBack(): Promise<void>;
  /** await-screen-idle latency — one measured call (OFF only). */
  awaitScreenIdle(): Promise<void>;
  /** await-ui-element latency — one measured call for `label` (OFF only). */
  awaitUiElement(label: string): Promise<void>;
  /** Sim-input ack-timeout count (ON-siminput only; 0 elsewhere). */
  ackTimeouts(): number;
  /** Connection-class runner failures (C.3), with the first message. */
  connectionErrors(): { count: number; first: string | null };
  /** The tool layer's fallback notes seen in this block (first few). */
  fallbackNotes(): string[];
  /** simulator-server readiness (OFF), null on ON blocks. */
  proprietaryReady(): ProprietaryReady | null;
  /** The tool-layer runner as the block saw it. */
  runnerRecord(): RunnerRecord;
  /** simctl relaunches the oracle saw (each one followed by a bundleId-scoped read). */
  oracleRelaunches(): number;
  /** Relaunches after which the runner had lost its target and was relaunched. */
  oracleRetargets(): number;
  /** The sim-input timing split of the last tap / swipe, cleared on read (null on
   * the arms whose input is not sim-input, or when the ack carried no timing). */
  takeInputTiming(): SimInputSample | null;
  dispose(): Promise<void>;
}

/* ---- shared registry driving (all arms pay the tool layer, IOS2-H1) -------- */

async function invokeDescribe(
  reg: Reg
): Promise<{ text: string; source: string; backend?: string }> {
  // iOS-4 ticket 2: name the app the oracle reads on every arm (the ON arms read
  // 3 elements in run 37572773799 without it, from the runner's stored target).
  const r = (await reg.invokeTool("describe", { udid: UDID, bundleId: SETTINGS })) as {
    description?: string;
    source?: string;
    backend?: string;
  };
  return { text: r.description ?? "", source: r.source ?? "unknown", backend: r.backend };
}
function invokeTap(reg: Reg, p: NPoint): Promise<unknown> {
  return reg.invokeTool("gesture-tap", { udid: UDID, x: p.x, y: p.y });
}
function invokeSwipe(reg: Reg, from: NPoint, to: NPoint): Promise<unknown> {
  return reg.invokeTool("gesture-swipe", {
    udid: UDID,
    fromX: from.x,
    fromY: from.y,
    toX: to.x,
    toY: to.y,
    durationMs: GESTURE_PARAMS.swipeDurationMs,
    ...(GESTURE_PARAMS.swipeMomentumFree ? { momentum: false } : {}),
  });
}

const MAX_NOTES_KEPT = 8;

/** The tool-layer runner as one block saw it. */
interface RunnerRecord {
  source: string;
  starts: number;
  terminations: string[];
  readyMs: number | null;
  /** Each start: the call that triggered it and how it ended. */
  startLog: RunnerStart[];
  /** The start error when the block's one start failed. */
  startFailure: string | null;
  /** Oracle RPCs that hit a connection error and succeeded on a retry. */
  oracleRetries: number;
  /** The block's screen geometry the arms convert the oracle's points with. */
  geometry: (ScreenGeometry & { screenSource: "framebuffer" | "runner-size" }) | null;
  /** Consecutive locate reads that disagreed (the layout moved under a locate). */
  locateShifts: number;
  /** Locates that never settled within the read bound (counted as misses). */
  unsettledLocates: number;
}

/**
 * What every arm shares: the block's registry (the flag set before it is created),
 * the oracle over the tool layer's runner, the serving-path record of each tool
 * call, and the connection-error count. The arms differ only in their input path
 * and their await-* / stage verbs.
 */
abstract class ArmBase {
  abstract readonly config: "OFF" | "ON";
  protected readonly reg: Reg;
  protected readonly oracle: RunnerOracle;
  /** The block's ONE ensure path for the tool layer's runner. */
  private readonly lease: RunnerLease<Awaited<ReturnType<typeof toolLayerRunner>>>;
  private readonly lifecycle: ReturnType<typeof watchRunnerLifecycle>;
  /** The call in flight, recorded against every runner start / termination. */
  private callLabel = "prepare";
  private connErrors = 0;
  private firstConnError: string | null = null;
  private notesKept: string[] = [];
  private ready: ProprietaryReady | null = null;
  private runnerReadyMs: number | null = null;
  private geom: RunnerRecord["geometry"] = null;

  constructor(
    readonly name: string,
    private readonly flagOn: boolean
  ) {
    if (flagOn) setFlag("open-ios-device-server", true, "project");
    else unsetFlag("open-ios-device-server", "project");
    this.reg = createRegistry();
    this.lifecycle = watchRunnerLifecycle(this.reg, UDID, { trigger: () => this.callLabel });
    this.lease = new RunnerLease(() => toolLayerRunner(this.reg, UDID));
    this.oracle = new RunnerOracle({
      runner: () => this.lease.ensure(),
      onConnectionError: (m) => this.recordConnectionError(`oracle: ${m}`),
      onCall: (op) => {
        this.callLabel = `oracle:${op}`;
      },
      locateSettle: { stableMs: LOCATE_STABLE_MS, maxReads: LOCATE_MAX_READS },
    });
  }

  /**
   * The block's screen geometry, untimed (run 37595262694): the device screen in
   * points from a simctl framebuffer and the device scale, and the runner's
   * `getScreenSize`. The oracle's points become fractions of that screen. Without
   * a framebuffer or a scale the runner size stands in for the screen (the arms
   * then convert identically, as before), recorded as `runner-size`.
   */
  private async measureGeometry(): Promise<NonNullable<RunnerRecord["geometry"]>> {
    const runner = await this.oracle.screenSize();
    let framebuffer: { width: number; height: number } | null = null;
    try {
      const shot = await simctlScreenshot("geometry");
      framebuffer = pngDimensions(readFileSync(shot));
      rmShot(shot);
    } catch {
      /* no framebuffer: the runner size stands in below */
    }
    const screen = deviceScreenPoints(framebuffer, DEVICE_SCALE);
    this.oracle.setDeviceScreen(screen ?? runner);
    return screen
      ? { screen, runner, screenSource: "framebuffer" }
      : { screen: runner, runner, screenSource: "runner-size" };
  }

  /** The geometry measured in prepare(); before it, the identity geometry. */
  protected geometry(): ScreenGeometry {
    return this.geom ?? { screen: { w: 1, h: 1 }, runner: { w: 1, h: 1 } };
  }

  protected recordConnectionError(message: string): void {
    this.connErrors++;
    if (this.firstConnError === null) this.firstConnError = message;
  }

  /** Fold the fallback notes of one tool call into the block record. */
  private absorb(notes: string[]): void {
    for (const n of notes) {
      if (this.notesKept.length < MAX_NOTES_KEPT) this.notesKept.push(n);
      if (isConnectionError(n)) this.recordConnectionError(`tool layer: ${n}`);
    }
  }

  /** Run one tool call, recording its fallback notes and connection errors.
   * `fallback`: a fallback note was logged during the call, or the result is
   * marked `proprietary-fallback`. */
  protected async viaTool<T>(
    tool: string,
    op: () => Promise<T>
  ): Promise<{ value: T; notes: string[]; fallback: boolean }> {
    this.callLabel = `tool:${tool}`;
    NOTES.take();
    try {
      const value = await op();
      const notes = NOTES.take();
      this.absorb(notes);
      return { value, notes, fallback: notes.length > 0 || isFallbackResult(value) };
    } catch (e) {
      this.absorb(NOTES.take());
      if (isConnectionError(e)) this.recordConnectionError(`tool: ${(e as Error).message}`);
      throw e;
    }
  }

  async prepare(): Promise<void> {
    // 1. The tool layer's runner: the one runner on this simulator for the block,
    //    started through the lease the oracle shares. A failed start stays failed.
    this.callLabel = "prepare";
    const t0 = Date.now();
    try {
      await this.lease.ensure();
    } catch (e) {
      this.recordConnectionError(
        `tool-layer runner did not start (prepare, ${Date.now() - t0} ms): ${(e as Error).message}`
      );
      throw e;
    }
    this.runnerReadyMs = Date.now() - t0;
    // 2. E: simulator-server must come up on an OFF block.
    if (this.config === "OFF") {
      const ref = simulatorServerRef(resolveDevice(UDID));
      try {
        await this.reg.resolveService(ref.urn, ref.options);
        this.ready = { checked: true, ready: true };
      } catch (e) {
        this.ready = { checked: true, ready: false, error: (e as Error).message };
      }
    }
    // 3. Root, then the product launch-app tool (as a user would; every block, so
    //    its native-devtools env setup is the same in all four), then the runner
    //    target (B) before the first tree read. The relaunch here skips
    //    ensureRoot's re-target: the target is set right after launch-app.
    await relaunchViaSimctl();
    this.oracle.noteRelaunch();
    await this.viaTool("launch-app", () =>
      this.reg.invokeTool("launch-app", { udid: UDID, bundleId: SETTINGS })
    );
    await this.oracle.ensureTarget();
    // 4. The screen geometry every oracle point and arm conversion uses.
    this.geom = await this.measureGeometry();
  }

  async describe(): Promise<DescribeSample> {
    const { value, fallback } = await this.viaTool("describe", () => invokeDescribe(this.reg));
    return {
      backend: treeOf(value.source),
      source: value.source,
      text: value.text,
      elements: describeBody(value.text).length,
      bytes: Buffer.byteLength(value.text, "utf8"),
      fallback,
    };
  }

  protected async toolTap(p: NPoint): Promise<Served> {
    const { value, notes, fallback } = await this.viaTool("gesture-tap", () =>
      invokeTap(this.reg, p)
    );
    return { path: gesturePath(this.flagOn, notes, value), fallback };
  }

  protected async toolSwipe(from: NPoint, to: NPoint): Promise<Served> {
    const { value, notes, fallback } = await this.viaTool("gesture-swipe", () =>
      invokeSwipe(this.reg, from, to)
    );
    return { path: gesturePath(this.flagOn, notes, value), fallback };
  }

  locate(label: string): Promise<NPoint | null> {
    return this.oracle.locate(label);
  }
  destination(title: string): Promise<{ landed: boolean; titles: string[] }> {
    return this.oracle.destination(title);
  }
  scrollRegion(): Promise<{ y1: number; y2: number }> {
    return this.oracle.scrollRegion();
  }
  screenHeightPoints(): Promise<number> {
    return this.oracle.screenHeightPoints();
  }
  async ensureRoot(): Promise<void> {
    await relaunchViaSimctl();
    this.oracle.noteRelaunch();
    // iOS-4 ticket 2: re-target the runner now, untimed, so the next measured tool
    // call does not run against a target the relaunch left stale. A failure is
    // recorded by the oracle (connection errors) and retried by its next read.
    await this.oracle.ensureTarget().catch(() => undefined);
  }
  goBack(): Promise<void> {
    return this.ensureRoot();
  }
  connectionErrors(): { count: number; first: string | null } {
    return { count: this.connErrors, first: this.firstConnError };
  }
  fallbackNotes(): string[] {
    return this.notesKept.slice();
  }
  proprietaryReady(): ProprietaryReady | null {
    return this.ready;
  }
  oracleRelaunches(): number {
    return this.oracle.relaunchesSeen();
  }
  oracleRetargets(): number {
    return this.oracle.retargetsSeen();
  }
  takeInputTiming(): SimInputSample | null {
    return null;
  }
  runnerRecord(): RunnerRecord {
    return {
      source: "tool-layer registry (one runner per simulator)",
      starts: this.lifecycle.starts(),
      terminations: this.lifecycle.terminations(),
      readyMs: this.runnerReadyMs,
      startLog: this.lifecycle.startLog(),
      startFailure: this.lease.startFailure(),
      oracleRetries: this.oracle.transientRetries(),
      geometry: this.geom,
      locateShifts: this.oracle.locateShiftsSeen(),
      unsettledLocates: this.oracle.unsettledLocatesSeen(),
    };
  }
  async dispose(): Promise<void> {
    // A second runner start or a termination before the block's own dispose is a
    // connection failure of the measured instrument; the record names the call
    // that triggered each start / termination.
    const cause = this.lifecycle.restartCause();
    if (cause) {
      this.recordConnectionError(cause);
      console.log(`[bench-ios][${this.name}] ${cause}`);
    }
    this.lifecycle.dispose();
    await this.reg.dispose().catch(() => undefined);
  }
}

/* ---- OFF arm: closed simulator-server + ax-service via the registry -------- */

class OffArm extends ArmBase implements Arm {
  readonly config = "OFF" as const;
  readonly treeBackend = "ax-service" as const;
  readonly hasAwaitProduct = true;
  readonly inputIsProductTool = true;
  constructor(name: string) {
    super(name, false);
  }
  async describeStages(): Promise<StageSample | null> {
    return null; // ax-service does not surface snapshot/serialize/encode stages.
  }
  tap(p: NPoint): Promise<Served> {
    return this.toolTap(proprietaryTapPoint(p, this.geometry()));
  }
  swipe(from: NPoint, to: NPoint): Promise<Served> {
    const g = this.geometry();
    return this.toolSwipe(proprietaryTapPoint(from, g), proprietaryTapPoint(to, g));
  }
  async awaitScreenIdle(): Promise<void> {
    await this.reg.invokeTool("await-screen-idle", { udid: UDID, timeoutMs: 4000 });
  }
  async awaitUiElement(label: string): Promise<void> {
    await this.reg.invokeTool("await-ui-element", {
      udid: UDID,
      condition: "exists",
      selector: { text: label },
      timeoutMs: 4000,
    });
  }
  ackTimeouts(): number {
    return 0;
  }
}

/* ---- ON-xcuitest arm: open runner via the tool layer, input via XCUITest ---- */

class XcuitestArm extends ArmBase implements Arm {
  readonly config = "ON" as const;
  readonly treeBackend = "xcuitest" as const;
  readonly hasAwaitProduct = false; // IOS2-M7: no open await product.
  readonly inputIsProductTool = true;
  constructor(name: string) {
    super(name, true);
  }
  describeStages(): Promise<StageSample | null> {
    // G3 stages are only on the direct runner call (the describe tool result omits
    // `timings`); labelled bench-local in the scoreboard. Same runner as the tool.
    return this.oracle.stages();
  }
  tap(p: NPoint): Promise<Served> {
    return this.toolTap(openToolTapPoint(p, this.geometry()));
  }
  swipe(from: NPoint, to: NPoint): Promise<Served> {
    const g = this.geometry();
    return this.toolSwipe(openToolTapPoint(from, g), openToolTapPoint(to, g));
  }
  awaitScreenIdle(): Promise<void> {
    throw new Error("await-screen-idle has no open iOS product (N/A)");
  }
  awaitUiElement(): Promise<void> {
    throw new Error("await-ui-element has no open iOS product (N/A)");
  }
  ackTimeouts(): number {
    return 0;
  }
}

/* ---- ON-siminput arm: open tree via the tool layer, input via sim-input HID - */

class SimInputArm extends ArmBase implements Arm {
  readonly config = "ON" as const;
  readonly treeBackend = "xcuitest" as const;
  readonly hasAwaitProduct = false; // IOS2-M7.
  readonly inputIsProductTool = false; // sim-input HID: bench-local, no product path.
  private sim = new IosSimInputService();
  private ackTimeoutCount = 0;
  private lastTiming: SimInputSample | null = null;
  constructor(name: string) {
    super(name, true);
  }
  describeStages(): Promise<StageSample | null> {
    return this.oracle.stages();
  }
  private async withAckTimeout<T>(op: Promise<T>, ms = 5000): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.ackTimeoutCount++;
        reject(new Error("sim-input ack timed out"));
      }, ms);
    });
    try {
      return await Promise.race([op, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }
  override takeInputTiming(): SimInputSample | null {
    const t = this.lastTiming;
    this.lastTiming = null;
    return t;
  }
  async tap(p: NPoint): Promise<Served> {
    // Screen points of the device screen (measured in prepare, untimed: IOS2-M2).
    const pt = simInputTapPoint(p, this.geometry());
    this.lastTiming = null;
    const ack = await this.withAckTimeout(this.sim.tap(UDID, pt));
    this.lastTiming = decomposeSimInputAck(ack);
    return { path: "sim-input", fallback: false };
  }
  async swipe(from: NPoint, to: NPoint): Promise<Served> {
    const g = this.geometry();
    const a = simInputTapPoint(from, g);
    const b = simInputTapPoint(to, g);
    this.lastTiming = null;
    const ack = await this.withAckTimeout(
      this.sim.swipe(UDID, {
        fromX: a.x,
        fromY: a.y,
        toX: b.x,
        toY: b.y,
        durationMs: GESTURE_PARAMS.swipeDurationMs,
        width: a.width,
        height: a.height,
      })
    );
    this.lastTiming = decomposeSimInputAck(ack);
    return { path: "sim-input", fallback: false };
  }
  awaitScreenIdle(): Promise<void> {
    throw new Error("await-screen-idle has no open iOS product (N/A)");
  }
  awaitUiElement(): Promise<void> {
    throw new Error("await-ui-element has no open iOS product (N/A)");
  }
  ackTimeouts(): number {
    return this.ackTimeoutCount;
  }
  async dispose(): Promise<void> {
    await this.sim.stopAll().catch(() => undefined);
    await super.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/* app lifecycle helpers                                                      */
/* -------------------------------------------------------------------------- */

/** Identical relaunch for every arm (IOS2-M6): terminate + launch via simctl (a
 * backend-independent root restore) + one fixed settle. No per-arm launchApp/idle
 * asymmetry, so no arm can start a gesture on a less-settled screen than another.
 * The runner keeps its target across it; oracle reads name the app explicitly. */
async function relaunchViaSimctl(): Promise<void> {
  try {
    execFileSync("xcrun", ["simctl", "terminate", UDID, SETTINGS], {
      stdio: "ignore",
      timeout: 15_000,
    });
  } catch {
    /* not running */
  }
  await sleep(200);
  try {
    execFileSync("xcrun", ["simctl", "launch", UDID, SETTINGS], {
      stdio: "ignore",
      timeout: 15_000,
    });
  } catch {
    /* ignore */
  }
  await sleep(900);
}

/* -------------------------------------------------------------------------- */
/* verbs                                                                      */
/* -------------------------------------------------------------------------- */

interface VerbResult {
  verb: string;
  latency: Summary;
  latencySamples: number[];
  errors: number;
  errorSamples: string[];
  locateFailed?: number;
  /** Measured samples whose untimed locate missed once and was retried (M4). */
  retries?: number;
  effectChecked?: number;
  effectZero?: number;
  /** C.1: the path that served each measured attempt ("error" when it threw). */
  servedBy?: string[];
  /** Measured attempts during which the tool layer fell back from the open path
   * (invalidates an ON block). */
  fallbacks?: number;
  /** Measured describes that returned 0 elements (describe verbs only;
   * invalidates the block on either arm). */
  emptyDescribes?: number;
  /** Element count of each measured describe (describe verbs only; iOS-4 ticket 2,
   * the merge's `treeSuspect` check). */
  elementsSamples?: number[];
  /** ON-siminput: the sim-input timing split of each measured tap / swipe
   * (iOS-4 ticket 1). */
  inputTimings?: SimInputSample[];
  extra?: Record<string, unknown>;
}

/** What one measured attempt reports: its serving path, whether the tool layer
 * fell back during it, and (describe verbs) whether the tree was empty. */
interface Attempt {
  path: string;
  fallback?: boolean;
  empty?: boolean;
  /** Elements the describe returned (describe verbs). */
  elements?: number;
  /** The sim-input timing split of the attempt's input (ON-siminput). */
  input?: SimInputSample | null;
}

/** Generic timed verb loop with an optional untimed per-iteration setup. A setup
 * that returns `false` (or throws) is retried once, untimed, and counted in
 * `retries`; a second miss is a locate failure (excluded, never a blind tap).
 * When `fn` resolves to an {@link Attempt} it names the serving path of that
 * attempt (C.1) and is tallied into `fallbacks` / `emptyDescribes`. */
async function timeCalls(
  label: string,
  fn: (i: number) => Promise<Attempt | void>,
  setup?: (i: number) => Promise<boolean>,
  extra?: () => Record<string, unknown>
): Promise<VerbResult> {
  for (let i = 0; i < WARMUP; i++) {
    if (setup) await setup(i).catch(() => false);
    await fn(i).catch(() => undefined);
  }
  const lat: number[] = [];
  let errors = 0;
  let locateFailed = 0;
  let retries = 0;
  const errorSamples: string[] = [];
  const servedBy: string[] = [];
  let pathReported = false;
  let fallbacks = 0;
  let emptyDescribes = 0;
  let emptyReported = false;
  const elementsSamples: number[] = [];
  const inputTimings: SimInputSample[] = [];
  for (let i = 0; i < N; i++) {
    if (setup) {
      const { value: ok, retried } = await retryLocateOnce(async () =>
        (await setup(i)) ? true : null
      );
      if (retried) retries++;
      if (!ok) {
        locateFailed++;
        continue; // IOS2-H7: a locate failure EXCLUDES the iteration, no blind tap.
      }
    }
    const t0 = Date.now();
    try {
      const attempt = await fn(i);
      lat.push(Date.now() - t0);
      if (attempt) {
        pathReported = true;
        servedBy.push(attempt.path);
        if (attempt.fallback) fallbacks++;
        if (attempt.empty !== undefined) {
          emptyReported = true;
          if (attempt.empty) emptyDescribes++;
        }
        if (attempt.elements !== undefined) elementsSamples.push(attempt.elements);
        if (attempt.input) inputTimings.push(attempt.input);
      }
    } catch (e) {
      errors++;
      servedBy.push("error");
      if (errorSamples.length < 5)
        errorSamples.push(`i=${i}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    verb: label,
    latency: summarize(lat),
    latencySamples: lat.slice(),
    errors,
    locateFailed,
    ...(setup ? { retries } : {}),
    errorSamples,
    ...(pathReported ? { servedBy, fallbacks } : {}),
    ...(emptyReported ? { emptyDescribes } : {}),
    ...(elementsSamples.length ? { elementsSamples } : {}),
    ...(inputTimings.length ? { inputTimings } : {}),
    extra: extra?.(),
  };
}

/** A verb with no product path on this arm: emitted as N/A, never gated (IOS2-M7). */
function naVerb(verb: string, reason: string): VerbResult {
  return {
    verb,
    latency: summarize([]),
    latencySamples: [],
    errors: 0,
    errorSamples: [],
    extra: { na: reason },
  };
}

interface TapRecord {
  coord: NPoint;
  ratio: number; // max neutral-pixel diff ratio observed (IOS2-H4: recorded, not a boolean)
  pollIndex: number; // which poll the max ratio came from
  latencyMs: number | null; // null when the tap RPC errored
  landed: boolean; // pixelLanded AND titleLanded
  pixelLanded: boolean; // ratio ≥ landingThreshold
  titleLanded: boolean; // the destination's navigation bar is `target` (fail closed)
  navTitles: string[] | null; // navigation titles after the tap; null when the read failed
  errored: boolean;
  servedBy: string; // C.1: the injector that served the tap ("error" when it threw)
  fallback: boolean; // the tool layer fell back from the open path during the tap
}
interface TapEffectResult extends VerbResult {
  inputTimings: SimInputSample[];
  effectChecked: number;
  effectZero: number;
  firstTapNoEffect: number;
  locateFailed: number;
  retries: number;
  landingThreshold: number;
  medianTapCoord: NPoint | null;
  records: TapRecord[];
  noEffectSamples: string[];
}

/**
 * FIRST-attempt, timing-INDEPENDENT effect-checked tap (IOS2-H4). Every iteration:
 * ensureRoot → UNTIMED shared locate → UNTIMED simctl BEFORE → TIMED arm.tap →
 * OUTSIDE the timed window poll the neutral-pixel diff and RECORD the max ratio →
 * read the destination's navigation title from the tree → next iteration's
 * ensureRoot restores. `landed = ratio ≥ landingThreshold AND the destination is
 * titled `target``, where the threshold is 0.5 × the block's own G0 navDiff. The
 * title check fails closed (a failed read or no navigation bar is a miss): any
 * Settings row navigates, so the pixel diff alone counted run 37572773799's taps on
 * "Apple Intelligence & Siri" as landings on "General". A locate failure EXCLUDES
 * the iteration (never a blind tap); a locate miss is retried once, untimed
 * (ensureRoot + locate again, counted in `retries`), a landing miss never is.
 */
async function timeTapEffect(
  arm: Arm,
  target: string,
  block: string,
  landingThreshold: number
): Promise<TapEffectResult> {
  const lat: number[] = [];
  let errors = 0;
  const errorSamples: string[] = [];
  let effectChecked = 0;
  let effectZero = 0;
  let locateFailed = 0;
  let retries = 0;
  const records: TapRecord[] = [];
  const noEffectSamples: string[] = [];
  const inputTimings: SimInputSample[] = [];
  let keptShots = 0;

  const runOne = async (record: boolean): Promise<void> => {
    const { value: coord, retried } = await retryLocateOnce(async () => {
      await arm.ensureRoot();
      return arm.locate(target);
    });
    if (record && retried) retries++;
    if (!coord) {
      if (record) locateFailed++;
      return;
    }
    await sleep(300); // untimed render settle
    const before = await simctlScreenshot("tap-before");
    arm.takeInputTiming(); // clear; untimed
    const t0 = Date.now();
    let tapErr: unknown;
    let servedBy = "error";
    let fallback = false;
    try {
      ({ path: servedBy, fallback } = await arm.tap(coord));
    } catch (e) {
      tapErr = e;
    }
    const dt = Date.now() - t0;
    const input = arm.takeInputTiming();
    if (record && !tapErr && input) inputTimings.push(input);
    let maxRatio = 0;
    let maxPoll = -1;
    let pixelLanded = false;
    let lastAfter = "";
    for (let poll = 0; poll < 3; poll++) {
      await sleep(800);
      const after = await simctlScreenshot("tap-after");
      const ratio = await neutralPixelDiffRatio(before, after).catch(() => 0);
      if (ratio > maxRatio) {
        maxRatio = ratio;
        maxPoll = poll;
      }
      if (lastAfter) rmShot(lastAfter);
      lastAfter = after;
      if (ratio >= landingThreshold) {
        pixelLanded = true;
        break;
      }
    }
    const dest = await arm.destination(target).catch(() => null);
    const titleLanded = dest?.landed === true;
    const landed = pixelLanded && titleLanded;
    // Keep a few before/after pairs per block in the artifact (IOS2-H4 item 4).
    if (record && keptShots < KEEP_SHOTS_PER_BLOCK) {
      persistShot(before, block, `tap-${keptShots}-before.png`);
      if (lastAfter) persistShot(lastAfter, block, `tap-${keptShots}-after.png`);
      keptShots++;
    }
    rmShot(before);
    if (lastAfter) rmShot(lastAfter);
    if (record) {
      records.push({
        coord: { x: Number(coord.x.toFixed(4)), y: Number(coord.y.toFixed(4)) },
        ratio: Number(maxRatio.toFixed(4)),
        pollIndex: maxPoll,
        latencyMs: tapErr ? null : dt,
        landed,
        pixelLanded,
        titleLanded,
        navTitles: dest ? dest.titles : null,
        errored: Boolean(tapErr),
        servedBy,
        fallback,
      });
      if (tapErr) {
        errors++;
        if (errorSamples.length < 5)
          errorSamples.push(`tap: ${tapErr instanceof Error ? tapErr.message : String(tapErr)}`);
      } else {
        lat.push(dt);
      }
      effectChecked++;
      if (!landed) {
        effectZero++;
        if (noEffectSamples.length < 8)
          noEffectSamples.push(
            `${arm.name} tap@(${coord.x.toFixed(3)},${coord.y.toFixed(3)}) ratio=${maxRatio.toFixed(4)} ` +
              `(threshold ${landingThreshold.toFixed(4)}) navTitles=${dest ? JSON.stringify(dest.titles) : "read failed"}`
          );
      }
    }
  };

  for (let i = 0; i < WARMUP; i++) await runOne(false).catch(() => undefined);
  for (let i = 0; i < N; i++) await runOne(true).catch(() => undefined);

  const xs = records.map((r) => r.coord.x).sort((a, b) => a - b);
  const ys = records.map((r) => r.coord.y).sort((a, b) => a - b);
  const medianTapCoord = xs.length && ys.length ? { x: pct(xs, 50), y: pct(ys, 50) } : null;

  return {
    verb: "gesture-tap",
    latency: summarize(lat),
    latencySamples: lat.slice(),
    errors,
    errorSamples,
    effectChecked,
    effectZero,
    firstTapNoEffect: effectZero,
    locateFailed,
    retries,
    landingThreshold: Number(landingThreshold.toFixed(4)),
    medianTapCoord,
    records,
    noEffectSamples,
    inputTimings,
  };
}

interface SwipeRecord {
  from: NPoint;
  to: NPoint;
  region: { y1: number; y2: number };
  /** The rows correlated: `region` clipped to the chrome-free band. */
  opticalRegion: { y1: number; y2: number };
  dyPoints: number;
  dyPx: number;
  confidence: number;
  refused: boolean;
  servedBy: string; // C.1
  fallback: boolean;
  /** D: the untimed wait for a stable "before" frame. */
  settleMs: number;
  settleStable: boolean;
  settleFrames: number;
}
interface ScrollResult {
  arm: string;
  unit: "screen-points";
  rasterScale: number | null;
  /** Where the raster scale came from (iOS-4 ticket 2). */
  rasterScaleSource: RasterScale["source"];
  offsetsPoints: number[];
  /** The accepted offsets in framebuffer px (scale-free, comparable across arms). */
  offsetsPx: number[];
  medianPx: number;
  median: number;
  q1: number;
  q3: number;
  iqr: number;
  refusals: number;
  n: number;
  records: SwipeRecord[];
  /** D: stable-frame settle before each "before" capture (outside the timed window). */
  settle: {
    intervalMs: number;
    timeoutMs: number;
    stable: number;
    unstable: number;
    waitMsP50: number;
    waitMsMax: number;
  };
}

/** OPTICAL swipe (IOS2-H5): timed swipe + full-resolution NCC offset OUTSIDE the
 * timed window, reported in screen POINTS. Returns the swipe latency verb AND the
 * per-arm optical offset distribution + per-swipe records.
 *
 * D: the "before" frame is taken once the screen is stable — the oracle tree shows
 * the root target, then two consecutive simctl frames are byte-identical (bounded
 * by SETTLE_TIMEOUT_MS) — instead of right after a fixed 900 ms relaunch settle,
 * which left run 37213144359's "before" frames blank. The wait is untimed and
 * recorded per swipe. */
async function timeSwipeOptical(
  arm: Arm,
  block: string
): Promise<{ verb: VerbResult; scroll: ScrollResult }> {
  const lat: number[] = [];
  let errors = 0;
  const errorSamples: string[] = [];
  const offsets: number[] = [];
  const offsetsPx: number[] = [];
  const inputTimings: SimInputSample[] = [];
  const records: SwipeRecord[] = [];
  const servedBy: string[] = [];
  let fallbacks = 0;
  const settleWaits: number[] = [];
  let settleStable = 0;
  let settleUnstable = 0;
  let refusals = 0;
  let rasterScale: number | null = null;
  let keptShots = 0;

  const region = await arm.scrollRegion().catch(() => ({ y1: 0.2, y2: 0.85 }));
  const screenH = await arm.screenHeightPoints().catch(() => NaN);
  const midX = 0.5;
  // Swipe the list BODY, not the header (IOS2-H5 item 5): start low in the region,
  // end high — a scroll-up of the settings list.
  const from: NPoint = { x: midX, y: region.y1 + (region.y2 - region.y1) * 0.75 };
  const to: NPoint = { x: midX, y: region.y1 + (region.y2 - region.y1) * 0.25 };

  const runOne = async (record: boolean): Promise<void> => {
    await arm.ensureRoot();
    // D: settle OUTSIDE the timed window. The tree read waits for the app to
    // answer with the root target; then two identical consecutive frames.
    const s0 = Date.now();
    await arm.locate(TARGET_LABEL).catch(() => null);
    const settle = await waitForStableFrame({
      capture: () => simctlScreenshot("swipe-before"),
      same: sameFileBytes,
      discard: (f) => rmShot(f),
      intervalMs: SETTLE_INTERVAL_MS,
      timeoutMs: SETTLE_TIMEOUT_MS,
    });
    const settleMs = Date.now() - s0;
    const before = settle.frame;
    arm.takeInputTiming(); // clear; untimed
    const t0 = Date.now();
    let err: unknown;
    let path = "error";
    let fallback = false;
    try {
      ({ path, fallback } = await arm.swipe(from, to));
    } catch (e) {
      err = e;
    }
    const dt = Date.now() - t0;
    const input = arm.takeInputTiming();
    if (record && !err && input) inputTimings.push(input);
    await sleep(500); // settle OUTSIDE the timed window before the optical read
    const after = await simctlScreenshot("swipe-after");
    let off: OpticalPoints = {
      dyPoints: NaN,
      dyPx: NaN,
      confidence: 0,
      rasterScale: NaN,
      opticalRegion: region,
      refused: true,
    };
    try {
      off = opticalScrollPoints(before, after, region, screenH);
    } catch {
      /* refused */
    }
    if (record && Number.isFinite(off.rasterScale)) rasterScale = off.rasterScale;
    if (record && keptShots < KEEP_SHOTS_PER_BLOCK) {
      persistShot(before, block, `swipe-${keptShots}-before.png`);
      persistShot(after, block, `swipe-${keptShots}-after.png`);
      keptShots++;
    }
    rmShot(before, after);
    if (record) {
      records.push({
        from: { x: Number(from.x.toFixed(4)), y: Number(from.y.toFixed(4)) },
        to: { x: Number(to.x.toFixed(4)), y: Number(to.y.toFixed(4)) },
        region: { y1: Number(region.y1.toFixed(4)), y2: Number(region.y2.toFixed(4)) },
        opticalRegion: off.opticalRegion,
        dyPoints: off.dyPoints,
        dyPx: off.dyPx,
        confidence: off.confidence,
        refused: off.refused,
        servedBy: path,
        fallback,
        settleMs,
        settleStable: settle.stable,
        settleFrames: settle.frames,
      });
      servedBy.push(path);
      if (fallback) fallbacks++;
      settleWaits.push(settleMs);
      if (settle.stable) settleStable++;
      else settleUnstable++;
      if (err) {
        errors++;
        if (errorSamples.length < 5)
          errorSamples.push(`swipe: ${err instanceof Error ? err.message : String(err)}`);
      } else {
        lat.push(dt);
      }
      if (off.refused || !Number.isFinite(off.dyPoints)) refusals++;
      else {
        offsets.push(off.dyPoints);
        offsetsPx.push(off.dyPx);
      }
    }
  };

  for (let i = 0; i < WARMUP; i++) await runOne(false).catch(() => undefined);
  for (let i = 0; i < N; i++) await runOne(true).catch(() => undefined);

  const q = iqr(offsets);
  return {
    verb: {
      verb: "gesture-swipe",
      latency: summarize(lat),
      latencySamples: lat.slice(),
      errors,
      errorSamples,
      servedBy,
      fallbacks,
      ...(inputTimings.length ? { inputTimings } : {}),
    },
    scroll: {
      arm: arm.name,
      unit: "screen-points",
      rasterScale,
      rasterScaleSource: DEVICE_SCALE !== null ? "device-profile" : "runner-screen-height",
      offsetsPoints: offsets.slice(),
      offsetsPx: offsetsPx.slice(),
      medianPx: offsetsPx.length ? iqr(offsetsPx).median : NaN,
      median: offsets.length ? q.median : NaN,
      q1: offsets.length ? q.q1 : NaN,
      q3: offsets.length ? q.q3 : NaN,
      iqr: offsets.length ? q.iqr : NaN,
      refusals,
      n: offsets.length,
      records,
      settle: {
        intervalMs: SETTLE_INTERVAL_MS,
        timeoutMs: SETTLE_TIMEOUT_MS,
        stable: settleStable,
        unstable: settleUnstable,
        waitMsP50: summarize(settleWaits).p50,
        waitMsMax: summarize(settleWaits).max,
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* block                                                                      */
/* -------------------------------------------------------------------------- */

interface BlockResult {
  block: string;
  config: "OFF" | "ON";
  /** The arm's intended tree backend. */
  intendedBackend: "ax-service" | "xcuitest";
  /** C.2: the tree backend the describe samples were OBSERVED on (`mixed(…)` when
   * more than one). The merge re-derives it from `servedBy`. */
  treeBackend: string;
  inputIsProductTool: boolean;
  hasAwaitProduct: boolean;
  verbs: VerbResult[];
  describe: {
    backend: string;
    source: string;
    elements: number;
    bytes: number;
    tokens: number;
    tokensCharsDiv4: number;
    cap: number;
    capElements: number;
    capTokens: number;
  };
  describeStages: { n: number; maxDelta: number; samples: StageSample[] } | null;
  scroll: ScrollResult | null;
  oracle: {
    selfTestPassed: boolean;
    target: string;
    navDiff: number;
    rootDiff: number;
    navTitles: string[] | null;
    navMin: number;
    landingThreshold: number;
    note: string;
    targetApp: string;
    relaunches: number;
    /** Relaunches after which the runner had lost its target (iOS-4 ticket 2). */
    retargets: number;
  };
  effectCheckedTotal: number;
  firstTapNoEffectTotal: number;
  effectZeroTotal: number;
  locateFailedTotal: number;
  landingRate: number | null;
  medianTapCoord: NPoint | null;
  tapRecords: TapRecord[];
  noEffectSamples: string[];
  simInputAckTimeouts: number;
  /** C.3: connection-class runner failures (formerly `runnerCrashes`). */
  connectionErrors: number;
  firstConnectionError: string | null;
  /** The tool layer's fallback notes seen in the block (first few). */
  fallbackNotes: string[];
  /** E: simulator-server readiness (OFF blocks). */
  proprietaryReady: ProprietaryReady | null;
  runner: RunnerRecord;
  degradedReasons: string[];
  fidelitySet: string[];
  gestureParams: BenchGestureParams;
  notes: string[];
}

function makeArm(block: string): Arm {
  switch (block) {
    case "OFF-1":
    case "OFF-2":
      return new OffArm(block);
    case "ON-xcuitest":
      return new XcuitestArm(block);
    case "ON-siminput":
      return new SimInputArm(block);
    default:
      throw new Error(`unknown block "${block}"`);
  }
}

interface SelfTest {
  selfTestPassed: boolean;
  navDiff: number;
  rootDiff: number;
  /** Navigation titles after the self-test tap; null when not read. */
  navTitles: string[] | null;
  note: string;
}

/** G0 oracle self-test with one retry (a transient screenshot blip or a first
 * cold tap must not fail the block on its own). */
async function oracleSelfTest(arm: Arm, target: string): Promise<SelfTest> {
  let last = await oracleSelfTestOnce(arm, target);
  if (!last.selfTestPassed) last = await oracleSelfTestOnce(arm, target);
  return last;
}
async function oracleSelfTestOnce(arm: Arm, target: string): Promise<SelfTest> {
  try {
    await arm.ensureRoot();
    const coord = await arm.locate(target);
    if (!coord)
      return {
        selfTestPassed: false,
        navDiff: 0,
        rootDiff: 0,
        navTitles: null,
        note: `target "${target}" not found on root`,
      };
    const rootShot = await simctlScreenshot("oracle-root");
    await arm.tap(coord);
    await sleep(1200);
    const navShot = await simctlScreenshot("oracle-nav");
    const navDiff = await neutralPixelDiffRatio(rootShot, navShot);
    // The tap must reach the screen titled `target`, not any pushed screen.
    const dest = await arm.destination(target).catch(() => null);
    await arm.goBack();
    await sleep(1000);
    const backShot = await simctlScreenshot("oracle-back");
    const rootDiff = await neutralPixelDiffRatio(rootShot, backShot);
    rmShot(rootShot, navShot, backShot);
    // IOS2-H4: navigation must be a REAL screen change (navDiff ≥ 0.10, an order of
    // magnitude above a row highlight ≈ 0.055), and BACK must restore the root
    // (rootDiff ≈ 0: below half the navigation change), and the pushed screen must
    // be titled `target` (fail closed: a failed read or no navigation bar fails).
    const pixelsOk = navDiff >= G0_NAV_MIN && rootDiff < LANDING_FRACTION_OF_NAV * navDiff;
    const titleOk = dest?.landed === true;
    const selfTestPassed = pixelsOk && titleOk;
    const titles = dest ? JSON.stringify(dest.titles) : "read failed";
    return {
      selfTestPassed,
      navDiff: Number(navDiff.toFixed(4)),
      rootDiff: Number(rootDiff.toFixed(4)),
      navTitles: dest ? dest.titles : null,
      note: selfTestPassed
        ? "ok"
        : !pixelsOk
          ? `navDiff=${navDiff.toFixed(4)} rootDiff=${rootDiff.toFixed(4)} (needs navDiff>=${G0_NAV_MIN} and rootDiff<${LANDING_FRACTION_OF_NAV}*navDiff)`
          : `tap on "${target}" reached navTitles=${titles}, not "${target}"`,
    };
  } catch (e) {
    return {
      selfTestPassed: false,
      navDiff: 0,
      rootDiff: 0,
      navTitles: null,
      note: `self-test threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function runBlock(block: string): Promise<BlockResult> {
  const arm = makeArm(block);
  const notes: string[] = [];
  const degradedReasons: string[] = [];

  // Runner up (the tool layer's, the only one), simulator-server checked (OFF),
  // root restored, `launch-app` tool, runner target set — all before any tree read.
  // A failure here leaves the oracle without a runner: the block still runs and
  // writes its JSON, and G0 / validity mark it INVALID.
  await arm.prepare().catch((e: unknown) => {
    notes.push(`block setup failed: ${e instanceof Error ? e.message : String(e)}`);
  });

  // ---- describe sample (idle root) → bytes/tokens/elements/fidelity (G4) -----
  let desc = await arm.describe();
  for (let attempt = 0; attempt < 4 && desc.elements === 0; attempt++) {
    await arm.ensureRoot();
    await sleep(600);
    desc = await arm.describe();
  }
  if (desc.elements === 0)
    notes.push("describe tree was still empty after warmup (backend not injectable?)");
  // A describe served by the other arm's path is caught by the merge's validity
  // gate from `describe.source` + every verb's `servedBy` (C.1/C.2).
  const capped = capDescribe(desc.text, DESCRIBE_CAP);
  const describeSample = {
    backend: desc.backend,
    source: desc.source,
    elements: desc.elements,
    bytes: desc.bytes,
    tokens: estTokens(desc.text),
    tokensCharsDiv4: estTokensCharsDiv4(desc.text),
    cap: DESCRIBE_CAP,
    capElements: Math.min(desc.elements, DESCRIBE_CAP),
    capTokens: estTokens(capped),
  };
  const fidelitySet = fidelitySetOf(desc.text);

  // ---- G0 oracle self-test ---------------------------------------------------
  const selfTest = await oracleSelfTest(arm, TARGET_LABEL);
  // The per-block landing threshold is DERIVED from this block's own navigation
  // change (IOS2-H4). If the self-test failed to measure a navigation, fall back
  // to 0.5 × the required minimum so the landing counter is never trivially met.
  const landingThreshold =
    selfTest.navDiff >= G0_NAV_MIN
      ? LANDING_FRACTION_OF_NAV * selfTest.navDiff
      : LANDING_FRACTION_OF_NAV * G0_NAV_MIN;
  const oracle = {
    target: TARGET_LABEL,
    navMin: G0_NAV_MIN,
    landingThreshold: Number(landingThreshold.toFixed(4)),
    ...selfTest,
    targetApp: SETTINGS,
    relaunches: 0, // filled at the end of the block
    retargets: 0, // filled at the end of the block
  };

  const verbs: VerbResult[] = [];

  // ---- verb: describe (idle) -------------------------------------------------
  await arm.ensureRoot();
  verbs.push(
    await timeCalls("describe", async () => {
      const d = await arm.describe();
      return {
        path: d.source,
        fallback: d.fallback,
        empty: d.elements === 0,
        elements: d.elements,
      };
    })
  );

  // ---- G3 describe stages (ON only, direct socket) --------------------------
  let describeStages: BlockResult["describeStages"] = null;
  {
    const samples: StageSample[] = [];
    for (let i = 0; i < N; i++) {
      const s = await arm.describeStages().catch(() => null);
      if (s) samples.push(s);
    }
    if (samples.length) {
      describeStages = {
        n: samples.length,
        maxDelta: Math.max(...samples.map((s) => s.delta)),
        samples,
      };
    }
  }

  // ---- verb: gesture-tap (effect-checked) -----------------------------------
  const tapVerb = await timeTapEffect(arm, TARGET_LABEL, block, landingThreshold);
  verbs.push({
    verb: tapVerb.verb,
    latency: tapVerb.latency,
    latencySamples: tapVerb.latencySamples,
    errors: tapVerb.errors,
    errorSamples: tapVerb.errorSamples,
    locateFailed: tapVerb.locateFailed,
    retries: tapVerb.retries,
    effectChecked: tapVerb.effectChecked,
    effectZero: tapVerb.effectZero,
    servedBy: tapVerb.records.map((r) => r.servedBy),
    fallbacks: tapVerb.records.filter((r) => r.fallback).length,
    ...(tapVerb.inputTimings.length ? { inputTimings: tapVerb.inputTimings } : {}),
    extra: {
      inputPath: arm.inputIsProductTool
        ? "gesture-tap tool (invokeTool)"
        : "sim-input HID (bench-local, no product path)",
    },
  });

  // ---- verb: tap+describe ----------------------------------------------------
  // Window = tap RPC + describe RPC only (IOS2-H6). Setup (untimed): ensureRoot +
  // shared locate; a locate failure EXCLUDES the iteration (no blind tap). Records
  // tap/describe sub-timings inside the window.
  let tapCoordForTd: NPoint | null = null;
  const tdSub: Array<{ tapMs: number; describeMs: number }> = [];
  verbs.push(
    await timeCalls(
      "tap+describe",
      async () => {
        const c = tapCoordForTd!;
        arm.takeInputTiming(); // clear; outside the window's work
        const a0 = Date.now();
        const tap = await arm.tap(c);
        const a1 = Date.now();
        const input = arm.takeInputTiming();
        const d = await arm.describe();
        const a2 = Date.now();
        tdSub.push({ tapMs: a1 - a0, describeMs: a2 - a1 });
        return {
          path: `${tap.path}+${d.source}`,
          fallback: tap.fallback || d.fallback,
          empty: d.elements === 0,
          input,
        };
      },
      async () => {
        await arm.ensureRoot();
        tapCoordForTd = await arm.locate(TARGET_LABEL);
        return tapCoordForTd !== null;
      },
      () => ({
        subTimings: {
          tapMsP50: summarize(tdSub.map((s) => s.tapMs)).p50,
          describeMsP50: summarize(tdSub.map((s) => s.describeMs)).p50,
          n: tdSub.length,
        },
        inputPath: arm.inputIsProductTool
          ? "gesture-tap tool (invokeTool)"
          : "sim-input HID (bench-local, no product path)",
      })
    )
  );

  // ---- verb: gesture-swipe (250ms) + optical offset (points) ----------------
  const { verb: swipeVerb, scroll } = await timeSwipeOptical(arm, block);
  verbs.push({
    ...swipeVerb,
    extra: {
      inputPath: arm.inputIsProductTool
        ? "gesture-swipe tool (invokeTool)"
        : "sim-input HID (bench-local, no product path)",
    },
  });

  // ---- verb: await-screen-idle / await-ui-element ---------------------------
  // ON: no open product (IOS2-M7) → N/A. OFF: the real tools, ensureRoot INSIDE
  // the loop (IOS2-H7), a tap to create motion, no blind-tap fallback.
  if (arm.hasAwaitProduct) {
    await arm.ensureRoot();
    const awaitIdleVerb = await timeCalls(
      "await-screen-idle",
      async () => {
        await arm.awaitScreenIdle();
      },
      async () => {
        await arm.ensureRoot(); // IOS2-H7: per-iteration root, never a drifted screen
        const coord = await arm.locate(TARGET_LABEL);
        if (!coord) return false; // exclude, no blind tap
        await arm.tap(coord).catch(() => undefined);
        return true;
      }
    );
    verbs.push(awaitIdleVerb);
    if (awaitIdleVerb.latency.min >= 3990 && awaitIdleVerb.latency.n > 0) {
      degradedReasons.push(
        "await-screen-idle capped on every iteration (wrong/never-settling screen)"
      );
    }

    await arm.ensureRoot();
    const awaitElVerb = await timeCalls(
      "await-ui-element",
      async () => {
        await arm.awaitUiElement(TARGET_LABEL);
      },
      async () => {
        await arm.ensureRoot();
        return true;
      }
    );
    verbs.push(awaitElVerb);
    if (awaitElVerb.latency.min >= 3990 && awaitElVerb.latency.n > 0) {
      degradedReasons.push("await-ui-element capped on every iteration (target never appeared)");
    }
  } else {
    verbs.push(naVerb("await-screen-idle", "N/A (no open iOS await product; iOS-4)"));
    verbs.push(naVerb("await-ui-element", "N/A (no open iOS await product; iOS-4)"));
  }

  // ---- paste / gesture-pinch: no ON counterpart yet (iOS-4) -----------------
  verbs.push(naVerb("paste", "N/A (iOS-4)"));
  verbs.push(naVerb("gesture-pinch", "N/A (iOS-4)"));

  const effectCheckedTotal = tapVerb.effectChecked;
  const firstTapNoEffectTotal = tapVerb.firstTapNoEffect;
  const landingRate =
    effectCheckedTotal > 0
      ? Number(((effectCheckedTotal - firstTapNoEffectTotal) / effectCheckedTotal).toFixed(4))
      : null;

  // C.2: the reported tree backend is what the describe samples observed.
  const observedTrees = [
    ...new Set(
      [desc.source, ...(verbs.find((v) => v.verb === "describe")?.servedBy ?? [])]
        .filter((p) => p !== "error")
        .map(treeOf)
    ),
  ].sort();
  const treeBackend =
    observedTrees.length === 1
      ? observedTrees[0]!
      : observedTrees.length === 0
        ? "unknown"
        : `mixed(${observedTrees.join(",")})`;

  // Dispose first: a runner that terminated mid-block is counted on dispose.
  await arm.dispose().catch(() => undefined);
  oracle.relaunches = arm.oracleRelaunches();
  oracle.retargets = arm.oracleRetargets();
  const conn = arm.connectionErrors();

  const result: BlockResult = {
    block,
    config: arm.config,
    intendedBackend: arm.treeBackend,
    treeBackend,
    inputIsProductTool: arm.inputIsProductTool,
    hasAwaitProduct: arm.hasAwaitProduct,
    verbs,
    describe: describeSample,
    describeStages,
    scroll,
    oracle,
    effectCheckedTotal,
    firstTapNoEffectTotal,
    effectZeroTotal: tapVerb.effectZero,
    locateFailedTotal: tapVerb.locateFailed,
    landingRate,
    medianTapCoord: tapVerb.medianTapCoord,
    tapRecords: tapVerb.records,
    noEffectSamples: tapVerb.noEffectSamples,
    simInputAckTimeouts: arm.ackTimeouts(),
    connectionErrors: conn.count,
    firstConnectionError: conn.first,
    fallbackNotes: arm.fallbackNotes(),
    proprietaryReady: arm.proprietaryReady(),
    runner: arm.runnerRecord(),
    degradedReasons,
    fidelitySet,
    gestureParams: GESTURE_PARAMS,
    notes,
  };
  return result;
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

/** `verb=n,…` for the verbs with a non-zero `key`, or `0`. */
function perVerb(
  verbs: VerbResult[],
  key: "fallbacks" | "emptyDescribes" | "retries" | "locateFailed"
): string {
  const hits = verbs.filter((v) => (v[key] ?? 0) > 0).map((v) => `${v.verb}=${v[key]}`);
  return hits.length ? hits.join(",") : "0";
}

async function xcodebuildVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("xcodebuild", ["-version"], { timeout: 15_000 });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}
/** The device type's framebuffer px per point (`mainScreenScale` in its
 * CoreSimulator profile), or null when it cannot be read. */
async function simctlDeviceScale(deviceTypeId: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devicetypes", "-j"], {
      timeout: 15_000,
    });
    const plist = deviceProfilePlist(JSON.parse(stdout), deviceTypeId);
    if (!plist) return null;
    const { stdout: raw } = await execFileAsync(
      "plutil",
      ["-extract", "mainScreenScale", "raw", "-o", "-", plist],
      { timeout: 5_000 }
    );
    const v = Number(raw.trim());
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

async function simctlRuntime(): Promise<{ runtime: string; deviceType: string }> {
  try {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "-j"], {
      timeout: 15_000,
    });
    const j = JSON.parse(stdout) as {
      devices: Record<string, Array<{ udid: string; name: string; deviceTypeIdentifier?: string }>>;
    };
    for (const [runtime, list] of Object.entries(j.devices)) {
      const hit = list.find((d) => d.udid === UDID);
      if (hit) return { runtime, deviceType: hit.deviceTypeIdentifier ?? hit.name };
    }
  } catch {
    /* ignore */
  }
  return { runtime: "unknown", deviceType: "unknown" };
}

/**
 * BENCH_WARM_RUNNER=1: build (cached) + launch the tool layer's runner once, set
 * the target, read one tree, shut it down. The workflow runs it before the blocks
 * so a runner that cannot build or start fails the job in minutes, and every block
 * then finds the build cache warm. Exactly the code path the blocks use.
 */
async function warmRunner(): Promise<void> {
  const reg = createRegistry();
  try {
    const t0 = Date.now();
    const runner = await toolLayerRunner(reg, UDID);
    const t1 = Date.now();
    await runner.launchApp(SETTINGS);
    const st = await runner.getNestedState({ bundleId: SETTINGS });
    let nodes = 0;
    const count = (ns: typeof st.tree): void => {
      for (const n of ns) {
        nodes++;
        count(n.children);
      }
    };
    count(st.tree);
    console.log(
      `[bench-ios] warm runner: ready in ${t1 - t0} ms (build cached or built + launch), ` +
        `${SETTINGS} tree ${nodes} nodes in ${Date.now() - t1} ms`
    );
    if (nodes === 0) throw new Error(`the runner read an empty ${SETTINGS} tree`);
  } finally {
    await reg.dispose().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (process.env.BENCH_WARM_RUNNER === "1") {
    await warmRunner();
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const started = new Date().toISOString();
  NOTES.install(console);

  const { runtime, deviceType } = await simctlRuntime();
  DEVICE_SCALE = await simctlDeviceScale(deviceType);
  const env = {
    startedAt: started,
    udid: UDID,
    runner: "tool-layer registry (one per simulator; no resident runner)",
    N,
    WARMUP,
    tokenizer: TOKENIZER,
    describeCap: DESCRIBE_CAP,
    g0NavMin: G0_NAV_MIN,
    runId: process.env.GITHUB_RUN_ID ?? null,
    sha: process.env.GITHUB_SHA ?? null, // IOS2-M8: the tested sha in the header
    xcodebuild: await xcodebuildVersion(),
    runtime,
    deviceType,
    deviceScreenScale: DEVICE_SCALE,
    macosVersion: os.release(),
  };
  console.log("[bench-ios] env:", JSON.stringify(env));

  const ALL_BLOCKS = ["OFF-1", "ON-xcuitest", "ON-siminput", "OFF-2"];
  const only = process.env.BENCH_ONLY;
  const toRun = only ? ALL_BLOCKS.filter((b) => b === only) : ALL_BLOCKS;
  if (only && toRun.length === 0)
    throw new Error(`BENCH_ONLY="${only}" is not one of ${ALL_BLOCKS.join("|")}`);

  const blocks: BlockResult[] = [];
  for (const block of toRun) {
    console.log(`########## BLOCK ${block} ##########`);
    const r = await runBlock(block);
    blocks.push(r);
    console.log(
      `[bench-ios][${block}] intended=${r.intendedBackend} observedTree=${r.treeBackend} ` +
        `oracleSelfTest=${r.oracle.selfTestPassed ? "pass" : "FAILED"} ` +
        `navDiff=${r.oracle.navDiff} landThresh=${r.oracle.landingThreshold} ` +
        `landing=${r.effectCheckedTotal - r.firstTapNoEffectTotal}/${r.effectCheckedTotal} ` +
        `ackTimeouts=${r.simInputAckTimeouts} connectionErrors=${r.connectionErrors}` +
        `${r.firstConnectionError ? ` (first: ${JSON.stringify(r.firstConnectionError)})` : ""} ` +
        `fallbackNotes=${r.fallbackNotes.length} runnerStarts=${r.runner.starts} ` +
        `runnerReadyMs=${r.runner.readyMs ?? "n/a"} oracleRetries=${r.runner.oracleRetries} ` +
        `timedFallbacks=${perVerb(r.verbs, "fallbacks")} timedEmptyDescribes=${perVerb(r.verbs, "emptyDescribes")} ` +
        `locateRetries=${perVerb(r.verbs, "retries")} locateFailed=${perVerb(r.verbs, "locateFailed")} ` +
        `simulatorServerReady=${r.proprietaryReady ? r.proprietaryReady.ready : "n/a"} ` +
        `describeTokens=${r.describe.tokens}@${r.describe.elements}el ` +
        `stageMaxDelta=${r.describeStages ? r.describeStages.maxDelta : "n/a"} ` +
        `scrollMedianPts=${r.scroll ? r.scroll.median : "n/a"}(px=${r.scroll ? r.scroll.medianPx : "n/a"} scale=${r.scroll ? `${r.scroll.rasterScale}/${r.scroll.rasterScaleSource}` : "n/a"} refusals=${r.scroll ? r.scroll.refusals : "n/a"}) ` +
        `oracleRetargets=${r.oracle.retargets} ` +
        `geometry=${r.runner.geometry ? `screen ${r.runner.geometry.screen.w}x${r.runner.geometry.screen.h}/${r.runner.geometry.screenSource} runner ${r.runner.geometry.runner.w}x${r.runner.geometry.runner.h}` : "n/a"} ` +
        `locateShifts=${r.runner.locateShifts} unsettledLocates=${r.runner.unsettledLocates} ` +
        `swipeSettle=${r.scroll ? `${r.scroll.settle.stable} stable/${r.scroll.settle.unstable} unstable p50=${r.scroll.settle.waitMsP50}ms` : "n/a"}`
    );
  }

  if (only) {
    const blockPath = join(OUT_DIR, `bench-block-${only}.json`);
    writeFileSync(blockPath, JSON.stringify({ env, block: blocks[0] }, null, 2));
    process.stdout.write(`RESULT_JSON=${blockPath}\n`);
    return;
  }

  const outPath = join(OUT_DIR, `bench-ios-${started.replace(/[:.]/g, "-")}.json`);
  writeFileSync(
    outPath,
    JSON.stringify({ env, blocks, finishedAt: new Date().toISOString() }, null, 2)
  );
  process.stdout.write(`RESULT_JSON=${outPath}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[bench-ios] FATAL", e);
    process.exit(1);
  });
