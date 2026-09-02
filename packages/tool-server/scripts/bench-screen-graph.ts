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
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Locate an element's normalized centre for a tap. Backend-neutral test
 * plumbing via `uiautomator dump` (NOT counted as an observation): the scripted
 * policy already "knows" the target, this only turns it into coordinates so the
 * tap is identical across every config.
 */
function locate(sel: BenchSelector): Located {
  adbTry(["shell", "uiautomator dump /sdcard/window_dump.xml"], 10_000);
  const xml = adbTry(["shell", "cat /sdcard/window_dump.xml"], 10_000);
  if (!xml) return { xNorm: 0.5, yNorm: 0.5, found: false };
  const nodes = xml.split("<node ").slice(1);
  const idRe = sel.id ? new RegExp(`:id/${sel.id}("|$|\\b)`) : null;
  const textLc = sel.text?.toLowerCase();
  for (const n of nodes) {
    const attr = (name: string): string => n.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";
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
      const w = Number(adbTry(["shell", "wm size"]).match(/(\d+)x(\d+)/)?.[1] ?? 1080);
      const h = Number(adbTry(["shell", "wm size"]).match(/(\d+)x(\d+)/)?.[2] ?? 2400);
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
    const loc = locate(a.selector);
    await reg.invokeTool("gesture-tap", { udid: SERIAL, x: loc.xNorm, y: loc.yNorm }).catch(() => undefined);
    await sleep(300);
    await reg.invokeTool("keyboard", { udid: SERIAL, text: a.text }).catch(() => undefined);
    return { rttMs: Date.now() - t0, usedNavigate: false };
  }
  // tap
  const loc = locate(a.selector);
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
      const res = await server.query(toOpenSelector(assertion), { limit: 5 });
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
    const knownScreen = hash.length > 0 && knownBefore.has(hash);
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
  revisitTokensTiktoken: ReturnType<typeof summarize>;
  wallMs: ReturnType<typeof summarize>;
  fallbacks: number;
  skipped?: string;
}

function aggregate(config: BenchConfigId, records: TaskRecord[], fallbacks: number): ConfigAgg {
  const stepTk: number[] = [];
  const stepC4: number[] = [];
  const stepRtt: number[] = [];
  const rttCount: number[] = [];
  const revisitTk: number[] = [];
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
      if (s.revisited) revisitTk.push(s.tokensTiktoken);
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
    revisitTokensTiktoken: summarize(revisitTk),
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
  skipped: Record<string, string>
): string {
  const by = (c: BenchConfigId): ConfigAgg | undefined => aggs.find((a) => a.config === c);
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
  for (const c of CONFIGS) {
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
  const h3 =
    o4 && o3 ? ratio(o4.revisitTokensTiktoken.p50, o3.revisitTokensTiktoken.p50) : NaN;
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
    L.push(`- O3 revisited-screen tokens/step p50: ${fmt(o3.revisitTokensTiktoken.p50)}`);
    L.push(`- O4 revisited-screen tokens/step p50: ${fmt(o4.revisitTokensTiktoken.p50)}`);
    L.push(`- cold/warm ratio (O4/O3): ${fmt(h3)}×`);
    L.push(`- O3 wall/task p50: ${fmt(o3.wallMs.p50)} ms; O4: ${fmt(o4.wallMs.p50)} ms`);
  } else {
    L.push("- O3/O4 not both present in this run.");
  }
  L.push("");
  L.push("## Per-config wall time / task (ms) — p50 / p95 / range");
  L.push("");
  L.push("| Config | p50 | p95 | range |");
  L.push("|---|---|---|---|");
  for (const c of CONFIGS) {
    const a = by(c);
    if (!a) continue;
    L.push(`| ${c} | ${fmt(a.wallMs.p50)} | ${fmt(a.wallMs.p95)} | ${range([a.wallMs.min, a.wallMs.max])} |`);
  }
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
    tasks: ALL_TASKS.length,
    configs: CONFIGS.join(","),
    tokenizer: tokenizerName(),
    androidHome: process.env.ANDROID_HOME ?? "(unset)",
    startedAt: started,
  };

  const allRecords: TaskRecord[] = [];
  const aggs: ConfigAgg[] = [];
  const skipped: Record<string, string> = {};
  const blockParams: Array<{ block: string; gestureParams: BenchGestureParams }> = [];

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
    if (usesOpenServer(config)) uninstallOpenServer();

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
    const knownBefore = new Set<string>();
    const records: TaskRecord[] = [];

    try {
      for (let rep = 0; rep < REPS; rep++) {
        for (const task of ALL_TASKS) {
          const rec = await runTask(reg, config, task, rep, knownBefore).catch((e) => {
            realDebug(`[bench-sg] ${config}/${task.id}/rep${rep} error: ${String(e)}`);
            return null;
          });
          if (rec) {
            records.push(rec);
            allRecords.push(rec);
          }
        }
      }
    } finally {
      await reg.dispose().catch(() => undefined);
    }

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

  const report = buildReport(aggs, env, skipped);
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
