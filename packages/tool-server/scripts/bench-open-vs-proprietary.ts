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
 * (b) captures the tool-server's fallback lines (`console.debug`, `console.warn`,
 * `console.error`) and counts empty describes inside timed samples, and (c) checks
 * the simulator-server host process — so a masked fallback is visible in the
 * output rather than silently scored as the wrong backend.
 *
 * The UiAutomation channel is exclusive AND exclusive between the ADT apk and
 * the open server: blocks alternate OFF and ON (ABBA since run 37591260027: OFF-1,
 * ON-im-1, ON-uia, OFF-2, ON-im-2, OFF-3, ON-im-3, OFF-legacy), force-stopping the other
 * instrumentation + killing simulator-server between blocks.
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
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { createRegistry } from "../src/utils/setup-registry";
import { setFlag, unsetFlag } from "@argent/configuration-core";
import { resolveDevice } from "../src/utils/device-info";
import { isAndroidTv, isAndroidTvCached } from "../src/utils/adb";
import {
  openDeviceServerRef,
  takeOpenServerWarmup,
  type OpenDeviceServerApi,
  type OpenInjectStrategy,
} from "../src/blueprints/android-open-server";
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
import { summarize } from "../../../.github/bench-ci/stats.js";
import {
  TTC_POLL_MS,
  TTC_BUDGET_MS,
  classifyDestination,
  deriveDestinationMarkers,
  summarizeDestination,
  tdVariantsFor,
  variantCounts,
  variantSchedule,
} from "../../../.github/bench-ci/tap-describe-destination.js";
import { MARKER_TAG, markerMessage } from "../../../.github/bench-ci/logcat-timeline.js";
import {
  PROBE_CMD as SETTINGS_PROBE_CMD,
  RELAUNCH_CMD as SETTINGS_RELAUNCH_CMD,
  CLEAR_KILL_GUARD_MS,
  waitSettingsReady,
} from "../../../.github/bench-ci/settings-reset.js";
import { openServerEmptyTreeCount } from "../src/tools/describe/platforms/android/index";
import { simulatorServerRef } from "../src/blueprints/simulator-server";
import { describeAndroidViaOpenState } from "../src/utils/open-server-describe";
import {
  setOpenServerTapTiming,
  takeOpenServerTapStages,
  type OpenServerTapStages,
} from "../src/utils/open-server-input";
import {
  HOST_AWAIT,
  hostAwaitIdle,
  hostAwaitSignature,
} from "../../../.github/bench-ci/block-arms.js";
import { statTicks } from "../../../.github/bench-ci/load-sampler.js";

/* -------------------------------------------------------------------------- */
/* Config + guards                                                           */
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

// Run 37591260027 ("Next run", ABBA): the ON-only diagnostic phases run in these blocks
// only. ON-im-1 in the ABBA design; the pre-ABBA single ON blocks keep them.
const ON_DIAGNOSTIC_BLOCKS = new Set(["ON-im-1", "ON-input-manager", "ON-uiautomation"]);

// Review run 37609765062 (Part A findings 5 and 6, "Follow-ups" 1): two diagnostic arms,
// one block each, report only (.github/bench-ci/block-arms.js).
//  - ON-im-bg: an ON-im block with the proprietary `simulator-server android --id <serial>`
//    spawned idle for the whole block (the PROBE-BG window B spawn, no calls; its screen
//    stream opens at spawn), killed at the end. Does the stream make the guest slower?
//  - ON-hostawait: an ON-im block whose tap → await-idle → describe await and the timed
//    await-screen-idle verb run the tool's HOST algorithm (block-arms.js hostAwaitIdle:
//    poll every 200 ms, 250 ms stable window, the tool's timeout and tree-equality rule)
//    over open-server state reads (describeAndroidViaOpenState, the read the tool's poll
//    path makes on ON), instead of the on-device AX-event await. Same ON stack, only the
//    algorithm changes: what does the await algorithm alone buy? It replaced OFF-devawait
//    (review round 1: the open server next to the proprietary helper is a second
//    UiAutomation client on one emulator).
const BG_SIMSERVER_BLOCKS = new Set(["ON-im-bg"]);
const HOST_AWAIT_BLOCKS = new Set(["ON-hostawait"]);

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
/* logcat markers + phase context (review 2026-10-07 run 37591260027)          */
/* -------------------------------------------------------------------------- */

// The block being measured (markers and the phase context name it).
let currentBlock = "?";

// Finding 1 / "Next run": a logcat marker at each timed t0, `log -t BENCH "<block> <verb>
// <i> t0"` (logcat-timeline.js markerMessage), so the merge can align the tap with the
// destination's first frame and the end of its transition. Written synchronously just
// before t0 is taken, never inside the timed window, the same call on every arm. A
// failed marker is logged once and never fails the block.
let markerFailed = false;
function benchMarker(verb: string, i: number): void {
  try {
    adb(["shell", "log", "-t", MARKER_TAG, `'${markerMessage(currentBlock, verb, i)}'`], 5_000);
  } catch (e) {
    if (!markerFailed)
      realDebug(
        `[bench] logcat marker failed (timeline will miss samples): ${e instanceof Error ? e.message : String(e)}`
      );
    markerFailed = true;
  }
}

// Finding 1: the load sampler (.github/bench-ci/load-sampler.js) attributes each 10 s
// interval to the phase written here (`block <name> phase <phase>`, the context file the
// emulator watchdog also reads).
function setPhase(phase: string): void {
  const f = process.env.BENCH_CONTEXT_FILE;
  if (!f) return;
  try {
    writeFileSync(f, `block ${currentBlock} phase ${phase}\n`);
  } catch {
    /* diagnostics only */
  }
}

/* -------------------------------------------------------------------------- */
/* console capture (the tool-server logs fallbacks at debug, warn and error)  */
/* -------------------------------------------------------------------------- */

const debugLines: string[] = [];
const realDebug = console.debug.bind(console);
const realWarn = console.warn.bind(console);
const realError = console.error.bind(console);
const logLine = (a: unknown[]): string =>
  a
    .map((x) =>
      typeof x === "string" ? x : x instanceof Error ? `${x.name}: ${x.message}` : JSON.stringify(x)
    )
    .join(" ");
console.debug = (...a: unknown[]): void => {
  debugLines.push(logLine(a));
};
// Run 37561512651 (Review 2026-10-07): since PR #20 the open describe path logs its
// fallback (`[describe.android] open-device-server failed, falling back: …`) and its
// empty-tree line at console.warn, so a debug-only hook read 0 fallbacks for them.
// warn and error lines are captured for the counter AND still printed.
console.warn = (...a: unknown[]): void => {
  debugLines.push(logLine(a));
  realWarn(...a);
};
console.error = (...a: unknown[]): void => {
  debugLines.push(logLine(a));
  realError(...a);
};
// Host-side open-server fallback log counter. Review 2026-10-07 finding 3: the old
// pattern only matched `[open-server-fast-inject] … falling back`, whose emitter was
// removed in phase 3n.2, so it always read 0 while gesture-tap/swipe/pinch,
// await-screen-idle, describe, paste … each log
// `[<tool>] open-device-server … failed, falling back …` when they leave the open
// path. Count every such line. Not counted: the proprietary path's own
// "[describe.android] devtools service failed, falling back to uiautomator dump"
// (OFF-only) and the open path's tier retries ("[describe.android.tier] …"), which
// never name the open device server. The open path's empty-tree warn line ("returned an
// empty accessibility tree … no other backend") is not a fallback and does not match;
// empty trees are counted from the describe result instead (`treeEmpty`).
const OPEN_SERVER_FALLBACK = /\bopen[- ](?:ios-)?device-server\b.*\bfalling back\b/i;
function fallbackCountSince(mark: number): { count: number; samples: string[] } {
  const slice = debugLines.slice(mark);
  const hits = slice.filter((l) => OPEN_SERVER_FALLBACK.test(l));
  return { count: hits.length, samples: hits.slice(0, 3) };
}

/* -------------------------------------------------------------------------- */
/* empty describes (run 37561512651, Review 2026-10-07)                        */
/* -------------------------------------------------------------------------- */

// Every `describe` the block's registry returns is checked: ON = the open server's
// `treeEmpty` marker (PR #20), OFF = the equivalent, a describe with 0 elements under
// ROOT. The rule is the same for both arms (either condition counts on either arm). The
// timing helpers compare the counters before and after each timed window, so a timed
// sample that read an empty screen is counted on its verb (`treeEmpty`); untimed
// describes only count toward the block total.
//
// Run 37571460849: every empty timed sample (ON tap+describe(settle:false) 23/40 and
// 12/40, OFF tap+describe 9/40 and 10/40) carried treeEmpty=false with 0 elements: a
// window was there, but the destination screen had nothing to describe yet (the
// SubSettings transition). Empty windows no longer fail the block: they are dropped
// from the verb's latency on both arms (`emptyLatencySamples` keeps them), and the
// verb publishes `treeEmpty` out of `describeWindows` (timed windows that read a
// describe), graded by P11 in the merge.
let emptyDescribeCount = 0;
let describeCount = 0;
let lastEmptyDescribe = "";
function isEmptyDescribe(r: unknown): boolean {
  if (!r || typeof r !== "object") return false;
  const d = r as { description?: unknown; treeEmpty?: unknown };
  const elements =
    typeof d.description === "string" ? parseDescribe(d.description).elements : undefined;
  return d.treeEmpty === true || elements === 0;
}
function noteDescribeResult(r: unknown): void {
  if (!r || typeof r !== "object") return;
  describeCount++;
  if (!isEmptyDescribe(r)) return;
  const d = r as { description?: unknown; treeEmpty?: unknown; treeEmptyReason?: unknown };
  const elements =
    typeof d.description === "string" ? parseDescribe(d.description).elements : undefined;
  emptyDescribeCount++;
  lastEmptyDescribe =
    `treeEmpty=${d.treeEmpty === true}` +
    (typeof d.treeEmptyReason === "string" ? ` reason=${d.treeEmptyReason}` : "") +
    ` elements=${elements ?? "?"}`;
}
// Per-verb accumulator: timed windows that read a describe, and how many of them read
// at least one empty describe.
interface EmptyAcc {
  count: number;
  describeWindows: number;
  samples: string[];
}
const newEmptyAcc = (): EmptyAcc => ({ count: 0, describeWindows: 0, samples: [] });
interface WindowMark {
  empty: number;
  describes: number;
}
const windowMark = (): WindowMark => ({ empty: emptyDescribeCount, describes: describeCount });
/** Close one timed window: count it; returns true when it read an empty describe. */
function noteTimedEmpty(acc: EmptyAcc, mark: WindowMark, label: string, i: number): boolean {
  if (describeCount > mark.describes) acc.describeWindows++;
  if (emptyDescribeCount === mark.empty) return false;
  acc.count++;
  const s = `i=${i} verb='${label}' emptyDescribes=${emptyDescribeCount - mark.empty} ${lastEmptyDescribe}`;
  if (acc.samples.length < 5) acc.samples.push(s);
  realDebug(`[bench][tree-empty] ${s}`);
  return true;
}

// Time to a correct describe (run 37578606526, review finding 12; extends the run
// 37571460849 time-to-non-empty loop). Every timed tap+describe read is classified
// (correct / pre-transition / empty / other, .github/bench-ci/tap-describe-destination.js). When
// the timed read is correct, its time-to-correct is the timed latency itself. Otherwise
// one untimed describe loop (the same call, TTC_POLL_MS apart, up to TTC_BUDGET_MS after
// the timed read) runs until a read is correct, on EVERY sample, not only after an empty
// one. The loop's first non-empty read also gives the old time-to-non-empty for the
// samples whose timed read was empty. Same loop on every arm.
interface TtneSample {
  fromTapMs: number | null;
  afterEmptyMs: number | null;
  polls: number;
}
interface TtcSample {
  // The variant's loop iteration (the index in its BENCH logcat marker).
  i: number;
  cls: DestinationClass;
  latencyMs: number;
  ttcMs: number | null;
  censoredAtMs: number | null;
  polls: number;
  // Only when the timed read was empty: the first non-empty read of the loop.
  ttne: TtneSample | null;
}
type DestinationClass = "correct" | "preTransition" | "empty" | "other";
interface DestinationMarkers {
  dest: string[];
  root: string[];
  valid: boolean;
}
async function measureTimeToCorrect(
  describe: () => Promise<unknown>,
  markers: DestinationMarkers,
  timed: unknown,
  t0: number,
  timedEnd: number,
  i: number
): Promise<TtcSample> {
  const latencyMs = Number((timedEnd - t0).toFixed(3));
  const cls = classifyDestination(timed, markers) as DestinationClass;
  if (cls === "correct")
    return { i, cls, latencyMs, ttcMs: latencyMs, censoredAtMs: null, polls: 0, ttne: null };
  const wasEmpty = cls === "empty";
  let ttne: TtneSample | null = null;
  let polls = 0;
  for (;;) {
    const r = await describe().catch(() => undefined);
    polls++;
    const now = performance.now();
    const c = classifyDestination(r, markers);
    if (wasEmpty && ttne === null && c !== "empty" && r !== undefined)
      ttne = {
        fromTapMs: Number((now - t0).toFixed(3)),
        afterEmptyMs: Number((now - timedEnd).toFixed(3)),
        polls,
      };
    if (c === "correct")
      return {
        i,
        cls,
        latencyMs,
        ttcMs: Number((now - t0).toFixed(3)),
        censoredAtMs: null,
        polls,
        ttne: wasEmpty ? ttne : null,
      };
    if (now - timedEnd >= TTC_BUDGET_MS)
      return {
        i,
        cls,
        latencyMs,
        ttcMs: null,
        censoredAtMs: Number((now - t0).toFixed(3)),
        polls,
        ttne: wasEmpty ? (ttne ?? { fromTapMs: null, afterEmptyMs: null, polls }) : null,
      };
    await sleep(TTC_POLL_MS);
  }
}
interface TtneSummary {
  measured: number;
  reached: number;
  timedOut: number;
  fromTapMs: ReturnType<typeof summarize> | null;
  afterEmptyMs: ReturnType<typeof summarize> | null;
  fromTapSamples: (number | null)[];
  afterEmptySamples: (number | null)[];
  polls: number[];
}
function summarizeTtne(xs: TtneSample[]): TtneSummary {
  const from = xs.map((x) => x.fromTapMs).filter((x): x is number => x !== null);
  const after = xs.map((x) => x.afterEmptyMs).filter((x): x is number => x !== null);
  return {
    measured: xs.length,
    reached: from.length,
    timedOut: xs.length - from.length,
    fromTapMs: from.length ? summarize(from) : null,
    afterEmptyMs: after.length ? summarize(after) : null,
    fromTapSamples: xs.map((x) => x.fromTapMs),
    afterEmptySamples: xs.map((x) => x.afterEmptyMs),
    polls: xs.map((x) => x.polls),
  };
}

/* -------------------------------------------------------------------------- */
/* Settings reset readiness (run 37561512651, Review 2026-10-07)               */
/* -------------------------------------------------------------------------- */

// After force-stop (+ pm clear) + am start, the system's delayed "remove task" kill
// can fire ~0.35 s later and kill the NEW Settings process before its first frame;
// the next timed call then reads no active window. Every Settings reset now waits
// (.github/bench-ci/settings-reset.js) until Settings is resumed, focused, not
// finishing and on a stable pid, relaunching it if it was killed, bounded at 5 s. The
// same wait runs in every block. Each wait is logged (`resetWaitMs`, measured from the
// am start) and summarised per block (`resetWait`).
//
// Run 37571460849: the relaunch force-stops before am start (SETTINGS_RELAUNCH_CMD), so
// a resumed record whose process was killed no longer swallows the intent (every
// relaunch in that run was "delivered to the top-most instance" and started nothing),
// and each wait's decision reasons are summed per block (`resetWait.reasons`).
interface ResetWaitRecord {
  waitMs: number;
  ok: boolean;
  relaunches: number;
  polls: number;
  last: string;
  reasons: Record<string, number>;
}
const resetLog: ResetWaitRecord[] = [];
async function awaitSettingsReady(startedAt: number): Promise<ResetWaitRecord> {
  const r = await waitSettingsReady({
    startedAt,
    now: () => performance.now(),
    sleep,
    probe: () => {
      try {
        return adbShell(SETTINGS_PROBE_CMD, 8_000);
      } catch {
        return "";
      }
    },
    relaunch: () => {
      try {
        return adbShell(SETTINGS_RELAUNCH_CMD, 8_000);
      } catch {
        /* the next probe sees it is still gone */
        return "Error: relaunch adb call failed";
      }
    },
  });
  // waitMs from the FIRST am start (includes any relaunch), so it is the full reset cost.
  const rec: ResetWaitRecord = {
    waitMs: Number((performance.now() - startedAt).toFixed(3)),
    ok: r.ok,
    relaunches: r.relaunches,
    polls: r.polls,
    last: r.last,
    reasons: r.reasons,
  };
  resetLog.push(rec);
  if (!rec.ok || rec.relaunches > 0)
    realDebug(
      `[bench][reset] resetWaitMs=${rec.waitMs} ok=${rec.ok} relaunches=${rec.relaunches} ` +
        `polls=${rec.polls} last: ${rec.last} reasons=${JSON.stringify(rec.reasons)}`
    );
  return rec;
}
// Sum of the reset waits logged since `mark` (null when the setup did not reset).
function resetWaitSince(mark: number): number | null {
  const xs = resetLog.slice(mark);
  return xs.length ? Number(xs.reduce((s, x) => s + x.waitMs, 0).toFixed(3)) : null;
}

/* -------------------------------------------------------------------------- */
/* stats + estimators                                                          */
/* -------------------------------------------------------------------------- */

// Review 2026-10-07 finding 4: p50/p95 come from the SAME quantile the merge and the
// scoreboard bootstrap use (.github/bench-ci/stats.js, linear interpolation; p50 is the
// true median, the old local pct() returned the lower-middle value). Every timed window
// is performance.now(), kept as float ms rounded to 1 µs (`elapsedMs`); Date.now()
// remains only for poll deadlines.
const elapsedMs = (t0: number): number => Number((performance.now() - t0).toFixed(3));
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

// ON-im-bg (review run 37609765062): the idle simulator-server held for the whole block.
// While it is held, the teardowns inside the block (cold start, setup, end) leave it alone.
let idleSimServer: { reg: Reg; record: IdleSimServerRecord } | null = null;
interface IdleSimServerRecord {
  spawned: boolean;
  pids: number[];
  spawnMs: number;
  aliveAtEnd: boolean | null;
}

function killSimServerForEmulator(): void {
  if (idleSimServer) return;
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

// ON-im-bg: spawn `simulator-server android --id <serial>` the way PROBE-BG window B does
// (and a headless agent's first gesture): resolve the SimulatorServer service through its
// own registry, then no call at all. Needs ARGENT_SIMULATOR_SERVER_DIR (the workflow sets
// only that dir for this block). Throws when no process is alive after the spawn, so the
// block fails instead of measuring plain ON-im under the bg name.
async function spawnIdleSimServer(): Promise<void> {
  const reg = createRegistry();
  const t0 = performance.now();
  const device = resolveDevice(SERIAL);
  const ref = simulatorServerRef(device);
  await reg.resolveService(ref.urn, ref.options);
  await sleep(2000);
  const pids = pidsOf(`simulator-server .*android --id ${SERIAL}`);
  if (!pids.length) {
    await reg.dispose().catch(() => undefined);
    throw new Error("ON-im-bg: no simulator-server process alive after the idle spawn");
  }
  idleSimServer = {
    reg,
    record: {
      spawned: true,
      pids,
      spawnMs: Number((performance.now() - t0).toFixed(1)),
      aliveAtEnd: null,
    },
  };
  realDebug(`[bench] ${currentBlock} idle simulator-server spawned (pids ${pids.join(",")})`);
}

// ON-im-bg: release and kill the idle simulator-server at the end of the block.
async function stopIdleSimServer(): Promise<IdleSimServerRecord | null> {
  const held = idleSimServer;
  if (!held) return null;
  const alive = pidsOf(`simulator-server .*android --id ${SERIAL}`);
  held.record.aliveAtEnd = held.record.pids.some((p) => alive.includes(p));
  idleSimServer = null;
  await held.reg.dispose().catch(() => undefined);
  killSimServerForEmulator();
  realDebug(
    `[bench] ${currentBlock} idle simulator-server stopped (alive at end: ${held.record.aliveAtEnd})`
  );
  return held.record;
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
  let clearedAt: number | null = null;
  try {
    adbShell(`pm clear ${SETTINGS}`, 8_000);
    clearedAt = performance.now();
  } catch {
    /* fall through to plain launch */
  }
  // Run 37571460849: pm clear schedules a "remove task" kill that lands 1.0-1.5 s
  // later. An am start inside that window got its new process killed (OFF 17/18 per
  // block, ON 4/4). Start only CLEAR_KILL_GUARD_MS after the clear, on every arm.
  await sleep(
    clearedAt === null ? 300 : Math.max(300, CLEAR_KILL_GUARD_MS - (performance.now() - clearedAt))
  );
  adbShell(`am start -n ${SETTINGS}/.Settings`, 8_000);
  // Run 37561512651: wait out the delayed post-pm-clear kill (resumed + focused + not
  // finishing + stable pid; relaunched if killed), then keep the 1.5 s render settle
  // counted from the am start, as before.
  const startedAt = performance.now();
  await awaitSettingsReady(startedAt);
  await sleep(Math.max(0, 1500 - (performance.now() - startedAt)));
  await reg
    .invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 })
    .catch(() => undefined);
}

// LIGHT reset for the tap effect loop: force-stop + relaunch WITHOUT `pm clear`
// (the effect check captures a fresh origin each iteration, so it needs a stable
// root to return to, not a pristine paste/search state). ~2-3 s vs ensureSettings'
// ~6-8 s — pm clear per originLost was what dragged a bench block to many minutes.
async function relaunchSettings(reg: Reg): Promise<void> {
  dismissSystemDialogs();
  adbShell(`am force-stop ${SETTINGS}`, 8_000);
  adbShell(`am start -n ${SETTINGS}/.Settings`, 8_000);
  // Same readiness wait as ensureSettings (run 37561512651), then the 0.7 s settle.
  const startedAt = performance.now();
  await awaitSettingsReady(startedAt);
  await sleep(Math.max(0, 700 - (performance.now() - startedAt)));
  await reg
    .invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 3000 })
    .catch(() => undefined);
}

// Settle onto a rendered, IDLE Settings homepage before the await-* verbs measure.
// The proprietary await-screen-idle caps on EVERY iteration (min≈4019 ms) when the
// block starts on a still-rendering or wrong screen, and await-ui-element then never
// finds its selector — the degraded-arm gate fires (run-2 OFF-2). Reset, WAIT
// (backend-independently, via the resumed activity) until Settings is resumed, let
// the backend confirm a canonical root row rendered, and retry the whole reset a few
// times. Returns the confirming describe's lines so the caller can pick an
// await-ui-element selector that is definitely on screen (never the "Settings"
// default that was absent in run-2). Empty array only if no clean root was reached.
async function ensureSettledSettingsRoot(reg: Reg): Promise<string[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await ensureSettings(reg);
    // Backend-independent: wait until Settings is actually the resumed activity, so
    // a launcher→Settings transition can't leave the await-* verbs on the launcher.
    await pollUntil(
      resumedActivityFingerprint,
      (f) => f !== undefined && /com\.android\.settings/.test(f),
      4000,
      150
    );
    await reg
      .invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 })
      .catch(() => undefined);
    try {
      const d = (await reg.invokeTool("describe", { udid: SERIAL })) as { description: string };
      const crashed = /keeps stopping|aerr_|isn't responding/i.test(d.description);
      const rooted = /network|battery|display|storage|connected|apps|sound|notif/i.test(
        d.description
      );
      if (rooted && !crashed) return d.description.split("\n");
    } catch {
      /* retry */
    }
    dismissSystemDialogs();
    await sleep(600);
  }
  return [];
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
  adbShell(`am start -a android.intent.action.VIEW -d https://example.com ${CHROME}`, 12_000);
  await sleep(3500);
  await reg
    .invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 5000 })
    .catch(() => undefined);
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
  // Phase 3n.1 (review 3N-H5): the raw per-sample latencies (ms) behind `latency`,
  // so the scoreboard can bootstrap a 95 % CI on the p50 difference vs the OFF blocks
  // instead of deciding a gate at ±1 ms with no interval. For the tap-effect verbs
  // this is the effect-checked (landed) subset, matching `latency`.
  latencySamples: number[];
  errors: number;
  fallbacks: number;
  fallbackSamples: string[];
  // Phase 3h review A9/d: the messages of the iterations counted in `errors`, so a
  // discarded iteration (e.g. a 0/59 tap on a benign retry) is explicable from the JSON
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
  // Review 2026-10-07 finding 2: gesture-swipe / gesture-pinch are timed as gesture +
  // one draining read (`drainRead`); `noDrain` is the gesture call alone over the
  // same iterations (secondary, the pre-fix number).
  drainRead?: string;
  noDrain?: { latency: ReturnType<typeof summarize>; latencySamples: number[] };
  // Run 37561512651 (Review 2026-10-07): timed samples whose window read at least one
  // empty describe (ON `treeEmpty` or 0 elements, OFF 0 elements), with the first few
  // identities. Run 37571460849: no longer fails the block; those windows are left out
  // of `latency`/`latencySamples` on both arms (their times are `emptyLatencySamples`)
  // and the rate treeEmpty / describeWindows is graded by P11 in the merge.
  treeEmpty: number;
  treeEmptySamples: string[];
  describeWindows: number;
  emptyLatencySamples: number[];
  // tap+describe only: after each empty timed window, the untimed time to a non-empty
  // describe (the first non-empty read of the time-to-correct loop).
  timeToNonEmpty?: TtneSummary;
  // tap+describe only (run 37578606526, review finding 12): every timed read classified
  // correct / stale / empty / other against the block's destination markers, the
  // correct-only latency, and time-to-correct from the tap for every sample
  // (tap-describe-destination.js summarizeDestination).
  destination?: ReturnType<typeof summarizeDestination>["destination"];
  timeToCorrect?: ReturnType<typeof summarizeDestination>["timeToCorrect"];
  // Per timed iteration, the Settings reset wait its untimed setup paid (ms from the
  // am start until Settings was ready; null when that setup did not reset Settings).
  // Only on verbs with a per-iteration setup.
  resetWaitMs?: (number | null)[];
  extra?: Record<string, unknown>;
}

// Review 2026-10-07 finding 2: the read that drains a queued final UP, identical on
// every arm. input-manager (and uia-async) inject the final ACTION_UP asynchronously,
// so the swipe/pinch RPC returns before the finger is up and the next state read pays
// the drain; a sync-UP arm pays it inside the gesture RPC. Timing the gesture alone
// therefore credits the async arms with work they defer. `describe` with
// `settle:false` is the read the headline tap row (tap+describe(settle:false)) uses:
// on the open path it drains the async UP before capturing (StateHandler /
// HierarchyHandler), on the proprietary path `settle` is ignored and it is that
// path's plain describe.
const DRAIN_READ = "describe(settle:false)";

async function timeGestureDrained(
  label: string,
  gesture: (i: number) => Promise<void>,
  drain: () => Promise<void>,
  setup?: (i: number) => Promise<void>
): Promise<VerbResult> {
  for (let i = 0; i < WARMUP; i++) {
    if (setup) await setup(i).catch(() => undefined);
    await gesture(i).catch(() => undefined);
    await drain().catch(() => undefined);
  }
  const mark = debugLines.length;
  const lat: number[] = [];
  const noDrain: number[] = [];
  let errors = 0;
  const errorSamples: string[] = [];
  const empty = newEmptyAcc();
  const emptyLat: number[] = [];
  const resetWaitMs: (number | null)[] = [];
  for (let i = 0; i < N; i++) {
    const resetMark = resetLog.length;
    if (setup) await setup(i).catch(() => undefined);
    if (setup) resetWaitMs.push(resetWaitSince(resetMark));
    const mark = windowMark();
    benchMarker(label, i);
    const t0 = performance.now();
    let sample: { total: number; gesture: number } | null = null;
    try {
      await gesture(i);
      const gestureMs = elapsedMs(t0);
      await drain();
      sample = { total: elapsedMs(t0), gesture: gestureMs };
    } catch (e) {
      errors++;
      if (errorSamples.length < 5)
        errorSamples.push(`i=${i}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const wasEmpty = noteTimedEmpty(empty, mark, label, i);
    if (sample && wasEmpty) emptyLat.push(sample.total);
    else if (sample) {
      lat.push(sample.total);
      noDrain.push(sample.gesture);
    }
  }
  const fb = fallbackCountSince(mark);
  return {
    verb: label,
    latency: summarize(lat),
    latencySamples: lat.slice(),
    errors,
    errorSamples,
    fallbacks: fb.count,
    fallbackSamples: fb.samples,
    treeEmpty: empty.count,
    treeEmptySamples: empty.samples,
    describeWindows: empty.describeWindows,
    emptyLatencySamples: emptyLat,
    ...(setup ? { resetWaitMs } : {}),
    drainRead: DRAIN_READ,
    noDrain: { latency: summarize(noDrain), latencySamples: noDrain.slice() },
  };
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
  const empty = newEmptyAcc();
  const emptyLat: number[] = [];
  const resetWaitMs: (number | null)[] = [];
  for (let i = 0; i < N; i++) {
    const resetMark = resetLog.length;
    if (setup) await setup(i).catch(() => undefined);
    if (setup) resetWaitMs.push(resetWaitSince(resetMark));
    const mark = windowMark();
    benchMarker(label, i);
    const t0 = performance.now();
    let dt: number | null = null;
    try {
      await fn(i);
      dt = elapsedMs(t0);
    } catch (e) {
      errors++;
      if (errorSamples.length < 5)
        errorSamples.push(`i=${i}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const wasEmpty = noteTimedEmpty(empty, mark, label, i);
    if (dt !== null) (wasEmpty ? emptyLat : lat).push(dt);
  }
  const fb = fallbackCountSince(mark);
  return {
    verb: label,
    latency: summarize(lat),
    latencySamples: lat.slice(),
    errors,
    errorSamples,
    fallbacks: fb.count,
    fallbackSamples: fb.samples,
    treeEmpty: empty.count,
    treeEmptySamples: empty.samples,
    describeWindows: empty.describeWindows,
    emptyLatencySamples: emptyLat,
    ...(setup ? { resetWaitMs } : {}),
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
  // FIRST-attempt no-effect count = effectZero (an alias printed alongside it so the
  // scoreboard makes explicit that the verdict is the first attempt only and nothing
  // was retried away). A dropped injection on this runner is the backend's real
  // behaviour and stays fatal on ON — it is NOT masked by a retry.
  firstTapNoEffect: number;
  // Iterations excluded because the UNTIMED fresh locate could not find the target
  // label even after a relaunch — never a blind tap (run-3 review).
  locateFailed: number;
  // Iterations whose located coordinate moved vs the previous one — evidence of the
  // BACK-restore layout drift the per-iteration re-locate corrects for.
  coordMoved: number;
  // How the coordinate was located: backend-independent uiautomator-dump file vs the
  // block's backend describe fallback. Same PRIMARY source in every block.
  locateVia: { dump: number; describe: number };
  // F7: per-miss identity strings for the first-attempt no-effect taps (capped).
  noEffectSamples: string[];
  // Loop iterations of this verb (timed or excluded), the range of its marker index.
  iterations?: number;
  // Step tap-latency: per timed sample of the ON gesture-tap. `timed` = the tap sent
  // `timing: true` (a seeded half of the samples, so the instrumentation's own cost
  // shows as the p50 gap between the halves); `stages` = that tap's stages (pre-tap
  // lock/resolve/screen-size read, the tap RPC on the host clock, the device stages,
  // `seq`, `dropped`). `counted` = the sample is in `latencySamples` (it changed
  // the screen and its window was not empty). Absent on OFF and on the other verbs.
  tapStages?: Array<{
    i: number;
    ms: number;
    counted: boolean;
    timed: boolean;
    stages?: OpenServerTapStages;
  }>;
}

/**
 * Timing-independent, FIRST-ATTEMPT effect-checked tap measurement, with a SYMMETRIC
 * per-iteration locate (phase 3h; run-3 review). Every iteration, in EVERY block,
 * identically: (1) UNTIMED fresh locate of `target` on the CURRENT screen
 * (`locateTargetCoord` — backend-independent uiautomator-dump file, backend-describe
 * fallback), so a coordinate that drifted after a BACK restore is re-found and the tap
 * always hits the right place; (2) the TIMED `timedTapAt(x, y)` = a coordinate tap
 * through the backend under test (all backends, including UiAutomation, tap by x,y —
 * no element re-resolution inside the timed call); (3) poll the fingerprint (fresh
 * read each step) ≤3 s. `effectZero` = `firstTapNoEffect` counts the FIRST tap missing
 * — NEVER retried away (a dropped injection is the backend's real behaviour, fatal on
 * ON). Then BACK to restore for the next iteration. A locate that fails even after a
 * relaunch fallback EXCLUDES the iteration (`locateFailed`), never a blind tap.
 */
async function timeTapEffect(
  label: string,
  target: string,
  // Resolves with the timed call's last result (tap+describe: the describe reply).
  timedTapAt: (x: number, y: number, i: number) => Promise<unknown>,
  reg: Reg,
  fingerprint: () => Promise<string | undefined>,
  ensureOrigin: () => Promise<void>,
  restoreBack: () => Promise<void>,
  // Run 37578606526 (review finding 12): tap+describe's destination check. After EVERY
  // timed window (never inside it), the timed read is classified and the untimed
  // time-to-correct loop runs (measureTimeToCorrect), before the effect poll.
  afterTimed?: (timed: unknown, t0: number, timedEnd: number, i: number) => Promise<TtcSample>,
  // Step tap-latency: whether sample i sends `timing: true` (ON gesture-tap only).
  tapTiming?: (i: number) => boolean
): Promise<TapEffectResult> {
  const [r] = await timeTapEffectVariants(
    [{ label, timedTapAt, afterTimed, tapTiming }],
    new Array<number>(N).fill(0),
    target,
    reg,
    fingerprint,
    ensureOrigin,
    restoreBack
  );
  return r!;
}

// One effect-checked tap variant: its verb label, the timed call and the optional
// destination check that runs after its timed window.
interface TapVariant {
  label: string;
  timedTapAt: (x: number, y: number, i: number) => Promise<unknown>;
  afterTimed?: (timed: unknown, t0: number, timedEnd: number, i: number) => Promise<TtcSample>;
  // Step tap-latency: whether sample i sends `timing: true`; its stages are read right
  // after the timed window (untimed). Set only on the ON gesture-tap.
  tapTiming?: (i: number) => boolean;
}

/**
 * timeTapEffect over several variants interleaved per sample (review 2026-10-07 run
 * 37591260027 finding 4). `schedule[k]` is the variant index of loop iteration k (a
 * seeded shuffle, tap-describe-destination.js variantSchedule), so every variant sees the
 * same drift, load and screen history within the block. Each iteration is exactly the
 * single-variant iteration below (locate, origin, BENCH marker, timed call, destination
 * check, effect poll, BACK), counted on its own variant; `i` is the variant's own
 * iteration number. One result per variant, in `variants` order.
 */
async function timeTapEffectVariants(
  variants: TapVariant[],
  schedule: number[],
  target: string,
  reg: Reg,
  fingerprint: () => Promise<string | undefined>,
  ensureOrigin: () => Promise<void>,
  restoreBack: () => Promise<void>
): Promise<TapEffectResult[]> {
  // Canonical ROOT fingerprint: after a reset, the first defined fingerprint is the
  // root the navigating tap moves AWAY from. Used only to confirm BACK restored it.
  let rootFp: string | undefined;
  for (let a = 0; a < 4 && rootFp === undefined; a++) {
    await ensureOrigin().catch(() => undefined);
    rootFp = await fingerprint().catch(() => undefined);
  }
  for (let i = 0; i < WARMUP; i++) {
    const v = variants[i % variants.length]!;
    const loc = await locateTargetCoord(reg, target);
    if (loc) await v.timedTapAt(loc.x, loc.y, i).catch(() => undefined);
    await ensureOrigin().catch(() => undefined);
  }
  const accs = variants.map(() => ({
    iter: 0,
    lat: [] as number[],
    errors: 0,
    errorSamples: [] as string[],
    effectChecked: 0,
    effectZero: 0,
    originLost: 0,
    locateFailed: 0,
    coordMoved: 0,
    locateVia: { dump: 0, describe: 0 },
    // F7: identity of each first-attempt no-effect tap (block/verb/iteration, origin
    // and final fingerprints, timings, coordinate + locate source), so a 59/60 is
    // diagnosable from the artifacts rather than a bare aggregate count.
    noEffectSamples: [] as string[],
    empty: newEmptyAcc(),
    emptyLat: [] as number[],
    ttne: [] as TtneSample[],
    ttc: [] as TtcSample[],
    fallbackLines: [] as string[],
    tapStages: [] as NonNullable<TapEffectResult["tapStages"]>,
  }));
  let prev: { x: number; y: number } | undefined;
  for (const vIdx of schedule) {
    const v = variants[vIdx]!;
    const a = accs[vIdx]!;
    const i = a.iter++;
    const label = v.label;
    const iterMark = debugLines.length;
    try {
      // 1. UNTIMED fresh locate on the CURRENT screen. If it fails, relaunch a pristine
      //    root ONCE (the only relaunch path) and re-locate; still nothing ⇒ exclude.
      let loc = await locateTargetCoord(reg, target);
      if (!loc) {
        await ensureOrigin().catch(() => undefined);
        loc = await locateTargetCoord(reg, target);
      }
      if (!loc) {
        a.locateFailed++;
        if (a.errorSamples.length < 5)
          a.errorSamples.push(`i=${i}: locate('${target}') failed — excluded`);
        continue;
      }
      a.locateVia[loc.source]++;
      if (prev && (Math.abs(loc.x - prev.x) > 0.002 || Math.abs(loc.y - prev.y) > 0.002))
        a.coordMoved++;
      prev = { x: loc.x, y: loc.y };
      // 2. Origin fingerprint (baseline for the effect poll).
      const origin = await fingerprint().catch(() => undefined);
      if (origin === undefined) {
        a.originLost++;
        continue;
      }
      const originFp = origin;
      // 3. TIMED window: the coordinate tap [+describe] through the backend under test,
      //    after the BENCH logcat marker (outside the window).
      const mark = windowMark();
      benchMarker(label, i);
      // Step tap-latency: this sample's timing switch, and no stale stages (an oracle,
      // reset or earlier tap) left to be read as this sample's.
      const tapTimed = v.tapTiming ? v.tapTiming(i) : false;
      if (v.tapTiming) {
        setOpenServerTapTiming(tapTimed);
        takeOpenServerTapStages(SERIAL);
      }
      const t0 = performance.now();
      let dt: number;
      let timed: unknown;
      try {
        timed = await v.timedTapAt(loc.x, loc.y, i);
        dt = elapsedMs(t0);
      } catch (e) {
        a.errors++;
        if (a.errorSamples.length < 5)
          a.errorSamples.push(`i=${i}: ${e instanceof Error ? e.message : String(e)}`);
        noteTimedEmpty(a.empty, mark, label, i);
        await ensureOrigin().catch(() => undefined);
        continue;
      }
      const timedEnd = t0 + dt;
      // Step tap-latency: the timed tap's stages, read outside the window; `counted`
      // is set below once the effect verdict is known.
      const stageRow = v.tapTiming
        ? {
            i,
            ms: dt,
            counted: false,
            timed: tapTimed,
            ...(tapTimed ? { stages: takeOpenServerTapStages(SERIAL) } : {}),
          }
        : undefined;
      if (v.tapTiming) setOpenServerTapTiming(false);
      if (stageRow) a.tapStages.push(stageRow);
      const wasEmpty = noteTimedEmpty(a.empty, mark, label, i);
      if (v.afterTimed) {
        const s = await v.afterTimed(timed, t0, timedEnd, i);
        a.ttc.push(s);
        if (s.ttne) a.ttne.push(s.ttne);
      }
      // 4. UNTIMED first-attempt verdict: did the FIRST tap change the screen ≤3 s?
      const changed = await pollUntil(
        fingerprint,
        (f) => f !== undefined && f !== originFp,
        3000,
        150
      );
      a.effectChecked++;
      // The miss iteration's latency is EXCLUDED from the tap percentiles (team-lead
      // run-6 decision): a tap that produced no effect is not a representative timing.
      // Its count is firstTapNoEffect (printed); it is never retried away. Run
      // 37571460849: an empty window is left out too (emptyLatencySamples, P11).
      if (changed && wasEmpty) a.emptyLat.push(dt);
      else if (changed) {
        a.lat.push(dt);
        if (stageRow) stageRow.counted = true;
      } else {
        a.effectZero++;
        // F7: capture WHY this first attempt showed no effect — the fingerprint the
        // poll ended on, the origin it was compared against, the tapped coordinate and
        // its locate source, and the tap timing — so a silent 59/60 is explicable.
        const finalFp = await fingerprint().catch(() => undefined);
        const sample =
          `i=${i} verb='${label}' tapMs=${dt} coord=(${loc.x.toFixed(4)},${loc.y.toFixed(4)}) ` +
          `via=${loc.source} originFp='${originFp}' finalFp='${finalFp ?? "(undef)"}'`;
        if (a.noEffectSamples.length < 10) a.noEffectSamples.push(sample);
        realDebug(`[bench][no-effect] ${sample}`);
      }
      // 5. Restore for the next iteration: BACK; if not back on the root, hard-reset.
      if (changed) {
        await restoreBack().catch(() => undefined);
        const restored = await pollUntil(
          fingerprint,
          (f) => f !== undefined && f === rootFp,
          2000,
          150
        );
        if (!restored) {
          a.originLost++;
          await ensureOrigin().catch(() => undefined);
        }
      }
    } finally {
      if (v.tapTiming) setOpenServerTapTiming(false);
      // The open-server fallback lines this iteration logged, on its own variant.
      for (const l of debugLines.slice(iterMark))
        if (OPEN_SERVER_FALLBACK.test(l)) a.fallbackLines.push(l);
    }
  }
  return variants.map((v, k) => {
    const a = accs[k]!;
    return {
      verb: v.label,
      latency: summarize(a.lat),
      latencySamples: a.lat.slice(),
      errors: a.errors,
      errorSamples: a.errorSamples,
      fallbacks: a.fallbackLines.length,
      fallbackSamples: a.fallbackLines.slice(0, 3),
      treeEmpty: a.empty.count,
      treeEmptySamples: a.empty.samples,
      describeWindows: a.empty.describeWindows,
      emptyLatencySamples: a.emptyLat,
      ...(v.afterTimed
        ? { timeToNonEmpty: summarizeTtne(a.ttne), ...summarizeDestination(a.ttc) }
        : {}),
      effectChecked: a.effectChecked,
      effectZero: a.effectZero,
      originLost: a.originLost,
      firstTapNoEffect: a.effectZero,
      locateFailed: a.locateFailed,
      coordMoved: a.coordMoved,
      locateVia: a.locateVia,
      noEffectSamples: a.noEffectSamples,
      iterations: a.iter,
      ...(v.tapTiming ? { tapStages: a.tapStages } : {}),
    };
  });
}

/**
 * Per-block oracle SELF-TEST (review run-2: prove the effect oracle is ARMED before
 * the timed loop). Navigate through the backend under test to the known target, poll
 * the fingerprint for a change ≤3 s, BACK, poll until restored — retrying the whole
 * cycle up to 3 times (this is VALIDATION, not measurement, so a dropped injection
 * may be retried here without touching any verdict). Returns true iff at least one
 * cycle navigated, was DETECTED by the oracle, and restored. A false result means the
 * oracle or the backend cannot complete a single known navigation on this block, so
 * its effect rows are untrustworthy — a verdict DISTINCT from "tap did not land" (a
 * first-attempt miss during the timed loop) and from a degraded await arm.
 */
async function oracleSelfTest(
  target: string,
  timedTapAt: (x: number, y: number, i: number) => Promise<void>,
  reg: Reg,
  fingerprint: () => Promise<string | undefined>,
  ensureOrigin: () => Promise<void>,
  restoreBack: () => Promise<void>
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await ensureOrigin().catch(() => undefined);
    const loc = await locateTargetCoord(reg, target);
    if (!loc) continue;
    const origin = await fingerprint().catch(() => undefined);
    if (origin === undefined) continue;
    await timedTapAt(loc.x, loc.y, 0).catch(() => undefined);
    const changed = await pollUntil(fingerprint, (f) => f !== undefined && f !== origin, 3000, 150);
    if (!changed) continue;
    await restoreBack().catch(() => undefined);
    const restored = await pollUntil(
      fingerprint,
      (f) => f !== undefined && f === origin,
      3000,
      150
    );
    if (restored) return true;
    await ensureOrigin().catch(() => undefined);
  }
  return false;
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
  // Fingerprint (hash) build cost (phase 3m). ~0 on the plain describe path (G1);
  // its own stage so the after-tap residual (G2) no longer hides a forced rebuild.
  fingerprintMs: StageStat;
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
  "fingerprintMs",
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

// Phase 3m.1 (3M-M5): one ALIGNED record per describe call. The p50/p95 summaries
// below are a sum-of-medians, which is neither an upper nor a lower bound on the
// median of per-sample residuals (`captureMs − Σ stage`), so a residual cannot be
// honestly recomputed from them (finding 3M-M5). Persisting the raw per-call
// stages lets a reviewer recompute the per-sample residual median directly.
type PerSampleStage = {
  captureMs?: number;
  waitedMs?: number;
  rootMs?: number;
  windowsMs?: number;
  rootsMs?: number;
  serializeMs?: number;
  encodeMs?: number;
  fingerprintMs?: number;
  wireBytes?: number;
  hostRttMs?: number;
};

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
  // Phase 3m.1 (3M-M5): the raw per-sample stage records, so per-sample residuals
  // can be recomputed off the artifact rather than trusted from the p50 proxy.
  samples: PerSampleStage[];
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
    fingerprintMs?: number;
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
  // Phase 3m.1 (3M-M5): aligned per-call records.
  perSample: PerSampleStage[];
}
function newSplitAcc(): SplitAcc {
  return {
    waited: [],
    captured: [],
    wireBytesSamples: [],
    stageSamples: {
      idleMs: [],
      rootMs: [],
      windowsMs: [],
      rootsMs: [],
      serializeMs: [],
      encodeMs: [],
      fingerprintMs: [],
      hostParseMs: [],
      hostRenderMs: [],
      hostTtfbMs: [],
      hostRecvMs: [],
      hostRttMs: [],
      prevServerWriteMs: [],
      prevServerHandleMs: [],
      prevServerTotalMs: [],
    },
    perSample: [],
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
    if (typeof t.fingerprintMs === "number") s.fingerprintMs.push(t.fingerprintMs);
    if (typeof t.prevServerWriteMs === "number") s.prevServerWriteMs.push(t.prevServerWriteMs);
    if (typeof t.prevServerHandleMs === "number") s.prevServerHandleMs.push(t.prevServerHandleMs);
    if (typeof t.prevServerTotalMs === "number") s.prevServerTotalMs.push(t.prevServerTotalMs);
  }
  // Phase 3m.1 (3M-M5): one aligned record per call for per-sample residual recompute.
  const sample: PerSampleStage = {};
  if (typeof d.captureMs === "number") sample.captureMs = d.captureMs;
  if (typeof d.waitedMs === "number") sample.waitedMs = d.waitedMs;
  if (typeof d.wireBytes === "number") sample.wireBytes = d.wireBytes;
  if (typeof d.hostRoundTripMs === "number") sample.hostRttMs = d.hostRoundTripMs;
  if (t) {
    if (typeof t.rootMs === "number") sample.rootMs = t.rootMs;
    if (typeof t.windowsMs === "number") sample.windowsMs = t.windowsMs;
    if (Array.isArray(t.rootsMs)) sample.rootsMs = t.rootsMs.reduce((a, b) => a + b, 0);
    if (typeof t.serializeMs === "number") sample.serializeMs = t.serializeMs;
    if (typeof t.encodeMs === "number") sample.encodeMs = t.encodeMs;
    if (typeof t.fingerprintMs === "number") sample.fingerprintMs = t.fingerprintMs;
  }
  acc.perSample.push(sample);
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
    fingerprintMs: stageStat(s.fingerprintMs),
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
    samples: acc.perSample,
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
 * Phase 3m.1 (3M-M4): the plain `describe` path is opt-OUT of fingerprints, so its
 * `fingerprintMs` stage is a tautological 0 — it confirms the opt-out path, not the
 * opt-in one, and says nothing about what the screen-graph path pays. This variant
 * drives the SAME after-tap setup but reads through the open API with
 * `fingerprints: true`, so `timings.fingerprintMs` is the REAL cost of the opt-in
 * `TreeStore.ensure(rootNode)` rebuild (a second `ScreenTree.build` of the capture's
 * already-resolved root). ON arms only (no open server on OFF); returns null if the
 * server cannot be resolved.
 */
async function describeSplitAfterTapFingerprints(
  reg: Reg,
  n: number,
  tapX: number,
  tapY: number
): Promise<DescribeSplit | null> {
  try {
    const device = resolveDevice(SERIAL);
    const ref = openDeviceServerRef(device);
    const server = await reg.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    const acc = newSplitAcc();
    for (let i = 0; i < n; i++) {
      await ensureSettings(reg);
      await reg
        .invokeTool("gesture-tap", { udid: SERIAL, x: tapX, y: tapY })
        .catch(() => undefined);
      try {
        // settle:false shape (waitTimeoutMs 0) so the fingerprint rebuild runs
        // mid-transition — the exact after-tap condition C1 lived in.
        const r = (await server.getNestedState({
          waitTimeoutMs: 0,
          fingerprints: true,
        })) as DescribeMeta;
        collectSplit(acc, r);
      } catch {
        /* skip */
      }
    }
    return finalizeSplit(acc);
  } catch {
    return null;
  }
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
  const empty = newEmptyAcc();
  const emptyLat: number[] = [];
  for (let i = 0; i < n; i++) {
    const mark = windowMark();
    const t0 = performance.now();
    let sample: { dt: number; d: DescribeMeta } | null = null;
    try {
      const d = (await reg.invokeTool("describe", { udid: SERIAL })) as DescribeMeta;
      sample = { dt: elapsedMs(t0), d };
    } catch (e) {
      errors++;
      if (errorSamples.length < 5)
        errorSamples.push(`i=${i}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const wasEmpty = noteTimedEmpty(empty, mark, label, i);
    if (sample && wasEmpty) emptyLat.push(sample.dt);
    else if (sample) {
      lat.push(sample.dt);
      collectSplit(acc, sample.d);
    }
  }
  const fb = fallbackCountSince(mark);
  return {
    verb: {
      verb: label,
      latency: summarize(lat),
      latencySamples: lat.slice(),
      errors,
      errorSamples,
      fallbacks: fb.count,
      fallbackSamples: fb.samples,
      treeEmpty: empty.count,
      treeEmptySamples: empty.samples,
      describeWindows: empty.describeWindows,
      emptyLatencySamples: emptyLat,
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
  lines.push(
    `[bench]   ${"wireBytes".padEnd(12)} ${bcell(idle.wireBytes)} | ${bcell(afterTap.wireBytes)}`
  );
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
      wire: [] as number[],
      ttfb: [] as number[],
      recv: [] as number[],
      rtt: [] as number[],
      parse: [] as number[],
      waited: [] as number[],
      capture: [] as number[],
      encode: [] as number[],
      write: [] as number[],
      handle: [] as number[],
      total: [] as number[],
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
async function measureAdbFormFactorCost(n: number): Promise<{
  beforeP50: number | null;
  beforeP95: number | null;
  afterP50: number | null;
  n: number;
}> {
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
    st.p50 === null
      ? "   -   "
      : `${String(st.p50).padStart(6)}/${String(st.p95 ?? "?").padStart(6)}`;
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

  let ports: { localPort: number; devicePort: number; allPort?: number };
  try {
    const device = resolveDevice(SERIAL);
    const ref = openDeviceServerRef(device);
    const server = await reg.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    ports = server.getTransportPorts();
  } catch (e) {
    arms.push(
      naArm(
        "adb-forward",
        `could not resolve open server: ${e instanceof Error ? e.message : String(e)}`
      )
    );
    return { paddingTarget: PAD, arms };
  }

  // (a) baseline + (c) padding — explicit client on the adb-forwarded loopback port.
  {
    const client = new AndroidOpenServerClient("127.0.0.1", ports.localPort);
    try {
      const a = await measureClientTransport(client, n);
      arms.push({
        label: "adb-forward",
        available: true,
        note: "baseline (adb server on the last hop)",
        ...a,
      });
      const c = await measureClientTransport(client, n, { _padTo: PAD });
      arms.push({
        label: `adb-forward +pad${PAD}`,
        available: true,
        note: "diagnostic: reply padded to a full-MSS multiple (never shipped)",
        ...c,
      });
    } catch (e) {
      arms.push(
        naArm("adb-forward", `probe failed: ${e instanceof Error ? e.message : String(e)}`)
      );
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
      arms.push(
        naArm(
          "redir (emulator console)",
          "server has no 0.0.0.0 listener (not an emulator bind); redir cannot reach loopback-only"
        )
      );
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
        arms.push({
          label: "redir (emulator console)",
          available: true,
          note: `redir tcp:${hostPort} -> guest 0.0.0.0:${ports.allPort} (bypasses adb server)`,
          ...s,
        });
      } catch (e) {
        arms.push(
          naArm(
            "redir (emulator console)",
            `probe failed: ${e instanceof Error ? e.message : String(e)}`
          )
        );
      } finally {
        if (client) client.close();
        if (hostPort !== undefined)
          await redirDel(consolePort, hostPort, token).catch(() => undefined);
      }
    }
  }

  return { paddingTarget: PAD, arms };
}

/** Render the phase 3j serialize-once + compact A/B and transport table for the log. */
function formatPhase3j(p: Phase3jResults): string {
  const lines: string[] = [];
  const cell = (st: StageStat): string =>
    st.p50 === null
      ? "   -   "
      : `${String(st.p50).padStart(6)}/${String(st.p95 ?? "?").padStart(6)}`;
  const ab = (
    title: string,
    before: RpcBreakdown | null,
    after: RpcBreakdown | null,
    keys: Array<[string, (b: RpcBreakdown) => StageStat]>
  ): void => {
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
  lines.push(
    `[bench] 3j item3 transport experiment (pad target ${p.transport.paddingTarget}B) p50/p95`
  );
  lines.push(
    `[bench]   ${"arm".padEnd(22)} ${"rttMs".padStart(13)} ${"recvMs".padStart(13)} ${"wireB".padStart(13)}  note`
  );
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
  const encodeLegacy = await measureRpcBreakdown(
    reg,
    "3j serialize legacy (before)",
    n,
    (s) =>
      s.getNestedState({
        waitTimeoutMs: 0,
        compact: true,
        _benchLegacyEncode: true,
      }) as Promise<RpcTimedReply>
  );
  const encodeOnce = await measureRpcBreakdown(
    reg,
    "3j serialize-once (after)",
    n,
    (s) => s.getNestedState({ waitTimeoutMs: 0, compact: true }) as Promise<RpcTimedReply>
  );
  const compactOff = await measureRpcBreakdown(
    reg,
    "3j compact off (before)",
    n,
    (s) => s.getNestedState({ waitTimeoutMs: 0, compact: false }) as Promise<RpcTimedReply>
  );
  const compactOn = await measureRpcBreakdown(
    reg,
    "3j compact on (after)",
    n,
    (s) => s.getNestedState({ waitTimeoutMs: 0, compact: true }) as Promise<RpcTimedReply>
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
  let out: string;
  try {
    out = adbShell("wm size", 8_000);
  } catch {
    return null;
  }
  const m = out.match(/Override size:\s*(\d+)x(\d+)/) ?? out.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
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

// Per-BLOCK probe state: once `uiautomator dump` proves unusable (an ON backend holds
// UiAutomation, so the shell dump errors after its idle timeout), stop calling it for
// the rest of the block so the fresh locate falls straight through to the backend
// describe instead of paying ~6 s per iteration. Reset at each block start.
let uiDumpEmptyStreak = 0;
function resetUiDumpProbe(): void {
  uiDumpEmptyStreak = 0;
}

// `adb shell uiautomator dump <file>` then `cat` — the FILE variant works where the
// `/dev/tty` variant returns nothing under non-interactive adb. Backend-independent.
// Returns the <hierarchy> slice or "" (e.g. UiAutomation busy while a backend holds
// it). After 2 consecutive empties in a block it short-circuits (dump unusable here).
function dumpUiTreeFile(): string {
  if (uiDumpEmptyStreak >= 2) return "";
  // F6: the short-circuit is a LOGGED, GATED event, not a silent per-block
  // degradation. When the 2nd consecutive empty dump disables the primary source
  // for the rest of the block (so every later locate falls through to the block's
  // own backend describe), record it once so the scoreboard/log shows WHEN the
  // backend-independent primary stopped being used.
  const noteShortCircuit = (): void => {
    if (uiDumpEmptyStreak === 2) {
      realDebug(
        "[bench][locate] uiautomator-dump short-circuited for this block (2 consecutive empty " +
          "dumps) — the backend-independent primary is disabled; locate falls through to the " +
          "block's own backend describe from here on (review F6)"
      );
    }
  };
  try {
    adbShell("uiautomator dump /sdcard/df_bench_ui.xml >/dev/null 2>&1", 6_000);
    const out = adbShell("cat /sdcard/df_bench_ui.xml 2>/dev/null", 5_000);
    const start = out.indexOf("<hierarchy");
    const end = out.lastIndexOf("</hierarchy>");
    if (start === -1 || end === -1) {
      uiDumpEmptyStreak++;
      noteShortCircuit();
      return "";
    }
    uiDumpEmptyStreak = 0;
    return out.slice(start, end + "</hierarchy>".length);
  } catch {
    uiDumpEmptyStreak++;
    noteShortCircuit();
    return "";
  }
}

// Normalized centre of a SPECIFIC label in a uiautomator-dump XML (prefix match on
// text or content-desc), or null. Same parse as uiTreeNavTarget, one target.
function locateLabelInXml(
  xml: string,
  screen: { width: number; height: number },
  target: string
): { x: number; y: number } | null {
  for (const node of xml.match(/<node\b[^>]*>/g) ?? []) {
    const text = xmlUnescape(node.match(/\btext="((?:[^"\\]|\\.)*)"/)?.[1] ?? "");
    const desc = xmlUnescape(node.match(/\bcontent-desc="((?:[^"\\]|\\.)*)"/)?.[1] ?? "");
    if (!text.startsWith(target) && !desc.startsWith(target)) continue;
    const b = node.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!b) continue;
    const l = Number(b[1]),
      t = Number(b[2]),
      r = Number(b[3]),
      bot = Number(b[4]);
    if (r <= l || bot <= t) continue;
    return { x: (l + r) / 2 / screen.width, y: (t + bot) / 2 / screen.height };
  }
  return null;
}

// UNTIMED fresh locate of `target` on the CURRENT screen (run-3 review: every
// iteration re-locates so a coordinate that drifted after a BACK restore is found
// afresh, and the timed tap always hits the right place — the miss rate then measures
// injection reliability, not a stale coordinate). PRIMARY source is the backend-
// INDEPENDENT uiautomator-dump file (identical in every block); FALLBACK is the
// block's own backend describe when the dump is empty (UiAutomation held by the
// backend, so the shell dump can return nothing). Returns the coord + which source
// found it, or null (locate failed → the iteration is excluded, never a blind tap).
async function locateTargetCoord(
  reg: Reg,
  target: string
): Promise<{ x: number; y: number; source: "dump" | "describe" } | null> {
  const screen = screenSizePx();
  if (screen) {
    const xml = dumpUiTreeFile();
    if (xml) {
      const c = locateLabelInXml(xml, screen, target);
      if (c) return { ...c, source: "dump" };
    }
  }
  // Fallback: the backend describe (untimed). Same target row, same parse as
  // deriveNavTarget's fallback; the coordinate for a given row is the physical row
  // centre regardless of which backend rendered it.
  try {
    const d = (await reg.invokeTool("describe", { udid: SERIAL })) as { description: string };
    const line = d.description.split("\n").find((l) => {
      const label = l.match(/(?<![=\w])"((?:[^"\\]|\\.)*)"/)?.[1];
      return !!label && label.startsWith(target) && !!frameCenterOf(l);
    });
    if (line) {
      const c = frameCenterOf(line)!;
      return { x: c.x, y: c.y, source: "describe" };
    }
  } catch {
    /* locate failed */
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
    let out: string;
    try {
      out = adbShell(
        "dumpsys activity activities | grep -m1 -E 'mResumedActivity|topResumedActivity'",
        8_000
      );
    } catch {
      out = "";
    }
    const m = out.match(/([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/);
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
//
// Run 37578606526 (review finding 12): it also returns the tap+describe destination
// markers (tap-describe-destination.js deriveDestinationMarkers: id+text keys on the
// settled destination and not on the root, and the reverse), from the SAME root and
// destination describes of the backend under test. The destination read now waits,
// identically on every arm, until the resumed activity left the root (≤ 3 s) plus
// DEST_SETTLE_MS (the OPEN transition finished ≤ ~1.8 s after the tap in that run) and
// an await-screen-idle, so a mid-transition read cannot become the "destination". An
// attempt whose markers are not valid (either side has none) is retried.
const DEST_SETTLE_MS = 2000;
async function deriveNavTarget(
  reg: Reg,
  settleForDerive: boolean | undefined
): Promise<{
  target: string;
  x: number;
  y: number;
  markers: string[];
  destinationMarkers: DestinationMarkers;
} | null> {
  const lineLabel = (l: string): string | undefined =>
    l.match(/(?<![=\w])"((?:[^"\\]|\\.)*)"/)?.[1];
  for (let attempt = 0; attempt < 3; attempt++) {
    await ensureSettings(reg);
    // Root labels for the markers come from the backend describe (the staleness
    // probe measures the backend); a failure here is retryable, not fatal.
    let rootLabels: Set<string>;
    let rootLines: string[];
    let rootDesc: string;
    let rootFp: string | undefined;
    try {
      const root = (await reg.invokeTool("describe", { udid: SERIAL })) as { description: string };
      rootDesc = root.description;
      rootLabels = labelSetOf(root.description);
      rootLines = root.description.split("\n");
      rootFp = await resumedActivityFingerprint();
    } catch {
      continue;
    }
    // PRIMARY target: backend-independent uiautomator dump → normalized centre.
    let picked: { target: string; x: number; y: number } | null = null;
    const screen = screenSizePx();
    if (screen) {
      const xml = dumpUiTreeFile();
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
    await pollUntil(resumedActivityFingerprint, (f) => f !== undefined && f !== rootFp, 3000, 150);
    await sleep(DEST_SETTLE_MS);
    await reg
      .invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 })
      .catch(() => undefined);
    let destLabels: Set<string>;
    let destDesc: string;
    try {
      const dest = (await reg.invokeTool("describe", {
        udid: SERIAL,
        ...(settleForDerive === undefined ? {} : { settle: settleForDerive }),
      })) as { description: string };
      destDesc = dest.description;
      destLabels = labelSetOf(dest.description);
    } catch {
      await ensureSettings(reg);
      continue;
    }
    const markers = [...destLabels].filter((l) => !rootLabels.has(l));
    const destinationMarkers = deriveDestinationMarkers(rootDesc, destDesc) as DestinationMarkers;
    await ensureSettings(reg);
    if (!destinationMarkers.valid && attempt < 2) {
      realDebug(
        `[bench][destination] markers not valid on attempt ${attempt} ` +
          `(dest=${destinationMarkers.dest.length} root=${destinationMarkers.root.length}); re-deriving`
      );
      continue;
    }
    return { target: picked.target, x: picked.x, y: picked.y, markers, destinationMarkers };
  }
  return null;
}

// Review 2026-10-07 finding 11: what each block actually ran, recorded on both arms.
// gitSha = the checkout the harness and the open server were built from; node = the
// host runtime; jsTiktoken = the tokenizer package version behind `tokens`;
// installedApk = sha256 of every APK file `pm path` reports for the block's device-side
// package AS INSTALLED (open: com.argent.devicecontrol, proprietary: the helper APK
// com.argent.androiddevtools), pulled with `adb exec-out cat`; hostApks = sha256 of the
// open APK(s) the tool-server installs from packages/android-device-server/bin (ON only;
// the OFF host files are hashed by proprietary-provenance.js).
interface BuildProvenance {
  gitSha: string | null;
  node: string;
  jsTiktoken: string | null;
  installedApk: {
    package: string;
    files: Array<{ path: string; sha256: string }>;
    error?: string;
  };
  hostApks?: Record<string, string>;
}

function gitSha(): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (sha) return sha;
  } catch {
    /* no git checkout: fall through */
  }
  return process.env.GITHUB_SHA ?? null;
}

// js-tiktoken does not export ./package.json, so walk up from its resolved entry.
function installedPackageVersion(name: string): string | null {
  try {
    let dir = dirname(require.resolve(name));
    for (let i = 0; i < 6; i++) {
      const pj = join(dir, "package.json");
      if (existsSync(pj)) {
        const meta = JSON.parse(readFileSync(pj, "utf8")) as { name?: string; version?: string };
        if (meta.name === name) return meta.version ?? null;
      }
      dir = dirname(dir);
    }
  } catch {
    /* unresolved */
  }
  return null;
}

function installedApkSha256(pkg: string): BuildProvenance["installedApk"] {
  try {
    const paths = adbShell(`pm path ${pkg}`)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("package:"))
      .map((l) => l.slice("package:".length));
    if (!paths.length) return { package: pkg, files: [], error: "pm path: not installed" };
    const files = paths.map((p) => {
      const bytes = execFileSync("adb", ["-s", SERIAL, "exec-out", "cat", p], {
        timeout: 60_000,
        maxBuffer: 512 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { path: p, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
    return { package: pkg, files };
  } catch (e) {
    return { package: pkg, files: [], error: e instanceof Error ? e.message : String(e) };
  }
}

function hostOpenApks(): Record<string, string> {
  const dir = join(process.cwd(), "packages", "android-device-server", "bin");
  const out: Record<string, string> = {};
  try {
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith(".apk"))
      .sort())
      out[f] = createHash("sha256")
        .update(readFileSync(join(dir, f)))
        .digest("hex");
  } catch {
    /* no build output: recorded as {} */
  }
  return out;
}

function buildProvenance(config: "OFF" | "ON"): BuildProvenance {
  return {
    gitSha: gitSha(),
    node: process.version,
    jsTiktoken: installedPackageVersion("js-tiktoken"),
    installedApk: installedApkSha256(config === "ON" ? OPEN_PKG : ADT_PKG),
    ...(config === "ON" ? { hostApks: hostOpenApks() } : {}),
  };
}

interface HostAwaitRecord {
  algorithm: "host";
  pollIntervalMs: number;
  minStableMs: number;
  calls: number;
  failed: number;
  settled: number;
  polls: number;
  readErrors: number;
  failures: string[];
}

interface BlockResult {
  block: string;
  config: "OFF" | "ON";
  // Run 37591260027 finding 4: the seeded per-sample order of the tap+describe variants
  // this block ran (verb names, in loop order).
  tapDescribeSchedule?: string[];
  // Run 37591260027 ("Next run"): whether the ON-only diagnostics ran in this block.
  onDiagnostics?: boolean;
  buildProvenance?: BuildProvenance;
  // Review run 37609765062: ON-im-bg's idle simulator-server, ON-hostawait's await route.
  idleSimServer?: IdleSimServerRecord | null;
  hostAwait?: HostAwaitRecord | null;
  // Phase 3n: the on-device injection strategy this ON block requested (uia-sync /
  // uia-async / input-manager), or undefined for the DEFAULT / OFF arms.
  injectStrategy?: OpenInjectStrategy | "default";
  // Phase 3n: the strategy the on-device server reported it actually ran, read
  // from a raw `tap` echo — "unavailable" iff an input-manager arm hit the
  // hiddenapi policy and fell back to uia-async (the merge/report drops that
  // block from the strategy comparison, ticket §3). undefined when not probed.
  injectStrategyReported?: string;
  // Phase 3n.3 (3N2-H1): the RAW on-device per-strategy injection counts from
  // `getInfo` (`{"input-manager":161}`, or `{"input-manager":150,"unavailable":11}`
  // on a hiddenapi fall-back), and their process-wide total — the merge gate fails on
  // `injectStrategyCounts["unavailable"] > 0` or a missing/zero total. undefined on OFF.
  injectStrategyCounts?: Record<string, number>;
  injectStrategyTotal?: number;
  // Phase 3n.3 (3N2-M6): count of TIMED, measured gated-inject RPCs behind the latency
  // rows (the "N measured" in the 161 process-wide breakdown). undefined on OFF/no verbs.
  measuredInjectRpcs?: number;
  // Review 2026-10-07 finding 3: every gesture tool call (tap/swipe/pinch/…) the bench
  // issued in this block, timed or not. On an ON block the on-device counter for the
  // block's strategy must equal it (Q4 equality, merge-blocks.js). Both configs.
  expectedInjectRpcs: number;
  // Review 2026-10-07 finding 3: `[<tool>] open-device-server … falling back` lines
  // logged during the whole block. Any on an ON block fails the block.
  openServerFallbacks: { count: number; samples: string[] };
  // Run 37561512651 (Review 2026-10-07): every Settings reset wait this block paid (ms
  // from am start until Settings was resumed, focused, not finishing and on a stable
  // pid) and its summary; `timeouts` = waits that hit the 5 s bound, `relaunches` = am
  // starts re-issued because Settings had been killed after the first one.
  resetWaitMs: number[];
  resetWait: {
    n: number;
    meanMs: number | null;
    maxMs: number | null;
    timeouts: number;
    relaunches: number;
    reasons: Record<string, number>;
  };
  // Empty describes in this block: `timed` = timed samples with one (sum of the verbs'
  // `treeEmpty`; graded by P11, no longer fatal since run 37571460849), `block` = every
  // empty describe incl. untimed ones (time-to-non-empty polls included),
  // `openServerEmptyTreeCount` = the host's open-path counter delta (ON; null on OFF).
  describeEmpty: { timed: number; block: number; openServerEmptyTreeCount: number | null };
  // Run 37578606526 (review finding 12): the tap+describe destination markers this block
  // derived from its own settled root and destination describes (null: no nav target).
  destinationMarkers: (DestinationMarkers & { target: string }) | null;
  // Step tap-latency: on ON, each cold start minus the open server's start warm-up
  // (discarded describe-shaped reads, JIT), which is kept apart per sample in
  // `coldStartWarmupMs` / `coldStartWarmupReads` (null: no warm-up recorded). OFF
  // carries no warm-up fields.
  coldStartMs: number[];
  coldStartWarmupMs?: Array<number | null>;
  coldStartWarmupReads?: Array<number | null>;
  verbs: VerbResult[];
  // Open-path describe idle-vs-capture split (p50), on an idle Settings root and
  // right after a tap into a content-heavy sub-screen. null on the proprietary
  // path (no split surfaced). Carries the phase 3i host split + wire bytes.
  describeSplitIdle: DescribeSplit;
  describeSplitAfterTap: DescribeSplit;
  // Phase 3m.1 (3M-M4): after-tap describe split read with `fingerprints: true`, so
  // `stages.fingerprintMs` is the REAL opt-in `TreeStore.ensure(rootNode)` cost, not
  // the tautological 0 of the opt-out plain describe. ON arms only; absent on OFF.
  describeSplitAfterTapFingerprints?: DescribeSplit;
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
  // FIRST-attempt no-effect taps across the effect-checked tap verbs = effectZeroTotal
  // (an explicit alias making clear the verdict is first-attempt only, nothing
  // retried). A positive count on an ON block is fatal — it is the honest
  // "N first attempts did not land" result for this backend on this runner.
  firstTapNoEffectTotal: number;
  // Iterations excluded because the per-iteration fresh locate could not find the
  // target even after a relaunch (never a blind tap); how many located coordinates
  // moved vs the previous iteration (BACK-restore drift evidence); and which source
  // located the coordinate (backend-independent dump vs backend-describe fallback).
  locateFailedTotal: number;
  coordMovedTotal: number;
  locateViaTotal: { dump: number; describe: number };
  // F7: per-miss identity of the first-attempt no-effect taps in this block (block,
  // verb, iteration, tap timing, origin/final fingerprints, coord + locate source),
  // so a silent 59/60 is diagnosable from the block JSON, not only an aggregate.
  noEffectSamples: string[];
  // Oracle self-test verdict (run-2 review): did the backend complete ONE
  // detected+restored navigation before the timed loop? false ⇒ the block's effect
  // rows are untrustworthy; the merge fails it with a DISTINCT "oracle self-test
  // failed" reason (never conflated with a first-attempt miss or a degraded arm).
  // true also when no effect check ran (no derivable target — reported separately).
  oracleSelfTestPassed: boolean;
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

// Step tap-latency (review round 1): the open server warms its JIT at start with
// discarded reads (blueprint `warmUp`), which the OFF stack has no counterpart of. The
// ON sample therefore excludes that warm-up, and what it took is returned apart.
async function coldStart(config: "OFF" | "ON"): Promise<{
  coldStartMs: number[];
  warmupMs: Array<number | null>;
  warmupReads: Array<number | null>;
}> {
  const out: number[] = [];
  const warmupMs: Array<number | null> = [];
  const warmupReads: Array<number | null> = [];
  for (let k = 0; k < COLD; k++) {
    await teardownBackend();
    const reg = createRegistry();
    takeOpenServerWarmup(SERIAL); // a stale record is not this start's
    const t0 = performance.now();
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const d = (await reg.invokeTool("describe", { udid: SERIAL })) as { source: string };
        ok = true;
        const w = config === "ON" ? takeOpenServerWarmup(SERIAL) : undefined;
        const warmMs = w ? w.ms : 0;
        out.push(elapsedMs(t0) - warmMs);
        warmupMs.push(w ? Math.round(w.ms * 10) / 10 : null);
        warmupReads.push(w ? w.reads : null);
        void d;
      } catch {
        await sleep(500);
      }
    }
    if (!ok) {
      out.push(NaN);
      warmupMs.push(null);
      warmupReads.push(null);
    }
    await reg.dispose().catch(() => undefined);
  }
  return { coldStartMs: out, warmupMs, warmupReads };
}

async function runBlock(
  block: string,
  config: "OFF" | "ON",
  // Phase 3n: the on-device injection strategy this ON block carries (uia-sync /
  // uia-async / input-manager). undefined = the DEFAULT path (today's behaviour),
  // used by the OFF blocks. Threaded to the host via the env var the blueprint reads
  // per gesture, so one bench run carries every arm.
  injectStrategy?: OpenInjectStrategy | "default"
): Promise<BlockResult> {
  const notes: string[] = [];
  currentBlock = block;
  // Review run 37609765062: ON-im-bg holds the idle simulator-server from before the cold
  // start to the end of the block (load samples without a phase are not counted).
  if (BG_SIMSERVER_BLOCKS.has(block)) await spawnIdleSimServer();
  setPhase("cold-start");
  // Review 2026-10-07 finding 3: every open-server "falling back" line from here to the
  // end of the block (cold start and untimed calls included) is counted; an ON block
  // with any fails (main() writes the block JSON first, then exits non-zero).
  const blockDebugMark = debugLines.length;
  // Run 37561512651: reset waits and empty describes are counted per block from here.
  const blockResetMark = resetLog.length;
  const blockEmptyMark = emptyDescribeCount;
  const blockOpenEmptyMark = openServerEmptyTreeCount();
  resetUiDumpProbe(); // re-probe the backend-independent locate source per block
  if (config === "ON") setFlag("open-device-server", true, "project");
  else unsetFlag("open-device-server", "project");
  // Phase 3n: select the Kotlin injection strategy for this block. Cleared for the
  // DEFAULT / OFF arms so their path is unchanged. (Phase 3n.2: the scrcpy
  // fast-inject backend and its host pacing were removed; every ON block runs the
  // on-device Kotlin injector, differing only in the `inject` strategy.)
  if (injectStrategy) process.env.ARGENT_OPEN_INJECT_STRATEGY = injectStrategy;
  else delete process.env.ARGENT_OPEN_INJECT_STRATEGY;

  const {
    coldStartMs,
    warmupMs: coldStartWarmupMs,
    warmupReads: coldStartWarmupReads,
  } = await coldStart(config);

  setPhase("setup");
  await teardownBackend();
  const reg = createRegistry();
  // Review 2026-10-07 finding 3 (Q4 equality): count every gesture tool call this
  // block issues (timed, warm-up, oracle, locate, setup/reset alike). Each one is one
  // tap/swipe/gesture RPC on the open path, and the on-device InjectStrategyCounter
  // records exactly one entry per such RPC, so for an ON block the counter must equal
  // this number; a call that left the open path never reaches the counter. The
  // server process is fresh for this registry (teardownBackend above), so its counts
  // are this block's.
  const INJECT_TOOLS = new Set([
    "gesture-tap",
    "gesture-swipe",
    "gesture-pinch",
    "gesture-rotate",
    "gesture-custom",
  ]);
  let hostInjectCalls = 0;
  const rawInvokeTool = reg.invokeTool.bind(reg) as Reg["invokeTool"];
  reg.invokeTool = ((name: string, ...rest: unknown[]) => {
    if (INJECT_TOOLS.has(name)) hostInjectCalls++;
    const p = (rawInvokeTool as (n: string, ...r: unknown[]) => Promise<unknown>)(name, ...rest);
    // Run 37561512651: every describe result is checked for an empty tree (both arms).
    return name === "describe"
      ? p.then((r) => {
          noteDescribeResult(r);
          return r;
        })
      : p;
  }) as Reg["invokeTool"];
  const verbs: VerbResult[] = [];

  // Review run 37609765062 (crossed await), review round 1: on ON-hostawait the await of
  // tap → await-idle → describe and the timed await-screen-idle verb run the tool's host
  // algorithm (hostAwaitIdle) over open-server state reads, after the same uncached
  // Android-TV probe the tool runs per call (isAndroidTv: adb devices + getprop); every
  // other block runs the tool (host poll on OFF, the on-device await on ON). A call whose
  // reads fail is counted as failed and the sample falls back to the tool (the arm is then
  // INVALID in the merge).
  const hostAwait: HostAwaitRecord | null = HOST_AWAIT_BLOCKS.has(block)
    ? {
        algorithm: "host",
        pollIntervalMs: HOST_AWAIT.pollIntervalMs,
        minStableMs: HOST_AWAIT.minStableMs,
        calls: 0,
        failed: 0,
        settled: 0,
        polls: 0,
        readErrors: 0,
        failures: [],
      }
    : null;
  const awaitIdle = async (timeoutMs?: number): Promise<void> => {
    if (hostAwait) {
      hostAwait.calls++;
      try {
        await isAndroidTv(SERIAL);
        const device = resolveDevice(SERIAL);
        const r = await hostAwaitIdle({
          read: async () =>
            hostAwaitSignature((await describeAndroidViaOpenState(reg, device)).tree),
          timeoutMs: timeoutMs ?? HOST_AWAIT.timeoutMs,
          sleep,
        });
        hostAwait.polls += r.polls;
        hostAwait.readErrors += r.readErrors;
        if (r.settled) hostAwait.settled++;
        if (r.readErrors === 0) return;
        throw new Error(`${r.readErrors} open-server read(s) failed`);
      } catch (e) {
        hostAwait.failed++;
        if (hostAwait.failures.length < 3)
          hostAwait.failures.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (timeoutMs === undefined) await reg.invokeTool("await-screen-idle", { udid: SERIAL });
    else await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs });
  };

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
  // Redir preconditions (fix h diagnostic): when an ON emulator block reports
  // adb-forward, this line says WHY redir was not selected — the console token file
  // must exist and the on-device 0.0.0.0 listener must answer the redir ping. Printed
  // so a fallback is a visible log line, not a silent downgrade.
  if (config === "ON") {
    realDebug(
      `[bench] ${block} redir-preconditions: emulatorSerial=${/^emulator-\d+$/.test(SERIAL)} ` +
        `consoleTokenFile=${readConsoleAuthToken() !== null} transport=${lastTransport}`
    );
  }

  // describe latency AND its decomposition from the SAME N back-to-back idle
  // describes (phase 3i correction): the verb p50/p95 and the stage + host/server
  // timeline table are now one sample, not a latency loop minus a separate
  // Math.min(N,10) split loop with untimed setup between calls.
  setPhase("describe-idle");
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

  // screenshot — NOT a latency verb (F6), and taken at the END of the block since run
  // 37591260027 (Part A): on OFF the first simulator-server-backed tool call spawns the
  // proprietary host process, and a screenshot may additionally start its frame stream
  // (gRPC streamScreenshot). A headless agent's first such call is usually a tap, so the
  // timed phases run with only what a tap starts; the screenshot's dims are read after
  // the last timed verb (see "screenshot" below).
  let shot = { bytes: 0, width: 0, height: 0, format: "unknown" };

  // Derive a NAVIGATING tap target once (a real Settings category that opens a
  // sub-screen), then reuse it for the effect-checked gesture-tap / tap+describe
  // below AND the staleness probe. Tapping a neutral (0.5, 0.5) point could land on
  // a gap and change nothing — worthless for an effect check — so the effect gate
  // taps a known-navigating row. On the pristine Settings root this target is
  // stable across resets.
  setPhase("nav-derive");
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

  // TIMED coordinate tap at a per-iteration LOCATED (x, y) — identical call in every
  // block (ON UiAutomation, OFF proprietary all tap by x,y; no element
  // re-resolution inside the timed call). The `_i` keeps the timedTapAt signature.
  const target = nav ? nav.target : "";
  const timedTapAt = async (x: number, y: number, _i: number): Promise<void> => {
    await reg.invokeTool("gesture-tap", { udid: SERIAL, x, y });
  };
  // For the no-target fallback only (canEffect false): a fixed neutral tap.
  const gestureTapRpc = async (): Promise<void> => {
    await reg.invokeTool("gesture-tap", { udid: SERIAL, x: tapX, y: tapY });
  };
  // Oracle self-test (run-2 review): before the timed loop, prove this backend can
  // complete ONE detected+restored navigation to the target. A failure here is a
  // distinct verdict ("oracle self-test failed") — the block is invalid, NOT the same
  // as first-attempt taps missing during the measured loop. Skipped when no target
  // was derivable (canEffect false — already surfaced as no effect check).
  let oracleSelfTestPassed = true;
  setPhase("oracle-self-test");
  if (canEffect) {
    oracleSelfTestPassed = await oracleSelfTest(
      target,
      timedTapAt,
      reg,
      fingerprint,
      ensureOrigin,
      restoreBack
    );
    notes.push(
      oracleSelfTestPassed
        ? `oracle self-test: PASSED (locate→tap→detect→restore for ${target})`
        : `ORACLE SELF-TEST FAILED: backend could not complete one located+detected+restored navigation ` +
            `to ${target} — this block's effect rows are untrustworthy (distinct from a first-attempt miss)`
    );
    await ensureSettings(reg);
  }
  setPhase("gesture-tap");
  // gesture-tap. TIMED = the coordinate tap ONLY; the per-iteration UNTIMED fresh
  // locate + the effect poll + BACK restore are outside the timed window (phase 3h).
  // effectZero = firstTapNoEffect counts the FIRST tap missing; the block fails on
  // effectZero > 0 in the merge (ON) / is reported (OFF).
  //
  // Step tap-latency: on ON the gesture-tap verb (only it) sends `timing: true` on a
  // seeded half of its samples and keeps their stages (`tapStages`), to split the
  // +1.5 ms vs OFF; the other half runs uninstrumented, so the scoreboard shows what
  // the instrumentation itself costs (a few clock reads, ~200 reply bytes).
  const tapTimingSchedule = variantSchedule(
    [Math.ceil(N / 2), Math.floor(N / 2)],
    `${block}/tap-timing`
  ) as number[];
  const tapTiming = config === "ON" ? (i: number) => tapTimingSchedule[i] === 0 : undefined;
  try {
    verbs.push(
      canEffect
        ? await timeTapEffect(
            "gesture-tap",
            target,
            timedTapAt,
            reg,
            fingerprint,
            ensureOrigin,
            restoreBack,
            undefined,
            tapTiming
          )
        : await timeCalls("gesture-tap", gestureTapRpc, undefined, ensureOrigin)
    );
  } finally {
    setOpenServerTapTiming(false);
  }

  await ensureSettings(reg);

  // tap+describe (F4 / P3d): what an agent actually does (act, then read). TIMED
  // window = coordinate tap RPC + the variant's read; the fresh locate, effect poll and
  // BACK restore are outside it.
  //
  // Review 2026-10-07 run 37591260027 finding 4: three variants on EVERY block, one per
  // sample in a seeded random order (tap-describe-destination.js variantSchedule, seeded
  // by the block name, recorded as `tapDescribeSchedule`): settle:false, settle:true
  // (the proprietary path ignores `settle`, so on OFF both are its plain describe) and
  // tap → await-screen-idle → describe with the tools' defaults, the call an agent on
  // either backend makes to read a settled screen. P5 is pre-registered on the await
  // variant (time-to-correct AND correct-at-first-read); the other two are report only.
  // No row is picked after the fact.
  //
  // Step settle-on-action: ON blocks also run tap(settle)+describe (tdVariantsFor), the
  // settle on the action: gesture-tap settle:true (first accessibility event <= 600 ms,
  // then 80 ms quiet, cap 1500 ms, on the device) and then describe settle:false. Report
  // only; pre-registered target (no gate): correct at first read >= 90 % and
  // time-to-correct <= tap+await-idle+describe on ON-im.
  setPhase("tap+describe");
  type TdCall = { settle?: boolean; awaitIdle?: boolean; tapSettle?: boolean };
  const TD_CALLS: Record<string, TdCall> = {
    "tap+describe(settle:false)": { settle: false },
    "tap+describe(settle:true)": { settle: true },
    "tap+await-idle+describe": { awaitIdle: true },
    "tap(settle)+describe": { tapSettle: true, settle: false },
  };
  const tdVariantList = tdVariantsFor(config) as string[];
  const tdRead = (c: TdCall): Promise<unknown> =>
    reg.invokeTool("describe", {
      udid: SERIAL,
      ...(c.settle === undefined ? {} : { settle: c.settle }),
    });
  const tapDescribeAt =
    (c: TdCall) =>
    async (x: number, y: number, _i: number): Promise<unknown> => {
      await reg.invokeTool("gesture-tap", {
        udid: SERIAL,
        x,
        y,
        ...(c.tapSettle ? { settle: true } : {}),
      });
      if (c.awaitIdle) await awaitIdle();
      // The describe reply leaves the timed window as its result; it is classified after.
      return tdRead(c);
    };
  const tapThenDescribeFixed = (c: TdCall) => async (): Promise<void> => {
    await reg.invokeTool("gesture-tap", {
      udid: SERIAL,
      x: tapX,
      y: tapY,
      ...(c.tapSettle ? { settle: true } : {}),
    });
    if (c.awaitIdle) await awaitIdle();
    await tdRead(c);
  };
  // Run 37578606526 (review finding 12): after EVERY timed tap+describe, classify the
  // timed read against this block's destination markers and run the untimed
  // time-to-correct loop (the variant's describe call, 50 ms apart, up to 3 s), on every
  // arm. No valid markers (the derive never saw a distinct destination): no destination
  // check, said in the notes, and the merge has no time-to-correct for P5 (N/A).
  const destMarkers = nav && nav.destinationMarkers.valid ? nav.destinationMarkers : null;
  if (nav && !destMarkers) {
    notes.push(
      `DESTINATION CHECK OFF: no valid markers for ${nav.target} (dest=${nav.destinationMarkers.dest.length} ` +
        `root=${nav.destinationMarkers.root.length}) — tap+describe reads not classified this block`
    );
  }
  const ttcAfterTimed =
    (c: TdCall) =>
    (timed: unknown, t0: number, timedEnd: number, i: number): Promise<TtcSample> =>
      measureTimeToCorrect(() => tdRead(c), destMarkers!, timed, t0, timedEnd, i);
  const tdCounts = variantCounts(N, tdVariantList) as number[];
  const tdSchedule = variantSchedule(tdCounts, block) as number[];
  const tapDescribeSchedule = tdSchedule.map((k) => tdVariantList[k] as string);
  if (canEffect) {
    const tdVariants: TapVariant[] = tdVariantList.map((label) => ({
      label,
      timedTapAt: tapDescribeAt(TD_CALLS[label]!),
      afterTimed: destMarkers ? ttcAfterTimed(TD_CALLS[label]!) : undefined,
    }));
    verbs.push(
      ...(await timeTapEffectVariants(
        tdVariants,
        tdSchedule,
        target,
        reg,
        fingerprint,
        ensureOrigin,
        restoreBack
      ))
    );
  } else {
    for (const label of tdVariantList)
      verbs.push(
        await timeCalls(label, tapThenDescribeFixed(TD_CALLS[label]!), undefined, ensureOrigin)
      );
  }

  await ensureSettings(reg);

  // waitedMs/captureMs split for describe right after a tap into a content-heavy
  // sub-screen — the tap+describe scenario. `setup` resets to root then taps, so
  // each describe reads a freshly-navigated (possibly still-settling) screen.
  setPhase("describe-split");
  const describeSplitAfterTap = await describeSplit(reg, Math.min(N, 10), async () => {
    await ensureSettings(reg);
    await reg.invokeTool("gesture-tap", { udid: SERIAL, x: tapX, y: tapY }).catch(() => undefined);
  });

  await ensureSettings(reg);

  // Post-navigating-tap staleness probe (phase 3d `destinationVisible`) REMOVED
  // (review F19). It read `visible: 0 of 20` in ALL four blocks of run 7 — including
  // the two proprietary OFF blocks whose taps landed 40/40 — because it tapped the
  // STALE coordinate derived once at nav-derive time and matched marker labels
  // captured once then, rather than locating fresh per iteration. An all-zero
  // oracle-adjacent probe is broken, not a finding, and given this effort's history
  // with needle-matching retractions it must not disappear silently; per F19 the
  // choice is "locate fresh per iteration OR remove", and it is removed here (the
  // phase-3d staleness claim is void from run 7 and is not re-measured this run).

  // gesture-swipe — reset to the Settings root before each iteration (F5). Review
  // 2026-10-07 finding 2: timed as swipe + one draining read (DRAIN_READ) on every arm,
  // so an async final UP still queued when the RPC returns is paid for; the swipe call
  // alone is kept as the no-drain column. The server returns no delivered gesture
  // duration (`{ swiped, timestampMs }` only), so none is recorded per sample.
  setPhase("gesture-swipe");
  const drainRead = async (): Promise<void> => {
    await reg.invokeTool("describe", { udid: SERIAL, settle: false });
  };
  verbs.push(
    await timeGestureDrained(
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
      drainRead,
      async () => {
        await ensureSettings(reg);
      }
    )
  );

  // Settle onto a rendered, IDLE Settings root so await-screen-idle measures an
  // ALREADY-idle screen (run-2 OFF-2 degraded here: it capped 20/20 because the block
  // started on a still-rendering screen). The 20 back-to-back await-* calls below do
  // not change the screen, so one robust settle holds for the whole await section.
  setPhase("await");
  const settledLines = await ensureSettledSettingsRoot(reg);

  // await-screen-idle (already idle -> resolve time). ON-hostawait: the host algorithm.
  verbs.push(
    await timeCalls("await-screen-idle", async () => {
      await awaitIdle(4000);
    })
  );

  // await-ui-element: select a label the settled root DEFINITELY renders (a present
  // NAV_CANDIDATE), so `exists` resolves at once instead of capping on the "Settings"
  // default that was absent from OFF-2's screen in run-2. Fall back to any short
  // present label, then to "Settings".
  const labelOfLine = (l: string): string | undefined =>
    l.match(/(?<![=\w])"((?:[^"\\]|\\.)*)"/)?.[1];
  let selText = "Settings";
  const presentLabels = settledLines.map(labelOfLine);
  const navPresent = NAV_CANDIDATES.find((cand) =>
    presentLabels.some((x) => !!x && x.startsWith(cand))
  );
  if (navPresent) {
    selText = navPresent;
  } else {
    const cand = presentLabels.find((x): x is string => !!x && x.length > 2 && x.length < 30);
    if (cand) selText = cand;
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

  // paste: open Settings search, focus field, then type into it N times. The search
  // entry can fail to render with parseable bounds on the FIRST proprietary describe
  // after a reset (run-2 OFF-2, run-3 OFF-1 both degraded here). Retry the settle +
  // describe + locate a few times before giving up, so an intermittent render race is
  // not scored as a degraded arm.
  setPhase("paste");
  let pasteReady = false;
  for (let attempt = 0; attempt < 3 && !pasteReady; attempt++) {
    await ensureSettledSettingsRoot(reg);
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
      /* retry */
    }
  }
  if (!pasteReady)
    notes.push("paste: could not locate Settings search field; measured on current focus");
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
  setPhase("gesture-pinch");
  const chromeOk = await ensureChrome(reg);
  if (!chromeOk)
    notes.push("gesture-pinch: Chrome/example.com did not confirm content; latency still measured");
  // Review 2026-10-07 finding 2: pinch + the same draining read, as for the swipe.
  verbs.push(
    await timeGestureDrained(
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
      drainRead,
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

  // screenshot dims, after the last timed verb (Part A, run 37591260027: see the
  // declaration of `shot` above). Not a latency verb (F6): OFF and ON return different
  // resolutions.
  setPhase("screenshot");
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
      "frames, so a side-by-side latency is not like-for-like — see the dims below. " +
      "Taken after the last timed verb (run 37591260027 Part A)."
  );

  // ---- ON-only diagnostics, AFTER every latency verb (review 2026-10-07 finding 8) ----
  // ping, the 2xN getNestedState / getState+screenshot decompositions, the nested-reply
  // capture, the phase-3j experiment, the end-of-block tap+describe(settle:true) row and
  // the fingerprinted after-tap split run after the last latency verb and change no
  // OFF-vs-ON row. Run 37591260027 ("Next run", ABBA): they run in ONE ON block only
  // (ON-im-1; the pre-ABBA single ON blocks keep them), so eight blocks fit the job.
  const onDiagnostics = config === "ON" && ON_DIAGNOSTIC_BLOCKS.has(block);
  const rpcBreakdowns: RpcBreakdown[] = [];
  let phase3j: Phase3jResults | undefined;
  if (onDiagnostics) setPhase("on-diagnostics");
  if (onDiagnostics && canEffect) {
    // Report only: settle:true run back to back at the end of the block (its interleaved
    // samples are the tap+describe(settle:true) variant above).
    await ensureSettings(reg);
    verbs.push(
      await timeTapEffect(
        "tap+describe(settle:true) end-of-block",
        target,
        tapDescribeAt({ settle: true }),
        reg,
        fingerprint,
        ensureOrigin,
        restoreBack,
        destMarkers ? ttcAfterTimed({ settle: true }) : undefined
      )
    );
    await ensureSettings(reg);
  }
  // Phase 3m.1 (3M-M4): a companion after-tap split read with fingerprints ON, so
  // `describeSplitAfterTapFp.stages.fingerprintMs` measures the opt-in rebuild cost
  // (the plain split above is opt-out and reads fingerprintMs 0 tautologically).
  // ON arms only; the proprietary path has no open server.
  const describeSplitAfterTapFp = onDiagnostics
    ? await describeSplitAfterTapFingerprints(reg, Math.min(N, 10), tapX, tapY)
    : null;

  // Raw RPC round-trip floor (phase 3i). Only the open server answers `ping`, so
  // this is an ON-only probe; OFF blocks report nulls.
  const ping = onDiagnostics ? await measurePing(reg, N) : { p50: null, p95: null, n: 0 };

  // Back-to-back RPC decompositions (phase 3i), ON only, on the idle Settings root.
  // getNestedState = the describe path (big nested text, no screenshot);
  // getState+screenshot = a JPEG-heavy payload. Comparing the 5-point timeline of
  // the two (and vs ping) shows whether the residual scales per-byte or is a fixed
  // per-request cost. Back-to-back so the piggybacked prevServer* is clean.
  if (onDiagnostics) {
    await ensureSettings(reg);
    const nested = await measureRpcBreakdown(
      reg,
      "getNestedState (describe path)",
      N,
      (s) => s.getNestedState({ waitTimeoutMs: 0 }) as Promise<RpcTimedReply>
    );
    if (nested) {
      rpcBreakdowns.push(nested);
      realDebug(formatRpcBreakdown(nested));
    }
    const withShot = await measureRpcBreakdown(
      reg,
      "getState +screenshot",
      N,
      (s) => s.getState({ waitTimeoutMs: 0, includeScreenshot: true }) as Promise<RpcTimedReply>
    );
    if (withShot) {
      rpcBreakdowns.push(withShot);
      realDebug(formatRpcBreakdown(withShot));
    }
    // Capture ONE real nested reply into the artifact (phase 3i #7), in the exact
    // HostBenchFixture shape, so the next phase can commit a real fixture in place
    // of the synthetic one. ON blocks only (the plain describe path).
    if (config === "ON") {
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
        realDebug(
          `[bench] captured real nested reply -> ${capturePath} (wireBytes=${state.wireBytes ?? "?"})`
        );
      } catch (e) {
        realDebug(
          `[bench] real nested-reply capture skipped: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    // Phase 3j: serialize-once + compact in-run A/B, and the transport experiment.
    // Off by default (keeps routine runs ~1 h); enable with BENCH_PHASE3J_EXPERIMENT=1.
    if (PHASE3J_EXPERIMENT) {
      try {
        phase3j = await runPhase3j(reg, N);
        realDebug(formatPhase3j(phase3j));
      } catch (e) {
        realDebug(
          `[bench] phase3j experiment skipped: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    } else {
      realDebug("[bench] phase3j experiment OFF (set BENCH_PHASE3J_EXPERIMENT=1 to run it)");
    }
  }

  // Print the per-stage p50/p95 split (idle vs after-tap) so the residual is
  // attributable to a concrete stage. Persisted in the block JSON via
  // describeSplit{Idle,AfterTap}.stages too; run OFF-1 and OFF-2 to read the
  // baseline (proprietary path leaves these null) and ON to read the open path.
  realDebug(formatStageTable(config, describeSplitIdle, describeSplitAfterTap));
  if (onDiagnostics) {
    realDebug(
      `[bench] ${config} ping p50/p95=${ping.p50 === null ? "-" : ping.p50.toFixed(2)}/${
        ping.p95 === null ? "-" : ping.p95.toFixed(2)
      } ms (n=${ping.n})`
    );
  }

  const rss = config === "OFF" ? simServerRssKb() : null;
  if (config === "ON")
    notes.push("host process: none beyond adb (open server runs on-device via am instrument)");

  // The tap timeline this block's backend injected, and the total no-effect tap
  // iterations across the effect-checked tap verbs (phase 3h).
  const injectBackend = config === "ON" ? "uiautomation" : "proprietary";
  const injectedTapTimeline = describeInjectedTapTimeline(
    injectBackend,
    BENCH_GESTURE_PARAMS.tapHoldMs
  );
  const effectZeroTotal = verbs.reduce((s, v) => s + (v.effectZero ?? 0), 0);
  const effectCheckedTotal = verbs.reduce((s, v) => s + (v.effectChecked ?? 0), 0);
  const originLostTotal = verbs.reduce((s, v) => s + (v.originLost ?? 0), 0);
  const firstTapNoEffectTotal = effectZeroTotal; // first-attempt only; no retry masks it
  const locateFailedTotal = verbs.reduce(
    (s, v) => s + ((v as Partial<TapEffectResult>).locateFailed ?? 0),
    0
  );
  const coordMovedTotal = verbs.reduce(
    (s, v) => s + ((v as Partial<TapEffectResult>).coordMoved ?? 0),
    0
  );
  // F7: gather the per-miss identity strings from every tap verb into the block.
  const noEffectSamples = verbs.flatMap(
    (v) => (v as Partial<TapEffectResult>).noEffectSamples ?? []
  );
  const locateViaTotal = verbs.reduce(
    (acc, v) => {
      const lv = (v as Partial<TapEffectResult>).locateVia;
      if (lv) {
        acc.dump += lv.dump;
        acc.describe += lv.describe;
      }
      return acc;
    },
    { dump: 0, describe: 0 }
  );
  notes.push(
    `effect-check: firstTapNoEffect=${firstTapNoEffectTotal}/${effectCheckedTotal} ` +
      `(first-attempt only, no re-tap; originLost=${originLostTotal}, locateFailed=${locateFailedTotal}, ` +
      `coordMoved=${coordMovedTotal}, locateVia dump/describe=${locateViaTotal.dump}/${locateViaTotal.describe}, ` +
      `target=${nav ? nav.target : "none"}); tap backend=${injectBackend}` +
      `${injectStrategy ? ` inject-strategy=${injectStrategy}` : ""}`
  );
  // flushInput asymmetry (fix c, review A2): an async-UP inject (input-manager, and
  // the uia-async strategy) defers the input drain to the next read, while a bare
  // UiAutomation/proprietary tap RPC drains inline. So gesture-tap (the tap-RPC row)
  // is NOT strictly like-for-like across arms — the like-for-like tap row is
  // tap+describe(settle:false), which pays the drain in every block.
  notes.push(
    "tap-RPC row (gesture-tap) carries the async-UP drain asymmetry: an async-UP inject " +
      "defers the drain to the next read, a bare UiAutomation/proprietary tap drains inline — " +
      "headline like-for-like tap row is tap+describe(settle:false)"
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
        `selector=${typeof elemVerb.extra?.selector === "string" ? elemVerb.extra.selector : "?"})`
    );
  }
  if (!pasteReady) {
    degradedReasons.push(
      "paste could not locate the Settings search field (measured on the wrong focus)"
    );
  }
  for (const r of degradedReasons) notes.push(`DEGRADED ARM: ${r}`);
  realDebug(
    `[bench] ${block} transport=${lastTransport} degradedReasons=${JSON.stringify(degradedReasons)}`
  );

  // Fidelity is compared on the pristine Settings root captured at block start
  // (before any tap/paste/keyboard state), so OFF and ON are the same screen.
  const fidelitySet = parsed.idTextSet;

  // Phase 3n.1 P7 (review 3N-M1): read the per-strategy injection COUNTS the server
  // accumulated over the whole block from `getInfo` — every measured tap/swipe/gesture
  // recorded the strategy it ran — instead of one extra post-hoc probe tap (which was
  // an unaccounted injection, 3N-L5). Reported as `<reported>: n/total` so a silent
  // hiddenapi fallback (`unavailable`) shows in the denominator split, per ON block.
  let injectStrategyReported: string | undefined;
  // Phase 3n.3 (3N2-H1): carry the RAW on-device per-strategy counts (and their
  // process-wide total) on the block JSON, so the merge gate can fail on
  // `injectStrategyCounts["unavailable"]` — the authoritative fallback signal now
  // that the host-side `[open-server-fast-inject] … falling back` emitter is gone —
  // instead of the dead host counter. `injectStrategyReported` stays as the human note.
  let injectStrategyCounts: Record<string, number> | undefined;
  let injectStrategyTotal: number | undefined;
  if (config === "ON") {
    try {
      const device = resolveDevice(SERIAL);
      const ref = openDeviceServerRef(device);
      const server = await reg.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
      const info = (await server.getInfo()) as { injectStrategyCounts?: Record<string, number> };
      const counts = info.injectStrategyCounts ?? {};
      const total = Object.values(counts).reduce((s, n) => s + n, 0);
      injectStrategyCounts = counts;
      injectStrategyTotal = total;
      // The strategy the host asked this block to run: input-manager for that arm, the
      // Kotlin DEFAULT (reported "default") for the ON-uiautomation control block.
      const expected = injectStrategy ?? "default";
      const n = counts[expected] ?? 0;
      const unavailable = counts["unavailable"] ?? 0;
      injectStrategyReported =
        `${expected}: ${n}/${total}` +
        (unavailable > 0 ? ` (unavailable→uia-async: ${unavailable}/${total})` : "") +
        ` [counts ${JSON.stringify(counts)}]`;
      if (expected === "input-manager" && unavailable > 0) {
        notes.push(
          `inject-strategy input-manager fell back to uia-async ${unavailable}/${total} time(s) on-device ` +
            `(hiddenapi) — P9 fallback path; treat as a portability caveat, not a clean input-manager arm`
        );
      } else if (expected === "input-manager") {
        notes.push(`inject-strategy input-manager ran ${n}/${total} on-device (0 fallbacks)`);
      } else {
        notes.push(`inject-strategy control block ran ${expected} ${n}/${total} on-device`);
      }
    } catch (e) {
      notes.push(
        `inject-strategy count read failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  // Finding 3: the expected on-device injection count (Q4 equality) and the block's
  // open-server fallback lines. Logged per block so bench-log-<block>.txt shows both.
  const expectedInjectRpcs = hostInjectCalls;
  const openServerFallbacks = fallbackCountSince(blockDebugMark);
  realDebug(
    `[bench] ${block} expectedInjectRpcs=${expectedInjectRpcs} (gesture tool calls issued this block)` +
      (injectStrategyCounts ? ` on-device counts=${JSON.stringify(injectStrategyCounts)}` : "") +
      ` openServerFallbacks=${openServerFallbacks.count}` +
      (openServerFallbacks.samples.length ? ` first: ${openServerFallbacks.samples[0]}` : "")
  );
  if (config === "ON" && openServerFallbacks.count > 0) {
    notes.push(
      `OPEN-SERVER FALLBACK: ${openServerFallbacks.count} "falling back" line(s) this block — ` +
        `some calls ran on the proprietary path; the block fails`
    );
  }
  // Run 37561512651: reset waits + empty describes for this block.
  const resetWaits = resetLog.slice(blockResetMark);
  const resetWaitMs = resetWaits.map((r) => r.waitMs);
  const resetWait = {
    n: resetWaits.length,
    meanMs: resetWaitMs.length
      ? Number((resetWaitMs.reduce((a, b) => a + b, 0) / resetWaitMs.length).toFixed(1))
      : null,
    maxMs: resetWaitMs.length ? Math.max(...resetWaitMs) : null,
    timeouts: resetWaits.filter((r) => !r.ok).length,
    relaunches: resetWaits.reduce((a, r) => a + r.relaunches, 0),
    // Run 37571460849: the probe's decisions summed over the block (why it waited,
    // why it relaunched, what each relaunch's am start answered, the outcomes).
    reasons: resetWaits.reduce<Record<string, number>>((acc, r) => {
      for (const [k, n] of Object.entries(r.reasons)) acc[k] = (acc[k] || 0) + n;
      return acc;
    }, {}),
  };
  const describeEmpty = {
    timed: verbs.reduce((a, v) => a + v.treeEmpty, 0),
    block: emptyDescribeCount - blockEmptyMark,
    openServerEmptyTreeCount:
      config === "ON" ? openServerEmptyTreeCount() - blockOpenEmptyMark : null,
  };
  realDebug(
    `[bench] ${block} resetWait=${JSON.stringify(resetWait)} describeEmpty=${JSON.stringify(describeEmpty)} ` +
      `treeEmpty(timed) by verb: ${verbs.map((v) => `${v.verb}=${v.treeEmpty}`).join(" ")}`
  );
  if (describeEmpty.timed > 0) {
    notes.push(
      `EMPTY DESCRIBES: ${describeEmpty.timed} timed sample(s) read an empty describe ` +
        `(${verbs
          .filter((v) => v.treeEmpty > 0)
          .map((v) => `${v.verb}=${v.treeEmpty}/${v.describeWindows}`)
          .join(", ")}) — left out of those verbs' latency, graded by P11 in the merge`
    );
  }
  const destVerbs = verbs.filter((v) => v.destination && v.timeToCorrect);
  if (destVerbs.length) {
    const line = destVerbs
      .map((v) => {
        const c = v.destination!.counts;
        const t = v.timeToCorrect!;
        return (
          `${v.verb} correct/pre-transition/empty/other=${c.correct}/${c.preTransition}/${c.empty}/${c.other} ` +
          `time-to-correct p50=${t.fromTapMs ? t.fromTapMs.p50.toFixed(1) : "-"} ms ` +
          `(timed out ${t.timedOut}/${t.measured})`
        );
      })
      .join("; ");
    realDebug(`[bench] ${block} destination: ${line}`);
    notes.push(
      `DESTINATION CHECK: ${line} — pre-transition/mixed = a read that showed (part of) the ` +
        `screen as it was before the tap (P12)`
    );
  }
  if (resetWait.timeouts > 0) {
    notes.push(
      `reset wait: ${resetWait.timeouts}/${resetWait.n} Settings reset(s) hit the 5 s bound ` +
        `before Settings was resumed, focused and stable`
    );
  }

  if (hostAwait) {
    realDebug(`[bench] ${block} hostAwait=${JSON.stringify(hostAwait)}`);
    notes.push(
      `host-algorithm await (await-algorithm arm): ${hostAwait.calls - hostAwait.failed}/` +
        `${hostAwait.calls} ran clean, ${hostAwait.settled} settled, ${hostAwait.polls} reads` +
        (hostAwait.failures.length ? `; failures: ${hostAwait.failures.join(" | ")}` : "")
    );
  }

  setPhase("teardown");
  await reg.dispose().catch(() => undefined);
  await teardownBackend();

  // Phase 3n.3 (3N2-M6): the measured gated-inject-RPC denominator as a NUMBER, so
  // Q4 can state "161 process-wide = N measured + warmups + oracle + locate/restore"
  // with N spelled out rather than "a subset". Every timed iteration of an inject verb
  // performed exactly one on-device injection; effect-checked verbs also injected on the
  // (excluded-from-latency) missed/errored iterations, so count `effectChecked + errors`
  // there and the full `latencySamples + errors` on the OFF-style timed verbs.
  const INJECT_VERB = /^(gesture-tap|gesture-swipe|gesture-pinch|tap\+|tap\(settle\)\+)/;
  const measuredInjectRpcs = verbs
    .filter((v) => INJECT_VERB.test(v.verb))
    .reduce(
      (s, v) =>
        s +
        (v.effectChecked != null
          ? v.effectChecked + v.errors
          : v.latencySamples.length + v.emptyLatencySamples.length + v.errors),
      0
    );
  // ON-im-bg: kill the idle simulator-server last (the teardown above left it alone).
  const idleSimServerRecord = await stopIdleSimServer();
  if (idleSimServerRecord)
    notes.push(
      `idle simulator-server (stream-causality arm): pids ${idleSimServerRecord.pids.join(",")}, ` +
        `alive at end of block: ${idleSimServerRecord.aliveAtEnd}`
    );

  return {
    block,
    config,
    tapDescribeSchedule,
    onDiagnostics,
    injectStrategy,
    injectStrategyReported,
    injectStrategyCounts,
    injectStrategyTotal,
    measuredInjectRpcs,
    expectedInjectRpcs,
    openServerFallbacks,
    idleSimServer: idleSimServerRecord,
    hostAwait,
    resetWaitMs,
    resetWait,
    describeEmpty,
    destinationMarkers: nav ? { target: nav.target, ...nav.destinationMarkers } : null,
    coldStartMs,
    ...(config === "ON" ? { coldStartWarmupMs, coldStartWarmupReads } : {}),
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
    firstTapNoEffectTotal,
    locateFailedTotal,
    coordMovedTotal,
    locateViaTotal,
    noEffectSamples,
    oracleSelfTestPassed,
    describeSplitIdle,
    describeSplitAfterTap,
    // Phase 3m.1 (3M-M4): opt-in fingerprint cost probe (ON only; null on OFF).
    ...(describeSplitAfterTapFp
      ? { describeSplitAfterTapFingerprints: describeSplitAfterTapFp }
      : {}),
    pingP50: ping.p50,
    pingP95: ping.p95,
    pingN: ping.n,
    rpcBreakdowns,
    ...(phase3j ? { phase3j } : {}),
    adbFormFactorBeforeP50: adbFF.beforeP50,
    adbFormFactorBeforeP95: adbFF.beforeP95,
    adbFormFactorAfterP50: adbFF.afterP50,
    adbFormFactorN: adbFF.n,
    transport: lastTransport,
    degradedReasons,
    notes,
  };
}

// ON-im-bg (review run 37609765062): runBlock releases the idle simulator-server after its
// final teardown on the normal path; when the block throws midway, this finally kills it,
// so a failed bg block never leaves the stream running into the next block or process.
// stopIdleSimServer is a no-op when nothing is held.
async function runBlockReleasing(
  block: string,
  config: "OFF" | "ON",
  injectStrategy?: OpenInjectStrategy | "default"
): Promise<BlockResult> {
  try {
    return await runBlock(block, config, injectStrategy);
  } finally {
    await stopIdleSimServer();
  }
}

/* -------------------------------------------------------------------------- */
/* Part A: what the proprietary stack runs in the background (run 37591260027) */
/* -------------------------------------------------------------------------- */

// Finding 1: the guest ran slower in every OFF block (tap → transition finished p50 OFF
// 1064-1361 ms vs ON 515-620 ms; qemu CPU p50 250-262 % vs 202-210 %), with the
// simulator-server host process alive only in OFF. From the code (identical to
// upstream/main: blueprints/simulator-server.ts, blueprints/android-devtools.ts, the OFF
// branch of tools/screenshot): the tool-server spawns `simulator-server android --id
// <serial>` lazily, on the first tool that resolves the SimulatorServer service (any
// gesture, paste or screenshot; boot-device does not), with no streaming flag and no
// ARGENT_* env; nothing on the host reads its MJPEG endpoint except screen-recording and
// the preview UI, which the bench never calls. The binary itself prints "MJPEG server
// started" at spawn, and the only screen RPC it links against the emulator is
// `EmulatorController/streamScreenshot` (a server-streaming gRPC: the emulator pushes a
// frame on every display change; there is no single-shot getScreenshot). Whether the
// binary opens that stream at spawn or on the first screenshot is inside the closed
// binary, so it is measured here:
//  - one fixed workload (adb `input swipe` up/down on the Settings root, the same in
//    every window, driven outside both backends) with qemu and simulator-server CPU
//    ticks read from /proc around it;
//  - windows: A no simulator-server; B simulator-server spawned through the registry
//    exactly as a headless agent's first gesture does it, no other call; C after one
//    `screenshot` tool call; A2 simulator-server killed again (drift control);
//  - the binary's own log at debug level for this process only (SIMSERVER_LOG and
//    RUST_LOG = simulator_server=debug): which window first prints a stream lifecycle
//    line ("Requesting screenshot stream", "Starting GRPC stream receiver", "Starting
//    screenshot service").
const PROBE_BG = "PROBE-BG";
const STREAM_LINE =
  /Requesting screenshot stream|Starting GRPC stream receiver|Starting screenshot service/i;
// Review run 37609765062 findings 2 and 6: the per-window qemu CPU deltas stay in the
// JSON as raw data but never in the verdict.
const PROBE_CPU_DELTA_CAVEAT =
  "The per-window qemu CPU deltas (qemuDeltaVsNoServerPct) are not evidence of load: " +
  "window A includes the warm-up right after `am start`, and with qemu saturating the " +
  "host cores (4 on CI) extra work shows as a slower guest, not as higher CPU. The " +
  "verdict rests only on the window of the first stream lifecycle line in the " +
  "simulator-server log.";
const PROBE_SWIPES = 8;

interface ProbeWindow {
  window: string;
  seconds: number;
  qemuCpuPct: number | null;
  simServerCpuPct: number | null;
  simServerAlive: boolean;
  simLines: number;
  streamLines: number;
}
interface PropBackground {
  workload: string;
  windows: ProbeWindow[];
  firstStreamLineWindow: string | null;
  debugLogHonoured: boolean;
  streamLineSamples: string[];
  // Raw, not evidence of load: see cpuDeltaCaveat.
  qemuDeltaVsNoServerPct: { spawnedIdle: number | null; afterScreenshot: number | null };
  stream: "on-at-spawn" | "on-after-screenshot" | "not-seen";
  // From the simulator-server log only (window of the first stream lifecycle line).
  verdict: string;
  cpuDeltaCaveat: string;
}

function pidsOf(pattern: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" })
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((p) => p !== process.pid);
  } catch {
    return [];
  }
}
function procTicks(pids: number[]): number | null {
  let sum = 0;
  let any = false;
  for (const pid of pids) {
    try {
      const t = statTicks(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (t != null) {
        sum += t;
        any = true;
      }
    } catch {
      /* gone or not Linux */
    }
  }
  return any ? sum : null;
}

async function runPropBackgroundProbe(): Promise<PropBackground> {
  currentBlock = PROBE_BG;
  setPhase("probe");
  unsetFlag("open-device-server", "project");
  delete process.env.ARGENT_OPEN_INJECT_STRATEGY;
  await teardownBackend();
  adbShell(`am force-stop ${SETTINGS}`, 8_000);
  adbShell(`am start -n ${SETTINGS}/.Settings`, 8_000);
  await sleep(3000);
  const simPattern = `simulator-server .*android --id ${SERIAL}`;
  const lines: Array<{ window: string; line: string }> = [];
  let window = "A";
  const rawWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text = String(chunk);
    if (text.startsWith("[sim "))
      for (const l of text.split("\n")) if (l.trim()) lines.push({ window, line: l.slice(0, 300) });
    return (rawWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  process.env.SIMSERVER_LOG = "simulator_server=debug";
  process.env.RUST_LOG = "simulator_server=debug";
  const reg = createRegistry();
  const workload = async (): Promise<void> => {
    for (let k = 0; k < PROBE_SWIPES; k++) {
      adbShell("input swipe 540 1700 540 900 250", 8_000);
      await sleep(700);
      adbShell("input swipe 540 900 540 1700 250", 8_000);
      await sleep(700);
    }
  };
  const measure = async (name: string): Promise<ProbeWindow> => {
    window = name;
    const before = lines.length;
    const q = pidsOf("qemu-system-");
    const sp = pidsOf(simPattern);
    const q0 = procTicks(q);
    const s0 = procTicks(sp);
    const w0 = performance.now();
    await workload();
    const sec = (performance.now() - w0) / 1000;
    const q1 = procTicks(q);
    const s1 = procTicks(sp);
    const pct = (a: number | null, b: number | null): number | null =>
      a == null || b == null ? null : Number((((b - a) / 100 / sec) * 100).toFixed(1));
    const mine = lines.slice(before);
    return {
      window: name,
      seconds: Number(sec.toFixed(1)),
      qemuCpuPct: pct(q0, q1),
      simServerCpuPct: sp.length ? pct(s0, s1) : 0,
      simServerAlive: sp.length > 0,
      simLines: mine.length,
      streamLines: mine.filter((x) => STREAM_LINE.test(x.line)).length,
    };
  };
  const windows: ProbeWindow[] = [];
  try {
    windows.push(await measure("A: no simulator-server"));
    window = "B: spawned, no call";
    const device = resolveDevice(SERIAL);
    const ref = simulatorServerRef(device);
    await reg.resolveService(ref.urn, ref.options);
    await sleep(2000);
    windows.push(await measure("B: spawned, no call"));
    window = "C: after one screenshot";
    await reg
      .invokeTool("screenshot", { udid: SERIAL, includeImageInContext: false })
      .catch(() => undefined);
    await sleep(1000);
    windows.push(await measure("C: after one screenshot"));
    await reg.dispose().catch(() => undefined);
    killSimServerForEmulator();
    await sleep(1500);
    windows.push(await measure("A2: no simulator-server"));
  } finally {
    process.stderr.write = rawWrite as typeof process.stderr.write;
    delete process.env.SIMSERVER_LOG;
    delete process.env.RUST_LOG;
    await reg.dispose().catch(() => undefined);
    await teardownBackend();
  }
  const first = lines.find((x) => STREAM_LINE.test(x.line));
  const debugLogHonoured = lines.some((x) => /\bDEBUG\b|\bTRACE\b/.test(x.line));
  const base = windows
    .filter((w) => w.window.startsWith("A") && w.qemuCpuPct != null)
    .map((w) => w.qemuCpuPct as number);
  const baseMean = base.length ? base.reduce((x, y) => x + y, 0) / base.length : null;
  const dOf = (prefix: string): number | null => {
    const w = windows.find((x) => x.window.startsWith(prefix));
    return w && w.qemuCpuPct != null && baseMean != null
      ? Number((w.qemuCpuPct - baseMean).toFixed(1))
      : null;
  };
  const stream: PropBackground["stream"] = !first
    ? "not-seen"
    : first.window.startsWith("B")
      ? "on-at-spawn"
      : "on-after-screenshot";
  const delta = { spawnedIdle: dOf("B"), afterScreenshot: dOf("C") };
  const verdict =
    stream === "on-at-spawn"
      ? "stream=on: simulator-server opens its screen stream at spawn (first lifecycle line in window B, before any screenshot), so every headless agent that taps runs it"
      : stream === "on-after-screenshot"
        ? "stream=on after the first screenshot: spawn alone does not open it (first lifecycle line in window C)"
        : debugLogHonoured
          ? "stream=not seen: debug log honoured but no stream lifecycle line"
          : "stream=undetermined from the log (the debug filter was not honoured)";
  return {
    workload: `${PROBE_SWIPES}× adb input swipe up+down on the Settings root, 0.7 s apart`,
    windows,
    firstStreamLineWindow: first ? first.window : null,
    debugLogHonoured,
    streamLineSamples: lines
      .filter((x) => STREAM_LINE.test(x.line))
      .slice(0, 10)
      .map((x) => `${x.window}: ${x.line}`),
    qemuDeltaVsNoServerPct: delta,
    stream,
    verdict,
    cpuDeltaCaveat: PROBE_CPU_DELTA_CAVEAT,
  };
}

// Review 2026-10-07 finding 3: an ON block with any open-server "falling back" line
// measured (part of) the proprietary path. Throws so the process exits non-zero.
function assertNoOpenServerFallback(blocks: BlockResult[]): void {
  const bad = blocks.filter((b) => b.config === "ON" && b.openServerFallbacks.count > 0);
  if (!bad.length) return;
  throw new Error(
    "open-server fallback on ON block(s): " +
      bad
        .map(
          (b) =>
            `${b.block}=${b.openServerFallbacks.count} (first: ${b.openServerFallbacks.samples[0] ?? "?"})`
        )
        .join(" | ")
  );
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
  // Phase 3n.2 (scrcpy removed): FOUR blocks (P0). Every ON block shares the open
  // Kotlin describe/state path; they differ only in the tap/swipe/gesture injection
  // strategy. `ON-uiautomation` is the mandatory CONTROL block (P0) — the pre-3n.1
  // Kotlin DEFAULT path, selected by the `default` sentinel (host sends no `inject`).
  // `ON-input-manager` is the shipped default. OFF-1/OFF-2 are the PROPRIETARY blocks
  // every gate is graded against (P1). Tuple: [name, config, injectStrategy?] where
  // injectStrategy is the `ARGENT_OPEN_INJECT_STRATEGY` value ("default" = the
  // sentinel for the old Kotlin DEFAULT). The scrcpy fast-inject arm was removed.
  //
  // Re-baseline (0.27): `OFF-legacy` is the same proprietary OFF config run against an
  // OLDER release's binaries. The harness has one binary set per process (the
  // ARGENT_SIMULATOR_SERVER_DIR / ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR env), so the
  // workflow runs it as its own BENCH_ONLY invocation with the legacy dirs, as the
  // LAST block (after OFF-2, outside the OFF-1↔OFF-2 drift interval); the
  // single-process full run skips it (it would just repeat OFF on the same binaries).
  //
  // Review 2026-10-07 run 37591260027 ("Next run"): interleaved ABBA with three blocks per
  // main arm, in this order: OFF-1, ON-im-1, ON-uia, OFF-2, ON-im-2, OFF-3, ON-im-3,
  // OFF-legacy. ON-im-N = the input-manager candidate, ON-uia = the UiAutomation control
  // (one block), OFF-N = the current proprietary release. The pre-ABBA names
  // (ON-uiautomation, ON-input-manager) stay accepted under BENCH_ONLY.
  //
  // Review run 37609765062: the default order swaps ON-uia and OFF-legacy for the diagnostic
  // arms ON-im-bg and ON-hostawait (BG_SIMSERVER_BLOCKS, HOST_AWAIT_BLOCKS): OFF-1, ON-im-1,
  // ON-im-bg, OFF-2, ON-im-2, ON-hostawait, OFF-3, ON-im-3. ON-uia and OFF-legacy stay
  // runnable by name.
  const ABBA_BLOCKS: Array<[string, "OFF" | "ON", (OpenInjectStrategy | "default")?]> = [
    ["OFF-1", "OFF"],
    ["ON-im-1", "ON", "input-manager"],
    ["ON-im-bg", "ON", "input-manager"],
    ["OFF-2", "OFF"],
    ["ON-im-2", "ON", "input-manager"],
    ["ON-hostawait", "ON", "input-manager"],
    ["OFF-3", "OFF"],
    ["ON-im-3", "ON", "input-manager"],
  ];
  const ALL_BLOCKS: Array<[string, "OFF" | "ON", (OpenInjectStrategy | "default")?]> = [
    ...ABBA_BLOCKS,
    ["ON-uia", "ON", "default"],
    ["OFF-legacy", "OFF"],
    ["ON-uiautomation", "ON", "default"],
    ["ON-input-manager", "ON", "input-manager"],
  ];
  const only = process.env.BENCH_ONLY;
  // Part A (run 37591260027 finding 1): the proprietary background probe, not a block.
  if (only === PROBE_BG) {
    const probe = await runPropBackgroundProbe();
    const probePath = join(OUT_DIR, "prop-background.json");
    writeFileSync(probePath, JSON.stringify({ env, probe }, null, 2));
    realDebug(`[bench] wrote ${probePath}: ${probe.verdict}`);
    return;
  }
  // Phase 3n.2 (Q7): refuse a scrcpy arm name outright — the ON-scrcpy block and its
  // fast-inject backend no longer exist.
  if (only && /scrcpy/i.test(only))
    throw new Error(`BENCH_ONLY="${only}" names a removed scrcpy arm (removed in phase 3n.2)`);
  const toRun = only ? ALL_BLOCKS.filter(([b]) => b === only) : ABBA_BLOCKS;
  if (only && toRun.length === 0)
    throw new Error(`BENCH_ONLY="${only}" is not one of ${ALL_BLOCKS.map(([b]) => b).join("|")}`);

  const blocks: BlockResult[] = [];
  for (const [block, config, injectStrategy] of toRun) {
    realDebug(
      `[bench] === block ${block} (${config}` +
        `${injectStrategy ? `, inject=${injectStrategy}` : ""}) ===`
    );
    const r = await runBlockReleasing(block, config, injectStrategy);
    // Finding 11: hashed after the block, while its device-side APK is still installed.
    r.buildProvenance = buildProvenance(config);
    realDebug(`[bench][${block}] buildProvenance ${JSON.stringify(r.buildProvenance)}`);
    blocks.push(r);
    // Per-block summary: the open-server fallback lines over the timed verbs and over
    // the whole block (finding 3; input-manager→uia-async is reported on-device via
    // injectStrategyReported) plus effect-check counts, so bench-log-<block>.txt shows
    // the block ran clean without digging into the JSON.
    const fbTotal = (r.verbs || []).reduce((s, v) => s + (v.fallbacks || 0), 0);
    realDebug(
      `[bench][${block}] openServerFallbacks(timed verbs)=${fbTotal} ` +
        `openServerFallbacks(block)=${r.openServerFallbacks.count} ` +
        `expectedInjectRpcs=${r.expectedInjectRpcs} ` +
        `oracleSelfTest=${r.oracleSelfTestPassed ? "pass" : "FAILED"} ` +
        `firstTapNoEffect=${r.firstTapNoEffectTotal}/${r.effectCheckedTotal} ` +
        `locateFailed=${r.locateFailedTotal} coordMoved=${r.coordMovedTotal} ` +
        `locateVia(dump/describe)=${r.locateViaTotal.dump}/${r.locateViaTotal.describe} ` +
        `originLost=${r.originLostTotal} ` +
        `tapFrames=${r.injectedTapTimeline.frameCount}(move=${r.injectedTapTimeline.hasMoveFrame})`
    );
    realDebug(
      `[bench] ${block} done: describe p50=${r.verbs[0]?.latency.p50}ms source=${r.describeSample.source} ` +
        `screenshot=${r.screenshot.bytes}b cold=${JSON.stringify(r.coldStartMs)} rss=${r.simServerRssKb}`
    );
  }

  // reset flag to default OFF
  unsetFlag("open-device-server", "project");

  if (only) {
    const blockPath = join(OUT_DIR, `bench-block-${only}.json`);
    writeFileSync(blockPath, JSON.stringify({ env, block: blocks[0] }, null, 2));
    realDebug(`[bench] wrote ${blockPath}`);
    process.stdout.write(`RESULT_JSON=${blockPath}\n`);
    // NOTE: under BENCH_ONLY the block does NOT throw on effectZero > 0 — every
    // block must run and write its JSON so the merge can report ALL four per-block
    // counts and fail at the END (ON fatal, OFF tolerated). A per-block throw here
    // aborted the CI step at the first failing block and hid a later block's result.
    // Review 2026-10-07 finding 3: an ON block that left the open path DOES fail its
    // process (after the JSON is written), so run_block records it INVALID.
    // Run 37571460849: an empty describe inside a timed verb no longer fails the
    // process (P11 grades the rate in the merge).
    assertNoOpenServerFallback(blocks);
    return;
  }

  // Parity gate: every block must have driven the identical gesture timeline, so
  // the OFF/ON latency comparison is genuinely like-for-like (throws otherwise).
  assertIdenticalGestureParams(blocks);
  assertNoOpenServerFallback(blocks);
  // Tap-timeline parity (phase 3h): same authored holdMs everywhere; a clean
  // two-frame DOWN→UP with NO MOVE on any arm. Recorded from the real injected shape.
  assertTapTimelineParity(blocks);
  // Effect gate across blocks: no block may have a no-effect tap iteration.
  const effectZeroByBlock = blocks
    .filter((b) => b.effectZeroTotal > 0)
    .map((b) => `${b.block}=${b.effectZeroTotal}`);
  if (effectZeroByBlock.length) {
    throw new Error(`no-effect tap iterations detected: ${effectZeroByBlock.join(", ")}`);
  }

  const off1 = blocks.find((b) => b.block === "OFF-1")!;
  // Fidelity (describe tree) is identical for every ON block — the injection
  // strategy only changes touch injection, not the describe path — so compare OFF-1
  // against the first ON block present (phase 3n: the arm names vary now).
  const on = blocks.find((b) => b.config === "ON")!;
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
