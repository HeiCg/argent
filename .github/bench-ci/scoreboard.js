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
  compareOnce,
} = require("./stats");

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
const verbLabel = (vn) => (isHostAlgo(vn) ? `${vn} (host algorithm)` : vn);

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
const pooledOffSamplesOf = (vn) => {
  const a = samplesOf(off1Blk, vn),
    b = samplesOf(off2Blk, vn);
  if (off1Blk && off2Blk) return a && b ? a.concat(b) : null;
  return a || b;
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
  L.push("### Gesture drain — swipe/pinch timed as gesture + one draining read");
  L.push("");
  L.push(
    `Timed window = gesture + \`${read}\` on every arm (the read the headline tap row uses; ` +
      "it drains a queued async final UP). no-drain = the gesture call alone, same iterations."
  );
  L.push("");
  L.push("| verb | block | gesture + drain p50/p95 | no-drain p50/p95 |");
  L.push("| --- | --- | --- | --- |");
  for (const { vn, b, v } of drainRows) {
    const nd = v.noDrain.latency || {};
    L.push(
      `| ${vn} | ${b.block} | ${fmt(v.latency.p50)}/${fmt(v.latency.p95)} | ${fmt(nd.p50)}/${fmt(nd.p95)} |`
    );
  }
  L.push("");
}

// Run 37561512651 / Review 2026-10-07: per verb, the open-server fallback lines (now
// counted at console.debug, console.warn and console.error) and the timed samples whose
// describe came back empty (`treeEmpty`: the open server's marker on ON, 0 elements on
// OFF; any one makes the block INVALID). Per block, the Settings reset wait (resumed +
// focused + not finishing + stable pid after am start). Older artifacts carry neither.
const hasTreeEmpty = blocks.some((b) => (b.verbs || []).some((v) => v.treeEmpty != null));
const hasResetWait = blocks.some((b) => b.resetWait);
if (hasTreeEmpty || hasResetWait) {
  L.push("### Fallbacks, empty trees and resets");
  L.push("");
  if (hasTreeEmpty) {
    L.push(
      "treeEmpty = timed samples whose describe returned an empty tree (ON: the open " +
        "server's `treeEmpty`; OFF: 0 elements). Any treeEmpty or ON fallback invalidates the block."
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
        "and on the same pid over two reads (bounded at 5 s; relaunched if it was killed)."
    );
    L.push("");
    L.push("| block | resets | resetWaitMs mean | resetWaitMs max | timeouts | relaunches |");
    L.push("| --- | --- | --- | --- | --- | --- |");
    for (const b of blocks) {
      const r = b.resetWait;
      if (!r) continue;
      L.push(
        `| ${b.block} | ${r.n} | ${fmt(r.meanMs)} | ${fmt(r.maxMs)} | ${r.timeouts} | ${r.relaunches} |`
      );
    }
    L.push("");
  }
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

// Phase 3n.1 promotion gates P2–P6. Review 2026-10-07 finding 5: ONE rule and ONE
// comparator. Every gated verb is ON-input-manager vs the pooled OFF-1+OFF-2 samples;
// the family (tap, swipe, pinch, tap+describe) is graded once by stats.gradeFamily
// (CI at the Holm-adjusted level vs ±margin) and the table row AND the P line are
// rendered from that same row object. win/parity PASS, loss FAIL, inconclusive
// INCONCLUSIVE (not a pass, distinct from FAIL). The min/max(OFF) point inequalities
// are retired. ON-uiautomation is the control (P6), graded the same way at the null
// margin of its own pair.
const onUia = blocks.find((b) => b.block === "ON-uiautomation");
const onIm = blocks.find((b) => b.block === "ON-input-manager");
if (onIm && off1Blk && off2Blk) {
  // comparator verb name in the OFF blocks (tap+describe(settle:false) → tap+describe).
  const offVerb = (vn) => (vn === "tap+describe(settle:false)" ? "tap+describe" : vn);
  const gatedVerbs = [
    "gesture-tap",
    "gesture-swipe",
    "gesture-pinch",
    "tap+describe(settle:false)",
  ].filter((vn) => verbNames.includes(vn));
  const family = gradeFamily(
    gatedVerbs.map((vn) => ({
      key: vn,
      a: samplesOf(onIm, vn),
      b: pooledOffSamplesOf(offVerb(vn)),
      margin: offMargin(offVerb(vn)),
    }))
  );
  const rowOf = Object.fromEntries(family.map((r) => [r.key, r]));
  const marginCell = (r) => (r.margin == null ? "**N/A**" : `±${r.margin}`);
  const holmCell = (r) =>
    r.alpha == null ? "-" : `α=${Number(r.alpha.toFixed(4))} (rank ${r.rank}/${r.m})`;
  const ciCell = (r) => (r.ci ? `${ciStr(r.ci)} @${pct(r.level)}` : "no samples");
  const readingCell = (r) => (r.holmStop ? `${r.reading} (Holm stop)` : r.reading);

  L.push(
    "### Promotion gates P2–P6 (ON-input-manager vs pooled PROPRIETARY OFF, bootstrap CI vs equivalence margin, Holm)"
  );
  L.push("");
  L.push(
    "| verb | ON-uiautomation | ON-input-manager | OFF-1 | OFF-2 | drift | margin | Δ(im−pooledOFF) | Holm α | CI | reading |"
  );
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const vn of gatedVerbs) {
    const r = rowOf[vn];
    L.push(
      "| " +
        [
          vn,
          fmt(p50Of(onUia, vn)),
          fmt(p50Of(onIm, vn)),
          fmt(p50Of(off1Blk, offVerb(vn))),
          fmt(p50Of(off2Blk, offVerb(vn))),
          fmt(drift(offVerb(vn))),
          marginCell(r),
          fmt(r.delta),
          holmCell(r),
          ciCell(r),
          readingCell(r),
        ].join(" | ") +
        " |"
    );
  }
  L.push("");

  // p95: report only (finding 4), unadjusted 95% CI on Δp95, never a gate.
  L.push("p95 Δ (ON-input-manager − pooled OFF), 95% bootstrap CI — report only, not gated:");
  L.push("");
  L.push("| verb | Δp95 | 95% CI |");
  L.push("| --- | --- | --- |");
  for (const vn of gatedVerbs) {
    const c = compareOnce(samplesOf(onIm, vn), pooledOffSamplesOf(offVerb(vn)), { p: 0.95 });
    L.push(`| ${vn} | ${fmt(c.delta)} | ${ciStr(c.ci)} |`);
  }
  L.push("");

  // P lines: rendered from the SAME family rows as the table above.
  const pline = (id, text, verdict) => L.push(`- **${id}** — ${text}: **${verdict}**`);
  const gateText = (r) =>
    `Δ ${fmt(r.delta)} ms, CI ${r.ci ? ciCell(r) : "no samples"} ${r.alpha == null ? "" : `(Holm ${holmCell(r)}) `}` +
    `vs ${marginCell(r)} → reading ${readingCell(r)}`;
  const pGate = (id, label, vn) => {
    const r = rowOf[vn];
    if (!r) return pline(id, `${label} (${vn}) ON-input-manager vs pooled OFF`, "N/A");
    pline(id, `${label} (${vn}) ON-input-manager vs pooled OFF: ${gateText(r)}`, r.gate);
  };
  pGate("P2", "tap", "gesture-tap");
  pGate("P3", "swipe", "gesture-swipe");
  pGate("P4", "pinch", "gesture-pinch");
  // P5: the headline ratio ≤ 1.15 vs each of OFF-1, OFF-2 and pooled, AND the headline
  // row's CI reading. PASS needs both; FAIL on a failed ratio or a loss; otherwise
  // INCONCLUSIVE (a 1.14x slower headline with a wide CI no longer passes).
  {
    const hv = "tap+describe(settle:false)";
    const im = p50Of(onIm, hv);
    const pooledS = pooledOffSamplesOf("tap+describe");
    const imS = samplesOf(onIm, hv);
    const o1 = p50Of(off1Blk, "tap+describe"),
      o2 = p50Of(off2Blk, "tap+describe");
    const po = pooledS ? median(pooledS) : o1 != null && o2 != null ? (o1 + o2) / 2 : null;
    const imP = imS ? median(imS) : im;
    const ratios = [
      [im, o1],
      [im, o2],
      [imP, po],
    ].map(([a, d]) => (a != null && d != null && d > 0 ? a / d : null));
    const anyNa = ratios.some((r) => r == null);
    const ratioOk = !anyNa && ratios.every((r) => r <= 1.15);
    const r = rowOf[hv];
    const reading = r ? r.reading : "N/A";
    const ciGate = gateOf(reading);
    const verdict =
      anyNa || ciGate === "N/A"
        ? "N/A"
        : !ratioOk || ciGate === "FAIL"
          ? "FAIL"
          : ciGate === "PASS"
            ? "PASS"
            : "INCONCLUSIVE";
    pline(
      "P5",
      `headline ${hv} ÷ OFF tap+describe ≤ 1.15 vs each OFF-1/OFF-2/pooled ` +
        `(${ratios.map((x) => (x == null ? "-" : x.toFixed(2))).join(" / ")}): ratio ${anyNa ? "N/A" : ratioOk ? "PASS" : "FAIL"}; ` +
        `CI reading ${reading}${r && r.ci ? ` (${gateText(r)})` : ""}`,
      verdict
    );
  }
  // P6: ON-input-manager vs the ON-uiautomation control, same rule and Holm across the
  // gated verbs, at the NULL margin of that pair (stats.pooledNullMargin: both arms
  // recentred on their medians, residuals pooled), not the OFF drift margin. FAIL on any loss; INCONCLUSIVE if no
  // loss but any verb is inconclusive; PASS when every verb is win or parity.
  {
    const label =
      "ON-input-manager vs ON-uiautomation (control), CI vs the pair's pooled null margin, Holm";
    if (!onUia) {
      pline("P6", label, "N/A");
    } else {
      const p6 = gradeFamily(
        gatedVerbs.map((vn) => ({
          key: vn,
          a: samplesOf(onIm, vn),
          b: samplesOf(onUia, vn),
          margin: pooledNullMargin(samplesOf(onIm, vn), samplesOf(onUia, vn)),
        }))
      );
      L.push("");
      L.push(
        "| P6 verb | ON-input-manager | ON-uiautomation | null margin | Δ(im−uia) | Holm α | CI | reading |"
      );
      L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
      for (const r of p6)
        L.push(
          `| ${r.key} | ${fmt(p50Of(onIm, r.key))} | ${fmt(p50Of(onUia, r.key))} | ${marginCell(r)} | ` +
            `${fmt(r.delta)} | ${holmCell(r)} | ${ciCell(r)} | ${readingCell(r)} |`
        );
      L.push("");
      const gates = p6.map((r) => r.gate);
      const verdict = !p6.length
        ? "N/A"
        : gates.includes("FAIL")
          ? "FAIL"
          : gates.includes("INCONCLUSIVE")
            ? "INCONCLUSIVE"
            : gates.includes("N/A")
              ? "N/A"
              : "PASS";
      const bad = p6.filter((r) => r.gate !== "PASS").map((r) => `${r.key} ${readingCell(r)}`);
      pline("P6", `${label}${bad.length ? ` (${bad.join(", ")})` : ""}`, verdict);
    }
  }
  // P7 fallback count from the block's echo.
  if (onIm.injectStrategyReported) {
    L.push(
      `- **P7 echo** — ON-input-manager \`injectStrategyReported\`: ${onIm.injectStrategyReported}`
    );
  }
  // Phase 3n.3 (3N2-H1/M6): the AUTHORITATIVE fallback signal is the on-device
  // injectStrategyCounts.unavailable (the host counter was removed in 3n.2). Print it
  // as a real number alongside the measured-RPC denominator so Q4 is not prose.
  if (onIm.injectStrategyCounts) {
    const c = onIm.injectStrategyCounts;
    const total =
      onIm.injectStrategyTotal != null
        ? onIm.injectStrategyTotal
        : Object.values(c).reduce((s, n) => s + n, 0);
    const unavail = c.unavailable || 0;
    const measured = onIm.measuredInjectRpcs;
    // Review 2026-10-07 finding 3: Q4 is an EQUALITY — the on-device input-manager
    // count must equal the gesture tool calls the bench issued (the merge refuses a
    // mismatch, so a rendered scoreboard only ever shows PASS or N/A here).
    const expected = onIm.expectedInjectRpcs;
    const imN = c["input-manager"] || 0;
    L.push(
      `- **Q4 equality** — on-device \`injectStrategyCounts["input-manager"]\` = **${imN}** == expected ` +
        (expected == null
          ? "**?** (no expectedInjectRpcs in the block): **N/A**"
          : `**${expected}** (gesture tool calls the bench issued in the block): ` +
            `**${imN === expected && total === expected && unavail === 0 ? "PASS" : "FAIL"}**`)
    );
    L.push(
      `- **Q4 fallbacks (on-device)** — \`injectStrategyCounts.unavailable\` = **${unavail}/${total}** ` +
        `(counts ${JSON.stringify(c)}) — the authoritative fallback signal; the host \`fastInject\` ` +
        `counter was removed in 3n.2 and is not evidence (3N2-H1).` +
        (measured != null
          ? ` Measured gated-inject RPCs (Q4 denominator) = **${measured}** of ${total} process-wide ` +
            `(the remainder is warmups + oracle self-test + describe-split + locate/restore taps).`
          : "")
    );
  }
  L.push("");
  // Method footer (findings 4/5): how every number above was produced, and what the
  // design does not capture.
  const m = family.filter((r) => r.alpha != null).length;
  L.push(
    "_Method (review 2026-10-07 findings 4/5). Timing: `performance.now()`, float ms. p50 = the " +
      "true median (linear-interpolation quantile from `.github/bench-ci/stats.js`, shared by the " +
      "bench script, the merge and this scoreboard). drift = OFF-1 p50 − OFF-2 p50 (published, " +
      "not gating). margin = max(bootstrap margin, 2 % of p50(OFF-1 ∪ OFF-2), 1 ms), where the " +
      "bootstrap margin is the 95th percentile of |p50(OFF-1\\*) − p50(OFF-2\\*)| over 10 000 seeded " +
      "resamples of each OFF block. Δ = p50(ON-input-manager) − p50(OFF-1 ∪ OFF-2 samples); CI = " +
      "seeded 10 000-draw percentile bootstrap of that difference. Reading: win if CI upper < " +
      "−margin, loss if CI lower > +margin, parity if the whole CI lies inside ±margin, otherwise " +
      "inconclusive. Holm across the m = " +
      m +
      " gated verbs: verbs are ranked by the bootstrap p-value of this rule (the smallest α at " +
      "which the CI reads win, loss or parity); the verb at rank k uses α_k = 0.05 / (m − k + 1), " +
      "i.e. a (1 − α_k) CI; after the first inconclusive verb in rank order every later verb is " +
      "retained as inconclusive (Holm stop). Gates: win or parity PASS, loss FAIL, inconclusive " +
      "INCONCLUSIVE (not passed, not a FAIL). P6 uses the null margin of its own pair: each arm " +
      "is recentred on its own median, the residuals are pooled and both resamples are drawn " +
      "from that pool (95th percentile of |Δp50|). p95 Δ is report only._"
  );
  L.push("");
  L.push(`_${EQUIV_FOOTER} (run 37561512651, Review 2026-10-07)._`);
  L.push("");
  L.push(
    "_Not captured: block-level variance is not captured — each arm is ONE block, so every CI " +
      "is within-block resampling and the OFF-1↔OFF-2 margin is the only between-block signal. " +
      "The follow-up is an interleaved ABBA design with ≥ 3 blocks per arm and CIs from " +
      "block-level variance. The promotion decision (P0–P7 + P9 + P10) is the planner's, from " +
      "these numbers._"
  );
  L.push("");
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
