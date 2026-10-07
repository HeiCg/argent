// CI variant of the phase-3f run-bench-merge.js. Same gates (gesture-param drift,
// ON-input-manager zero-fallback), but TOLERANT of a missing OFF arm: on a
// hosted Linux runner the proprietary simulator-server may refuse to run (it
// ships bin/linux/ but discovery/exec can fail), in which case only the ON blocks
// are present and the run is scored ON-only. Also folds the CI runner facts
// (nproc / RAM / KVM / emulator image+arch) written by the workflow to
// $BENCH_OUT/ci-runner-env.json into the merged `env` block, and the emulator/host
// record ($BENCH_OUT/ci-emulator-env.json, emulator-diagnostics.sh env) as `emulator`
// (null when absent, e.g. old fixtures).
//
// Emulator lost (2026-10-04): when the CI watchdog's marker exists
// ($BENCH_EMULATOR_LOST_FILE), the run is PARTIAL — the completeness gates (a requested
// ON block without a file, P0 VOID) record the gap in `missingBlocks` instead of
// throwing, so the merged JSON + scoreboard still describe the blocks that completed.
// The quality gates below still apply to every completed block. The workflow fails
// the job on the marker regardless (emulator-diagnostics.sh enforce).
//
// Review 2026-10-07 (findings 1, 3, 6). Validity is recorded, not only thrown:
//  - $BENCH_OUT/validity.json (block-validity.js, written by the workflow's run_block)
//    carries each block's ready-gate result, exit code and provenance stamp; a block
//    recorded as failed is INVALID, and a requested ON block that failed without a
//    file no longer throws the merge (the scoreboard shows it under an INVALID banner).
//  - Block order: OFF-1 must start before every ON block and OFF-2 after every ON
//    block (env.startedAt per block). Otherwise the run is INVALID (`runInvalidReasons`).
//  - OFF-legacy is graded on its own: a failed, degraded, unstamped or wrong-release
//    legacy block marks only `legacyArm.invalid`, never throws the main merge.
// `valid` (non-legacy) is false when any of the above holds; scoreboard.js exits 1 on it.
//
// Run 37571460849:
//  - Accounting: every block in BENCH_BLOCKS must have a bench-block-<name>.json or a
//    validity.json entry (a run, or an explicit `--did-not-run`). A requested block with
//    neither makes the run INVALID (that run skipped OFF-2 without a trace). Enforced
//    when validity.json exists or BENCH_REQUIRE_VALIDITY=1 (the workflow sets it).
//  - Empty describes inside timed verbs no longer invalidate a block. The bench drops
//    those samples from the verb's latency on both arms; here they become a quality
//    metric per (block, verb): `emptyRates` (empty / windows that read a describe,
//    Wilson 95 % CI) graded by P11 (≤ 25 %; stats.p11Gate), verdict in `p11`. ON
//    fallbacks still fail the merge.
//
// Run 37578606526 (review finding 12): `destinationRates` = the tap+describe reads
// classified correct / pre-transition / empty / other per (block, verb), with Wilson CIs,
// the correct-only latency and time-to-correct; `p12` = the pre-transition/mixed rate per
// row, report only.
//
// Review 2026-10-07 run 37591260027 ("Next run"):
//  - ABBA blocks: OFF-1, ON-im-1, ON-uia, OFF-2, ON-im-2, OFF-3, ON-im-3, OFF-legacy.
//    Arms by name: OFF-<n> = the current proprietary arm (pooled, every OFF-<n> must share
//    one provenance), ON-im-<n> (or the pre-ABBA ON-input-manager) = the candidate,
//    ON-uia (or ON-uiautomation) = the control. Q4 applies to every candidate block. The
//    order check: with ABBA names, blocks must start in the BENCH_BLOCKS order; the
//    pre-ABBA bracket check (OFF-1 before, OFF-2 after every ON block) otherwise.
//  - `transitionTimeline`: tap → first frame / transition finished per (block, verb) from
//    the BENCH markers in logcat-bench.txt (logcat-timeline.js), plus the per-sample
//    time-to-correct after the transition finished for the tap+describe variants.
//  - `loadByBlock`: qemu, simulator-server and on-device com.argent.* CPU per (block,
//    phase) from load-samples.jsonl (load-sampler.js).
//  - `propBackground`: the Part A probe (prop-background.json): what the proprietary
//    stack runs in the background.
//
// Review run 37609765062:
//  - P11 grades WRONG reads (Part B finding 1): empty + pre-transition/mixed out of the
//    classified tap+describe reads, per variant per block (`wrongReadRates`), same Wilson
//    rule (PASS if the CI upper bound ≤ 25 %, FAIL if the lower bound > 25 %, else
//    INCONCLUSIVE; a FAIL on any main arm fails it; no classified read FAILs). The empty
//    rate (`emptyRates`) is report only.
//  - Diagnostic arms ON-im-bg and ON-hostawait (block-arms.js): one block each, report
//    only, never pooled into ON-im / OFF and never in P2-P6. Like OFF-legacy, a failed gate
//    on them marks only their own section (`diagnosticArms[name].invalid`); their validity
//    rules (on-device injectStrategyCounts total > 0; simulator-server alive in ≥ 90 % of
//    the load samples with CPU > 0; the host-algorithm await ran and never failed) are
//    block-arms.js diagnosticArmReasons. ON-hostawait replaced OFF-devawait in review
//    round 1 (two UiAutomation clients on one emulator).
//  - ON-uia left the default: P0 (the control is mandatory) applies to the pre-ABBA names
//    only; an ABBA run without ON-uia reads P6 N/A.
//  - `p5Decomposition`: per arm, the time-to-correct p50 of the gated variant split into
//    tap → transition finished (logcat) + await floor (await-screen-idle on a still screen)
//    + describe p50 + rest (Part A finding 5). Report only.
const fs = require("fs");
const path = require("path");
const {
  UNKNOWN,
  provenanceKey,
  provenanceLabel,
  provenanceDiff,
} = require("./proprietary-provenance");
const { readValidity, entryReasons } = require("./block-validity");
const { median, round1, p11Gate, p11Verdict, P11_THRESHOLD, wilsonCI } = require("./stats");
const {
  destinationRates: destinationRatesOf,
  ttcGateSamples,
  TD_GATED_VARIANT,
} = require("./tap-describe-destination");
const { timelineOfFile, residualAfterFinish, markerVerbKey } = require("./logcat-timeline");
const { readSamples, aggregate: aggregateLoad } = require("./load-sampler");

const OUT = process.env.BENCH_OUT || path.join(process.cwd(), ".bench-results");
// Phase 3n: the block universe now includes the three Kotlin injection-strategy
// arms alongside the legacy ON-uiautomation name (kept for backward compatibility
// with older per-block JSONs / fixtures). Which of
// these actually ran is driven by BENCH_BLOCKS (workflow) / present files; a
// requested ON block that produced no file still fails loudly below.
// Re-baseline (0.27): OFF-legacy is the proprietary arm on an OLDER release's
// binaries (legacy_proprietary_version), run in the same job + emulator, LAST
// (after OFF-2, so it never sits inside the OFF-1↔OFF-2 drift interval). It is
// its own arm — never pooled with OFF-1/OFF-2, never part of the drift floor.
// Run 37591260027: the ABBA names join the universe; canonical order = the pre-registered
// run order (pre-ABBA names keep their old relative order).
// Review run 37609765062: the diagnostic arms ON-im-bg / ON-hostawait sit in the default
// run order (OFF-1, ON-im-1, ON-im-bg, OFF-2, ON-im-2, ON-hostawait, OFF-3, ON-im-3).
const ALL = [
  "OFF-1",
  "ON-im-1",
  "ON-im-bg",
  "ON-uia",
  "ON-uiautomation",
  "ON-uia-sync",
  "ON-uia-async",
  "ON-input-manager",
  "OFF-2",
  "ON-im-2",
  "ON-hostawait",
  "OFF-3",
  "ON-im-3",
  "OFF-legacy",
];
const LEGACY_OFF = "OFF-legacy";
const {
  isCurrentOff,
  isOnIm,
  isOnUia,
  isAbbaName,
  isDiagnosticArm,
  armOf,
  diagnosticArmReasons,
  simServerAliveOf,
} = require("./block-arms");
// Side arms: graded on their own, a failure marks only their section (never the main run).
const isSide = (n) => n === LEGACY_OFF || isDiagnosticArm(n);
// The CURRENT proprietary arm: the blocks the gates, fidelity and drift floor use.
const CURRENT_OFF = ALL.filter(isCurrentOff);

const readJson = (p) => {
  if (!p || !fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const emulatorLost = readJson(process.env.BENCH_EMULATOR_LOST_FILE);
const partial = Boolean(emulatorLost);
const emulator = readJson(path.join(OUT, "ci-emulator-env.json"));
const lostLabel = emulatorLost
  ? `${emulatorLost.lostAt}${emulatorLost.context ? ` (${emulatorLost.context})` : ""}`
  : "";

const files = {};
for (const n of ALL) {
  const p = path.join(OUT, `bench-block-${n}.json`);
  if (fs.existsSync(p)) files[n] = JSON.parse(fs.readFileSync(p, "utf8"));
}
const present = ALL.filter((n) => files[n]);
const requestedBlocks = (process.env.BENCH_BLOCKS || ALL.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter((n) => ALL.includes(n));
const missingBlocks = requestedBlocks.filter((n) => !files[n]);

// Per-block validity (review 2026-10-07 finding 6): what the workflow recorded for
// each block (ready-gate, exit code, provenance stamp). Absent on old artifacts and
// fixtures, which then merge as before. `invalid` collects reasons per block; the
// gates below add to it where a failure must not throw the merge (OFF-legacy).
const validityFile = readValidity(OUT);
const validity = validityFile ? validityFile.blocks : {};
const invalid = {};
const markInvalid = (n, why) => {
  (invalid[n] = invalid[n] || []).push(why);
};
for (const [n, e] of Object.entries(validity))
  for (const why of entryReasons(e)) markInvalid(n, why);
// Run 37571460849: blocks the workflow recorded as not run, and requested blocks that
// left no trace at all (neither a block file nor a validity entry).
const notRun = Object.values(validity)
  .filter((e) => e && e.ran === false)
  .map((e) => ({ block: e.block, reason: e.notRunReason || "unspecified" }));
const requireAccounting = Boolean(validityFile) || process.env.BENCH_REQUIRE_VALIDITY === "1";
const unaccountedReasons = (process.env.BENCH_BLOCKS && requireAccounting ? requestedBlocks : [])
  .filter((n) => !files[n] && !validity[n])
  .map(
    (n) =>
      `requested block ${n} has no bench-block-${n}.json and no validity entry (it neither ran ` +
      `nor was recorded as did not run)`
  );
const mainInvalidBlocks = () =>
  Object.keys(invalid)
    .filter((n) => !isSide(n))
    .map((n) => ({ block: n, reasons: invalid[n] }));

if (present.length === 0) {
  const recordedInvalid = mainInvalidBlocks();
  if (!partial && !recordedInvalid.length)
    throw new Error(`no bench-block-*.json found under ${OUT}`);
  const emptyPath = path.join(OUT, `bench-merged-${Date.now()}.json`);
  const empty = {
    partial,
    emulatorLost,
    missingBlocks,
    emulator,
    env: { ci: readJson(path.join(OUT, "ci-runner-env.json")) || {} },
    valid: recordedInvalid.length === 0 && unaccountedReasons.length === 0,
    invalidBlocks: recordedInvalid,
    runInvalidReasons: unaccountedReasons,
    notRun,
    validity: validityFile ? validity : null,
    blocksRan: [],
    blocks: [],
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(emptyPath, JSON.stringify(empty, null, 2));
  if (partial) console.log(`PARTIAL: emulator lost at ${lostLabel} before any block completed`);
  for (const x of recordedInvalid) console.log(`INVALID block ${x.block}: ${x.reasons.join("; ")}`);
  for (const why of unaccountedReasons) console.log(`INVALID run: ${why}`);
  console.log("MERGED_JSON=" + emptyPath);
  process.exit(0);
}

// ON blocks are the hard requirement: a requested ON-* block that produced no
// file must fail loudly (a silent drop would score an incomplete run as healthy).
// OFF-* may be absent — a proprietary refusal on Linux legitimately downgrades to
// ON-only.
const requested = (process.env.BENCH_BLOCKS || ALL.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// A requested ON block the workflow recorded as failed (validity.json) is reported as
// INVALID below instead of throwing here, so the scoreboard can say so.
// A diagnostic ON arm the workflow recorded as not run (no proprietary binary to spawn)
// is accounted for, not missing.
const notRunNames = new Set(notRun.map((x) => x.block));
const missingOn = requested.filter(
  (n) =>
    n.startsWith("ON") &&
    ALL.includes(n) &&
    !files[n] &&
    !invalid[n] &&
    !(isDiagnosticArm(n) && notRunNames.has(n))
);
const imPresent = ALL.filter((n) => files[n] && isOnIm(n));
const uiaPresent = ALL.filter((n) => files[n] && isOnUia(n));
if (missingOn.length && !partial) {
  throw new Error(`missing required ON block file(s): ${missingOn.join(", ")}`);
}

// P0 (phase 3n.1): the ON-uiautomation control arm is mandatory whenever the
// input-manager candidate ran — without the current default as a same-run control,
// no "no regression of the default" (P6) or default-path claim is possible. A 3n.1
// run with ON-input-manager but no ON-uiautomation is VOID. Review run 37609765062:
// ON-uia left the default ABBA list; an ABBA run without it reads P6 N/A instead.
const abbaDesign = present.some(isAbbaName) || requested.some(isAbbaName);
if (
  !abbaDesign &&
  imPresent.length &&
  !uiaPresent.length &&
  !partial &&
  !ALL.some((n) => isOnUia(n) && invalid[n])
) {
  throw new Error(
    `P0 VOID: ${imPresent.join(", ")} ran but the UiAutomation control block (ON-uia / ` +
      "ON-uiautomation) is absent — the run cannot grade the promotion candidate against the " +
      "current default (P6)."
  );
}

// Proprietary provenance gate (re-baseline 0.27). Every OFF block records which
// release it ran (`block.proprietaryProvenance`: npm version + sha256 of each binary/
// APK, stamped by proprietary-provenance.js). OFF-1 and OFF-2 are POOLED as one arm
// and their |Δp50| is the drift floor, so they must be the same binaries: a
// different version, a different sha256, or one known + one unknown is refused.
// Missing provenance on EVERY current OFF block (pre-0.27 fixtures/artifacts) reads
// "unknown" and still merges. OFF-legacy is a separate arm and is never pooled.
const provOf = (n) => (files[n] && files[n].block.proprietaryProvenance) || UNKNOWN;
const currentOffPresent = CURRENT_OFF.filter((n) => files[n]);
// With a validity record (every run since review 2026-10-07), a current OFF block
// without provenance was not stamped: INVALID, not "unknown". An OFF block already
// recorded as invalid is not compared for pooling (the run is INVALID anyway).
if (validityFile) {
  for (const n of currentOffPresent)
    if (provOf(n) === UNKNOWN && !(invalid[n] || []).some((r) => /not stamped/.test(r)))
      markInvalid(n, "unstamped: no proprietary provenance in the block file");
}
const poolable = currentOffPresent.every((n) => !invalid[n]);
for (let i = 1; poolable && i < currentOffPresent.length; i++) {
  const a = currentOffPresent[0],
    b = currentOffPresent[i];
  if (provenanceKey(provOf(a)) !== provenanceKey(provOf(b))) {
    throw new Error(
      `proprietary provenance differs between ${a} (${provenanceLabel(provOf(a))}) and ${b} ` +
        `(${provenanceLabel(provOf(b))}): ${provenanceDiff(provOf(a), provOf(b))} — refusing to ` +
        `pool them as one OFF arm or use them as a drift floor. Run both on the same release.`
    );
  }
}
const currentProv = currentOffPresent.length ? provOf(currentOffPresent[0]) : null;
// Finding 6: an unstamped OFF-legacy file is INVALID, never pooled or labelled "unknown".
const legacyUnstamped = Boolean(files[LEGACY_OFF]) && provOf(LEGACY_OFF) === UNKNOWN;
if (legacyUnstamped)
  markInvalid(LEGACY_OFF, "unstamped: no proprietary provenance in the OFF-legacy block file");
const legacyProv = files[LEGACY_OFF] && !legacyUnstamped ? provOf(LEGACY_OFF) : null;
// The workflow passes the requested releases; a stamped block on another release is
// the wrong baseline (e.g. a stale PROP_PKG), not a result. Current: fatal. Legacy:
// invalidates the legacy section only.
const versionMismatch = (label, prov, want) => {
  if (!want || !prov || prov === UNKNOWN || prov.version === want) return null;
  return (
    `${label} proprietary arm ran ${provenanceLabel(prov)}, expected ${want} ` +
    `(${label === "current" ? "BENCH_PROPRIETARY_VERSION" : "BENCH_LEGACY_PROPRIETARY_VERSION"})`
  );
};
const curMismatch = versionMismatch("current", currentProv, process.env.BENCH_PROPRIETARY_VERSION);
if (curMismatch) throw new Error(curMismatch);
const legMismatch = versionMismatch(
  "legacy",
  legacyProv,
  process.env.BENCH_LEGACY_PROPRIETARY_VERSION
);
if (legMismatch) markInvalid(LEGACY_OFF, legMismatch);

const blocks = present.map((n) => files[n].block);
// The fatal quality gates below grade the main arms (OFF-1/OFF-2 + ON). OFF-legacy and
// the diagnostic arms (ON-im-bg, ON-hostawait) run the same checks but a failure there
// only invalidates their own section.
const mainPresent = present.filter((n) => !isSide(n));
const sidePresent = present.filter(isSide);
const mainBlocks = mainPresent.map((n) => files[n].block);

// Gesture-param drift gate across the blocks that ran.
const gp = mainBlocks.map((b) => JSON.stringify(b.gestureParams));
if (new Set(gp).size > 1) {
  throw new Error("gesture params drifted across blocks: " + gp.join(" | "));
}
for (const n of sidePresent) {
  const own = JSON.stringify(files[n].block.gestureParams);
  if (gp.length && own !== gp[0]) markInvalid(n, `gesture params drifted: ${own} vs ${gp[0]}`);
}

// Tap-timeline parity gate (phase 3h). The bench records the ACTUAL injected tap
// timeline per block (frame count, per-frame tMs, holdMs, MOVE flag); assert the
// authored holdMs is identical across blocks and every backend injected the SAME
// clean two-frame DOWN→UP (no MOVE anywhere — every backend is at parity by shape, not
// just holdMs). Replaces "the gestureParams constant equals itself per block".
const tls = blocks.map((b) => ({ block: b.block, tl: b.injectedTapTimeline })).filter((x) => x.tl);
if (tls.length) {
  const holdMs0 = tls[0].tl.holdMs;
  for (const { block, tl } of tls) {
    const why =
      tl.holdMs !== holdMs0
        ? `tap-timeline parity: ${block} holdMs=${tl.holdMs} != ${tls[0].block} holdMs=${holdMs0}`
        : tl.hasMoveFrame || tl.frameCount !== 2
          ? `tap-timeline parity: ${block} (backend ${tl.backend}) is not a clean two-frame ` +
            `DOWN→UP (frameCount=${tl.frameCount}, hasMoveFrame=${tl.hasMoveFrame})`
          : null;
    if (!why) continue;
    if (isSide(block)) markInvalid(block, why);
    else throw new Error(why);
  }
}

// Effect gate (phase 3h). Runs at the END, after all four per-block JSONs exist, so
// one failing block never hides the others. A block's effect-checked taps must have
// landed (effectZeroTotal 0, from the timing-independent poll oracle). ON blocks are
// FATAL; OFF (proprietary) is tolerated and only reported (its arm is best-effort on
// Linux). originLost is reported for context.
const firstMiss = (b) =>
  b.firstTapNoEffectTotal != null ? b.firstTapNoEffectTotal : b.effectZeroTotal || 0;
const landingRate = (b) => {
  const c = b.effectCheckedTotal || 0;
  return c > 0 ? (c - firstMiss(b)) / c : 1;
};
const effectLine = present
  .map((n) => {
    const b = files[n].block;
    const c = b.effectCheckedTotal || 0;
    const self = b.oracleSelfTestPassed === false ? " oracleSelfTest=FAILED" : "";
    return `${n}: firstTapLanding=${c - firstMiss(b)}/${c} (${(landingRate(b) * 100).toFixed(1)}%) originLost=${b.originLostTotal || 0}${self}`;
  })
  .join(" | ");
console.log("tap first-attempt landing per block — " + effectLine);

// Oracle self-test gate (run-2 review): a block whose backend could not complete a
// single detected+restored navigation before the timed loop has UNTRUSTWORTHY effect
// rows — a DISTINCT verdict from "a tap did not land" and from "degraded arm". Fatal
// on any block (ON or OFF) that ran the check.
// Each fatal gate below grades `mainPresent`; `legacyGate` applies the same predicate
// to the side arms (OFF-legacy, finding 6; the diagnostic arms, review run 37609765062)
// and records the reason instead of throwing.
const legacyGate = (pred, why) => {
  for (const n of sidePresent) if (pred(n)) markInvalid(n, why(n));
};
legacyGate(
  (n) => files[n].block.oracleSelfTestPassed === false,
  () => "oracle self-test failed"
);
const oracleFailed = mainPresent.filter((n) => files[n].block.oracleSelfTestPassed === false);
if (oracleFailed.length) {
  throw new Error(
    `oracle self-test failed on block(s): ${oracleFailed.join(", ")} — the backend could not ` +
      `complete one detected+restored navigation, so the effect rows are untrustworthy (NOT the ` +
      `same as a first-attempt miss). Full per-block: ${effectLine}`
  );
}

// First-attempt LANDING-RATE gate (team-lead run-6 decision), SYMMETRIC across every
// block (OFF and ON): a backend must land >= 95% of its
// first-attempt taps on a freshly-located, settled coordinate — i.e. at most 3 misses
// of 60, or 2 of 40. Its purpose is to catch a tap that NEVER lands, not the 1-2%
// async injection drop that a hosted x86_64 KVM emulator produces (measured, printed
// as firstTapLanding, and its latency excluded from the tap percentiles — never
// retried away). oracleSelfTest already proved the backend CAN land + detect a tap.
const landingLow = (n) => {
  const b = files[n].block;
  const c = b.effectCheckedTotal || 0;
  return c > 0 && firstMiss(b) > Math.floor(c * 0.05);
};
legacyGate(
  landingLow,
  (n) =>
    `first-attempt landing rate below 95% (${firstMiss(files[n].block)}/${files[n].block.effectCheckedTotal})`
);
const landingBad = mainPresent.filter(landingLow).map((n) => {
  const b = files[n].block;
  const c = b.effectCheckedTotal || 0;
  return `${n}=${firstMiss(b)}/${c} (${(landingRate(b) * 100).toFixed(1)}%, threshold >${Math.floor(c * 0.05)} fails)`;
});
if (landingBad.length) {
  throw new Error(
    `first-attempt landing rate below 95% on block(s): ${landingBad.join(", ")} — the backend ` +
      `failed to land too many first taps (not a 1-2% async drop). Full per-block: ${effectLine}`
  );
}

// Vacuous-arm gate (phase 3h review A2, fix a). The effect gate above passes
// trivially when NOTHING was checked (effectZero 0 of 0). A block that ran tap
// verbs must have ARMED the backend-independent effect oracle (effectCheckedTotal
// > 0) — this holds for OFF too now that the oracle is backend-independent. A block
// with tap verbs and effectCheckedTotal === 0 fails the merge, ON or OFF.
const ranTapVerbs = (b) => (b.verbs || []).some((v) => /tap/i.test(v.verb || ""));
const isUnarmed = (n) =>
  ranTapVerbs(files[n].block) && (files[n].block.effectCheckedTotal || 0) === 0;
legacyGate(isUnarmed, () => "effect check UNARMED (effectCheckedTotal === 0)");
const unarmed = mainPresent.filter(isUnarmed);
if (unarmed.length) {
  throw new Error(
    `effect check UNARMED on block(s) that ran tap verbs: ${unarmed.join(", ")} ` +
      `(effectCheckedTotal === 0 — the effect gate would pass vacuously). ` +
      `Every tap block must arm the effect oracle. Full per-block: ${effectLine}`
  );
}

// Degraded-arm gate (phase 3h review A1, fix b). A block whose await-screen-idle /
// await-ui-element hit the cap on every iteration, or whose paste never found the
// search field, was on the WRONG screen for part of the run — its rows are not a
// valid baseline. The bench records the reasons in `degradedReasons`; a non-empty
// list fails the merge (an unarmed OR degraded OFF block must fail, per the ticket).
const isDegraded = (n) => (files[n].block.degradedReasons || []).length > 0;
legacyGate(isDegraded, (n) => `DEGRADED ARM: ${files[n].block.degradedReasons.join("; ")}`);
const degraded = mainPresent
  .filter(isDegraded)
  .map((n) => `${n}: ${files[n].block.degradedReasons.join("; ")}`);
if (degraded.length) {
  throw new Error(
    `DEGRADED ARM on block(s): ${degraded.join(" | ")} — the block was on the wrong ` +
      `screen for part of the run; its rows are not a valid baseline. Rerun.`
  );
}

// Empty describes inside timed verbs (run 37571460849). The bench counts, per verb, the
// timed windows that read a describe (`describeWindows`) and those whose describe came
// back empty (`treeEmpty`: the open server's marker or 0 elements on ON, 0 elements on
// OFF), and drops the empty windows from the verb's latency on both arms. They no
// longer invalidate the block. Each (block, verb) with a describe in its timed window is
// a quality row graded by P11: empty rate ≤ 25 %, Wilson 95 % CI (stats.p11Gate). Empties
// with no denominator FAIL (fail closed). The verdict covers the main arms; OFF-legacy
// is graded on its own line.
// Review run 37609765062 Part B finding 1: the empty rate is report only (P11 grades the
// wrong reads below). Rows keep the rate and its Wilson CI, without a gate.
const emptyRates = [];
for (const n of present) {
  const b = files[n].block;
  for (const v of b.verbs || []) {
    const windows = v.describeWindows || 0;
    const empty = v.treeEmpty || 0;
    if (windows === 0 && empty === 0) continue;
    emptyRates.push({
      block: n,
      config: b.config,
      verb: v.verb,
      empty,
      n: windows,
      rate: windows > 0 ? Number((empty / windows).toFixed(4)) : null,
      ci: wilsonCI(empty, windows),
      reportOnly: true,
      ...(v.timeToNonEmpty ? { timeToNonEmpty: v.timeToNonEmpty } : {}),
    });
  }
}
// Run 37578606526 / review finding 12: every timed tap+describe read is classified by the
// bench (tap-describe-destination.js) as correct / pre-transition / empty / other against
// the block's own destination markers, and followed by a time-to-correct loop. One row per
// (block, verb) with the counts, Wilson 95 % CIs, the correct-only latency and the
// time-to-correct summary. P12 = the pre-transition/mixed rate per (block, verb): report
// only (run 37591260027 finding 2: such a read showed the screen as it was, it is not a
// cached tree).
const destinationRates = [];
for (const n of present) {
  const b = files[n].block;
  for (const v of b.verbs || []) {
    if (!v.destination) continue;
    const t = v.timeToCorrect || null;
    destinationRates.push({
      block: n,
      config: b.config,
      verb: v.verb,
      ...destinationRatesOf(v.destination.counts),
      correctLatency: v.destination.correctLatency || null,
      timeToCorrect: t
        ? {
            measured: t.measured,
            reached: t.reached,
            timedOut: t.timedOut,
            firstRead: t.firstRead,
            budgetMs: t.budgetMs,
            fromTapMs: t.fromTapMs,
          }
        : null,
    });
  }
}
const p12 = {
  reportOnly: true,
  rows: destinationRates.map((r) => ({
    block: r.block,
    verb: r.verb,
    preTransition: r.counts.preTransition,
    n: r.n,
    rate: r.rates.preTransition.rate,
    ci: r.rates.preTransition.ci,
  })),
};
// Review run 37609765062 Part B finding 1: P11 grades WRONG reads, empty + pre-transition/
// mixed out of the classified tap+describe reads. An empty read (the describe landed
// inside the transition) and a pre-transition read (it landed before the destination's
// first frame and showed the old screen) are both wrong; grading empties alone penalised
// the arm whose transition starts earlier. Same Wilson rule, threshold and fail-closed
// denominator as before (stats.p11Gate).
// Gated reads (contract fix, same review): tap+await-idle+describe and plain describe (an
// empty read is wrong there; it has no pre-transition class). The settle:false /
// settle:true variants read back to back fail on both arms (run 37609765062: 15-20 of 20
// wrong per block), so the gate does not discriminate there; their right oracle is
// correct-at-first-read (the destination check, P12). Their rates stay, report only, until
// settle moves to the action (step settle-on-action).
const P11_GATED_VERBS = [TD_GATED_VARIANT, "describe"];
const SETTLE_REPORT_ONLY = "report only (settle moves to the action in step settle-on-action)";
const reportOnlyLabel = (verb) => (/settle/.test(verb) ? SETTLE_REPORT_ONLY : "report only");
const wrongRow = (r, wrong, empty, preTransition, n) => {
  const g = p11Gate(wrong, n);
  const gated = P11_GATED_VERBS.includes(r.verb);
  return {
    block: r.block,
    config: r.config,
    verb: r.verb,
    wrong,
    empty,
    preTransition,
    n: g.n,
    rate: g.rate,
    ci: g.ci,
    gate: g.gate,
    gated,
    ...(gated ? {} : { reportOnly: reportOnlyLabel(r.verb) }),
  };
};
const wrongReadRates = [
  ...destinationRates.map((r) =>
    wrongRow(
      r,
      r.counts.empty + r.counts.preTransition,
      r.counts.empty,
      r.counts.preTransition,
      r.n
    )
  ),
  // Plain describe on the idle root: its empty windows are its wrong reads.
  ...emptyRates
    .filter((r) => r.verb === "describe")
    .map((r) => wrongRow(r, r.empty, r.empty, null, r.n)),
];
const p11Main = wrongReadRates.filter((r) => r.gated && !isSide(r.block));
const p11Legacy = wrongReadRates.filter((r) => r.gated && r.block === LEGACY_OFF);
const p11 = {
  threshold: P11_THRESHOLD,
  metric: "wrong reads (empty + pre-transition/mixed) per gated read per block",
  gatedVerbs: P11_GATED_VERBS,
  settleVariants: SETTLE_REPORT_ONLY,
  verdict: p11Verdict(p11Main),
  legacyVerdict: p11Legacy.length ? p11Verdict(p11Legacy) : null,
  // The diagnostic arms are graded on their own lines, report only.
  diagnosticVerdicts: Object.fromEntries(
    ALL.filter(isDiagnosticArm)
      .map((n) => [n, wrongReadRates.filter((r) => r.gated && r.block === n)])
      .filter(([, rows]) => rows.length)
      .map(([n, rows]) => [n, p11Verdict(rows)])
  ),
  fails: p11Main.filter((r) => r.gate === "FAIL").map((r) => `${r.block} ${r.verb}`),
  inconclusive: p11Main.filter((r) => r.gate === "INCONCLUSIVE").map((r) => `${r.block} ${r.verb}`),
  emptyRateReportOnly: true,
};

// Open-server fallback gate (review 2026-10-07 finding 3). gesture-tap/swipe/pinch,
// await-screen-idle, describe, paste … fall back to the proprietary path with a
// `console.debug("[<tool>] open-device-server … failed, falling back …")` line. The
// bench captures those lines per block (`openServerFallbacks`, counted over the whole
// block, untimed calls included) and fails an ON block on any; this gate re-checks
// it, so an ON number can never be a proprietary number in disguise. Since PR #20 the
// host logs the describe fallback at console.warn; the bench hooks console.debug,
// console.warn and console.error (run 37561512651, Review 2026-10-07).
const fellBackOf = (n) => ((files[n].block.openServerFallbacks || {}).count || 0) > 0;
legacyGate(
  (n) => n.startsWith("ON") && fellBackOf(n),
  (n) => `open-server fallback: ${files[n].block.openServerFallbacks.count} "falling back" line(s)`
);
const fellBack = mainPresent
  .filter((n) => n.startsWith("ON"))
  .filter(fellBackOf)
  .map((n) => {
    const f = files[n].block.openServerFallbacks;
    return `${n}=${f.count}${f.samples && f.samples.length ? ` (first: ${f.samples[0]})` : ""}`;
  });
if (fellBack.length) {
  throw new Error(
    `ON block(s) fell back off the open server ("falling back" lines at console.debug/warn/error): ` +
      `${fellBack.join(" | ")} — some calls in the block ran on the proprietary path, so its ` +
      `rows are not open-server numbers.`
  );
}

// Redir transport gate (phase 3j item 3d / run-3 review). On this hosted x86_64
// emulator the open path MUST use the emulator-console `redir` transport (run 3
// proved it selects: both ON blocks recorded transport=redir). An ON block that
// fell back to adb-forward is not the transport we ship for emulators — fail so a
// silent fallback (leaked console token, unbound 0.0.0.0 listener, redir ping
// failure) can never be scored as a clean emulator run. Physical devices would be
// loopback+adb-forward, but CI is always an emulator serial.
const notRedir = (n) => n.startsWith("ON") && (files[n].block.transport || "") !== "redir";
legacyGate(notRedir, (n) => `transport ${files[n].block.transport || "(none)"}, not redir`);
const redirBad = mainPresent
  .filter(notRedir)
  .map((n) => `${n}=${files[n].block.transport || "(none)"}`);
if (redirBad.length) {
  throw new Error(
    `ON emulator block(s) did NOT use the redir transport: ${redirBad.join(", ")} — expected ` +
      `transport=redir (run 3 proved redir selects on this runner). A fall back to adb-forward ` +
      `means the console token / 0.0.0.0 listener / redir ping regressed; not a clean emulator run.`
  );
}

// Zero-fallback gate for the ON-input-manager arm (only if it ran). Phase 3n.3
// (3N2-H1): the AUTHORITATIVE fallback signal is the on-device
// `injectStrategyCounts["unavailable"]` accumulated over the block via `getInfo` (the
// Kotlin `InjectStrategyCounter` records "unavailable" for every input-manager RPC that
// hit the hiddenapi policy and fell back to uia-async). The old gate summed the host
// `verb.fallbacks` counter, which phase 3n.2 made STRUCTURALLY ZERO — its only emitter
// (the scrcpy `[open-server-fast-inject] … falling back` line) was deleted — so it
// passed on any run, including one where every injection fell back. This gate now reads
// the block JSON's raw counts (carried by bench-open-vs-proprietary.ts), fails on any
// `unavailable`, and ALSO fails on a missing/zero denominator (a dead or absent counter
// cannot certify a clean input-manager arm).
//
// Review 2026-10-07 finding 3 (Q4 equality): `total > 0 && unavailable == 0` is not
// enough — a call that fell back to the proprietary path never reaches the on-device
// injector, so it leaves no trace in the counter at all. The bench counts the gesture
// tool calls it issued in the block (`expectedInjectRpcs`); the on-device count for
// the block's strategy must equal it exactly. Mandatory for ON-input-manager; checked
// on any other ON block that carries the number.
let strategyUnavailable = null;
let strategyTotal = null;
let measuredInjectRpcs = null;
let strategyExpected = null;
let strategyMatched = null;
// Run 37591260027 (ABBA): every candidate block (ON-im-<n>, or the pre-ABBA
// ON-input-manager) passes the same Q4 checks; `q4ByBlock` keeps each block's numbers,
// the top-level fields carry the first candidate block (pre-ABBA readers).
const q4ByBlock = {};
for (const n of imPresent) {
  const im = files[n].block;
  const counts = im.injectStrategyCounts || {};
  const total =
    im.injectStrategyTotal != null
      ? im.injectStrategyTotal
      : Object.values(counts).reduce((s, x) => s + x, 0);
  const unavailable = counts["unavailable"] || 0;
  const measured = im.measuredInjectRpcs != null ? im.measuredInjectRpcs : null;
  if (total === 0) {
    throw new Error(
      `${n} reported NO on-device injections (injectStrategyCounts empty / total 0) — ` +
        "the strategy counter never ran (getInfo unread, or an absent counter), so this run cannot " +
        "certify a clean input-manager arm. Expected the process-wide inject total (e.g. 161)."
    );
  }
  if (unavailable > 0) {
    throw new Error(
      `${n} fell back to uia-async on ${unavailable}/${total} injection(s) ` +
        `(injectStrategyCounts.unavailable) — the reflective pipe degraded, so the measurement is NOT a ` +
        `clean input-manager arm. Counts: ${JSON.stringify(counts)}`
    );
  }
  const expected = im.expectedInjectRpcs != null ? im.expectedInjectRpcs : null;
  if (expected == null) {
    throw new Error(
      `${n} carries no expectedInjectRpcs (the gesture tool calls the bench issued ` +
        "in the block) — Q4 cannot match the on-device injectStrategyCounts against the " +
        "injections actually made, so a silent proprietary fallback could pass."
    );
  }
  const matched = counts["input-manager"] || 0;
  if (matched !== expected || total !== expected) {
    throw new Error(
      `Q4: ${n} on-device injectStrategyCounts["input-manager"]=${matched} ` +
        `(total ${total}) but expected ${expected} injections (gesture tool calls ` +
        `the bench issued) — the difference did not run through the input-manager injector ` +
        `(fallback to the proprietary path, a server restart, or an extra RPC). Counts: ` +
        `${JSON.stringify(counts)}`
    );
  }
  q4ByBlock[n] = { total, unavailable, measured, expected, matched };
  if (strategyTotal === null) {
    strategyTotal = total;
    strategyUnavailable = unavailable;
    measuredInjectRpcs = measured;
    strategyExpected = expected;
    strategyMatched = matched;
  }
}
for (const n of present.filter((x) => x.startsWith("ON") && !isOnIm(x))) {
  const b = files[n].block;
  if (b.expectedInjectRpcs == null || !b.injectStrategyCounts) continue;
  const key = b.injectStrategy && b.injectStrategy !== "default" ? b.injectStrategy : "default";
  const got = b.injectStrategyCounts[key] || 0;
  if (got !== b.expectedInjectRpcs && isSide(n)) {
    markInvalid(
      n,
      `Q4: on-device injectStrategyCounts["${key}"]=${got} but expected ${b.expectedInjectRpcs}`
    );
  } else if (got !== b.expectedInjectRpcs) {
    throw new Error(
      `Q4: ${n} on-device injectStrategyCounts["${key}"]=${got} but expected ` +
        `${b.expectedInjectRpcs} injections (gesture tool calls the bench issued). Counts: ` +
        `${JSON.stringify(b.injectStrategyCounts)}`
    );
  }
}

// Block order (review 2026-10-07 finding 1): OFF-1 and OFF-2 bracket every ON block,
// so the OFF-1↔OFF-2 drift floor spans the ON measurements. Read from each block's
// env.startedAt (set when the bench process starts its block), else the start time
// the workflow recorded. A violated or unverifiable order makes the run INVALID.
const runInvalidReasons = [...unaccountedReasons];
const startOfBlock = (n) =>
  (files[n] && files[n].env && files[n].env.startedAt) ||
  (validity[n] && validity[n].startedAt) ||
  null;
const onPresent = mainPresent.filter((n) => n.startsWith("ON"));
const bracketing = CURRENT_OFF.filter((n) => files[n]);
if (abbaDesign) {
  // Run 37591260027 (ABBA): the pre-registered order is BENCH_BLOCKS (else the canonical
  // order); every present main block must start after the one listed before it.
  const order = (process.env.BENCH_BLOCKS ? requested : ALL).filter((n) => mainPresent.includes(n));
  const missingTs = order.filter((n) => !startOfBlock(n));
  for (const n of missingTs)
    runInvalidReasons.push(`block order cannot be verified: no start timestamp for ${n}`);
  if (!missingTs.length) {
    for (let k = 1; k < order.length; k++) {
      const prev = order[k - 1],
        cur = order[k];
      if (!(Date.parse(startOfBlock(cur)) > Date.parse(startOfBlock(prev))))
        runInvalidReasons.push(
          `${cur} (started ${startOfBlock(cur)}) did not start after ${prev} ` +
            `(started ${startOfBlock(prev)}); the pre-registered ABBA order is ${order.join(", ")}`
        );
    }
  }
} else if (onPresent.length && bracketing.length) {
  const missingTs = [...bracketing, ...onPresent].filter((n) => !startOfBlock(n));
  for (const n of missingTs)
    runInvalidReasons.push(`block order cannot be verified: no start timestamp for ${n}`);
  if (!missingTs.length) {
    const t = (n) => Date.parse(startOfBlock(n));
    for (const on of onPresent) {
      if (files["OFF-1"] && !(t("OFF-1") < t(on))) {
        runInvalidReasons.push(
          `OFF-1 (started ${startOfBlock("OFF-1")}) did not start before ${on} ` +
            `(started ${startOfBlock(on)}); OFF-1 must start before every ON block`
        );
      }
      if (files["OFF-2"] && !(t("OFF-2") > t(on))) {
        runInvalidReasons.push(
          `OFF-2 (started ${startOfBlock("OFF-2")}) started before ${on} ` +
            `(started ${startOfBlock(on)}); OFF-2 must start after every ON block`
        );
      }
    }
  }
}
// Per-phase CPU (load-sampler.js): also the ON-im-bg liveness record below.
const loadSamples = readSamples(path.join(OUT, "load-samples.jsonl"));
// Review run 37609765062: the diagnostic arms, each graded on its own (block-arms.js).
const diagnosticArms = {};
for (const n of ALL.filter((x) => isDiagnosticArm(x) && (files[x] || validity[x]))) {
  if (files[n])
    for (const why of diagnosticArmReasons(n, files[n].block, loadSamples)) markInvalid(n, why);
  const alive = simServerAliveOf(n, loadSamples);
  diagnosticArms[n] = {
    arm: armOf(n),
    ran: Boolean(files[n]),
    invalid: Boolean(invalid[n]) || !files[n],
    invalidReasons: invalid[n] || (files[n] ? [] : ["no block file (did not run or failed)"]),
    simServerAlive: n === "ON-im-bg" && alive ? `${alive.alive}/${alive.n}` : null,
    simServerTicks: n === "ON-im-bg" && alive ? alive.ticks : null,
    hostAwait: files[n] ? files[n].block.hostAwait || null : null,
  };
}
const invalidBlocks = mainInvalidBlocks();
const valid = invalidBlocks.length === 0 && runInvalidReasons.length === 0;

// Fidelity: OFF-1 vs ON-uiautomation, only when both arms ran.
const jaccard = (a, b) => {
  const A = new Set(a),
    B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni === 0 ? 1 : Number((inter / uni).toFixed(3));
};
let fidelity = null;
// The describe tree is identical for every ON block (the injection strategy only
// changes touch injection), so compare OFF-1 against the first ON block present —
// ON-uiautomation when it ran, otherwise whichever strategy arm did (phase 3n).
const firstOnName = present.find((n) => n.startsWith("ON"));
if (files["OFF-1"] && firstOnName) {
  const off1 = files["OFF-1"].block;
  const on = files[firstOnName].block;
  fidelity = {
    off1_vs_on_jaccard: jaccard(off1.fidelitySet, on.fidelitySet),
    onlyOff: off1.fidelitySet.filter((x) => !on.fidelitySet.includes(x)),
    onlyOn: on.fidelitySet.filter((x) => !off1.fidelitySet.includes(x)),
    offCount: off1.fidelitySet.length,
    onCount: on.fidelitySet.length,
  };
}

// OFF-legacy as its own arm: per-verb p50/p95 vs the CURRENT OFF arm (OFF-1/OFF-2
// pooled). Review 2026-10-07 finding 4: the pooled p50 is the true median of the
// pooled OFF-1+OFF-2 samples (stats.js), the same point estimate the scoreboard's
// bootstrap resamples; blocks without per-sample arrays (old artifacts) fall back to
// the mean of the block p50s. p95 stays the mean of the block p95s (report only).
let legacyArm = null;
if (files[LEGACY_OFF] || invalid[LEGACY_OFF]) {
  const lb = files[LEGACY_OFF] ? files[LEGACY_OFF].block : { verbs: [] };
  const cur = currentOffPresent.map((n) => files[n].block);
  const mean = (xs) =>
    xs.length ? Number((xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(1)) : null;
  const deltaVsCurrent = (lb.verbs || []).map((v) => {
    const cv = cur.map((b) => (b.verbs || []).find((x) => x.verb === v.verb)).filter(Boolean);
    const allSamples = cv.length === cur.length && cv.every((x) => Array.isArray(x.latencySamples));
    const curP50 =
      cv.length !== cur.length
        ? null
        : allSamples && Array.isArray(v.latencySamples)
          ? round1(median(cv.flatMap((x) => x.latencySamples)))
          : mean(cv.map((x) => x.latency.p50));
    const legP50 =
      allSamples && Array.isArray(v.latencySamples)
        ? round1(median(v.latencySamples))
        : v.latency.p50;
    const curP95 = cv.length === cur.length ? mean(cv.map((x) => x.latency.p95)) : null;
    return {
      verb: v.verb,
      legacy: { p50: v.latency.p50, p95: v.latency.p95 },
      current: { p50: curP50, p95: curP95, blocks: currentOffPresent },
      delta: curP50 == null ? null : Number((legP50 - curP50).toFixed(1)),
    };
  });
  legacyArm = {
    block: LEGACY_OFF,
    label: legacyUnstamped ? "unstamped" : provenanceLabel(legacyProv),
    version: legacyProv && legacyProv !== UNKNOWN ? legacyProv.version : null,
    currentLabel: provenanceLabel(currentProv),
    currentVersion: currentProv && currentProv !== UNKNOWN ? currentProv.version : null,
    // Finding 6: a failed / degraded / unstamped / wrong-release legacy block
    // invalidates this section only; the scoreboard prints the reasons, not the table.
    invalid: Boolean(invalid[LEGACY_OFF]),
    invalidReasons: invalid[LEGACY_OFF] || [],
    deltaVsCurrent,
  };
}

// Base env from any present block (they capture identical device/env facts).
const baseEnv = files[present[0]].env;
let ciEnv = {};
const ciEnvPath = path.join(OUT, "ci-runner-env.json");
if (fs.existsSync(ciEnvPath)) {
  try {
    ciEnv = JSON.parse(fs.readFileSync(ciEnvPath, "utf8"));
  } catch {
    /* leave ciEnv empty */
  }
}

// Run 37591260027 finding 1: the transition timeline per (block, verb) from the BENCH
// markers in logcat-bench.txt, keyed by the block JSON's verb names; for verbs with a
// time-to-correct, the per-sample time after the transition finished (matched by the
// loop iteration).
const rawTimeline = timelineOfFile(path.join(OUT, "logcat-bench.txt"));
let transitionTimeline = null;
if (rawTimeline) {
  transitionTimeline = {};
  for (const n of present) {
    const b = files[n].block;
    const byKey = rawTimeline[n] || {};
    for (const v of b.verbs || []) {
      const row = byKey[markerVerbKey(v.verb)];
      if (!row) continue;
      (transitionTimeline[n] = transitionTimeline[n] || {})[v.verb] = {
        markers: row.markers,
        firstFrameMs: row.firstFrameMs,
        finishedMs: row.finishedMs,
        firstFrameSamples: row.firstFrame.map((x) => ({ i: x.i, ms: x.ms })),
        finishedSamples: row.finished,
        afterFinishTtcMs: residualAfterFinish(v.timeToCorrect || null, row),
      };
    }
  }
}
// Run 37591260027 finding 1: per-phase CPU (load-sampler.js, read above) and the Part A probe.
const loadByBlock = loadSamples.length ? aggregateLoad(loadSamples) : null;
const propBackgroundFile = readJson(path.join(OUT, "prop-background.json"));
const propBackground = propBackgroundFile ? propBackgroundFile.probe || null : null;

// Review run 37609765062 Part A finding 5: per arm, time-to-correct p50 of the gated variant
// = tap → transition finished (logcat, device clock) + await floor (await-screen-idle on a
// still screen) + describe p50 (idle) + rest. Each term is the mean of the arm's block
// values (the review's "mean of block p50s"); rest closes the sum. Report only.
const ARM_ORDER = ["OFF", "ON-im", "ON-uia", "ON-im-bg", "ON-hostawait", "OFF-legacy"];
const verbIn = (b, vn) => (b.verbs || []).find((v) => v.verb === vn) || null;
const p50OfVerb = (v) =>
  !v
    ? null
    : Array.isArray(v.latencySamples) && v.latencySamples.length
      ? median(v.latencySamples)
      : v.latency && v.latency.p50 != null
        ? v.latency.p50
        : null;
function p5TermsOf(n) {
  const b = files[n].block;
  const g = ttcGateSamples((verbIn(b, TD_GATED_VARIANT) || {}).timeToCorrect || null);
  const tl = transitionTimeline && transitionTimeline[n] && transitionTimeline[n][TD_GATED_VARIANT];
  return {
    ttc: g && g.samples.length ? median(g.samples) : null,
    fin: tl && tl.finishedMs ? tl.finishedMs.p50 : null,
    floor: p50OfVerb(verbIn(b, "await-screen-idle")),
    describe: p50OfVerb(verbIn(b, "describe")),
  };
}
const meanOf = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  return v.length ? round1(v.reduce((a, c) => a + c, 0) / v.length) : null;
};
const p5Arms = [];
for (const arm of ARM_ORDER) {
  const names = present.filter((n) => armOf(n) === arm && (!isDiagnosticArm(n) || !invalid[n]));
  const terms = names
    .map((n) => ({ n, ...p5TermsOf(n) }))
    .filter((t) => t.ttc != null && t.floor != null && t.describe != null);
  if (!terms.length) continue;
  const T = meanOf(terms.map((t) => t.ttc));
  const A = meanOf(terms.map((t) => t.fin));
  const B = meanOf(terms.map((t) => t.floor));
  const D = meanOf(terms.map((t) => t.describe));
  const R = round1(T - (A ?? 0) - B - D);
  const frac = (x) => (x == null || !T ? null : Number((x / T).toFixed(3)));
  p5Arms.push({
    arm,
    blocks: terms.map((t) => t.n),
    timeToCorrectMs: T,
    transitionFinishedMs: A,
    awaitFloorMs: B,
    describeMs: D,
    restMs: R,
    transitionMissing: A == null,
    fractions: {
      transitionFinished: frac(A),
      awaitFloor: frac(B),
      describe: frac(D),
      rest: frac(R),
    },
  });
}
const p5Decomposition = p5Arms.length
  ? { variant: TD_GATED_VARIANT, reportOnly: true, arms: p5Arms }
  : null;

const result = {
  // Emulator lost mid-run: only `blocksRan` completed; `missingBlocks` never produced
  // a file. A partial merge is never a complete result.
  partial,
  emulatorLost,
  missingBlocks: partial ? missingBlocks : missingBlocks.filter((n) => invalid[n]),
  emulator,
  // Review 2026-10-07 (findings 1, 6): run validity. `valid` covers the main arms
  // (OFF-1/OFF-2 + ON); OFF-legacy validity lives in `legacyArm.invalid`.
  valid,
  invalidBlocks,
  runInvalidReasons,
  // Run 37571460849: blocks recorded as not run (with the reason), and the empty-
  // describe quality rows + P11 verdict.
  notRun,
  emptyRates,
  wrongReadRates,
  p11,
  // Run 37578606526: tap+describe destination classes per (block, verb) and P12.
  destinationRates,
  p12,
  validity: validityFile ? validity : null,
  blockStartedAt: Object.fromEntries(present.map((n) => [n, startOfBlock(n)])),
  env: { ...baseEnv, ci: ciEnv },
  envPerBlock: Object.fromEntries(present.map((n) => [n, files[n].env])),
  blocksRan: present,
  offArmPresent: !!(files["OFF-1"] || files["OFF-2"]),
  blocks,
  // Re-baseline (0.27): which proprietary release each OFF block ran. `current` is
  // the pooled OFF-1/OFF-2 arm (one provenance by the gate above), `legacy` the
  // OFF-legacy arm; "unknown" for pre-0.27 blocks that carry none.
  proprietaryProvenance: {
    current: currentProv,
    legacy: legacyProv,
    byBlock: Object.fromEntries(
      present
        .filter((n) => n.startsWith("OFF"))
        .map((n) => [n, n === LEGACY_OFF && legacyUnstamped ? "unstamped" : provOf(n)])
    ),
  },
  legacyArm,
  // Review run 37609765062: the diagnostic arms (validity per arm) and the P5 decomposition.
  diagnosticArms,
  p5Decomposition,
  // Phase 3n.3 (3N2-H1/M6): the on-device fallback signal + its denominators, carried
  // for the scoreboard so Q4 states real numbers (not the dead host counter).
  strategyUnavailable,
  strategyTotal,
  measuredInjectRpcs,
  // Review 2026-10-07 finding 3: Q4 equality — on-device input-manager count vs the
  // gesture tool calls the bench issued (the merge refuses any mismatch).
  strategyExpected,
  strategyMatched,
  q4ByBlock,
  // Run 37591260027: timeline, per-phase load, the proprietary background probe.
  transitionTimeline,
  loadByBlock,
  propBackground,
  // Phase 3h: parity + effect evidence carried into the scoreboard.
  tapTimelines: Object.fromEntries(tls.map(({ block, tl }) => [block, tl])),
  effectByBlock: Object.fromEntries(
    blocks.map((b) => {
      const c = b.effectCheckedTotal || 0;
      const miss =
        b.firstTapNoEffectTotal != null ? b.firstTapNoEffectTotal : b.effectZeroTotal || 0;
      return [
        b.block,
        {
          effectZero: b.effectZeroTotal || 0,
          firstTapNoEffect: miss,
          firstTapLanded: c - miss,
          effectChecked: c,
          firstTapLandingRate: c > 0 ? Number(((c - miss) / c).toFixed(4)) : null,
          originLost: b.originLostTotal || 0,
          oracleSelfTestPassed: b.oracleSelfTestPassed !== false,
          transport: b.transport || null,
        },
      ];
    })
  ),
  effectZeroByBlock: Object.fromEntries(blocks.map((b) => [b.block, b.effectZeroTotal || 0])),
  transportByBlock: Object.fromEntries(blocks.map((b) => [b.block, b.transport || null])),
  fidelity,
  finishedAt: new Date().toISOString(),
};

const outPath = path.join(OUT, `bench-merged-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(
  `blocks merged: ${present.join(", ")}` +
    (strategyUnavailable === null
      ? " (no ON-input-manager arm)"
      : `; ${imPresent.join("/")} on-device inject fallbacks (injectStrategyCounts.unavailable): ` +
        `${strategyUnavailable}/${strategyTotal} (gate 0) — OK; input-manager ` +
        `${strategyMatched} == expected ${strategyExpected} injections — OK` +
        (measuredInjectRpcs != null ? `; measured gated-inject RPCs: ${measuredInjectRpcs}` : ""))
);
console.log("tap effect-check (ON fatal, OFF tolerated) — " + effectLine + " — ON gate OK");
console.log(
  `proprietary provenance: current ${currentProv ? provenanceLabel(currentProv) : "(no OFF-1/OFF-2)"}` +
    (legacyArm ? `; legacy ${legacyArm.label} (OFF-legacy, own arm)` : "")
);
if (legacyArm && legacyArm.invalid) {
  console.log(
    `::warning::OFF-legacy INVALID (legacy section only): ${legacyArm.invalidReasons.join("; ")}`
  );
}
for (const x of invalidBlocks) console.log(`INVALID block ${x.block}: ${x.reasons.join("; ")}`);
for (const why of runInvalidReasons) console.log(`INVALID run: ${why}`);
for (const x of notRun) console.log(`did not run: ${x.block} (${x.reason})`);
for (const [n, d] of Object.entries(diagnosticArms))
  if (d.invalid)
    console.log(`::warning::${n} INVALID (its own section only): ${d.invalidReasons.join("; ")}`);
console.log(
  `P11 wrong reads (empty + pre-transition/mixed) ≤ ${P11_THRESHOLD * 100} % per block on ` +
    `${P11_GATED_VERBS.join(" and ")} (settle variants report only): ${p11.verdict}` +
    (p11.fails.length ? `; FAIL ${p11.fails.join(", ")}` : "") +
    (p11.inconclusive.length ? `; INCONCLUSIVE ${p11.inconclusive.join(", ")}` : "")
);
if (p12.rows.length) {
  console.log(
    "P12 pre-transition/mixed tap+describe reads (report only): " +
      p12.rows.map((r) => `${r.block} ${r.verb} ${r.preTransition}/${r.n}`).join(", ")
  );
}
if (!valid) console.log("::error::latency run INVALID — see the scoreboard banner");
if (tls.length) {
  console.log(
    "tap-timeline parity OK: holdMs=" +
      tls[0].tl.holdMs +
      "ms; every backend a clean 2-frame DOWN→UP — " +
      tls
        .map(({ block, tl }) => `${block}:${tl.frameCount}f${tl.hasMoveFrame ? "+move" : ""}`)
        .join(", ")
  );
}
if (partial) {
  console.log(
    `PARTIAL: emulator lost at ${lostLabel}; completed ${present.join(", ")}; ` +
      `missing ${missingBlocks.join(", ") || "(none)"}`
  );
}
console.log("MERGED_JSON=" + outPath);
