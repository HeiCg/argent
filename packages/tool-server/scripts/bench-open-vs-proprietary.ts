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
import { performance } from "node:perf_hooks";
import { createRegistry } from "../src/utils/setup-registry";
import { setFlag, unsetFlag } from "@argent/configuration-core";
import { resolveDevice } from "../src/utils/device-info";
import { isAndroidTv, isAndroidTvCached } from "../src/utils/adb";
import { openDeviceServerRef, type OpenDeviceServerApi } from "../src/blueprints/android-open-server";
import { AndroidOpenServerClient } from "../src/utils/android-open-server-client";
import {
  emulatorConsolePort,
  readConsoleAuthToken,
  freeHostPort,
  redirAdd,
  redirDel,
} from "../src/utils/open-server-transport";
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

// Phase 3j: the transport experiment (serialize-once/compact A/B + adb-forward vs
// redir vs padding) adds ~20 min per ON block, so it is OFF by default — routine
// runs stay ~1 h and still show redir via the four-block idle describe + its
// decomposition. Enabling it ALSO starts the on-device server in bench-debug mode
// (read at spawn time by the blueprint) so its debug RPC params (_padTo,
// _benchLegacyEncode) are honored; one knob controls both.
const PHASE3J_EXPERIMENT = process.env.BENCH_PHASE3J_EXPERIMENT === "1";
if (PHASE3J_EXPERIMENT) process.env.ARGENT_OPEN_SERVER_BENCH_DEBUG = "1";

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
// Count ONLY fast-inject (scrcpy → Kotlin) fallbacks, i.e. the blueprint's
// "[open-server-fast-inject] scrcpy <verb> failed; falling back to the Kotlin ..."
// line — the ON-scrcpy gate's concern. It must NOT count the describe path's own
// "[describe.android] ... falling back to uiautomator" (an empty-tree retry that
// happens on every ON block during rapid effect-check describes) — conflating the
// two failed a clean scrcpy arm on benign describe retries.
function fallbackCountSince(mark: number): { count: number; samples: string[] } {
  const slice = debugLines.slice(mark);
  const hits = slice.filter((l) => /\[open-server-fast-inject\].*falling back/i.test(l));
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

// LIGHT reset for the tap effect loop: force-stop + relaunch WITHOUT `pm clear`
// (the effect check captures a fresh origin each iteration, so it needs a stable
// root to return to, not a pristine paste/search state). ~2-3 s vs ensureSettings'
// ~6-8 s — pm clear per originLost was what dragged a bench block to many minutes.
async function relaunchSettings(reg: Reg): Promise<void> {
  dismissSystemDialogs();
  adbShell(`am force-stop ${SETTINGS}`, 8_000);
  adbShell(`am start -n ${SETTINGS}/.Settings`, 8_000);
  await sleep(700);
  await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 3000 }).catch(() => undefined);
}

// A describe validated to be the real Settings root: not a crash dialog, and
// carrying at least one canonical root row. Retries the screen reset a few times
// so a transient ADT crash can't poison the byte/element/fidelity numbers.
async function cleanSettingsDescribe(
  reg: Reg
): Promise<{ description: string; source: string; transport?: string }> {
  let last: { description: string; source: string; transport?: string } = {
    description: "",
    source: "",
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    await ensureSettings(reg);
    try {
      const d = (await reg.invokeTool("describe", { udid: SERIAL })) as {
        description: string;
        source: string;
        // Phase 3j item 3d (fix h): which host↔device transport the open path used —
        // "redir" on the CI emulator once the redir client pings, else "adb-forward";
        // undefined on the proprietary (OFF) path.
        transport?: string;
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
  // Phase 3h review A9/d: the messages of the iterations counted in `errors`, so a
  // discarded iteration (e.g. the ON-scrcpy 0/59 tap) is explicable from the JSON
  // rather than swallowed by a bare catch. Capped to the first few.
  errorSamples: string[];
  // Effect-check (phase 3h), only on the tap verbs measured by `timeTapEffect`:
  // `effectChecked` iterations had a clean origin and a completed tap; `effectZero`
  // of them showed NO screen change within the poll window (the tap never landed);
  // `originLost` iterations could not be restored to the origin after a tap and were
  // hard-reset (excluded from effectChecked). A healthy block has effectZero === 0.
  // This is TIMING-INDEPENDENT: it polls the fingerprint after the (separately
  // timed) tap until it changes or 3 s elapse, so a driver whose describe returns
  // before the navigation renders (the proprietary path) is not miscounted.
  effectChecked?: number;
  effectZero?: number;
  originLost?: number;
  extra?: Record<string, unknown>;
}

async function timeCalls(
  label: string,
  fn: (i: number) => Promise<void>,
  extra?: () => Record<string, unknown>,
  // Untimed per-iteration setup (F5): resets the screen to a known state before
  // each measured tap/swipe so every iteration starts from the same place, and
  // its cost is NOT counted in the latency of the verb under test.
  setup?: (i: number) => Promise<void>
): Promise<VerbResult> {
  for (let i = 0; i < WARMUP; i++) {
    if (setup) await setup(i).catch(() => undefined);
    await fn(i).catch(() => undefined);
  }
  const mark = debugLines.length;
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
      if (errorSamples.length < 5) errorSamples.push(`i=${i}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const fb = fallbackCountSince(mark);
  return {
    verb: label,
    latency: summarize(lat),
    errors,
    errorSamples,
    fallbacks: fb.count,
    fallbackSamples: fb.samples,
    extra: extra?.(),
  };
}

/**
 * Poll `read` until `ok(value)` or `timeoutMs` elapses; returns whether it became
 * ok. Read errors are treated as not-ok (kept polling). Used to make the effect
 * check timing-INDEPENDENT: after the (separately timed) tap we wait for the screen
 * to actually change rather than reading once and racing the navigation.
 */
async function pollUntil<T>(
  read: () => Promise<T>,
  ok: (v: T | undefined) => boolean,
  timeoutMs: number,
  stepMs = 150
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read().catch(() => undefined);
    if (ok(v)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(stepMs);
  }
}

interface TapEffectResult extends VerbResult {
  effectChecked: number;
  effectZero: number;
  originLost: number;
}

/**
 * Timing-independent effect-checked tap measurement (phase 3h). Per iteration:
 * establish a clean origin, TIME exactly `tapRpc` (the tap RPC, or tap RPC +
 * describe RPC for tap+describe), then OUTSIDE the timed window poll the screen
 * fingerprint until it differs from the origin or 3 s elapse — `effectZero` counts
 * only taps that NEVER changed the screen. Restore the origin with BACK (poll until
 * it is back), hard-resetting via `ensureOrigin` and counting `originLost` if BACK
 * did not restore it, so the next iteration never taps from a wrong screen.
 */
async function timeTapEffect(
  label: string,
  tapRpc: (i: number) => Promise<void>,
  fingerprint: () => Promise<string | undefined>,
  ensureOrigin: () => Promise<void>,
  restoreBack: () => Promise<void>
): Promise<TapEffectResult> {
  for (let i = 0; i < WARMUP; i++) {
    await ensureOrigin().catch(() => undefined);
    await tapRpc(i).catch(() => undefined);
  }
  await ensureOrigin().catch(() => undefined);
  const mark = debugLines.length;
  const lat: number[] = [];
  let errors = 0;
  const errorSamples: string[] = [];
  let effectChecked = 0;
  let effectZero = 0;
  let originLost = 0;
  for (let i = 0; i < N; i++) {
    let origin = await fingerprint().catch(() => undefined);
    if (origin === undefined) {
      await ensureOrigin().catch(() => undefined);
      origin = await fingerprint().catch(() => undefined);
    }
    if (origin === undefined) {
      originLost++;
      continue;
    }
    const originFp = origin;
    // TIMED window: exactly the tap RPC(s).
    const t0 = Date.now();
    try {
      await tapRpc(i);
      lat.push(Date.now() - t0);
    } catch (e) {
      errors++;
      if (errorSamples.length < 5) errorSamples.push(`i=${i}: ${e instanceof Error ? e.message : String(e)}`);
      await ensureOrigin().catch(() => undefined);
      continue;
    }
    // UNTIMED: did the screen EVER change within 3 s? (poll, not a single read)
    const changed = await pollUntil(fingerprint, (f) => f !== undefined && f !== originFp, 3000, 150);
    effectChecked++;
    if (!changed) effectZero++;
    // UNTIMED: restore the origin for the next iteration.
    if (changed) {
      await restoreBack().catch(() => undefined);
      // Origin renders fast after BACK; if it is not back in ~2 s, hard-reset.
      const restored = await pollUntil(fingerprint, (f) => f === originFp, 2000, 150);
      if (!restored) {
        originLost++;
        await ensureOrigin().catch(() => undefined);
      }
    }
  }
  const fb = fallbackCountSince(mark);
  return {
    verb: label,
    latency: summarize(lat),
    errors,
    errorSamples,
    fallbacks: fb.count,
    fallbackSamples: fb.samples,
    effectChecked,
    effectZero,
    originLost,
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
  // Host-side split (phase 3i): the cost OUTSIDE the on-device `timings`.
  // `hostParseMs` is the host JSON.parse of the reply, `hostRenderMs` the host
  // tree-lowering + v2 trim. The host-clock timeline decomposes the round-trip:
  // `hostTtfbMs` = request-flushed → first response byte (request leg + server
  // pre-write incl. capture), `hostRecvMs` = first → last byte (receive/streaming
  // span; on loopback ≈ the server write duration), `hostRttMs` = the whole thing.
  hostParseMs: StageStat;
  hostRenderMs: StageStat;
  hostTtfbMs: StageStat;
  hostRecvMs: StageStat;
  hostRttMs: StageStat;
  // Server-side write timeline piggybacked from the previous same-method reply
  // (phase 3i). Clean when the describe loop is back-to-back (prev getState is the
  // previous describe's getState); representative-only under the after-tap loop.
  prevServerWriteMs: StageStat;
  prevServerHandleMs: StageStat;
  prevServerTotalMs: StageStat;
};
const STAGE_KEYS = [
  "idleMs",
  "rootMs",
  "windowsMs",
  "rootsMs",
  "serializeMs",
  "encodeMs",
  "hostParseMs",
  "hostRenderMs",
  "hostTtfbMs",
  "hostRecvMs",
  "hostRttMs",
  "prevServerWriteMs",
  "prevServerHandleMs",
  "prevServerTotalMs",
] as const;
type StageKey = (typeof STAGE_KEYS)[number];

function stageStat(xs: number[]): StageStat {
  if (!xs.length) return { p50: null, p95: null, n: 0 };
  const sm = summarize(xs);
  return { p50: sm.p50, p95: sm.p95, n: xs.length };
}

// Named so BlockResult and runBlock share one shape.
type DescribeSplit = {
  waitedP50: number | null;
  captureP50: number | null;
  n: number;
  // Per-stage p50/p95 of the open-path describe capture (phase 3g). Persisted per
  // describe call and summarized here so the residual after a tap can be pinned to
  // a concrete stage (rootInActiveWindow vs windows enumeration vs each w.root vs
  // serialize vs encode) rather than guessed from logcat.
  stages: DescribeStages;
  // Reply wire size (phase 3i), the full nested tree over `adb forward`. Bytes, not
  // ms, so it rides beside `stages` rather than in the ms table.
  wireBytes: StageStat;
};

// The describe result metadata the phase 3g/3i instrumentation attaches.
type DescribeMeta = {
  waitedMs?: number;
  captureMs?: number;
  wireBytes?: number;
  hostParseMs?: number;
  hostRenderMs?: number;
  hostSentToFirstByteMs?: number;
  hostFirstToLastByteMs?: number;
  hostRoundTripMs?: number;
  timings?: {
    idleMs?: number;
    rootMs?: number;
    windowsMs?: number;
    rootsMs?: number[];
    serializeMs?: number;
    encodeMs?: number;
    prevServerHandleMs?: number;
    prevServerWriteMs?: number;
    prevServerTotalMs?: number;
  };
};

// Accumulator so the timed idle loop and the after-tap loop collect identically.
interface SplitAcc {
  waited: number[];
  captured: number[];
  wireBytesSamples: number[];
  stageSamples: Record<StageKey, number[]>;
}
function newSplitAcc(): SplitAcc {
  return {
    waited: [],
    captured: [],
    wireBytesSamples: [],
    stageSamples: {
      idleMs: [], rootMs: [], windowsMs: [], rootsMs: [], serializeMs: [], encodeMs: [],
      hostParseMs: [], hostRenderMs: [], hostTtfbMs: [], hostRecvMs: [], hostRttMs: [],
      prevServerWriteMs: [], prevServerHandleMs: [], prevServerTotalMs: [],
    },
  };
}
function collectSplit(acc: SplitAcc, d: DescribeMeta): void {
  const s = acc.stageSamples;
  if (typeof d.waitedMs === "number") acc.waited.push(d.waitedMs);
  if (typeof d.captureMs === "number") acc.captured.push(d.captureMs);
  if (typeof d.wireBytes === "number") acc.wireBytesSamples.push(d.wireBytes);
  if (typeof d.hostParseMs === "number") s.hostParseMs.push(d.hostParseMs);
  if (typeof d.hostRenderMs === "number") s.hostRenderMs.push(d.hostRenderMs);
  if (typeof d.hostSentToFirstByteMs === "number") s.hostTtfbMs.push(d.hostSentToFirstByteMs);
  if (typeof d.hostFirstToLastByteMs === "number") s.hostRecvMs.push(d.hostFirstToLastByteMs);
  if (typeof d.hostRoundTripMs === "number") s.hostRttMs.push(d.hostRoundTripMs);
  const t = d.timings;
  if (t) {
    if (typeof t.idleMs === "number") s.idleMs.push(t.idleMs);
    if (typeof t.rootMs === "number") s.rootMs.push(t.rootMs);
    if (typeof t.windowsMs === "number") s.windowsMs.push(t.windowsMs);
    // rootsMs is one entry per kept window; sum to the per-call total.
    if (Array.isArray(t.rootsMs)) s.rootsMs.push(t.rootsMs.reduce((a, b) => a + b, 0));
    if (typeof t.serializeMs === "number") s.serializeMs.push(t.serializeMs);
    if (typeof t.encodeMs === "number") s.encodeMs.push(t.encodeMs);
    if (typeof t.prevServerWriteMs === "number") s.prevServerWriteMs.push(t.prevServerWriteMs);
    if (typeof t.prevServerHandleMs === "number") s.prevServerHandleMs.push(t.prevServerHandleMs);
    if (typeof t.prevServerTotalMs === "number") s.prevServerTotalMs.push(t.prevServerTotalMs);
  }
}
function finalizeSplit(acc: SplitAcc): DescribeSplit {
  const p50 = (xs: number[]): number | null => (xs.length ? summarize(xs).p50 : null);
  const s = acc.stageSamples;
  const stages: DescribeStages = {
    idleMs: stageStat(s.idleMs),
    rootMs: stageStat(s.rootMs),
    windowsMs: stageStat(s.windowsMs),
    rootsMs: stageStat(s.rootsMs),
    serializeMs: stageStat(s.serializeMs),
    encodeMs: stageStat(s.encodeMs),
    hostParseMs: stageStat(s.hostParseMs),
    hostRenderMs: stageStat(s.hostRenderMs),
    hostTtfbMs: stageStat(s.hostTtfbMs),
    hostRecvMs: stageStat(s.hostRecvMs),
    hostRttMs: stageStat(s.hostRttMs),
    prevServerWriteMs: stageStat(s.prevServerWriteMs),
    prevServerHandleMs: stageStat(s.prevServerHandleMs),
    prevServerTotalMs: stageStat(s.prevServerTotalMs),
  };
  return {
    waitedP50: p50(acc.waited),
    captureP50: p50(acc.captured),
    n: Math.max(acc.waited.length, acc.stageSamples.hostRttMs.length),
    stages,
    wireBytes: stageStat(acc.wireBytesSamples),
  };
}

async function describeSplit(
  reg: Reg,
  n: number,
  setup?: () => Promise<void>
): Promise<DescribeSplit> {
  const acc = newSplitAcc();
  for (let i = 0; i < n; i++) {
    if (setup) await setup().catch(() => undefined);
    try {
      collectSplit(acc, (await reg.invokeTool("describe", { udid: SERIAL })) as DescribeMeta);
    } catch {
      /* skip */
    }
  }
  return finalizeSplit(acc);
}

/**
 * Timed idle-describe loop (phase 3i correction): times N BACK-TO-BACK describes
 * on the already-at-root screen AND collects each one's stage timings + host/server
 * timeline, so the verb-latency p50/p95 and the full decomposition come from the
 * SAME N iterations (the old split sampled a separate Math.min(N,10) loop with an
 * untimed ensureSettings between calls — not subtractable). Back-to-back also makes
 * the piggybacked prevServer* clean: the previous getState is the previous
 * describe's getState.
 */
async function describeIdleLatencyWithStages(
  reg: Reg,
  label: string,
  n: number
): Promise<{ verb: VerbResult; split: DescribeSplit }> {
  for (let i = 0; i < WARMUP; i++) {
    await reg.invokeTool("describe", { udid: SERIAL }).catch(() => undefined);
  }
  const mark = debugLines.length;
  const acc = newSplitAcc();
  const lat: number[] = [];
  let errors = 0;
  const errorSamples: string[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    try {
      const d = (await reg.invokeTool("describe", { udid: SERIAL })) as DescribeMeta;
      lat.push(Date.now() - t0);
      collectSplit(acc, d);
    } catch (e) {
      errors++;
      if (errorSamples.length < 5) errorSamples.push(`i=${i}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const fb = fallbackCountSince(mark);
  return {
    verb: {
      verb: label,
      latency: summarize(lat),
      errors,
      errorSamples,
      fallbacks: fb.count,
      fallbackSamples: fb.samples,
      extra: undefined,
    },
    split: finalizeSplit(acc),
  };
}

/** Render an idle-vs-after-tap per-stage p50/p95 table for the bench log. */
function formatStageTable(
  label: string,
  idle: { stages: DescribeStages; wireBytes: StageStat },
  afterTap: { stages: DescribeStages; wireBytes: StageStat }
): string {
  const cell = (s: StageStat) =>
    s.p50 === null ? "   -   " : `${String(s.p50).padStart(3)}/${String(s.p95 ?? "?").padStart(3)}`;
  const lines: string[] = [];
  lines.push(`[bench] ${label} describe stage p50/p95 (ms)  idle | after-tap`);
  for (const k of STAGE_KEYS) {
    lines.push(`[bench]   ${k.padEnd(12)} ${cell(idle.stages[k])} | ${cell(afterTap.stages[k])}`);
  }
  // Wire payload (phase 3i): bytes, not ms — the full nested tree over adb forward.
  const bcell = (s: StageStat) =>
    s.p50 === null ? "   -   " : `${String(s.p50).padStart(6)}/${String(s.p95 ?? "?").padStart(6)}`;
  lines.push(`[bench]   ${"wireBytes".padEnd(12)} ${bcell(idle.wireBytes)} | ${bcell(afterTap.wireBytes)}`);
  return lines.join("\n");
}

/**
 * Raw RPC round-trip floor (phase 3i): time N `ping` calls to the open server over
 * `adb forward`. `ping` carries no `getState` work, so its p50 is the transport +
 * dispatch floor — ~1 ms confirms the socket itself is cheap (TCP_NODELAY set both
 * ends) and the idle describe residual is payload/serialize, not the round-trip.
 * Sub-ms precision via performance.now(). Returns nulls if the open server can't be
 * resolved (e.g. an OFF block).
 */
async function measurePing(
  reg: Reg,
  n: number
): Promise<{ p50: number | null; p95: number | null; n: number }> {
  try {
    const device = resolveDevice(SERIAL);
    const ref = openDeviceServerRef(device);
    const server = await reg.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    for (let i = 0; i < 3; i++) await server.ping().catch(() => undefined); // warmup
    const lat: number[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      try {
        await server.ping();
        lat.push(performance.now() - t0);
      } catch {
        /* skip */
      }
    }
    if (lat.length === 0) return { p50: null, p95: null, n: 0 };
    const s = summarize(lat);
    return { p50: s.p50, p95: s.p95, n: lat.length };
  } catch {
    return { p50: null, p95: null, n: 0 };
  }
}

// Reply fields the phase 3i host + server instrumentation attaches to getState /
// getNestedState. All optional — absent on an older server APK.
interface RpcTimedReply {
  wireBytes?: number;
  hostParseMs?: number;
  hostSentToFirstByteMs?: number;
  hostFirstToLastByteMs?: number;
  hostRoundTripMs?: number;
  waitedMs?: number;
  captureMs?: number;
  timings?: {
    encodeMs?: number;
    serializeMs?: number;
    prevServerHandleMs?: number;
    prevServerWriteMs?: number;
    prevServerTotalMs?: number;
  };
}

// Full end-to-end decomposition of one RPC, measured BACK-TO-BACK (no other RPC
// between calls) so the piggybacked prevServer* fields belong to the previous call
// of the SAME method — the clean version of what describeSplit collects amid setup
// (phase 3i). Bytes for wireBytes; ms for the rest.
interface RpcBreakdown {
  label: string;
  n: number;
  wireBytes: StageStat;
  hostTtfbMs: StageStat;
  hostRecvMs: StageStat;
  hostRttMs: StageStat;
  hostParseMs: StageStat;
  serverWaitedMs: StageStat;
  serverCaptureMs: StageStat;
  serverEncodeMs: StageStat;
  serverWriteMs: StageStat; // prevServerWriteMs (t4 - t3)
  serverHandleMs: StageStat; // prevServerHandleMs (t3 - t2)
  serverTotalMs: StageStat; // prevServerTotalMs (t4 - t2)
}

async function measureRpcBreakdown(
  reg: Reg,
  label: string,
  n: number,
  call: (server: OpenDeviceServerApi) => Promise<RpcTimedReply>
): Promise<RpcBreakdown | null> {
  try {
    const device = resolveDevice(SERIAL);
    const ref = openDeviceServerRef(device);
    const server = await reg.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    // Warmup also primes the server's prevServer* piggyback for the first sample.
    for (let i = 0; i < 3; i++) await call(server).catch(() => undefined);
    const s = {
      wire: [] as number[], ttfb: [] as number[], recv: [] as number[], rtt: [] as number[],
      parse: [] as number[], waited: [] as number[], capture: [] as number[], encode: [] as number[],
      write: [] as number[], handle: [] as number[], total: [] as number[],
    };
    const push = (arr: number[], v?: number) => {
      if (typeof v === "number" && Number.isFinite(v)) arr.push(v);
    };
    for (let i = 0; i < n; i++) {
      try {
        const r = await call(server);
        push(s.wire, r.wireBytes);
        push(s.ttfb, r.hostSentToFirstByteMs);
        push(s.recv, r.hostFirstToLastByteMs);
        push(s.rtt, r.hostRoundTripMs);
        push(s.parse, r.hostParseMs);
        push(s.waited, r.waitedMs);
        push(s.capture, r.captureMs);
        push(s.encode, r.timings?.encodeMs);
        push(s.write, r.timings?.prevServerWriteMs);
        push(s.handle, r.timings?.prevServerHandleMs);
        push(s.total, r.timings?.prevServerTotalMs);
      } catch {
        /* skip */
      }
    }
    return {
      label,
      n: s.rtt.length,
      wireBytes: stageStat(s.wire),
      hostTtfbMs: stageStat(s.ttfb),
      hostRecvMs: stageStat(s.recv),
      hostRttMs: stageStat(s.rtt),
      hostParseMs: stageStat(s.parse),
      serverWaitedMs: stageStat(s.waited),
      serverCaptureMs: stageStat(s.capture),
      serverEncodeMs: stageStat(s.encode),
      serverWriteMs: stageStat(s.write),
      serverHandleMs: stageStat(s.handle),
      serverTotalMs: stageStat(s.total),
    };
  } catch {
    return null;
  }
}

/**
 * Measure the per-describe adb-spawn cost the form-factor check used to pay
 * (phase 3i correction #1). `isAndroidTv` re-runs `adb devices` + `getprop
 * ro.boot.qemu.avd_name` on EVERY call (the memo caches only the pm-features
 * verdict), so `describe` paid three adb process spawns inside its timed window,
 * OFF and ON alike. `isAndroidTvCached` returns the memoized kind with zero
 * spawns. before = the old cost, after ≈ 0 = the new cost. Runs on both configs
 * (adb is available in both).
 */
async function measureAdbFormFactorCost(
  n: number
): Promise<{ beforeP50: number | null; beforeP95: number | null; afterP50: number | null; n: number }> {
  try {
    const before: number[] = [];
    const after: number[] = [];
    for (let i = 0; i < 3; i++) await isAndroidTv(SERIAL).catch(() => undefined); // warm the memo
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await isAndroidTv(SERIAL).catch(() => undefined); // still spawns adb devices + getprop
      before.push(performance.now() - t0);
      const t1 = performance.now();
      await isAndroidTvCached(SERIAL).catch(() => undefined); // cache-only, zero spawns
      after.push(performance.now() - t1);
    }
    if (before.length === 0) return { beforeP50: null, beforeP95: null, afterP50: null, n: 0 };
    const b = summarize(before);
    const a = summarize(after);
    return { beforeP50: b.p50, beforeP95: b.p95, afterP50: a.p50, n: before.length };
  } catch {
    return { beforeP50: null, beforeP95: null, afterP50: null, n: 0 };
  }
}

/** Render one RpcBreakdown as a p50/p95 stage table for the bench log. */
function formatRpcBreakdown(b: RpcBreakdown): string {
  const cell = (st: StageStat) =>
    st.p50 === null ? "   -   " : `${String(st.p50).padStart(6)}/${String(st.p95 ?? "?").padStart(6)}`;
  const rows: Array<[string, StageStat]> = [
    ["wireBytes", b.wireBytes],
    ["hostTtfbMs", b.hostTtfbMs],
    ["hostRecvMs", b.hostRecvMs],
    ["hostRttMs", b.hostRttMs],
    ["hostParseMs", b.hostParseMs],
    ["server waitedMs", b.serverWaitedMs],
    ["server captureMs", b.serverCaptureMs],
    ["server encodeMs", b.serverEncodeMs],
    ["server writeMs(t4-t3)", b.serverWriteMs],
    ["server handleMs(t3-t2)", b.serverHandleMs],
    ["server totalMs(t4-t2)", b.serverTotalMs],
  ];
  const lines: string[] = [];
  lines.push(`[bench] RPC breakdown ${b.label} (N=${b.n}) p50/p95`);
  for (const [k, st] of rows) lines.push(`[bench]   ${k.padEnd(22)} ${cell(st)}`);
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* phase 3j: serialize-once + compact A/B, and the transport experiment         */
/* -------------------------------------------------------------------------- */

// One transport arm's host-observed cost (phase 3j item 3): the RPC round-trip,
// the first→last-byte receive span (where the ~40 ms delayed-ACK gap lives), and
// the wire size, all p50/p95 over N getNestedState calls.
interface TransportArm {
  label: string;
  available: boolean;
  note: string;
  rtt: StageStat;
  recv: StageStat;
  wire: StageStat;
}

interface TransportExperiment {
  paddingTarget: number;
  arms: TransportArm[];
}

interface Phase3jResults {
  // Item 1 (serialize-once) in-run A/B: same method, same run, back-to-back N.
  encodeLegacy: RpcBreakdown | null; // _benchLegacyEncode:true (before)
  encodeOnce: RpcBreakdown | null; // serialize-once (after)
  // Item 2 (compact payload) in-run A/B.
  compactOff: RpcBreakdown | null; // compact:false (before)
  compactOn: RpcBreakdown | null; // compact:true (after)
  // Item 3 (transport) experiment: adb-forward vs +padding vs redir.
  transport: TransportExperiment;
}

/** N getNestedState round-trips over an EXPLICIT `client`, returning host stats. */
async function measureClientTransport(
  client: AndroidOpenServerClient,
  n: number,
  extraParams: Record<string, unknown> = {}
): Promise<{ rtt: StageStat; recv: StageStat; wire: StageStat }> {
  for (let i = 0; i < 3; i++) await client.request("ping").catch(() => undefined);
  const rtt: number[] = [];
  const recv: number[] = [];
  const wire: number[] = [];
  for (let i = 0; i < n; i++) {
    try {
      const r = await client.requestWithStats("getState", {
        nested: true,
        includeScreenshot: false,
        compact: true,
        maxElements: 3000,
        waitTimeoutMs: 0,
        ...extraParams,
      });
      rtt.push(r.hostRoundTripMs);
      recv.push(r.hostFirstToLastByteMs);
      wire.push(r.wireBytes);
    } catch {
      /* skip */
    }
  }
  return { rtt: stageStat(rtt), recv: stageStat(recv), wire: stageStat(wire) };
}

/**
 * The phase 3j transport experiment (item 3), all in ONE run, N each: (a) the
 * `adb forward` baseline, (b) the emulator-console `redir` path, (c) the padding
 * diagnostic (`_padTo` a full MSS multiple so the reply has no final partial
 * segment). Each arm uses its OWN explicit client so the measurement is
 * independent of whichever transport the blueprint selected as the session default
 * — (a)/(c) dial the adb-forwarded loopback port directly, (b) dials a fresh
 * console `redir` mapping. Comparing the recv gap across the three isolates the
 * ~40 ms host-recv cost's cause.
 */
async function measureTransportExperiment(reg: Reg, n: number): Promise<TransportExperiment> {
  const PAD = 1448;
  const arms: TransportArm[] = [];
  const empty = (): StageStat => stageStat([]);
  const naArm = (label: string, note: string): TransportArm => ({
    label,
    available: false,
    note,
    rtt: empty(),
    recv: empty(),
    wire: empty(),
  });

  let ports: { localPort: number; devicePort: number; allPort?: number } | null = null;
  try {
    const device = resolveDevice(SERIAL);
    const ref = openDeviceServerRef(device);
    const server = await reg.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    ports = server.getTransportPorts();
  } catch (e) {
    arms.push(naArm("adb-forward", `could not resolve open server: ${e instanceof Error ? e.message : String(e)}`));
    return { paddingTarget: PAD, arms };
  }

  // (a) baseline + (c) padding — explicit client on the adb-forwarded loopback port.
  {
    const client = new AndroidOpenServerClient("127.0.0.1", ports.localPort);
    try {
      const a = await measureClientTransport(client, n);
      arms.push({ label: "adb-forward", available: true, note: "baseline (adb server on the last hop)", ...a });
      const c = await measureClientTransport(client, n, { _padTo: PAD });
      arms.push({ label: `adb-forward +pad${PAD}`, available: true, note: "diagnostic: reply padded to a full-MSS multiple (never shipped)", ...c });
    } catch (e) {
      arms.push(naArm("adb-forward", `probe failed: ${e instanceof Error ? e.message : String(e)}`));
    } finally {
      client.close();
    }
  }

  // (b) redir — a fresh console mapping to the guest 0.0.0.0 listener, bypassing
  // adbd + the adb server. Best-effort; any miss records the reason.
  {
    const consolePort = emulatorConsolePort(SERIAL);
    const token = readConsoleAuthToken();
    if (ports.allPort === undefined) {
      arms.push(naArm("redir (emulator console)", "server has no 0.0.0.0 listener (not an emulator bind); redir cannot reach loopback-only"));
    } else if (consolePort === null) {
      arms.push(naArm("redir (emulator console)", `serial ${SERIAL} is not emulator-NNNN`));
    } else if (token === null) {
      arms.push(naArm("redir (emulator console)", "no emulator console auth token"));
    } else {
      let hostPort: number | undefined;
      let client: AndroidOpenServerClient | null = null;
      try {
        hostPort = await freeHostPort();
        await redirAdd(consolePort, hostPort, ports.allPort, token);
        client = new AndroidOpenServerClient("127.0.0.1", hostPort);
        const s = await measureClientTransport(client, n);
        arms.push({ label: "redir (emulator console)", available: true, note: `redir tcp:${hostPort} -> guest 0.0.0.0:${ports.allPort} (bypasses adb server)`, ...s });
      } catch (e) {
        arms.push(naArm("redir (emulator console)", `probe failed: ${e instanceof Error ? e.message : String(e)}`));
      } finally {
        if (client) client.close();
        if (hostPort !== undefined) await redirDel(consolePort, hostPort, token).catch(() => undefined);
      }
    }
  }

  return { paddingTarget: PAD, arms };
}

/** Render the phase 3j serialize-once + compact A/B and transport table for the log. */
function formatPhase3j(p: Phase3jResults): string {
  const lines: string[] = [];
  const cell = (st: StageStat): string =>
    st.p50 === null ? "   -   " : `${String(st.p50).padStart(6)}/${String(st.p95 ?? "?").padStart(6)}`;
  const ab = (title: string, before: RpcBreakdown | null, after: RpcBreakdown | null, keys: Array<[string, (b: RpcBreakdown) => StageStat]>): void => {
    lines.push(`[bench] ${title} (before | after) p50/p95`);
    for (const [k, sel] of keys) {
      const b = before ? cell(sel(before)) : "   -   ";
      const a = after ? cell(sel(after)) : "   -   ";
      lines.push(`[bench]   ${k.padEnd(22)} ${b} | ${a}`);
    }
  };
  ab("3j item1 serialize-once", p.encodeLegacy, p.encodeOnce, [
    ["server handleMs(t3-t2)", (b) => b.serverHandleMs],
    ["server encodeMs", (b) => b.serverEncodeMs],
    ["server writeMs(t4-t3)", (b) => b.serverWriteMs],
    ["server totalMs(t4-t2)", (b) => b.serverTotalMs],
    ["wireBytes", (b) => b.wireBytes],
    ["hostRttMs", (b) => b.hostRttMs],
  ]);
  ab("3j item2 compact", p.compactOff, p.compactOn, [
    ["wireBytes", (b) => b.wireBytes],
    ["server encodeMs", (b) => b.serverEncodeMs],
    ["server handleMs(t3-t2)", (b) => b.serverHandleMs],
    ["hostParseMs", (b) => b.hostParseMs],
    ["hostRecvMs", (b) => b.hostRecvMs],
    ["hostRttMs", (b) => b.hostRttMs],
  ]);
  lines.push(`[bench] 3j item3 transport experiment (pad target ${p.transport.paddingTarget}B) p50/p95`);
  lines.push(`[bench]   ${"arm".padEnd(22)} ${"rttMs".padStart(13)} ${"recvMs".padStart(13)} ${"wireB".padStart(13)}  note`);
  for (const a of p.transport.arms) {
    lines.push(
      `[bench]   ${a.label.padEnd(22)} ${cell(a.rtt)} ${cell(a.recv)} ${cell(a.wire)}  ${a.available ? "" : "N/A: "}${a.note}`
    );
  }
  return lines.join("\n");
}

/**
 * Run the phase 3j in-run A/Bs (serialize-once, compact) and the transport
 * experiment on the idle Settings root, ON only. Each A/B is back-to-back N so the
 * server's piggybacked prevServer* timings are clean.
 */
async function runPhase3j(reg: Reg, n: number): Promise<Phase3jResults> {
  await ensureSettings(reg);
  const encodeLegacy = await measureRpcBreakdown(reg, "3j serialize legacy (before)", n, (s) =>
    s.getNestedState({ waitTimeoutMs: 0, compact: true, _benchLegacyEncode: true }) as Promise<RpcTimedReply>
  );
  const encodeOnce = await measureRpcBreakdown(reg, "3j serialize-once (after)", n, (s) =>
    s.getNestedState({ waitTimeoutMs: 0, compact: true }) as Promise<RpcTimedReply>
  );
  const compactOff = await measureRpcBreakdown(reg, "3j compact off (before)", n, (s) =>
    s.getNestedState({ waitTimeoutMs: 0, compact: false }) as Promise<RpcTimedReply>
  );
  const compactOn = await measureRpcBreakdown(reg, "3j compact on (after)", n, (s) =>
    s.getNestedState({ waitTimeoutMs: 0, compact: true }) as Promise<RpcTimedReply>
  );
  const transport = await measureTransportExperiment(reg, n);
  return { encodeLegacy, encodeOnce, compactOff, compactOn, transport };
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

/* -------------------------------------------------------------------------- */
/* backend-INDEPENDENT effect oracle (phase 3h review A1–A3, fix a)            */
/* An untimed `adb shell uiautomator dump` snapshot, used for the nav-target   */
/* derive and the effect fingerprint, so the OFF (proprietary) block arms the  */
/* effect check with the SAME sensitivity as ON. The timed taps + describes    */
/* still go through the backend under test; only the ORACLE is backend-free.   */
/* -------------------------------------------------------------------------- */

function xmlUnescape(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// Screen size in pixels (from `adb shell wm size`), to normalize uiautomator-dump
// bounds (pixels) to the 0..1 coordinates gesture-tap expects. null if unparseable.
function screenSizePx(): { width: number; height: number } | null {
  let out = "";
  try {
    out = adbShell("wm size", 8_000);
  } catch {
    return null;
  }
  const m = out.match(/Override size:\s*(\d+)x(\d+)/) ?? out.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

// Raw `adb shell uiautomator dump /dev/tty` XML, INDEPENDENT of the backend under
// test. Returns the <hierarchy>…</hierarchy> slice, or "" if no tree was produced.
function dumpUiTree(): string {
  let out = "";
  try {
    out = adbShell("uiautomator dump /dev/tty 2>/dev/null", 12_000);
  } catch {
    return "";
  }
  const start = out.indexOf("<hierarchy");
  const close = "</hierarchy>";
  const end = out.lastIndexOf(close);
  if (start === -1 || end === -1) return "";
  return out.slice(start, end + close.length);
}

// First NAV_CANDIDATE present in the dump (by text or content-desc, prefix match in
// candidate-priority order) with parseable bounds, as a normalized (0..1) tap
// centre. null if none present or the screen size is unknown.
function uiTreeNavTarget(
  xml: string,
  screen: { width: number; height: number }
): { target: string; x: number; y: number } | null {
  const nodes = xml.match(/<node\b[^>]*>/g) ?? [];
  for (const cand of NAV_CANDIDATES) {
    for (const node of nodes) {
      const text = xmlUnescape(node.match(/\btext="((?:[^"\\]|\\.)*)"/)?.[1] ?? "");
      const desc = xmlUnescape(node.match(/\bcontent-desc="((?:[^"\\]|\\.)*)"/)?.[1] ?? "");
      if (!text.startsWith(cand) && !desc.startsWith(cand)) continue;
      const b = node.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!b) continue;
      const l = Number(b[1]);
      const t = Number(b[2]);
      const r = Number(b[3]);
      const bot = Number(b[4]);
      if (r <= l || bot <= t) continue;
      return { target: cand, x: (l + r) / 2 / screen.width, y: (t + bot) / 2 / screen.height };
    }
  }
  return null;
}

// Backend-independent, UiAutomation-free, animation-immune effect fingerprint
// (phase 3h review A2/A3 fix a; run-1 correction). The first cut used
// `uiautomator dump /dev/tty`, which returned NO tree on the CI emulator (dump to a
// tty in non-interactive adb yields nothing), so origin was undefined on 100% of
// iterations (originLost=N, effectChecked=0 — the unarmed gate then fired). The
// resumed activity from `dumpsys activity activities` needs no UiAutomation (so it
// works while EITHER backend holds it), never blocks on idle, and is immune to clock
// / ripple animation: a navigating tap moves the resumed activity from the Settings
// homepage to a sub-page (.SubSettings / a dedicated activity), a no-op tap leaves it
// unchanged. Identical on OFF and ON — it touches neither backend, so the effect
// check has the SAME sensitivity in every block.
function resumedActivityFingerprint(): Promise<string | undefined> {
  return Promise.resolve().then(() => {
    let out = "";
    try {
      out = adbShell("dumpsys activity activities | grep -m1 -E 'mResumedActivity|topResumedActivity'", 8_000);
    } catch {
      out = "";
    }
    let m = out.match(/([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/);
    if (m) return "act:" + m[1];
    // Fallback: the focused window's activity component (still backend-independent).
    try {
      const w = adbShell("dumpsys window | grep -m1 mCurrentFocus", 8_000);
      const wm = w.match(/([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/);
      if (wm) return "win:" + wm[1];
    } catch {
      /* fall through */
    }
    return undefined;
  });
}

// Derive a deterministic navigating tap TARGET and the destination-only marker
// set (labels on the fully-settled destination but NOT on the root). Phase 3h
// review A1–A3 (fix a): the target is derived PRIMARILY from an untimed, backend-
// INDEPENDENT `adb uiautomator dump` so the OFF (proprietary) block arms the effect
// check just like ON — the describe-based pick remains only as a fallback for the
// rare case the dump yields no tree. The MARKERS still come from the backend
// describe, because the staleness probe deliberately measures the backend's own
// rendering. The whole derive retries 3× with a full reset between attempts: a
// single flaky read must NOT silently disarm the entire block. `settleForDerive`
// picks the describe policy for the settled-destination marker read (true on ON so
// the markers are complete; undefined on OFF where `settle` is a no-op).
async function deriveNavTarget(
  reg: Reg,
  settleForDerive: boolean | undefined
): Promise<{ target: string; x: number; y: number; markers: string[] } | null> {
  const lineLabel = (l: string): string | undefined =>
    l.match(/(?<![=\w])"((?:[^"\\]|\\.)*)"/)?.[1];
  for (let attempt = 0; attempt < 3; attempt++) {
    await ensureSettings(reg);
    // Root labels for the markers come from the backend describe (the staleness
    // probe measures the backend); a failure here is retryable, not fatal.
    let rootLabels: Set<string>;
    let rootLines: string[];
    try {
      const root = (await reg.invokeTool("describe", { udid: SERIAL })) as { description: string };
      rootLabels = labelSetOf(root.description);
      rootLines = root.description.split("\n");
    } catch {
      continue;
    }
    // PRIMARY target: backend-independent uiautomator dump → normalized centre.
    let picked: { target: string; x: number; y: number } | null = null;
    const screen = screenSizePx();
    if (screen) {
      const xml = dumpUiTree();
      if (xml) picked = uiTreeNavTarget(xml, screen);
    }
    // FALLBACK target: the old backend-describe pick (concatenated row label
    // prefix), used only when the dump produced nothing.
    if (!picked) {
      for (const cand of NAV_CANDIDATES) {
        const line = rootLines.find((l) => {
          const label = lineLabel(l);
          return !!label && label.startsWith(cand) && !!frameCenterOf(l);
        });
        if (line) {
          const c = frameCenterOf(line)!;
          picked = { target: cand, x: c.x, y: c.y };
          break;
        }
      }
    }
    if (!picked) continue;
    await reg
      .invokeTool("gesture-tap", { udid: SERIAL, x: picked.x, y: picked.y })
      .catch(() => undefined);
    await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 }).catch(() => undefined);
    let destLabels: Set<string>;
    try {
      const dest = (await reg.invokeTool("describe", {
        udid: SERIAL,
        ...(settleForDerive === undefined ? {} : { settle: settleForDerive }),
      })) as { description: string };
      destLabels = labelSetOf(dest.description);
    } catch {
      await ensureSettings(reg);
      continue;
    }
    const markers = [...destLabels].filter((l) => !rootLabels.has(l));
    await ensureSettings(reg);
    return { target: picked.target, x: picked.x, y: picked.y, markers };
  }
  return null;
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
    await relaunchSettings(reg); // light reset (no pm clear) — this loop runs N×2 on ON
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
  // path (no split surfaced). Carries the phase 3i host split + wire bytes.
  describeSplitIdle: DescribeSplit;
  describeSplitAfterTap: DescribeSplit;
  // Raw RPC round-trip floor (phase 3i): `getState`-free `ping` p50/p95 over
  // `adb forward`. ~1 ms confirms the transport itself is cheap and the idle
  // describe residual is payload/serialize, not the socket. null on OFF blocks
  // (no open server) or if the ping probe could not run.
  pingP50: number | null;
  pingP95: number | null;
  pingN: number;
  // Back-to-back end-to-end RPC decompositions (phase 3i): getNestedState (the
  // describe path, ~31 KB text) and getState+screenshot (JPEG-heavy), so the 5-point
  // timeline shows whether the residual is per-byte or per-request. Empty on OFF.
  rpcBreakdowns: RpcBreakdown[];
  // Phase 3j: serialize-once + compact in-run A/B and the transport experiment
  // (adb-forward vs redir vs padding). ON only; undefined on OFF blocks.
  phase3j?: Phase3jResults;
  // Per-describe adb-spawn cost the form-factor check used to pay (phase 3i #1):
  // before = old `isAndroidTv` (adb devices + getprop every call), after ≈ 0 =
  // `isAndroidTvCached`. Both configs.
  adbFormFactorBeforeP50: number | null;
  adbFormFactorBeforeP95: number | null;
  adbFormFactorAfterP50: number | null;
  adbFormFactorN: number;
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
  // Total effect-checked tap iterations (clean origin + completed tap), and total
  // originLost iterations (origin could not be restored after a tap → hard-reset,
  // excluded from effectChecked) — so a high effectZero can be read against how many
  // taps were actually evaluated.
  effectCheckedTotal: number;
  originLostTotal: number;
  // Phase 3j item 3d (fix h): the host↔device transport this block's open path used
  // — "redir" on the CI emulator once the redir client pings, else "adb-forward";
  // "n/a (proprietary)" on the OFF blocks (no open server). Printed per block.
  transport: string | null;
  // Phase 3h review A1 (fix b): reasons this block's OFF arm was DEGRADED (not merely
  // unarmed) — await-screen-idle / await-ui-element capped on every iteration, or the
  // paste search field never found. Non-empty ⇒ the merge fails the block.
  degradedReasons: string[];
  notes: string[];
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
  // Transport used by the open path this block (fix h). On ON it is the describe
  // metadata ("redir" on the CI emulator, else "adb-forward"); the proprietary
  // (OFF) path has no open server, so it is reported n/a. Physical devices would
  // stay loopback + adb-forward (redir is gated to emulators on-device).
  const lastTransport =
    config === "ON" ? (clean.transport ?? "adb-forward (metadata absent)") : "n/a (proprietary)";

  // describe latency AND its decomposition from the SAME N back-to-back idle
  // describes (phase 3i correction): the verb p50/p95 and the stage + host/server
  // timeline table are now one sample, not a latency loop minus a separate
  // Math.min(N,10) split loop with untimed setup between calls.
  const idle = await describeIdleLatencyWithStages(reg, "describe", N);
  const describeRes = idle.verb;
  const describeSplitIdle = idle.split;
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

  // Raw RPC round-trip floor (phase 3i). Only the open server answers `ping`, so
  // this is an ON-only probe; OFF blocks report nulls.
  const ping =
    config === "ON"
      ? await measurePing(reg, N)
      : { p50: null, p95: null, n: 0 };

  // Per-describe adb-spawn cost the form-factor check used to pay (phase 3i #1),
  // measured on both configs.
  const adbFF = await measureAdbFormFactorCost(Math.min(N, 12));
  realDebug(
    `[bench] ${config} adb form-factor cost before/after p50=${
      adbFF.beforeP50 === null ? "-" : adbFF.beforeP50.toFixed(2)
    }/${adbFF.afterP50 === null ? "-" : adbFF.afterP50.toFixed(2)} ms (before p95=${
      adbFF.beforeP95 === null ? "-" : adbFF.beforeP95.toFixed(2)
    }, n=${adbFF.n})`
  );

  // Back-to-back RPC decompositions (phase 3i), ON only, on the idle Settings root.
  // getNestedState = the describe path (big nested text, no screenshot);
  // getState+screenshot = a JPEG-heavy payload. Comparing the 5-point timeline of
  // the two (and vs ping) shows whether the residual scales per-byte or is a fixed
  // per-request cost. Back-to-back so the piggybacked prevServer* is clean.
  const rpcBreakdowns: RpcBreakdown[] = [];
  let phase3j: Phase3jResults | undefined;
  if (config === "ON") {
    await ensureSettings(reg);
    const nested = await measureRpcBreakdown(reg, "getNestedState (describe path)", N, (s) =>
      s.getNestedState({ waitTimeoutMs: 0 }) as Promise<RpcTimedReply>
    );
    if (nested) {
      rpcBreakdowns.push(nested);
      realDebug(formatRpcBreakdown(nested));
    }
    const withShot = await measureRpcBreakdown(reg, "getState +screenshot", N, (s) =>
      s.getState({ waitTimeoutMs: 0, includeScreenshot: true }) as Promise<RpcTimedReply>
    );
    if (withShot) {
      rpcBreakdowns.push(withShot);
      realDebug(formatRpcBreakdown(withShot));
    }
    // Capture ONE real nested reply into the artifact (phase 3i #7), in the exact
    // HostBenchFixture shape, so the next phase can commit a real fixture in place
    // of the synthetic one. ON-uiautomation only (the plain describe path).
    if (!fastInject) {
      try {
        const device = resolveDevice(SERIAL);
        const ref = openDeviceServerRef(device);
        const server = await reg.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
        const state = (await server.getNestedState({ waitTimeoutMs: 0 })) as {
          tree: unknown;
          info: { screenWidth: number; screenHeight: number };
          wireBytes?: number;
        };
        const capturePath = join(OUT_DIR, "real-nested-reply.json");
        writeFileSync(
          capturePath,
          JSON.stringify(
            {
              description:
                "Real idle-Settings nested reply captured by the CI latency bench (phase 3i). " +
                "Drop-in HostBenchFixture for bench-describe-host — replaces the synthetic fixture.",
              screen: { width: state.info.screenWidth, height: state.info.screenHeight },
              tree: state.tree,
            },
            null,
            2
          ) + "\n"
        );
        realDebug(`[bench] captured real nested reply -> ${capturePath} (wireBytes=${state.wireBytes ?? "?"})`);
      } catch (e) {
        realDebug(`[bench] real nested-reply capture skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Phase 3j: serialize-once + compact in-run A/B, and the transport experiment.
    // Off by default (keeps routine runs ~1 h); enable with BENCH_PHASE3J_EXPERIMENT=1.
    if (PHASE3J_EXPERIMENT) {
      try {
        phase3j = await runPhase3j(reg, N);
        realDebug(formatPhase3j(phase3j));
      } catch (e) {
        realDebug(`[bench] phase3j experiment skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      realDebug("[bench] phase3j experiment OFF (set BENCH_PHASE3J_EXPERIMENT=1 to run it)");
    }
  }

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
  const canEffect = !!nav;
  // Effect fingerprint = the BACKEND-INDEPENDENT resumed activity (fix a; run-1
  // correction — the uiautomator-dump oracle produced no tree on the CI emulator).
  // A navigating tap changes the resumed activity, a no-op tap leaves it identical;
  // it touches neither backend, so OFF and ON have identical sensitivity. Origin
  // restore = a system BACK keyevent (adb, not the backend), hard-reset = ensureSettings.
  const fingerprint = (): Promise<string | undefined> => resumedActivityFingerprint();
  // Light reset (no pm clear) for the tap loop — fast enough to run per originLost.
  const ensureOrigin = async (): Promise<void> => {
    await relaunchSettings(reg);
  };
  const restoreBack = async (): Promise<void> => {
    adbShell("input keyevent KEYCODE_BACK", 5000);
  };
  if (!nav) {
    notes.push(
      "effect-check: no navigating target could be derived on this root — gesture-tap / " +
        "tap+describe ran on (0.5, 0.5) WITHOUT an effect check this block"
    );
  }
  await ensureSettings(reg);

  // gesture-tap. Latency = the tap RPC ONLY; the effect check (timing-independent
  // poll for a screen change up to 3 s, then BACK to restore the origin) is OUTSIDE
  // the timed window (phase 3h). effectZero counts taps that NEVER changed the
  // screen; the block fails on effectZero > 0 in the merge.
  const gestureTapRpc = async (): Promise<void> => {
    await reg.invokeTool("gesture-tap", { udid: SERIAL, x: tapX, y: tapY });
  };
  verbs.push(
    canEffect
      ? await timeTapEffect("gesture-tap", gestureTapRpc, fingerprint, ensureOrigin, restoreBack)
      : await timeCalls("gesture-tap", gestureTapRpc, undefined, ensureOrigin)
  );

  await ensureSettings(reg);

  // tap+describe (F4 / P3d): what an agent actually does (act, then read). TIMED
  // window = tap RPC + describe RPC; the effect poll + BACK restore are outside it.
  // ON runs both idle policies (settle:false like-for-like, settle:true our policy);
  // OFF has one policy.
  const tapThenDescribe = (settle?: boolean) => async (): Promise<void> => {
    await reg.invokeTool("gesture-tap", { udid: SERIAL, x: tapX, y: tapY });
    await reg.invokeTool("describe", {
      udid: SERIAL,
      ...(settle === undefined ? {} : { settle }),
    });
  };
  const runTapDescribe = (name: string, settle?: boolean): Promise<VerbResult> =>
    canEffect
      ? timeTapEffect(name, tapThenDescribe(settle), fingerprint, ensureOrigin, restoreBack)
      : timeCalls(name, tapThenDescribe(settle), undefined, ensureOrigin);
  if (config === "ON") {
    verbs.push(await runTapDescribe("tap+describe(settle:false)", false));
    await ensureSettings(reg);
    verbs.push(await runTapDescribe("tap+describe(settle:true)", true));
  } else {
    verbs.push(await runTapDescribe("tap+describe", undefined));
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
  if (config === "ON") {
    realDebug(
      `[bench] ${config} ping p50/p95=${ping.p50 === null ? "-" : ping.p50.toFixed(2)}/${
        ping.p95 === null ? "-" : ping.p95.toFixed(2)
      } ms (n=${ping.n})`
    );
  }

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
  const originLostTotal = verbs.reduce((s, v) => s + (v.originLost ?? 0), 0);
  notes.push(
    `effect-check: ${effectZeroTotal} no-effect tap iteration(s) of ${effectCheckedTotal} checked ` +
      `(originLost=${originLostTotal}, target=${nav ? nav.target : "none"}); tap backend=${injectBackend}`
  );
  // flushInput asymmetry (fix c, review A2): only the scrcpy branch defers the input
  // drain to the next read; the UiAutomation/proprietary tap RPC drains inline. So
  // gesture-tap (the tap-RPC row) is NOT like-for-like across backends — the
  // like-for-like tap row is tap+describe(settle:false), which pays the drain in
  // every block. The fold itself is unchanged in this ticket.
  notes.push(
    "tap-RPC row (gesture-tap) carries the flushInput asymmetry: scrcpy defers the input " +
      "drain to the next read, UiAutomation/proprietary drain inline — headline like-for-like " +
      "tap row is tap+describe(settle:false)"
  );

  // Degraded-arm detection (fix b, review A1): a block whose await-screen-idle /
  // await-ui-element hit the 4000 ms cap on EVERY iteration, or whose paste never
  // found the search field, was on the WRONG screen for part of the block — its rows
  // are not a valid baseline. Surface the reasons; the merge FAILS such a block.
  const CAP_MS = 4000;
  const degradedReasons: string[] = [];
  const idleVerb = verbs.find((v) => v.verb === "await-screen-idle");
  if (idleVerb && idleVerb.latency.n > 0 && idleVerb.latency.min >= CAP_MS - 100) {
    degradedReasons.push(
      `await-screen-idle hit the ${CAP_MS}ms cap on every iteration (min=${idleVerb.latency.min}ms)`
    );
  }
  const elemVerb = verbs.find((v) => v.verb === "await-ui-element");
  if (elemVerb && elemVerb.latency.n > 0 && elemVerb.latency.min >= CAP_MS - 100) {
    degradedReasons.push(
      `await-ui-element hit the ${CAP_MS}ms cap on every iteration (min=${elemVerb.latency.min}ms, ` +
        `selector=${String(elemVerb.extra?.selector ?? "?")})`
    );
  }
  if (!pasteReady) {
    degradedReasons.push("paste could not locate the Settings search field (measured on the wrong focus)");
  }
  for (const r of degradedReasons) notes.push(`DEGRADED ARM: ${r}`);
  realDebug(`[bench] ${block} transport=${lastTransport} degradedReasons=${JSON.stringify(degradedReasons)}`);

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
    effectCheckedTotal,
    originLostTotal,
    describeSplitIdle,
    describeSplitAfterTap,
    pingP50: ping.p50,
    pingP95: ping.p95,
    pingN: ping.n,
    rpcBreakdowns,
    ...(phase3j ? { phase3j } : {}),
    adbFormFactorBeforeP50: adbFF.beforeP50,
    adbFormFactorBeforeP95: adbFF.beforeP95,
    adbFormFactorAfterP50: adbFF.afterP50,
    adbFormFactorN: adbFF.n,
    destinationVisible,
    transport: lastTransport,
    degradedReasons,
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
        `effectZero=${r.effectZeroTotal}/${r.effectCheckedTotal} originLost=${r.originLostTotal} ` +
        `tapFrames=${r.injectedTapTimeline.frameCount}(move=${r.injectedTapTimeline.hasMoveFrame})`
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
    // NOTE: under BENCH_ONLY the block does NOT throw on effectZero > 0 — every
    // block must run and write its JSON so the merge can report ALL four per-block
    // counts and fail at the END (ON fatal, OFF tolerated). A per-block throw here
    // aborted the CI step at the first failing block and hid the ON-scrcpy A/B.
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
