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
  observeAfterAction,
  usesGraph,
  usesOpenServer,
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
  accountSuccess,
  evaluateAssertion,
  isExcludedRun,
  type AssertionMatch,
  type OracleNode,
} from "../src/screen-graph/bench/oracle";
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
    // Chrome's first-run flow is dismissed once up front (prepareChromeOnce);
    // here we only wait for the page to load. Cold-load on the KVM runner needs
    // more than the old 3 s or the assertion reads a half-painted page.
    await sleep(4500);
  }
  await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 }).catch(() => undefined);
}

/** Clickable-label / id patterns that dismiss the Chrome first-run experience. */
const FRE_DISMISS =
  /use without an account|accept & continue|accept and continue|got it|no thanks|not now|maybe later|dismiss|skip|use without/i;

/**
 * One-time Chrome first-run dismissal (C.3). A fresh emulator shows
 * "Welcome to Chrome / Turn on sync?" the first time Chrome opens, which HIDES
 * example.com and fails EVERY chrome task for EVERY config (run 33742435496:
 * all 6 chrome tasks NNN across B1..O5, so no config discrimination and H4
 * unmeasurable). Dismiss it ONCE, up front, over the open server: `launchApp`'s
 * per-task `am force-stop` never `pm clear`s Chrome, so the FRE stays dismissed
 * for the emulator's lifetime — including B1, whose per-task launch runs with the
 * open flag off. Fully best-effort: it logs and returns on any failure (the
 * pre-flight gate, which does its own dismissal, is the real guard).
 */
async function prepareChromeOnce(): Promise<void> {
  setFlag("open-device-server", true, "project");
  const reg = createRegistry();
  try {
    const server = await openServer(reg);
    adbTry(["shell", `am force-stop ${CHROME}`], 8_000);
    await sleep(400);
    adbTry(
      ["shell", `am start -a android.intent.action.VIEW -d https://example.com ${CHROME}`],
      12_000
    );
    await sleep(3500);
    await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 }).catch(() => undefined);
    for (let i = 0; i < 6; i++) {
      const info = await server.getInfo().catch(() => ({ screenWidth: 1080, screenHeight: 2400 }));
      const W = info.screenWidth || 1080;
      const H = info.screenHeight || 2400;
      const q = await server.query({}, { limit: 1000 });
      const nodes = q.nodes;
      if (nodes.some((n) => /example domain/i.test(n.text ?? ""))) {
        realDebug("[bench-sg] chrome FRE: example.com is up; done");
        return;
      }
      const hasOmnibox = nodes.some((n) =>
        /url_bar|search_box_text|search or type/i.test(`${n.id ?? ""} ${n.text ?? ""}`)
      );
      const fre = nodes.find((n) =>
        FRE_DISMISS.test(`${n.text ?? ""} ${n.cd ?? ""} ${n.id ?? ""}`)
      );
      if (!fre) {
        if (hasOmnibox) {
          realDebug("[bench-sg] chrome FRE: omnibox present, no FRE button; done");
          return;
        }
        await sleep(1000);
        continue;
      }
      const cx = Math.round((fre.bounds.x1 + fre.bounds.x2) / 2);
      const cy = Math.round((fre.bounds.y1 + fre.bounds.y2) / 2);
      realDebug(`[bench-sg] chrome FRE: tapping "${(fre.text ?? fre.cd ?? fre.id ?? "").slice(0, 40)}"`);
      await server.tapWithOutcome(cx, cy).catch(() => undefined);
      await sleep(1500);
      await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 3000 }).catch(() => undefined);
      void W;
      void H;
    }
    realDebug("[bench-sg] chrome FRE: dismissal loop exhausted (continuing)");
  } catch (e) {
    realDebug(`[bench-sg] chrome FRE prep failed (continuing): ${String(e)}`);
  } finally {
    await teardownBackend().catch(() => undefined);
    await reg.dispose().catch(() => undefined);
    unsetFlag("open-device-server", "project");
  }
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
 * Locate an element's normalized centre for a tap. Backend-neutral test plumbing
 * (NOT counted as an observation): the scripted policy already "knows" the
 * target, this only turns it into coordinates so the tap is identical across
 * every config.
 *
 * ONLY the open-device-server path exists (ticket §1): every config locates via
 * the server's own `query` (node pixel bounds, normalized by `getInfo`). B1's
 * proprietary run replays coordinates precomputed by `precomputeB1Coords` in a
 * separate open-server pass and never calls this — the old `uiautomator dump`
 * fallback (which contended with ADT's UiAutomation and produced the stale/miss
 * taps the C.1 ticket set out to kill) has been removed. Calling this on a
 * non-open config is a harness bug and throws.
 */
async function locateNorm(reg: Reg, config: BenchConfigId, sel: BenchSelector): Promise<Located> {
  if (!usesOpenServer(config)) {
    throw new Error(`locateNorm called for non-open config ${config}; B1 must use precomputed coords`);
  }
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

/** Key for a precomputed tap coordinate: task id + step index. */
function coordKey(taskId: string, stepIndex: number): string {
  return `${taskId}#${stepIndex}`;
}

/**
 * B1 locate plumbing (ticket §1). The proprietary android-devtools holds
 * UiAutomation exclusively, so a per-step "stop ADT → start ours → locate →
 * restart ADT" switch would cost far more than the 3 s/step budget the ticket
 * sets. We take the sanctioned alternative: ONE open-server pass up front that
 * navigates each task deterministically (fresh emulator + animations off) and
 * records the pixel-normalized centre of every tap target. B1 then replays those
 * coordinates through its proprietary tap path. The whole pass is plumbing —
 * excluded from every metric and reported as `plumbingMs`.
 *
 * Runs once (screens are deterministic), keyed by `taskId#stepIndex`, reused for
 * all reps. A target that cannot be located here yields `found:false`, which
 * makes the B1 run record a `locateFailed` for that task (honest, not a centre
 * tap).
 */
async function precomputeB1Coords(): Promise<{ coords: Map<string, Located>; plumbingMs: number }> {
  const t0 = Date.now();
  const coords = new Map<string, Located>();
  forceStopInstrumentation();
  killSimServerForEmulator();
  setFlag("open-device-server", true, "project");
  const reg = createRegistry();
  try {
    for (const task of TASKS) {
      for (let i = 0; i < task.steps.length; i++) {
        const a = task.steps[i]!.action;
        if (a.kind === "launch") {
          await launchApp(reg, task.app);
          continue;
        }
        if (a.kind === "tap") {
          const loc = await locateNorm(reg, "B2", a.selector);
          coords.set(coordKey(task.id, i), loc);
          if (loc.found) {
            await reg
              .invokeTool("gesture-tap", { udid: SERIAL, x: loc.xNorm, y: loc.yNorm })
              .catch(() => undefined);
            await reg
              .invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 2500 })
              .catch(() => undefined);
          } else {
            realDebug(`[bench-sg] B1 precompute: ${task.id} step ${i} locate MISS (${JSON.stringify(a.selector)})`);
          }
        } else if (a.kind === "swipe") {
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
          await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 2500 }).catch(() => undefined);
        } else if (a.kind === "tapXY") {
          // Same-screen no-op tap: execute so the screen state matches for any
          // later `tap` step; no coordinate to record (it carries its own x/y).
          await reg.invokeTool("gesture-tap", { udid: SERIAL, x: a.x, y: a.y }).catch(() => undefined);
          await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 2500 }).catch(() => undefined);
        } else if (a.kind === "back") {
          adbTry(["shell", "input keyevent 4"], 6_000);
          await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 2500 }).catch(() => undefined);
        } else if (a.kind === "type") {
          await reg.invokeTool("keyboard", { udid: SERIAL, text: a.text }).catch(() => undefined);
          await sleep(800);
        }
      }
    }
  } finally {
    await reg.dispose().catch(() => undefined);
    forceStopInstrumentation();
    killSimServerForEmulator();
    unsetFlag("open-device-server", "project"); // restore B1 (proprietary)
  }
  return { coords, plumbingMs: Date.now() - t0 };
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
  /** the tap target could not be located; the task aborts here (ticket §2). */
  locateFailed: boolean;
  /** an action tool call (tap/gesture) threw; the task aborts (review MEDIUM-8). */
  actionFailed: boolean;
  /** this step is INTENDED to keep the same screen (H2 same-screen subset). */
  sameScreen: boolean;
}

interface TaskRecord {
  config: BenchConfigId;
  task: string;
  app: string;
  rep: number;
  steps: StepRecord[];
  success: boolean;
  /**
   * The run was aborted because a tap target could not be located — plumbing,
   * not an agent/backend deficiency. Excluded from the success denominator and
   * counted separately (ticket §2).
   */
  locateFailed: boolean;
  /** an action tool call threw mid-task — the run is invalid (review MEDIUM-8). */
  actionFailed: boolean;
  /** the success oracle could not be read — the run is invalid (review MEDIUM-7). */
  oracleError: boolean;
  /** the task threw before producing a usable record (backend down; review HIGH-4). */
  taskError: boolean;
  assertionObs: ObservationKind;
  assertionTokensTiktoken: number;
  assertionTokensCharsDiv4: number;
  /** The needle the success oracle looked for on the final screen. */
  assertionNeedle: string;
  /**
   * Every VISIBLE node whose text/contentDescription carried the needle, from
   * the ONE oracle used for all configs (ticket §3). Empty when unmet — its
   * emptiness IS the evidence.
   */
  assertionMatches: AssertionMatch[];
  /**
   * Off-metric plumbing time for this run: the B1 instrumentation switch that
   * lets the proprietary config be read by the same on-device `query` oracle
   * (0 for open configs, whose server is already serving).
   */
  plumbingMs: number;
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
  /** tap target could not be located — the task aborts (ticket §2). */
  locateFailed: boolean;
  /** the action tool call threw — the task aborts, run invalid (review MEDIUM-8). */
  actionFailed: boolean;
}

async function runAction(
  reg: Reg,
  config: BenchConfigId,
  step: BenchStep,
  useNavigate: boolean,
  located: Located | null,
  navSel: BenchSelector | null
): Promise<ActionResult> {
  const a = step.action;
  const t0 = Date.now();

  // O5 navigate-to: replace the tap+observe loop with one plan when the target
  // is known and the graph can route to it. TWO bugs are fixed here versus the
  // C.2 harness that produced 30/60 O5 locate-fails in run 33742435496:
  //
  //  1. TARGET SHAPE. The tool's target is `{ screen | selector }` — the bench
  //     selector goes UNDER `selector`, not as the whole target. C.2 passed
  //     `{ text }` as the target itself, which failed the tool's zod refine
  //     (`screen ?? selector` required) and THREW on every O5 known-target step.
  //     Because `located` was not computed for O5, each throw was recorded as a
  //     locate-fail — the exact 10 settings-nav tasks × 3 reps = 30.
  //  2. ROUTE TARGET. `planToSelector` matches a screen whose index holds the
  //     selector by EXACT text. The step's TAP selector (e.g. "Network &
  //     internet") is on the CURRENT screen, so it resolves to 0 steps and never
  //     enters the sub-screen. We route to the task's `navTarget` instead — a
  //     DESTINATION-unique exact text (confirmed against the capture), so the
  //     plan is the real root→sub-screen tap. Falls back to the tap selector when
  //     a task has no navTarget.
  //
  // `reached` is required; a no-route / divergence (or a throw) falls through to
  // the plain locate+tap the caller precomputed `located` for (O5's OWN recovery
  // on the same open backend, not a switch to another config), so a routing miss
  // is an honest tap, never a spurious locate-fail.
  if (useNavigate && a.kind === "tap") {
    const target = navSel ?? a.selector;
    try {
      const nav = (await reg.invokeTool("navigate-to", {
        udid: SERIAL,
        target: { selector: toBenchTarget(target) },
      })) as { reached?: boolean; completedSteps?: number; totalSteps?: number };
      if (nav?.reached) {
        return { rttMs: Date.now() - t0, usedNavigate: true, locateFailed: false, actionFailed: false };
      }
      realDebug(
        `[bench-sg] navigate-to did not reach ${JSON.stringify(target)}; falling back to locate+tap`
      );
    } catch (e) {
      realDebug(
        `[bench-sg] navigate-to threw for ${JSON.stringify(target)}: ${String(e)}; falling back to locate+tap`
      );
    }
    /* fall through to the plain tap below (located computed by the caller) */
  }

  if (a.kind === "launch") {
    // launch handled by the caller (app reset); this is a no-op timing anchor.
    return { rttMs: 0, usedNavigate: false, locateFailed: false, actionFailed: false };
  }
  if (a.kind === "back") {
    try {
      adb(["shell", "input keyevent 4"], 6_000);
    } catch (e) {
      realDebug(`[bench-sg] back keyevent failed: ${String(e)}`);
      return { rttMs: Date.now() - t0, usedNavigate: false, locateFailed: false, actionFailed: true };
    }
    return { rttMs: Date.now() - t0, usedNavigate: false, locateFailed: false, actionFailed: false };
  }
  if (a.kind === "swipe") {
    const [fromY, toY] = a.direction === "up" ? [0.7, 0.3] : [0.3, 0.7];
    try {
      await reg.invokeTool("gesture-swipe", {
        udid: SERIAL,
        fromX: 0.5,
        fromY,
        toX: 0.5,
        toY,
        durationMs: BENCH_GESTURE_PARAMS.swipeDurationMs,
      });
    } catch (e) {
      realDebug(`[bench-sg] swipe failed: ${String(e)}`);
      return { rttMs: Date.now() - t0, usedNavigate: false, locateFailed: false, actionFailed: true };
    }
    return { rttMs: Date.now() - t0, usedNavigate: false, locateFailed: false, actionFailed: false };
  }
  if (a.kind === "type") {
    // A `type` follows a tap that opened + focused the field (e.g. the Settings
    // search box); type straight into it. `adb input text` needs spaces escaped.
    try {
      await reg.invokeTool("keyboard", { udid: SERIAL, text: a.text });
    } catch (e) {
      realDebug(`[bench-sg] keyboard failed: ${String(e)}`);
      return { rttMs: Date.now() - t0, usedNavigate: false, locateFailed: false, actionFailed: true };
    }
    await sleep(800); // async search results populate off the main thread
    return { rttMs: Date.now() - t0, usedNavigate: false, locateFailed: false, actionFailed: false };
  }
  if (a.kind === "tapXY") {
    // Fixed-coordinate tap (no locate) for the same-screen H2 no-op taps.
    let res: { outcome?: { changed: boolean; newScreen: boolean } };
    try {
      res = (await reg.invokeTool("gesture-tap", { udid: SERIAL, x: a.x, y: a.y })) as {
        outcome?: { changed: boolean; newScreen: boolean };
      };
    } catch (e) {
      realDebug(`[bench-sg] tapXY failed: ${String(e)}`);
      return { rttMs: Date.now() - t0, usedNavigate: false, locateFailed: false, actionFailed: true };
    }
    const outcome = res.outcome
      ? { changed: res.outcome.changed, newScreen: res.outcome.newScreen }
      : undefined;
    return { rttMs: Date.now() - t0, outcome, usedNavigate: false, locateFailed: false, actionFailed: false };
  }
  // tap. `located` is resolved by the caller (open `query` for every config;
  // for B1 a precomputed coordinate — locate is identical plumbing, ticket §1).
  // A failed locate ABORTS the task instead of tapping screen centre (ticket §2)
  // — a centre tap silently corrupts every downstream step and the assertion.
  if (!located || !located.found) {
    return { rttMs: Date.now() - t0, usedNavigate: false, locateFailed: true, actionFailed: false };
  }
  // A gesture-tap tool THROW must abort the run, never be swallowed into a false
  // success (review MEDIUM-8): mark actionFailed and exclude the run.
  let res: { outcome?: { changed: boolean; newScreen: boolean } };
  try {
    res = (await reg.invokeTool("gesture-tap", { udid: SERIAL, x: located.xNorm, y: located.yNorm })) as {
      outcome?: { changed: boolean; newScreen: boolean };
    };
  } catch (e) {
    realDebug(`[bench-sg] gesture-tap failed: ${String(e)}`);
    return { rttMs: Date.now() - t0, usedNavigate: false, locateFailed: false, actionFailed: true };
  }
  const outcome = res.outcome
    ? { changed: res.outcome.changed, newScreen: res.outcome.newScreen }
    : undefined;
  return { rttMs: Date.now() - t0, outcome, usedNavigate: false, locateFailed: false, actionFailed: false };
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

interface OracleReadout {
  matched: boolean;
  matches: AssertionMatch[];
  /** JSON of the matched nodes — off the metric path, persisted as evidence. */
  tokensTiktoken: number;
  tokensCharsDiv4: number;
}

/**
 * The ONE success oracle for every config (ticket §3), run over an OPEN-server
 * registry (`reg` is the config's own registry for open configs, a temporary
 * open registry for the B1 switch). Fetches EVERY node once (empty selector so
 * text- and content-description-only matches are both reachable — the Kotlin
 * `query` matcher folds only case and matches `text` alone), then applies the
 * pure `evaluateAssertion` rule. Fix §4: one settle (`await-screen-idle`) + one
 * re-query when the first read is unmet, identically for all configs.
 */
async function oracleRead(reg: Reg, needle: string): Promise<OracleReadout> {
  const server = await openServer(reg);
  let screen: { width: number; height: number };
  try {
    const info = await server.getInfo();
    screen = { width: info.screenWidth || 1080, height: info.screenHeight || 2400 };
  } catch {
    screen = { width: 1080, height: 2400 };
  }
  const fetchNodes = async (): Promise<OracleNode[]> => {
    const res = await server.query({}, { limit: 1000 });
    // Structural map to the oracle's node shape (no blind cast): the open-server
    // compact node carries id/text/cd/bounds among other fields.
    return res.nodes.map((n) => ({ id: n.id, text: n.text, cd: n.cd, bounds: n.bounds }));
  };
  let nodes = await fetchNodes();
  let result = evaluateAssertion(nodes, needle, { screen });
  if (!result.matched) {
    await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 1500 }).catch(() => undefined);
    await sleep(300);
    nodes = await fetchNodes();
    result = evaluateAssertion(nodes, needle, { screen });
  }
  const both = countBoth(JSON.stringify(result.matches));
  return {
    matched: result.matched,
    matches: result.matches,
    tokensTiktoken: both.tiktoken,
    tokensCharsDiv4: both.charsDiv4,
  };
}

interface AssertionResult {
  obs: ObservationKind;
  success: boolean;
  matches: AssertionMatch[];
  tokensTiktoken: number;
  tokensCharsDiv4: number;
  /** off-metric B1 instrumentation-switch time; 0 for open configs. */
  plumbingMs: number;
  /** the oracle could not be read (query / B1 switch threw) — run invalid. */
  error: boolean;
}

/**
 * Success assertion, judged by the SAME on-device `query` oracle for every
 * config (ticket §3). Open configs read their already-serving server. B1
 * (proprietary android-devtools holds UiAutomation) switches: stop ADT → bring
 * our server up on a temporary registry → read → stop ours → restore the B1
 * flag; the next task's launch restarts ADT. The whole switch is plumbing,
 * excluded from every metric and reported as `plumbingMs`.
 */
async function runAssertion(
  reg: Reg,
  config: BenchConfigId,
  assertion: BenchSelector
): Promise<AssertionResult> {
  const needle = assertion.text ?? assertion.id ?? "";
  if (usesOpenServer(config)) {
    try {
      const r = await oracleRead(reg, needle);
      return {
        obs: "query",
        success: r.matched,
        matches: r.matches,
        tokensTiktoken: r.tokensTiktoken,
        tokensCharsDiv4: r.tokensCharsDiv4,
        plumbingMs: 0,
        error: false,
      };
    } catch (e) {
      realDebug(`[bench-sg] ${config} oracle read failed: ${String(e)}`);
      return { obs: "query", success: false, matches: [], tokensTiktoken: 0, tokensCharsDiv4: 0, plumbingMs: 0, error: true };
    }
  }
  // B1: instrumentation switch so the proprietary screen is judged by the same
  // on-device query oracle as every open config. Fully reset the device-side
  // backends on the way in AND out so neither instrumentation stays holding
  // UiAutomation; the next task's proprietary tool call respawns ADT cleanly.
  const t0 = Date.now();
  forceStopInstrumentation();
  killSimServerForEmulator();
  await sleep(500);
  setFlag("open-device-server", true, "project");
  const tmp = createRegistry();
  try {
    const r = await oracleRead(tmp, needle);
    return {
      obs: "query",
      success: r.matched,
      matches: r.matches,
      tokensTiktoken: r.tokensTiktoken,
      tokensCharsDiv4: r.tokensCharsDiv4,
      plumbingMs: Date.now() - t0,
      error: false,
    };
  } catch (e) {
    realDebug(`[bench-sg] B1 oracle switch failed: ${String(e)}`);
    return { obs: "query", success: false, matches: [], tokensTiktoken: 0, tokensCharsDiv4: 0, plumbingMs: Date.now() - t0, error: true };
  } finally {
    await tmp.dispose().catch(() => undefined);
    forceStopInstrumentation();
    killSimServerForEmulator();
    unsetFlag("open-device-server", "project"); // restore B1 (proprietary) for the next task
    await sleep(500);
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
  knownBefore: Set<string>,
  precomputed: Map<string, Located> | null
): Promise<TaskRecord> {
  const wall0 = Date.now();
  const steps: StepRecord[] = [];
  let abortReason: "locate" | "action" | null = null;

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

    // Resolve the tap target's coordinate — plumbing, identical for every config
    // (ticket §1): open configs locate via the live `query`; B1 replays the
    // precomputed coordinate. Computed for O5's navigate steps too so a navigate
    // divergence falls back to an honest locate+tap instead of a spurious
    // locate-fail; the locate is off-metric plumbing (not in rttCount) and O5's
    // graph-lookup observation is unchanged. `tapXY` carries fixed normalized
    // coordinates and skips this.
    let located: Located | null = null;
    if (step.action.kind === "tap") {
      located = precomputed
        ? precomputed.get(coordKey(task.id, i)) ?? { xNorm: 0.5, yNorm: 0.5, found: false }
        : await locateNorm(reg, config, step.action.selector);
    }

    // O5 routes to the task's DESTINATION (navTarget: a dest-unique exact text),
    // NOT the tap selector (which is on the current screen — 0 steps). Falls back
    // to the tap selector for a task with no navTarget.
    const navSel: BenchSelector | null =
      task.navTarget ?? (step.action.kind === "tap" ? step.action.selector : null);

    const tBefore = await traversals(reg, config);
    const action = isLaunch
      ? { rttMs: 0, usedNavigate: false, locateFailed: false, actionFailed: false }
      : await runAction(reg, config, step, useNavigate, located, navSel);

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
      locateFailed: action.locateFailed,
      actionFailed: action.actionFailed,
      sameScreen: step.sameScreen === true,
    });

    // A failed locate (ticket §2) or a thrown action (review MEDIUM-8) aborts the
    // task — the rest of the steps and the oracle would run on a corrupted state.
    // The run is excluded from the success denominator and counted by reason.
    if (action.locateFailed) {
      abortReason = "locate";
      realDebug(`[bench-sg] ${config}/${task.id}/rep${rep}: locate failed at step ${i}; aborting task`);
      break;
    }
    if (action.actionFailed) {
      abortReason = "action";
      realDebug(`[bench-sg] ${config}/${task.id}/rep${rep}: action failed at step ${i}; aborting task`);
      break;
    }
  }

  const needleText = task.assertion.text ?? task.assertion.id ?? "";
  if (abortReason) {
    return {
      config,
      task: task.id,
      app: task.app,
      rep,
      steps,
      success: false,
      locateFailed: abortReason === "locate",
      actionFailed: abortReason === "action",
      oracleError: false,
      taskError: false,
      assertionObs: "none",
      assertionTokensTiktoken: 0,
      assertionTokensCharsDiv4: 0,
      assertionNeedle: needleText,
      assertionMatches: [],
      plumbingMs: 0,
      wallMs: Date.now() - wall0,
      gestureParams: BENCH_GESTURE_PARAMS,
    };
  }

  await sleep(400); // brief settle so the final assertion reads the arrived screen
  const assertion = await runAssertion(reg, config, task.assertion);

  return {
    config,
    task: task.id,
    app: task.app,
    rep,
    steps,
    success: assertion.error ? false : assertion.success,
    locateFailed: false,
    actionFailed: false,
    oracleError: assertion.error,
    taskError: false,
    assertionObs: assertion.obs,
    assertionTokensTiktoken: assertion.tokensTiktoken,
    assertionTokensCharsDiv4: assertion.tokensCharsDiv4,
    assertionNeedle: needleText,
    assertionMatches: assertion.matches,
    plumbingMs: assertion.plumbingMs,
    // HIGH-3: wall time excludes the off-metric B1 oracle-switch plumbing.
    wallMs: Date.now() - wall0 - assertion.plumbingMs,
    gestureParams: BENCH_GESTURE_PARAMS,
  };
}

/** A minimal record for a task-run that THREW before producing data (HIGH-4). */
function erroredTaskRecord(config: BenchConfigId, task: BenchTask, rep: number): TaskRecord {
  return {
    config,
    task: task.id,
    app: task.app,
    rep,
    steps: [],
    success: false,
    locateFailed: false,
    actionFailed: false,
    oracleError: false,
    taskError: true,
    assertionObs: "none",
    assertionTokensTiktoken: 0,
    assertionTokensCharsDiv4: 0,
    assertionNeedle: task.assertion.text ?? task.assertion.id ?? "",
    assertionMatches: [],
    plumbingMs: 0,
    wallMs: 0,
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
  /** ok / scored, where scored excludes every excluded run (ticket §2, MEDIUM-7/8). */
  successRate: number;
  /** all task-runs. */
  total: number;
  /** runs judged by the oracle (total − excluded). */
  scored: number;
  /** runs excluded from the denominator, by reason. */
  excluded: number;
  locateFailed: number;
  actionFailed: number;
  oracleError: number;
  taskError: number;
  perStepTokensTiktoken: ReturnType<typeof summarize>;
  perStepTokensCharsDiv4: ReturnType<typeof summarize>;
  perStepRtt: ReturnType<typeof summarize>;
  rttCountPerStep: ReturnType<typeof summarize>;
  /** RTT count/step over SAME-SCREEN steps only (H2 subset; review addendum). */
  rttCountSameScreen: ReturnType<typeof summarize>;
  /** tokens on steps reaching a NOVEL screen (cold: describe/query). */
  coldTokensTiktoken: ReturnType<typeof summarize>;
  /** tokens on steps reaching a KNOWN screen (warm: graph-lookup). */
  warmTokensTiktoken: ReturnType<typeof summarize>;
  wallMs: ReturnType<typeof summarize>;
  /** off-metric plumbing ms (B1 precompute + oracle switches; 0 elsewhere). */
  plumbingMs: number;
  fallbacks: number;
  skipped?: string;
}

function aggregate(
  config: BenchConfigId,
  records: TaskRecord[],
  fallbacks: number,
  extraPlumbingMs = 0
): ConfigAgg {
  const stepTk: number[] = [];
  const stepC4: number[] = [];
  const stepRtt: number[] = [];
  const rttCount: number[] = [];
  const rttCountSS: number[] = [];
  const coldTk: number[] = [];
  const warmTk: number[] = [];
  const walls: number[] = [];
  let plumbingMs = extraPlumbingMs;
  for (const r of records) {
    plumbingMs += r.plumbingMs ?? 0;
    // Excluded runs (locate/action/oracle/task failures) never produced an honest
    // observation/oracle — keep their steps and wall time out of the metrics.
    if (isExcludedRun(r)) continue;
    walls.push(r.wallMs);
    for (const s of r.steps) {
      if (s.actionKind === "launch") continue;
      stepTk.push(s.tokensTiktoken);
      stepC4.push(s.tokensCharsDiv4);
      stepRtt.push(s.rttMs);
      rttCount.push(s.rttCount);
      if (s.sameScreen) rttCountSS.push(s.rttCount);
      // A step reaching a screen already in the graph is warm; a novel screen is
      // cold. In O3 (cold store) most steps are cold; in O4/O5 (preloaded) warm.
      if (s.knownScreen) warmTk.push(s.tokensTiktoken);
      else coldTk.push(s.tokensTiktoken);
    }
  }
  const acct = accountSuccess(records);
  return {
    config,
    tasks: new Set(records.map((r) => r.task)).size,
    reps: REPS,
    successRate: acct.successRate,
    total: acct.total,
    scored: acct.scored,
    excluded: acct.excluded,
    locateFailed: acct.locateFailed,
    actionFailed: acct.actionFailed,
    oracleError: acct.oracleError,
    taskError: acct.taskError,
    perStepTokensTiktoken: summarize(stepTk),
    perStepTokensCharsDiv4: summarize(stepC4),
    perStepRtt: summarize(stepRtt),
    rttCountPerStep: summarize(rttCount),
    rttCountSameScreen: summarize(rttCountSS),
    coldTokensTiktoken: summarize(coldTk),
    warmTokensTiktoken: summarize(warmTk),
    wallMs: summarize(walls),
    plumbingMs,
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
      // Denominator excludes locate-failed runs (ticket §2), matching successRate.
      const scored = records.filter((r) => r.config === c && r.rep === rep && !r.locateFailed);
      if (scored.length) {
        out.push(Number(((scored.filter((r) => r.success).length / scored.length) * 100).toFixed(0)));
      }
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
  L.push(
    "`success` = ok / scored, where scored EXCLUDES every plumbing/infra failure " +
      "(locate / action / oracle / task — ticket §2, review MEDIUM-7/8). `excluded` shows " +
      "the count and reason breakdown `L`ocate/`A`ction/`O`racle/`T`ask. `fallbacks` counts " +
      "describe/tree fallbacks — for B1 any fallback means the proprietary path was NOT " +
      "exercised and its metrics are INVALID (review HIGH-5). `plumb ms` is off-metric " +
      "plumbing time (B1 coordinate precompute + per-task oracle instrumentation switch)."
  );
  L.push("");
  L.push(
    "| Config | n steps | tok p50 | tok p95 | chars/4 p50 | RTT p50 (ms) | RTT count/step p50 | success | scored | excluded (L/A/O/T) | fallbacks | plumb ms |"
  );
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of REPORT_ORDER) {
    const a = by(c);
    if (!a) continue;
    const exc = `${a.excluded} (${a.locateFailed}/${a.actionFailed}/${a.oracleError}/${a.taskError})`;
    const fbCell = c === "B1" && a.fallbacks > 0 ? `**${a.fallbacks}** ⚠` : String(a.fallbacks);
    L.push(
      `| ${c} | ${a.perStepTokensTiktoken.n} | ${fmt(a.perStepTokensTiktoken.p50)} | ${fmt(
        a.perStepTokensTiktoken.p95
      )} | ${fmt(a.perStepTokensCharsDiv4.p50)} | ${fmt(a.perStepRtt.p50)} | ${fmt(
        a.rttCountPerStep.p50
      )} | ${(a.successRate * 100).toFixed(0)}% | ${a.scored}/${a.total} | ${exc} | ${fbCell} | ${a.plumbingMs} |`
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
  const h2 = o2 && b2 ? b2.rttCountPerStep.p50 - o2.rttCountPerStep.p50 : NaN;
  // H2 (review addendum): the honest test is over SAME-SCREEN steps only — the
  // navigation tasks change the screen every step, so O2's outcome has nothing to
  // skip there. Same-screen steps are where an unchanged outcome removes the read.
  const h2ss =
    o2 && b2 ? b2.rttCountSameScreen.p50 - o2.rttCountSameScreen.p50 : NaN;
  // H3: warm cost (O4, all screens preloaded → graph-lookup) vs cold cost
  // (O3, novel screens → describe). Falls back to overall per-step if a side has
  // no cold/warm samples.
  const o3Cold = o3 && isFinite(o3.coldTokensTiktoken.p50) ? o3.coldTokensTiktoken.p50 : o3?.perStepTokensTiktoken.p50 ?? NaN;
  const o4Warm = o4 && isFinite(o4.warmTokensTiktoken.p50) ? o4.warmTokensTiktoken.p50 : o4?.perStepTokensTiktoken.p50 ?? NaN;
  const h3 = ratio(o4Warm, o3Cold);
  L.push("| Hypothesis | Target | Measured | Verdict |");
  L.push("|---|---|---|---|");
  L.push(
    `| H1 O1 tokens/step vs B2 (unchanged steps) | ≤ 0.5× | ${fmt(h1)}× | ${
      h1 <= 0.5 ? "PASS" : "FAIL"
    } |`
  );
  L.push(
    `| H2 O2 removes ≥1 RTT/step vs B2 (ALL steps) | ≥ 1 | ${fmt(h2)} | ${h2 >= 1 ? "PASS" : "FAIL"} |`
  );
  const h2ssN = o2 ? o2.rttCountSameScreen.n : 0;
  L.push(
    `| H2 O2 removes ≥1 RTT/step vs B2 (SAME-SCREEN steps, n=${h2ssN}) | ≥ 1 | ${fmt(h2ss)} | ${
      h2ssN === 0 ? "NO DATA" : h2ss >= 1 ? "PASS" : "FAIL"
    } |`
  );
  L.push(
    `| H3 O4 tokens/step vs O3 (revisited) | ≤ 0.2× | ${fmt(h3)}× | ${
      h3 <= 0.2 ? "PASS" : "FAIL"
    } |`
  );
  L.push("");
  // H4 (review HIGH-6): compare each open config to a baseline over the (task,rep)
  // pairs BOTH sides actually SCORED (neither excluded). No verdict when the
  // intersection is empty. B1 with any describe fallback is an invalid baseline.
  const scoredPairs = (c: BenchConfigId): Set<string> => {
    const s = new Set<string>();
    for (const r of records) {
      if (r.config === c && !isExcludedRun(r)) s.add(`${r.task}#${r.rep}`);
    }
    return s;
  };
  const successAt = (c: BenchConfigId, key: string): boolean => {
    const [task, repStr] = key.split("#");
    const r = records.find((x) => x.config === c && x.task === task && x.rep === Number(repStr));
    return Boolean(r && !isExcludedRun(r) && r.success);
  };
  const b1Invalid = Boolean(b1 && b1.fallbacks > 0);
  const h4Row = (base: ConfigAgg | undefined, invalid: boolean): string => {
    if (!base) return "baseline absent";
    if (invalid) return "INVALID BASELINE (describe fallback → proprietary path not exercised)";
    const basePairs = scoredPairs(base.config);
    const parts: string[] = [];
    let worst = false;
    for (const a of aggs.filter((x) => x.config.startsWith("O"))) {
      const inter = [...scoredPairs(a.config)].filter((k) => basePairs.has(k));
      if (inter.length === 0) {
        parts.push(`${a.config}: no shared scored pairs`);
        continue;
      }
      const aOk = inter.filter((k) => successAt(a.config, k)).length / inter.length;
      const bOk = inter.filter((k) => successAt(base.config, k)).length / inter.length;
      const nonInferior = aOk >= bOk - 0.02;
      if (!nonInferior) worst = true;
      parts.push(
        `${a.config} ${(aOk * 100).toFixed(0)}% vs ${(bOk * 100).toFixed(0)}% (n=${inter.length})${
          nonInferior ? "" : " ✗"
        }`
      );
    }
    return `${worst ? "FAIL" : "PASS"} — ${parts.join("; ")}`;
  };
  L.push(
    "**H4 — success non-inferior (±2 pp) to each baseline, ONE oracle for every config**, " +
      "computed over the (task, rep) pairs BOTH sides scored (review HIGH-6); B1 read via the " +
      "instrumentation switch, not the old describe substring scan:"
  );
  L.push("");
  L.push("| Baseline | Baseline success (overall) | Verdict (O1..O5, intersection) |");
  L.push("|---|---|---|");
  L.push(
    `| B1 (argent proprietary) | ${b1 ? (b1.successRate * 100).toFixed(0) + `% (${b1.scored}/${b1.total})` : "—"}${
      b1Invalid ? " ⚠INVALID" : ""
    } | ${h4Row(b1, b1Invalid)} |`
  );
  L.push(
    `| B2 (open server, no graph) | ${b2 ? (b2.successRate * 100).toFixed(0) + `% (${b2.scored}/${b2.total})` : "—"} | ${h4Row(b2, false)} |`
  );
  L.push("");
  L.push("## H2 detail — RTT count/step, all steps vs same-screen only");
  L.push("");
  L.push(
    "The navigation tasks change the screen every step, so O2's unchanged-outcome " +
      "skip has nothing to act on there — H2 is only visible on the SAME-SCREEN tasks " +
      "(review addendum). B2 always issues action + describe (2); O2 drops the read to " +
      "action-only (1) on a step whose outcome reports no change."
  );
  L.push("");
  L.push("| Config | RTT/step p50 (all) | RTT/step mean (all) | RTT/step p50 (same-screen) | RTT/step mean (same-screen) | same-screen n |");
  L.push("|---|---|---|---|---|---|");
  for (const c of REPORT_ORDER) {
    const a = by(c);
    if (!a) continue;
    L.push(
      `| ${c} | ${fmt(a.rttCountPerStep.p50)} | ${fmt(a.rttCountPerStep.mean)} | ${fmt(
        a.rttCountSameScreen.p50
      )} | ${fmt(a.rttCountSameScreen.mean)} | ${a.rttCountSameScreen.n} |`
    );
  }
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
    "- H2 counts action + observation round-trips. B2 always issues action + describe; O2 " +
      "drops the read when the outcome reports no change. On the navigation tasks every step " +
      "changes the screen, so O2 saves nothing there (all-steps H2 ≈ 0) — the saving is real " +
      "only on the SAME-SCREEN tasks (see the H2 detail table), where an unchanged step costs " +
      "1 RTT for O2 vs 2 for B2.");
  L.push(
    "- Locate is backend-neutral plumbing, identical for every config (ticket §1): open " +
      "configs locate via the live open-server `query`; B1 replays coordinates precomputed in " +
      "ONE up-front open-server pass (per-step ADT↔ours switching exceeds the 3 s/step budget). " +
      "A failed locate ABORTS the task (`locate-fail`) instead of tapping screen centre, and is " +
      "excluded from the success denominator.");
  L.push(
    "- ONE success oracle for every config (ticket §3): a needle counts as present when it " +
      "appears case-insensitively in the `text` OR `contentDescription` of a VISIBLE node " +
      "(geometry-gated), read by the on-device `query`. B1 is read through an instrumentation " +
      "switch (stop ADT → bring our server up → query → restore B1) so it is judged by the same " +
      "rule as the open configs, not the old describe substring scan. The matched node text is " +
      "persisted per assertion (below) as evidence.");
  L.push("- Emulator torn down after the run (see harness teardown).");
  L.push("");

  // Per-task success matrix (ticket §Output). Y=success, N=oracle unmet,
  // L=locate-failed (aborted, excluded from denominator), .=config absent.
  L.push("## Per-task success matrix (per config)");
  L.push("");
  L.push("Legend: `Y` oracle met · `N` oracle unmet · `L` locate-failed (aborted, not scored).");
  L.push("");
  const taskIds = [...new Set(records.map((r) => r.task))];
  const cell = (c: BenchConfigId, task: string): string => {
    const rs = records.filter((r) => r.config === c && r.task === task);
    if (rs.length === 0) return ".";
    return rs
      .sort((a, b) => a.rep - b.rep)
      .map((r) => (r.locateFailed ? "L" : r.success ? "Y" : "N"))
      .join("");
  };
  const presentConfigs = REPORT_ORDER.filter((c) => by(c));
  L.push(`| Task | ${presentConfigs.join(" | ")} |`);
  L.push(`|---|${presentConfigs.map(() => "---").join("|")}|`);
  for (const task of taskIds) {
    L.push(`| ${task} | ${presentConfigs.map((c) => cell(c, task)).join(" | ")} |`);
  }
  L.push("");

  // Assertion evidence: the matched node text for every assertion (ticket
  // §Output). One representative rep (0) per config/task; empty ⇒ unmet.
  L.push("## Assertion evidence — matched node text (rep 0)");
  L.push("");
  L.push("| Config | Task | Needle | Met | Field | Matched node text (first match) |");
  L.push("|---|---|---|---|---|---|");
  for (const c of presentConfigs) {
    for (const task of taskIds) {
      const r = records.find((x) => x.config === c && x.task === task && x.rep === 0);
      if (!r) continue;
      if (r.locateFailed) {
        L.push(`| ${c} | ${task} | ${r.assertionNeedle} | locate-fail | — | (task aborted on locate) |`);
        continue;
      }
      const m = r.assertionMatches[0];
      const text = m ? m.text.replace(/\s+/g, " ").slice(0, 80).replace(/\|/g, "\\|") : "";
      L.push(
        `| ${c} | ${task} | ${r.assertionNeedle} | ${r.success ? "Y" : "N"} | ${
          m ? m.field : "—"
        } | ${text || "(none)"} |`
      );
    }
  }
  L.push("");

  // B1 per-task failure evidence (ticket §Acceptance): if B1 < 90 %, each open
  // failure must name a real proprietary-path failure with the node text.
  if (b1) {
    const b1Fails = taskIds.filter((task) =>
      records.some((r) => r.config === "B1" && r.task === task && !r.locateFailed && !r.success)
    );
    if (b1Fails.length) {
      L.push("## B1 per-task failure evidence (proprietary path)");
      L.push("");
      L.push(
        "Each B1 task whose oracle was unmet (scored, not locate-failed), with the same " +
          "on-device query readout used for every config. An empty match set on a screen where " +
          "the open configs matched is the evidence of a real proprietary-path divergence."
      );
      L.push("");
      L.push("| Task | Needle | B1 met | B2 met | B1 matched text | B2 matched text |");
      L.push("|---|---|---|---|---|---|");
      for (const task of b1Fails) {
        const rb1 = records.find((r) => r.config === "B1" && r.task === task && r.rep === 0);
        const rb2 = records.find((r) => r.config === "B2" && r.task === task && r.rep === 0);
        const txt = (r?: TaskRecord): string =>
          r?.assertionMatches[0]
            ? r.assertionMatches[0].text.replace(/\s+/g, " ").slice(0, 60).replace(/\|/g, "\\|")
            : "(none)";
        L.push(
          `| ${task} | ${rb1?.assertionNeedle ?? ""} | ${rb1?.success ? "Y" : "N"} | ${
            rb2?.success ? "Y" : "N"
          } | ${txt(rb1)} | ${txt(rb2)} |`
        );
      }
      L.push("");
    }
  }

  // Optional pass1 provenance appendix (ticket §Output: keep the old H1/H3
  // numbers for provenance). Reads a prior full-pass JSON named by env.
  const pass1Path = process.env.BENCH_PASS1_APPENDIX;
  if (pass1Path && existsSync(pass1Path)) {
    try {
      const prior = JSON.parse(readFileSync(pass1Path, "utf8")) as { aggregates: ConfigAgg[] };
      const p = (c: BenchConfigId): ConfigAgg | undefined => prior.aggregates.find((a) => a.config === c);
      const pB2 = p("B2");
      const pO1 = p("O1");
      const pO3 = p("O3");
      const pO4 = p("O4");
      const pH1 =
        pO1 && pB2 ? ratio(pO1.perStepTokensTiktoken.p50, pB2.perStepTokensTiktoken.p50) : NaN;
      const pColdSrc = pO3 && isFinite(pO3.coldTokensTiktoken.p50)
        ? pO3.coldTokensTiktoken.p50
        : pO3?.perStepTokensTiktoken.p50 ?? NaN;
      const pWarmSrc = pO4 && isFinite(pO4.warmTokensTiktoken.p50)
        ? pO4.warmTokensTiktoken.p50
        : pO4?.perStepTokensTiktoken.p50 ?? NaN;
      const pH3 = ratio(pWarmSrc, pColdSrc);
      L.push("## Appendix: pass1 provenance (pre-C.1 harness)");
      L.push("");
      L.push(
        `Source: \`${pass1Path.split("/").pop()}\`. The C.1 oracle/locate fixes do not touch the ` +
          "token metric path, so H1/H3 should sit within ±10 % of these.");
      L.push("");
      L.push("| Metric | pass1 | this pass |");
      L.push("|---|---|---|");
      L.push(`| H1 (O1/B2 tokens/step) | ${fmt(pH1)}× | ${fmt(h1)}× |`);
      L.push(`| H3 (O4 warm / O3 cold) | ${fmt(pH3)}× | ${fmt(h3)}× |`);
      L.push(
        `| O1 tok/step p50 | ${fmt(pO1?.perStepTokensTiktoken.p50 ?? NaN)} | ${fmt(
          o1?.perStepTokensTiktoken.p50 ?? NaN
        )} |`
      );
      L.push(`| O3 cold tok/step p50 | ${fmt(pColdSrc)} | ${fmt(o3Cold)} |`);
      L.push(`| O4 warm tok/step p50 | ${fmt(pWarmSrc)} | ${fmt(o4Warm)} |`);
      L.push(
        `| B2 tok/step p50 | ${fmt(pB2?.perStepTokensTiktoken.p50 ?? NaN)} | ${fmt(
          b2?.perStepTokensTiktoken.p50 ?? NaN
        )} |`
      );
      L.push("");
      L.push(
        "pass1 H4/B1 (33 %) is intentionally omitted: it was the pre-C.1 artifact " +
          "(centre taps + a describe-scan oracle) this ticket replaces.");
      L.push("");
    } catch (e) {
      realDebug(`[bench-sg] pass1 appendix skipped: ${String(e)}`);
    }
  }
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

  // Dismiss Chrome's first-run flow ONCE up front so example.com renders for
  // every chrome task and every config (incl. B1, which launches Chrome with the
  // open flag off). Without this all 6 chrome tasks fail identically for all
  // configs, flattening success and making H4 unmeasurable. Best-effort.
  if (TASKS.some((t) => t.app === "chrome")) {
    await prepareChromeOnce();
  }

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

    // B1 locate plumbing: precompute every tap coordinate in ONE open-server
    // pass BEFORE switching to the proprietary backend (ticket §1).
    let precomputed: Map<string, Located> | null = null;
    let precomputeMs = 0;
    if (config === "B1") {
      const pc = await precomputeB1Coords();
      precomputed = pc.coords;
      precomputeMs = pc.plumbingMs;
      const missed = [...pc.coords.entries()].filter(([, v]) => !v.found).map(([k]) => k);
      realDebug(
        `[bench-sg] B1 precompute done in ${precomputeMs}ms: ${pc.coords.size} coords, ${missed.length} miss` +
          (missed.length ? ` (${missed.join(",")})` : "")
      );
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

    // HIGH-4: abort a config after N CONSECUTIVE task throws (backend down /
    // UiAutomation contended), not just on the first task. Errored runs are
    // recorded explicitly (taskError:true) so they show up excluded, not missing.
    const MAX_CONSECUTIVE_ERRORS = 3;
    let aborted: string | undefined;
    let consecutiveErrors = 0;
    try {
      loop: for (let rep = 0; rep < REPS; rep++) {
        for (const task of TASKS) {
          let err: unknown;
          const rec = await runTask(reg, config, task, rep, knownBefore, precomputed).catch((e) => {
            err = e;
            realDebug(`[bench-sg] ${config}/${task.id}/rep${rep} error: ${String(e)}`);
            return null;
          });
          if (rec) {
            records.push(rec);
            allRecords.push(rec);
            consecutiveErrors = 0;
          } else {
            const errored = erroredTaskRecord(config, task, rep);
            records.push(errored);
            allRecords.push(errored);
            consecutiveErrors++;
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              aborted =
                `aborted after ${consecutiveErrors} consecutive task errors ` +
                `(last: ${task.id}/rep${rep}: ${String(err)})`;
              realDebug(`[bench-sg] ${config} ${aborted}`);
              break loop;
            }
          }
        }
      }
    } finally {
      await reg.dispose().catch(() => undefined);
    }
    if (aborted) skipped[config] = aborted;

    const fb = fallbacksSince(mark);
    // HIGH-5: a describe/tree FALLBACK on B1 means the proprietary path was not
    // actually exercised (it silently ran the generic uiautomator dump after our
    // per-task ADT force-stop) — B1's metrics are then invalid. Flag it loudly.
    if (config === "B1" && fb.count > 0) {
      skipped["B1-invalid"] =
        `${fb.count} describe/tree fallback(s) — proprietary path NOT exercised; ` +
        `B1 metrics INVALID. Samples: ${fb.samples.join(" | ")}`;
      realDebug(`[bench-sg] B1 INVALID: ${fb.count} fallbacks — ${fb.samples.join(" | ")}`);
    }
    const agg = aggregate(config, records, fb.count, precomputeMs);
    aggs.push(agg);
    blockParams.push({ block: config, gestureParams: BENCH_GESTURE_PARAMS });
    realDebug(
      `[bench-sg] ${config} done: ${records.length} task-runs, success ${agg.successRate} ` +
        `(scored ${agg.scored}/${agg.total}, excluded ${agg.excluded} ` +
        `[loc ${agg.locateFailed}/act ${agg.actionFailed}/ora ${agg.oracleError}/task ${agg.taskError}], ` +
        `fallbacks ${agg.fallbacks}, plumb ${agg.plumbingMs}ms)`
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
