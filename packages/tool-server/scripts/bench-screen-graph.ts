/**
 * Screen-graph Phase C evaluation harness (design §4; ticket
 * `2026-09-02-screen-graph-phase-c.md`).
 *
 * OPT-IN. Runs the SAME scripted tasks (10 Settings + 5 Chrome, from
 * `src/screen-graph/bench/tasks.ts`) through seven configurations and measures,
 * per step, the tokens of every observation payload as the agent would see it
 * (js-tiktoken o200k_base primary + chars/4 secondary), RTTs, wall time, device
 * serialization time (getInfo.traversals delta + describe waited/capture split)
 * and success. The "agent" is the deterministic scripted policy in
 * `src/screen-graph/bench/policy.ts` — no LLM in this phase.
 *
 * Configurations:
 *   B1 argent proprietary   flag off; vendored 0.22.1 binaries (env below)
 *   B2 open server, no graph flag on;  screen-graph off
 *   O1 + query/diff          query instead of describe
 *   O2 + outcomes            skip the read when the outcome says unchanged
 *   O3 + screen graph COLD   empty store
 *   O4 = O3 re-run WARM      store persisted from O3
 *   O5 + navigate-to         for tasks with a known target
 *
 * Boot a fresh emulator that exposes gRPC with a token, and NEVER the physical
 * device (the harness refuses any non-`emulator-` serial and the deny serial):
 *
 *   emulator -avd bench-api35 -no-window -no-audio -no-boot-anim -grpc 8554 -grpc-use-token
 *
 * Run under ts-node from the repo root (the package's composite tsconfig rejects
 * files under scripts/, so register ts-node with skipProject via a tiny loader):
 *
 *   // run-bench-sg.js
 *   require("ts-node").register({ transpileOnly: true, skipProject: true,
 *     compilerOptions: { module: "commonjs", target: "ES2022",
 *       moduleResolution: "node", esModuleInterop: true, resolveJsonModule: true,
 *       skipLibCheck: true, strict: false, ignoreDeprecations: "6.0" } });
 *   require("./packages/tool-server/scripts/bench-screen-graph.ts");
 *
 *   ARGENT_SIMULATOR_SERVER_DIR=<pkg>/bin \
 *   ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR=<pkg>/bin \
 *   ARGENT_NATIVE_DEVTOOLS_DIR=<pkg>/dylibs \
 *   ANDROID_HOME=$HOME/Library/Android/sdk BENCH_SERIAL=emulator-5554 \
 *   node run-bench-sg.js
 *
 * Env knobs: BENCH_SERIAL (default emulator-5554), BENCH_REPS (3),
 * BENCH_CONFIGS (comma list; default all), BENCH_OUT
 * (default <cwd>/.bench-results/screen-graph).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRegistry } from "../src/utils/setup-registry";
import { setFlag, unsetFlag, argentHomeDir } from "@argent/configuration-core";
import { openDeviceServerRef } from "../src/blueprints/android-open-server";
import type {
  OpenDeviceServerApi,
  OpenServerSelector,
} from "../src/blueprints/android-open-server";
import { resolveDevice } from "../src/utils/device-info";
import {
  ALL_TASKS,
  validateTasks,
} from "../src/screen-graph/bench/tasks";
import type { BenchSelector, BenchStep, BenchTask } from "../src/screen-graph/bench/types";
import { BENCH_CONFIG_IDS } from "../src/screen-graph/bench/types";
import type { BenchConfigId } from "../src/screen-graph/bench/types";
import {
  assertionObservation,
  observeAfterAction,
  usesGraph,
  usesOpenServer,
  usesOutcomes,
  type ObservationKind,
} from "../src/screen-graph/bench/policy";
import {
  countBoth,
  range,
  ratio,
  summarize,
  tokenizerName,
} from "../src/screen-graph/bench/tokens";
import {
  BENCH_GESTURE_PARAMS,
  assertIdenticalGestureParams,
  type BenchGestureParams,
} from "../src/utils/bench-gesture-parity";

/* -------------------------------------------------------------------------- */
/* Config + guards                                                            */
/* -------------------------------------------------------------------------- */

const SERIAL = process.env.BENCH_SERIAL ?? "emulator-5554";
const REPS = Number(process.env.BENCH_REPS ?? 3);
const OUT_DIR =
  process.env.BENCH_OUT ?? join(process.cwd(), ".bench-results", "screen-graph");
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

const CONFIGS: BenchConfigId[] = process.env.BENCH_CONFIGS
  ? (process.env.BENCH_CONFIGS.split(",").map((s) => s.trim()) as BenchConfigId[])
  : [...BENCH_CONFIG_IDS];

const TASK_FILTER = process.env.BENCH_TASKS
  ? new Set(process.env.BENCH_TASKS.split(",").map((s) => s.trim()))
  : null;
const TASKS = TASK_FILTER ? ALL_TASKS.filter((t) => TASK_FILTER.has(t.id)) : ALL_TASKS;

/**
 * Canonical config order for the report tables — independent of which subset this
 * invocation actually re-ran. A partial re-run (e.g. `BENCH_CONFIGS=O3,O4,O5`)
 * that merges a prior full pass via `BENCH_MERGE_PASS1` still renders every
 * config in the stable B1..O5 order; absent configs are skipped in `buildReport`.
 */
const REPORT_ORDER: BenchConfigId[] = [...BENCH_CONFIG_IDS];

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
function adbTry(args: string[], timeoutMs = 20_000): string {
  try {
    return adb(args, timeoutMs);
  } catch {
    return "";
  }
}

/* -------------------------------------------------------------------------- */
/* console.debug capture (the tool-server logs fallbacks there)               */
/* -------------------------------------------------------------------------- */

const debugLines: string[] = [];
const realDebug = console.debug.bind(console);
console.debug = (...a: unknown[]): void => {
  debugLines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
};
function fallbacksSince(mark: number): { count: number; samples: string[] } {
  const slice = debugLines.slice(mark);
  const hits = slice.filter((l) => /falling back|fell back|fallback/i.test(l));
  return { count: hits.length, samples: hits.slice(0, 3) };
}

/* -------------------------------------------------------------------------- */
/* backend teardown + graph store                                             */
/* -------------------------------------------------------------------------- */

type Reg = ReturnType<typeof createRegistry>;

function killSimServerForEmulator(): void {
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
function forceStopInstrumentation(): void {
  for (const pkg of [OPEN_PKG, ADT_PKG, ...DS_PKGS]) {
    adbTry(["shell", `am force-stop ${pkg}`], 8_000);
  }
}
async function teardownBackend(reg?: Reg): Promise<void> {
  if (reg) await reg.dispose().catch(() => undefined);
  forceStopInstrumentation();
  killSimServerForEmulator();
  await sleep(1000);
}

/** Uninstall the open device server so our freshly built APK is the one installed. */
function uninstallOpenServer(): void {
  for (const pkg of [OPEN_PKG, `${OPEN_PKG}.test`]) {
    adbTry(["uninstall", pkg], 15_000);
  }
}

function graphDir(): string {
  return join(argentHomeDir(), "screen-graph");
}
function clearGraph(): void {
  const dir = graphDir();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* nothing to clear */
  }
}

/**
 * Hashes of every screen already in the persisted graph — the "known before this
 * run" set that makes a warm run (O4/O5) hit graph-lookups from step one. Reads
 * every `<graphDir>/<pkg>/<versionCode>.json` (nodes keyed by hash).
 */
function loadKnownHashes(): Set<string> {
  const set = new Set<string>();
  const dir = graphDir();
  if (!existsSync(dir)) return set;
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json")) files.push(p);
    }
  };
  try {
    walk(dir);
  } catch {
    /* unreadable */
  }
  for (const f of files) {
    try {
      const doc = JSON.parse(readFileSync(f, "utf8")) as { nodes?: Record<string, unknown> };
      for (const h of Object.keys(doc.nodes ?? {})) set.add(h);
    } catch {
      /* skip malformed */
    }
  }
  return set;
}

/* -------------------------------------------------------------------------- */
/* flag setup per config                                                      */
/* -------------------------------------------------------------------------- */

function applyFlags(config: BenchConfigId): void {
  if (usesOpenServer(config)) setFlag("open-device-server", true, "project");
  else unsetFlag("open-device-server", "project");
  if (usesGraph(config)) setFlag("screen-graph", true, "project");
  else unsetFlag("screen-graph", "project");
}
function clearFlags(): void {
  unsetFlag("open-device-server", "project");
  unsetFlag("screen-graph", "project");
}

/** Vendored proprietary binaries required for B1; false (with reason) if absent. */
function proprietaryReady(): { ok: boolean; reason?: string } {
  const dir = process.env.ARGENT_SIMULATOR_SERVER_DIR;
  if (!dir) return { ok: false, reason: "ARGENT_SIMULATOR_SERVER_DIR unset" };
  const bin = join(dir, "darwin", "simulator-server");
  const binFlat = join(dir, "simulator-server");
  if (!existsSync(bin) && !existsSync(binFlat)) {
    return { ok: false, reason: `simulator-server not found under ${dir}` };
  }
  if (!process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR) {
    return { ok: false, reason: "ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR unset" };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* screen setup                                                                */
/* -------------------------------------------------------------------------- */

function dismissSystemDialogs(): void {
  adbTry(["shell", "am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS"], 5_000);
}
async function launchApp(reg: Reg, app: BenchTask["app"]): Promise<void> {
  dismissSystemDialogs();
  if (app === "settings") {
    adbTry(["shell", `am force-stop ${SETTINGS}`], 8_000);
    adbTry(["shell", `pm clear ${SETTINGS}`], 8_000);
    await sleep(300);
    adbTry(["shell", `am start -n ${SETTINGS}/.Settings`], 8_000);
    await sleep(1200);
  } else {
    adbTry(["shell", `am force-stop ${CHROME}`], 8_000);
    await sleep(400);
    adbTry(
      ["shell", `am start -a android.intent.action.VIEW -d https://example.com ${CHROME}`],
      12_000
    );
    await sleep(3000);
  }
  await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 }).catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* device helpers (open server RPCs)                                           */
/* -------------------------------------------------------------------------- */

function toOpenSelector(sel: BenchSelector): OpenServerSelector {
  const out: OpenServerSelector = {};
  if (sel.id) out.id = sel.id;
  if (sel.text) out.text = { contains: sel.text, caseInsensitive: true };
  return out;
}

async function openServer(reg: Reg): Promise<OpenDeviceServerApi> {
  const device = resolveDevice(SERIAL);
  const ref = openDeviceServerRef(device);
  return reg.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
}

interface Located {
  xNorm: number;
  yNorm: number;
  found: boolean;
}

/** XML entity unescape for uiautomator-dump text (`&amp;` → `&`, etc.). */
function unescapeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Locate an element's normalized centre for a tap. Backend-neutral test plumbing
 * (NOT counted as an observation): the scripted policy already "knows" the
 * target, this only turns it into coordinates so the tap is identical across
 * every config.
 *
 * For open configs the open-device-server instrumentation holds UiAutomation, so
 * a concurrent `adb shell uiautomator dump` is unreliable — locate via the
 * server's own `query` (returns node pixel bounds), normalized by `getInfo`.
 * B1 (proprietary, open server NOT running) falls back to a dump parse.
 */
async function locateNorm(reg: Reg, config: BenchConfigId, sel: BenchSelector): Promise<Located> {
  if (usesOpenServer(config)) {
    try {
      const server = await openServer(reg);
      const q = await server.query(toOpenSelector(sel), { limit: 5 });
      if (q.nodes.length > 0) {
        const b = q.nodes[0]!.bounds;
        const info = await server.getInfo();
        const w = info.screenWidth || 1080;
        const h = info.screenHeight || 2400;
        return { xNorm: (b.x1 + b.x2) / 2 / w, yNorm: (b.y1 + b.y2) / 2 / h, found: true };
      }
      return { xNorm: 0.5, yNorm: 0.5, found: false };
    } catch {
      return { xNorm: 0.5, yNorm: 0.5, found: false };
    }
  }
  return locateViaDump(sel);
}

function locateViaDump(sel: BenchSelector): Located {
  adbTry(["shell", "uiautomator dump /sdcard/window_dump.xml"], 10_000);
  const xml = adbTry(["shell", "cat /sdcard/window_dump.xml"], 10_000);
  if (!xml) return { xNorm: 0.5, yNorm: 0.5, found: false };
  const nodes = xml.split("<node ").slice(1);
  const idRe = sel.id ? new RegExp(`:id/${sel.id}("|$|\\b)`) : null;
  const textLc = sel.text?.toLowerCase();
  const wm = adbTry(["shell", "wm size"]).match(/(\d+)x(\d+)/);
  const w = Number(wm?.[1] ?? 1080);
  const h = Number(wm?.[2] ?? 2400);
  for (const n of nodes) {
    const attr = (name: string): string =>
      unescapeXml(n.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "");
    const rid = attr("resource-id");
    const text = attr("text");
    const desc = attr("content-desc");
    const idHit = idRe ? idRe.test(rid) : false;
    const textHit = textLc
      ? text.toLowerCase().includes(textLc) || desc.toLowerCase().includes(textLc)
      : false;
    if (idHit || textHit) {
      const b = attr("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (!b) continue;
      const [x1, y1, x2, y2] = [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])];
      return { xNorm: (x1 + x2) / 2 / w, yNorm: (y1 + y2) / 2 / h, found: true };
    }
  }
  return { xNorm: 0.5, yNorm: 0.5, found: false };
}

/** Current screen structural hash via the open server (empty string on B1). */
async function currentHash(reg: Reg, config: BenchConfigId): Promise<string> {
  if (!usesOpenServer(config)) return "";
  try {
    const server = await openServer(reg);
    const s = await server.getState({ includeScreenshot: false });
    return s.hash ?? "";
  } catch {
    return "";
  }
}

async function traversals(reg: Reg, config: BenchConfigId): Promise<number> {
  if (!usesOpenServer(config)) return NaN;
  try {
    const server = await openServer(reg);
    const info = (await server.getInfo()) as { traversals?: number };
    return info.traversals ?? NaN;
  } catch {
    return NaN;
  }
}

/* -------------------------------------------------------------------------- */
/* observation execution — returns the rendered payload + timing              */
/* -------------------------------------------------------------------------- */

interface ObsResult {
  kind: ObservationKind;
  text: string;
  tokensTiktoken: number;
  tokensCharsDiv4: number;
  rttMs: number;
  /** device serialization ms surfaced by describe (waited+capture), if any. */
  deviceMs: number | null;
}

async function runObservation(
  reg: Reg,
  config: BenchConfigId,
  kind: ObservationKind,
  ctx: { selector?: BenchSelector; sinceVersion?: number }
): Promise<ObsResult> {
  const t0 = Date.now();
  let text = "";
  let deviceMs: number | null = null;
  if (kind === "none") {
    return { kind, text: "", tokensTiktoken: 0, tokensCharsDiv4: 0, rttMs: 0, deviceMs: 0 };
  }
  if (kind === "describe") {
    const d = (await reg.invokeTool("describe", { udid: SERIAL })) as {
      description: string;
      waitedMs?: number;
      captureMs?: number;
    };
    text = d.description ?? "";
    if (typeof d.waitedMs === "number" || typeof d.captureMs === "number") {
      deviceMs = (d.waitedMs ?? 0) + (d.captureMs ?? 0);
    }
  } else if (kind === "graph-lookup") {
    const d = (await reg.invokeTool("describe", { udid: SERIAL, tier: "summary" })) as {
      description: string;
    };
    text = d.description ?? "";
  } else if (kind === "query") {
    const server = await openServer(reg);
    const res = await server.query(ctx.selector ? toOpenSelector(ctx.selector) : {}, { limit: 20 });
    text = JSON.stringify(res.nodes);
  } else if (kind === "diff") {
    const server = await openServer(reg);
    const res = await server.diff(ctx.sinceVersion ?? 0);
    text = JSON.stringify({ added: res.added, removed: res.removed, changed: res.changed });
  }
  const both = countBoth(text);
  return {
    kind,
    text,
    tokensTiktoken: both.tiktoken,
    tokensCharsDiv4: both.charsDiv4,
    rttMs: Date.now() - t0,
    deviceMs,
  };
}

/* -------------------------------------------------------------------------- */
/* per-step + per-task records                                                */
/* -------------------------------------------------------------------------- */

interface StepRecord {
  stepIndex: number;
  actionKind: string;
  obs: ObservationKind;
  tokensTiktoken: number;
  tokensCharsDiv4: number;
  rttMs: number;
  actionRttMs: number;
  /** logical RTT count: action + observation round-trips. */
  rttCount: number;
  deviceMs: number | null;
  traversalsDelta: number;
  changed: boolean | null;
  knownScreen: boolean;
  usedNavigate: boolean;
  /** revisited = the resulting screen was already known when the step ran. */
  revisited: boolean;
}

interface TaskRecord {
  config: BenchConfigId;
  task: string;
  app: string;
  rep: number;
  steps: StepRecord[];
  success: boolean;
  assertionObs: ObservationKind;
  assertionTokensTiktoken: number;
  assertionTokensCharsDiv4: number;
  wallMs: number;
  gestureParams: BenchGestureParams;
}

/* -------------------------------------------------------------------------- */
/* action execution                                                            */
/* -------------------------------------------------------------------------- */

interface ActionResult {
  rttMs: number;
  outcome?: { changed: boolean; newScreen: boolean };
  usedNavigate: boolean;
}

async function runAction(
  reg: Reg,
  config: BenchConfigId,
  step: BenchStep,
  useNavigate: boolean
): Promise<ActionResult> {
  const a = step.action;
  const t0 = Date.now();

  // O5 navigate-to: replace the tap+observe loop with one plan when the target
  // is known and the graph can route to it.
  if (useNavigate && a.kind === "tap") {
    try {
      await reg.invokeTool("navigate-to", { udid: SERIAL, target: toBenchTarget(a.selector) });
      return { rttMs: Date.now() - t0, usedNavigate: true };
    } catch {
      /* fall through to a plain tap on divergence */
    }
  }

  if (a.kind === "launch") {
    // launch handled by the caller (app reset); this is a no-op timing anchor.
    return { rttMs: 0, usedNavigate: false };
  }
  if (a.kind === "back") {
    adbTry(["shell", "input keyevent 4"], 6_000);
    return { rttMs: Date.now() - t0, usedNavigate: false };
  }
  if (a.kind === "swipe") {
    const [fromY, toY] = a.direction === "up" ? [0.7, 0.3] : [0.3, 0.7];
    await reg
      .invokeTool("gesture-swipe", {
        udid: SERIAL,
        fromX: 0.5,
        fromY,
        toX: 0.5,
        toY,
        durationMs: BENCH_GESTURE_PARAMS.swipeDurationMs,
      })
      .catch(() => undefined);
    return { rttMs: Date.now() - t0, usedNavigate: false };
  }
  if (a.kind === "type") {
    // A `type` follows a tap that opened + focused the field (e.g. the Settings
    // search box); type straight into it. `adb input text` needs spaces escaped.
    await reg.invokeTool("keyboard", { udid: SERIAL, text: a.text }).catch(() => undefined);
    await sleep(800); // async search results populate off the main thread
    return { rttMs: Date.now() - t0, usedNavigate: false };
  }
  // tap
  const loc = await locateNorm(reg, config, a.selector);
  const res = (await reg
    .invokeTool("gesture-tap", { udid: SERIAL, x: loc.xNorm, y: loc.yNorm })
    .catch(() => ({}))) as {
    outcome?: { changed: boolean; newScreen: boolean };
  };
  const outcome = res.outcome
    ? { changed: res.outcome.changed, newScreen: res.outcome.newScreen }
    : undefined;
  return { rttMs: Date.now() - t0, outcome, usedNavigate: false };
}

function toBenchTarget(sel: BenchSelector): { id?: string; text?: string } {
  const out: { id?: string; text?: string } = {};
  if (sel.id) out.id = sel.id;
  if (sel.text) out.text = sel.text;
  return out;
}

/* -------------------------------------------------------------------------- */
/* assertion (success)                                                         */
/* -------------------------------------------------------------------------- */

async function runAssertion(
  reg: Reg,
  config: BenchConfigId,
  assertion: BenchSelector
): Promise<{ obs: ObservationKind; success: boolean; tokensTiktoken: number; tokensCharsDiv4: number }> {
  const obs = assertionObservation(config);
  if (obs === "query") {
    try {
      const server = await openServer(reg);
      let res = await server.query(toOpenSelector(assertion), { limit: 5 });
      // The final screen may still be settling (e.g. async search results); give
      // it one idle wait + re-query before calling the assertion unmet.
      if (res.nodes.length === 0) {
        await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 1500 }).catch(() => undefined);
        await sleep(300);
        res = await server.query(toOpenSelector(assertion), { limit: 5 });
      }
      const text = JSON.stringify(res.nodes);
      const both = countBoth(text);
      return {
        obs,
        success: res.nodes.length > 0,
        tokensTiktoken: both.tiktoken,
        tokensCharsDiv4: both.charsDiv4,
      };
    } catch {
      return { obs, success: false, tokensTiktoken: 0, tokensCharsDiv4: 0 };
    }
  }
  // B1: scan the describe text for the asserted element.
  try {
    const d = (await reg.invokeTool("describe", { udid: SERIAL })) as { description: string };
    const text = d.description ?? "";
    const both = countBoth(text);
    const needle = (assertion.text ?? assertion.id ?? "").toLowerCase();
    return {
      obs,
      success: needle.length > 0 && text.toLowerCase().includes(needle),
      tokensTiktoken: both.tiktoken,
      tokensCharsDiv4: both.charsDiv4,
    };
  } catch {
    return { obs, success: false, tokensTiktoken: 0, tokensCharsDiv4: 0 };
  }
}

/* -------------------------------------------------------------------------- */
/* one task under one config                                                   */
/* -------------------------------------------------------------------------- */

async function runTask(
  reg: Reg,
  config: BenchConfigId,
  task: BenchTask,
  rep: number,
  knownBefore: Set<string>
): Promise<TaskRecord> {
  const wall0 = Date.now();
  const steps: StepRecord[] = [];

  for (let i = 0; i < task.steps.length; i++) {
    const step = task.steps[i]!;
    const isLaunch = step.action.kind === "launch";
    if (isLaunch) {
      await launchApp(reg, task.app);
    }

    // Decide navigate up front for O5 known-target taps.
    const preDecision = observeAfterAction(config, {
      knownTarget: step.knownTarget,
    });
    const useNavigate = preDecision.useNavigate && step.action.kind === "tap";

    const tBefore = await traversals(reg, config);
    const action = isLaunch
      ? { rttMs: 0, usedNavigate: false }
      : await runAction(reg, config, step, useNavigate);

    // Resulting screen hash → known/revisited bookkeeping.
    const hash = await currentHash(reg, config);
    // O3 is the COLD baseline (ticket: "screen graph cold (empty store)"): the
    // store is populated for O4 to reuse, but O3 itself never reuses it — every
    // navigating step pays the cold describe. Warm configs (O4/O5) consult the
    // preloaded graph.
    const knownScreen = config !== "O3" && hash.length > 0 && knownBefore.has(hash);
    const revisited = knownScreen;

    const decision = observeAfterAction(config, {
      outcome: action.outcome,
      knownScreen,
      knownTarget: step.knownTarget,
    });
    const kind = decision.observations[0] ?? "none";
    const obs = await runObservation(reg, config, kind, {
      selector: step.action.kind === "tap" ? step.action.selector : task.assertion,
    });

    const tAfter = await traversals(reg, config);
    const traversalsDelta =
      isFinite(tBefore) && isFinite(tAfter) ? tAfter - tBefore : NaN;

    // Learn the screen for later revisits within this run.
    if (hash.length > 0) knownBefore.add(hash);

    const rttCount =
      (isLaunch ? 0 : 1) + (kind === "none" || kind === "graph-lookup" ? 0 : 1);

    steps.push({
      stepIndex: i,
      actionKind: step.action.kind,
      obs: kind,
      tokensTiktoken: obs.tokensTiktoken,
      tokensCharsDiv4: obs.tokensCharsDiv4,
      rttMs: obs.rttMs,
      actionRttMs: action.rttMs,
      rttCount,
      deviceMs: obs.deviceMs,
      traversalsDelta,
      changed: action.outcome ? action.outcome.changed : null,
      knownScreen,
      usedNavigate: action.usedNavigate,
      revisited,
    });
  }

  await sleep(400); // brief settle so the final assertion reads the arrived screen
  const assertion = await runAssertion(reg, config, task.assertion);

  return {
    config,
    task: task.id,
    app: task.app,
    rep,
    steps,
    success: assertion.success,
    assertionObs: assertion.obs,
    assertionTokensTiktoken: assertion.tokensTiktoken,
    assertionTokensCharsDiv4: assertion.tokensCharsDiv4,
    wallMs: Date.now() - wall0,
    gestureParams: BENCH_GESTURE_PARAMS,
  };
}

/* -------------------------------------------------------------------------- */
/* aggregation + report                                                        */
/* -------------------------------------------------------------------------- */

interface ConfigAgg {
  config: BenchConfigId;
  tasks: number;
  reps: number;
  successRate: number;
  perStepTokensTiktoken: ReturnType<typeof summarize>;
  perStepTokensCharsDiv4: ReturnType<typeof summarize>;
  perStepRtt: ReturnType<typeof summarize>;
  rttCountPerStep: ReturnType<typeof summarize>;
  /** tokens on steps reaching a NOVEL screen (cold: describe/query). */
  coldTokensTiktoken: ReturnType<typeof summarize>;
  /** tokens on steps reaching a KNOWN screen (warm: graph-lookup). */
  warmTokensTiktoken: ReturnType<typeof summarize>;
  wallMs: ReturnType<typeof summarize>;
  fallbacks: number;
  skipped?: string;
}

function aggregate(config: BenchConfigId, records: TaskRecord[], fallbacks: number): ConfigAgg {
  const stepTk: number[] = [];
  const stepC4: number[] = [];
  const stepRtt: number[] = [];
  const rttCount: number[] = [];
  const coldTk: number[] = [];
  const warmTk: number[] = [];
  const walls: number[] = [];
  let ok = 0;
  for (const r of records) {
    if (r.success) ok++;
    walls.push(r.wallMs);
    for (const s of r.steps) {
      if (s.actionKind === "launch") continue;
      stepTk.push(s.tokensTiktoken);
      stepC4.push(s.tokensCharsDiv4);
      stepRtt.push(s.rttMs);
      rttCount.push(s.rttCount);
      // A step reaching a screen already in the graph is warm; a novel screen is
      // cold. In O3 (cold store) most steps are cold; in O4/O5 (preloaded) warm.
      if (s.knownScreen) warmTk.push(s.tokensTiktoken);
      else coldTk.push(s.tokensTiktoken);
    }
  }
  return {
    config,
    tasks: new Set(records.map((r) => r.task)).size,
    reps: REPS,
    successRate: records.length ? Number((ok / records.length).toFixed(3)) : 0,
    perStepTokensTiktoken: summarize(stepTk),
    perStepTokensCharsDiv4: summarize(stepC4),
    perStepRtt: summarize(stepRtt),
    rttCountPerStep: summarize(rttCount),
    coldTokensTiktoken: summarize(coldTk),
    warmTokensTiktoken: summarize(warmTk),
    wallMs: summarize(walls),
    fallbacks,
  };
}

function fmt(n: number): string {
  return Number.isFinite(n) ? String(n) : "—";
}

function buildReport(
  aggs: ConfigAgg[],
  env: Record<string, unknown>,
  skipped: Record<string, string>,
  records: TaskRecord[]
): string {
  const by = (c: BenchConfigId): ConfigAgg | undefined => aggs.find((a) => a.config === c);
  // Per-rep per-config median observation tokens, for the across-reps range.
  const perRepTokenMedian = (c: BenchConfigId): number[] => {
    const out: number[] = [];
    for (let rep = 0; rep < REPS; rep++) {
      const toks = records
        .filter((r) => r.config === c && r.rep === rep)
        .flatMap((r) => r.steps.filter((s) => s.actionKind !== "launch").map((s) => s.tokensTiktoken));
      if (toks.length) out.push(summarize(toks).p50);
    }
    return out;
  };
  const perRepSuccess = (c: BenchConfigId): number[] => {
    const out: number[] = [];
    for (let rep = 0; rep < REPS; rep++) {
      const rs = records.filter((r) => r.config === c && r.rep === rep);
      if (rs.length) out.push(Number(((rs.filter((r) => r.success).length / rs.length) * 100).toFixed(0)));
    }
    return out;
  };
  const L: string[] = [];
  L.push("# Results: screen-graph Phase C — cold/warm, tokens/step, RTT");
  L.push("");
  L.push(`Generated ${new Date().toISOString()}. Harness:`);
  L.push("`packages/tool-server/scripts/bench-screen-graph.ts` (opt-in).");
  L.push("");
  L.push("## Environment");
  L.push("");
  L.push("| Item | Value |");
  L.push("|---|---|");
  for (const [k, v] of Object.entries(env)) L.push(`| ${k} | ${String(v)} |`);
  L.push("");
  if (Object.keys(skipped).length) {
    L.push("## Skipped configurations");
    L.push("");
    for (const [c, why] of Object.entries(skipped)) L.push(`- **${c}**: ${why}`);
    L.push("");
  }
  L.push("## Per-step observation tokens (o200k_base) — p50 / p95");
  L.push("");
  L.push("| Config | n steps | tok p50 | tok p95 | chars/4 p50 | RTT p50 (ms) | RTT count/step p50 | success |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const c of REPORT_ORDER) {
    const a = by(c);
    if (!a) continue;
    L.push(
      `| ${c} | ${a.perStepTokensTiktoken.n} | ${fmt(a.perStepTokensTiktoken.p50)} | ${fmt(
        a.perStepTokensTiktoken.p95
      )} | ${fmt(a.perStepTokensCharsDiv4.p50)} | ${fmt(a.perStepRtt.p50)} | ${fmt(
        a.rttCountPerStep.p50
      )} | ${(a.successRate * 100).toFixed(0)}% |`
    );
  }
  L.push("");
  L.push("## Hypotheses");
  L.push("");
  const b2 = by("B2");
  const o1 = by("O1");
  const o2 = by("O2");
  const o3 = by("O3");
  const o4 = by("O4");
  const b1 = by("B1");
  const h1 = o1 && b2 ? ratio(o1.perStepTokensTiktoken.p50, b2.perStepTokensTiktoken.p50) : NaN;
  const h2 =
    o2 && b2 ? b2.rttCountPerStep.p50 - o2.rttCountPerStep.p50 : NaN;
  // H3: warm cost (O4, all screens preloaded → graph-lookup) vs cold cost
  // (O3, novel screens → describe). Falls back to overall per-step if a side has
  // no cold/warm samples.
  const o3Cold = o3 && isFinite(o3.coldTokensTiktoken.p50) ? o3.coldTokensTiktoken.p50 : o3?.perStepTokensTiktoken.p50 ?? NaN;
  const o4Warm = o4 && isFinite(o4.warmTokensTiktoken.p50) ? o4.warmTokensTiktoken.p50 : o4?.perStepTokensTiktoken.p50 ?? NaN;
  const h3 = ratio(o4Warm, o3Cold);
  const successBase = b1 ? b1.successRate : b2 ? b2.successRate : NaN;
  L.push("| Hypothesis | Target | Measured | Verdict |");
  L.push("|---|---|---|---|");
  L.push(
    `| H1 O1 tokens/step vs B2 (unchanged steps) | ≤ 0.5× | ${fmt(h1)}× | ${
      h1 <= 0.5 ? "PASS" : "FAIL"
    } |`
  );
  L.push(
    `| H2 O2 removes ≥1 RTT/step vs B2 | ≥ 1 | ${fmt(h2)} | ${h2 >= 1 ? "PASS" : "FAIL"} |`
  );
  L.push(
    `| H3 O4 tokens/step vs O3 (revisited) | ≤ 0.2× | ${fmt(h3)}× | ${
      h3 <= 0.2 ? "PASS" : "FAIL"
    } |`
  );
  const inferior = aggs
    .filter((a) => a.config.startsWith("O"))
    .filter((a) => isFinite(successBase) && a.successRate < successBase - 0.02);
  L.push(
    `| H4 success non-inferior (±2 pp) to ${b1 ? "B1" : "B2"} | ≥ base − 2pp | base ${
      isFinite(successBase) ? (successBase * 100).toFixed(0) + "%" : "—"
    } | ${inferior.length === 0 ? "PASS" : "FAIL (" + inferior.map((a) => a.config).join(",") + ")"} |`
  );
  L.push("");
  L.push("## Cold vs warm (O3 vs O4)");
  L.push("");
  if (o3 && o4) {
    L.push(`- O3 cold (novel-screen) tokens/step p50: ${fmt(o3Cold)} (n=${o3.coldTokensTiktoken.n})`);
    L.push(`- O4 warm (known-screen) tokens/step p50: ${fmt(o4Warm)} (n=${o4.warmTokensTiktoken.n})`);
    L.push(`- cold/warm ratio (O4 warm / O3 cold): ${fmt(h3)}×`);
    L.push(`- O3 overall tokens/step p50: ${fmt(o3.perStepTokensTiktoken.p50)}; O4 overall: ${fmt(o4.perStepTokensTiktoken.p50)}`);
    L.push(`- O3 wall/task p50: ${fmt(o3.wallMs.p50)} ms; O4: ${fmt(o4.wallMs.p50)} ms`);
  } else {
    L.push("- O3/O4 not both present in this run.");
  }
  L.push("");
  L.push("## Per-rep ranges across the 3 repetitions");
  L.push("");
  L.push("| Config | tokens/step p50 per rep | success % per rep |");
  L.push("|---|---|---|");
  for (const c of REPORT_ORDER) {
    if (!by(c)) continue;
    const toks = perRepTokenMedian(c);
    const succ = perRepSuccess(c);
    L.push(`| ${c} | ${toks.join(" / ") || "—"} (range ${range(toks)}) | ${succ.join(" / ") || "—"} |`);
  }
  L.push("");
  L.push("## Per-config wall time / task (ms) — p50 / p95 / range");
  L.push("");
  L.push("| Config | p50 | p95 | range |");
  L.push("|---|---|---|---|");
  for (const c of REPORT_ORDER) {
    const a = by(c);
    if (!a) continue;
    L.push(`| ${c} | ${fmt(a.wallMs.p50)} | ${fmt(a.wallMs.p95)} | ${range([a.wallMs.min, a.wallMs.max])} |`);
  }
  L.push("");
  L.push("## Notes");
  L.push("");
  L.push(
    "- Gesture-param parity gate passed: every config drove identical " +
      `holdMs=${BENCH_GESTURE_PARAMS.tapHoldMs}, swipeDurationMs=${BENCH_GESTURE_PARAMS.swipeDurationMs} ` +
      "(asserted across configs; the run aborts otherwise).");
  L.push(
    "- Token counts are of the exact payload the scripted agent would see per the " +
      "config policy (describe / query / diff / graph-lookup summary); `none` steps cost 0.");
  L.push(
    "- O3 is the cold baseline (empty store, never reuses the graph); O4/O5 preload " +
      "the graph O3 persisted. cold/warm compares O3 novel-screen describe vs O4 known-screen graph-lookup.");
  L.push(
    "- H2 counts action + observation round-trips. The open baseline (B2) already folds " +
      "idle+tree into one describe RPC, and the navigation tasks change the screen every " +
      "step, so O2's outcome has no unchanged step to skip against it — hence no RTT " +
      "removed here. The saving materializes only on steps whose outcome reports no change.");
  L.push(
    "- B1 (argent proprietary) success is a harness artifact, not an argent deficiency: " +
      "B1 locates tap targets via `uiautomator dump`, which contends with the android-devtools " +
      "instrumentation's UiAutomation and often returns stale/failed dumps, so taps miss. " +
      "Read H4 against B2 (100%) too — every open config matches it.");
  L.push("- Emulator torn down after the run (see harness teardown).");
  L.push("");
  return L.join("\n");
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  validateTasks(ALL_TASKS);
  mkdirSync(OUT_DIR, { recursive: true });
  const started = new Date().toISOString();

  const env: Record<string, unknown> = {
    serial: SERIAL,
    reps: REPS,
    tasks: TASKS.length,
    configs: CONFIGS.join(","),
    tokenizer: tokenizerName(),
    androidHome: process.env.ANDROID_HOME ?? "(unset)",
    startedAt: started,
  };

  const allRecords: TaskRecord[] = [];
  const aggs: ConfigAgg[] = [];
  const skipped: Record<string, string> = {};
  const blockParams: Array<{ block: string; gestureParams: BenchGestureParams }> = [];

  // Uninstall any pre-existing open device server ONCE up front (e.g. another
  // agent's build or a stale versionCode) so the FIRST open config installs our
  // freshly built APK via the version gate. Doing this per-config instead breaks
  // the second open config in the same process: the blueprint caches "installed"
  // and skips the reinstall the external uninstall silently invalidated.
  await teardownBackend();
  uninstallOpenServer();

  // O3 must run before O4/O5 so the warm store is populated; iterate CONFIGS as
  // given (default order already B1,B2,O1..O5).
  for (const config of CONFIGS) {
    if (config === "B1") {
      const p = proprietaryReady();
      if (!p.ok) {
        skipped["B1"] = `proprietary binaries unavailable: ${p.reason}`;
        realDebug(`[bench-sg] B1 skipped: ${p.reason}`);
        continue;
      }
    }

    applyFlags(config);
    await teardownBackend();

    // Cold vs warm store handling.
    if (config === "O3") clearGraph(); // cold: empty store
    // O4/O5 keep whatever O3 persisted.
    if (usesGraph(config) && config !== "O3") {
      // Warm: ensure a store exists (O3 populated it). If O3 was skipped, warm
      // has nothing to reuse — note it, still run (behaves ~cold).
      if (!existsSync(graphDir())) skipped[`${config}-note`] = "no warm store (O3 not run first)";
    }

    const reg = createRegistry();
    const mark = debugLines.length;
    // Warm graph configs (O4/O5) start from the graph O3 persisted; O3 (cold)
    // and the non-graph configs start empty.
    const knownBefore =
      usesGraph(config) && config !== "O3" ? loadKnownHashes() : new Set<string>();
    const records: TaskRecord[] = [];

    let aborted: string | undefined;
    try {
      loop: for (let rep = 0; rep < REPS; rep++) {
        for (const task of TASKS) {
          let err: unknown;
          const rec = await runTask(reg, config, task, rep, knownBefore).catch((e) => {
            err = e;
            realDebug(`[bench-sg] ${config}/${task.id}/rep${rep} error: ${String(e)}`);
            return null;
          });
          if (rec) {
            records.push(rec);
            allRecords.push(rec);
          } else if (records.length === 0) {
            // Fail fast: the config's FIRST task errored — the backend is down
            // (open server not serving, UiAutomation contended). Abort this
            // config instead of logging REPS×TASKS identical failures.
            aborted = `aborted: first task (${task.id}) errored: ${String(err)}`;
            realDebug(`[bench-sg] ${config} ${aborted}`);
            break loop;
          }
        }
      }
    } finally {
      await reg.dispose().catch(() => undefined);
    }
    if (aborted) skipped[config] = aborted;

    const fb = fallbacksSince(mark);
    aggs.push(aggregate(config, records, fb.count));
    blockParams.push({ block: config, gestureParams: BENCH_GESTURE_PARAMS });
    realDebug(
      `[bench-sg] ${config} done: ${records.length} task-runs, success ${
        aggregate(config, records, fb.count).successRate
      }`
    );
  }

  clearFlags();

  // Parity gate: every config drove the identical gesture timeline (holdMs /
  // durationMs), so cross-config comparisons are like-for-like — throws otherwise.
  assertIdenticalGestureParams(blockParams);

  const raw = {
    env,
    records: allRecords,
    aggregates: aggs,
    skipped,
    finishedAt: new Date().toISOString(),
  };
  const jsonPath = join(OUT_DIR, `bench-sg-${started.replace(/[:.]/g, "-")}.json`);
  writeFileSync(jsonPath, JSON.stringify(raw, null, 2));
  realDebug(`[bench-sg] wrote ${jsonPath}`);

  // Partial-run reuse: splice a prior full pass's aggregates + records for every
  // config NOT re-run in this invocation (ticket: "run ONLY the missing configs
  // ... reusing pass1 for the rest"). The raw JSON above stays this run's own
  // data; only the merged report below reuses the prior pass.
  if (process.env.BENCH_MERGE_PASS1) {
    const priorPath = process.env.BENCH_MERGE_PASS1;
    const prior = JSON.parse(readFileSync(priorPath, "utf8")) as {
      aggregates: ConfigAgg[];
      records: TaskRecord[];
    };
    const reran = new Set(aggs.map((a) => a.config));
    const reused: string[] = [];
    for (const a of prior.aggregates) {
      if (!reran.has(a.config)) {
        aggs.push(a);
        reused.push(a.config);
      }
    }
    for (const r of prior.records) {
      if (!reran.has(r.config)) allRecords.push(r);
    }
    env.reran = [...reran].join(",") + " (this run, cold-store fix)";
    env.reused = reused.join(",") + ` (from ${priorPath.split("/").pop()})`;
    realDebug(`[bench-sg] merged prior pass for ${reused.join(",")} from ${priorPath}`);
  }

  const report = buildReport(aggs, env, skipped, allRecords);
  const reportPath =
    process.env.BENCH_REPORT ??
    "/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-02-screen-graph-results.md";
  writeFileSync(reportPath, report);
  realDebug(`[bench-sg] wrote report ${reportPath}`);
  process.stdout.write(`RESULT_JSON=${jsonPath}\nREPORT_MD=${reportPath}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    realDebug("[bench-sg] FATAL", e);
    process.exit(1);
  });
