// Render the latency-bench scoreboard as Markdown from the merged bench JSON
// Written to stdout; the workflow tees it
// into $GITHUB_STEP_SUMMARY and uploads it as an artifact. This is x86_64/KVM on
// a hosted runner — NOT comparable to the local arm64/HVF numbers; only OFF vs ON
// within THIS run is like-for-like.
//
// Review 2026-10-07 finding 6: the merged JSON carries run validity (`valid`,
// `invalidBlocks`, `runInvalidReasons` from validity.json, the block-order check and
// the merge gates). An INVALID run gets a banner at the top and this script exits 1,
// so the scoreboard step fails the job; OFF-legacy validity only marks its own
// section. No merged JSON at all also exits 1 (a latency run that merged nothing is
// never a result).
//
// Review run 37609765062: P11 on wrong reads (empty + pre-transition/mixed; the empty rate
// is report only), the diagnostic arms ON-im-bg / ON-hostawait in their own report-only
// tables ("Stream causality", "Await algorithm"; an invalid arm marks only its table), qemu
// CPU per thread and host idle / steal / iowait in "CPU per phase", and the P5
// decomposition per arm.
const fs = require("fs");
const path = require("path");
const {
  median,
  round1,
  driftMargin,
  equivalenceMargin,
  pooledNullMargin,
  readCI,
  gateOf,
  gradeFamily,
  gradeFamilyBlocks,
  practicalMargin,
  newcombeDiffCI,
  compareOnce,
} = require("./stats");
const {
  ttcGateSamples,
  TD_VARIANTS,
  TD_GATED_VARIANT,
  CLASS_LABEL,
} = require("./tap-describe-destination");
const { isCurrentOff, isOnIm, isOnUia, isOnImBg, isOnHostawait } = require("./block-arms");
const { VCPU_COMM } = require("./load-sampler");

const OUT = process.env.BENCH_OUT || path.join(process.cwd(), ".bench-results");
const latest = (glob) => {
  const rx = new RegExp(glob);
  const hits = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((f) => rx.test(f)) : [];
  if (hits.length === 0) return null;
  hits.sort();
  return path.join(OUT, hits[hits.length - 1]);
};

const mergedPath = latest("^bench-merged-.*\\.json$");
if (!mergedPath) {
  console.log("## Latency bench — NO RESULTS\n\nNo `bench-merged-*.json` was produced.");
  process.exit(1);
}
const merged = JSON.parse(fs.readFileSync(mergedPath, "utf8"));

const env = merged.env || {};
const ci = env.ci || {};
const L = [];

L.push("## Open vs proprietary — latency bench (CI)");
L.push("");
// Finding 6: INVALID banner before anything else. Old merged JSONs carry no `valid`
// key and read as valid.
const runInvalid = merged.valid === false;
if (runInvalid) {
  L.push("> **INVALID RUN — do not read the numbers below as a result.** The job fails (exit 1).");
  for (const x of merged.invalidBlocks || [])
    L.push(`> - ${x.block}: ${(x.reasons || []).join("; ")}`);
  for (const why of merged.runInvalidReasons || []) L.push(`> - ${why}`);
  L.push("");
}
L.push("> **x86_64 / KVM on a GitHub-hosted runner.** These numbers are NOT comparable");
L.push("> to the local arm64 / HVF results (v4–v6). Only OFF vs ON *within this run* is");
L.push("> like-for-like.");
L.push("");
// Emulator lost mid-run (merge-blocks.js partial mode): say so before any number.
if (merged.partial) {
  const lost = merged.emulatorLost || {};
  L.push(
    `> **PARTIAL — emulator lost at ${lost.lostAt || "?"}${lost.context ? ` (${lost.context})` : ""}.** ` +
      `Only the completed blocks below are reported; missing: ${(merged.missingBlocks || []).join(", ") || "(none)"}. ` +
      "Not a complete run: do not compare it against a full one. The job fails."
  );
  L.push("");
}
L.push(
  `Blocks run: **${(merged.blocksRan || []).join(", ") || "?"}**` +
    (merged.offArmPresent ? "" : "  — **ON-only** (proprietary OFF arm absent/refused)")
);
L.push("");

// Environment
L.push("### Environment");
L.push("");
L.push("| key | value |");
L.push("| --- | --- |");
const row = (k, v) =>
  L.push(`| ${k} | ${v === undefined || v === null ? "-" : String(v).replace(/\|/g, "\\|")} |`);
row("android release", env.androidRelease);
row("android sdk", env.androidSdk);
row("abi", env.abi);
row("screen", env.screen);
row("density", env.density);
row("N / warmup / cold", `${env.N} / ${env.WARMUP} / ${env.COLD}`);
row("tokenizer", env.tokenizer);
row("nproc", ci.nproc);
row("RAM (free -m total)", ci.memTotalMb ? `${ci.memTotalMb} MB` : undefined);
row("RAM available", ci.memAvailMb ? `${ci.memAvailMb} MB` : undefined);
row("swap total", ci.swapTotalMb !== undefined ? `${ci.swapTotalMb} MB` : undefined);
row("KVM present", ci.kvm);
row("emulator image", ci.emulatorImage);
row("emulator arch", ci.emulatorArch);
row("runner", ci.runner);
// Emulator/host provenance (ci-emulator-env.json); absent on pre-diagnostics runs.
const emu = merged.emulator || null;
if (emu) {
  const e = emu.emulator || {};
  row(
    "emulator",
    e.version
      ? `${e.version} (build ${e.buildId || "?"})${e.pinnedBuild ? " — pinned via emulator_build" : ""}`
      : undefined
  );
  row("emulator -gpu / RAM", e.gpu ? `${e.gpu} / ${e.memoryMb ?? "?"} MB` : undefined);
  row("system image revision", emu.systemImage ? emu.systemImage.revision : undefined);
  row(
    "adb",
    emu.adb && emu.adb.version ? `${emu.adb.version} (${emu.adb.platformTools || "?"})` : undefined
  );
  row("runner image", emu.runnerImage ? emu.runnerImage.version : undefined);
  row("kernel", emu.kernel);
}
L.push("");

// Re-baseline (0.27): which proprietary release each OFF block ran (npm version +
// sha256 of every binary/APK used), so a "vs proprietary" number names its baseline.
const pp = merged.proprietaryProvenance || null;
const provLabel = (p) =>
  !p ? "unknown" : typeof p !== "object" ? String(p) : `${p.package || "?"}@${p.version || "?"}`;
const offBlockNames = (merged.blocks || [])
  .map((b) => b.block)
  .filter((n) => typeof n === "string" && n.startsWith("OFF"));
if (offBlockNames.length) {
  L.push("### Proprietary provenance");
  L.push("");
  L.push("| block | release | file | sha256 |");
  L.push("| --- | --- | --- | --- |");
  for (const n of offBlockNames) {
    const p = pp && pp.byBlock ? pp.byBlock[n] : null;
    const entries = p && typeof p === "object" ? Object.entries(p.files || {}) : [];
    if (!entries.length) L.push(`| ${n} | ${provLabel(p)} | - | - |`);
    for (const [f, h] of entries) L.push(`| ${n} | ${provLabel(p)} | \`${f}\` | \`${h}\` |`);
  }
  L.push("");
}

// Per-block verb latency (p50/p95 ms)
const blocks = merged.blocks || [];
const verbNames = [];
for (const b of blocks)
  for (const v of b.verbs || []) if (!verbNames.includes(v.verb)) verbNames.push(v.verb);

// Review 2026-10-07 findings 4/5: every statistic below comes from stats.js — the true
// median (the same quantile the bench script records p50/p95 with), the seeded
// 10 000-draw bootstrap, the drift margin, the CI-vs-margin reading and Holm.
const verbOf = (b, vn) => b && (b.verbs || []).find((x) => x.verb === vn);
const p50Of = (b, vn) => {
  const v = verbOf(b, vn);
  return v ? v.latency.p50 : null;
};
const samplesOf = (b, vn) => {
  const v = verbOf(b, vn);
  return v && Array.isArray(v.latencySamples) ? v.latencySamples : null;
};
// Latencies are float ms since finding 4 (performance.now): print to 0.1 ms.
const fmt = (x) => (x == null || !Number.isFinite(x) ? "-" : String(round1(x)));
const ciStr = (ci) => (ci ? `[${ci[0]}, ${ci[1]}]` : "no samples");
const pct = (level) => `${Number((level * 100).toFixed(2))}%`;
// Finding 9: await-* rows compare the tool-server's host-side wait algorithms, not
// drivers (OFF await-screen-idle polls from the host every 200 ms with a 250 ms stable
// window; ON waits on device events). Labelled wherever a verb name is printed.
const isHostAlgo = (vn) => /^await-/.test(vn);
// Run 37591260027 finding 3: gesture-swipe / gesture-pinch are timed as the gesture plus
// one describe; labelled as such wherever a verb name is printed.
const DRAINED_LABEL = { "gesture-swipe": "swipe+describe", "gesture-pinch": "pinch+describe" };
const verbLabel = (vn) =>
  isHostAlgo(vn)
    ? `${vn} (host algorithm)`
    : DRAINED_LABEL[vn]
      ? `${DRAINED_LABEL[vn]} (${vn})`
      : vn;

const off1Blk = blocks.find((b) => b.block === "OFF-1");
const off2Blk = blocks.find((b) => b.block === "OFF-2");
// Drift (published): OFF-1 p50 − OFF-2 p50, a point difference. Bootstrap margin: the
// 95th percentile of |Δp50| over 10 000 resamples of OFF-1 and OFF-2 (stats.driftMargin).
// Margin (gating, run 37561512651 / Review 2026-10-07): the pre-registered equivalence
// margin max(bootstrap margin, 2 % of the pooled OFF p50, 1 ms) (stats.equivalenceMargin).
function drift(vn) {
  const a = p50Of(off1Blk, vn),
    b = p50Of(off2Blk, vn);
  return a != null && b != null ? round1(a - b) : null;
}
const marginCache = new Map();
function offEquivalence(vn) {
  if (!marginCache.has(vn))
    marginCache.set(vn, equivalenceMargin(samplesOf(off1Blk, vn), samplesOf(off2Blk, vn)));
  return marginCache.get(vn);
}
function offMargin(vn) {
  const e = offEquivalence(vn);
  return e ? e.margin : null;
}
function offBootMargin(vn) {
  return driftMargin(samplesOf(off1Blk, vn), samplesOf(off2Blk, vn));
}
const EQUIV_FOOTER =
  "pre-registered equivalence margin: 2 % of the proprietary p50 or 1 ms, whichever is " +
  "larger, never below the measured OFF drift";
// Run 37591260027: every current OFF block (OFF-1, OFF-2, OFF-3 …) pools into the arm.
const pooledOffSamplesOf = (vn) => {
  const offs = blocks.filter((b) => isCurrentOff(b.block));
  if (!offs.length) return null;
  const parts = offs.map((b) => samplesOf(b, vn));
  if (offs.length === 1) return parts[0];
  return parts.every(Boolean) ? parts.flat() : null;
};

L.push("### Verb latency p50 / p95 (ms)");
L.push("");
L.push("| verb | " + blocks.map((b) => b.block).join(" | ") + " |");
L.push("| --- | " + blocks.map(() => "---").join(" | ") + " |");
for (const vn of verbNames) {
  const cells = blocks.map((b) => {
    const v = (b.verbs || []).find((x) => x.verb === vn);
    if (!v) return "-";
    const fb = v.fallbacks ? ` ⚠fb${v.fallbacks}` : "";
    const err = v.errors ? ` err${v.errors}` : "";
    return `${fmt(v.latency.p50)}/${fmt(v.latency.p95)}${err}${fb}`;
  });
  L.push(`| ${verbLabel(vn)} | ${cells.join(" | ")} |`);
}
L.push("");
// Run 37591260027 finding 3: the swipe/pinch rows include one describe.
if (verbNames.some((vn) => DRAINED_LABEL[vn])) {
  L.push(
    "_swipe+describe / pinch+describe = the gesture plus one describe(settle:false) in the timed " +
      "window (it drains a queued async final UP); the gesture alone is the gesture-only column " +
      "of the table below. In run 37591260027 ~500 ms of the pinch row was the describe after " +
      "the pinch (OFF 720-730 ms, ON 216 ms), so the two rows answer different questions._"
  );
  L.push("");
}
if (verbNames.some(isHostAlgo)) {
  L.push(
    "_await-\\* rows are a host-algorithm difference, not a driver comparison: OFF runs the " +
      "tool-server's host-side wait (await-screen-idle polls from the host every 200 ms with a " +
      "250 ms stable window), ON waits on device events. Read them as which algorithm, not which " +
      "driver, is faster (review 2026-10-07 finding 9)._"
  );
  L.push("");
}

// Review 2026-10-07 finding 2: gesture-swipe / gesture-pinch are timed as the gesture
// PLUS one draining read (the same read on every arm), so an async final UP that is
// still queued when the RPC returns is paid for inside the timed window. The raw
// gesture-only time of the same iterations is the secondary "no-drain" column.
const drainRows = [];
for (const vn of ["gesture-swipe", "gesture-pinch"]) {
  for (const b of blocks) {
    const v = verbOf(b, vn);
    if (v && v.noDrain) drainRows.push({ vn, b, v });
  }
}
if (drainRows.length) {
  const read = drainRows.find((r) => r.v.drainRead)?.v.drainRead || "?";
  L.push("### swipe+describe / pinch+describe and the gesture alone");
  L.push("");
  L.push(
    `Timed window = gesture + \`${read}\` on every arm (it drains a queued async final UP). ` +
      "gesture only = the gesture call alone, same iterations; gated with the same rule (P3/P4)."
  );
  L.push("");
  L.push("| verb | block | gesture + describe p50/p95 | gesture only p50/p95 |");
  L.push("| --- | --- | --- | --- |");
  for (const { vn, b, v } of drainRows) {
    const nd = v.noDrain.latency || {};
    L.push(
      `| ${DRAINED_LABEL[vn]} | ${b.block} | ${fmt(v.latency.p50)}/${fmt(v.latency.p95)} | ${fmt(nd.p50)}/${fmt(nd.p95)} |`
    );
  }
  L.push("");
}

// Run 37561512651 / Review 2026-10-07: per verb, the open-server fallback lines (now
// counted at console.debug, console.warn and console.error) and the timed samples whose
// describe came back empty (`treeEmpty`: the open server's marker or 0 elements on ON,
// 0 elements on OFF). Since run 37571460849 they are excluded from the verb's latency on
// both arms and graded by P11 (section below), not invalidating. Per block, the Settings
// reset wait (resumed + focused + not finishing + stable pid after am start) and the
// probe's decision-reason histogram. Older artifacts carry neither.
const hasTreeEmpty = blocks.some((b) => (b.verbs || []).some((v) => v.treeEmpty != null));
const hasResetWait = blocks.some((b) => b.resetWait);
if (hasTreeEmpty || hasResetWait) {
  L.push("### Fallbacks, empty trees and resets");
  L.push("");
  if (hasTreeEmpty) {
    L.push(
      "treeEmpty = timed samples whose describe returned an empty tree (ON: the open " +
        "server's `treeEmpty` or 0 elements; OFF: 0 elements). They are excluded from that verb's " +
        "latency on both arms and graded by P11 below; an ON fallback invalidates the block."
    );
    L.push("");
    L.push("| verb | block | fallbacks | treeEmpty |");
    L.push("| --- | --- | --- | --- |");
    for (const vn of verbNames) {
      for (const b of blocks) {
        const v = verbOf(b, vn);
        if (!v) continue;
        L.push(
          `| ${vn} | ${b.block} | ${v.fallbacks || 0} | ${v.treeEmpty == null ? "-" : v.treeEmpty} |`
        );
      }
    }
    L.push("");
  }
  if (hasResetWait) {
    L.push(
      "Settings reset wait after `am start` until Settings is resumed, focused, not finishing " +
        "and on the same pid over two reads (bounded at 5 s; relaunched with force-stop + am start " +
        "if it was killed). am start waits 2 s after pm clear (run 37571460849). probe reasons = " +
        "the wait's decisions over the block: `wait:<why not ready>` per poll, `relaunch:<why>`, " +
        "`relaunch-start:<am start answer>`, `outcome:ready|timeout`."
    );
    L.push("");
    L.push(
      "| block | resets | resetWaitMs mean | resetWaitMs max | timeouts | relaunches | probe reasons |"
    );
    L.push("| --- | --- | --- | --- | --- | --- | --- |");
    const reasonsCell = (rs) =>
      rs && Object.keys(rs).length
        ? Object.entries(rs)
            .sort((x, y) => y[1] - x[1])
            .map(([k, n]) => `${k}=${n}`)
            .join(", ")
        : "-";
    for (const b of blocks) {
      const r = b.resetWait;
      if (!r) continue;
      L.push(
        `| ${b.block} | ${r.n} | ${fmt(r.meanMs)} | ${fmt(r.maxMs)} | ${r.timeouts} | ${r.relaunches} | ` +
          `${reasonsCell(r.reasons)} |`
      );
    }
    L.push("");
  }
}

// Run 37578606526 / review finding 12: tap+describe reads classified correct /
// pre-transition / empty / other against the block's destination markers
// (merged.destinationRates), and P12 = the pre-transition/mixed rate per (block, verb),
// report only. Run 37591260027 finding 2: such a read showed the screen as it was before
// the tap; no sign of a cached tree ("stale = a wrong answer" is withdrawn).
const pctCell = (x) => (x == null ? "-" : `${Number((x * 100).toFixed(1))}%`);
const rateCiCell = (r) =>
  r && r.rate != null
    ? `${pctCell(r.rate)} [${pctCell(r.ci[0])}, ${pctCell(r.ci[1])}]`
    : "no denominator";
const destRows = merged.destinationRates || [];
const p12Rows = (merged.p12 && merged.p12.rows) || [];
const PT = CLASS_LABEL.preTransition;
const PRE_TRANSITION_NOTE =
  `A ${PT} read showed (part of) the screen as it was before the tap: the describe ran ` +
  "before the destination was drawn. In run 37591260027, 22-27 of the 29-32 OFF reads in " +
  "this class ended before the destination's first frame; there is no sign of a cached " +
  "tree (review finding 2).";
const ptOf = (r) => (r.preTransition != null ? r.preTransition : r.stale);
function p12Line() {
  return (
    `- **P12** — ${PT} tap+describe reads (a root-only marker present) per block, Wilson 95 % CI, ` +
    "report only, not gated: " +
    p12Rows.map((r) => `${r.block} ${r.verb} ${ptOf(r)}/${r.n} = ${rateCiCell(r)}`).join("; ") +
    ": **REPORT ONLY**"
  );
}

// Review run 37609765062 Part B finding 1: P11 grades WRONG reads per tap+describe variant
// per block (merged.wrongReadRates: empty + pre-transition/mixed out of the classified
// reads). The empty rate per timed verb (merged.emptyRates) is published, report only.
// Older merged JSONs (P11 on the empty rate) carry no `metric` and render their old line.
const emptyRates = merged.emptyRates || [];
const wrongRows = merged.wrongReadRates || [];
if (wrongRows.length || emptyRates.length || merged.p11) {
  const p11 = merged.p11 || { verdict: "N/A", fails: [], inconclusive: [] };
  const detail = [
    p11.fails && p11.fails.length ? `FAIL: ${p11.fails.join(", ")}` : "",
    p11.inconclusive && p11.inconclusive.length
      ? `INCONCLUSIVE: ${p11.inconclusive.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("; ");
  const ciCellOf = (r) => (r.ci ? `[${pctCell(r.ci[0])}, ${pctCell(r.ci[1])}]` : "no denominator");
  L.push("### Wrong reads in tap+describe and describe — quality metric (P11)");
  L.push("");
  L.push(
    "A tap+describe read is wrong when it is empty (no elements: the describe landed inside " +
      `the transition) or ${PT} (a root-only marker: it showed the screen as it was before the ` +
      "tap), from the destination check below; a plain describe read is wrong when it is empty. " +
      "Both are wrong answers to an agent; the first is visible, the second silent. P11 gates " +
      "tap+await-idle+describe and plain describe per block; the settle variants keep their " +
      "rate here, report only."
  );
  L.push("");
  L.push(
    `| variant | block | wrong (empty + ${PT}) / reads | empty | ${PT} | rate | Wilson 95% CI | P11 (≤ 25 %) |`
  );
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of wrongRows)
    L.push(
      `| ${r.verb} | ${r.block} | ${r.wrong}/${r.n} | ${r.empty} | ${r.preTransition ?? "-"} | ` +
        `${pctCell(r.rate)} | ${ciCellOf(r)} | ${r.gated === false ? r.reportOnly : r.gate} |`
    );
  L.push("");
  L.push(
    (p11.metric
      ? `- **P11** — wrong reads (empty + ${PT}) ≤ 25 % per block, gated on ` +
        "tap+await-idle+describe and plain describe (empty = wrong) (pre-registered threshold, " +
        "re-graded per review 2026-10-07 run 37609765062 Part B finding 1: an empty read and a " +
        "pre-transition read are both wrong, and grading empties alone penalised the arm whose " +
        "describe lands inside the transition instead of before it; Wilson 95 % CI: PASS if the " +
        "upper bound ≤ 25 %, FAIL if the lower bound > 25 %, INCONCLUSIVE if it straddles 25 %; " +
        "a FAIL on any main arm fails it; a gated read with no classified read FAILs; " +
        "settle:false / settle:true variants: report only, both arms fail them back to back " +
        "(run 37609765062: 15-20 of 20 wrong per block) so the gate does not discriminate, and " +
        "their oracle is correct-at-first-read in the destination check (P12); empty rate: " +
        "report only)"
      : "- **P11** — empty rate ≤ 25 % per timed verb per block (pre-registered; Wilson 95 % CI: PASS " +
        "if the upper bound ≤ 25 %, FAIL if the lower bound > 25 %, INCONCLUSIVE if it straddles " +
        "25 %; a FAIL on either arm fails it; empties with no denominator FAIL)") +
      (detail ? ` (${detail})` : "") +
      `: **${p11.verdict}**`
  );
  // Run 37578606526 / finding 12: P12, printed right next to P11 — the pre-transition rate.
  if (p12Rows.length) L.push(p12Line());
  if (p11.legacyVerdict)
    L.push(`- **P11 (OFF-legacy, own arm)** — same rule: **${p11.legacyVerdict}**`);
  for (const [n, v] of Object.entries(p11.diagnosticVerdicts || {}))
    L.push(`- **P11 (${n}, diagnostic arm, report only)** — same rule: **${v}**`);
  L.push("");
  if (emptyRates.length) {
    L.push("### Empty describes in timed verbs — report only");
    L.push("");
    L.push(
      "A timed window whose describe came back empty is excluded from that verb's latency on both " +
        "arms (the p50/p95 above are over the non-empty windows). Its rate is published here: " +
        "empty / windows that read a describe, with a Wilson 95 % CI. Report only since review run " +
        "37609765062 (P11 grades the wrong reads above)."
    );
    L.push("");
    L.push("| verb | block | empty / windows | rate | Wilson 95% CI |");
    L.push("| --- | --- | --- | --- | --- |");
    for (const r of emptyRates)
      L.push(
        `| ${r.verb} | ${r.block} | ${r.empty}/${r.n} | ${pctCell(r.rate)} | ${ciCellOf(r)} |`
      );
    L.push("");
  }
  // Time to a non-empty describe after an empty one inside tap+describe: the first
  // non-empty read of the untimed time-to-correct loop (50 ms apart; up to 2 s before run
  // 37578606526, up to 3 s since) after an empty timed window, on every arm. "from tap" is
  // what an agent waits for after acting; "after the empty" is the extra wait past the
  // timed window. A non-empty read can still be pre-transition (see the destination check).
  const ttneRows = emptyRates.filter((r) => r.timeToNonEmpty);
  if (ttneRows.length) {
    const budget = destRows.length ? "3 s" : "2 s";
    L.push("### tap+describe time-to-non-empty");
    L.push("");
    L.push(
      `After an empty timed describe, an untimed describe loop (50 ms apart, up to ${budget}) runs until ` +
        "a describe is non-empty. from tap = from the start of the timed tap; after the empty = from " +
        `the end of the timed window. Same loop on every arm. Non-empty is not correct: a ${PT} read ` +
        "is non-empty."
    );
    L.push("");
    L.push(
      `| block | verb | empties | reached non-empty | timed out (${budget}) | from tap p50/p95 (ms) | after the empty p50/p95 (ms) |`
    );
    L.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const r of ttneRows) {
      const t = r.timeToNonEmpty;
      const pp = (x) => (x ? `${fmt(x.p50)}/${fmt(x.p95)}` : "-");
      L.push(
        `| ${r.block} | ${r.verb} | ${t.measured} | ${t.reached} | ${t.timedOut} | ${pp(t.fromTapMs)} | ` +
          `${pp(t.afterEmptyMs)} |`
      );
    }
    L.push("");
  }
}

if (destRows.length) {
  const pp = (x) => (x ? `${fmt(x.p50)}/${fmt(x.p95)}` : "-");
  L.push(`### tap+describe destination check — correct / ${PT} / empty / other (P12)`);
  L.push("");
  L.push(
    "Every timed tap+describe read is classified against the block's own markers, derived from " +
      "its settled root and settled destination describes (id+text keys on one and not the other; " +
      `same selector on every arm): correct = a destination marker and no root-only marker; ${PT} = ` +
      "a root-only marker present (the screen as it was before the tap, alone or mixed); empty = no " +
      "elements; other = neither. Rates with Wilson 95 % CIs. correct-only latency = the timed " +
      "window over correct reads (the honest headline). time-to-correct = from the tap to the first " +
      "correct read: the timed latency when the timed read was correct, else an untimed describe " +
      "loop (same call, 50 ms apart, up to 3 s after the timed read) on every sample. " +
      PRE_TRANSITION_NOTE
  );
  L.push("");
  L.push(
    `| block | verb | n | correct | ${PT} | empty | other | correct rate | ${PT} rate (P12) | empty rate | correct-only latency p50/p95 (ms) | time-to-correct p50/p95 (ms) | correct at first read | timed out |`
  );
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of destRows) {
    const t = r.timeToCorrect || {};
    L.push(
      `| ${r.block} | ${r.verb} | ${r.n} | ${r.counts.correct} | ${ptOf(r.counts)} | ${r.counts.empty} | ` +
        `${r.counts.other} | ${rateCiCell(r.rates.correct)} | ${rateCiCell(r.rates.preTransition || r.rates.stale)} | ` +
        `${rateCiCell(r.rates.empty)} | ${pp(r.correctLatency)} | ${pp(t.fromTapMs)} | ` +
        `${t.firstRead ?? "-"} | ${t.timedOut ?? "-"} |`
    );
  }
  L.push("");
  if (!emptyRates.length && !merged.p11 && p12Rows.length) {
    L.push(p12Line());
    L.push("");
  }
}

// Run 37571460849: blocks the workflow recorded as not run, with the reason.
if ((merged.notRun || []).length) {
  L.push(`Did not run: ${merged.notRun.map((x) => `**${x.block}** (${x.reason})`).join(", ")}`);
  L.push("");
}

// describe sample + screenshot dims
L.push("### describe sample & screenshot");
L.push("");
L.push("| block | source | bytes | tokens | elements | screenshot |");
L.push("| --- | --- | --- | --- | --- | --- |");
for (const b of blocks) {
  const d = b.describeSample || {};
  const s = b.screenshot || {};
  L.push(
    `| ${b.block} | ${d.source ?? "-"} | ${d.bytes ?? "-"} | ${d.tokens ?? "-"} | ${d.elements ?? "-"} | ${s.width}x${s.height} ${s.bytes}b |`
  );
}
L.push("");

// Review 2026-10-07 finding 11: what each block ran — the harness checkout, the host
// runtime, the tokenizer package and the sha256 of the device-side APK as installed
// (open server on ON, the proprietary helper APK on OFF). Absent on older blocks.
const provBlocks = blocks.filter((b) => b.buildProvenance);
if (provBlocks.length) {
  L.push("### Build provenance");
  L.push("");
  L.push("| block | git sha | node | js-tiktoken | installed package | installed APK sha256 |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const b of provBlocks) {
    const bp = b.buildProvenance;
    const ia = bp.installedApk || {};
    const sha = bp.gitSha ? `\`${String(bp.gitSha).slice(0, 12)}\`` : "-";
    const files = ia.files && ia.files.length ? ia.files : [null];
    for (const f of files)
      L.push(
        `| ${b.block} | ${sha} | ${bp.node || "-"} | ${bp.jsTiktoken || "-"} | ${ia.package || "-"} | ` +
          `${f ? `\`${f.sha256}\`` : `- ${ia.error ? `(${String(ia.error).replace(/\|/g, "\\|")})` : ""}`} |`
      );
  }
  const onHashes = new Set(
    provBlocks
      .filter((b) => b.block.startsWith("ON"))
      .map((b) =>
        ((b.buildProvenance.installedApk || {}).files || []).map((f) => f.sha256).join(",")
      )
  );
  if (onHashes.size > 1)
    L.push("", "> The ON blocks ran different installed open-server APKs (sha256 differs).");
  L.push("");
}

// cold start
L.push("### Cold-start describe (ms)");
L.push("");
L.push("| block | samples |");
L.push("| --- | --- |");
for (const b of blocks)
  L.push(
    `| ${b.block} | ${JSON.stringify((b.coldStartMs || []).map((x) => (Number.isFinite(x) ? round1(x) : x)))} |`
  );
L.push("");

// Fidelity
if (merged.fidelity) {
  const f = merged.fidelity;
  L.push("### Fidelity (OFF-1 describe vs ON-uiautomation describe)");
  L.push("");
  L.push(
    `- Jaccard(id+text set): **${f.off1_vs_on_jaccard}** (OFF ${f.offCount} vs ON ${f.onCount} keys)`
  );
  if (f.onlyOff && f.onlyOff.length)
    L.push(`- only OFF: ${f.onlyOff.slice(0, 12).join(", ")}${f.onlyOff.length > 12 ? " …" : ""}`);
  if (f.onlyOn && f.onlyOn.length)
    L.push(`- only ON: ${f.onlyOn.slice(0, 12).join(", ")}${f.onlyOn.length > 12 ? " …" : ""}`);
  L.push("");
} else {
  L.push("### Fidelity");
  L.push("");
  L.push("_Not computed — the OFF-1 proprietary arm did not produce a describe sample this run._");
  L.push("");
}

// OFF drift: the published point difference and the bootstrap margin the gates use.
const off1 = off1Blk;
const off2 = off2Blk;
if (off1 && off2) {
  L.push("### OFF-1 vs OFF-2 drift (proprietary self-consistency)");
  L.push("");
  L.push(
    "drift = OFF-1 p50 − OFF-2 p50 (point). bootstrap margin = 95th percentile of |p50(OFF-1\\*) − " +
      "p50(OFF-2\\*)| over 10 000 seeded resamples of each block. equivalence margin = " +
      "max(bootstrap margin, 2 % of the pooled OFF p50, 1 ms), the term that binds in brackets; " +
      "the gates read CIs against ±equivalence margin."
  );
  L.push("");
  L.push("| verb | OFF-1 p50 | OFF-2 p50 | drift | bootstrap margin | equivalence margin |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const vn of verbNames) {
    const a = verbOf(off1, vn);
    const b = verbOf(off2, vn);
    if (!a && !b) continue;
    const m = offBootMargin(vn);
    const e = offEquivalence(vn);
    L.push(
      `| ${verbLabel(vn)} | ${a ? fmt(a.latency.p50) : "-"} | ${b ? fmt(b.latency.p50) : "-"} | ` +
        `${fmt(drift(vn))} | ${m == null ? "N/A" : `±${m}`} | ` +
        `${e ? `±${e.margin} (${e.binding})` : "N/A"} |`
    );
  }
  L.push("");
}

// Run 37591260027 (ABBA): with three OFF blocks, the per-block p50s and their spread.
const allOff = blocks.filter((b) => isCurrentOff(b.block));
if (allOff.length > 2) {
  L.push("### Current OFF arm per block (ABBA)");
  L.push("");
  L.push(
    "| verb | " + allOff.map((b) => b.block).join(" | ") + " | between-block SD of the p50s |"
  );
  L.push("| --- | " + allOff.map(() => "---").join(" | ") + " | --- |");
  for (const vn of verbNames) {
    const ps = allOff.map((b) => p50Of(b, vn));
    if (ps.every((x) => x == null)) continue;
    const vs = ps.filter((x) => x != null);
    const m = vs.reduce((x, y) => x + y, 0) / vs.length;
    const sd =
      vs.length > 1
        ? Math.sqrt(vs.reduce((x, y) => x + (y - m) * (y - m), 0) / (vs.length - 1))
        : null;
    L.push(`| ${verbLabel(vn)} | ${ps.map(fmt).join(" | ")} | ${fmt(sd)} |`);
  }
  L.push("");
}

// Re-baseline (0.27): OFF-legacy (an older proprietary release, same job + emulator)
// vs the CURRENT proprietary arm. Report only (not a gate): Δ = legacy p50 − p50 of the
// pooled OFF-1+OFF-2 samples, unadjusted 95% bootstrap CI, read against the same OFF
// drift margin with the same rule (stats.readCI). The merge guarantees OFF-1/OFF-2 share
// one provenance, so the margin is same-provenance; OFF-legacy never enters it. Δ < 0 =
// the old release was faster than the current one.
const legacyBlk = blocks.find((b) => b.block === "OFF-legacy");
const la = merged.legacyArm || null;
if (la && la.invalid) {
  // Finding 6: a failed / degraded / unstamped / wrong-release OFF-legacy invalidates
  // this section only. Its numbers are not printed as a comparison.
  L.push(
    `### Proprietary baseline: ${la.version || la.label || "unknown"} vs ${la.currentVersion || la.currentLabel || "unknown"} — INVALID`
  );
  L.push("");
  L.push(
    "OFF-legacy is not a valid baseline this run (legacy section only; the main arms are unaffected):"
  );
  L.push("");
  for (const why of la.invalidReasons || []) L.push(`- ${why}`);
  L.push("");
} else if (legacyBlk && la) {
  const legLabel = la.version || la.label || "unknown";
  const curLabel = la.currentVersion || la.currentLabel || "unknown";
  L.push(`### Proprietary baseline: ${legLabel} vs ${curLabel}`);
  L.push("");
  L.push(
    `OFF-legacy (${la.label}) vs the current OFF arm (${la.currentLabel}; OFF-1/OFF-2 pooled), ` +
      "same job and emulator. Report only. Δ = legacy p50 − pooled current p50; 95% CI = seeded " +
      "10 000-draw bootstrap; reading = CI vs ±margin (the equivalence margin of the OFF arm) " +
      "(win = the legacy release is faster, loss = slower)."
  );
  L.push("");
  L.push(
    "| verb | OFF-legacy p50/p95 | OFF-1 p50/p95 | OFF-2 p50/p95 | margin | Δ(legacy−pooledOFF) | 95% CI | reading |"
  );
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  const pp95 = (b, vn) => {
    const v = verbOf(b, vn);
    return v ? `${fmt(v.latency.p50)}/${fmt(v.latency.p95)}` : "-";
  };
  for (const d of la.deltaVsCurrent || []) {
    const vn = d.verb;
    const margin = offMargin(vn);
    const { ci } = compareOnce(samplesOf(legacyBlk, vn), pooledOffSamplesOf(vn));
    L.push(
      "| " +
        [
          verbLabel(vn),
          pp95(legacyBlk, vn),
          pp95(off1Blk, vn),
          pp95(off2Blk, vn),
          margin == null ? "**N/A**" : `±${margin}`,
          d.delta == null ? "-" : d.delta,
          ciStr(ci),
          d.delta == null ? "-" : readCI(ci, margin),
        ].join(" | ") +
        " |"
    );
  }
  L.push("");
}

// Review 2026-10-07 run 37591260027 finding 1 (Part A): what the proprietary stack runs
// in the background during an OFF block, the per-phase CPU, and the transition timeline
// per block (logcat BENCH markers). Absent on older merged JSONs.
{
  const pb = merged.propBackground || null;
  L.push("### Proprietary stack background (Part A)");
  L.push("");
  const streamWord = !pb
    ? "unknown"
    : pb.stream === "on-at-spawn"
      ? "on"
      : pb.stream === "on-after-screenshot"
        ? "on after the first screenshot"
        : "undetermined";
  L.push(
    `- **proprietary stack background: stream=${streamWord}** because ` +
      (pb ? `${pb.verdict} (probe: ${pb.workload}).` : "no PROBE-BG result in this run.")
  );
  L.push(
    "- From the code (identical to upstream/main): the tool-server spawns `simulator-server android " +
      "--id <serial>` lazily, on the first tool that needs it (any gesture, paste or screenshot; not " +
      "at boot), with no streaming flag and no ARGENT_* env; only screen-recording and the preview " +
      "UI read its MJPEG stream, and the bench calls neither. Its only screen RPC to the emulator is " +
      "`EmulatorController/streamScreenshot` (a frame on every display change). The OFF arm is an " +
      "upstream headless agent's: spawned by the first tap, screenshot taken after the last timed verb."
  );
  if (pb && Array.isArray(pb.windows) && pb.windows.length) {
    L.push("");
    L.push(
      "| probe window | seconds | qemu CPU % | simulator-server CPU % | simulator-server alive | its log lines | stream lifecycle lines |"
    );
    L.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const w of pb.windows)
      L.push(
        `| ${w.window} | ${fmt(w.seconds)} | ${fmt(w.qemuCpuPct)} | ${fmt(w.simServerCpuPct)} | ` +
          `${w.simServerAlive ? "yes" : "no"} | ${w.simLines} | ${w.streamLines} |`
      );
    if ((pb.streamLineSamples || []).length) {
      L.push("");
      for (const l of pb.streamLineSamples.slice(0, 5))
        L.push(`- \`${String(l).replace(/`/g, "'")}\``);
    }
  }
  if (pb && pb.cpuDeltaCaveat) {
    L.push("");
    L.push(`- ${pb.cpuDeltaCaveat}`);
  }
  // Review run 37609765062 findings 2 and 6: state only what the run proves. The stream
  // is on without a client; the OFF guest is more loaded; the cause is not isolated.
  if (pb && pb.stream && pb.stream !== "not-seen") {
    // Review run 37609765062: say which isolating arm ran (its table below) and which did not.
    const ranBg = blocks.some((b) => isOnImBg(b.block));
    const ranDa = blocks.some((b) => isOnHostawait(b.block));
    const ran = [
      ranBg ? "ON-im-bg (ON-im + simulator-server idle, spawned, no calls): Stream causality" : "",
      ranDa ? "ON-hostawait (ON-im with the host await algorithm): Await algorithm" : "",
    ].filter(Boolean);
    const missing = [
      ranBg ? "" : "`ON-im + simulator-server idle` (spawned, no calls)",
      ranDa ? "" : "a crossed-await arm",
    ].filter(Boolean);
    L.push(
      "- The stream opens at spawn with no client, so an upstream headless agent runs with it. " +
        "The guest is more loaded in OFF: read the CPU per phase table and the transition " +
        "timeline below, which is the under-load timeline of each arm. The probe alone does not " +
        "isolate the cause (the stream, the on-device helper `com.argent.androiddevtools` or " +
        "another component of the proprietary stack)." +
        (ran.length ? ` Isolating arms in this run (report only): ${ran.join("; ")} tables.` : "") +
        (missing.length
          ? ` The arms that would isolate it, not run here: ${missing.join(" and ")}.`
          : "")
    );
  }
  L.push("");

  const load = merged.loadByBlock || null;
  if (load) {
    L.push("### CPU per phase (10 s intervals)");
    L.push("");
    L.push(
      "qemu = the emulator process on the host; simulator-server = the proprietary host process " +
        "(0 when not running); com.argent.* = the on-device agents (open server, proprietary helper). " +
        "100 % = one core; p50 over the intervals that started and ended in the phase. " +
        `qemu vCPU threads = the qemu threads whose comm matches \`/${VCPU_COMM.source}/\` ` +
        "(unnamed threads inherit qemu-system-…, so the main loop counts here), qemu other " +
        "threads = the rest (GPU, gRPC, audio …), from /proc/<qemu>/task/*/stat. host idle / " +
        "steal / iowait = share of all host CPU time from /proc/stat (review run 37609765062 " +
        'Part A findings 3 and 6). "-" = not sampled (older run, or no /proc).'
    );
    L.push("");
    L.push(
      "| block | phase | intervals | qemu CPU % p50 | simulator-server CPU % p50 (alive) | com.argent.* CPU % p50 | by process p50 | qemu vCPU threads % p50 | qemu other threads % p50 | host idle % p50 | host steal % p50 | host iowait % p50 |"
    );
    L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const b of Object.keys(load)) {
      for (const [ph, r] of Object.entries(load[b])) {
        const p = (x) => (x ? fmt(x.p50) : "-");
        const by = Object.entries(r.argentByName || {})
          .map(([n, x]) => `${n.replace(/^com\.argent\./, "")} ${fmt(x.p50)}`)
          .join(", ");
        L.push(
          `| ${b} | ${ph} | ${r.intervals} | ${p(r.qemuCpuPct)} | ${p(r.simServerCpuPct)} ` +
            `(${r.simServerAliveIntervals}/${r.intervals}) | ${p(r.argentCpuPct)} | ${by || "-"} | ` +
            `${p(r.qemuVcpuCpuPct)} | ${p(r.qemuOtherCpuPct)} | ${p(r.hostIdlePct)} | ` +
            `${p(r.hostStealPct)} | ${p(r.hostIowaitPct)} |`
        );
      }
    }
    L.push("");
  }

  const tl = merged.transitionTimeline || null;
  if (tl && Object.keys(tl).length) {
    L.push("### Transition timeline per block (logcat, from the BENCH marker at each t0)");
    L.push("");
    L.push(
      "tap → first frame = the first `ActivityTaskManager: Displayed` after the marker; tap → " +
        "transition finished = the first OPEN `Finish Transition` created after it (before the next " +
        "marker, ≤ 5 s). Device clock on both ends. after finished = time-to-correct − tap → " +
        "finished per sample (the part attributable to the read)."
    );
    L.push("");
    L.push(
      "| block | verb | markers | tap → first frame p50/p95 (n) | tap → transition finished p50/p95 (n) | time-to-correct after finished p50 (n) |"
    );
    L.push("| --- | --- | --- | --- | --- | --- |");
    const pn = (x) => (x ? `${fmt(x.p50)}/${fmt(x.p95)} (${x.n})` : "-");
    for (const b of blocks) {
      const rows = tl[b.block];
      if (!rows) continue;
      for (const [vn, r] of Object.entries(rows))
        L.push(
          `| ${b.block} | ${vn} | ${r.markers} | ${pn(r.firstFrameMs)} | ${pn(r.finishedMs)} | ` +
            `${r.afterFinishTtcMs ? `${fmt(r.afterFinishTtcMs.p50)} (${r.afterFinishTtcMs.n})` : "-"} |`
        );
    }
    L.push("");
  }
}

// Phase 3n.1 promotion gates P2–P6. Review 2026-10-07 finding 5: ONE rule and ONE
// comparator, the table row AND the P line rendered from the same graded row.
//
// Review 2026-10-07 run 37591260027 ("Next run" + findings 3, 4, 7):
//  - ABBA, three blocks per main arm. With ≥ 2 blocks in both the candidate (ON-im-<n>)
//    and the current OFF arm, the PRIMARY CI of Δ uses the between-block variance: a
//    Welch t interval on the block p50s (stats.gradeFamilyBlocks), Δ = mean of the ON
//    block p50s − mean of the OFF block p50s, at the Holm-adjusted level, read against
//    the practical margin max(2 % of the pooled OFF p50, 1 ms). The within-block
//    bootstrap of the pooled samples is kept as a SECONDARY column (95 %, unadjusted).
//    A pre-ABBA run (one candidate block) keeps the within-block rule as its primary.
//  - P3/P4: the drained rows read "swipe+describe" / "pinch+describe" and the gesture
//    alone ("swipe (gesture only)", the noDrain samples) is gated with the same rule.
//    Both rows are reported; the promotion decision uses BOTH (PASS needs both).
//  - P5: pre-registered on the tap+await-idle+describe variant on both arms:
//    time-to-correct AND correct-at-first-read (higher is better; margin 10 pp). The
//    settle:false / settle:true variants are report only. No post-hoc row selection.
//  - Readings (finding 7): a CI that excludes zero with the point beyond the margin
//    reads "loss (within/at margin)" (NOT PASSED) or "win (within/at margin)" (PASS).
const offBlocks = blocks.filter((b) => isCurrentOff(b.block));
const imBlocks = blocks.filter((b) => isOnIm(b.block));
const onUia = blocks.find((b) => isOnUia(b.block)) || null;
const onIm = imBlocks[0] || null;
const blockLevel = offBlocks.length >= 2 && imBlocks.length >= 2;
// Pooled samples of an arm (null when any of its blocks lacks them).
const poolOf = (bs, get) => {
  const parts = bs.map(get);
  return parts.length && parts.every(Array.isArray) ? parts.flat() : null;
};
const noDrainOf = (b, vn) => {
  const v = verbOf(b, vn);
  return v && v.noDrain && Array.isArray(v.noDrain.latencySamples)
    ? v.noDrain.latencySamples
    : null;
};
const ttcOf = (b, vn) => {
  const v = verbOf(b, vn);
  return v ? ttcGateSamples(v.timeToCorrect) : null;
};
const ttcSamplesOf = (b, vn) => {
  const t = ttcOf(b, vn);
  return t ? t.samples : null;
};
const cafrOf = (b, vn) => {
  const v = verbOf(b, vn);
  const t = v && v.timeToCorrect;
  return t && t.measured ? { k: t.firstRead || 0, n: t.measured } : null;
};
const CAFR_MARGIN = 0.1;
const TTC_KEY = `${TD_GATED_VARIANT} time-to-correct`;
const CAFR_KEY = `${TD_GATED_VARIANT} correct-at-first-read`;
const latencyRow = (key, label, samples) => ({
  key,
  label,
  kind: "latency",
  samples,
  blockValue: (b) => {
    const s = samples(b);
    return s && s.length ? median(s) : null;
  },
});
const promoRows = [
  latencyRow("gesture-tap", "tap", (b) => samplesOf(b, "gesture-tap")),
  latencyRow("swipe+describe", "swipe + one describe", (b) => samplesOf(b, "gesture-swipe")),
  latencyRow("swipe (gesture only)", "swipe alone", (b) => noDrainOf(b, "gesture-swipe")),
  latencyRow("pinch+describe", "pinch + one describe", (b) => samplesOf(b, "gesture-pinch")),
  latencyRow("pinch (gesture only)", "pinch alone", (b) => noDrainOf(b, "gesture-pinch")),
  latencyRow(TTC_KEY, "time-to-correct", (b) => ttcSamplesOf(b, TD_GATED_VARIANT)),
  {
    key: CAFR_KEY,
    label: "correct at first read",
    kind: "rate",
    samples: () => null,
    blockValue: (b) => {
      const c = cafrOf(b, TD_GATED_VARIANT);
      return c ? c.k / c.n : null;
    },
  },
].filter(
  (r) =>
    imBlocks.some((b) => r.blockValue(b) != null) && offBlocks.some((b) => r.blockValue(b) != null)
);
const valuesOf = (bs, r) => bs.map((b) => r.blockValue(b)).filter((x) => x != null);
const pooledOffOf = (r) => poolOf(offBlocks, r.samples);
const pooledImOf = (r) => poolOf(imBlocks, r.samples);
const rateOf = (bs) => {
  const cs = bs.map((b) => cafrOf(b, TD_GATED_VARIANT)).filter(Boolean);
  const k = cs.reduce((s, c) => s + c.k, 0);
  const n = cs.reduce((s, c) => s + c.n, 0);
  return n ? { k, n } : null;
};
// Margins: block-level = practical; pre-ABBA = the OFF-1/OFF-2 equivalence margin.
const marginOfRow = (r) => {
  if (r.kind === "rate") return CAFR_MARGIN;
  if (blockLevel) return practicalMargin(pooledOffOf(r));
  const e = equivalenceMargin(r.samples(off1Blk), r.samples(off2Blk));
  return e ? e.margin : null;
};
if (onIm && offBlocks.length) {
  const graded = blockLevel
    ? gradeFamilyBlocks(
        promoRows.map((r) => ({
          key: r.key,
          a: valuesOf(imBlocks, r),
          b: valuesOf(offBlocks, r),
          margin: marginOfRow(r),
          higherIsBetter: r.kind === "rate",
          digits: r.kind === "rate" ? 3 : 1,
        }))
      )
    : gradeFamily(
        promoRows
          .filter((r) => r.kind === "latency")
          .map((r) => ({ key: r.key, a: pooledImOf(r), b: pooledOffOf(r), margin: marginOfRow(r) }))
      );
  // Pre-ABBA (one candidate block): the rate row is not in the within-block bootstrap
  // family; it is read on the Newcombe 95 % difference CI of the pooled counts (unadjusted).
  if (!blockLevel && promoRows.some((r) => r.key === CAFR_KEY)) {
    const a = rateOf(imBlocks),
      b = rateOf(offBlocks);
    if (a && b) {
      const d = Number((a.k / a.n - b.k / b.n).toFixed(3));
      const ci = newcombeDiffCI(a.k, a.n, b.k, b.n);
      const reading = ci ? readCI([-ci[1], -ci[0]], CAFR_MARGIN, -d) : "N/A";
      graded.push({
        key: CAFR_KEY,
        delta: d,
        margin: CAFR_MARGIN,
        m: null,
        p: null,
        rank: null,
        alpha: null,
        level: 0.95,
        ci,
        reading,
        holmStop: false,
        gate: gateOf(reading),
      });
    }
  }
  const rowOf = Object.fromEntries(graded.map((r) => [r.key, r]));
  // Secondary: the within-block CI (95 %, unadjusted) of the pooled samples; a rate row
  // uses the Newcombe difference CI of the pooled counts.
  const secondaryOf = (r) => {
    if (r.kind === "rate") {
      const a = rateOf(imBlocks),
        b = rateOf(offBlocks);
      if (!a || !b) return null;
      const d = Number((a.k / a.n - b.k / b.n).toFixed(3));
      const ci = newcombeDiffCI(a.k, a.n, b.k, b.n);
      return { delta: d, ci, reading: ci ? readCI([-ci[1], -ci[0]], CAFR_MARGIN, -d) : "N/A" };
    }
    const c = compareOnce(pooledImOf(r), pooledOffOf(r));
    return { ...c, reading: readCI(c.ci, marginOfRow(r), c.delta) };
  };
  const secondary = Object.fromEntries(promoRows.map((r) => [r.key, secondaryOf(r)]));
  const isRate = (key) => key === CAFR_KEY;
  const fmtV = (key, x) =>
    x == null ? "-" : isRate(key) ? `${Number((x * 100).toFixed(1))}%` : fmt(x);
  const marginCell = (r) =>
    r.margin == null ? "**N/A**" : isRate(r.key) ? `±${r.margin * 100} pp` : `±${r.margin}`;
  const holmCell = (r) =>
    r.alpha == null ? "-" : `α=${Number(r.alpha.toFixed(4))} (rank ${r.rank}/${r.m})`;
  const ciFmt = (key, ci) =>
    !ci
      ? "no samples"
      : isRate(key)
        ? `[${Number((ci[0] * 100).toFixed(1))}, ${Number((ci[1] * 100).toFixed(1))}] pp`
        : ciStr(ci);
  const ciCell = (r) => (r.ci ? `${ciFmt(r.key, r.ci)} @${pct(r.level)}` : "no samples");
  const readingCell = (r) => (r.holmStop ? `${r.reading} (Holm stop)` : r.reading);
  const deltaCell = (r) =>
    r.delta == null
      ? "-"
      : isRate(r.key)
        ? `${Number((r.delta * 100).toFixed(1))} pp`
        : fmt(r.delta);
  const blockVals = (bs, r) => bs.map((b) => fmtV(r.key, r.blockValue(b))).join(" / ");
  const method = blockLevel
    ? `block-level: Welch t on the block p50s (${imBlocks.length} ON-im vs ${offBlocks.length} OFF blocks)`
    : "within-block: bootstrap of the pooled samples (block-level variance not estimable: " +
      `${imBlocks.length} candidate block(s), ${offBlocks.length} OFF block(s))`;

  L.push(
    "### Promotion gates P2–P6 (ON-im vs the current proprietary OFF arm, CI vs margin, Holm)"
  );
  L.push("");
  L.push(`Primary CI: **${method}**. Secondary: within-block bootstrap (95 %, unadjusted).`);
  L.push("");
  L.push(
    "| row | ON-im block p50s | ON-uia | OFF block p50s | margin | Δ(ON-im − OFF) | Holm α | CI (primary) | reading | within-block Δ, 95% CI, reading (secondary) |"
  );
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const s of promoRows) {
    const r = rowOf[s.key] || {
      key: s.key,
      margin: marginOfRow(s),
      delta: null,
      alpha: null,
      ci: null,
      reading: "N/A",
      holmStop: false,
      gate: "N/A",
    };
    const sec = secondary[s.key];
    L.push(
      "| " +
        [
          s.key,
          blockVals(imBlocks, s),
          onUia ? fmtV(s.key, s.blockValue(onUia)) : "-",
          blockVals(offBlocks, s),
          marginCell(r),
          deltaCell(r),
          holmCell(r),
          ciCell(r),
          readingCell(r),
          sec
            ? `${isRate(s.key) ? `${Number((sec.delta * 100).toFixed(1))} pp` : fmt(sec.delta)}, ${ciFmt(s.key, sec.ci)}, ${sec.reading}`
            : "-",
        ].join(" | ") +
        " |"
    );
  }
  L.push("");

  // p95: report only (finding 4), unadjusted 95% CI on Δp95 of the pooled samples.
  L.push("p95 Δ (ON-im − pooled OFF), 95% bootstrap CI — report only, not gated:");
  L.push("");
  L.push("| row | Δp95 | 95% CI |");
  L.push("| --- | --- | --- |");
  for (const s of promoRows.filter((r) => r.kind === "latency")) {
    const c = compareOnce(pooledImOf(s), pooledOffOf(s), { p: 0.95 });
    L.push(`| ${s.key} | ${fmt(c.delta)} | ${ciStr(c.ci)} |`);
  }
  L.push("");

  // Report only (finding 4): every tap+describe variant per arm, pooled.
  const variantNames = TD_VARIANTS.filter((vn) => verbNames.includes(vn));
  if (variantNames.length) {
    L.push(
      "tap+describe variants, interleaved per sample in a seeded order on every block — " +
        `only ${TD_GATED_VARIANT} is gated (P5); the others are report only:`
    );
    L.push("");
    L.push(
      "| variant | arm | first read p50 (ms) | time-to-correct p50 (ms) | correct at first read | pre-transition/mixed | Δ time-to-correct (ON-im − OFF), 95% CI |"
    );
    L.push("| --- | --- | --- | --- | --- | --- | --- |");
    const arms = [
      ["ON-im", imBlocks],
      ["ON-uia", onUia ? [onUia] : []],
      ["OFF", offBlocks],
    ];
    for (const vn of variantNames) {
      const im = poolOf(imBlocks, (b) => ttcSamplesOf(b, vn));
      const off = poolOf(offBlocks, (b) => ttcSamplesOf(b, vn));
      const c = compareOnce(im, off);
      for (const [arm, bs] of arms) {
        if (!bs.length) continue;
        const first = poolOf(bs, (b) => samplesOf(b, vn));
        const ttc = poolOf(bs, (b) => ttcSamplesOf(b, vn));
        const cs = bs.map((b) => verbOf(b, vn)).filter((v) => v && v.timeToCorrect);
        const k = cs.reduce((s, v) => s + (v.timeToCorrect.firstRead || 0), 0);
        const n = cs.reduce((s, v) => s + (v.timeToCorrect.measured || 0), 0);
        const pt = cs.reduce(
          (s, v) =>
            s +
            ((v.destination &&
              v.destination.counts &&
              (v.destination.counts.preTransition ?? v.destination.counts.stale)) ||
              0),
          0
        );
        L.push(
          `| ${vn}${vn === TD_GATED_VARIANT ? " (gated, P5)" : ""} | ${arm} | ${fmt(first && first.length ? median(first) : null)} | ` +
            `${fmt(ttc && ttc.length ? median(ttc) : null)} | ${n ? `${k}/${n}` : "-"} | ${n ? `${pt}/${n}` : "-"} | ` +
            `${arm === "ON-im" ? `${fmt(c.delta)}, ${ciStr(c.ci)}` : ""} |`
        );
      }
    }
    L.push("");
  }

  // P lines: rendered from the SAME graded rows as the table above.
  const pline = (id, text, verdict) => L.push(`- **${id}** — ${text}: **${verdict}**`);
  const offP50 = (r) => {
    const s = promoRows.find((x) => x.key === r.key);
    const vals = s ? valuesOf(offBlocks, s) : [];
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const gateText = (r) => {
    const base = offP50(r);
    const rel =
      !isRate(r.key) && r.delta != null && base
        ? ` (${r.delta > 0 ? "+" : ""}${Number(((r.delta / base) * 100).toFixed(1))} % of OFF)`
        : "";
    return (
      `Δ ${deltaCell(r)}${rel}, CI ${r.ci ? ciCell(r) : "no samples"} ` +
      `${r.alpha == null ? "" : `(Holm ${holmCell(r)}) `}vs ${marginCell(r)} → reading ${readingCell(r)}`
    );
  };
  const notPassedText = (r) =>
    r && r.gate === "NOT PASSED" && r.delta != null
      ? ` — NOT PASSED: ON ${isRate(r.key) ? `${Math.abs(r.delta * 100).toFixed(1)} pp lower` : `${fmt(Math.abs(r.delta))} ms slower`}`
      : "";
  const combine = (gates) =>
    gates.some((g) => g === "N/A")
      ? "N/A"
      : gates.includes("FAIL")
        ? "FAIL"
        : gates.every((g) => g === "PASS")
          ? "PASS"
          : gates.includes("NOT PASSED")
            ? "NOT PASSED"
            : "INCONCLUSIVE";
  const gateOfKey = (key) => (rowOf[key] ? rowOf[key].gate : "N/A");
  const rowText = (key) =>
    rowOf[key]
      ? `${key}: ${gateText(rowOf[key])}${notPassedText(rowOf[key])} [${rowOf[key].gate}]`
      : `${key}: N/A`;
  {
    const r = rowOf["gesture-tap"];
    pline(
      "P2",
      r ? `tap (gesture-tap) ON-im vs OFF: ${gateText(r)}${notPassedText(r)}` : "tap: no samples",
      r ? r.gate : "N/A"
    );
  }
  for (const [id, a, b] of [
    ["P3", "swipe+describe", "swipe (gesture only)"],
    ["P4", "pinch+describe", "pinch (gesture only)"],
  ]) {
    const keys = [a, b].filter((k) => rowOf[k]);
    pline(
      id,
      `${keys.map(rowText).join("; ") || `${a}: N/A`}. Promotion decision: ` +
        (keys.length === 2
          ? `both rows (${a} AND ${b}); PASS needs both`
          : `${keys[0] || a} only (the gesture-only samples are absent in this run)`),
      combine(keys.length ? keys.map(gateOfKey) : ["N/A"])
    );
  }
  {
    const label =
      `pre-registered on ${TD_GATED_VARIANT} on both arms (tap → await-screen-idle → describe): ` +
      "time-to-correct AND correct-at-first-read (margin ±10 pp, higher is better)";
    if (!rowOf[TTC_KEY]) {
      pline("P5", `${label}: no ${TD_GATED_VARIANT} samples in this run`, "N/A");
    } else {
      const imT = imBlocks.map((b) => ttcOf(b, TD_GATED_VARIANT)).filter(Boolean);
      const offT = offBlocks.map((b) => ttcOf(b, TD_GATED_VARIANT)).filter(Boolean);
      const to = (ts) => ts.reduce((s, t) => s + t.timedOut, 0);
      const nOf = (ts) => ts.reduce((s, t) => s + t.samples.length, 0);
      const timedOut = to(imT) + to(offT);
      let verdict = combine([gateOfKey(TTC_KEY), gateOfKey(CAFR_KEY)]);
      if (verdict === "PASS" && timedOut > 0) verdict = "INCONCLUSIVE";
      pline(
        "P5",
        `${label}: ${rowText(TTC_KEY)}; ${rowText(CAFR_KEY)}; timed out: ON-im ${to(imT)}/${nOf(imT)}, ` +
          `OFF ${to(offT)}/${nOf(offT)}` +
          (timedOut > 0 ? " (entered at the give-up time, a lower bound: no PASS on it)" : ""),
        verdict
      );
    }
  }
  // P6: ON-im vs the ON-uia control, within-block (the control is one block), at the
  // NULL margin of that pair (stats.pooledNullMargin), Holm across the latency rows.
  {
    const label =
      "ON-im vs ON-uia (control), within-block CI vs the pair's pooled null margin, Holm";
    const latRows = promoRows.filter((r) => r.kind === "latency");
    if (!onUia || !latRows.length) {
      pline("P6", label, "N/A");
    } else {
      const p6 = gradeFamily(
        latRows.map((s) => ({
          key: s.key,
          a: pooledImOf(s),
          b: s.samples(onUia),
          margin: pooledNullMargin(pooledImOf(s), s.samples(onUia)),
        }))
      );
      L.push("");
      L.push(
        "| P6 row | ON-im (pooled) | ON-uia | null margin | Δ(im−uia) | Holm α | CI | reading |"
      );
      L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
      for (const r of p6) {
        const s = latRows.find((x) => x.key === r.key);
        const im = pooledImOf(s);
        L.push(
          `| ${r.key} | ${fmt(im && im.length ? median(im) : null)} | ${fmt(s.blockValue(onUia))} | ${marginCell(r)} | ` +
            `${fmt(r.delta)} | ${holmCell(r)} | ${ciCell(r)} | ${readingCell(r)} |`
        );
      }
      L.push("");
      const gates = p6.map((r) => r.gate);
      const verdict = !p6.length
        ? "N/A"
        : gates.includes("FAIL")
          ? "FAIL"
          : gates.includes("INCONCLUSIVE") || gates.includes("NOT PASSED")
            ? "INCONCLUSIVE"
            : gates.includes("N/A")
              ? "N/A"
              : "PASS";
      const bad = p6.filter((r) => r.gate !== "PASS").map((r) => `${r.key} ${readingCell(r)}`);
      pline("P6", `${label}${bad.length ? ` (${bad.join(", ")})` : ""}`, verdict);
    }
  }
  // P7 fallback count from the block's echo.
  for (const b of imBlocks)
    if (b.injectStrategyReported)
      L.push(`- **P7 echo** — ${b.block} \`injectStrategyReported\`: ${b.injectStrategyReported}`);
  // Phase 3n.3 (3N2-H1/M6) + review 2026-10-07 finding 3: Q4 equality per candidate block.
  for (const b of imBlocks) {
    if (!b.injectStrategyCounts) continue;
    const c = b.injectStrategyCounts;
    const total =
      b.injectStrategyTotal != null
        ? b.injectStrategyTotal
        : Object.values(c).reduce((s, n) => s + n, 0);
    const unavail = c.unavailable || 0;
    const measured = b.measuredInjectRpcs;
    const expected = b.expectedInjectRpcs;
    const imN = c["input-manager"] || 0;
    L.push(
      `- **Q4 equality** — ${b.block} on-device \`injectStrategyCounts["input-manager"]\` = **${imN}** == expected ` +
        (expected == null
          ? "**?** (no expectedInjectRpcs in the block): **N/A**"
          : `**${expected}** (gesture tool calls the bench issued in the block): ` +
            `**${imN === expected && total === expected && unavail === 0 ? "PASS" : "FAIL"}**`)
    );
    L.push(
      `- **Q4 fallbacks (on-device)** — ${b.block} \`injectStrategyCounts.unavailable\` = **${unavail}/${total}** ` +
        `(counts ${JSON.stringify(c)}) — the authoritative fallback signal; the host \`fastInject\` ` +
        `counter was removed in 3n.2 and is not evidence (3N2-H1).` +
        (measured != null
          ? ` Measured gated-inject RPCs (Q4 denominator) = **${measured}** of ${total} process-wide ` +
            `(the remainder is warmups + oracle self-test + describe-split + locate/restore taps).`
          : "")
    );
  }
  L.push("");
  // Method footer: how every number above was produced.
  const m = graded.filter((r) => r.alpha != null).length;
  L.push(
    "_Method (review 2026-10-07 findings 4/5; run 37591260027 next-run design). Timing: " +
      "`performance.now()`, float ms. p50 = the true median (linear-interpolation quantile from " +
      "`.github/bench-ci/stats.js`, shared by the bench script, the merge and this scoreboard). " +
      (blockLevel
        ? "Primary CI: Welch t interval on the block p50s (one value per block; Δ = mean of the " +
          "ON-im block p50s − mean of the OFF block p50s; between-block variance, Welch–" +
          "Satterthwaite df), at the Holm-adjusted level. Margin: max(2 % of the pooled OFF p50, " +
          "1 ms) for latency rows (the between-block noise is already in the CI), ±10 pp for " +
          "correct-at-first-read (higher is better). Secondary: the within-block bootstrap of the " +
          "pooled samples (seeded, 10 000 draws, 95 %, unadjusted). "
        : "Primary CI (pre-ABBA, one candidate block): seeded 10 000-draw percentile bootstrap of " +
          "Δ = p50(ON) − p50(OFF-1 ∪ OFF-2); margin = max(bootstrap OFF-1↔OFF-2 drift margin, 2 % of " +
          "the pooled OFF p50, 1 ms). ") +
      "Reading: win if CI upper < −margin, loss if CI lower > +margin, parity if the whole CI " +
      "lies inside ±margin; a CI that excludes zero with the point beyond the margin reads " +
      "loss (within/at margin) (NOT PASSED) or win (within/at margin) (PASS: no value in the CI " +
      "is worse); otherwise inconclusive. Holm across the m = " +
      m +
      " gated rows: rows are ranked by the p-value of this rule (the smallest α at which the CI " +
      "reads win, loss or parity); the row at rank k uses α_k = 0.05 / (m − k + 1); after the " +
      "first row that does not settle its margin hypothesis every later row is retained as " +
      "inconclusive (Holm stop). P6 uses the null margin of its own pair, within-block (the " +
      "control is one block). p95 Δ is report only._"
  );
  L.push("");
  L.push(
    `_tap+describe (run 37591260027 finding 4): every block runs ${TD_VARIANTS.join(", ")}, one ` +
      "per sample in a seeded random order; P5 is pre-registered on " +
      `${TD_GATED_VARIANT} on both arms (time-to-correct AND correct-at-first-read); the ` +
      "other variants are report only. The proprietary describe ignores `settle`, so on OFF " +
      "the two settle variants are the same call. " +
      PRE_TRANSITION_NOTE +
      "_"
  );
  L.push("");
  L.push(
    blockLevel
      ? `_Block-level variance captured: ${imBlocks.length} ON-im and ${offBlocks.length} OFF blocks (interleaved ABBA). ` +
          "Scope: swiftshader on a 4-vCPU hosted runner; the promotion decision (P0–P7 + P9 + P10) is the planner's._"
      : "_Not captured: block-level variance — one candidate block, so every CI is within-block " +
          "resampling and the OFF-1↔OFF-2 margin is the only between-block signal; the " +
          "interleaved ABBA design (≥ 3 blocks per arm) captures it. The promotion decision " +
          "(P0–P7 + P9 + P10) is the planner's, from these numbers._"
  );
  L.push("");
  if (!blockLevel) {
    L.push(`_${EQUIV_FOOTER} (run 37561512651, Review 2026-10-07)._`);
    L.push("");
  }
}

// Review run 37609765062 (Part A findings 5 and 6; "Follow-ups" 1): the diagnostic arms,
// each one block, report only, compared with the block of the reference arm nearest in
// the run order (block start times; the merged block order otherwise). Δ = arm p50 −
// reference p50 with a seeded within-block bootstrap CI (no between-block variance).
{
  const diag = merged.diagnosticArms || {};
  const tlAll = merged.transitionTimeline || {};
  const startedAt = merged.blockStartedAt || {};
  const ranOrder = merged.blocksRan || blocks.map((b) => b.block);
  const pos = (n) => {
    const useTimes = ranOrder.every((x) => startedAt[x]);
    return useTimes ? Date.parse(startedAt[n]) : ranOrder.indexOf(n);
  };
  const nearestOf = (name, cands) =>
    cands
      .map((b) => b.block)
      .sort(
        (x, y) => Math.abs(pos(x) - pos(name)) - Math.abs(pos(y) - pos(name)) || pos(x) - pos(y)
      )[0] || null;
  const tlSamples = (n, key) =>
    Object.values(tlAll[n] || {}).flatMap((r) =>
      ((key === "ff" ? r.firstFrameSamples : r.finishedSamples) || []).map((x) => x.ms)
    );
  const ttcOfBlock = (n) => {
    const v = verbOf(
      blocks.find((b) => b.block === n),
      TD_GATED_VARIANT
    );
    const g = v ? ttcGateSamples(v.timeToCorrect) : null;
    return g ? g.samples : null;
  };
  const METRICS = {
    ff: ["tap → first frame (logcat)", (n) => tlSamples(n, "ff")],
    fin: ["tap → transition finished (logcat)", (n) => tlSamples(n, "fin")],
    ttc: [`time-to-correct (${TD_GATED_VARIANT})`, ttcOfBlock],
    floor: [
      "await floor (await-screen-idle, still screen)",
      (n) =>
        samplesOf(
          blocks.find((b) => b.block === n),
          "await-screen-idle"
        ),
    ],
  };
  const section = (title, armName, refArm, refBlocks, metricKeys, intro) => {
    if (!blocks.some((b) => b.block === armName) && !diag[armName]) return;
    const d = diag[armName] || { invalid: false, invalidReasons: [] };
    if (d.invalid) {
      L.push(`### ${title} — INVALID`);
      L.push("");
      L.push(
        `${armName} is not a valid arm this run (its table only; the main arms are unaffected):`
      );
      L.push("");
      for (const why of d.invalidReasons || []) L.push(`- ${why}`);
      L.push("");
      return;
    }
    const ref = nearestOf(armName, refBlocks);
    L.push(`### ${title} — 1 block each; report only`);
    L.push("");
    L.push(
      intro +
        (d.simServerAlive ? ` simulator-server alive in ${d.simServerAlive} load samples.` : "")
    );
    L.push("");
    if (!ref) {
      L.push(`_No ${refArm} block in this run: nothing to compare._`);
      L.push("");
      return;
    }
    L.push(
      "| metric | reference block | reference p50 (n) | arm block | arm p50 (n) | Δ (arm − reference) | 95% CI (within-block bootstrap) |"
    );
    L.push("| --- | --- | --- | --- | --- | --- | --- |");
    const cell = (xs) => (xs && xs.length ? `${fmt(median(xs))} (${xs.length})` : "-");
    for (const k of metricKeys) {
      const [label, get] = METRICS[k];
      const a = get(armName);
      const r = get(ref);
      const c = compareOnce(a && a.length ? a : null, r && r.length ? r : null);
      L.push(
        `| ${label} | ${ref} | ${cell(r)} | ${armName} | ${cell(a)} | ${fmt(c.delta)} | ${ciStr(c.ci)} |`
      );
    }
    L.push("");
  };
  section(
    "Stream causality (ON-im vs ON-im-bg)",
    "ON-im-bg",
    "ON-im",
    blocks.filter((b) => isOnIm(b.block)),
    ["ff", "fin", "ttc"],
    "ON-im-bg = an ON-im block (open server, input-manager) with the proprietary " +
      "`simulator-server android --id <serial>` spawned idle for the whole block (the PROBE-BG " +
      "window B spawn, no calls; its screen stream opens at spawn) and killed at the end. " +
      "Reference = the ON-im block nearest in the run order. If tap → first frame moves from the " +
      "ON-im level (~370 ms in run 37609765062) towards the OFF level (~700 ms), the stream causes " +
      "the slower guest under the proprietary stack (review run 37609765062 Part A finding 6). " +
      "Changes: one host process (simulator-server, with its emulator gRPC screen stream). Does " +
      "not change: the open server, input-manager input, describe and the device await; the " +
      "on-device helper com.argent.androiddevtools is NOT started, so this arm cannot implicate it."
  );
  section(
    "Await algorithm (ON-im vs ON-hostawait)",
    "ON-hostawait",
    "ON-im",
    blocks.filter((b) => isOnIm(b.block)),
    ["ttc", "floor"],
    "ON-hostawait = an ON-im block whose await in " +
      `${TD_GATED_VARIANT} and whose await-screen-idle verb run the tool's HOST algorithm (poll ` +
      "every 200 ms, 250 ms stable window, the tool's timeout and tree-equality rule) over " +
      "open-server state reads, after the same uncached Android-TV probe the tool pays, instead " +
      "of the on-device AX-event await. Reference = the ON-im block nearest in the run order. " +
      "Changes: only the await algorithm (and its reads: one getState per poll instead of " +
      "awaitChange). Does not change: the stack (open server, input-manager input, describe, no " +
      "proprietary process), so Δ is the algorithm's share of P5 on the ON stack (review run " +
      "37609765062 Part A finding 5); it does not say how the host algorithm behaves on the " +
      "proprietary stack. It replaced OFF-devawait (review round 1: two UiAutomation clients)."
  );

  // P5 decomposition (merged.p5Decomposition): time-to-correct p50 by term, per arm.
  const dec = merged.p5Decomposition || null;
  if (dec && (dec.arms || []).length) {
    L.push("### P5 decomposition — time-to-correct p50 by term (report only, no gate)");
    L.push("");
    L.push(
      `${dec.variant}: time-to-correct p50 = tap → transition finished (logcat, device clock) + ` +
        "await floor (await-screen-idle on a still screen) + describe p50 (idle) + rest. Each term " +
        "is the mean of the arm's block values; rest closes the sum (it mixes the host and device " +
        "clocks and holds what the await waits after the transition). Share of time-to-correct in " +
        "brackets (review run 37609765062 Part A finding 5)."
    );
    L.push("");
    L.push(
      "| arm | blocks | time-to-correct p50 | tap → transition finished (logcat) | await floor (await-screen-idle, still screen) | describe p50 | rest |"
    );
    L.push("| --- | --- | --- | --- | --- | --- | --- |");
    const termCell = (x, f) =>
      x == null ? "-" : `${fmt(x)} (${f == null ? "-" : `${Number((f * 100).toFixed(1))}%`})`;
    for (const a of dec.arms)
      L.push(
        `| ${a.arm} | ${a.blocks.join(", ")} | ${fmt(a.timeToCorrectMs)} | ` +
          `${termCell(a.transitionFinishedMs, a.fractions.transitionFinished)} | ` +
          `${termCell(a.awaitFloorMs, a.fractions.awaitFloor)} | ` +
          `${termCell(a.describeMs, a.fractions.describe)} | ${termCell(a.restMs, a.fractions.rest)} |`
      );
    L.push("");
  }
}

// Effect-check + tap-timeline parity (phase 3h) — the taps actually landed and the
// injected shape was as intended.
// Print zero/checked, never the numerator alone (phase 3h review A2, fix a): a
// block that checked NOTHING (0/0) rendered "0" here and passed vacuously. The gate
// now requires every tap block to have ARMED the oracle (checked > 0) AND landed
// every tap (zero === 0). `effectByBlock` carries {effectZero, effectChecked}.
const eb = merged.effectByBlock || {};
const ez = merged.effectZeroByBlock; // legacy fallback for the block-key list
const effKeys = Object.keys(eb).length ? Object.keys(eb) : ez ? Object.keys(ez) : [];
if (effKeys.length) {
  L.push("### tap first-attempt landing & timeline parity (phase 3h)");
  L.push("");
  L.push(
    "| block | firstTapLanding (landed/checked) | rate | oracle self-test | transport | tap frames | MOVE |"
  );
  L.push("| --- | --- | --- | --- | --- | --- | --- |");
  const tt = merged.tapTimelines || {};
  const rate = (e) => {
    const c = e.effectChecked || 0;
    if (!c) return null;
    const miss = e.firstTapNoEffect != null ? e.firstTapNoEffect : e.effectZero || 0;
    return (c - miss) / c;
  };
  for (const b of blocks) {
    const tl = tt[b.block];
    const e = eb[b.block] || { effectZero: ez ? ez[b.block] : undefined, effectChecked: undefined };
    const c = e.effectChecked;
    const miss = e.firstTapNoEffect != null ? e.firstTapNoEffect : e.effectZero;
    const cell = c === undefined ? "-" : `${c - (miss ?? 0)}/${c}`;
    const r = rate(e);
    const self = c === undefined ? "-" : e.oracleSelfTestPassed === false ? "FAILED" : "pass";
    L.push(
      `| ${b.block} | ${cell} | ${r === null ? "-" : (r * 100).toFixed(1) + "%"} | ${self} | ${e.transport ?? "-"} | ${tl ? tl.frameCount : "-"} | ${tl ? (tl.hasMoveFrame ? "yes" : "no") : "-"} |`
    );
  }
  // Symmetric first-attempt LANDING-RATE gate (team-lead run-6 decision): every tap
  // block must be armed (checked > 0), pass the oracle self-test, and land >= 95% of
  // its first-attempt taps (catches a tap that never lands, not a 1-2% async drop).
  const tapBlocks = Object.values(eb).filter((e) => e && e.effectChecked !== undefined);
  const armed = tapBlocks.length > 0 && tapBlocks.every((e) => (e.effectChecked || 0) > 0);
  const landOk = tapBlocks.every((e) => {
    const r = rate(e);
    return r === null || r >= 0.95;
  });
  const selfOk = tapBlocks.every((e) => e.oracleSelfTestPassed !== false);
  const pass = armed && landOk && selfOk;
  L.push("");
  L.push(
    `- first-attempt landing gate (every tap block armed, oracle self-test passed, landing rate >= 95%): **${pass ? "PASS" : "FAIL"}**` +
      (tapBlocks.length ? "" : " (no tap block reported effect counts)")
  );
  L.push("");
}

// Locate source per block (review F5) + no-effect diagnostics (review F7). The
// per-iteration untimed locate is NOT backend-independent: its primary source, a
// `uiautomator dump` file, is unusable while a backend holds UiAutomation, so it
// falls through to the block's OWN backend describe. Only the effect FINGERPRINT
// (mResumedActivity via dumpsys) is backend-independent. Print the split so the
// asymmetry is visible, and surface any first-attempt no-effect tap's identity.
if (blocks.some((b) => b.locateViaTotal || (b.noEffectSamples && b.noEffectSamples.length))) {
  L.push("### Locate source & no-effect taps (F5 / F7)");
  L.push("");
  L.push(
    "Locate is per-backend (dump primary, backend-describe fallback); only the effect fingerprint (`mResumedActivity`) is backend-independent."
  );
  L.push("");
  L.push("| block | locate dump/describe | first-attempt no-effect |");
  L.push("| --- | --- | --- |");
  for (const b of blocks) {
    const lv = b.locateViaTotal;
    const via = lv ? `${lv.dump}/${lv.describe}` : "-";
    const ne =
      b.noEffectSamples && b.noEffectSamples.length ? String(b.noEffectSamples.length) : "0";
    L.push(`| ${b.block} | ${via} | ${ne} |`);
  }
  L.push("");
  const withMisses = blocks.filter((b) => b.noEffectSamples && b.noEffectSamples.length);
  if (withMisses.length) {
    L.push("First-attempt no-effect tap identities (F7):");
    L.push("");
    for (const b of withMisses) {
      for (const s of b.noEffectSamples) L.push(`- **${b.block}** ${s}`);
    }
    L.push("");
  }
}

// Notes
L.push("### Notes per block");
L.push("");
for (const b of blocks) {
  if (b.notes && b.notes.length) {
    L.push(`**${b.block}**`);
    for (const n of b.notes) L.push(`- ${n}`);
    L.push("");
  }
}

// Phase 3n.2: the Fling A/B section was removed with scrcpy. The fling metric is
// instrument-unresolved and deferred to ticket 3o (metric repair); no fling artifact
// is produced by this run and none is rendered here.

// Phase 3j: serialize-once + compact in-run A/B and the transport experiment.
// Defensive — only rendered for ON blocks that carry a `phase3j` object.
const p50p95 = (st) =>
  st && st.p50 !== null && st.p50 !== undefined ? `${st.p50}/${st.p95 ?? "?"}` : "-";
const on3j = blocks.filter((b) => b.phase3j);
if (on3j.length) {
  L.push("### Phase 3j — serialize-once + compact (before | after, p50/p95)");
  L.push("");
  for (const b of on3j) {
    const p = b.phase3j;
    L.push(`**${b.block}**`);
    L.push("");
    L.push("| metric | serialize legacy | serialize once | compact off | compact on |");
    L.push("| --- | --- | --- | --- | --- |");
    const el = p.encodeLegacy,
      eo = p.encodeOnce,
      co = p.compactOff,
      cn = p.compactOn;
    L.push(
      `| server handleMs (t3-t2) | ${p50p95(el?.serverHandleMs)} | ${p50p95(eo?.serverHandleMs)} | ${p50p95(co?.serverHandleMs)} | ${p50p95(cn?.serverHandleMs)} |`
    );
    L.push(
      `| server encodeMs | ${p50p95(el?.serverEncodeMs)} | ${p50p95(eo?.serverEncodeMs)} | ${p50p95(co?.serverEncodeMs)} | ${p50p95(cn?.serverEncodeMs)} |`
    );
    L.push(
      `| wireBytes | ${p50p95(el?.wireBytes)} | ${p50p95(eo?.wireBytes)} | ${p50p95(co?.wireBytes)} | ${p50p95(cn?.wireBytes)} |`
    );
    L.push(
      `| hostRttMs | ${p50p95(el?.hostRttMs)} | ${p50p95(eo?.hostRttMs)} | ${p50p95(co?.hostRttMs)} | ${p50p95(cn?.hostRttMs)} |`
    );
    L.push("");
    if (p.transport && p.transport.arms) {
      L.push(
        `Transport experiment (N per arm; pad target ${p.transport.paddingTarget}B) — rttMs / recvMs / wireB p50/p95:`
      );
      L.push("");
      L.push("| arm | rttMs | recvMs | wireB | note |");
      L.push("| --- | --- | --- | --- | --- |");
      for (const a of p.transport.arms) {
        const note = (a.available ? "" : "N/A: ") + (a.note || "");
        L.push(
          `| ${a.label} | ${p50p95(a.rtt)} | ${p50p95(a.recv)} | ${p50p95(a.wire)} | ${note.replace(/\|/g, "\\|")} |`
        );
      }
      L.push("");
    }
  }
}

L.push(`_merged: ${path.basename(mergedPath)}_`);

process.stdout.write(L.join("\n") + "\n");
// Finding 6: an INVALID run fails the scoreboard step (and so the job).
if (runInvalid) {
  process.stderr.write(
    "latency run INVALID: " +
      [
        ...(merged.invalidBlocks || []).map((x) => `${x.block}: ${(x.reasons || []).join("; ")}`),
        ...(merged.runInvalidReasons || []),
      ].join(" | ") +
      "\n"
  );
  process.exit(1);
}
