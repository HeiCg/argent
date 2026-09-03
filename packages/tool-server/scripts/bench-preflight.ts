/**
 * Screen-graph Phase C.1 PRE-FLIGHT (review BLOCKER-1/2).
 *
 * Single-emulator, ~10 min, NO metrics. Boots the open device server, dumps the
 * full `query({}, { limit: 1000 })` node set (text + contentDescription) of the
 * two LAUNCH screens (Settings root, example.com), and evaluates every task's
 * assertion needle against them with the SAME oracle the matrix uses. Purpose:
 *
 *  - BLOCKER-1: any needle that already matches the LAUNCH screen of a task that
 *    NAVIGATES away from it (all Settings tasks + same-screen tasks) would
 *    false-pass on a missed tap. The pre-flight names them so they can be moved
 *    to a destination-unique needle before the matrix.
 *  - BLOCKER-2: settle "documentation" vs "documents" etc. on example.com with
 *    the real dump, not assumption.
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
import type { OpenDeviceServerApi } from "../src/blueprints/android-open-server";
import { resolveDevice } from "../src/utils/device-info";
import { ALL_TASKS } from "../src/screen-graph/bench/tasks";
import { evaluateAssertion, type OracleNode } from "../src/screen-graph/bench/oracle";

const SERIAL = process.env.BENCH_SERIAL ?? "emulator-5554";
const PHYSICAL_DENY = "ZF524RZBHD";
if (SERIAL === PHYSICAL_DENY) throw new Error(`refuse to target ${PHYSICAL_DENY}`);
if (!SERIAL.startsWith("emulator-")) throw new Error(`BENCH_SERIAL must be emulator-*, got ${SERIAL}`);

const SETTINGS = "com.android.settings";
const CHROME = "com.android.chrome";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

async function dumpScreen(reg: Reg): Promise<{ screen: { width: number; height: number }; nodes: OracleNode[] }> {
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

/** A task "navigates" away from its launch screen if it has a tap/tapXY/swipe/back before asserting. */
function navigatesAwayFromLaunch(taskId: string): boolean {
  const task = ALL_TASKS.find((t) => t.id === taskId)!;
  return task.steps.some((s) => s.action.kind !== "launch");
}

async function main(): Promise<void> {
  setFlag("open-device-server", true, "project");
  const reg = createRegistry();
  const out: {
    serial: string;
    settingsRoot?: { screen: { width: number; height: number }; nodes: OracleNode[] };
    exampleCom?: { screen: { width: number; height: number }; nodes: OracleNode[] };
    needleEval: Array<{
      task: string;
      app: string;
      needle: string;
      navigates: boolean;
      matchesLaunch: boolean;
      launchMatchText: string;
      verdict: string;
    }>;
  } = { serial: SERIAL, needleEval: [] };

  try {
    // ---- Settings root ------------------------------------------------------
    adbTry(["shell", `am force-stop ${SETTINGS}`]);
    adbTry(["shell", `pm clear ${SETTINGS}`]);
    await sleep(400);
    adbTry(["shell", `am start -n ${SETTINGS}/.Settings`], 8_000);
    await sleep(1500);
    await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 }).catch(() => undefined);
    out.settingsRoot = await dumpScreen(reg);

    // ---- example.com --------------------------------------------------------
    adbTry(["shell", `am force-stop ${CHROME}`]);
    await sleep(400);
    adbTry(["shell", `am start -a android.intent.action.VIEW -d https://example.com ${CHROME}`], 12_000);
    await sleep(3500);
    await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 }).catch(() => undefined);
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
  } finally {
    await reg.dispose().catch(() => undefined);
    unsetFlag("open-device-server", "project");
  }

  const fixturePath = join(__dirname, "..", "test", "fixtures", "preflight-launch-screens.json");
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, JSON.stringify(out, null, 2));

  // Human summary.
  process.stdout.write("\n=== PRE-FLIGHT needle-vs-launch-screen summary ===\n");
  process.stdout.write(`settings-root nodes: ${out.settingsRoot?.nodes.length}; example.com nodes: ${out.exampleCom?.nodes.length}\n`);
  for (const e of out.needleEval) {
    process.stdout.write(
      `${e.verdict.startsWith("BAD") || e.verdict.startsWith("MISSING") ? "‼ " : "  "}` +
        `${e.task} [${e.app}] needle="${e.needle}" navigates=${e.navigates} matchesLaunch=${e.matchesLaunch} :: ${e.verdict}` +
        (e.matchesLaunch ? ` (match="${e.launchMatchText}")` : "") +
        "\n"
    );
  }
  const bad = out.needleEval.filter((e) => e.verdict.startsWith("BAD") || e.verdict.startsWith("MISSING"));
  process.stdout.write(`\nPROBLEM needles: ${bad.length} — ${bad.map((b) => b.task).join(", ") || "none"}\n`);
  // Dump the raw example.com body words so BLOCKER-2 can be settled by eye.
  const exampleText = (out.exampleCom?.nodes ?? [])
    .map((n) => `${n.text ?? ""}${n.cd ? " ⟨cd:" + n.cd + "⟩" : ""}`)
    .filter((s) => s.trim().length)
    .join(" | ");
  process.stdout.write(`\nexample.com visible text/cd:\n${exampleText}\n`);
  process.stdout.write(`\nFIXTURE=${fixturePath}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    process.stderr.write(`[preflight] FATAL ${String(e)}\n`);
    process.exit(1);
  });
