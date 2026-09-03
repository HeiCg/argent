/**
 * Fling-fidelity grid (F15/F16 + phase 3f A/B): does a config reproduce another's
 * fling DISTANCE across a sweep of swipe durations and distances? The phase-3f use
 * is the Kotlin-vs-scrcpy A/B — ON-scrcpy (fast-inject) must reproduce
 * ON-uiautomation's flinging swipe distance, or "fling fidelity unchanged" is not
 * a claim we may make (item 9).
 *
 * MEASUREMENT ONLY. Opt-in, not a test (lives under scripts/). For each cell in
 * durationMs ∈ {150, 250, 400} × distance ∈ {0.3, 0.5} it runs N (default 12,
 * ≥ 10) plain flinging swipes for ONE config, resetting the Settings list before
 * each swipe, and measures how far a labelled anchor row moved (normalized
 * fraction of screen height). It reports median + IQR per cell.
 *
 * SEPARATE PROCESSES (item 9). The touch backend flag is read ONCE at factory
 * time, so each config runs in its own process selected by FLING_CONFIG ∈
 * {OFF | ON-uiautomation | ON-scrcpy}, writing `.bench-results/fling-block-<cfg>.json`.
 * `run-fling-merge.js` then assembles the A/B ratios (ON-scrcpy / ON-uiautomation,
 * and each ON / OFF). Run each against a booted AVD with gRPC + token:
 *
 *   emulator -avd <avd> -no-window -no-audio -no-boot-anim -grpc 8554 -grpc-use-token
 *   ARGENT_SIMULATOR_SERVER_DIR=<pkg>/bin ... ANDROID_HOME=$HOME/Library/Android/sdk \
 *   BENCH_SERIAL=emulator-5554 FLING_CONFIG=ON-scrcpy node run-fling.js
 *   # …repeat for ON-uiautomation and OFF, then: node run-fling-merge.js
 *
 * Env knobs: BENCH_SERIAL (emulator-5554), FLING_N (12), FLING_CONFIG (required),
 * BENCH_OUT (.bench-results).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRegistry } from "../src/utils/setup-registry";
import { setFlag, unsetFlag } from "@argent/configuration-core";

const SERIAL = process.env.BENCH_SERIAL ?? "emulator-5554";
const N = Number(process.env.FLING_N ?? 12);
const OUT_DIR = process.env.BENCH_OUT ?? join(process.cwd(), ".bench-results");
// Phase 3f: the flag that selects the touch backend is read ONCE at factory time,
// so a true A/B must run each config in its OWN process (item 9). FLING_CONFIG
// selects exactly one config for this process; it writes a per-config block file
// that run-fling-merge.js assembles into the A/B (ON-scrcpy vs ON-uiautomation,
// the Kotlin-vs-scrcpy fling-distance comparison) plus the OFF proprietary ref.
type FlingConfigName = "OFF" | "ON-uiautomation" | "ON-scrcpy";
interface FlingConfig {
  name: FlingConfigName;
  openServer: boolean;
  fastInject: boolean;
}
const CONFIGS: Record<FlingConfigName, FlingConfig> = {
  OFF: { name: "OFF", openServer: false, fastInject: false },
  "ON-uiautomation": { name: "ON-uiautomation", openServer: true, fastInject: false },
  "ON-scrcpy": { name: "ON-scrcpy", openServer: true, fastInject: true },
};
const PHYSICAL_DENY = "ZF524RZBHD";
const SETTINGS = "com.android.settings";

if (SERIAL === PHYSICAL_DENY) throw new Error(`refuse to target physical device ${PHYSICAL_DENY}`);
if (!SERIAL.startsWith("emulator-")) {
  throw new Error(`BENCH_SERIAL must be an emulator- serial (got "${SERIAL}"); refusing.`);
}

const DURATIONS = [150, 250, 400];
const DISTANCES = [0.3, 0.5];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function adbShell(cmd: string, timeoutMs = 20_000): string {
  return execFileSync("adb", ["-s", SERIAL, "shell", cmd], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

type Reg = ReturnType<typeof createRegistry>;

async function ensureSettings(reg: Reg): Promise<void> {
  try {
    adbShell("am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS", 5_000);
  } catch {
    /* best effort */
  }
  adbShell(`am force-stop ${SETTINGS}`, 8_000);
  try {
    adbShell(`pm clear ${SETTINGS}`, 8_000);
  } catch {
    /* fall through */
  }
  await sleep(300);
  adbShell(`am start -n ${SETTINGS}/.Settings`, 8_000);
  await sleep(1400);
  await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 }).catch(() => undefined);
}

/** Parse describe lines into { label, y } for labelled rows. */
function labelledRows(desc: string): Array<{ label: string; y: number }> {
  const rows: Array<{ label: string; y: number }> = [];
  for (const line of desc.split("\n")) {
    const labelM = line.match(/(?<![=\w])"((?:[^"\\]|\\.)*)"/);
    const frameM = line.match(/\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)\s*$/);
    if (labelM && frameM) rows.push({ label: labelM[1]!, y: Number(frameM[2]) });
  }
  return rows;
}

async function describeRows(reg: Reg): Promise<Array<{ label: string; y: number }>> {
  const d = (await reg.invokeTool("describe", { udid: SERIAL })) as { description: string };
  return labelledRows(d.description);
}

/**
 * One swipe's normalized vertical scroll = median downward displacement of the
 * rows present BOTH before and after (matching v2's fling measure). Robust: it
 * doesn't saturate the way tracking a single anchor that scrolls off does, and
 * sticky rows (search bar, title) that don't move are excluded by the `> 0.02`
 * filter, so only the scrolled list content is measured.
 */
async function measureOne(reg: Reg, durationMs: number, distance: number): Promise<number | null> {
  await ensureSettings(reg);
  const before = await describeRows(reg);
  if (before.length === 0) return null;
  const beforeMap = new Map<string, number>();
  for (const r of before) if (!beforeMap.has(r.label)) beforeMap.set(r.label, r.y);
  const fromY = 0.72;
  const toY = fromY - distance;
  await reg.invokeTool("gesture-swipe", {
    udid: SERIAL,
    fromX: 0.5,
    fromY,
    toX: 0.5,
    toY,
    durationMs,
  });
  await sleep(1300);
  await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 }).catch(() => undefined);
  const after = await describeRows(reg);
  const afterMap = new Map<string, number>();
  for (const r of after) if (!afterMap.has(r.label)) afterMap.set(r.label, r.y);
  const disps: number[] = [];
  for (const [label, by] of beforeMap) {
    const ay = afterMap.get(label);
    if (ay === undefined) continue;
    const d = by - ay; // content moved up ⇒ positive
    if (d > 0.02) disps.push(d);
  }
  // No surviving moved row (the whole list flung past a screen): count it as a
  // full screen of travel so a hard fling isn't scored as zero.
  if (disps.length === 0) return 1;
  return median(disps);
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[idx]!;
}
function round3(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(3)) : n;
}

interface Cell {
  durationMs: number;
  distance: number;
  config: FlingConfigName;
  n: number;
  median: number;
  iqr: [number, number];
  samples: number[];
}

async function runConfig(cfg: FlingConfig): Promise<Cell[]> {
  if (cfg.openServer) setFlag("open-device-server", true, "project");
  else unsetFlag("open-device-server", "project");
  if (cfg.fastInject) setFlag("open-device-server-fast-inject", true, "project");
  else unsetFlag("open-device-server-fast-inject", "project");
  const reg = createRegistry();
  const cells: Cell[] = [];
  for (const durationMs of DURATIONS) {
    for (const distance of DISTANCES) {
      const samples: number[] = [];
      for (let i = 0; i < N; i++) {
        const d = await measureOne(reg, durationMs, distance).catch(() => null);
        if (d !== null) samples.push(d);
      }
      cells.push({
        durationMs,
        distance,
        config: cfg.name,
        n: samples.length,
        median: round3(median(samples)),
        iqr: [round3(quantile(samples, 0.25)), round3(quantile(samples, 0.75))],
        samples: samples.map(round3),
      });
      // eslint-disable-next-line no-console
      console.log(
        `[fling] ${cfg.name} d=${durationMs}ms dist=${distance} n=${samples.length} ` +
          `median=${round3(median(samples))} iqr=[${round3(quantile(samples, 0.25))},${round3(
            quantile(samples, 0.75)
          )}]`
      );
    }
  }
  await reg.dispose().catch(() => undefined);
  return cells;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const started = new Date().toISOString();

  // A/B requires each config in its own process (flag read once at factory time),
  // so FLING_CONFIG is mandatory. Each run writes one per-config block file;
  // run-fling-merge.js assembles the A/B (ON-scrcpy vs ON-uiautomation) + OFF ref.
  const selected = process.env.FLING_CONFIG as FlingConfigName | undefined;
  if (!selected || !(selected in CONFIGS)) {
    throw new Error(
      `FLING_CONFIG must be one of ${Object.keys(CONFIGS).join("|")} — ` +
        `run each config in a SEPARATE process (the touch backend flag is read once ` +
        `at factory time), then merge with run-fling-merge.js.`
    );
  }
  const cfg = CONFIGS[selected];
  const cells = await runConfig(cfg);
  unsetFlag("open-device-server", "project");
  unsetFlag("open-device-server-fast-inject", "project");

  const result = {
    serial: SERIAL,
    N,
    config: cfg.name,
    openServer: cfg.openServer,
    fastInject: cfg.fastInject,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    cells,
  };
  const blockPath = join(OUT_DIR, `fling-block-${cfg.name}.json`);
  writeFileSync(blockPath, JSON.stringify(result, null, 2));
  // eslint-disable-next-line no-console
  console.log(`\n=== FLING BLOCK ${cfg.name} (median normalized scroll) ===`);
  for (const c of cells) {
    // eslint-disable-next-line no-console
    console.log(`d=${c.durationMs}ms dist=${c.distance}: median ${c.median} iqr=[${c.iqr[0]},${c.iqr[1]}] n=${c.n}`);
  }
  process.stdout.write(`RESULT_JSON=${blockPath}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error("[fling] FATAL", e);
    process.exit(1);
  });
