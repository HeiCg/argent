/**
 * Screen-graph Phase C.1/C.3 PRE-FLIGHT.
 *
 * Single-emulator, ~10 min, NO matrix metrics. Boots the open device server,
 * dumps the full `query({}, { limit: 1000 })` node set (text + contentDescription)
 * of the two LAUNCH screens (Settings root, example.com), and evaluates every
 * task's assertion needle against them with the SAME oracle the matrix uses.
 *
 *  - BLOCKER-1: any needle that already matches the LAUNCH screen of a task that
 *    NAVIGATES away from it (all Settings tasks + same-screen tasks) would
 *    false-pass on a missed tap. The pre-flight names them so they can be moved
 *    to a destination-unique needle before the matrix.
 *  - BLOCKER-2: settle "documentation" vs "documents" etc. on example.com with
 *    the real dump, not assumption.
 *
 * C.3 changes:
 *  - GATE: the script EXITS 1 when any needle is BAD or MISSING (via the pure
 *    `preflightVerdict`), so — with `set -o pipefail` in the workflow — a
 *    non-zero `PROBLEM needles` count fails the pre-flight step and the matrix
 *    step never runs on a false-passing needle set.
 *  - Chrome FIRST-RUN: dismiss the "Welcome to Chrome / Turn on sync?" flow
 *    before dumping example.com, otherwise the launch screen is the FRE (not the
 *    page) and every chrome needle reads MISSING.
 *  - BENCH_CAPTURE=1: for every task, execute the task's steps once through the
 *    plain describe+tap path and dump the LAUNCH and DESTINATION screens'
 *    visible text/id to `.bench-results/screen-graph/capture.json`, so a
 *    destination-unique needle can be picked from real device text (never a
 *    guess). Capture mode never gates (exit 0) — it is the gathering pass.
 *
 * Writes a fixture (`test/fixtures/preflight-launch-screens.json`) the unit test
 * asserts against, and prints a human summary.
 *
 * Run like the harness (ts-node loader), open flag forced on here:
 *   ANDROID_HOME=$HOME/Library/Android/sdk BENCH_SERIAL=emulator-5554 \
 *   node -e 'require("ts-node").register({transpileOnly:true,skipProject:true,compilerOptions:{module:"commonjs",target:"ES2022",moduleResolution:"node",esModuleInterop:true,resolveJsonModule:true,skipLibCheck:true,strict:false,ignoreDeprecations:"6.0"}}); require("./packages/tool-server/scripts/bench-preflight.ts");'
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRegistry } from "../src/utils/setup-registry";
import { setFlag, unsetFlag } from "@argent/configuration-core";
import { openDeviceServerRef } from "../src/blueprints/android-open-server";
import type {
  OpenDeviceServerApi,
  OpenServerSelector,
} from "../src/blueprints/android-open-server";
import { resolveDevice } from "../src/utils/device-info";
import { ALL_TASKS } from "../src/screen-graph/bench/tasks";
import type { BenchApp, BenchSelector, BenchStep, BenchTask } from "../src/screen-graph/bench/types";
import { evaluateAssertion, type OracleNode } from "../src/screen-graph/bench/oracle";
import { preflightVerdict, type NeedleEvalRow } from "../src/screen-graph/bench/preflight";

const SERIAL = process.env.BENCH_SERIAL ?? "emulator-5554";
const PHYSICAL_DENY = "ZF524RZBHD";
if (SERIAL === PHYSICAL_DENY) throw new Error(`refuse to target ${PHYSICAL_DENY}`);
if (!SERIAL.startsWith("emulator-")) throw new Error(`BENCH_SERIAL must be emulator-*, got ${SERIAL}`);

const CAPTURE = process.env.BENCH_CAPTURE === "1" || process.env.BENCH_CAPTURE === "true";
const OUT_DIR = process.env.BENCH_OUT ?? join(process.cwd(), ".bench-results", "screen-graph");

const SETTINGS = "com.android.settings";
const CHROME = "com.android.chrome";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Clickable-label / id patterns that dismiss the Chrome first-run experience. */
const FRE_DISMISS =
  /use without an account|accept & continue|accept and continue|got it|no thanks|not now|maybe later|dismiss|skip|use without/i;
/** The page has actually rendered when this heading is present. */
const EXAMPLE_HEADING = /example domain/i;

function adbTry(args: string[], timeoutMs = 15_000): string {
  try {
    return execFileSync("adb", ["-s", SERIAL, ...args], { encoding: "utf8", timeout: timeoutMs });
  } catch {
    return "";
  }
}

type Reg = ReturnType<typeof createRegistry>;
async function openServer(reg: Reg): Promise<OpenDeviceServerApi> {
  const device = resolveDevice(SERIAL);
  const ref = openDeviceServerRef(device);
  return reg.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
}

interface ScreenDump {
  screen: { width: number; height: number };
  nodes: OracleNode[];
}

async function dumpScreen(reg: Reg): Promise<ScreenDump> {
  const server = await openServer(reg);
  let screen = { width: 1080, height: 2400 };
  try {
    const info = await server.getInfo();
    screen = { width: info.screenWidth || 1080, height: info.screenHeight || 2400 };
  } catch {
    /* default */
  }
  const res = await server.query({}, { limit: 1000 });
  const nodes: OracleNode[] = res.nodes.map((n) => ({ id: n.id, text: n.text, cd: n.cd, bounds: n.bounds }));
  return { screen, nodes };
}

function toOpenSelector(sel: BenchSelector): OpenServerSelector {
  const out: OpenServerSelector = {};
  if (sel.id) out.id = sel.id;
  if (sel.text) out.text = { contains: sel.text, caseInsensitive: true };
  return out;
}

/**
 * A task "navigates" away from its launch screen only via a REAL navigation step
 * — a `tap` on a selector that is NOT flagged `sameScreen`, or a `back`. Swipes
 * and `sameScreen` no-op taps do NOT change the screen for needle purposes:
 *  - the same-screen H2 tasks (no-op tapXY / typing) stay put by design, so their
 *    needle legitimately lives on the launch==destination screen;
 *  - example.com is a single short page a swipe cannot reveal new content on, so
 *    the chrome-scroll tasks also end where they launched.
 * Confirmed by capture 33767073864: chrome-scroll-* and same-chrome-noop have
 * identical launch/destination node sets. The old "any non-launch step" rule
 * mis-flagged all of these as BAD. A launch-destination task's needle must be
 * PRESENT on that screen (checked as a launch-only task); a genuinely navigating
 * task's needle must be ABSENT from the launch screen (destination-unique).
 */
function navigatesAwayFromLaunch(taskId: string): boolean {
  const task = ALL_TASKS.find((t) => t.id === taskId)!;
  return task.steps.some((s) => {
    if (s.sameScreen) return false;
    return s.action.kind === "tap" || s.action.kind === "back";
  });
}

/* -------------------------------------------------------------------------- */
/* app launch (with Chrome first-run dismissal)                               */
/* -------------------------------------------------------------------------- */

/**
 * Dismiss the Chrome first-run flow ("Welcome to Chrome" → "Turn on sync?") if
 * it is up. Reuses the pattern from `android-open-server.device.test.ts`: query
 * the live tree for a clickable dismiss label and tap it, up to a few rounds,
 * stopping once the page heading or the omnibox is present. Best-effort — a warm
 * emulator has already completed the FRE.
 */
async function dismissChromeFre(reg: Reg): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const { screen, nodes } = await dumpScreen(reg);
    const hasHeading = nodes.some((n) => EXAMPLE_HEADING.test(n.text ?? ""));
    if (hasHeading) return;
    const hasOmnibox = nodes.some((n) =>
      /url_bar|search_box_text|search or type/i.test(`${n.id ?? ""} ${n.text ?? ""}`)
    );
    const fre = nodes.find(
      (n) =>
        n.bounds &&
        FRE_DISMISS.test(`${n.text ?? ""} ${n.cd ?? ""} ${n.id ?? ""}`)
    );
    if (!fre) {
      if (hasOmnibox) return; // page chrome is up; nothing to dismiss
      await sleep(1000);
      continue;
    }
    const b = fre.bounds!;
    const x = (b.x1 + b.x2) / 2 / screen.width;
    const y = (b.y1 + b.y2) / 2 / screen.height;
    await reg.invokeTool("gesture-tap", { udid: SERIAL, x, y }).catch(() => undefined);
    await sleep(1500);
    await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 3000 }).catch(() => undefined);
  }
}

async function launchAppPreflight(reg: Reg, app: BenchApp): Promise<void> {
  if (app === "settings") {
    adbTry(["shell", `am force-stop ${SETTINGS}`]);
    adbTry(["shell", `pm clear ${SETTINGS}`]);
    await sleep(400);
    adbTry(["shell", `am start -n ${SETTINGS}/.Settings`], 8_000);
    await sleep(1500);
    await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 }).catch(() => undefined);
    return;
  }
  // chrome
  adbTry(["shell", `am force-stop ${CHROME}`]);
  await sleep(400);
  adbTry(["shell", `am start -a android.intent.action.VIEW -d https://example.com ${CHROME}`], 12_000);
  await sleep(3500);
  await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 }).catch(() => undefined);
  await dismissChromeFre(reg);
  // If the FRE consumed the VIEW intent, re-issue it so the page actually loads.
  const dump = await dumpScreen(reg);
  if (!dump.nodes.some((n) => EXAMPLE_HEADING.test(n.text ?? ""))) {
    adbTry(["shell", `am start -a android.intent.action.VIEW -d https://example.com ${CHROME}`], 12_000);
    await sleep(3500);
    await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 }).catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* capture mode (BENCH_CAPTURE=1) — dump launch + destination per task        */
/* -------------------------------------------------------------------------- */

/** Execute ONE task step through the open server (plain describe+tap path). */
async function execCaptureStep(reg: Reg, step: BenchStep): Promise<void> {
  const server = await openServer(reg);
  const info = await server.getInfo().catch(() => ({ screenWidth: 1080, screenHeight: 2400 }));
  const W = info.screenWidth || 1080;
  const H = info.screenHeight || 2400;
  const a = step.action;
  switch (a.kind) {
    case "launch":
      return; // handled by the caller
    case "tap": {
      const q = await server.query(toOpenSelector(a.selector), { limit: 1 });
      const node = q.nodes[0];
      if (!node) {
        process.stdout.write(`  [capture] locate MISS ${JSON.stringify(a.selector)}\n`);
        return;
      }
      const cx = Math.round((node.bounds.x1 + node.bounds.x2) / 2);
      const cy = Math.round((node.bounds.y1 + node.bounds.y2) / 2);
      await server.tapWithOutcome(cx, cy).catch(() => undefined);
      break;
    }
    case "tapXY": {
      await server.tapWithOutcome(Math.round(a.x * W), Math.round(a.y * H)).catch(() => undefined);
      break;
    }
    case "swipe": {
      const cx = Math.round(W / 2);
      const [fromY, toY] =
        a.direction === "up"
          ? [Math.round(H * 0.7), Math.round(H * 0.3)]
          : [Math.round(H * 0.3), Math.round(H * 0.7)];
      await server.swipeWithOutcome(cx, fromY, cx, toY, 10).catch(() => undefined);
      break;
    }
    case "type": {
      await server.typeTextWithOutcome(a.text).catch(() => undefined);
      await sleep(800); // async results populate off the main thread
      break;
    }
    case "back": {
      // Match the matrix harness (adb keyevent 4); the server key path did not
      // navigate back reliably in capture 33767073864.
      adbTry(["shell", "input keyevent 4"], 6_000);
      break;
    }
  }
  await sleep(600);
  await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 3000 }).catch(() => undefined);
}

interface CaptureScreen {
  nodeCount: number;
  /** visible text of every node, whitespace-collapsed. */
  texts: string[];
  /** content-descriptions of every node. */
  cds: string[];
  /** resource-ids of every node. */
  ids: string[];
}

function summarizeScreen(dump: ScreenDump): CaptureScreen {
  const clean = (s?: string): string => (s ?? "").replace(/\s+/g, " ").trim();
  const texts = new Set<string>();
  const cds = new Set<string>();
  const ids = new Set<string>();
  for (const n of dump.nodes) {
    const t = clean(n.text);
    const c = clean(n.cd);
    const i = clean(n.id);
    if (t) texts.add(t);
    if (c) cds.add(c);
    if (i) ids.add(i);
  }
  return {
    nodeCount: dump.nodes.length,
    texts: [...texts],
    cds: [...cds],
    ids: [...ids],
  };
}

interface CaptureEntry {
  task: string;
  app: BenchApp;
  needle: string;
  navigates: boolean;
  launch: CaptureScreen;
  destination: CaptureScreen;
}

async function captureTask(reg: Reg, task: BenchTask): Promise<CaptureEntry> {
  await launchAppPreflight(reg, task.app);
  const launch = await dumpScreen(reg);
  for (const step of task.steps) {
    if (step.action.kind === "launch") continue;
    await execCaptureStep(reg, step);
  }
  const destination = await dumpScreen(reg);
  return {
    task: task.id,
    app: task.app,
    needle: task.assertion.text ?? task.assertion.id ?? "",
    navigates: navigatesAwayFromLaunch(task.id),
    launch: summarizeScreen(launch),
    destination: summarizeScreen(destination),
  };
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  setFlag("open-device-server", true, "project");
  const reg = createRegistry();
  const out: {
    serial: string;
    settingsRoot?: ScreenDump;
    exampleCom?: ScreenDump;
    needleEval: Array<NeedleEvalRow & { app: string; needle: string; navigates: boolean; matchesLaunch: boolean; launchMatchText: string }>;
  } = { serial: SERIAL, needleEval: [] };

  const captures: CaptureEntry[] = [];

  try {
    // ---- Settings root ------------------------------------------------------
    await launchAppPreflight(reg, "settings");
    out.settingsRoot = await dumpScreen(reg);

    // ---- example.com (first-run dismissed) ----------------------------------
    await launchAppPreflight(reg, "chrome");
    out.exampleCom = await dumpScreen(reg);

    // ---- Needle evaluation against LAUNCH screens ---------------------------
    for (const task of ALL_TASKS) {
      const needle = task.assertion.text ?? task.assertion.id ?? "";
      const launch = task.app === "settings" ? out.settingsRoot! : out.exampleCom!;
      const r = evaluateAssertion(launch.nodes, needle, { screen: launch.screen });
      const navigates = navigatesAwayFromLaunch(task.id);
      // A navigating task must NOT match its launch screen. A launch-only chrome
      // task MUST match (its launch screen is its destination).
      const verdict = navigates
        ? r.matched
          ? "BAD (needle on launch screen a navigating task leaves — false-pass risk)"
          : "ok (unique to destination)"
        : r.matched
          ? "ok (launch == destination; needle present)"
          : "MISSING (launch-only task but needle not on screen)";
      out.needleEval.push({
        task: task.id,
        app: task.app,
        needle,
        navigates,
        matchesLaunch: r.matched,
        launchMatchText: r.matches[0]?.text.replace(/\s+/g, " ").slice(0, 70) ?? "",
        verdict,
      });
    }

    // ---- Capture (optional): launch + destination per task ------------------
    if (CAPTURE) {
      process.stdout.write("\n=== BENCH_CAPTURE: dumping launch + destination screens per task ===\n");
      for (const task of ALL_TASKS) {
        try {
          const entry = await captureTask(reg, task);
          captures.push(entry);
          process.stdout.write(
            `  captured ${task.id} [${task.app}] launch=${entry.launch.nodeCount} dest=${entry.destination.nodeCount}\n`
          );
        } catch (e) {
          process.stdout.write(`  capture FAILED ${task.id}: ${String(e)}\n`);
        }
      }
    }
  } finally {
    await reg.dispose().catch(() => undefined);
    unsetFlag("open-device-server", "project");
  }

  const fixturePath = join(__dirname, "..", "test", "fixtures", "preflight-launch-screens.json");
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, JSON.stringify(out, null, 2));

  if (CAPTURE) {
    mkdirSync(OUT_DIR, { recursive: true });
    const capturePath = join(OUT_DIR, "capture.json");
    writeFileSync(capturePath, JSON.stringify({ serial: SERIAL, captures }, null, 2));
    process.stdout.write(`\nCAPTURE=${capturePath} (${captures.length} tasks)\n`);
  }

  // Human summary.
  process.stdout.write("\n=== PRE-FLIGHT needle-vs-launch-screen summary ===\n");
  process.stdout.write(
    `settings-root nodes: ${out.settingsRoot?.nodes.length}; example.com nodes: ${out.exampleCom?.nodes.length}\n`
  );
  for (const e of out.needleEval) {
    process.stdout.write(
      `${e.verdict.startsWith("BAD") || e.verdict.startsWith("MISSING") ? "‼ " : "  "}` +
        `${e.task} [${e.app}] needle="${e.needle}" navigates=${e.navigates} matchesLaunch=${e.matchesLaunch} :: ${e.verdict}` +
        (e.matchesLaunch ? ` (match="${e.launchMatchText}")` : "") +
        "\n"
    );
  }
  const verdict = preflightVerdict(out.needleEval);
  const problemCount = verdict.problems.length;
  process.stdout.write(
    `\nPROBLEM needles: ${problemCount} — ${
      out.needleEval
        .filter((e) => e.verdict.startsWith("BAD") || e.verdict.startsWith("MISSING"))
        .map((b) => b.task)
        .join(", ") || "none"
    }\n`
  );
  // Dump the raw example.com body words so BLOCKER-2 can be settled by eye.
  const exampleText = (out.exampleCom?.nodes ?? [])
    .map((n) => `${n.text ?? ""}${n.cd ? " ⟨cd:" + n.cd + "⟩" : ""}`)
    .filter((s) => s.trim().length)
    .join(" | ");
  process.stdout.write(`\nexample.com visible text/cd:\n${exampleText}\n`);
  process.stdout.write(`\nFIXTURE=${fixturePath}\n`);

  // GATE (C.3 §1): a BAD or MISSING needle fails the pre-flight so the matrix
  // step never runs on a false-passing needle set. Capture mode is the gathering
  // pass — it never gates.
  if (CAPTURE) {
    process.stdout.write("\n[preflight] capture mode: not gating (exit 0)\n");
    return 0;
  }
  if (!verdict.ok) {
    process.stderr.write(
      `\n[preflight] GATE FAIL: ${problemCount} PROBLEM needle(s):\n  ${verdict.problems.join("\n  ")}\n`
    );
    return 1;
  }
  process.stdout.write("\n[preflight] GATE PASS: PROBLEM needles: 0\n");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`[preflight] FATAL ${String(e)}\n`);
    process.exit(1);
  });
