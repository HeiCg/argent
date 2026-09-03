/**
 * Backend benchmark: argent proprietary Android path (flag `open-device-server`
 * OFF -> simulator-server binary + argent-android-devtools APK) vs the open
 * Kotlin android-device-server (flag ON), on a single booted AVD.
 *
 * MEASUREMENT ONLY. Opt-in, not a test (lives under scripts/, not test/**). It
 * drives the SAME tool-registry call sites an agent hits (`describe`,
 * `screenshot`, `gesture-tap`, `gesture-swipe`, `await-ui-element`,
 * `await-screen-idle`, `paste`, `gesture-pinch`) via `registry.invokeTool`,
 * toggling the flag per block. Because the open path silently falls back to the
 * proprietary path on any failure, it (a) asserts `describe.source` per config,
 * (b) captures the tool-server's `console.debug` fallback lines, and (c) checks
 * the simulator-server host process — so a masked fallback is visible in the
 * output rather than silently scored as the wrong backend.
 *
 * The UiAutomation channel is exclusive AND exclusive between the ADT apk and
 * the open server: blocks run OFF-1 -> ON -> OFF-2, force-stopping the other
 * instrumentation + killing simulator-server between blocks. OFF-2 detects drift.
 *
 * Run against a booted emulator that exposes gRPC with a token (the proprietary
 * simulator-server `android` controller discovers the emulator via the
 * grpc.port/grpc.token in ~/Library/Caches/TemporaryItems/avd/running/*.ini,
 * only written when gRPC is enabled with a port):
 *
 *   emulator -avd <avd> -no-window -no-audio -no-boot-anim -grpc 8554 -grpc-use-token
 *
 * Point the proprietary path at the vendored binaries and run under ts-node.
 * This package's composite tsconfig (rootDir ./src) rejects a file under
 * scripts/, so register ts-node with skipProject via a tiny loader run from the
 * repo root (cwd must be the repo root so the flag file + output dir resolve):
 *
 *   // run-bench.js
 *   require("ts-node").register({ transpileOnly: true, skipProject: true,
 *     compilerOptions: { module: "commonjs", target: "ES2022",
 *       moduleResolution: "node", esModuleInterop: true, resolveJsonModule: true,
 *       skipLibCheck: true, strict: false, ignoreDeprecations: "6.0" } });
 *   require("./packages/tool-server/scripts/bench-open-vs-proprietary.ts");
 *
 *   ARGENT_SIMULATOR_SERVER_DIR=<pkg>/bin \
 *   ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR=<pkg>/bin \
 *   ARGENT_NATIVE_DEVTOOLS_DIR=<pkg>/dylibs \
 *   ANDROID_HOME=$HOME/Library/Android/sdk BENCH_SERIAL=emulator-5554 \
 *   node run-bench.js
 *
 * Env knobs: BENCH_SERIAL (default emulator-5554), BENCH_N (20), BENCH_WARMUP (3),
 * BENCH_COLD (3), BENCH_OUT (default <cwd>/.bench-results).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRegistry } from "../src/utils/setup-registry";
import { setFlag, unsetFlag } from "@argent/configuration-core";
import {
  BENCH_GESTURE_PARAMS,
  assertIdenticalGestureParams,
  assertTapTimelineParity,
  describeInjectedTapTimeline,
  type BenchGestureParams,
  type InjectedTapTimeline,
} from "../src/utils/bench-gesture-parity";

/* -------------------------------------------------------------------------- */
/* Config + guards                                                            */
/* -------------------------------------------------------------------------- */

const SERIAL = process.env.BENCH_SERIAL ?? "emulator-5554";
const N = Number(process.env.BENCH_N ?? 20);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 3);
const COLD = Number(process.env.BENCH_COLD ?? 3);
const OUT_DIR = process.env.BENCH_OUT ?? join(process.cwd(), ".bench-results");
const PHYSICAL_DENY = "ZF524RZBHD";

if (SERIAL === PHYSICAL_DENY) throw new Error(`refuse to target physical device ${PHYSICAL_DENY}`);
if (!SERIAL.startsWith("emulator-")) {
  throw new Error(`BENCH_SERIAL must be an emulator- serial (got "${SERIAL}"); refusing.`);
}

const SETTINGS = "com.android.settings";
const CHROME = "com.android.chrome";
const OPEN_PKG = "com.argent.devicecontrol";
const ADT_PKG = "com.argent.androiddevtools";
const DS_PKGS = ["com.devicestream.server", "com.devicestream.server.test"];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/* adb (always explicit -s SERIAL; never the physical device)                 */
/* -------------------------------------------------------------------------- */

function adb(args: string[], timeoutMs = 20_000): string {
  return execFileSync("adb", ["-s", SERIAL, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function adbShell(cmd: string, timeoutMs = 20_000): string {
  return adb(["shell", cmd], timeoutMs);
}

/* -------------------------------------------------------------------------- */
/* console.debug capture (the tool-server logs fallbacks there)               */
/* -------------------------------------------------------------------------- */

const debugLines: string[] = [];
const realDebug = console.debug.bind(console);
console.debug = (...a: unknown[]): void => {
  debugLines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
};
function fallbackCountSince(mark: number): { count: number; samples: string[] } {
  const slice = debugLines.slice(mark);
  const hits = slice.filter((l) => /falling back|fell back|fallback/i.test(l));
  return { count: hits.length, samples: hits.slice(0, 3) };
}

/* -------------------------------------------------------------------------- */
/* stats + estimators                                                          */
/* -------------------------------------------------------------------------- */

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}
function summarize(xs: number[]): {
  n: number;
  p50: number;
  p95: number;
  max: number;
  min: number;
  mean: number;
} {
  const s = xs.slice().sort((a, b) => a - b);
  const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  return {
    n: xs.length,
    p50: pct(s, 50),
    p95: pct(s, 95),
    max: s.length ? s[s.length - 1]! : NaN,
    min: s.length ? s[0]! : NaN,
    mean: Number(mean.toFixed(1)),
  };
}
// Token estimator (F22): js-tiktoken o200k_base is the primary count for BOTH
// configs, with chars/4 kept as a secondary sanity figure. The encoder is loaded
// once; if it ever fails to load we fall back to chars/4 and say so.
import { getEncoding, type Tiktoken } from "js-tiktoken";
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
/* describe text parsing (same formatDescribeTree output for both configs)     */
/* -------------------------------------------------------------------------- */

function parseDescribe(desc: string): { elements: number; idTextSet: string[] } {
  const lines = desc.split("\n");
  const rootIdx = lines.findIndex((l) => l.startsWith("ROOT "));
  const body = lines.slice(rootIdx + 1).filter((l) => l.trim().length > 0);
  const set = new Set<string>();
  for (const line of body) {
    const idM = line.match(/\bid="((?:[^"\\]|\\.)*)"/);
    const labelM = line.match(/(?<![=\w])"((?:[^"\\]|\\.)*)"/); // first quoted, not name="..."
    const id = idM?.[1];
    const label = labelM?.[1];
    if (id) set.add(`id:${id}`);
    if (label) set.add(`text:${label}`);
  }
  return { elements: body.length, idTextSet: [...set] };
}
function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni === 0 ? 1 : Number((inter / uni).toFixed(3));
}

/* -------------------------------------------------------------------------- */
/* PNG dims                                                                    */
/* -------------------------------------------------------------------------- */

function pngInfo(path: string): { bytes: number; width: number; height: number; sig: boolean } {
  const buf = readFileSync(path);
  const sig =
    buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const width = sig ? buf.readUInt32BE(16) : 0;
  const height = sig ? buf.readUInt32BE(20) : 0;
  return { bytes: statSync(path).size, width, height, sig };
}

/* -------------------------------------------------------------------------- */
/* backend teardown                                                            */
/* -------------------------------------------------------------------------- */

function killSimServerForEmulator(): void {
  // Only ever the emulator's controller; never `android_device --id <physical>`.
  try {
    const out = execFileSync("pgrep", ["-f", `simulator-server .*android --id ${SERIAL}`], {
      encoding: "utf8",
    });
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      try {
        execFileSync("kill", [pid]);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* none running */
  }
}
function simServerRssKb(): number | null {
  try {
    const out = execFileSync("pgrep", ["-f", `simulator-server .*android --id ${SERIAL}`], {
      encoding: "utf8",
    });
    const pid = out.split(/\s+/).filter(Boolean)[0];
    if (!pid) return null;
    const rss = execFileSync("ps", ["-o", "rss=", "-p", pid], { encoding: "utf8" }).trim();
    return rss ? Number(rss) : null;
  } catch {
    return null;
  }
}
function forceStopInstrumentation(): void {
  for (const pkg of [OPEN_PKG, ADT_PKG, ...DS_PKGS]) {
    try {
      adbShell(`am force-stop ${pkg}`, 8_000);
    } catch {
      /* best effort */
    }
  }
}
async function teardownBackend(reg?: Awaited<ReturnType<typeof createRegistry>>): Promise<void> {
  if (reg) await reg.dispose().catch(() => undefined);
  forceStopInstrumentation();
  killSimServerForEmulator();
  await sleep(1200);
}

/* -------------------------------------------------------------------------- */
/* screen setup                                                                */
/* -------------------------------------------------------------------------- */

type Reg = ReturnType<typeof createRegistry>;

function dismissSystemDialogs(): void {
  try {
    adbShell("am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS", 5_000);
  } catch {
    /* best effort */
  }
}
async function ensureSettings(reg: Reg): Promise<void> {
  dismissSystemDialogs();
  adbShell(`am force-stop ${SETTINGS}`, 8_000);
  // Reset Settings so a restored search screen (with leftover paste text) can't
  // masquerade as the root; guarantees the pristine-root describe is comparable.
  try {
    adbShell(`pm clear ${SETTINGS}`, 8_000);
  } catch {
    /* fall through to plain launch */
  }
  await sleep(300);
  adbShell(`am start -n ${SETTINGS}/.Settings`, 8_000);
  await sleep(1500);
  await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 }).catch(() => undefined);
}

// A describe validated to be the real Settings root: not a crash dialog, and
// carrying at least one canonical root row. Retries the screen reset a few times
// so a transient ADT crash can't poison the byte/element/fidelity numbers.
async function cleanSettingsDescribe(
  reg: Reg
): Promise<{ description: string; source: string }> {
  let last = { description: "", source: "" };
  for (let attempt = 0; attempt < 4; attempt++) {
    await ensureSettings(reg);
    try {
      const d = (await reg.invokeTool("describe", { udid: SERIAL })) as {
        description: string;
        source: string;
      };
      last = d;
      const crashed = /keeps stopping|aerr_|isn't responding/i.test(d.description);
      const rootish = /network|battery|display|storage|connected|apps|sound|notif/i.test(
        d.description
      );
      if (!crashed && rootish) return d;
    } catch {
      /* retry */
    }
    dismissSystemDialogs();
    await sleep(600);
  }
  return last;
}
async function ensureChrome(reg: Reg): Promise<boolean> {
  adbShell(`am force-stop ${CHROME}`, 8_000);
  await sleep(500);
  // Load a deterministic, pinch-zoomable page directly via a VIEW intent.
  adbShell(
    `am start -a android.intent.action.VIEW -d https://example.com ${CHROME}`,
    12_000
  );
  await sleep(3500);
  await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 5000 }).catch(() => undefined);
  // Confirm we are actually in Chrome (a cold FRE would block content).
  try {
    const d = (await reg.invokeTool("describe", { udid: SERIAL })) as { description: string };
    return /example|more information|url_bar|search/i.test(d.description);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* measurement                                                                 */
/* -------------------------------------------------------------------------- */

interface VerbResult {
  verb: string;
  latency: ReturnType<typeof summarize>;
  errors: number;
  fallbacks: number;
  fallbackSamples: string[];
  // Effect-check (phase 3h): when the verb runs on a navigating target with an
  // `effectHash`, each iteration compares a screen fingerprint before vs after the
  // action. `effectChecked` iterations were compared; `effectZero` of them saw NO
  // change — i.e. the tap did not land. A healthy block has effectZero === 0. This
  // is what would have caught the v8 "tap win" that was really timing a no-op
  // scrcpy injection (pngDiffRatio 0). Absent on verbs without an effect check.
  effectChecked?: number;
  effectZero?: number;
  extra?: Record<string, unknown>;
}

async function timeCalls(
  label: string,
  fn: (i: number) => Promise<void>,
  extra?: () => Record<string, unknown>,
  // Untimed per-iteration setup (F5): resets the screen to a known state before
  // each measured tap/swipe so every iteration starts from the same place, and
  // its cost is NOT counted in the latency of the verb under test.
  setup?: (i: number) => Promise<void>,
  // Optional per-iteration effect check (phase 3h). Captures a screen fingerprint
  // (untimed) after `setup` and again after `fn`; if they are equal the action had
  // no observable effect (the tap did not land). Returns undefined if the
  // fingerprint could not be read (that iteration is not counted).
  effectHash?: () => Promise<string | undefined>
): Promise<VerbResult> {
  for (let i = 0; i < WARMUP; i++) {
    if (setup) await setup(i).catch(() => undefined);
    await fn(i).catch(() => undefined);
  }
  const mark = debugLines.length;
  const lat: number[] = [];
  let errors = 0;
  let effectChecked = 0;
  let effectZero = 0;
  for (let i = 0; i < N; i++) {
    if (setup) await setup(i).catch(() => undefined);
    const before = effectHash ? await effectHash().catch(() => undefined) : undefined;
    const t0 = Date.now();
    try {
      await fn(i);
      lat.push(Date.now() - t0);
    } catch {
      errors++;
      continue;
    }
    if (effectHash && before !== undefined) {
      const after = await effectHash().catch(() => undefined);
      if (after !== undefined) {
        effectChecked++;
        if (after === before) effectZero++;
      }
    }
  }
  const fb = fallbackCountSince(mark);
  return {
    verb: label,
    latency: summarize(lat),
    errors,
    fallbacks: fb.count,
    fallbackSamples: fb.samples,
    ...(effectHash ? { effectChecked, effectZero } : {}),
    extra: extra?.(),
  };
}

// Sample the describe result's server-measured idle-gate (waitedMs) vs. capture
// (captureMs) split, running `setup` untimed before each describe. Only the open
// path surfaces these (they ride the DescribeResult metadata); the proprietary
// path leaves them undefined, so `n` reports how many samples actually carried a
// split. Isolates "the describe was slow because the UI was still animating"
// (waitedMs) from "the tree was expensive to serialize" (captureMs).
type StageStat = { p50: number | null; p95: number | null; n: number };
type DescribeStages = {
  idleMs: StageStat;
  rootMs: StageStat;
  windowsMs: StageStat;
  rootsMs: StageStat;
  serializeMs: StageStat;
  encodeMs: StageStat;
};
const STAGE_KEYS = ["idleMs", "rootMs", "windowsMs", "rootsMs", "serializeMs", "encodeMs"] as const;
type StageKey = (typeof STAGE_KEYS)[number];

function stageStat(xs: number[]): StageStat {
  if (!xs.length) return { p50: null, p95: null, n: 0 };
  const sm = summarize(xs);
  return { p50: sm.p50, p95: sm.p95, n: xs.length };
}

async function describeSplit(
  reg: Reg,
  n: number,
  setup?: () => Promise<void>
): Promise<{
  waitedP50: number | null;
  captureP50: number | null;
  n: number;
  // Per-stage p50/p95 of the open-path describe capture (phase 3g). Persisted per
  // describe call and summarized here so the residual after a tap can be pinned to
  // a concrete stage (rootInActiveWindow vs windows enumeration vs each w.root vs
  // serialize vs encode) rather than guessed from logcat.
  stages: DescribeStages;
}> {
  const waited: number[] = [];
  const captured: number[] = [];
  const stageSamples: Record<StageKey, number[]> = {
    idleMs: [], rootMs: [], windowsMs: [], rootsMs: [], serializeMs: [], encodeMs: [],
  };
  for (let i = 0; i < n; i++) {
    if (setup) await setup().catch(() => undefined);
    try {
      const d = (await reg.invokeTool("describe", { udid: SERIAL })) as {
        waitedMs?: number;
        captureMs?: number;
        timings?: {
          idleMs?: number;
          rootMs?: number;
          windowsMs?: number;
          rootsMs?: number[];
          serializeMs?: number;
          encodeMs?: number;
        };
      };
      if (typeof d.waitedMs === "number") waited.push(d.waitedMs);
      if (typeof d.captureMs === "number") captured.push(d.captureMs);
      const t = d.timings;
      if (t) {
        if (typeof t.idleMs === "number") stageSamples.idleMs.push(t.idleMs);
        if (typeof t.rootMs === "number") stageSamples.rootMs.push(t.rootMs);
        if (typeof t.windowsMs === "number") stageSamples.windowsMs.push(t.windowsMs);
        // rootsMs is one entry per kept window; sum to the per-call total so the
        // stage reads as "time spent in w.root binder calls this capture".
        if (Array.isArray(t.rootsMs)) {
          stageSamples.rootsMs.push(t.rootsMs.reduce((a, b) => a + b, 0));
        }
        if (typeof t.serializeMs === "number") stageSamples.serializeMs.push(t.serializeMs);
        if (typeof t.encodeMs === "number") stageSamples.encodeMs.push(t.encodeMs);
      }
    } catch {
      /* skip */
    }
  }
  const p50 = (xs: number[]): number | null =>
    xs.length ? summarize(xs).p50 : null;
  const stages: DescribeStages = {
    idleMs: stageStat(stageSamples.idleMs),
    rootMs: stageStat(stageSamples.rootMs),
    windowsMs: stageStat(stageSamples.windowsMs),
    rootsMs: stageStat(stageSamples.rootsMs),
    serializeMs: stageStat(stageSamples.serializeMs),
    encodeMs: stageStat(stageSamples.encodeMs),
  };
  return { waitedP50: p50(waited), captureP50: p50(captured), n: waited.length, stages };
}

/** Render an idle-vs-after-tap per-stage p50/p95 table for the bench log. */
function formatStageTable(
  label: string,
  idle: { stages: DescribeStages },
  afterTap: { stages: DescribeStages }
): string {
  const cell = (s: StageStat) =>
    s.p50 === null ? "   -   " : `${String(s.p50).padStart(3)}/${String(s.p95 ?? "?").padStart(3)}`;
  const lines: string[] = [];
  lines.push(`[bench] ${label} describe stage p50/p95 (ms)  idle | after-tap`);
  for (const k of STAGE_KEYS) {
    lines.push(`[bench]   ${k.padEnd(11)} ${cell(idle.stages[k])} | ${cell(afterTap.stages[k])}`);
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* describe staleness after a navigating tap (P3d)                             */
/* -------------------------------------------------------------------------- */

// Tap-centre of a describe line's trailing "(x, y, w, h)" frame.
function frameCenterOf(descLine: string): { x: number; y: number } | null {
  const fm = descLine.match(/\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)\s*$/);
  if (!fm) return null;
  return { x: Number(fm[1]) + Number(fm[3]) / 2, y: Number(fm[2]) + Number(fm[4]) / 2 };
}
// Every quoted label (not name="…") in a describe rendering — both backends emit
// the same `"label"` shape, so this is directly comparable across configs.
function labelSetOf(desc: string): Set<string> {
  const set = new Set<string>();
  for (const line of desc.split("\n")) {
    const m = line.match(/(?<![=\w])"((?:[^"\\]|\\.)*)"/);
    if (m?.[1]) set.add(m[1]);
  }
  return set;
}

// The Settings-root category to navigate INTO for the staleness probe. The
// first present (by label) with a tappable frame wins; stable on API 35.
const NAV_CANDIDATES = [
  "Network & internet",
  "Connected devices",
  "Apps",
  "Notifications",
  "Battery",
  "Storage",
  "Sound & vibration",
  "Display",
  "Security & privacy",
  "Security",
  "System",
];

// Derive a deterministic navigating tap target and the destination-only marker
// set (labels on the fully-settled destination but NOT on the root), live from
// the device under the CURRENT flag: a stale post-tap read (still the root)
// shares none of these markers, a fresh read shares at least one. `settleForDerive`
// picks the describe policy used to read the settled destination (true on ON so
// the markers are complete; undefined on OFF where `settle` is a no-op).
async function deriveNavTarget(
  reg: Reg,
  settleForDerive: boolean | undefined
): Promise<{ target: string; x: number; y: number; markers: string[] } | null> {
  await ensureSettings(reg);
  let root: { description: string };
  try {
    root = (await reg.invokeTool("describe", { udid: SERIAL })) as { description: string };
  } catch {
    return null;
  }
  const rootLabels = labelSetOf(root.description);
  const lines = root.description.split("\n");
  // The Settings root renders each row as a single concatenated label
  // ("Network & internet / Mobile, Wi‑Fi, hotspot"), so match a candidate as the
  // PREFIX of a row's label, not an exact quoted string.
  const lineLabel = (l: string): string | undefined =>
    l.match(/(?<![=\w])"((?:[^"\\]|\\.)*)"/)?.[1];
  let picked: { target: string; x: number; y: number } | null = null;
  for (const cand of NAV_CANDIDATES) {
    const line = lines.find((l) => {
      const label = lineLabel(l);
      return !!label && label.startsWith(cand) && !!frameCenterOf(l);
    });
    if (line) {
      const c = frameCenterOf(line)!;
      picked = { target: cand, x: c.x, y: c.y };
      break;
    }
  }
  if (!picked) return null;
  await reg
    .invokeTool("gesture-tap", { udid: SERIAL, x: picked.x, y: picked.y })
    .catch(() => undefined);
  await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 }).catch(() => undefined);
  let dest: { description: string };
  try {
    dest = (await reg.invokeTool("describe", {
      udid: SERIAL,
      ...(settleForDerive === undefined ? {} : { settle: settleForDerive }),
    })) as { description: string };
  } catch {
    return null;
  }
  const destLabels = labelSetOf(dest.description);
  const markers = [...destLabels].filter((l) => !rootLabels.has(l));
  await ensureSettings(reg);
  return { ...picked, markers };
}

// After a navigating tap, does the IMMEDIATE describe already show the
// destination screen (fresh) or still the pre-tap root (stale)? Returns the
// destination-visible rate over n runs for the given describe idle policy
// (`policy` is passed straight to the describe tool: undefined = OFF path where
// `settle` is a no-op; false/true = ON's two policies). `waitedP50` confirms the
// server-side idle wait each policy actually spent (≈0 for settle:false, ≈cap for
// settle:true; null on OFF, which surfaces no split).
async function destinationVisibleRate(
  reg: Reg,
  n: number,
  policy: boolean | undefined,
  nav: { target: string; x: number; y: number; markers: string[] }
): Promise<{ visible: number; n: number; rate: number; waitedP50: number | null }> {
  let visible = 0;
  let counted = 0;
  const waited: number[] = [];
  const markers = new Set(nav.markers);
  for (let i = 0; i < n; i++) {
    await ensureSettings(reg);
    try {
      await reg.invokeTool("gesture-tap", { udid: SERIAL, x: nav.x, y: nav.y });
      const d = (await reg.invokeTool("describe", {
        udid: SERIAL,
        ...(policy === undefined ? {} : { settle: policy }),
      })) as { description: string; waitedMs?: number };
      counted++;
      const labels = labelSetOf(d.description);
      if ([...markers].some((m) => labels.has(m))) visible++;
      if (typeof d.waitedMs === "number") waited.push(d.waitedMs);
    } catch {
      /* skip this run */
    }
  }
  const rate = counted ? Number((visible / counted).toFixed(3)) : NaN;
  return { visible, n: counted, rate, waitedP50: waited.length ? summarize(waited).p50 : null };
}

interface BlockResult {
  block: string;
  config: "OFF" | "ON";
  // Phase 3f: whether tap/swipe/gesture ran on the scrcpy fast-inject backend
  // (true only for the ON-scrcpy block); describe/state/etc. stay on Kotlin.
  fastInject: boolean;
  coldStartMs: number[];
  verbs: VerbResult[];
  // Open-path describe idle-vs-capture split (p50), on an idle Settings root and
  // right after a tap into a content-heavy sub-screen. null on the proprietary
  // path (no split surfaced).
  describeSplitIdle: { waitedP50: number | null; captureP50: number | null; n: number; stages: DescribeStages };
  describeSplitAfterTap: { waitedP50: number | null; captureP50: number | null; n: number; stages: DescribeStages };
  // Post-navigating-tap staleness (P3d): "destination already visible" rate for
  // each describe idle policy — OFF (as-is) in an OFF block; ON settle:false and
  // ON settle:true in an ON block. Empty when no nav target could be derived.
  destinationVisible: Array<{
    policy: string;
    target: string | null;
    markerCount: number;
    visible: number;
    n: number;
    rate: number;
    waitedP50: number | null;
  }>;
  describeSample: {
    source: string;
    bytes: number;
    tokens: number;
    tokensCharsDiv4: number;
    elements: number;
  };
  fidelitySet: string[];
  screenshot: { bytes: number; width: number; height: number; format: string };
  simServerRssKb: number | null;
  // The gesture timing params this block drove (identical across OFF/ON by
  // construction; asserted in main so a drift can't slip through).
  gestureParams: BenchGestureParams;
  // The tap frame timeline this block's backend actually injected (phase 3h) —
  // frame count, per-frame tMs, holdMs. The merge asserts parity from THIS rather
  // than re-reading the source constant per block (meaningless under BENCH_ONLY).
  injectedTapTimeline: InjectedTapTimeline;
  // Total no-effect tap iterations across the effect-checked tap verbs (phase 3h).
  // A healthy block is 0; a positive count fails the block (the tap did not land).
  effectZeroTotal: number;
  notes: string[];
}

// Screen fingerprint for the effect check: the sorted label set of a describe.
// Both backends emit the same `"label"` shape, so this is comparable across
// configs; a navigating tap changes the set, a no-op tap leaves it identical.
async function describeLabelHash(reg: Reg): Promise<string | undefined> {
  try {
    const d = (await reg.invokeTool("describe", { udid: SERIAL })) as { description: string };
    return [...labelSetOf(d.description)].sort().join("\n");
  } catch {
    return undefined;
  }
}

async function coldStart(config: "OFF" | "ON"): Promise<number[]> {
  const out: number[] = [];
  for (let k = 0; k < COLD; k++) {
    await teardownBackend();
    const reg = createRegistry();
    const t0 = Date.now();
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const d = (await reg.invokeTool("describe", { udid: SERIAL })) as { source: string };
        ok = true;
        out.push(Date.now() - t0);
        void d;
      } catch {
        await sleep(500);
      }
    }
    if (!ok) out.push(NaN);
    await reg.dispose().catch(() => undefined);
  }
  return out;
}

async function runBlock(
  block: string,
  config: "OFF" | "ON",
  fastInject: boolean
): Promise<BlockResult> {
  const notes: string[] = [];
  if (config === "ON") setFlag("open-device-server", true, "project");
  else unsetFlag("open-device-server", "project");
  // Phase 3f: the scrcpy control-channel touch backend is gated by this flag; the
  // blueprint reads it when the factory `fastInject` option is omitted (which is
  // the case for the registry-created instances the bench drives). Only the
  // ON-scrcpy block sets it — ON-uiautomation and both OFF blocks leave it off so
  // tap/swipe/gesture stay on the UiAutomation (or proprietary) path.
  if (fastInject) setFlag("open-device-server-fast-inject", true, "project");
  else unsetFlag("open-device-server-fast-inject", "project");

  const coldStartMs = await coldStart(config);

  await teardownBackend();
  const reg = createRegistry();
  const verbs: VerbResult[] = [];

  // ---- Settings root screen ----
  // Validated pristine-root describe first: this is the sample used for
  // bytes/tokens/elements/fidelity, immune to the latency loop and transient
  // crash dialogs.
  const clean = await cleanSettingsDescribe(reg);
  const lastDesc = clean.description;
  const lastSource = clean.source;
  const parsed = parseDescribe(lastDesc);

  // describe latency (measured separately; screen already at root)
  const describeRes = await timeCalls("describe", async () => {
    await reg.invokeTool("describe", { udid: SERIAL });
  });
  const describeSample = {
    source: lastSource,
    bytes: Buffer.byteLength(lastDesc, "utf8"),
    tokens: estTokens(lastDesc),
    tokensCharsDiv4: estTokensCharsDiv4(lastDesc),
    elements: parsed.elements,
  };
  const expectSource = config === "ON" ? "open-device-server" : "android-devtools|uiautomator";
  if (config === "ON" && lastSource !== "open-device-server") {
    notes.push(`describe.source="${lastSource}" (expected open-device-server) — masked fallback`);
  }
  if (config === "OFF" && !/android-devtools|uiautomator/.test(lastSource)) {
    notes.push(`describe.source="${lastSource}" (expected ${expectSource})`);
  }
  verbs.push(describeRes);

  // waitedMs/captureMs split for describe on the idle Settings root (open path
  // only; screen is already at root here). Measured before the tap loops perturb
  // the screen.
  const describeSplitIdle = await describeSplit(reg, Math.min(N, 10), async () => {
    await ensureSettings(reg);
  });

  // screenshot — NOT a latency verb (F6). The two backends return different-sized
  // frames (OFF a ~270×600 stream frame, ON a full-res capture), so timing them
  // side by side compares an encode of very different pixel counts, not the same
  // work. We capture dims once for the report and note the asymmetry instead of
  // scoring a bogus latency row.
  let shot = { bytes: 0, width: 0, height: 0, format: "unknown" };
  try {
    const s = (await reg.invokeTool("screenshot", {
      udid: SERIAL,
      includeImageInContext: false,
    })) as { image: { hostPath: string; mimeType: string; size: number } };
    const info = pngInfo(s.image.hostPath);
    shot = {
      bytes: info.bytes,
      width: info.width,
      height: info.height,
      format: s.image.mimeType + (info.sig ? " (PNG sig ok)" : " (no PNG sig)"),
    };
  } catch {
    /* dims stay zero */
  }
  notes.push(
    "screenshot latency row removed (F6): OFF and ON return different-resolution " +
      "frames, so a side-by-side latency is not like-for-like — see the dims below."
  );

  // Derive a NAVIGATING tap target once (a real Settings category that opens a
  // sub-screen), then reuse it for the effect-checked gesture-tap / tap+describe
  // below AND the staleness probe. Tapping a neutral (0.5, 0.5) point could land on
  // a gap and change nothing — worthless for an effect check — so the effect gate
  // taps a known-navigating row. On the pristine Settings root this target is
  // stable across resets.
  const nav = await deriveNavTarget(reg, config === "ON" ? true : undefined);
  const tapX = nav ? nav.x : 0.5;
  const tapY = nav ? nav.y : 0.5;
  const effectHash = nav ? () => describeLabelHash(reg) : undefined;
  if (!nav) {
    notes.push(
      "effect-check: no navigating target could be derived on this root — gesture-tap / " +
        "tap+describe ran on (0.5, 0.5) WITHOUT an effect check this block"
    );
  }
  await ensureSettings(reg);

  // gesture-tap (navigating target; latency = inject round-trip). Reset to the
  // Settings root before each iteration (F5) so every tap starts identically; the
  // reset is untimed. Effect-checked (phase 3h): a describe-label fingerprint
  // before vs after every tap — effectZero counts iterations where the screen did
  // not change (the tap did not land), which fails the block below.
  verbs.push(
    await timeCalls(
      "gesture-tap",
      async () => {
        await reg.invokeTool("gesture-tap", { udid: SERIAL, x: tapX, y: tapY });
      },
      undefined,
      async () => {
        await ensureSettings(reg);
      },
      effectHash
    )
  );

  // re-establish settings after taps navigated
  await ensureSettings(reg);

  // tap+describe (F4 / P3d): a single timed tap→describe pair — what an agent
  // actually does (act, then read the screen) — resetting to the Settings root
  // between iterations (untimed) so the pair is measured from the same starting
  // screen. ON runs both idle policies: settle:false (immediate read, like-for-
  // like with the proprietary path) and settle:true (the settled read, our
  // policy). OFF has one policy (its describe reads immediately regardless), so it
  // runs as-is. Effect-checked on the same navigating target as gesture-tap.
  const tapThenDescribe = (settle?: boolean) => async () => {
    await reg.invokeTool("gesture-tap", { udid: SERIAL, x: tapX, y: tapY });
    await reg.invokeTool("describe", {
      udid: SERIAL,
      ...(settle === undefined ? {} : { settle }),
    });
  };
  const resetToSettings = async () => {
    await ensureSettings(reg);
  };
  if (config === "ON") {
    verbs.push(await timeCalls("tap+describe(settle:false)", tapThenDescribe(false), undefined, resetToSettings, effectHash));
    await ensureSettings(reg);
    verbs.push(await timeCalls("tap+describe(settle:true)", tapThenDescribe(true), undefined, resetToSettings, effectHash));
  } else {
    verbs.push(await timeCalls("tap+describe", tapThenDescribe(undefined), undefined, resetToSettings, effectHash));
  }

  await ensureSettings(reg);

  // waitedMs/captureMs split for describe right after a tap into a content-heavy
  // sub-screen — the tap+describe scenario. `setup` resets to root then taps, so
  // each describe reads a freshly-navigated (possibly still-settling) screen.
  const describeSplitAfterTap = await describeSplit(reg, Math.min(N, 10), async () => {
    await ensureSettings(reg);
    await reg.invokeTool("gesture-tap", { udid: SERIAL, x: tapX, y: tapY }).catch(() => undefined);
  });

  // Print the per-stage p50/p95 split (idle vs after-tap) so the residual is
  // attributable to a concrete stage. Persisted in the block JSON via
  // describeSplit{Idle,AfterTap}.stages too; run OFF-1 and OFF-2 to read the
  // baseline (proprietary path leaves these null) and ON to read the open path.
  realDebug(formatStageTable(config, describeSplitIdle, describeSplitAfterTap));

  await ensureSettings(reg);

  // Post-navigating-tap staleness (P3d): after tapping a KNOWN Settings category,
  // does the immediate describe already contain the destination screen's content?
  // OFF measures its one policy; ON measures settle:false (like-for-like) and
  // settle:true (settled read). Reuses the `nav` target derived above (same row +
  // marker set), so the effect check and the staleness probe agree.
  const destinationVisible: BlockResult["destinationVisible"] = [];
  if (!nav || nav.markers.length === 0) {
    notes.push(
      "destination-visible: could not derive a nav target / destination markers on this root; staleness skipped"
    );
  } else if (config === "ON") {
    const off = await destinationVisibleRate(reg, N, false, nav);
    destinationVisible.push({
      policy: "ON settle:false",
      target: nav.target,
      markerCount: nav.markers.length,
      ...off,
    });
    await ensureSettings(reg);
    const onT = await destinationVisibleRate(reg, N, true, nav);
    destinationVisible.push({
      policy: "ON settle:true",
      target: nav.target,
      markerCount: nav.markers.length,
      ...onT,
    });
  } else {
    const offRes = await destinationVisibleRate(reg, N, undefined, nav);
    destinationVisible.push({
      policy: "OFF",
      target: nav.target,
      markerCount: nav.markers.length,
      ...offRes,
    });
  }

  await ensureSettings(reg);

  // gesture-swipe — reset to the Settings root before each iteration (F5).
  verbs.push(
    await timeCalls(
      "gesture-swipe",
      async () => {
        await reg.invokeTool("gesture-swipe", {
          udid: SERIAL,
          fromX: 0.5,
          fromY: 0.7,
          toX: 0.5,
          toY: 0.35,
          durationMs: BENCH_GESTURE_PARAMS.swipeDurationMs,
        });
      },
      undefined,
      async () => {
        await ensureSettings(reg);
      }
    )
  );

  await ensureSettings(reg);

  // await-screen-idle (already idle -> resolve time)
  verbs.push(
    await timeCalls("await-screen-idle", async () => {
      await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 });
    })
  );

  // await-ui-element: pick a present label from the current describe
  let selText = "Settings";
  try {
    const d = (await reg.invokeTool("describe", { udid: SERIAL })) as { description: string };
    const m = d.description.split("\n").map((l) => l.match(/(?<![=\w])"((?:[^"\\]|\\.)*)"/)?.[1]);
    const cand = m.find((x): x is string => !!x && x.length > 2 && x.length < 30);
    if (cand) selText = cand;
  } catch {
    /* keep default */
  }
  verbs.push(
    await timeCalls(
      "await-ui-element",
      async () => {
        await reg.invokeTool("await-ui-element", {
          udid: SERIAL,
          condition: "exists",
          selector: { text: selText },
          timeoutMs: 4000,
        });
      },
      () => ({ selector: selText })
    )
  );

  // paste: open Settings search, focus field, then type into it N times
  await ensureSettings(reg);
  let pasteReady = false;
  try {
    const d = (await reg.invokeTool("describe", { udid: SERIAL })) as { description: string };
    // Find the search entry line and tap its centre.
    const line = d.description
      .split("\n")
      .find((l) => /search/i.test(l) && /\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)/.test(l));
    const fm = line?.match(/\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)\s*$/);
    if (fm) {
      const x = Number(fm[1]) + Number(fm[3]) / 2;
      const y = Number(fm[2]) + Number(fm[4]) / 2;
      await reg.invokeTool("gesture-tap", { udid: SERIAL, x, y });
      await sleep(1200);
      pasteReady = true;
    }
  } catch {
    /* pasteReady stays false */
  }
  if (!pasteReady) notes.push("paste: could not locate Settings search field; measured on current focus");
  verbs.push(
    await timeCalls("paste", async (i) => {
      await reg.invokeTool("paste", { udid: SERIAL, text: `b${i % 10}` });
    })
  );

  // gesture-pinch on Chrome/example.com. Every iteration measures the SAME
  // gesture — a zoom-IN from a reset (minimum) page scale — with the reset done
  // untimed in `setup`, exactly as gesture-tap / gesture-swipe reset to the
  // Settings root before each measured call (F5). Without this reset the pinch
  // verb absorbed the PREVIOUS iteration's zoom-settle animation into the next
  // call's implicit `waitForIdle` (the 1029 ms pinch in v3), so the number was
  // measuring idle-wait drift, not the gesture.
  const chromeOk = await ensureChrome(reg);
  if (!chromeOk) notes.push("gesture-pinch: Chrome/example.com did not confirm content; latency still measured");
  verbs.push(
    await timeCalls(
      "gesture-pinch",
      async () => {
        await reg.invokeTool("gesture-pinch", {
          udid: SERIAL,
          centerX: 0.5,
          centerY: 0.4,
          startDistance: 0.08,
          endDistance: 0.42,
          durationMs: BENCH_GESTURE_PARAMS.pinchDurationMs,
        });
      },
      undefined,
      async () => {
        // Untimed reset: pinch the page back to minimum zoom, then settle, so the
        // measured zoom-in starts from the identical page scale on both backends.
        await reg
          .invokeTool("gesture-pinch", {
            udid: SERIAL,
            centerX: 0.5,
            centerY: 0.4,
            startDistance: 0.42,
            endDistance: 0.05,
            durationMs: BENCH_GESTURE_PARAMS.pinchDurationMs,
          })
          .catch(() => undefined);
        await reg
          .invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 })
          .catch(() => undefined);
      }
    )
  );

  const rss = config === "OFF" ? simServerRssKb() : null;
  if (config === "ON") notes.push("host process: none beyond adb (open server runs on-device via am instrument)");

  // The tap timeline this block's backend injected, and the total no-effect tap
  // iterations across the effect-checked tap verbs (phase 3h).
  const injectBackend = fastInject ? "scrcpy" : config === "ON" ? "uiautomation" : "proprietary";
  const injectedTapTimeline = describeInjectedTapTimeline(injectBackend, BENCH_GESTURE_PARAMS.tapHoldMs);
  const effectZeroTotal = verbs.reduce((s, v) => s + (v.effectZero ?? 0), 0);
  const effectCheckedTotal = verbs.reduce((s, v) => s + (v.effectChecked ?? 0), 0);
  notes.push(
    `effect-check: ${effectZeroTotal} no-effect tap iteration(s) of ${effectCheckedTotal} checked ` +
      `(target=${nav ? nav.target : "none"}); tap backend=${injectBackend}`
  );

  // Fidelity is compared on the pristine Settings root captured at block start
  // (before any tap/paste/keyboard state), so OFF and ON are the same screen.
  const fidelitySet = parsed.idTextSet;

  await reg.dispose().catch(() => undefined);
  await teardownBackend();

  return {
    block,
    config,
    fastInject,
    coldStartMs,
    verbs,
    describeSample,
    fidelitySet,
    screenshot: shot,
    simServerRssKb: rss,
    gestureParams: BENCH_GESTURE_PARAMS,
    injectedTapTimeline,
    effectZeroTotal,
    describeSplitIdle,
    describeSplitAfterTap,
    destinationVisible,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const started = new Date().toISOString();

  // environment capture
  const env = {
    startedAt: started,
    serial: SERIAL,
    N,
    WARMUP,
    COLD,
    tokenizer: TOKENIZER,
    androidRelease: adbShell("getprop ro.build.version.release").trim(),
    androidSdk: adbShell("getprop ro.build.version.sdk").trim(),
    abi: adbShell("getprop ro.product.cpu.abi").trim(),
    screen: adbShell("wm size").trim(),
    density: adbShell("wm density").trim(),
    simulatorServerDir: process.env.ARGENT_SIMULATOR_SERVER_DIR ?? null,
    devtoolsAndroidBinDir: process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR ?? null,
  };
  realDebug("[bench] env:", JSON.stringify(env));

  // Memory-frugal per-block mode (phase 3e): under heavy host memory pressure the
  // full OFF-1→…→OFF-2 process was Jetsam-killed (SIGKILL) mid-run. Setting
  // BENCH_ONLY=<block> runs a SINGLE block in a short-lived process and writes a
  // per-block file `bench-block-<name>.json` ({env, block}); run-bench-merge.js
  // assembles the four into the same combined result + fidelity. No env → the
  // original single-process full run.
  //
  // Phase 3f: FOUR blocks. The two ON blocks share the open Kotlin describe/state
  // path (so their describe bytes/tokens/fidelity are identical); they differ only
  // in the tap/swipe/gesture backend — ON-uiautomation injects via UiAutomation,
  // ON-scrcpy injects over the scrcpy control channel (fast-inject flag on).
  const ALL_BLOCKS: Array<[string, "OFF" | "ON", boolean]> = [
    ["OFF-1", "OFF", false],
    ["ON-uiautomation", "ON", false],
    ["ON-scrcpy", "ON", true],
    ["OFF-2", "OFF", false],
  ];
  const only = process.env.BENCH_ONLY;
  const toRun = only ? ALL_BLOCKS.filter(([b]) => b === only) : ALL_BLOCKS;
  if (only && toRun.length === 0)
    throw new Error(`BENCH_ONLY="${only}" is not one of ${ALL_BLOCKS.map(([b]) => b).join("|")}`);

  const blocks: BlockResult[] = [];
  for (const [block, config, fastInject] of toRun) {
    realDebug(`[bench] === block ${block} (${config}${fastInject ? ", scrcpy fast-inject" : ""}) ===`);
    const dbgMark = debugLines.length;
    const r = await runBlock(block, config, fastInject);
    blocks.push(r);
    // Surface the scrcpy server start line + scid + control-channel line to REAL
    // stdout (not only the captured console.debug), plus this block's fast-inject
    // fallback count and effect-check count — so bench-log-<block>.txt shows the
    // scrcpy session was real and clean without digging into the JSON (item: print
    // the scrcpy server start line, scid, and fastInjectFallbacks per block).
    const scrcpyLines = debugLines
      .slice(dbgMark)
      .filter((l) => /scrcpy (server starting|control channel)|scid=/.test(l));
    for (const l of [...new Set(scrcpyLines)]) realDebug(`[bench][${block}] ${l}`);
    const fbTotal = (r.verbs || []).reduce((s, v) => s + (v.fallbacks || 0), 0);
    realDebug(
      `[bench][${block}] fastInject=${fastInject} fastInjectFallbacks=${fbTotal} ` +
        `effectZero=${r.effectZeroTotal} tapFrames=${r.injectedTapTimeline.frameCount}` +
        `(move=${r.injectedTapTimeline.hasMoveFrame})`
    );
    realDebug(
      `[bench] ${block} done: describe p50=${r.verbs[0]?.latency.p50}ms source=${r.describeSample.source} ` +
        `screenshot=${r.screenshot.bytes}b cold=${JSON.stringify(r.coldStartMs)} rss=${r.simServerRssKb}`
    );
  }

  // reset flags to default OFF
  unsetFlag("open-device-server", "project");
  unsetFlag("open-device-server-fast-inject", "project");

  if (only) {
    const blockPath = join(OUT_DIR, `bench-block-${only}.json`);
    writeFileSync(blockPath, JSON.stringify({ env, block: blocks[0] }, null, 2));
    realDebug(`[bench] wrote ${blockPath}`);
    process.stdout.write(`RESULT_JSON=${blockPath}\n`);
    // Effect gate (phase 3h): fail the block AFTER writing its file (so the
    // artifact is preserved) if any effect-checked tap iteration saw no screen
    // change. This is the gate that would have caught the retracted "tap win" — a
    // no-op scrcpy injection timed as a fast tap.
    const ez = blocks[0]!.effectZeroTotal;
    if (ez > 0) {
      throw new Error(
        `block ${only}: ${ez} no-effect tap iteration(s) — the tap did not land on a ` +
          `navigating target (pngDiffRatio-equivalent 0). Failing the block.`
      );
    }
    return;
  }

  // Parity gate: every block must have driven the identical gesture timeline, so
  // the OFF/ON latency comparison is genuinely like-for-like (throws otherwise).
  assertIdenticalGestureParams(blocks);
  // Tap-timeline parity (phase 3h): same authored holdMs everywhere; the same-point
  // MOVE present in exactly the scrcpy block. Recorded from the real injected shape.
  assertTapTimelineParity(blocks);
  // Effect gate across blocks: no block may have a no-effect tap iteration.
  const effectZeroByBlock = blocks
    .filter((b) => b.effectZeroTotal > 0)
    .map((b) => `${b.block}=${b.effectZeroTotal}`);
  if (effectZeroByBlock.length) {
    throw new Error(`no-effect tap iterations detected: ${effectZeroByBlock.join(", ")}`);
  }

  const off1 = blocks.find((b) => b.block === "OFF-1")!;
  // Fidelity (describe tree) is identical for both ON blocks — fast-inject only
  // changes touch injection, not the describe path — so compare OFF-1 against the
  // ON-uiautomation describe sample.
  const on = blocks.find((b) => b.block === "ON-uiautomation")!;
  const result = {
    env,
    blocks,
    fidelity: {
      off1_vs_on_jaccard: jaccard(off1.fidelitySet, on.fidelitySet),
      onlyOff: off1.fidelitySet.filter((x) => !on.fidelitySet.includes(x)),
      onlyOn: on.fidelitySet.filter((x) => !off1.fidelitySet.includes(x)),
      offCount: off1.fidelitySet.length,
      onCount: on.fidelitySet.length,
    },
    finishedAt: new Date().toISOString(),
  };

  const outPath = join(OUT_DIR, `bench-${started.replace(/[:.]/g, "-")}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  realDebug(`[bench] wrote ${outPath}`);
  // Print the path last so the caller can capture it.
  process.stdout.write(`RESULT_JSON=${outPath}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    realDebug("[bench] FATAL", e);
    process.exit(1);
  });
