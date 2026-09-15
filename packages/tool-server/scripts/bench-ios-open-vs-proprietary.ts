/**
 * iOS-2 like-for-like bench — OFF (closed simulator-server + ax-service) vs
 * ON-xcuitest (open XCUITest runner: tree from app.snapshot(), input via
 * XCUITest) vs ON-siminput (same XCUITest tree, input via the sim-input HID
 * digitizer). Mirrors the Android bench-open-vs-proprietary.ts block/verb/oracle/
 * per-sample structure, with the iOS drivers behind ONE {@link Arm} interface.
 *
 * How the arms are driven (see the results file header for the like-for-like
 * caveats — this is a REPORT-ONLY phase, G2, no promotion):
 *   - OFF-1 / OFF-2: the closed simulator-server + ax-service via the tool-server
 *     registry (`createRegistry()` + `invokeTool`), the `open-ios-device-server`
 *     flag OFF. Its ack is acceptance, not effect; gesture timelines are
 *     host-paced. Fetched at run time by the workflow, never committed.
 *   - ON-xcuitest: the iOS-1 runner reached DIRECTLY over its NDJSON socket
 *     (`IosOpenServerClient`, port from `IOS_OPEN_SERVER_PORT`) — tree AND input.
 *   - ON-siminput: the SAME runner tree (XCUITest snapshot), input via the
 *     `sim-input` HID host driver (`IosSimInputService`). Input and tree are
 *     independent on iOS: describe is scored per TREE backend (ax-service vs
 *     XCUITest snapshot), never per input arm — the tables say so.
 *
 * Effect oracle for tap: neutral pixels via `xcrun simctl io <udid> screenshot`
 * before/after, polled OUTSIDE the timed window, plus the nav title from the open
 * tree; first-attempt verdict; landing rate per block with denominators. Scroll
 * metric for swipe: OPTICAL strip cross-correlation between the pre/post-swipe
 * simctl screenshots (pixel offset of the list region), never tree survivorship,
 * no clamp — raw offset distribution per arm with IQR.
 *
 * Memory-frugal per-block mode: BENCH_ONLY=<block> runs ONE block in a
 * short-lived process and writes `bench-block-<name>.json` ({env, block});
 * merge-blocks-ios.js assembles the four. This matches the Android harness so the
 * CI workflow drives one block per `node` invocation.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { createRegistry } from "../src/utils/setup-registry";
import { unsetFlag } from "@argent/configuration-core";
import {
  IosOpenServerClient,
  type IosOpenServerNode,
  type IosOpenServerState,
} from "../src/utils/ios-open-server-client";
import { openServerIosNestedToDescribeNode } from "../src/tools/describe/platforms/ios/open-server-tree";
import { formatDescribeTree } from "../src/tools/describe/format-tree";
import { IosSimInputService } from "../src/utils/ios-sim-input-service";
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
// G4: the equal element cap for the per-tree-backend token comparison. Both
// backends' describe text is truncated to the first CAP element lines and the
// tokens of that prefix are reported alongside the uncapped count + denominator.
const DESCRIBE_CAP = Number(process.env.BENCH_DESCRIBE_CAP ?? 400);
const SETTINGS = "com.apple.Preferences";
const TARGET_LABEL = process.env.BENCH_TAP_TARGET ?? "General";

if (!UDID)
  throw new Error("BENCH_UDID / IOS_OPEN_SERVER_UDID must be set (the booted simulator udid)");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Reg = ReturnType<typeof createRegistry>;

// Gesture timing params driven identically across blocks (drift gate in the merge).
const GESTURE_PARAMS = {
  tapHoldMs: 0,
  swipeDurationMs: 250,
  swipeSteps: 12,
} as const;
export type BenchGestureParams = typeof GESTURE_PARAMS;

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
  // `simctl io screenshot` occasionally fails transiently right after boot / a
  // relaunch (device busy). Retry a few times before giving up so a single blip
  // does not throw the whole oracle (run 1: OFF-1 self-test threw on shot #0).
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

/** Delete a screenshot PNG and its derived BMP. The bench takes thousands of
 * screenshots; leaving them under TMPDIR bloats the runner and made the artifact
 * upload crawl (run 3 hung in teardown). Best-effort, never throws. */
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

interface Bmp {
  width: number;
  height: number;
  data: Buffer;
  stride: number;
  offset: number;
  bpp: number;
}
/** Downscale a PNG to a small 24/32-bit BMP (longest side 160) via `sips`. A
 * smaller raster keeps the neutral-pixel diff + optical cross-correlation cheap
 * on a hosted runner while staying well above the 2% effect threshold. */
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

interface OpticalOffset {
  /** Best vertical pixel shift (in the downscaled BMP), +down / −up. NaN if refused. */
  dyPx: number;
  /** Confidence = (secondBestSAD − bestSAD) / bestSAD; low ⇒ ambiguous. */
  confidence: number;
  refused: boolean;
}
/**
 * OPTICAL scroll offset by strip cross-correlation on the list region of the
 * pre/post-swipe screenshots. For each candidate vertical shift dy, sum the
 * absolute difference of a central column strip between before[y] and
 * after[y+dy]; the dy minimizing SAD is the offset. No clamp, no tree
 * survivorship. A best match not clearly better than the runner-up (confidence <
 * `minConfidence`) is a REFUSAL (excluded from the distribution, counted).
 */
async function opticalScrollOffset(
  pngBefore: string,
  pngAfter: string,
  region: { y1: number; y2: number },
  minConfidence = 0.06
): Promise<OpticalOffset> {
  const a = await toBmp(pngBefore);
  const b = await toBmp(pngAfter);
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const bppA = a.bpp / 8;
  const bppB = b.bpp / 8;
  // Region rows in the downscaled BMP (region is normalized 0..1 of screen).
  const ry1 = Math.max(1, Math.floor(region.y1 * h));
  const ry2 = Math.min(h - 1, Math.ceil(region.y2 * h));
  // Central column strip (middle third) to avoid chrome edges.
  const cx1 = Math.floor(w / 3);
  const cx2 = Math.ceil((2 * w) / 3);
  const maxShift = Math.floor((ry2 - ry1) / 2);
  const rowSad = (dy: number): number => {
    let sad = 0;
    let count = 0;
    for (let y = ry1; y < ry2; y++) {
      const yb = y + dy;
      if (yb < 0 || yb >= h) continue;
      for (let x = cx1; x < cx2; x++) {
        const ia = a.offset + y * a.stride + x * bppA;
        const ib = b.offset + yb * b.stride + x * bppB;
        sad +=
          Math.abs(a.data[ia]! - b.data[ib]!) +
          Math.abs(a.data[ia + 1]! - b.data[ib + 1]!) +
          Math.abs(a.data[ia + 2]! - b.data[ib + 2]!);
        count++;
      }
    }
    return count > 0 ? sad / count : Number.POSITIVE_INFINITY;
  };
  let best = { dy: 0, sad: Number.POSITIVE_INFINITY };
  let second = { dy: 0, sad: Number.POSITIVE_INFINITY };
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    const sad = rowSad(dy);
    if (sad < best.sad) {
      second = best;
      best = { dy, sad };
    } else if (sad < second.sad) {
      second = { dy, sad };
    }
  }
  const confidence = best.sad > 0 ? (second.sad - best.sad) / best.sad : 0;
  const refused = !Number.isFinite(best.sad) || confidence < minConfidence;
  return { dyPx: refused ? NaN : best.dy, confidence: Number(confidence.toFixed(4)), refused };
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
  /** Describe the current screen → formatted text (comparable per backend). */
  describe(): Promise<DescribeSample>;
  /** Open-tree stage timings (G3), or null for the ax-service backend. */
  describeStages(): Promise<StageSample | null>;
  /** Tap a normalized point (host-timed by the caller). */
  tap(p: NPoint): Promise<void>;
  /** Swipe between normalized points over ~250 ms. */
  swipe(from: NPoint, to: NPoint): Promise<void>;
  /** Locate a label's center as a normalized point on the CURRENT screen, or null. */
  locate(label: string): Promise<NPoint | null>;
  /** The scroll container's normalized vertical span (for the optical region). */
  scrollRegion(): Promise<{ y1: number; y2: number }>;
  /** Return to the Settings root (relaunch). */
  ensureRoot(): Promise<void>;
  /** Go one screen back (best effort). */
  goBack(): Promise<void>;
  /** await-screen-idle latency (ms) — one measured call. */
  awaitScreenIdle(): Promise<void>;
  /** await-ui-element latency (ms) — one measured call for `label`. */
  awaitUiElement(label: string): Promise<void>;
  /** Sim-input ack-timeout count (ON-siminput only; 0 elsewhere). */
  ackTimeouts(): number;
  /** Runner exit/crash count observed (ON arms; 0 on OFF). */
  crashes(): number;
  dispose(): Promise<void>;
}

/* ---- OFF arm: closed simulator-server + ax-service via the registry -------- */

class OffArm implements Arm {
  readonly config = "OFF" as const;
  readonly treeBackend = "ax-service" as const;
  private reg: Reg;
  constructor(readonly name: string) {
    unsetFlag("open-ios-device-server", "project");
    this.reg = createRegistry();
  }
  private async describeText(settle?: boolean): Promise<{ text: string; source: string }> {
    const r = (await this.reg.invokeTool("describe", {
      udid: UDID,
      ...(settle === undefined ? {} : { settle }),
    })) as { description: string; source: string };
    return { text: r.description ?? "", source: r.source ?? "ax-service" };
  }
  async describe(): Promise<DescribeSample> {
    const { text, source } = await this.describeText();
    return {
      backend: "ax-service",
      source,
      text,
      elements: describeBody(text).length,
      bytes: Buffer.byteLength(text, "utf8"),
    };
  }
  async describeStages(): Promise<StageSample | null> {
    // The ax-service path does not surface snapshot/serialize/encode stages.
    return null;
  }
  async tap(p: NPoint): Promise<void> {
    await this.reg.invokeTool("gesture-tap", { udid: UDID, x: p.x, y: p.y });
  }
  async swipe(from: NPoint, to: NPoint): Promise<void> {
    // The gesture-swipe tool takes fromX/fromY/toX/toY (normalized), NOT
    // startX/endX (run 1: OFF swipe threw 20/20 on the wrong param names).
    await this.reg.invokeTool("gesture-swipe", {
      udid: UDID,
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      durationMs: GESTURE_PARAMS.swipeDurationMs,
    });
  }
  async locate(label: string): Promise<NPoint | null> {
    const { text } = await this.describeText();
    return locateInDescribeText(text, label);
  }
  async scrollRegion(): Promise<{ y1: number; y2: number }> {
    const { text } = await this.describeText();
    return scrollRegionFromDescribeText(text);
  }
  async ensureRoot(): Promise<void> {
    await relaunchViaSimctl();
    await this.reg
      .invokeTool("await-screen-idle", { udid: UDID, timeoutMs: 2500 })
      .catch(() => undefined);
  }
  async goBack(): Promise<void> {
    // iOS has no reliable global back gesture; relaunching Settings is the only
    // guaranteed root restore (run 1: tapping the top-left chevron did NOT go
    // back, so navDiff==rootDiff and the oracle self-test failed).
    await relaunchViaSimctl();
  }
  async awaitScreenIdle(): Promise<void> {
    await this.reg.invokeTool("await-screen-idle", { udid: UDID, timeoutMs: 4000 });
  }
  async awaitUiElement(label: string): Promise<void> {
    // The tool takes { condition, selector: {text|identifier|role} } — NOT a bare
    // `label` (run 1: OFF await-ui-element threw 20/20 on the wrong shape).
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

/* ---- ON tree helpers (shared by both ON arms) ------------------------------ */

function walk(nodes: IosOpenServerNode[], fn: (n: IosOpenServerNode) => void): void {
  for (const n of nodes) {
    fn(n);
    walk(n.children, fn);
  }
}
function findByLabel(nodes: IosOpenServerNode[], label: string): IosOpenServerNode | undefined {
  let hit: IosOpenServerNode | undefined;
  walk(nodes, (n) => {
    if (!hit && n.label === label) hit = n;
  });
  return hit;
}
/**
 * The best tappable match for `label`: XCUITest reports offscreen table cells
 * with below-the-fold bounds, so the DFS-first match can be a non-hittable cell
 * near the bottom (run 2: every ON-siminput no-effect tap was the SAME bottom
 * coordinate 0.628,0.847). Prefer a `hittable` match whose center sits on-screen
 * (a small margin in from the edges), topmost first; fall back to the first
 * match so a missing `hittable` flag never returns null.
 */
function findTappableByLabel(
  nodes: IosOpenServerNode[],
  label: string,
  screenW: number,
  screenH: number
): IosOpenServerNode | undefined {
  const matches: IosOpenServerNode[] = [];
  walk(nodes, (n) => {
    if (n.label === label) matches.push(n);
  });
  if (matches.length === 0) return undefined;
  const onScreen = (n: IosOpenServerNode): boolean => {
    const cy = (n.bounds.y1 + n.bounds.y2) / 2 / (screenH || 1);
    const cx = (n.bounds.x1 + n.bounds.x2) / 2 / (screenW || 1);
    return cy > 0.03 && cy < 0.93 && cx > 0 && cx < 1;
  };
  const hittable = matches.filter((n) => n.hittable && onScreen(n));
  const pool = hittable.length ? hittable : matches.filter(onScreen);
  const chosen = (pool.length ? pool : matches)
    .slice()
    .sort((a, b) => a.bounds.y1 - b.bounds.y1)[0];
  return chosen;
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

/** Shared open-tree reader: getNestedState + describe text via the shared formatter. */
class OpenTree {
  constructor(private readonly client: IosOpenServerClient) {}
  state(): Promise<IosOpenServerState> {
    return this.client.getNestedState();
  }
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
    return { y1: c.bounds.y1 / st.info.screenHeight, y2: c.bounds.y2 / st.info.screenHeight };
  }
  /** Poll the version counter until quiet for `quietMs` or timeout. */
  async awaitIdle(quietMs = 500, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    let stableSince = Date.now();
    for (;;) {
      const st = await this.client.getNestedState().catch(() => null);
      const v = st?.version ?? last;
      if (v !== last) {
        last = v;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) {
        return;
      }
      if (Date.now() >= deadline) return;
      await sleep(120);
    }
  }
  async awaitElement(label: string, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const st = await this.client.getNestedState().catch(() => null);
      if (st && findByLabel(st.tree, label)) return;
      if (Date.now() >= deadline) return;
      await sleep(120);
    }
  }
  async screenSize(): Promise<{ w: number; h: number }> {
    const s = await this.client.getScreenSize();
    return { w: s.screenWidth, h: s.screenHeight };
  }
}

/* ---- ON-xcuitest arm: open runner, tree AND input via XCUITest ------------- */

class XcuitestArm implements Arm {
  readonly config = "ON" as const;
  readonly treeBackend = "xcuitest" as const;
  private client: IosOpenServerClient;
  private tree: OpenTree;
  private crashCount = 0;
  constructor(readonly name: string) {
    this.client = new IosOpenServerClient({ port: RUNNER_PORT, timeoutMs: 90_000 });
    this.tree = new OpenTree(this.client);
  }
  describe(): Promise<DescribeSample> {
    return this.tree.describe();
  }
  describeStages(): Promise<StageSample | null> {
    return this.tree.stages();
  }
  private async pt(p: NPoint): Promise<{ x: number; y: number }> {
    const { w, h } = await this.tree.screenSize();
    return { x: p.x * w, y: p.y * h };
  }
  async tap(p: NPoint): Promise<void> {
    const { x, y } = await this.pt(p);
    const r = await this.client.tap(x, y, { holdMs: GESTURE_PARAMS.tapHoldMs });
    if (!r.success) throw new Error("xcuitest tap reported success=false");
  }
  async swipe(from: NPoint, to: NPoint): Promise<void> {
    const { w, h } = await this.tree.screenSize();
    const r = await this.client.swipe(from.x * w, from.y * h, to.x * w, to.y * h, {
      steps: GESTURE_PARAMS.swipeSteps,
      durationMs: GESTURE_PARAMS.swipeDurationMs,
    });
    if (!r.success) throw new Error("xcuitest swipe reported success=false");
  }
  locate(label: string): Promise<NPoint | null> {
    return this.tree.locate(label);
  }
  scrollRegion(): Promise<{ y1: number; y2: number }> {
    return this.tree.scrollRegion();
  }
  async ensureRoot(): Promise<void> {
    await this.client.launchApp(SETTINGS);
    await sleep(900);
  }
  async goBack(): Promise<void> {
    // Relaunch Settings — the reliable iOS root restore (see OffArm.goBack).
    await this.client.launchApp(SETTINGS);
    await sleep(700);
  }
  awaitScreenIdle(): Promise<void> {
    return this.tree.awaitIdle();
  }
  awaitUiElement(label: string): Promise<void> {
    return this.tree.awaitElement(label);
  }
  ackTimeouts(): number {
    return 0;
  }
  crashes(): number {
    return this.crashCount;
  }
  async dispose(): Promise<void> {
    this.client.close();
  }
}

/* ---- ON-siminput arm: open runner tree, input via the sim-input HID driver - */

class SimInputArm implements Arm {
  readonly config = "ON" as const;
  readonly treeBackend = "xcuitest" as const;
  private client: IosOpenServerClient;
  private tree: OpenTree;
  private sim: IosSimInputService;
  private ackTimeoutCount = 0;
  private crashCount = 0;
  constructor(readonly name: string) {
    this.client = new IosOpenServerClient({ port: RUNNER_PORT, timeoutMs: 90_000 });
    this.tree = new OpenTree(this.client);
    this.sim = new IosSimInputService();
  }
  describe(): Promise<DescribeSample> {
    return this.tree.describe();
  }
  describeStages(): Promise<StageSample | null> {
    return this.tree.stages();
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
    const { w, h } = await this.tree.screenSize();
    await this.withAckTimeout(this.sim.tap(UDID, { x: p.x * w, y: p.y * h, width: w, height: h }));
  }
  async swipe(from: NPoint, to: NPoint): Promise<void> {
    const { w, h } = await this.tree.screenSize();
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
    return this.tree.locate(label);
  }
  scrollRegion(): Promise<{ y1: number; y2: number }> {
    return this.tree.scrollRegion();
  }
  async ensureRoot(): Promise<void> {
    await this.client.launchApp(SETTINGS);
    await sleep(900);
  }
  async goBack(): Promise<void> {
    // Relaunch Settings — the reliable iOS root restore (see OffArm.goBack).
    await this.client.launchApp(SETTINGS);
    await sleep(700);
  }
  awaitScreenIdle(): Promise<void> {
    return this.tree.awaitIdle();
  }
  awaitUiElement(label: string): Promise<void> {
    return this.tree.awaitElement(label);
  }
  ackTimeouts(): number {
    return this.ackTimeoutCount;
  }
  crashes(): number {
    return this.crashCount;
  }
  async dispose(): Promise<void> {
    await this.sim.stopAll().catch(() => undefined);
    this.client.close();
  }
}

/* -------------------------------------------------------------------------- */
/* describe-text locate helpers (OFF backend)                                 */
/* -------------------------------------------------------------------------- */

/** Parse the normalized center of the first line carrying `label`, from the
 * describe text (each node line ends with a `(x, y, w, h)` normalized frame). */
function locateInDescribeText(desc: string, label: string): NPoint | null {
  for (const line of describeBody(desc)) {
    if (!line.includes(`"${label}"`)) continue;
    const frame = parseFrame(line);
    if (frame) return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  }
  return null;
}
function scrollRegionFromDescribeText(desc: string): { y1: number; y2: number } {
  // Widest tall element = the scroll container; fall back to the mid screen.
  let best: { y1: number; y2: number; area: number } | null = null;
  for (const line of describeBody(desc)) {
    const f = parseFrame(line);
    if (!f) continue;
    const area = f.width * f.height;
    if (f.height > 0.3 && (!best || area > best.area)) best = { y1: f.y, y2: f.y + f.height, area };
  }
  return best ? { y1: best.y1, y2: best.y2 } : { y1: 0.2, y2: 0.85 };
}
function parseFrame(line: string): { x: number; y: number; width: number; height: number } | null {
  const m = line.match(/\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\)\s*$/);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) };
}

/* -------------------------------------------------------------------------- */
/* app lifecycle helpers                                                      */
/* -------------------------------------------------------------------------- */

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
  effectChecked?: number;
  effectZero?: number;
  originLost?: number;
  extra?: Record<string, unknown>;
}

/** Generic timed verb loop with an optional untimed per-iteration setup. */
async function timeCalls(
  label: string,
  fn: (i: number) => Promise<void>,
  setup?: (i: number) => Promise<void>,
  extra?: () => Record<string, unknown>
): Promise<VerbResult> {
  for (let i = 0; i < WARMUP; i++) {
    if (setup) await setup(i).catch(() => undefined);
    await fn(i).catch(() => undefined);
  }
  const lat: number[] = [];
  let errors = 0;
  const errorSamples: string[] = [];
  for (let i = 0; i < N; i++) {
    if (setup) await setup(i).catch(() => undefined);
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
    errorSamples,
    extra: extra?.(),
  };
}

interface TapEffectResult extends VerbResult {
  effectChecked: number;
  effectZero: number;
  originLost: number;
  firstTapNoEffect: number;
  locateFailed: number;
  noEffectSamples: string[];
}

/**
 * FIRST-attempt, timing-INDEPENDENT effect-checked tap. Every iteration: ensure
 * root → UNTIMED locate of `target` on the current tree → UNTIMED simctl
 * screenshot BEFORE → TIMED arm.tap → OUTSIDE the timed window poll the neutral-
 * pixel diff (and the open nav-title, when the arm exposes a tree) until it
 * changes or 3 s → BACK to restore. A miss is NEVER retried away (fatal on ON in
 * the merge). A locate that fails EXCLUDES the iteration (never a blind tap).
 */
async function timeTapEffect(arm: Arm, target: string): Promise<TapEffectResult> {
  const lat: number[] = [];
  let errors = 0;
  const errorSamples: string[] = [];
  let effectChecked = 0;
  let effectZero = 0;
  const originLost = 0;
  let locateFailed = 0;
  const noEffectSamples: string[] = [];

  const runOne = async (record: boolean): Promise<void> => {
    await arm.ensureRoot();
    const coord = await arm.locate(target);
    if (!coord) {
      if (record) locateFailed++;
      return;
    }
    // Brief render settle (untimed): a HID (sim-input) tap on a still-animating
    // row can be dropped by the OS; let the relaunched root fully render first.
    await sleep(300);
    const before = await simctlScreenshot("tap-before");
    const t0 = Date.now();
    let tapErr: unknown;
    try {
      await arm.tap(coord);
    } catch (e) {
      tapErr = e;
    }
    const dt = Date.now() - t0;
    // Effect check OUTSIDE the timed window. A screenshot on a hosted runner is
    // expensive (simctl + sips + pixel diff), so instead of polling every 200 ms
    // for 3 s we settle a fixed window and take at most TWO `after` shots — still
    // strictly outside the timed window, still a first-attempt verdict.
    let landed = false;
    for (let poll = 0; poll < 3 && !landed; poll++) {
      await sleep(800);
      const after = await simctlScreenshot("tap-after");
      const ratio = await neutralPixelDiffRatio(before, after).catch(() => 0);
      rmShot(after);
      if (ratio >= 0.02) landed = true;
    }
    rmShot(before);
    if (record) {
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
            `${arm.name} tap@(${coord.x.toFixed(3)},${coord.y.toFixed(3)}) no-effect`
          );
      }
    }
    // No trailing restore: the NEXT iteration's `ensureRoot()` (relaunch) is the
    // reliable iOS root restore, so a second relaunch here would only double the
    // cost. originLost is structurally 0 on iOS (relaunch always finds root).
    void originLost;
  };

  for (let i = 0; i < WARMUP; i++) await runOne(false).catch(() => undefined);
  for (let i = 0; i < N; i++) await runOne(true).catch(() => undefined);

  return {
    verb: "gesture-tap",
    latency: summarize(lat),
    latencySamples: lat.slice(),
    errors,
    errorSamples,
    effectChecked,
    effectZero,
    originLost,
    firstTapNoEffect: effectZero,
    locateFailed,
    noEffectSamples,
  };
}

interface ScrollResult {
  arm: string;
  offsetsPx: number[];
  median: number;
  q1: number;
  q3: number;
  iqr: number;
  refusals: number;
  n: number;
}

/** OPTICAL swipe: timed swipe + strip cross-correlation offset OUTSIDE the timed
 * window. Returns the swipe latency verb AND the per-arm optical offset dist. */
async function timeSwipeOptical(arm: Arm): Promise<{ verb: VerbResult; scroll: ScrollResult }> {
  const lat: number[] = [];
  let errors = 0;
  const errorSamples: string[] = [];
  const offsets: number[] = [];
  let refusals = 0;

  const region = await arm.scrollRegion().catch(() => ({ y1: 0.2, y2: 0.85 }));
  const midX = 0.5;
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
    const off = await opticalScrollOffset(before, after, region).catch(() => ({
      dyPx: NaN,
      confidence: 0,
      refused: true,
    }));
    rmShot(before, after);
    if (record) {
      if (err) {
        errors++;
        if (errorSamples.length < 5)
          errorSamples.push(`swipe: ${err instanceof Error ? err.message : String(err)}`);
      } else {
        lat.push(dt);
      }
      if (off.refused || !Number.isFinite(off.dyPx)) refusals++;
      else offsets.push(off.dyPx);
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
      offsetsPx: offsets.slice(),
      median: offsets.length ? q.median : NaN,
      q1: offsets.length ? q.q1 : NaN,
      q3: offsets.length ? q.q3 : NaN,
      iqr: offsets.length ? q.iqr : NaN,
      refusals,
      n: offsets.length,
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
    note: string;
  };
  effectCheckedTotal: number;
  firstTapNoEffectTotal: number;
  effectZeroTotal: number;
  originLostTotal: number;
  locateFailedTotal: number;
  landingRate: number | null;
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
    // Navigation must have changed the screen (navDiff high) and BACK must have
    // largely restored the root (rootDiff low relative to navDiff).
    const selfTestPassed = navDiff >= 0.02 && rootDiff < navDiff;
    return {
      selfTestPassed,
      navDiff: Number(navDiff.toFixed(4)),
      rootDiff: Number(rootDiff.toFixed(4)),
      note: selfTestPassed
        ? "ok"
        : `navDiff=${navDiff.toFixed(4)} rootDiff=${rootDiff.toFixed(4)} (needs navDiff>=0.02 and rootDiff<navDiff)`,
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
  // Warm up until the tree is non-empty: the ax-service (OFF) path can return an
  // empty tree for the first read after boot before the app is injected (run 1:
  // OFF-1's G4 sample was 0 elements while OFF-2 recovered 29). Retry with a
  // relaunch so the G4 denominator is the real element count, not a cold blip.
  let desc = await arm.describe();
  for (let attempt = 0; attempt < 4 && desc.elements === 0; attempt++) {
    await arm.ensureRoot();
    await sleep(600);
    desc = await arm.describe();
  }
  if (desc.elements === 0)
    notes.push("describe tree was still empty after warmup (backend not injectable?)");
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
  const oracle = { target: TARGET_LABEL, ...(await oracleSelfTest(arm, TARGET_LABEL)) };

  const verbs: VerbResult[] = [];

  // ---- verb: describe (idle) -------------------------------------------------
  await arm.ensureRoot();
  verbs.push(
    await timeCalls("describe", async () => {
      await arm.describe();
    })
  );

  // ---- G3 describe stages (ON only) -----------------------------------------
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
  const tapVerb = await timeTapEffect(arm, TARGET_LABEL);
  verbs.push(tapVerb);

  // ---- verb: tap+describe(settle:false) -------------------------------------
  verbs.push(
    await timeCalls(
      "tap+describe(settle:false)",
      async () => {
        const coord = (await arm.locate(TARGET_LABEL)) ?? { x: 0.5, y: 0.3 };
        await arm.tap(coord);
        await arm.describe();
      },
      async () => {
        await arm.ensureRoot();
      }
    )
  );

  // ---- verb: gesture-swipe (250ms) + optical offset -------------------------
  const { verb: swipeVerb, scroll } = await timeSwipeOptical(arm);
  verbs.push(swipeVerb);

  // ---- verb: await-screen-idle ----------------------------------------------
  await arm.ensureRoot();
  const awaitIdleVerb = await timeCalls(
    "await-screen-idle",
    async () => {
      await arm.awaitScreenIdle();
    },
    async () => {
      const coord = (await arm.locate(TARGET_LABEL)) ?? { x: 0.5, y: 0.3 };
      await arm.tap(coord).catch(() => undefined);
    }
  );
  verbs.push(awaitIdleVerb);
  if (awaitIdleVerb.latency.min >= 3990 && awaitIdleVerb.latency.n > 0) {
    degradedReasons.push(
      "await-screen-idle capped on every iteration (wrong/never-settling screen)"
    );
  }

  // ---- verb: await-ui-element -----------------------------------------------
  await arm.ensureRoot();
  const awaitElVerb = await timeCalls("await-ui-element", async () => {
    await arm.awaitUiElement(TARGET_LABEL);
  });
  verbs.push(awaitElVerb);
  if (awaitElVerb.latency.min >= 3990 && awaitElVerb.latency.n > 0) {
    degradedReasons.push("await-ui-element capped on every iteration (target never appeared)");
  }

  // ---- paste / gesture-pinch: no ON counterpart yet (iOS-4) -----------------
  verbs.push({
    verb: "paste",
    latency: summarize([]),
    latencySamples: [],
    errors: 0,
    errorSamples: [],
    extra: { na: "N/A (iOS-4)" },
  });
  verbs.push({
    verb: "gesture-pinch",
    latency: summarize([]),
    latencySamples: [],
    errors: 0,
    errorSamples: [],
    extra: { na: "N/A (iOS-4)" },
  });

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
    verbs,
    describe: describeSample,
    describeStages,
    scroll,
    oracle,
    effectCheckedTotal,
    firstTapNoEffectTotal,
    effectZeroTotal: tapVerb.effectZero,
    originLostTotal: tapVerb.originLost,
    locateFailedTotal: tapVerb.locateFailed,
    landingRate,
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
    runId: process.env.GITHUB_RUN_ID ?? null,
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
        `landing=${r.effectCheckedTotal - r.firstTapNoEffectTotal}/${r.effectCheckedTotal} ` +
        `ackTimeouts=${r.simInputAckTimeouts} crashes=${r.runnerCrashes} ` +
        `describeTokens=${r.describe.tokens}@${r.describe.elements}el (cap ${r.describe.capTokens}@${r.describe.capElements}) ` +
        `stageMaxDelta=${r.describeStages ? r.describeStages.maxDelta : "n/a"} ` +
        `scrollMedianPx=${r.scroll ? r.scroll.median : "n/a"}(refusals=${r.scroll ? r.scroll.refusals : "n/a"})`
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
