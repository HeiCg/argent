/**
 * Fling-fidelity grid, OPTICAL metric (ticket 3o). Rebuilt after 3n.2 deleted the
 * anchor-displacement harness (`775ae6fc`). It measures, per cell (durationMs ×
 * distance), how far the Settings list actually scrolled after a flinging swipe, in
 * PIXELS of the host framebuffer, by cross-correlating a pre-swipe and a post-settle
 * screenshot (`scripts/optical-scroll.ts`). The old metric was censored, quantized
 * and clamped (review 3N-H3) — it is NOT resurrected; there is no `d > 0.02` filter,
 * no `return 1` clamp, no ratio and no floor in this file. The raw sub-pixel offset
 * (and its confidence) is persisted for every sample; the ratio and the gate live in
 * `.github/bench-ci/merge-fling.js`.
 *
 * Screenshots are taken by the HOST via `adb exec-out screencap -p` (backend
 * independent — the same channel for OFF/proprietary and every ON arm) and OUTSIDE
 * any timed window (this is a displacement metric, not a latency metric).
 *
 * ARMS (ticket 3o):
 *   - OFF                 proprietary driver (open-device-server flag off)
 *   - ON-input-manager    shipped default injector (ARGENT_OPEN_INJECT_STRATEGY=input-manager)
 *   - ON-uiautomation     control; the pre-3n.1 Kotlin DEFAULT path. PINS the env to
 *                         `default` — an UNSET env resolves to `input-manager` after the
 *                         3n.1 flip (review 3N1-H1: the leak that voided run 2's uia arms).
 *   - ON-uia-A / ON-uia-B self-test: two IDENTICAL-code arms (both pin `default`),
 *                         interleaved PER SAMPLE. They bound the instrument's own
 *                         reproducibility before any arm is graded (P8 / 3N-H3).
 *
 * The self-test verdict (merge) decides whether ANY arm is graded. Fling is
 * REPORT-ONLY this run; the harness fails loudly only on an arm-round collapse
 * (so a broken run cannot masquerade as a clean instrument result), never on the gate.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRegistry } from "../src/utils/setup-registry";
import { setFlag, unsetFlag } from "@argent/configuration-core";
import { estimateScrollPx, type ScrollEstimate } from "./optical-scroll";

const SERIAL = process.env.BENCH_SERIAL ?? "emulator-5554";
const N = Number(process.env.FLING_N ?? 16);
const OUT_DIR = process.env.BENCH_OUT ?? join(process.cwd(), ".bench-results");
const PHYSICAL_DENY = "ZF524RZBHD";
const SETTINGS = "com.android.settings";

if (SERIAL === PHYSICAL_DENY) throw new Error(`refuse to target physical device ${PHYSICAL_DENY}`);
if (!SERIAL.startsWith("emulator-")) {
  throw new Error(`BENCH_SERIAL must be an emulator- serial (got "${SERIAL}"); refusing.`);
}

const DURATIONS = [150, 250, 400];
const DISTANCES = [0.3, 0.5];

type FlingArm = "OFF" | "ON-input-manager" | "ON-uiautomation" | "ON-uia-A" | "ON-uia-B";
/** The env `ARGENT_OPEN_INJECT_STRATEGY` value for each arm; null ⇒ flag off (OFF). */
const ARM_STRATEGY: Record<FlingArm, "input-manager" | "default" | null> = {
  OFF: null,
  "ON-input-manager": "input-manager",
  "ON-uiautomation": "default",
  "ON-uia-A": "default",
  "ON-uia-B": "default",
};

type Reg = ReturnType<typeof createRegistry>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function adbShell(cmd: string, timeoutMs = 20_000): string {
  return execFileSync("adb", ["-s", SERIAL, "shell", cmd], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Host screenshot as PNG bytes — backend-independent, outside any timed window. */
function screencapPng(): Buffer {
  return execFileSync("adb", ["-s", SERIAL, "exec-out", "screencap", "-p"], {
    timeout: 20_000,
    maxBuffer: 64 * 1024 * 1024,
  }) as Buffer;
}

/** Reset the Settings list to the top so every sample starts from the same scroll. */
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

interface Sample {
  offsetPx: number;
  confidence: number;
  peakShift: number;
}
interface Drop {
  round: number;
  reason: string;
}

/**
 * One flinging swipe measured optically. Returns the sub-pixel offset (px) or a drop
 * reason (a refused estimate — low confidence / blank / dimension mismatch — is a drop,
 * never a clamped value). Screenshots bracket the swipe + settle, taken by the host.
 */
async function measureOne(
  reg: Reg,
  durationMs: number,
  distance: number
): Promise<{ sample: Sample | null; reason: string | null }> {
  await ensureSettings(reg);
  let before: Buffer;
  try {
    before = screencapPng();
  } catch (e) {
    return { sample: null, reason: `pre-swipe screencap failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const fromY = 0.72;
  const toY = fromY - distance;
  await reg.invokeTool("gesture-swipe", {
    udid: SERIAL,
    fromX: 0.5,
    fromY,
    toX: 0.5,
    toY,
    durationMs,
    momentum: true,
  });
  await sleep(1300);
  await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 }).catch(() => undefined);
  let after: Buffer;
  try {
    after = screencapPng();
  } catch (e) {
    return { sample: null, reason: `post-settle screencap failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  let est: ScrollEstimate;
  try {
    est = estimateScrollPx(before, after);
  } catch (e) {
    return { sample: null, reason: `estimator threw: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (est.refused || est.offsetPx === null) {
    return { sample: null, reason: `estimator refused: ${est.reason ?? "low confidence"} (conf ${est.confidence})` };
  }
  return { sample: { offsetPx: est.offsetPx, confidence: est.confidence, peakShift: est.peakShift }, reason: null };
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
function r3(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(3)) : n;
}

interface Cell {
  durationMs: number;
  distance: number;
  config: FlingArm;
  n: number;
  medianPx: number;
  iqrPx: [number, number];
  samples: Sample[];
  drops: Drop[];
}

function summarizeCell(durationMs: number, distance: number, config: FlingArm, samples: Sample[], drops: Drop[]): Cell {
  const offsets = samples.map((s) => s.offsetPx);
  return {
    durationMs,
    distance,
    config,
    n: samples.length,
    medianPx: r3(median(offsets)),
    iqrPx: [r3(quantile(offsets, 0.25)), r3(quantile(offsets, 0.75))],
    samples,
    drops,
  };
}

/** Set the open-device-server flag + inject-strategy env for an arm's config. */
function applyArmFlags(arm: FlingArm): void {
  const strat = ARM_STRATEGY[arm];
  if (strat === null) {
    unsetFlag("open-device-server", "project");
    delete process.env.ARGENT_OPEN_INJECT_STRATEGY;
    return;
  }
  setFlag("open-device-server", true, "project");
  // PIN the strategy (never delete). Post the 3n.1 flip an unset env resolves to
  // `input-manager`, so a control arm that merely deletes the env would silently run
  // input-manager (3N1-H1). `default` selects the pre-3n.1 Kotlin DEFAULT (no inject).
  process.env.ARGENT_OPEN_INJECT_STRATEGY = strat;
}

const CELLS: Array<{ durationMs: number; distance: number }> = DURATIONS.flatMap((d) =>
  DISTANCES.map((dist) => ({ durationMs: d, distance: dist }))
);
const cellKey = (durationMs: number, distance: number): string => `${durationMs}|${distance}`;

interface Accum {
  samples: Sample[];
  drops: Drop[];
}
interface SampleEvent {
  arm: FlingArm;
  durationMs: number;
  distance: number;
  round: number;
  tMs: number;
  ok: boolean;
  confidence: number | null;
}

/**
 * One live-registry "visit" produces samples for a set of arm-labels that share the
 * SAME flags. The self-test visit produces `ON-uia-A` / `ON-uia-B` alternating per
 * sample (both are the DEFAULT path — identical code), which is the per-sample
 * interleaving the instrument control requires (P8 / 3N-H3). The graded visits
 * (OFF, input-manager, uia-control) each produce one label; visit order rotates per
 * round so no arm sits at a fixed time-position.
 */
type Visit = "off" | "input-manager" | "uia-control" | "uia-selftest";
const VISIT_FLAGS: Record<Visit, FlingArm> = {
  off: "OFF",
  "input-manager": "ON-input-manager",
  "uia-control": "ON-uiautomation",
  "uia-selftest": "ON-uiautomation", // same flags as control; labels split A/B per sample
};

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const rounds = Math.max(1, Number(process.env.FLING_ROUNDS ?? 4));
  const perRound = Math.ceil(N / rounds);
  const includeOff = process.env.FLING_INCLUDE_OFF !== "0";
  const arms: FlingArm[] = includeOff
    ? ["OFF", "ON-input-manager", "ON-uiautomation", "ON-uia-A", "ON-uia-B"]
    : ["ON-input-manager", "ON-uiautomation", "ON-uia-A", "ON-uia-B"];
  const acc: Record<FlingArm, Map<string, Accum>> = {} as never;
  for (const a of arms) acc[a] = new Map(CELLS.map((c) => [cellKey(c.durationMs, c.distance), { samples: [], drops: [] }]));
  const evidence: SampleEvent[] = [];
  const armRoundFailures: string[] = [];
  const t0 = Date.now();

  const take = async (reg: Reg, arm: FlingArm, durationMs: number, distance: number, round: number): Promise<void> => {
    const cell = acc[arm].get(cellKey(durationMs, distance))!;
    if (cell.samples.length >= N) return;
    const { sample, reason } = await measureOne(reg, durationMs, distance);
    evidence.push({
      arm,
      durationMs,
      distance,
      round,
      tMs: Date.now() - t0,
      ok: sample !== null,
      confidence: sample ? sample.confidence : null,
    });
    if (sample) cell.samples.push(sample);
    else cell.drops.push({ round, reason: reason ?? "unknown" });
  };

  const visits: Visit[] = includeOff
    ? ["off", "input-manager", "uia-control", "uia-selftest"]
    : ["input-manager", "uia-control", "uia-selftest"];

  for (let round = 0; round < rounds; round++) {
    const order = visits.map((_, i) => visits[(i + round) % visits.length]!);
    for (const visit of order) {
      applyArmFlags(VISIT_FLAGS[visit]);
      let reg: Reg | null = null;
      try {
        reg = createRegistry();
        await reg.invokeTool("await-screen-idle", { udid: SERIAL, timeoutMs: 4000 }).catch(() => undefined);
        for (let j = 0; j < perRound; j++) {
          for (const c of CELLS) {
            if (visit === "uia-selftest") {
              // Interleave the two identical-code arms PER SAMPLE.
              await take(reg, "ON-uia-A", c.durationMs, c.distance, round);
              await take(reg, "ON-uia-B", c.durationMs, c.distance, round);
            } else {
              await take(reg, VISIT_FLAGS[visit], c.durationMs, c.distance, round);
            }
          }
        }
      } catch (e) {
        const reason = `visit ${visit} round ${round} failed: ${e instanceof Error ? e.message : String(e)}`;
        armRoundFailures.push(reason);
        const owed: FlingArm[] = visit === "uia-selftest" ? ["ON-uia-A", "ON-uia-B"] : [VISIT_FLAGS[visit]];
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
      await sleep(3000);
    }
    // eslint-disable-next-line no-console
    console.log(`[fling] round ${round + 1}/${rounds} complete`);
  }
  unsetFlag("open-device-server", "project");
  delete process.env.ARGENT_OPEN_INJECT_STRATEGY;

  const estimatorMeta = { metric: "optical-scroll-px", strip: "central-band NCC, sub-pixel, confidence≥0.6", minConfidence: 0.6 };
  for (const arm of arms) {
    const cells = CELLS.map((c) => {
      const a = acc[arm].get(cellKey(c.durationMs, c.distance))!;
      return summarizeCell(c.durationMs, c.distance, arm, a.samples, a.drops);
    });
    const result = {
      serial: SERIAL,
      N,
      config: arm,
      injectStrategy: ARM_STRATEGY[arm],
      openServer: ARM_STRATEGY[arm] !== null,
      mode: "interleaved-optical",
      rounds,
      ...estimatorMeta,
      startedAt: new Date(t0).toISOString(),
      finishedAt: new Date().toISOString(),
      cells,
    };
    writeFileSync(join(OUT_DIR, `fling-block-${arm}.json`), JSON.stringify(result, null, 2));
    // eslint-disable-next-line no-console
    console.log(`\n=== FLING BLOCK ${arm} (optical scroll px, interleaved) ===`);
    for (const c of cells) {
      // eslint-disable-next-line no-console
      console.log(
        `d=${c.durationMs}ms dist=${c.distance}: median ${c.medianPx}px iqr=[${c.iqrPx[0]},${c.iqrPx[1]}] n=${c.n}` +
          (c.drops.length ? ` (dropped ${c.drops.length}: ${c.drops.map((d) => d.reason).slice(0, 2).join(" | ")})` : "")
      );
    }
  }
  const evPath = join(OUT_DIR, "fling-interleave-evidence.json");
  writeFileSync(evPath, JSON.stringify({ serial: SERIAL, N, rounds, perRound, t0, events: evidence }, null, 2));
  process.stdout.write(`INTERLEAVE_EVIDENCE_JSON=${evPath}\n`);

  if (armRoundFailures.length) {
    throw new Error(
      `${armRoundFailures.length} arm-round failure(s) — the fling run is not gradable: ${armRoundFailures.join(" ; ")}`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error("[fling] FATAL", e);
    process.exit(1);
  });
