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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  getSkippedNoIdHash,
  resetSkippedNoIdHash,
  takeRecordMs,
} from "../src/utils/screen-graph-open-wiring";
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
import { observationQuery } from "../src/screen-graph/bench/observe";
import { parseDescribeLocate } from "../src/screen-graph/bench/describe-locate";
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
// C.4 work item F: 5 reps by default so a 95% Wilson interval is tight enough to
// separate configs above the ~3.4–8.3 pp run-to-run noise floor the C.3 review
// measured on identical code.
const REPS = Number(process.env.BENCH_REPS ?? 5);
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

/**
 * Phase D.2 M2: shape of the persisted Settings graph — node/edge counts and
 * out-degree. `buildSummary` lists up to 6 outgoing edges, so the warm summary
 * (and thus H3's ratio) tracks out-degree; report it beside H3. Best-effort.
 */
function settingsGraphShape(): {
  nodes: number;
  edges: number;
  maxOutDegree: number;
  meanOutDegree: number;
} | undefined {
  try {
    const dir = join(graphDir(), "com.android.settings");
    if (!existsSync(dir)) return undefined;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    let nodes = 0;
    let edges = 0;
    const outDeg = new Map<string, number>();
    for (const f of files) {
      const doc = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
        nodes?: Record<string, unknown>;
        edges?: Array<{ from?: string }>;
      };
      nodes += Object.keys(doc.nodes ?? {}).length;
      for (const e of doc.edges ?? []) {
        edges += 1;
        if (e.from) outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
      }
    }
    const degs = [...outDeg.values()];
    const maxOutDegree = degs.length ? Math.max(...degs) : 0;
    const meanOutDegree = nodes > 0 ? Number((edges / nodes).toFixed(2)) : 0;
    return { nodes, edges, maxOutDegree, meanOutDegree };
  } catch {
    return undefined;
  }
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
 * The OPEN configs locate via the server's own `query` (node pixel bounds,
 * normalized by `getInfo`). B1 (proprietary, no open query) does NOT call this:
 * it locates its tap target LIVE from the `describe` it already paid for, every
 * step, via `parseDescribeLocate` (C.4 work item A — the C.3 up-front
 * `precomputeB1Coords` replayed one stale coordinate for every rep and made B1's
 * success a harness artifact). Calling this on B1 is a harness bug and throws.
 */
async function locateNorm(reg: Reg, config: BenchConfigId, sel: BenchSelector): Promise<Located> {
  if (!usesOpenServer(config)) {
    throw new Error(`locateNorm called for non-open config ${config}; B1 locates from its own describe`);
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

// B1's live describe+tap locate is `parseDescribeLocate`, imported from
// `src/screen-graph/bench/describe-locate.ts` (a pure, unit-tested module — the
// bench script self-executes on import so the parser cannot live here).

/**
 * Current screen IDENTITY hash `H_id` via the open server (empty on B1). The
 * graph keys nodes by H_id (phase D §1), so known/revisited bookkeeping and the
 * per-step `hash` field use it, not the scroll-sensitive structural `H`.
 */
async function currentHash(reg: Reg, config: BenchConfigId): Promise<string> {
  if (!usesOpenServer(config)) return "";
  try {
    const server = await openServer(reg);
    const s = await server.getState({ includeScreenshot: false });
    return s.idHash ?? s.hash ?? "";
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
  /** how this step's action was performed (C.4 work item B). */
  strategy: "navigate" | "locate-tap" | "none";
  /** this step is a known-target tap O5 tries to route (denominator for O5-pure). */
  knownTarget: boolean;
  /** structured navigate-to result for an O5 known-target tap step, if attempted. */
  nav?: NavRecord;
  /** the O5 route failed/mis-landed and this step fell back to locate+tap. */
  navFallback: boolean;
  /** the resulting screen's structural hash (open configs; "" for B1). */
  hash: string;
  /** how the resulting screen was recognised: exact hash, or n/a. */
  knownScreenVia: "exact" | "none";
  /** revisited = the resulting screen was already known when the step ran. */
  revisited: boolean;
  /** the tap target could not be located; the task aborts here (ticket §2). */
  locateFailed: boolean;
  /** an action tool call (tap/gesture) threw; the task aborts (review MEDIUM-8). */
  actionFailed: boolean;
  /** this step is INTENDED to keep the same screen (H2 same-screen subset). */
  sameScreen: boolean;
  /**
   * Phase D.2 L4: wall time the graph RECORDING spent on this step (settled
   * getState + getInfo + versionCode + store write), for open configs. Off the
   * agent's timed tool cost but inside the wall clock, so the ~1 s gap vs B1 is
   * attributed. 0 for B1 (no open-server recording) and non-open steps.
   */
  recordMs: number;
  /**
   * Phase D.2 HIGH-2: measured device RPCs for a routed known-target tap — the
   * navigate-to RPCs plus the bench's arrival verify (queryPresent + idle). Only
   * set on O5 known-target taps that routed; undefined otherwise.
   */
  measuredRpc?: number;
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
  /** Phase D.2 L2: set only by `erroredTaskRecord` — a pre-action shared-infra
   *  fault; the sole case `isExcludedRun` excludes. Normally none. */
  infraPreAction?: boolean;
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

/**
 * The structured `navigate-to` outcome for one O5 known-target tap step (C.4 work
 * item B) — persisted so fallbacks are counted from records, not console text,
 * and O5-pure vs O5-mixed can be split. `strategy` is how the tap was ultimately
 * performed.
 */
interface NavRecord {
  attempted: boolean;
  reached: boolean;
  completedSteps: number;
  totalSteps: number;
  error?: string;
  fromVia?: string;
  fromScore?: number;
  /** `navigate-to` reported reached but the routing target was not live-present. */
  misland?: boolean;
  /**
   * Why a planned step diverged during replay (phase D.1 Fix A): `selector
   * ambiguous on live tree` (a recorded key matched >1 live node) or `selector
   * unresolved on live tree` (matched 0). Absent for a plain hash-mismatch
   * divergence or a no-route.
   */
  divergeReason?: string;
  /** Measured device RPCs navigate-to issued for this tap (phase D.2 HIGH-2). */
  rpcCount?: number;
}

interface ActionResult {
  rttMs: number;
  outcome?: { changed: boolean; newScreen: boolean };
  usedNavigate: boolean;
  /** How the action was performed: navigate route, plain locate+tap, or n/a. */
  strategy: "navigate" | "locate-tap" | "none";
  /** Structured navigate-to result for an O5 known-target tap step. */
  nav?: NavRecord;
  /** the O5 route failed/mis-landed and the step fell back to locate+tap. */
  navFallback: boolean;
  /** tap target could not be located — the task aborts (ticket §2). */
  locateFailed: boolean;
  /** the action tool call threw — the task aborts, run invalid (review MEDIUM-8). */
  actionFailed: boolean;
}

/** Whether a selector is live-present on the current screen (open configs only). */
async function queryPresent(reg: Reg, sel: BenchSelector): Promise<boolean> {
  try {
    const server = await openServer(reg);
    const q = await server.query(toOpenSelector(sel), { limit: 1 });
    return q.nodes.length > 0;
  } catch {
    return false;
  }
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

  // O5 navigate-to: replace the tap+observe loop with one plan when the target is
  // known and the graph can route to it. The full navigate result is captured
  // (C.4 work item B): `reached`, `completedSteps`, `totalSteps`, `error`, how the
  // FROM screen localized. On `reached` we ALSO verify the routing target is
  // live-present — `navigate-to` verifies arrival by structural hash, which can
  // match a drifted-but-wrong screen (review C-H2/C-H3), so a "reached" without
  // the target present is a mis-land, not a success. A no-route, a divergence, a
  // throw, or a mis-land falls back to a plain locate+tap ON THE SAME OPEN
  // BACKEND (O5's own recovery, never a switch to another config); and on a
  // PARTIAL route (completedSteps > 0, the screen already moved) we RE-OBSERVE
  // and RE-LOCATE before the fallback tap — never tap a stale coordinate.
  let nav: NavRecord | undefined;
  if (useNavigate && a.kind === "tap") {
    const target = navSel ?? a.selector;
    nav = { attempted: true, reached: false, completedSteps: 0, totalSteps: 0 };
    try {
      const r = (await reg.invokeTool("navigate-to", {
        udid: SERIAL,
        target: { selector: toBenchTarget(target) },
      })) as {
        reached?: boolean;
        completedSteps?: number;
        totalSteps?: number;
        error?: string;
        fromVia?: string;
        fromScore?: number;
        divergeReason?: string;
        rpcCount?: number;
      };
      nav.reached = Boolean(r?.reached);
      nav.completedSteps = r?.completedSteps ?? 0;
      nav.totalSteps = r?.totalSteps ?? 0;
      if (r?.error) nav.error = r.error;
      if (r?.fromVia) nav.fromVia = r.fromVia;
      if (typeof r?.fromScore === "number") nav.fromScore = r.fromScore;
      if (r?.divergeReason) nav.divergeReason = r.divergeReason;
      if (typeof r?.rpcCount === "number") nav.rpcCount = r.rpcCount;
      if (nav.reached) {
        await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 3000 }).catch(() => undefined);
        // Verify the route landed where the needle lives; the graph verifies by
        // hash only. `navSel` is a destination identity distinct from the oracle.
        const present = await queryPresent(reg, target);
        if (present) {
          return {
            rttMs: Date.now() - t0,
            usedNavigate: true,
            strategy: "navigate",
            nav,
            navFallback: false,
            locateFailed: false,
            actionFailed: false,
          };
        }
        nav.misland = true;
        realDebug(
          `[bench-sg] navigate-to reached but ${JSON.stringify(target)} not live-present; re-observe + fallback`
        );
      } else {
        realDebug(
          `[bench-sg] navigate-to no-route/divergence for ${JSON.stringify(target)} ` +
            `(completed ${nav.completedSteps}/${nav.totalSteps}${nav.error ? `, ${nav.error}` : ""}); falling back`
        );
      }
    } catch (e) {
      nav.error = String(e);
      realDebug(`[bench-sg] navigate-to threw for ${JSON.stringify(target)}: ${String(e)}; falling back`);
    }
    // Fallback: re-observe when the route already EXECUTED a plan step, then
    // re-locate LIVE so the tap uses the current screen, not a stale coordinate.
    // Gate on `totalSteps > 0` (the plan ran at least its first action) — NOT on
    // `completedSteps > 0`: `runNavigation` returns `completedSteps:0` for a step
    // that diverged AFTER tapping (navigate.ts does not increment on divergence),
    // so `completedSteps:0` does NOT mean "never tapped" (review C4-H4). A true
    // no-route has `totalSteps:0` (no plan), leaving the source screen intact.
    if (nav.totalSteps > 0) {
      await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 3000 }).catch(() => undefined);
      await reg.invokeTool("describe", { udid: SERIAL }).catch(() => undefined);
    }
    located = await locateNorm(reg, config, a.selector);
    if (!located.found) {
      return {
        rttMs: Date.now() - t0,
        usedNavigate: false,
        strategy: "locate-tap",
        nav,
        navFallback: true,
        locateFailed: true,
        actionFailed: false,
      };
    }
    const tapRes = await tapAt(reg, located);
    if (tapRes.failed) {
      return { rttMs: Date.now() - t0, usedNavigate: false, strategy: "locate-tap", nav, navFallback: true, locateFailed: false, actionFailed: true };
    }
    return {
      rttMs: Date.now() - t0,
      outcome: tapRes.outcome,
      usedNavigate: false,
      strategy: "locate-tap",
      nav,
      navFallback: true,
      locateFailed: false,
      actionFailed: false,
    };
  }

  if (a.kind === "launch") {
    // launch handled by the caller (app reset); this is a no-op timing anchor.
    return { rttMs: 0, usedNavigate: false, strategy: "none", navFallback: false, locateFailed: false, actionFailed: false };
  }
  if (a.kind === "back") {
    try {
      adb(["shell", "input keyevent 4"], 6_000);
    } catch (e) {
      realDebug(`[bench-sg] back keyevent failed: ${String(e)}`);
      return { rttMs: Date.now() - t0, usedNavigate: false, strategy: "none", navFallback: false, locateFailed: false, actionFailed: true };
    }
    return { rttMs: Date.now() - t0, usedNavigate: false, strategy: "none", navFallback: false, locateFailed: false, actionFailed: false };
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
      return { rttMs: Date.now() - t0, usedNavigate: false, strategy: "none", navFallback: false, locateFailed: false, actionFailed: true };
    }
    return { rttMs: Date.now() - t0, usedNavigate: false, strategy: "none", navFallback: false, locateFailed: false, actionFailed: false };
  }
  if (a.kind === "type") {
    // A `type` follows a tap that opened + focused the field (e.g. the Settings
    // search box); type straight into it. `adb input text` needs spaces escaped.
    try {
      await reg.invokeTool("keyboard", { udid: SERIAL, text: a.text });
    } catch (e) {
      realDebug(`[bench-sg] keyboard failed: ${String(e)}`);
      return { rttMs: Date.now() - t0, usedNavigate: false, strategy: "none", navFallback: false, locateFailed: false, actionFailed: true };
    }
    await sleep(800); // async search results populate off the main thread
    return { rttMs: Date.now() - t0, usedNavigate: false, strategy: "none", navFallback: false, locateFailed: false, actionFailed: false };
  }
  if (a.kind === "tapXY") {
    // Fixed-coordinate tap (no locate) for the same-screen H2 no-op taps.
    const tapRes = await tapAt(reg, { xNorm: a.x, yNorm: a.y, found: true });
    if (tapRes.failed) {
      return { rttMs: Date.now() - t0, usedNavigate: false, strategy: "none", navFallback: false, locateFailed: false, actionFailed: true };
    }
    return { rttMs: Date.now() - t0, outcome: tapRes.outcome, usedNavigate: false, strategy: "none", navFallback: false, locateFailed: false, actionFailed: false };
  }
  // Plain tap. `located` is resolved by the caller (open `query` live for every
  // open config; for B1 parsed live from the describe it just paid for). A failed
  // locate ABORTS the task instead of tapping screen centre (ticket §2) — a centre
  // tap silently corrupts every downstream step and the assertion.
  if (!located || !located.found) {
    return { rttMs: Date.now() - t0, usedNavigate: false, strategy: "locate-tap", navFallback: false, locateFailed: true, actionFailed: false };
  }
  const tapRes = await tapAt(reg, located);
  if (tapRes.failed) {
    return { rttMs: Date.now() - t0, usedNavigate: false, strategy: "locate-tap", navFallback: false, locateFailed: false, actionFailed: true };
  }
  return { rttMs: Date.now() - t0, outcome: tapRes.outcome, usedNavigate: false, strategy: "locate-tap", navFallback: false, locateFailed: false, actionFailed: false };
}

/** Perform a normalized-coordinate tap; surface its outcome or a throw. */
async function tapAt(
  reg: Reg,
  loc: Located
): Promise<{ outcome?: { changed: boolean; newScreen: boolean }; failed: boolean }> {
  try {
    const res = (await reg.invokeTool("gesture-tap", { udid: SERIAL, x: loc.xNorm, y: loc.yNorm })) as {
      outcome?: { changed: boolean; newScreen: boolean };
    };
    const outcome = res.outcome ? { changed: res.outcome.changed, newScreen: res.outcome.newScreen } : undefined;
    return { outcome, failed: false };
  } catch (e) {
    realDebug(`[bench-sg] gesture-tap failed: ${String(e)}`);
    return { failed: true };
  }
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
  knownBefore: Set<string>
): Promise<TaskRecord> {
  const wall0 = Date.now();
  const steps: StepRecord[] = [];
  let abortReason: "locate" | "action" | null = null;

  for (let i = 0; i < task.steps.length; i++) {
    const step = task.steps[i]!;
    const isLaunch = step.action.kind === "launch";
    const isTap = step.action.kind === "tap";
    if (isLaunch) {
      await launchApp(reg, task.app);
    }

    // Decide navigate up front for O5 known-target taps.
    const preDecision = observeAfterAction(config, { knownTarget: step.knownTarget });
    const useNavigate = preDecision.useNavigate && isTap;

    // B1 (proprietary) is a plain describe+tap agent (C.4 work item A): for a tap
    // it reads the screen ONCE via `describe` — the observation it pays for — and
    // locates the target LIVE inside that reading. No open-server query, no
    // precomputed / stale coordinate. Open configs locate via the live `query`.
    const b1DescribeTap = config === "B1" && isTap;
    let located: Located | null = null;
    let b1Obs: ObsResult | null = null;
    if (b1DescribeTap) {
      b1Obs = await runObservation(reg, config, "describe", {});
      located = parseDescribeLocate(b1Obs.text, (step.action as { selector: BenchSelector }).selector);
    } else if (isTap && usesOpenServer(config)) {
      located = await locateNorm(reg, config, (step.action as { selector: BenchSelector }).selector);
    }

    // O5 routes to the task's DESTINATION identity (navTarget), never the tap
    // selector (on the current screen → 0 steps). Falls back to the tap selector
    // when a task has no navTarget.
    const navSel: BenchSelector | null =
      task.navTarget ?? (isTap ? (step.action as { selector: BenchSelector }).selector : null);

    const tBefore = await traversals(reg, config);
    const action: ActionResult = isLaunch
      ? { rttMs: 0, usedNavigate: false, strategy: "none", navFallback: false, locateFailed: false, actionFailed: false }
      : await runAction(reg, config, step, useNavigate, located, navSel);

    // Resulting screen hash → known/revisited bookkeeping.
    const hash = await currentHash(reg, config);
    // O3 is the COLD baseline (ticket: "screen graph cold (empty store)"): the
    // store is populated for O4 to reuse, but O3 itself never reuses it — every
    // navigating step pays the cold describe. Warm configs (O4/O5) consult the
    // preloaded graph.
    const knownScreen = config !== "O3" && hash.length > 0 && knownBefore.has(hash);
    const revisited = knownScreen;

    // Observation. B1's tap-step describe already happened (pre-tap, above) and IS
    // the observation — no second read. Every other step reads AFTER the action per
    // the config policy; its query selector is needle-INDEPENDENT (C.4 work item D:
    // `observationQuery` never returns the assertion needle).
    let kind: ObservationKind;
    let obs: ObsResult;
    if (b1Obs) {
      kind = "describe";
      obs = b1Obs;
    } else {
      const decision = observeAfterAction(config, {
        outcome: action.outcome,
        knownScreen,
        knownTarget: step.knownTarget,
      });
      kind = decision.observations[0] ?? "none";
      obs = await runObservation(reg, config, kind, { selector: observationQuery(task, step) });
    }

    const tAfter = await traversals(reg, config);
    const traversalsDelta =
      isFinite(tBefore) && isFinite(tAfter) ? tAfter - tBefore : NaN;

    // Learn the screen for later revisits within this run.
    if (hash.length > 0) knownBefore.add(hash);

    const rttCount =
      (isLaunch ? 0 : 1) + (kind === "none" || kind === "graph-lookup" ? 0 : 1);

    // Phase D.2 L4: sample the recording wall time accrued for this step (settled
    // getState + store write inside the tap RPC), off the timed tool cost.
    const recordMs = takeRecordMs();
    // Phase D.2 HIGH-2: measured RPCs for a routed known-target tap — navigate-to's
    // own RPCs + the bench's arrival verify (await-screen-idle + queryPresent).
    const measuredRpc =
      action.strategy === "navigate" && typeof action.nav?.rpcCount === "number"
        ? action.nav.rpcCount + 2
        : undefined;

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
      strategy: action.strategy,
      knownTarget: step.knownTarget === true,
      ...(action.nav ? { nav: action.nav } : {}),
      navFallback: action.navFallback,
      hash,
      knownScreenVia: knownScreen ? "exact" : "none",
      revisited,
      locateFailed: action.locateFailed,
      actionFailed: action.actionFailed,
      sameScreen: step.sameScreen === true,
      recordMs,
      ...(measuredRpc !== undefined ? { measuredRpc } : {}),
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
    // Phase D.2 L2: a task that threw before producing ANY record is a pre-action
    // shared-infra fault (backend/emulator down before this config acted) — it
    // would strike every config identically, so it is the ONE case `infraPreAction`
    // marks and `isExcludedRun` excludes. This is the setter the field describes.
    infraPreAction: true,
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
  /** successful runs among the scored (Wilson numerator). */
  ok: number;
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
  /** Phase D.2 HIGH-2/L4: measured action wall time, recording wall time, and
   *  measured RPCs on routed known-target taps. */
  actionRttMs: ReturnType<typeof summarize>;
  recordMs: ReturnType<typeof summarize>;
  measuredRpc: ReturnType<typeof summarize>;
  rttCountPerStep: ReturnType<typeof summarize>;
  /** RTT count/step over SAME-SCREEN steps only (H2 subset; review addendum). */
  rttCountSameScreen: ReturnType<typeof summarize>;
  /** tokens on steps reaching a NOVEL screen (cold: describe/query). */
  coldTokensTiktoken: ReturnType<typeof summarize>;
  /** tokens on steps reaching a KNOWN screen (warm: graph-lookup). */
  warmTokensTiktoken: ReturnType<typeof summarize>;
  wallMs: ReturnType<typeof summarize>;
  /** off-metric plumbing ms (B1 oracle instrumentation switches; 0 elsewhere). */
  plumbingMs: number;
  /** describe/tree fallbacks from console text — for B1, any means INVALID. */
  fallbacks: number;
  /* --- O5 navigate-to structure (C.4 work item B), 0 for non-O5 configs ----- */
  /** known-target tap STEPS in scored runs (the O5-pure coverage denominator). */
  knownTargetSteps: number;
  /** known-target tap steps where navigate-to attempted a route. */
  navAttempted: number;
  /** known-target tap steps where the route reached AND the target was live. */
  navRouted: number;
  /** known-target tap steps that fell back to locate+tap (structured count). */
  navFallbacks: number;
  /** of the fallbacks, those where navigate reported reached but mis-landed. */
  navMisland: number;
  /** of the fallbacks, those that DIVERGED after tapping (a plan ran, `totalSteps>0`). */
  navDiverged: number;
  /** of the fallbacks, those with NO route at all (`totalSteps === 0`). */
  navNoRoute: number;
  /** no-route split (phase D.1): destination selector indexed by >1 node. */
  navNoRouteAmbiguous: number;
  /** no-route split (phase D.1): no edge reached a node indexing the target. */
  navNoRouteNoPath: number;
  /** diverged split (phase D.1): replay found >1 live node for the acted selector. */
  navDivergedSelectorAmbiguous: number;
  /** diverged split (phase D.1): replay found 0 live nodes for the acted selector. */
  navDivergedSelectorUnresolved: number;
  /** diverged split (phase D.1): the landed H_id simply mismatched the plan. */
  navDivergedHashMismatch: number;
  skipped?: string;
}

/**
 * Honest logical round-trip count for a step (phase D §0.7). For an O5
 * known-target tap that used navigate-to, this counts the RPCs the harness truly
 * issued — the recorded `rttCount` (1) omits the navigate + the fallback locate,
 * so the raw field undercounts O5 (review C4-M4). For every other step it equals
 * the recorded action + observation count.
 */
function effectiveRttCount(s: StepRecord): number {
  if (s.actionKind === "launch") return 0;
  const nav = s.nav;
  if (s.knownTarget && s.actionKind === "tap" && nav?.attempted) {
    let c = 1; // navigate-to
    if (nav.reached) c += 1; // queryPresent arrival verify
    if (s.navFallback) {
      if ((nav.totalSteps ?? 0) > 0) c += 1; // re-observe describe (route already moved the screen)
      c += 1; // re-locate query
      c += 1; // fallback tap
    }
    return c; // the observation on these steps is graph-lookup (0)
  }
  return 1 + (s.obs === "none" || s.obs === "graph-lookup" ? 0 : 1);
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
  // Phase D.2 HIGH-2 / L4: measured wall + RPC accounting.
  const actionRtt: number[] = [];
  const recordMsArr: number[] = [];
  const measuredRpc: number[] = [];
  let plumbingMs = extraPlumbingMs;
  let knownTargetSteps = 0;
  let navAttempted = 0;
  let navRouted = 0;
  let navFallbacks = 0;
  let navMisland = 0;
  let navDiverged = 0;
  let navNoRoute = 0;
  // Phase D.1: split the fallback causes. No-route: the plan step never ran —
  // either the destination selector was indexed by >1 node ("ambiguous target",
  // Fix B should drive this to 0) or no edge reached it ("no known path").
  // Diverged: a plan ran but replay could not uniquely re-resolve the acted
  // element ("selector ambiguous/unresolved on live tree", Fix A) or the landed
  // H_id simply mismatched.
  let navNoRouteAmbiguous = 0;
  let navNoRouteNoPath = 0;
  let navDivergedSelectorAmbiguous = 0;
  let navDivergedSelectorUnresolved = 0;
  let navDivergedHashMismatch = 0;

  // Nav counters over ALL records and ALL attempts (phase D §0.2) — BEFORE any
  // exclusion skip, so a known-target tap that FAILED (and would once have been
  // dropped from the denominator) is still counted. Fallbacks split three ways:
  // mis-landed (reached the wrong screen), diverged-after-tap (a plan ran,
  // `totalSteps>0`, but stopped before arrival), and no-route (`totalSteps===0`).
  for (const r of records) {
    for (const s of r.steps) {
      if (!(s.knownTarget && s.actionKind === "tap")) continue;
      knownTargetSteps += 1;
      if (s.nav?.attempted) navAttempted += 1;
      if (s.strategy === "navigate") navRouted += 1;
      if (s.navFallback) {
        navFallbacks += 1;
        if (s.nav?.misland) navMisland += 1;
        else if ((s.nav?.totalSteps ?? 0) > 0) {
          navDiverged += 1;
          const dr = s.nav?.divergeReason ?? "";
          if (dr.includes("ambiguous")) navDivergedSelectorAmbiguous += 1;
          else if (dr.includes("unresolved")) navDivergedSelectorUnresolved += 1;
          else navDivergedHashMismatch += 1;
        } else {
          navNoRoute += 1;
          const er = s.nav?.error ?? "";
          if (er.includes("ambiguous target")) navNoRouteAmbiguous += 1;
          else navNoRouteNoPath += 1;
        }
      }
    }
  }

  for (const r of records) {
    plumbingMs += r.plumbingMs ?? 0;
    // Only pre-action shared-infra runs are excluded (phase D §0.1); every other
    // run — including a config's own failed navigation — keeps its steps and wall
    // time in the distributions, so O5's per-step tokens/RTT are over ALL its
    // steps (155-ish), not just the runs its routing did not destroy (§0.7).
    if (isExcludedRun(r)) continue;
    walls.push(r.wallMs);
    for (const s of r.steps) {
      if (s.actionKind === "launch") continue;
      const eff = effectiveRttCount(s);
      stepTk.push(s.tokensTiktoken);
      stepC4.push(s.tokensCharsDiv4);
      stepRtt.push(s.rttMs);
      rttCount.push(eff);
      if (s.sameScreen) rttCountSS.push(eff);
      if (typeof s.actionRttMs === "number") actionRtt.push(s.actionRttMs);
      if (typeof s.recordMs === "number") recordMsArr.push(s.recordMs);
      if (typeof s.measuredRpc === "number") measuredRpc.push(s.measuredRpc);
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
    ok: acct.ok,
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
    actionRttMs: summarize(actionRtt),
    recordMs: summarize(recordMsArr),
    measuredRpc: summarize(measuredRpc),
    rttCountPerStep: summarize(rttCount),
    rttCountSameScreen: summarize(rttCountSS),
    coldTokensTiktoken: summarize(coldTk),
    warmTokensTiktoken: summarize(warmTk),
    wallMs: summarize(walls),
    plumbingMs,
    fallbacks,
    knownTargetSteps,
    navAttempted,
    navRouted,
    navFallbacks,
    navMisland,
    navDiverged,
    navNoRoute,
    navNoRouteAmbiguous,
    navNoRouteNoPath,
    navDivergedSelectorAmbiguous,
    navDivergedSelectorUnresolved,
    navDivergedHashMismatch,
  };
}

/* -------------------------------------------------------------------------- */
/* statistics helpers (C.4 work item F)                                        */
/* -------------------------------------------------------------------------- */

/**
 * 95% Wilson score interval for a binomial proportion `ok/n` (z = 1.96), as
 * percentages. Wilson (not normal-approximation) so it behaves at the small N and
 * near-100% rates this bench produces. Returns the point estimate and [lo, hi].
 */
function wilson95(ok: number, n: number): { p: number; lo: number; hi: number } {
  if (n <= 0) return { p: NaN, lo: NaN, hi: NaN };
  const z = 1.959963984540054;
  const phat = ok / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (phat + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom;
  const clamp = (x: number): number => Math.max(0, Math.min(1, x));
  return { p: phat * 100, lo: clamp(centre - half) * 100, hi: clamp(centre + half) * 100 };
}

/**
 * Task-cluster bootstrap 95% interval (phase D §0.3, review C4-H5). The 5 reps of
 * a task are CORRELATED, so the effective N is the 20 tasks, not 100 runs — a
 * naive Wilson at n=100 is up to ~2× too narrow where failures cluster (O5's 13
 * are 3 whole tasks). We resample the TASKS with replacement (`B` draws), recompute
 * the config's success rate over the resampled tasks' reps, and take the 2.5/97.5
 * percentiles. Deterministic (fixed seed) so the report regenerates identically.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOOTSTRAP_B = 10_000;
const BOOTSTRAP_SEED = 0x5eed_c0de;

/** Per (config, task) → success bits over reps, keyed for the bootstrap. */
function successByTask(records: TaskRecord[], config: BenchConfigId): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const r of records) {
    if (r.config !== config) continue;
    const arr = m.get(r.task) ?? [];
    const failReason = r.locateFailed || r.actionFailed || r.oracleError || r.taskError;
    arr.push(r.success && !isExcludedRun(r) && !failReason ? 1 : 0);
    m.set(r.task, arr);
  }
  return m;
}

function rateOverTasks(byTask: Map<string, number[]>, tasks: string[]): number {
  let num = 0;
  let den = 0;
  for (const t of tasks) {
    const v = byTask.get(t);
    if (!v) continue;
    for (const b of v) {
      num += b;
      den += 1;
    }
  }
  return den ? num / den : NaN;
}

interface Interval {
  p: number;
  lo: number;
  hi: number;
}

/** Cluster-bootstrap 95% CI (percentages) for one config's success rate. */
function clusterBootstrap95(records: TaskRecord[], config: BenchConfigId): Interval {
  const byTask = successByTask(records, config);
  const tasks = [...byTask.keys()];
  if (tasks.length === 0) return { p: NaN, lo: NaN, hi: NaN };
  const point = rateOverTasks(byTask, tasks) * 100;
  const rng = mulberry32(BOOTSTRAP_SEED);
  const boots: number[] = [];
  for (let b = 0; b < BOOTSTRAP_B; b++) {
    const sample: string[] = [];
    for (let i = 0; i < tasks.length; i++) sample.push(tasks[Math.floor(rng() * tasks.length)]!);
    boots.push(rateOverTasks(byTask, sample) * 100);
  }
  boots.sort((x, y) => x - y);
  return { p: point, lo: boots[Math.floor(0.025 * BOOTSTRAP_B)]!, hi: boots[Math.ceil(0.975 * BOOTSTRAP_B) - 1]! };
}

/** Paired cluster-bootstrap 95% CI (pp) for `config − baseline` success. */
function pairedClusterBootstrap95(
  records: TaskRecord[],
  config: BenchConfigId,
  baseline: BenchConfigId
): Interval {
  const byA = successByTask(records, config);
  const byB = successByTask(records, baseline);
  const tasks = [...new Set([...byA.keys(), ...byB.keys()])];
  if (tasks.length === 0) return { p: NaN, lo: NaN, hi: NaN };
  const point = (rateOverTasks(byA, tasks) - rateOverTasks(byB, tasks)) * 100;
  const rng = mulberry32(BOOTSTRAP_SEED);
  const boots: number[] = [];
  for (let b = 0; b < BOOTSTRAP_B; b++) {
    const sample: string[] = [];
    for (let i = 0; i < tasks.length; i++) sample.push(tasks[Math.floor(rng() * tasks.length)]!);
    boots.push((rateOverTasks(byA, sample) - rateOverTasks(byB, sample)) * 100);
  }
  boots.sort((x, y) => x - y);
  return { p: point, lo: boots[Math.floor(0.025 * BOOTSTRAP_B)]!, hi: boots[Math.ceil(0.975 * BOOTSTRAP_B) - 1]! };
}

/** O5-pure vs O5-mixed split (C.4 work item B). */
interface O5Split {
  /** all O5 scored runs (the published O5 success). */
  mixed: { ok: number; scored: number };
  /**
   * O5 scored runs whose EVERY known-target tap routed via navigate-to (no
   * fallback) — the "pure navigate" runs. */
  pure: { ok: number; scored: number; tokens: ReturnType<typeof summarize>; rtt: ReturnType<typeof summarize> };
}

function o5Split(records: TaskRecord[]): O5Split {
  const o5 = records.filter((r) => r.config === "O5" && !isExcludedRun(r));
  let mixedOk = 0;
  let pureOk = 0;
  let pureScored = 0;
  const pureTok: number[] = [];
  const pureRtt: number[] = [];
  for (const r of o5) {
    if (r.success) mixedOk += 1;
    const ktSteps = r.steps.filter((s) => s.knownTarget && s.actionKind === "tap");
    // A "pure" run has ≥1 known-target tap and routed every one of them.
    const isPure = ktSteps.length > 0 && ktSteps.every((s) => s.strategy === "navigate");
    if (isPure) {
      pureScored += 1;
      if (r.success) pureOk += 1;
      for (const s of r.steps) {
        if (s.actionKind === "launch") continue;
        pureTok.push(s.tokensTiktoken);
        pureRtt.push(effectiveRttCount(s));
      }
    }
  }
  return {
    mixed: { ok: mixedOk, scored: o5.length },
    pure: { ok: pureOk, scored: pureScored, tokens: summarize(pureTok), rtt: summarize(pureRtt) },
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
    "`success` = ok / total — EXCLUSIONS-AS-FAILURES (phase D §0.1): the denominator is the " +
      "full run count for every config, so a config cannot shrink its own denominator by " +
      "failing (review C4-H1). The PRIMARY interval is the task-cluster bootstrap (n=20 tasks, " +
      "the effective N — the 5 reps of a task are correlated, review C4-H5); the naive Wilson " +
      "(n=100) is kept as a SECONDARY column and reads too narrow where failures cluster. " +
      "`fail (L/A/O/T)` breaks the failures down by reason (locate/action/oracle/task) — these " +
      "are reasons, NOT exclusions. `navFb` is the STRUCTURED O5 navigate-to fallback count " +
      "(known-target taps that fell back to locate+tap, over ALL attempts). `fallbacks` is the " +
      "console describe/tree-fallback count — for B1 any means the proprietary path was NOT " +
      "exercised and its metrics are INVALID (review HIGH-5). RTT count/step is the HONEST count " +
      "(§0.7): an O5 known-target tap counts its navigate-to + the fallback locate + tap, not 1. " +
      "B1 locates LIVE from its own describe every step (no precompute)."
  );
  L.push("");
  L.push(
    "| Config | n steps | tok p50 | tok p95 | chars/4 p50 | RTT p50 (ms) | RTT count/step p50 | success | cluster 95% (n=20) | Wilson (n=100) | fail (L/A/O/T) | navFb | fallbacks | plumb ms |"
  );
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of REPORT_ORDER) {
    const a = by(c);
    if (!a) continue;
    const failCount = a.total - a.ok - a.excluded;
    const failCell = `${failCount} (${a.locateFailed}/${a.actionFailed}/${a.oracleError}/${a.taskError})`;
    const fbCell = c === "B1" && a.fallbacks > 0 ? `**${a.fallbacks}** ⚠` : String(a.fallbacks);
    const w = wilson95(a.ok, a.scored);
    const wCell = Number.isFinite(w.lo) ? `[${w.lo.toFixed(0)}, ${w.hi.toFixed(0)}]` : "—";
    const cb = clusterBootstrap95(records, c);
    const cbCell = Number.isFinite(cb.lo) ? `[${cb.lo.toFixed(0)}, ${cb.hi.toFixed(0)}]` : "—";
    const navFbCell = c === "O5" ? `${a.navFallbacks}/${a.knownTargetSteps}` : "—";
    L.push(
      `| ${c} | ${a.perStepTokensTiktoken.n} | ${fmt(a.perStepTokensTiktoken.p50)} | ${fmt(
        a.perStepTokensTiktoken.p95
      )} | ${fmt(a.perStepTokensCharsDiv4.p50)} | ${fmt(a.perStepRtt.p50)} | ${fmt(
        a.rttCountPerStep.p50
      )} | ${(a.successRate * 100).toFixed(0)}% (${a.ok}/${a.total}) | ${cbCell} | ${wCell} | ${failCell} | ${navFbCell} | ${fbCell} | ${a.plumbingMs} |`
    );
  }
  L.push("");

  // O5 navigate-to structure + O5-pure vs O5-mixed (C.4 work item B).
  const o5 = by("O5");
  if (o5) {
    const split = o5Split(records);
    const cov = o5.knownTargetSteps > 0 ? `${o5.navRouted}/${o5.knownTargetSteps}` : "—/—";
    const pureW = wilson95(split.pure.ok, split.pure.scored);
    const mixedW = wilson95(split.mixed.ok, split.mixed.scored);
    L.push("## O5 navigate-to structure (from structured records, over ALL attempts)");
    L.push("");
    L.push(
      `- O5-pure coverage: **${cov}** known-target taps ROUTED via navigate-to ` +
        `(attempted ${o5.navAttempted}). Fallbacks ${o5.navFallbacks}/${o5.knownTargetSteps}: ` +
        `mis-landed ${o5.navMisland}, diverged-after-tap ${o5.navDiverged}, ` +
        `no-route ${o5.navNoRoute} (phase D §0.2, counted over ALL attempts before any exclusion).`
    );
    L.push(
      `- No-route split (phase D.1): ambiguous-target ${o5.navNoRouteAmbiguous}, ` +
        `no-known-path ${o5.navNoRouteNoPath}. Diverged split: selector-ambiguous-on-live-tree ` +
        `${o5.navDivergedSelectorAmbiguous}, selector-unresolved-on-live-tree ` +
        `${o5.navDivergedSelectorUnresolved}, hash-mismatch ${o5.navDivergedHashMismatch}.`
    );
    L.push(
      `- Records skipped for a missing H_id (phase D.1 Fix B, recordSkippedNoIdHash): ` +
        `${typeof env.skippedNoIdHash === "number" ? env.skippedNoIdHash : getSkippedNoIdHash()} ` +
        `(a structural-hash node was never created).`
    );
    L.push(
      `- **O5-mixed** (all scored runs, the published O5): ${split.mixed.ok}/${split.mixed.scored} ` +
        `= ${(mixedW.p || 0).toFixed(0)}% [${mixedW.lo.toFixed(0)}, ${mixedW.hi.toFixed(0)}].`
    );
    L.push(
      `- **O5-pure** (runs whose every known-target tap routed): ${split.pure.ok}/${split.pure.scored}` +
        (split.pure.scored > 0
          ? ` = ${(pureW.p || 0).toFixed(0)}% [${pureW.lo.toFixed(0)}, ${pureW.hi.toFixed(0)}]; ` +
            `tokens/step p50 ${fmt(split.pure.tokens.p50)} (n=${split.pure.tokens.n}).`
          : " — no run routed every known-target tap (see coverage above)."));
    // Phase D.2 HIGH-2: MEASURED RPCs for a routed known-target tap (navigate-to's
    // real getState/query/tap/getState + the bench's arrival verify), replacing
    // the modelled "2". Half of O5's 100 runs have no known-target tap, so this is
    // reported over the routed taps only (phase D.2 M4).
    L.push(
      `- **O5 measured RPCs per routed tap p50: ${fmt(o5.measuredRpc.p50)}** ` +
        `(n=${o5.measuredRpc.n} routed taps; navigate-to RPCs + await-idle + queryPresent), ` +
        `replacing the modelled "2". O5 action wall p50 ${fmt(o5.actionRttMs.p50)} ms (all steps).`
    );
    L.push("");
  }

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
  // H4 (phase D §0.3): compare each open config to each baseline on the FULL
  // 100-run denominator — NO shared-pair intersection (the C.4 intersection
  // removed the same runs O5 destroyed from the baseline too, review C4-H2). The
  // discriminator is the PAIRED task-cluster bootstrap of the success difference
  // (effective N = 20 tasks); a config is INFERIOR only when its point estimate is
  // more than the ~3.4–8.3 pp noise floor below the baseline (we use 5 pp) — the
  // run-to-run noise cannot otherwise be told apart. Wilson stays as a footnote.
  const b1Invalid = Boolean(b1 && b1.fallbacks > 0);
  const INFERIOR_MARGIN_PP = 5;
  const h4Row = (base: ConfigAgg | undefined, invalid: boolean): string => {
    if (!base) return "baseline absent";
    if (invalid) return "INVALID BASELINE (describe fallback → proprietary path not exercised)";
    const parts: string[] = [];
    let anyInferior = false;
    for (const a of aggs.filter((x) => x.config.startsWith("O"))) {
      const d = pairedClusterBootstrap95(records, a.config, base.config);
      const inferior = d.p <= -INFERIOR_MARGIN_PP;
      if (inferior) anyInferior = true;
      const tag = inferior ? "INFERIOR ✗" : "non-inferior";
      parts.push(
        `${a.config} Δ ${d.p >= 0 ? "+" : ""}${d.p.toFixed(0)} pp [${d.lo.toFixed(0)}, ${d.hi.toFixed(0)}] — ${tag}`
      );
    }
    return `${anyInferior ? "FAIL (an O-config is inferior)" : "PASS (none inferior)"} — ${parts.join("; ")}`;
  };
  const baseCell = (a?: ConfigAgg): string => {
    if (!a) return "—";
    const cb = clusterBootstrap95(records, a.config);
    const w = wilson95(a.ok, a.scored);
    return `${(a.successRate * 100).toFixed(0)}% (${a.ok}/${a.total}) cluster [${cb.lo.toFixed(0)}, ${cb.hi.toFixed(0)}] · Wilson [${w.lo.toFixed(0)}, ${w.hi.toFixed(0)}]`;
  };
  L.push(
    "**H4 — success non-inferior to each baseline, ONE oracle for every config**, on the FULL " +
      "100-run denominator (exclusions-as-failures), with the PAIRED task-cluster bootstrap of " +
      "`Δ = config − baseline` (phase D §0.3). A config is INFERIOR when its point estimate is " +
      `more than ${INFERIOR_MARGIN_PP} pp (the noise floor) below the baseline. No shared-pair ` +
      "intersection — the C.4 intersection removed the runs O5 destroyed from the baseline too " +
      "(review C4-H2). B1 locates LIVE from its own describe (no precompute)."
  );
  L.push("");
  L.push("| Baseline | Baseline success (cluster / Wilson) | Verdict (O1..O5, paired cluster-bootstrap Δ) |");
  L.push("|---|---|---|");
  L.push(
    `| B1 (argent proprietary) | ${baseCell(b1)}${b1Invalid ? " ⚠INVALID" : ""} | ${h4Row(b1, b1Invalid)} |`
  );
  L.push(`| B2 (open server, no graph) | ${baseCell(b2)} | ${h4Row(b2, false)} |`);
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
    "- Locate (C.4 work item A): open configs locate via the live open-server `query`; B1 " +
      "locates LIVE from the `describe` it pays for each step (a plain describe+tap agent) — no " +
      "precompute, no stale/replayed coordinate. A failed locate ABORTS the task (`locate-fail`) " +
      "instead of tapping screen centre, and is excluded from the success denominator.");
  L.push(
    "- O5 navigate-to (C.4 work item B/C): `navTarget` is a DESTINATION identity, never the " +
      "oracle needle; the tool localizes the FROM screen by exact hash else a resource-id " +
      "Jaccard match (≥0.9) and verifies each arrival tolerantly, so a drifted root hash no " +
      "longer loses the route. A route that does not reach, or reaches but leaves the target not " +
      "live-present, re-observes and falls back to a plain locate+tap (counted structurally as " +
      "`navFb`). O5-pure = runs whose every known-target tap routed; O5-mixed = all O5 runs.");
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
  // L=locate-failed (aborted — counts as a FAILURE, phase D §0.1), .=config absent.
  L.push("## Per-task success matrix (per config)");
  L.push("");
  L.push(
    "Legend: `Y` oracle met · `N` oracle unmet · `L` locate-failed (aborted). " +
      "`L` and `N` BOTH count as failures on the full denominator (phase D §0.1) — `L` merely " +
      "records that the run aborted on a locate rather than reaching a met/unmet oracle."
  );
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

/**
 * Offline report regeneration (phase D §0.8): rebuild the results doc from a prior
 * run's JSON with the CURRENT (corrected) accounting — no device, no new run.
 * `BENCH_REGEN=<bench-sg-*.json>` [+ `BENCH_REPORT=<out.md>`]. Rebuilds the
 * aggregates from the stored per-run records so every corrected rule (exclusions-
 * as-failures, nav counters over all attempts, honest RTT, paired cluster
 * bootstrap, no H4 intersection) applies to the old data.
 */
function regenerateFromJson(regenPath: string): void {
  const raw = JSON.parse(readFileSync(regenPath, "utf8")) as {
    env?: Record<string, unknown>;
    records: TaskRecord[];
    skipped?: Record<string, string>;
    aggregates?: Array<{ config: BenchConfigId; fallbacks?: number }>;
  };
  const records = raw.records;
  const skipped = raw.skipped ?? {};
  const fbByConfig = new Map<BenchConfigId, number>();
  for (const a of raw.aggregates ?? []) fbByConfig.set(a.config, a.fallbacks ?? 0);
  const aggs: ConfigAgg[] = [];
  for (const c of REPORT_ORDER) {
    const rs = records.filter((r) => r.config === c);
    if (rs.length === 0) continue;
    aggs.push(aggregate(c, rs, fbByConfig.get(c) ?? 0, 0));
  }
  const env = { ...(raw.env ?? {}), regeneratedFrom: regenPath.split("/").pop(), regeneratedAt: new Date().toISOString() };
  const report = buildReport(aggs, env, skipped, records);
  const outPath = process.env.BENCH_REPORT ?? join(OUT_DIR, "results-ci.md");
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(outPath, report);
  process.stdout.write(`REGEN_FROM=${regenPath}\nREPORT_MD=${outPath}\n`);
}

async function main(): Promise<void> {
  const regenPath = process.env.BENCH_REGEN;
  if (regenPath) {
    regenerateFromJson(regenPath);
    return;
  }
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

  // Phase D.1: start the matrix from an EMPTY graph store (so no store persisted
  // by a previous run leaks pre-D.1 edges into routing) and RECORD selector edges
  // for every config that acts on the open server (B2/O1/O2 included) via
  // record-only mode. By the time O5 runs LAST, its store holds selector edges
  // over the whole task list. Recording is graph MAINTENANCE, off the agent's
  // timed observation cost, and never changes a config's observation policy (the
  // describe tiers stay gated on the `screen-graph` flag, which is off for
  // B1/B2/O1/O2). B1 has no open server in its loop, so it contributes no
  // recordings — the six open configs traverse the identical tasks, so O5's store
  // is fully covered without it.
  clearGraph();
  resetSkippedNoIdHash();
  process.env.ARGENT_SG_RECORD = "1";

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

    // C.4 work item A: no B1 precompute. B1 locates each tap LIVE from the
    // describe it pays for, in `runTask`.
    const precomputeMs = 0;

    applyFlags(config);
    await teardownBackend();

    // Phase D.1: the store is cleared ONCE before the loop and accumulates across
    // configs (all-config recording), so O3 no longer clears it. O3 stays the
    // COLD baseline via the `knownScreen = config !== "O3"` guard in runTask (it
    // never consults the graph and pays a full describe every step, so a
    // pre-populated store does not change its cold token cost).
    if (usesGraph(config) && config !== "O3") {
      // Warm: a store should exist by now (earlier configs populated it).
      if (!existsSync(graphDir())) skipped[`${config}-note`] = "no warm store (earlier configs recorded none)";
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
          const rec = await runTask(reg, config, task, rep, knownBefore).catch((e) => {
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

  // Phase D.1 Fix B: persist the count of records dropped for a missing H_id so
  // the doc regenerated from JSON can quote it (the live counter is 0 on regen).
  env.skippedNoIdHash = getSkippedNoIdHash();
  // Phase D.2 M1: persist the bootstrap resample count so the doc reads it from
  // the JSON instead of hand-typing it.
  env.bootstrapB = BOOTSTRAP_B;
  // Phase D.2 M2: persist the settings graph shape (out-degree) so H3 can be read
  // alongside it — the warm summary lists ≤6 outgoing edges, so the token ratio
  // tracks graph density.
  env.settingsGraph = settingsGraphShape();

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

  // C.4 work item C: copy the persisted screen graph into OUT_DIR so the run
  // UPLOADS it as an artifact — the C.3 runs shipped no graph store, so the
  // root-hash instability could not be shown from the artifacts. Each node now
  // carries its resource-id multiset + hash, giving two real roots for analysis.
  try {
    const src = graphDir();
    if (existsSync(src)) {
      const dst = join(OUT_DIR, "graph-store");
      cpSync(src, dst, { recursive: true });
      realDebug(`[bench-sg] copied graph store ${src} -> ${dst}`);
    }
  } catch (e) {
    realDebug(`[bench-sg] graph-store copy skipped: ${String(e)}`);
  }

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
