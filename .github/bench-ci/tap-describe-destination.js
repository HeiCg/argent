// Destination check for tap+describe (review finding 12; run 37578606526).
//
// tap+describe never checked that its describe returned the screen the tap navigated
// to. Run 37578606526, post hoc from logcat (TaplEvents ACTION_DOWN + the WindowManager
// OPEN transition): 45/120 OFF timed describes finished before the destination's first
// frame was drawn (DOWN + latency < transition ready), so they cannot have read it, yet
// they counted as fast non-empty successes. ON returned treeEmpty in that window.
//
// Every timed tap+describe read is now classified, the same way on every arm:
//  - empty:   the describe returned no elements (or the open server's treeEmpty).
//  - preTransition ("pre-transition/mixed"; "stale" before run 37591260027): at least
//             one ROOT-ONLY marker is present (the screen as it was before the tap,
//             alone or mixed with the destination).
//  - correct: at least one DESTINATION marker is present and no root-only marker.
//  - other:   neither (a dialog, another app, a half-built screen).
// Markers are id+text keys (`id:<id>`, `text:<label>`) read from the describe text with
// the same rule as the bench's parseDescribe. They are derived per block from that
// block's own settled root and settled destination describes: destination markers =
// keys on the destination and not on the root (e.g. `text:Navigate up`, the sub-screen
// rows, `id:collapsing_toolbar`), root markers = keys on the root and not on the
// destination. A key on both (the "Network & internet" row and the sub-screen title)
// marks neither. Same selector on both arms; each arm's markers come from its own
// backend, so a rendering difference between backends cannot misclassify one of them.
//
// Review 2026-10-07 run 37591260027 finding 2: "stale = a wrong answer" was not supported.
// 22-27 of the 29-32 OFF reads in that class ended before the destination's first frame:
// they showed the screen as it was, there is no sign of a cached tree. The class is now
// `preTransition`, printed "pre-transition/mixed". Old block files carry `stale`; the
// counts read it as preTransition.
"use strict";

const { summarize, wilsonCI } = require("./stats");

/** The four classes, in the order every table prints them. */
const DESTINATION_CLASSES = ["correct", "preTransition", "empty", "other"];
/** Printed name of each class. */
const CLASS_LABEL = {
  correct: "correct",
  preTransition: "pre-transition/mixed",
  empty: "empty",
  other: "other",
};

/** time-to-correct loop: same describe call, POLL_MS apart, up to BUDGET_MS after the timed read. */
const TTC_POLL_MS = 50;
const TTC_BUDGET_MS = 3000;

/**
 * id+text keys of a describe rendering (formatDescribeTree output), and its element
 * count (lines under ROOT). Same rule as parseDescribe in bench-open-vs-proprietary.ts.
 * @param {string} desc
 * @returns {{ elements: number, keys: string[] }}
 */
function describeKeys(desc) {
  const lines = String(desc || "").split("\n");
  const rootIdx = lines.findIndex((l) => l.startsWith("ROOT "));
  const body = lines.slice(rootIdx + 1).filter((l) => l.trim().length > 0);
  const set = new Set();
  for (const line of body) {
    const idM = line.match(/\bid="((?:[^"\\]|\\.)*)"/);
    const labelM = line.match(/(?<![=\w])"((?:[^"\\]|\\.)*)"/); // first quoted, not name="..."
    if (idM && idM[1]) set.add(`id:${idM[1]}`);
    if (labelM && labelM[1]) set.add(`text:${labelM[1]}`);
  }
  return { elements: body.length, keys: [...set] };
}

/**
 * Markers from one settled root describe and one settled destination describe.
 * `valid` is false when either side has no marker of its own (the destination read was
 * still the root, or the root read was already the destination): no read can then be
 * classified correct or pre-transition, and the caller re-derives.
 * @param {string} rootDesc
 * @param {string} destDesc
 * @returns {{ dest: string[], root: string[], valid: boolean }}
 */
function deriveDestinationMarkers(rootDesc, destDesc) {
  const root = new Set(describeKeys(rootDesc).keys);
  const dest = new Set(describeKeys(destDesc).keys);
  const destOnly = [...dest].filter((k) => !root.has(k)).sort();
  const rootOnly = [...root].filter((k) => !dest.has(k)).sort();
  return { dest: destOnly, root: rootOnly, valid: destOnly.length > 0 && rootOnly.length > 0 };
}

/**
 * Classify one describe result. `r` is the describe tool's reply ({ description,
 * treeEmpty? }) or undefined (the call failed: other).
 * @param {unknown} r
 * @param {{ dest: string[], root: string[] } | null | undefined} markers
 * @returns {"correct" | "preTransition" | "empty" | "other"}
 */
function classifyDestination(r, markers) {
  if (!r || typeof r !== "object") return "other";
  const d = /** @type {{ description?: unknown, treeEmpty?: unknown }} */ (r);
  const desc = typeof d.description === "string" ? d.description : null;
  const parsed = desc === null ? null : describeKeys(desc);
  if (d.treeEmpty === true || (parsed && parsed.elements === 0)) return "empty";
  if (!parsed || !markers) return "other";
  const keys = new Set(parsed.keys);
  if (markers.root.some((k) => keys.has(k))) return "preTransition";
  if (markers.dest.some((k) => keys.has(k))) return "correct";
  return "other";
}

/**
 * Per-class counts, rates and Wilson 95 % CIs over `n` classified reads.
 * @param {{ correct?: number, preTransition?: number, stale?: number, empty?: number,
 *   other?: number }} counts `stale` = the pre-run-37591260027 name of preTransition.
 * @returns {{ n: number, counts: Record<string, number>,
 *   rates: Record<string, { k: number, rate: number | null, ci: [number, number] | null }> }}
 */
function destinationRates(counts) {
  const src = { ...(counts || {}) };
  if (src.preTransition == null && src.stale != null) src.preTransition = src.stale;
  const c = Object.fromEntries(DESTINATION_CLASSES.map((k) => [k, src[k] || 0]));
  const n = DESTINATION_CLASSES.reduce((s, k) => s + c[k], 0);
  const rates = Object.fromEntries(
    DESTINATION_CLASSES.map((k) => [
      k,
      { k: c[k], rate: n > 0 ? Number((c[k] / n).toFixed(4)) : null, ci: wilsonCI(c[k], n) },
    ])
  );
  return { n, counts: c, rates };
}

/**
 * One verb's per-sample classes (`destination`) and time-to-correct (`timeToCorrect`), as
 * the bench writes them on the verb. `samples[i]` = { cls, latencyMs (the timed window),
 * ttcMs (from the tap to the first correct read; the timed latency when the timed read
 * was correct; null = timed out), censoredAtMs (elapsed from the tap when the loop gave
 * up; null when reached), polls (untimed describes after the timed one) }.
 * @param {Array<{ cls: string, latencyMs: number, ttcMs: number | null,
 *   censoredAtMs: number | null, polls: number }>} samples
 */
function summarizeDestination(samples) {
  const counts = { correct: 0, preTransition: 0, empty: 0, other: 0 };
  for (const s of samples)
    counts[/** @type {"correct"} */ (s.cls === "stale" ? "preTransition" : s.cls)]++;
  const correctLat = samples.filter((s) => s.cls === "correct").map((s) => s.latencyMs);
  const reached = /** @type {number[]} */ (samples.map((s) => s.ttcMs).filter((x) => x !== null));
  return {
    destination: {
      classes: samples.map((s) => s.cls),
      ...destinationRates(counts),
      correctLatency: correctLat.length ? summarize(correctLat) : null,
      correctLatencySamples: correctLat,
    },
    timeToCorrect: {
      pollMs: TTC_POLL_MS,
      budgetMs: TTC_BUDGET_MS,
      measured: samples.length,
      reached: reached.length,
      timedOut: samples.length - reached.length,
      firstRead: counts.correct,
      fromTapMs: reached.length ? summarize(reached) : null,
      samples: samples.map((s) => s.ttcMs),
      censoredAtMs: samples.map((s) => s.censoredAtMs),
      polls: samples.map((s) => s.polls),
      // Run 37591260027: the loop iteration of each sample (the index in its BENCH logcat
      // marker), so the merge can align time-to-correct with the transition timeline.
      iters: samples.map((s) => (s.i == null ? null : s.i)),
    },
  };
}

/**
 * Time-to-correct samples for a gate: a timed-out sample enters at the elapsed time the
 * loop gave up (a lower bound of its true value), and `timedOut` says how many did, so
 * the gate can refuse a PASS that leans on them.
 * @param {{ samples?: (number | null)[], censoredAtMs?: (number | null)[] } | null | undefined} ttc
 * @returns {{ samples: number[], timedOut: number } | null}
 */
function ttcGateSamples(ttc) {
  if (!ttc || !Array.isArray(ttc.samples) || !ttc.samples.length) return null;
  const cen = ttc.censoredAtMs || [];
  let timedOut = 0;
  const out = [];
  ttc.samples.forEach((x, i) => {
    if (x != null) out.push(x);
    else {
      timedOut++;
      if (cen[i] != null) out.push(/** @type {number} */ (cen[i]));
    }
  });
  return { samples: out, timedOut };
}

/* ---- tap+describe variants (review 2026-10-07 run 37591260027 finding 4) ---- */

// The run picked the P5 comparator after seeing the results (the better of two ON rows),
// ran settle:true at the end of the block instead of interleaved, and never measured the
// call an OFF agent would make (tap → await-screen-idle → describe). Every block now runs
// the same three variants, interleaved per sample in a seeded random order:
//  - "tap+describe(settle:false)": the describe right after the tap (settle is ignored by
//    the proprietary path, so on OFF this is its plain describe);
//  - "tap+describe(settle:true)": the open path's idle-gated describe (plain on OFF);
//  - "tap+await-idle+describe": tap, await-screen-idle (tool defaults), describe (tool
//    defaults): what an agent on either backend does to read a settled screen.
// P5 is pre-registered on the await variant only, on both arms (time-to-correct AND
// correct-at-first-read); the other two are report only. The await variant gets N
// samples, each of the other two N/2.
const TD_VARIANTS = [
  "tap+describe(settle:false)",
  "tap+describe(settle:true)",
  "tap+await-idle+describe",
];
const TD_GATED_VARIANT = "tap+await-idle+describe";

// Step settle-on-action (review run 37609765062 Part B): the settle moves from the
// describe to the action. "tap(settle)+describe" = gesture-tap with settle: true (the open
// server waits for the first accessibility event, then 80 ms of quiet, cap 1500 ms), then
// describe with settle: false. ON blocks only: the proprietary tap ignores `settle`, so on
// OFF the variant is the plain tap+describe(settle:false) already measured there. Report
// only, with a pre-registered target and no gate: correct at first read >= 90 % and
// time-to-correct <= the gated await variant, on ON-im.
const TD_ACTION_SETTLE_VARIANT = "tap(settle)+describe";
const TD_ACTION_SETTLE_TARGET = { correctAtFirstRead: 0.9, ttcAtMostVariant: TD_GATED_VARIANT };
const TD_ON_VARIANTS = [...TD_VARIANTS, TD_ACTION_SETTLE_VARIANT];

/** The tap+describe variants a block runs: the ON arm adds tap(settle)+describe. */
function tdVariantsFor(config) {
  return config === "ON" ? TD_ON_VARIANTS : TD_VARIANTS;
}

/**
 * Samples per variant for a block with BENCH_N = n, in `variants` order: N for the gated
 * variant, N/2 for each other one.
 */
function variantCounts(n, variants = TD_VARIANTS) {
  const half = Math.max(1, Math.round(n / 2));
  return variants.map((v) => (v === TD_GATED_VARIANT ? n : half));
}

/** 32-bit string hash (FNV-1a), the seed of a block's schedule. */
function hashSeed(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Seeded per-sample order of the variants: counts[v] copies of each index v, shuffled
 * (Fisher–Yates, mulberry32 seeded by `seed`). Same seed → same order.
 * @param {number[]} counts @param {string} seed @returns {number[]}
 */
function variantSchedule(counts, seed) {
  const out = [];
  counts.forEach((c, v) => {
    for (let k = 0; k < c; k++) out.push(v);
  });
  let a = hashSeed(String(seed));
  const rnd = () => {
    let t = (a = (a + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

module.exports = {
  TD_VARIANTS,
  TD_GATED_VARIANT,
  TD_ACTION_SETTLE_VARIANT,
  TD_ACTION_SETTLE_TARGET,
  tdVariantsFor,
  variantCounts,
  variantSchedule,
  CLASS_LABEL,
  TTC_POLL_MS,
  TTC_BUDGET_MS,
  deriveDestinationMarkers,
  classifyDestination,
  destinationRates,
  summarizeDestination,
  ttcGateSamples,
};
