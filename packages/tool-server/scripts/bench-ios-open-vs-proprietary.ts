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
 * (`landed = ratio ≥ 0.5 × navDiff`), and G0 requires `navDiff ≥ 0.10` with
 * `rootDiff ≈ 0`. Optical scroll (IOS2-H5): full-resolution NCC via
 * `optical-scroll.ts` (no half-window clamp, refuse only on confidence < 0.6),
 * reported in screen POINTS with the raster scale stated, before/after PNGs kept
 * for a few samples per block.
 *
 * Memory-frugal per-block mode: BENCH_ONLY=<block> runs ONE block in a
 * short-lived process and writes `bench-block-<name>.json` ({env, block});
 * merge-blocks-ios.js assembles the four.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { createRegistry } from "../src/utils/setup-registry";
import { setFlag, unsetFlag } from "@argent/configuration-core";
import { IosOpenServerClient, type IosOpenServerNode } from "../src/utils/ios-open-server-client";
import { openServerIosNestedToDescribeNode } from "../src/tools/describe/platforms/ios/open-server-tree";
import { formatDescribeTree } from "../src/tools/describe/format-tree";
import { IosSimInputService } from "../src/utils/ios-sim-input-service";
import { estimateScrollPx } from "./optical-scroll";
import { framebufferPxToPoints, framebufferScale, pngDimensions } from "./bench-ios-optical";
import { getEncoding, type Tiktoken } from "js-tiktoken";

const execFileAsync = promisify(execFile);

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

const UDID = process.env.BENCH_UDID ?? process.env.IOS_OPEN_SERVER_UDID ?? "";
const RUNNER_PORT = Number(process.env.IOS_OPEN_SERVER_PORT ?? "0");
const N = Number(process.env.BENCH_N ?? 20);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 1);
const OUT_DIR = process.env.BENCH_OUT ?? join(process.cwd(), ".bench-results");
// G4: the equal element cap for the per-tree-backend token comparison.
const DESCRIBE_CAP = Number(process.env.BENCH_DESCRIBE_CAP ?? 400);
const SETTINGS = "com.apple.Preferences";
const TARGET_LABEL = process.env.BENCH_TAP_TARGET ?? "General";
// IOS2-H4: G0 requires a real navigation. The three healthy iOS-2 blocks measured
// 0.176–0.238; a touch highlight is ≈ 0.055. 0.10 rejects the highlight, admits
// the navigation. The per-block landing threshold is derived from the self-test.
const G0_NAV_MIN = Number(process.env.BENCH_G0_NAV_MIN ?? 0.1);
const LANDING_FRACTION_OF_NAV = 0.5;
// How many before/after screenshot pairs to KEEP per block in the artifact
// (IOS2-H4/H5 item 4). The rest are still deleted by rmShot.
const KEEP_SHOTS_PER_BLOCK = 3;

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

/** A connection-class RPC failure = the runner process/socket died (IOS2-M9). */
function isConnectionError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|socket closed|not connected|write after end|read ECONN/i.test(
    m
  );
}

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
  refused: boolean;
}
/**
 * OPTICAL scroll offset in screen POINTS (IOS2-H5). Reads the FULL-resolution
 * pre/post-swipe PNGs, runs the shared `optical-scroll.ts` NCC estimator over the
 * scroll region (no half-window clamp; maxShiftFrac 0.9 of the region ≥ the swipe
 * distance; refuse only on confidence < 0.6), then converts framebuffer px →
 * points against the runner's screen height.
 */
function opticalScrollPoints(
  pngBefore: string,
  pngAfter: string,
  region: { y1: number; y2: number },
  screenHeightPoints: number
): OpticalPoints {
  const beforeBuf = readFileSync(pngBefore);
  const afterBuf = readFileSync(pngAfter);
  const est = estimateScrollPx(beforeBuf, afterBuf, {
    y0: Math.max(0, Math.min(1, region.y1)),
    y1: Math.max(0, Math.min(1, region.y2)),
    minConfidence: 0.6,
    maxShiftFrac: 0.9,
  });
  const dims = pngDimensions(beforeBuf);
  const rasterScale = framebufferScale(dims.height, screenHeightPoints);
  const dyPx = est.offsetPx ?? NaN;
  const dyPoints = est.refused ? NaN : framebufferPxToPoints(dyPx, dims.height, screenHeightPoints);
  return {
    dyPoints: Number.isFinite(dyPoints) ? Number(dyPoints.toFixed(2)) : NaN,
    dyPx: Number.isFinite(dyPx) ? Number(dyPx.toFixed(2)) : NaN,
    confidence: est.confidence,
    rasterScale: Number.isFinite(rasterScale) ? Number(rasterScale.toFixed(3)) : NaN,
    refused: est.refused,
  };
}

/* -------------------------------------------------------------------------- */
/* Arm interface — the three iOS drivers behind one surface                    */
/* -------------------------------------------------------------------------- */

interface DescribeSample {
  backend: "ax-service" | "xcuitest";
  source: string;
  text: string;
  elements: number;
  bytes: number;
}
interface StageSample {
  snapshotMs: number;
  serializeMs: number;
  encodeMs: number;
  captureMs: number;
  sum: number;
  delta: number;
}
/** Normalized 0..1 point on screen. */
interface NPoint {
  x: number;
  y: number;
}

interface Arm {
  readonly name: string;
  readonly config: "OFF" | "ON";
  readonly treeBackend: "ax-service" | "xcuitest";
  /** True only when the arm's await-* verbs have a real product tool (OFF). The
   * open iOS path has no await-screen-idle / await-ui-element product (IOS2-M7),
   * so the ON arms report those verbs as N/A instead of a bench-local poll. */
  readonly hasAwaitProduct: boolean;
  /** Whether the tap/swipe input path is a product tool (true) or bench-local
   * sim-input HID (false, ON-siminput) — the row label depends on it (IOS2-H1). */
  readonly inputIsProductTool: boolean;
  /** Describe the current screen via `invokeTool` → formatted text (IOS2-H1). */
  describe(): Promise<DescribeSample>;
  /** Open-tree stage timings (G3), or null for the ax-service backend. */
  describeStages(): Promise<StageSample | null>;
  /** Tap a normalized point (host-timed by the caller). */
  tap(p: NPoint): Promise<void>;
  /** Swipe between normalized points over ~250 ms. */
  swipe(from: NPoint, to: NPoint): Promise<void>;
  /** Locate a label's center as a normalized point on the CURRENT screen — the
   * ONE shared implementation for every arm (IOS2-H3), from the open XCUITest
   * tree, backend-independent and untimed. */
  locate(label: string): Promise<NPoint | null>;
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
  /** Runner exit/crash count observed (ON arms; 0 on OFF). */
  crashes(): number;
  dispose(): Promise<void>;
}

/* ---- ON tree helpers (shared by every arm's locate) ------------------------ */

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
 * The best HITTABLE match for `label`, computed HOST-SIDE (IOS2-H2/H3). Since the
 * runner's own `hittable` is only a heuristic (`isEnabled && hasArea`, a real
 * XCUITest hit-test would be an iOS-4 runner field), the predicate here is the
 * documented best effort:
 *   - on-screen  : the node's CENTER frame sits inside the window with a small
 *                  margin (not above the status bar, not below the home strip);
 *   - enabled    : the runner's `hittable` flag (isEnabled && hasArea);
 *   - not occluded: among the on-screen enabled matches, the one painted LAST in
 *                  DFS/paint order (a later-painted sibling covers an earlier one),
 *                  a best-effort z-order top pick.
 * Falls back to on-screen matches, then any match, so a missing flag never
 * returns null.
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
  const chosen = (pool.length ? pool : matches)
    .slice()
    // topmost by z-order: last painted (highest DFS index) among the candidates.
    .sort((a, b) => b.dfs - a.dfs)[0];
  return chosen?.node;
}
function findScrollContainer(nodes: IosOpenServerNode[]): IosOpenServerNode | undefined {
  const types = ["Table", "CollectionView", "ScrollView"];
  for (const t of types) {
    let hit: IosOpenServerNode | undefined;
    walk(nodes, (n) => {
      if (!hit && n.type === t) hit = n;
    });
    if (hit) return hit;
  }
  return undefined;
}

/** Shared open-tree reader over the resident XCUITest runner. Every arm holds one
 * for the backend-independent `locate` / `scrollRegion` / `screenSize`; the ON
 * arms additionally use it for their describe tree and the G3 stage timings. */
class OpenTree {
  private cachedHeightPoints: number | null = null;
  constructor(private readonly client: IosOpenServerClient) {}
  async describe(): Promise<DescribeSample> {
    const st = await this.client.getNestedState();
    const node = openServerIosNestedToDescribeNode(
      st.tree,
      st.info.screenWidth,
      st.info.screenHeight
    );
    const text = formatDescribeTree(node, { source: "open-device-server" });
    return {
      backend: "xcuitest",
      source: "xcuitest-runner",
      text,
      elements: describeBody(text).length,
      bytes: Buffer.byteLength(text, "utf8"),
    };
  }
  async stages(): Promise<StageSample> {
    const st = await this.client.getNestedState();
    const t = st.timings;
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
  async locate(label: string): Promise<NPoint | null> {
    const st = await this.client.getNestedState();
    const hit = findTappableByLabel(st.tree, label, st.info.screenWidth, st.info.screenHeight);
    if (!hit) return null;
    const cxPt = (hit.bounds.x1 + hit.bounds.x2) / 2;
    const cyPt = (hit.bounds.y1 + hit.bounds.y2) / 2;
    return { x: cxPt / st.info.screenWidth, y: cyPt / st.info.screenHeight };
  }
  async scrollRegion(): Promise<{ y1: number; y2: number }> {
    const st = await this.client.getNestedState();
    const c = findScrollContainer(st.tree);
    if (!c) return { y1: 0.2, y2: 0.85 };
    // Clamp to [0,1]: a Table can report a content-sized frame taller than the
    // window (IOS2-H5 item 5), which would put a swipe endpoint off-screen.
    const y1 = Math.max(0, Math.min(1, c.bounds.y1 / st.info.screenHeight));
    const y2 = Math.max(0, Math.min(1, c.bounds.y2 / st.info.screenHeight));
    return y1 < y2 ? { y1, y2 } : { y1: 0.2, y2: 0.85 };
  }
  async screenHeightPoints(): Promise<number> {
    if (this.cachedHeightPoints !== null) return this.cachedHeightPoints;
    const s = await this.client.getScreenSize();
    this.cachedHeightPoints = s.screenHeight;
    return s.screenHeight;
  }
  async screenSize(): Promise<{ w: number; h: number }> {
    const s = await this.client.getScreenSize();
    return { w: s.screenWidth, h: s.screenHeight };
  }
}

/* ---- shared registry driving (all arms pay the tool layer, IOS2-H1) -------- */

async function invokeDescribe(reg: Reg): Promise<{ text: string; source: string }> {
  const r = (await reg.invokeTool("describe", { udid: UDID })) as {
    description?: string;
    source?: string;
  };
  return { text: r.description ?? "", source: r.source ?? "unknown" };
}
async function invokeTap(reg: Reg, p: NPoint): Promise<void> {
  await reg.invokeTool("gesture-tap", { udid: UDID, x: p.x, y: p.y });
}
async function invokeSwipe(reg: Reg, from: NPoint, to: NPoint): Promise<void> {
  await reg.invokeTool("gesture-swipe", {
    udid: UDID,
    fromX: from.x,
    fromY: from.y,
    toX: to.x,
    toY: to.y,
    durationMs: GESTURE_PARAMS.swipeDurationMs,
    ...(GESTURE_PARAMS.swipeMomentumFree ? { momentum: false } : {}),
  });
}

/* ---- OFF arm: closed simulator-server + ax-service via the registry -------- */

class OffArm implements Arm {
  readonly config = "OFF" as const;
  readonly treeBackend = "ax-service" as const;
  readonly hasAwaitProduct = true;
  readonly inputIsProductTool = true;
  private reg: Reg;
  private open: OpenTree;
  constructor(readonly name: string) {
    unsetFlag("open-ios-device-server", "project");
    this.reg = createRegistry();
    // Backend-independent locate reads the resident open XCUITest tree so all four
    // blocks target the SAME frame (IOS2-H3). Untimed, never a measured verb here.
    this.open = new OpenTree(new IosOpenServerClient({ port: RUNNER_PORT, timeoutMs: 90_000 }));
  }
  async describe(): Promise<DescribeSample> {
    const { text, source } = await invokeDescribe(this.reg);
    return {
      backend: "ax-service",
      source,
      text,
      elements: describeBody(text).length,
      bytes: Buffer.byteLength(text, "utf8"),
    };
  }
  async describeStages(): Promise<StageSample | null> {
    return null; // ax-service does not surface snapshot/serialize/encode stages.
  }
  tap(p: NPoint): Promise<void> {
    return invokeTap(this.reg, p);
  }
  swipe(from: NPoint, to: NPoint): Promise<void> {
    return invokeSwipe(this.reg, from, to);
  }
  locate(label: string): Promise<NPoint | null> {
    return this.open.locate(label);
  }
  scrollRegion(): Promise<{ y1: number; y2: number }> {
    return this.open.scrollRegion();
  }
  screenHeightPoints(): Promise<number> {
    return this.open.screenHeightPoints();
  }
  ensureRoot(): Promise<void> {
    return relaunchViaSimctl();
  }
  goBack(): Promise<void> {
    return relaunchViaSimctl();
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
  crashes(): number {
    return 0;
  }
  async dispose(): Promise<void> {
    await this.reg.dispose().catch(() => undefined);
  }
}

/* ---- ON-xcuitest arm: open runner via the tool layer, input via XCUITest ---- */

class XcuitestArm implements Arm {
  readonly config = "ON" as const;
  readonly treeBackend = "xcuitest" as const;
  readonly hasAwaitProduct = false; // IOS2-M7: no open await product.
  readonly inputIsProductTool = true;
  private reg: Reg;
  private open: OpenTree;
  private crashCount = 0;
  constructor(readonly name: string) {
    setFlag("open-ios-device-server", true, "project");
    this.reg = createRegistry();
    this.open = new OpenTree(new IosOpenServerClient({ port: RUNNER_PORT, timeoutMs: 90_000 }));
  }
  private async probe<T>(op: Promise<T>): Promise<T> {
    try {
      return await op;
    } catch (e) {
      if (isConnectionError(e)) this.crashCount++;
      throw e;
    }
  }
  async describe(): Promise<DescribeSample> {
    // Flag ON → invokeTool("describe") routes to the open XCUITest runner and pays
    // the host tool layer (IOS2-H1). The formatted text matches the open tree.
    const { text, source } = await invokeDescribe(this.reg);
    return {
      backend: "xcuitest",
      source,
      text,
      elements: describeBody(text).length,
      bytes: Buffer.byteLength(text, "utf8"),
    };
  }
  describeStages(): Promise<StageSample | null> {
    // G3 stages are only on the direct socket (the describe tool result omits
    // `timings`); labelled bench-local, direct-socket in the scoreboard.
    return this.probe(this.open.stages());
  }
  tap(p: NPoint): Promise<void> {
    return invokeTap(this.reg, p);
  }
  swipe(from: NPoint, to: NPoint): Promise<void> {
    return invokeSwipe(this.reg, from, to);
  }
  locate(label: string): Promise<NPoint | null> {
    return this.probe(this.open.locate(label));
  }
  scrollRegion(): Promise<{ y1: number; y2: number }> {
    return this.probe(this.open.scrollRegion());
  }
  screenHeightPoints(): Promise<number> {
    return this.probe(this.open.screenHeightPoints());
  }
  ensureRoot(): Promise<void> {
    return relaunchViaSimctl();
  }
  goBack(): Promise<void> {
    return relaunchViaSimctl();
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
  crashes(): number {
    return this.crashCount;
  }
  async dispose(): Promise<void> {
    await this.reg.dispose().catch(() => undefined);
  }
}

/* ---- ON-siminput arm: open tree via the tool layer, input via sim-input HID - */

class SimInputArm implements Arm {
  readonly config = "ON" as const;
  readonly treeBackend = "xcuitest" as const;
  readonly hasAwaitProduct = false; // IOS2-M7.
  readonly inputIsProductTool = false; // sim-input HID: bench-local, no product path.
  private reg: Reg;
  private open: OpenTree;
  private sim: IosSimInputService;
  private ackTimeoutCount = 0;
  private crashCount = 0;
  private cachedSize: { w: number; h: number } | null = null;
  constructor(readonly name: string) {
    setFlag("open-ios-device-server", true, "project");
    this.reg = createRegistry();
    this.open = new OpenTree(new IosOpenServerClient({ port: RUNNER_PORT, timeoutMs: 90_000 }));
    this.sim = new IosSimInputService();
  }
  private async probe<T>(op: Promise<T>): Promise<T> {
    try {
      return await op;
    } catch (e) {
      if (isConnectionError(e)) this.crashCount++;
      throw e;
    }
  }
  private async size(): Promise<{ w: number; h: number }> {
    // Fetched OUT of the timed window (IOS2-M2) and cached per block.
    if (!this.cachedSize) this.cachedSize = await this.probe(this.open.screenSize());
    return this.cachedSize;
  }
  async describe(): Promise<DescribeSample> {
    // Describe still goes through the tool layer (flag ON → XCUITest tree).
    const { text, source } = await invokeDescribe(this.reg);
    return {
      backend: "xcuitest",
      source,
      text,
      elements: describeBody(text).length,
      bytes: Buffer.byteLength(text, "utf8"),
    };
  }
  describeStages(): Promise<StageSample | null> {
    return this.probe(this.open.stages());
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
  async tap(p: NPoint): Promise<void> {
    const { w, h } = await this.size(); // cached, untimed
    await this.withAckTimeout(this.sim.tap(UDID, { x: p.x * w, y: p.y * h, width: w, height: h }));
  }
  async swipe(from: NPoint, to: NPoint): Promise<void> {
    const { w, h } = await this.size();
    await this.withAckTimeout(
      this.sim.swipe(UDID, {
        fromX: from.x * w,
        fromY: from.y * h,
        toX: to.x * w,
        toY: to.y * h,
        durationMs: GESTURE_PARAMS.swipeDurationMs,
        width: w,
        height: h,
      })
    );
  }
  locate(label: string): Promise<NPoint | null> {
    return this.probe(this.open.locate(label));
  }
  scrollRegion(): Promise<{ y1: number; y2: number }> {
    return this.probe(this.open.scrollRegion());
  }
  screenHeightPoints(): Promise<number> {
    return this.probe(this.open.screenHeightPoints());
  }
  ensureRoot(): Promise<void> {
    return relaunchViaSimctl();
  }
  goBack(): Promise<void> {
    return relaunchViaSimctl();
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
  crashes(): number {
    return this.crashCount;
  }
  async dispose(): Promise<void> {
    await this.sim.stopAll().catch(() => undefined);
    await this.reg.dispose().catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* app lifecycle helpers                                                      */
/* -------------------------------------------------------------------------- */

/** Identical relaunch for every arm (IOS2-M6): terminate + launch via simctl (a
 * backend-independent root restore) + one fixed settle. No per-arm launchApp/idle
 * asymmetry, so no arm can start a gesture on a less-settled screen than another. */
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
  effectChecked?: number;
  effectZero?: number;
  extra?: Record<string, unknown>;
}

/** Generic timed verb loop with an optional untimed per-iteration setup. Counts a
 * setup that returns `false` as a locate failure (excluded, never a blind tap). */
async function timeCalls(
  label: string,
  fn: (i: number) => Promise<void>,
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
  const errorSamples: string[] = [];
  for (let i = 0; i < N; i++) {
    if (setup) {
      const ok = await setup(i).catch(() => false);
      if (!ok) {
        locateFailed++;
        continue; // IOS2-H7: a locate failure EXCLUDES the iteration, no blind tap.
      }
    }
    const t0 = Date.now();
    try {
      await fn(i);
      lat.push(Date.now() - t0);
    } catch (e) {
      errors++;
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
    errorSamples,
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
  landed: boolean;
  errored: boolean;
}
interface TapEffectResult extends VerbResult {
  effectChecked: number;
  effectZero: number;
  firstTapNoEffect: number;
  locateFailed: number;
  landingThreshold: number;
  medianTapCoord: NPoint | null;
  records: TapRecord[];
  noEffectSamples: string[];
}

/**
 * FIRST-attempt, timing-INDEPENDENT effect-checked tap (IOS2-H4). Every iteration:
 * ensureRoot → UNTIMED shared locate → UNTIMED simctl BEFORE → TIMED arm.tap →
 * OUTSIDE the timed window poll the neutral-pixel diff and RECORD the max ratio →
 * next iteration's ensureRoot restores. `landed = ratio ≥ landingThreshold`, where
 * the threshold is 0.5 × the block's own G0 navDiff. A locate failure EXCLUDES the
 * iteration (never a blind tap); a miss is never retried away.
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
  const records: TapRecord[] = [];
  const noEffectSamples: string[] = [];
  let keptShots = 0;

  const runOne = async (record: boolean): Promise<void> => {
    await arm.ensureRoot();
    const coord = await arm.locate(target);
    if (!coord) {
      if (record) locateFailed++;
      return;
    }
    await sleep(300); // untimed render settle
    const before = await simctlScreenshot("tap-before");
    const t0 = Date.now();
    let tapErr: unknown;
    try {
      await arm.tap(coord);
    } catch (e) {
      tapErr = e;
    }
    const dt = Date.now() - t0;
    let maxRatio = 0;
    let maxPoll = -1;
    let landed = false;
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
        landed = true;
        break;
      }
    }
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
        errored: Boolean(tapErr),
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
            `${arm.name} tap@(${coord.x.toFixed(3)},${coord.y.toFixed(3)}) ratio=${maxRatio.toFixed(4)} < ${landingThreshold.toFixed(4)}`
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
    landingThreshold: Number(landingThreshold.toFixed(4)),
    medianTapCoord,
    records,
    noEffectSamples,
  };
}

interface SwipeRecord {
  from: NPoint;
  to: NPoint;
  region: { y1: number; y2: number };
  dyPoints: number;
  dyPx: number;
  confidence: number;
  refused: boolean;
}
interface ScrollResult {
  arm: string;
  unit: "screen-points";
  rasterScale: number | null;
  offsetsPoints: number[];
  median: number;
  q1: number;
  q3: number;
  iqr: number;
  refusals: number;
  n: number;
  records: SwipeRecord[];
}

/** OPTICAL swipe (IOS2-H5): timed swipe + full-resolution NCC offset OUTSIDE the
 * timed window, reported in screen POINTS. Returns the swipe latency verb AND the
 * per-arm optical offset distribution + per-swipe records. */
async function timeSwipeOptical(
  arm: Arm,
  block: string
): Promise<{ verb: VerbResult; scroll: ScrollResult }> {
  const lat: number[] = [];
  let errors = 0;
  const errorSamples: string[] = [];
  const offsets: number[] = [];
  const records: SwipeRecord[] = [];
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
    const before = await simctlScreenshot("swipe-before");
    const t0 = Date.now();
    let err: unknown;
    try {
      await arm.swipe(from, to);
    } catch (e) {
      err = e;
    }
    const dt = Date.now() - t0;
    await sleep(500); // settle OUTSIDE the timed window before the optical read
    const after = await simctlScreenshot("swipe-after");
    let off: OpticalPoints = {
      dyPoints: NaN,
      dyPx: NaN,
      confidence: 0,
      rasterScale: NaN,
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
        dyPoints: off.dyPoints,
        dyPx: off.dyPx,
        confidence: off.confidence,
        refused: off.refused,
      });
      if (err) {
        errors++;
        if (errorSamples.length < 5)
          errorSamples.push(`swipe: ${err instanceof Error ? err.message : String(err)}`);
      } else {
        lat.push(dt);
      }
      if (off.refused || !Number.isFinite(off.dyPoints)) refusals++;
      else offsets.push(off.dyPoints);
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
    },
    scroll: {
      arm: arm.name,
      unit: "screen-points",
      rasterScale,
      offsetsPoints: offsets.slice(),
      median: offsets.length ? q.median : NaN,
      q1: offsets.length ? q.q1 : NaN,
      q3: offsets.length ? q.q3 : NaN,
      iqr: offsets.length ? q.iqr : NaN,
      refusals,
      n: offsets.length,
      records,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* block                                                                      */
/* -------------------------------------------------------------------------- */

interface BlockResult {
  block: string;
  config: "OFF" | "ON";
  treeBackend: "ax-service" | "xcuitest";
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
    navMin: number;
    landingThreshold: number;
    note: string;
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
  runnerCrashes: number;
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

/** G0 oracle self-test with one retry (a transient screenshot blip or a first
 * cold tap must not fail the block on its own). */
async function oracleSelfTest(
  arm: Arm,
  target: string
): Promise<{ selfTestPassed: boolean; navDiff: number; rootDiff: number; note: string }> {
  let last = await oracleSelfTestOnce(arm, target);
  if (!last.selfTestPassed) last = await oracleSelfTestOnce(arm, target);
  return last;
}
async function oracleSelfTestOnce(
  arm: Arm,
  target: string
): Promise<{ selfTestPassed: boolean; navDiff: number; rootDiff: number; note: string }> {
  try {
    await arm.ensureRoot();
    const coord = await arm.locate(target);
    if (!coord)
      return {
        selfTestPassed: false,
        navDiff: 0,
        rootDiff: 0,
        note: `target "${target}" not found on root`,
      };
    const rootShot = await simctlScreenshot("oracle-root");
    await arm.tap(coord);
    await sleep(1200);
    const navShot = await simctlScreenshot("oracle-nav");
    const navDiff = await neutralPixelDiffRatio(rootShot, navShot);
    await arm.goBack();
    await sleep(1000);
    const backShot = await simctlScreenshot("oracle-back");
    const rootDiff = await neutralPixelDiffRatio(rootShot, backShot);
    rmShot(rootShot, navShot, backShot);
    // IOS2-H4: navigation must be a REAL screen change (navDiff ≥ 0.10, an order of
    // magnitude above a row highlight ≈ 0.055), and BACK must restore the root
    // (rootDiff ≈ 0: below half the navigation change).
    const selfTestPassed = navDiff >= G0_NAV_MIN && rootDiff < LANDING_FRACTION_OF_NAV * navDiff;
    return {
      selfTestPassed,
      navDiff: Number(navDiff.toFixed(4)),
      rootDiff: Number(rootDiff.toFixed(4)),
      note: selfTestPassed
        ? "ok"
        : `navDiff=${navDiff.toFixed(4)} rootDiff=${rootDiff.toFixed(4)} (needs navDiff>=${G0_NAV_MIN} and rootDiff<${LANDING_FRACTION_OF_NAV}*navDiff)`,
    };
  } catch (e) {
    return {
      selfTestPassed: false,
      navDiff: 0,
      rootDiff: 0,
      note: `self-test threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function runBlock(block: string): Promise<BlockResult> {
  const arm = makeArm(block);
  const notes: string[] = [];
  const degradedReasons: string[] = [];

  await arm.ensureRoot();

  // ---- describe sample (idle root) → bytes/tokens/elements/fidelity (G4) -----
  let desc = await arm.describe();
  for (let attempt = 0; attempt < 4 && desc.elements === 0; attempt++) {
    await arm.ensureRoot();
    await sleep(600);
    desc = await arm.describe();
  }
  if (desc.elements === 0)
    notes.push("describe tree was still empty after warmup (backend not injectable?)");
  // Masked-fallback guard (IOS2-H1): the ON path must report the open source.
  const expectSource = arm.config === "ON" ? "xcuitest-runner" : "ax-service";
  if (arm.config === "ON" && desc.source !== "xcuitest-runner")
    notes.push(`describe.source="${desc.source}" (expected ${expectSource}) — masked fallback`);
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
  };

  const verbs: VerbResult[] = [];

  // ---- verb: describe (idle) -------------------------------------------------
  await arm.ensureRoot();
  verbs.push(
    await timeCalls("describe", async () => {
      await arm.describe();
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
    effectChecked: tapVerb.effectChecked,
    effectZero: tapVerb.effectZero,
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
        const a0 = Date.now();
        await arm.tap(c);
        const a1 = Date.now();
        await arm.describe();
        const a2 = Date.now();
        tdSub.push({ tapMs: a1 - a0, describeMs: a2 - a1 });
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

  const result: BlockResult = {
    block,
    config: arm.config,
    treeBackend: arm.treeBackend,
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
    runnerCrashes: arm.crashes(),
    degradedReasons,
    fidelitySet,
    gestureParams: GESTURE_PARAMS,
    notes,
  };

  await arm.dispose().catch(() => undefined);
  return result;
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

async function xcodebuildVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("xcodebuild", ["-version"], { timeout: 15_000 });
    return stdout.trim();
  } catch {
    return "unknown";
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

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const started = new Date().toISOString();

  const { runtime, deviceType } = await simctlRuntime();
  const env = {
    startedAt: started,
    udid: UDID,
    runnerPort: RUNNER_PORT,
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
      `[bench-ios][${block}] backend=${r.treeBackend} oracleSelfTest=${r.oracle.selfTestPassed ? "pass" : "FAILED"} ` +
        `navDiff=${r.oracle.navDiff} landThresh=${r.oracle.landingThreshold} ` +
        `landing=${r.effectCheckedTotal - r.firstTapNoEffectTotal}/${r.effectCheckedTotal} ` +
        `ackTimeouts=${r.simInputAckTimeouts} crashes=${r.runnerCrashes} ` +
        `describeTokens=${r.describe.tokens}@${r.describe.elements}el ` +
        `stageMaxDelta=${r.describeStages ? r.describeStages.maxDelta : "n/a"} ` +
        `scrollMedianPts=${r.scroll ? r.scroll.median : "n/a"}(refusals=${r.scroll ? r.scroll.refusals : "n/a"})`
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
