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
// Phase 3k: `ON-scrcpy` runs the drift-corrected pacing fix (the after arm) and
// `ON-scrcpy-legacy` the pre-3k await-per-frame pacing (the before arm), so one CI
// run carries both. The pacing mode is read per-process from ARGENT_SCRCPY_PACING,
// set here from the config, since the touch backend flag is read once at factory
// time and each config already runs in its own process (item 9).
type FlingConfigName = "OFF" | "ON-uiautomation" | "ON-scrcpy" | "ON-scrcpy-legacy";
type ScrcpyPacing = "drift" | "legacy";
interface FlingConfig {
  name: FlingConfigName;
  openServer: boolean;
  fastInject: boolean;
  pacing?: ScrcpyPacing;
}
const CONFIGS: Record<FlingConfigName, FlingConfig> = {
  OFF: { name: "OFF", openServer: false, fastInject: false },
  "ON-uiautomation": { name: "ON-uiautomation", openServer: true, fastInject: false },
  "ON-scrcpy": { name: "ON-scrcpy", openServer: true, fastInject: true, pacing: "drift" },
  "ON-scrcpy-legacy": { name: "ON-scrcpy-legacy", openServer: true, fastInject: true, pacing: "legacy" },
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

interface Drop {
  round: number;
  reason: string;
}
interface Cell {
  durationMs: number;
  distance: number;
  config: FlingConfigName;
  n: number;
  median: number;
  iqr: [number, number];
  samples: number[];
  /** 3K-M1: the drop reason for every missing sample (never silently dropped). */
  drops: Drop[];
}

/**
 * One measured swipe. Returns the normalized scroll (number) OR a `reason` string
 * for a dropped sample — 3K-M1: no sample is silently discarded. `round` is stamped
 * by the caller so the interleave evidence and the per-cell drop list line up.
 */
async function sampleOnce(
  reg: Reg,
  durationMs: number,
  distance: number
): Promise<{ value: number | null; reason: string | null }> {
  try {
    const d = await measureOne(reg, durationMs, distance);
    if (d === null) return { value: null, reason: "no describe rows before swipe (empty tree)" };
    return { value: d, reason: null };
  } catch (e) {
    return { value: null, reason: e instanceof Error ? e.message : String(e) };
  }
}

function summarizeCell(
  durationMs: number,
  distance: number,
  config: FlingConfigName,
  samples: number[],
  drops: Drop[]
): Cell {
  return {
    durationMs,
    distance,
    config,
    n: samples.length,
    median: round3(median(samples)),
    iqr: [round3(quantile(samples, 0.25)), round3(quantile(samples, 0.75))],
    samples: samples.map(round3),
    drops,
  };
}

async function runConfig(cfg: FlingConfig): Promise<Cell[]> {
  if (cfg.openServer) setFlag("open-device-server", true, "project");
  else unsetFlag("open-device-server", "project");
  if (cfg.fastInject) setFlag("open-device-server-fast-inject", true, "project");
  else unsetFlag("open-device-server-fast-inject", "project");
  // Phase 3k: select the scrcpy host pacing for the fast-inject arms (drift = the
  // fix / after, legacy = pre-3k await-per-frame / before). Read per-gesture by the
  // backend from this env var; set before the registry (hence the backend) exists.
  if (cfg.fastInject && cfg.pacing) process.env.ARGENT_SCRCPY_PACING = cfg.pacing;
  else delete process.env.ARGENT_SCRCPY_PACING;
  // Emit the per-frame host pacing trace to stdout (→ the fling-log artifact) so the
  // measured intended-vs-actual dispatch/write spans are captured for both arms.
  if (cfg.fastInject) process.env.ARGENT_SCRCPY_PACING_TRACE = "1";
  else delete process.env.ARGENT_SCRCPY_PACING_TRACE;
  const reg = createRegistry();
  const cells: Cell[] = [];
  for (const durationMs of DURATIONS) {
    for (const distance of DISTANCES) {
      const samples: number[] = [];
      const drops: Drop[] = [];
      for (let i = 0; i < N; i++) {
        const { value, reason } = await sampleOnce(reg, durationMs, distance);
        if (value !== null) samples.push(value);
        else drops.push({ round: i, reason: reason ?? "unknown" });
      }
      cells.push(summarizeCell(durationMs, distance, cfg.name, samples, drops));
      // eslint-disable-next-line no-console
      console.log(
        `[fling] ${cfg.name} d=${durationMs}ms dist=${distance} n=${samples.length} ` +
          `median=${round3(median(samples))} iqr=[${round3(quantile(samples, 0.25))},${round3(
            quantile(samples, 0.75)
          )}]` +
          (drops.length ? ` DROPPED ${drops.length}: ${drops.map((d) => d.reason).join(" | ")}` : "")
      );
    }
  }
  await reg.dispose().catch(() => undefined);
  return cells;
}

// ── Interleaved orchestrator (3K-M6) ────────────────────────────────────────
// The sequential per-config mode confounds ARM with TIME: each arm's samples for a
// cell fall in one contiguous ~7-min window, so emulator drift over the run maps onto
// arm differences. This orchestrator interleaves the arms in ROUNDS within a single
// process: each round warms one arm's registry (flags read at factory time, so a
// fresh registry per arm respects the once-at-factory contract), takes a few samples
// of every cell, then DISPOSES it before the next arm — so only one backend is live
// at any instant (same isolation as the separate-process design) while every arm's N
// samples for a cell are spread across the whole run. The scrcpy visit interleaves
// the drift and legacy pacing arms per sample (they share one backend; pacing is read
// per gesture from ARGENT_SCRCPY_PACING). Arm order rotates per round.
type ArmGroup = "uia" | "scrcpy" | "off";
interface ArmAccum {
  samples: number[];
  drops: Drop[];
}
interface InterleaveSampleEvent {
  arm: FlingConfigName;
  durationMs: number;
  distance: number;
  round: number;
  tMs: number; // ms since orchestrator start (interleaving evidence)
  ok: boolean;
}

function applyArmFlags(group: ArmGroup): void {
  if (group === "off") {
    unsetFlag("open-device-server", "project");
    unsetFlag("open-device-server-fast-inject", "project");
    delete process.env.ARGENT_SCRCPY_PACING;
    delete process.env.ARGENT_SCRCPY_PACING_TRACE;
    delete process.env.ARGENT_SCRCPY_PACING_TRACE_FILE;
    return;
  }
  setFlag("open-device-server", true, "project");
  if (group === "scrcpy") {
    setFlag("open-device-server-fast-inject", true, "project");
    // Route the host per-frame pacing trace to a FILE (stdout is swallowed by this
    // harness, review 3K-H3) so the drift arm's trace reaches the artifact.
    process.env.ARGENT_SCRCPY_PACING_TRACE = "1";
    process.env.ARGENT_SCRCPY_PACING_TRACE_FILE = join(OUT_DIR, "pacing-trace.txt");
  } else {
    unsetFlag("open-device-server-fast-inject", "project");
    delete process.env.ARGENT_SCRCPY_PACING;
    delete process.env.ARGENT_SCRCPY_PACING_TRACE;
    delete process.env.ARGENT_SCRCPY_PACING_TRACE_FILE;
  }
}

const CELLS: Array<{ durationMs: number; distance: number }> = DURATIONS.flatMap((d) =>
  DISTANCES.map((dist) => ({ durationMs: d, distance: dist }))
);
const cellKey = (durationMs: number, distance: number): string => `${durationMs}|${distance}`;

async function runInterleaved(): Promise<void> {
  const includeOff = process.env.FLING_INCLUDE_OFF !== "0";
  const rounds = Math.max(1, Number(process.env.FLING_ROUNDS ?? 3));
  const perRound = Math.ceil(N / rounds); // samples per cell per arm per round
  // Arm groups present this run. drift+legacy both live in the "scrcpy" group.
  const groups: ArmGroup[] = includeOff ? ["uia", "scrcpy", "off"] : ["uia", "scrcpy"];
  // Per-arm accumulators keyed by cell. The scrcpy group feeds TWO arms.
  const armNames: FlingConfigName[] = ["ON-uiautomation", "ON-scrcpy", "ON-scrcpy-legacy", "OFF"];
  const acc: Record<FlingConfigName, Map<string, ArmAccum>> = {} as never;
  for (const a of armNames) {
    acc[a] = new Map(CELLS.map((c) => [cellKey(c.durationMs, c.distance), { samples: [], drops: [] }]));
  }
  const evidence: InterleaveSampleEvent[] = [];
  // 3K1-M3: a warm/whole-arm-round failure must FAIL the step, not degrade to
  // "non-informative". We still record the per-cell drop reasons and write the block
  // files (for diagnosis), but any arm-round failure is collected here and rethrown
  // after the artifacts are written, so `main()` exits non-zero instead of the gate
  // silently reading a short arm as floored.
  const armRoundFailures: string[] = [];
  const t0 = Date.now();
  let produced = 0; // total samples produced this run so far (cap at N per arm-cell)

  const takeInto = async (
    reg: Reg,
    arm: FlingConfigName,
    durationMs: number,
    distance: number,
    round: number
  ): Promise<void> => {
    const cell = acc[arm].get(cellKey(durationMs, distance))!;
    if (cell.samples.length >= N) return; // already have the target N for this arm-cell
    const { value, reason } = await sampleOnce(reg, durationMs, distance);
    evidence.push({ arm, durationMs, distance, round, tMs: Date.now() - t0, ok: value !== null });
    if (value !== null) {
      cell.samples.push(value);
      produced++;
    } else {
      cell.drops.push({ round, reason: reason ?? "unknown" });
    }
  };

  for (let round = 0; round < rounds; round++) {
    // Rotate arm order each round so no arm sits in a fixed time-position.
    const order = groups.map((_, i) => groups[(i + round) % groups.length]!);
    for (const group of order) {
      applyArmFlags(group);
      let reg: Reg | null = null;
      try {
        reg = createRegistry();
        // Warm the registry (build the device + backend at the correct flags) so a
        // warm failure is attributed to the whole arm-round, not one cell.
        await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 }).catch(() => undefined);
        for (let j = 0; j < perRound; j++) {
          for (const c of CELLS) {
            if (group === "scrcpy") {
              // Interleave drift/legacy per sample (shared backend, per-gesture env).
              process.env.ARGENT_SCRCPY_PACING = "drift";
              await takeInto(reg, "ON-scrcpy", c.durationMs, c.distance, round);
              process.env.ARGENT_SCRCPY_PACING = "legacy";
              await takeInto(reg, "ON-scrcpy-legacy", c.durationMs, c.distance, round);
              delete process.env.ARGENT_SCRCPY_PACING;
            } else {
              await takeInto(reg, group === "uia" ? "ON-uiautomation" : "OFF", c.durationMs, c.distance, round);
            }
          }
        }
      } catch (e) {
        // Warm/whole-arm failure this round: record a drop for every cell it owed AND
        // remember it so the run fails loudly (3K1-M3) — an arm that dies must not
        // degrade to "non-informative" and let the gate exit green.
        const reason = `arm ${group} round ${round} failed: ${e instanceof Error ? e.message : String(e)}`;
        armRoundFailures.push(reason);
        const owed: FlingConfigName[] =
          group === "scrcpy" ? ["ON-scrcpy", "ON-scrcpy-legacy"] : group === "uia" ? ["ON-uiautomation"] : ["OFF"];
        for (const arm of owed) {
          for (const c of CELLS) {
            const cell = acc[arm].get(cellKey(c.durationMs, c.distance))!;
            if (cell.samples.length < N) cell.drops.push({ round, reason });
          }
        }
        // eslint-disable-next-line no-console
        console.error(`[fling] ${reason}`);
      } finally {
        if (reg) await reg.dispose().catch(() => undefined);
      }
      await sleep(3000); // mirror the between-arm settle of the sequential design
    }
    // eslint-disable-next-line no-console
    console.log(`[fling] interleave round ${round + 1}/${rounds} complete (produced ${produced} samples so far)`);
  }
  unsetFlag("open-device-server", "project");
  unsetFlag("open-device-server-fast-inject", "project");

  // Write one block file per arm, plus the interleave evidence.
  const armConfig: Record<FlingConfigName, FlingConfig> = CONFIGS;
  for (const arm of includeOff ? armNames : armNames.filter((a) => a !== "OFF")) {
    const cfg = armConfig[arm];
    const cells = CELLS.map((c) => {
      const a = acc[arm].get(cellKey(c.durationMs, c.distance))!;
      return summarizeCell(c.durationMs, c.distance, arm, a.samples, a.drops);
    });
    const result = {
      serial: SERIAL,
      N,
      config: arm,
      openServer: cfg.openServer,
      fastInject: cfg.fastInject,
      pacing: cfg.fastInject ? cfg.pacing ?? "drift" : null,
      mode: "interleaved",
      rounds,
      startedAt: new Date(t0).toISOString(),
      finishedAt: new Date().toISOString(),
      cells,
    };
    writeFileSync(join(OUT_DIR, `fling-block-${arm}.json`), JSON.stringify(result, null, 2));
    // eslint-disable-next-line no-console
    console.log(`\n=== FLING BLOCK ${arm} (interleaved, median normalized scroll) ===`);
    for (const c of cells) {
      // eslint-disable-next-line no-console
      console.log(
        `d=${c.durationMs}ms dist=${c.distance}: median ${c.median} iqr=[${c.iqr[0]},${c.iqr[1]}] n=${c.n}` +
          (c.drops.length ? ` (dropped ${c.drops.length})` : "")
      );
    }
  }
  // Interleave evidence: per-arm-cell sample timestamps prove the arms are spread
  // across the whole run (each arm's N samples span rounds, not one contiguous block).
  const evPath = join(OUT_DIR, "fling-interleave-evidence.json");
  writeFileSync(evPath, JSON.stringify({ serial: SERIAL, N, rounds, perRound, t0, events: evidence }, null, 2));
  // Per arm-cell time span (min→max tMs) so the Result can show interleaving at a glance.
  console.log("\n=== INTERLEAVE EVIDENCE (per arm-cell sample time span, ms since start) ===");
  for (const arm of includeOff ? armNames : armNames.filter((a) => a !== "OFF")) {
    for (const c of CELLS) {
      const ev = evidence.filter(
        (e) => e.arm === arm && e.durationMs === c.durationMs && e.distance === c.distance && e.ok
      );
      if (!ev.length) continue;
      const ts = ev.map((e) => e.tMs);
      const roundsSeen = [...new Set(ev.map((e) => e.round))].sort((a, b) => a - b);
      console.log(
        `  ${arm} d=${c.durationMs}ms dist=${c.distance}: n=${ev.length} ` +
          `span=[${Math.min(...ts)}..${Math.max(...ts)}]ms rounds=${roundsSeen.join(",")}`
      );
    }
  }
  process.stdout.write(`INTERLEAVE_EVIDENCE_JSON=${evPath}\n`);

  // 3K1-M3: fail loudly if any arm-round died. The block files + evidence are already
  // written for diagnosis, but the process must exit non-zero so the CI step fails and
  // the fling gate never grades a run where an arm silently lost its samples.
  if (armRoundFailures.length) {
    throw new Error(
      `${armRoundFailures.length} arm-round failure(s) — the fling run is not gradable: ` +
        armRoundFailures.join(" ; ")
    );
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const started = new Date().toISOString();

  // Phase 3k.1: FLING_CONFIG=INTERLEAVE runs the round-robin orchestrator (all arms
  // in ONE process, interleaved per cell — 3K-M6) and writes every block file itself.
  // The per-config values still work for a single-arm process; the flag is read once
  // at factory time, so each arm gets a fresh registry.
  if (process.env.FLING_CONFIG === "INTERLEAVE") {
    await runInterleaved();
    return;
  }
  const selected = process.env.FLING_CONFIG as FlingConfigName | undefined;
  if (!selected || !(selected in CONFIGS)) {
    throw new Error(
      `FLING_CONFIG must be INTERLEAVE or one of ${Object.keys(CONFIGS).join("|")} — ` +
        `INTERLEAVE runs every arm round-robin in one process (3K-M6); a single config ` +
        `runs that arm alone (the touch backend flag is read once at factory time).`
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
    pacing: cfg.fastInject ? cfg.pacing ?? "drift" : null,
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
