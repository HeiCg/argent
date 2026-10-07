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
// classified correct / stale / empty / other per (block, verb), with Wilson CIs, the
// correct-only latency and time-to-correct; `p12` = the stale rate per row, report only.
const fs = require("fs");
const path = require("path");
const {
  UNKNOWN,
  provenanceKey,
  provenanceLabel,
  provenanceDiff,
} = require("./proprietary-provenance");
const { readValidity, entryReasons } = require("./block-validity");
const { median, round1, p11Gate, p11Verdict, P11_THRESHOLD } = require("./stats");
const { destinationRates: destinationRatesOf } = require("./tap-describe-destination");

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
const ALL = [
  "OFF-1",
  "ON-uiautomation",
  "ON-uia-sync",
  "ON-uia-async",
  "ON-input-manager",
  "OFF-2",
  "OFF-legacy",
];
// The CURRENT proprietary arm: the blocks the gates, fidelity and drift floor use.
const CURRENT_OFF = ["OFF-1", "OFF-2"];
const LEGACY_OFF = "OFF-legacy";

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
    .filter((n) => n !== LEGACY_OFF)
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
const missingOn = requested.filter(
  (n) => n.startsWith("ON") && ALL.includes(n) && !files[n] && !invalid[n]
);
if (missingOn.length && !partial) {
  throw new Error(`missing required ON block file(s): ${missingOn.join(", ")}`);
}

// P0 (phase 3n.1): the ON-uiautomation control arm is mandatory whenever the
// input-manager candidate ran — without the current default as a same-run control,
// no "no regression of the default" (P6) or default-path claim is possible. A 3n.1
// run with ON-input-manager but no ON-uiautomation is VOID.
if (
  files["ON-input-manager"] &&
  !files["ON-uiautomation"] &&
  !partial &&
  !invalid["ON-uiautomation"]
) {
  throw new Error(
    "P0 VOID: ON-input-manager ran but the ON-uiautomation control block is absent — " +
      "the run cannot grade the promotion candidate against the current default (P6)."
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
// The fatal quality gates below grade the main arms (OFF-1/OFF-2 + ON). OFF-legacy
// runs the same checks but a failure there only invalidates the legacy section.
const mainPresent = present.filter((n) => n !== LEGACY_OFF);
const mainBlocks = mainPresent.map((n) => files[n].block);
const legacyBlock = files[LEGACY_OFF] ? files[LEGACY_OFF].block : null;

// Gesture-param drift gate across the blocks that ran.
const gp = mainBlocks.map((b) => JSON.stringify(b.gestureParams));
if (new Set(gp).size > 1) {
  throw new Error("gesture params drifted across blocks: " + gp.join(" | "));
}
if (legacyBlock && gp.length && JSON.stringify(legacyBlock.gestureParams) !== gp[0]) {
  markInvalid(
    LEGACY_OFF,
    `gesture params drifted: ${JSON.stringify(legacyBlock.gestureParams)} vs ${gp[0]}`
  );
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
    if (block === LEGACY_OFF) markInvalid(LEGACY_OFF, why);
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
// to OFF-legacy and records the reason instead of throwing (finding 6).
const legacyGate = (pred, why) => {
  if (legacyBlock && pred(LEGACY_OFF)) markInvalid(LEGACY_OFF, why(LEGACY_OFF));
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
      ...p11Gate(empty, windows),
      ...(v.timeToNonEmpty ? { timeToNonEmpty: v.timeToNonEmpty } : {}),
    });
  }
}
// Run 37578606526 / review finding 12: every timed tap+describe read is classified by the
// bench (tap-describe-destination.js) as correct / stale / empty / other against the
// block's own destination markers, and followed by a time-to-correct loop. One row per
// (block, verb) with the counts, Wilson 95 % CIs, the correct-only latency and the
// time-to-correct summary. P12 = the stale rate per (block, verb): report only.
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
    stale: r.counts.stale,
    n: r.n,
    rate: r.rates.stale.rate,
    ci: r.rates.stale.ci,
  })),
};
const p11Main = emptyRates.filter((r) => r.block !== LEGACY_OFF);
const p11Legacy = emptyRates.filter((r) => r.block === LEGACY_OFF);
const p11 = {
  threshold: P11_THRESHOLD,
  verdict: p11Verdict(p11Main),
  legacyVerdict: p11Legacy.length ? p11Verdict(p11Legacy) : null,
  fails: p11Main.filter((r) => r.gate === "FAIL").map((r) => `${r.block} ${r.verb}`),
  inconclusive: p11Main.filter((r) => r.gate === "INCONCLUSIVE").map((r) => `${r.block} ${r.verb}`),
};

// Open-server fallback gate (review 2026-10-07 finding 3). gesture-tap/swipe/pinch,
// await-screen-idle, describe, paste … fall back to the proprietary path with a
// `console.debug("[<tool>] open-device-server … failed, falling back …")` line. The
// bench captures those lines per block (`openServerFallbacks`, counted over the whole
// block, untimed calls included) and fails an ON block on any; this gate re-checks
// it, so an ON number can never be a proprietary number in disguise. Since PR #20 the
// host logs the describe fallback at console.warn; the bench hooks console.debug,
// console.warn and console.error (run 37561512651, Review 2026-10-07).
const fellBack = present
  .filter((n) => n.startsWith("ON"))
  .filter((n) => ((files[n].block.openServerFallbacks || {}).count || 0) > 0)
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
const redirBad = present
  .filter((n) => n.startsWith("ON"))
  .filter((n) => (files[n].block.transport || "") !== "redir")
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
if (files["ON-input-manager"]) {
  const im = files["ON-input-manager"].block;
  const counts = im.injectStrategyCounts || {};
  strategyTotal =
    im.injectStrategyTotal != null
      ? im.injectStrategyTotal
      : Object.values(counts).reduce((s, n) => s + n, 0);
  strategyUnavailable = counts["unavailable"] || 0;
  measuredInjectRpcs = im.measuredInjectRpcs != null ? im.measuredInjectRpcs : null;
  if (strategyTotal === 0) {
    throw new Error(
      "ON-input-manager reported NO on-device injections (injectStrategyCounts empty / total 0) — " +
        "the strategy counter never ran (getInfo unread, or an absent counter), so this run cannot " +
        "certify a clean input-manager arm. Expected the process-wide inject total (e.g. 161)."
    );
  }
  if (strategyUnavailable > 0) {
    throw new Error(
      `ON-input-manager fell back to uia-async on ${strategyUnavailable}/${strategyTotal} injection(s) ` +
        `(injectStrategyCounts.unavailable) — the reflective pipe degraded, so the measurement is NOT a ` +
        `clean input-manager arm. Counts: ${JSON.stringify(counts)}`
    );
  }
  strategyExpected = im.expectedInjectRpcs != null ? im.expectedInjectRpcs : null;
  if (strategyExpected == null) {
    throw new Error(
      "ON-input-manager carries no expectedInjectRpcs (the gesture tool calls the bench issued " +
        "in the block) — Q4 cannot match the on-device injectStrategyCounts against the " +
        "injections actually made, so a silent proprietary fallback could pass."
    );
  }
  strategyMatched = counts["input-manager"] || 0;
  if (strategyMatched !== strategyExpected || strategyTotal !== strategyExpected) {
    throw new Error(
      `Q4: ON-input-manager on-device injectStrategyCounts["input-manager"]=${strategyMatched} ` +
        `(total ${strategyTotal}) but expected ${strategyExpected} injections (gesture tool calls ` +
        `the bench issued) — the difference did not run through the input-manager injector ` +
        `(fallback to the proprietary path, a server restart, or an extra RPC). Counts: ` +
        `${JSON.stringify(counts)}`
    );
  }
}
for (const n of present.filter((x) => x.startsWith("ON") && x !== "ON-input-manager")) {
  const b = files[n].block;
  if (b.expectedInjectRpcs == null || !b.injectStrategyCounts) continue;
  const key = b.injectStrategy && b.injectStrategy !== "default" ? b.injectStrategy : "default";
  const got = b.injectStrategyCounts[key] || 0;
  if (got !== b.expectedInjectRpcs) {
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
if (onPresent.length && bracketing.length) {
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
  // Phase 3n.3 (3N2-H1/M6): the on-device fallback signal + its denominators, carried
  // for the scoreboard so Q4 states real numbers (not the dead host counter).
  strategyUnavailable,
  strategyTotal,
  measuredInjectRpcs,
  // Review 2026-10-07 finding 3: Q4 equality — on-device input-manager count vs the
  // gesture tool calls the bench issued (the merge refuses any mismatch).
  strategyExpected,
  strategyMatched,
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
      : `; ON-input-manager on-device inject fallbacks (injectStrategyCounts.unavailable): ` +
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
console.log(
  `P11 empty describes ≤ ${P11_THRESHOLD * 100} % per timed verb per block: ${p11.verdict}` +
    (p11.fails.length ? `; FAIL ${p11.fails.join(", ")}` : "") +
    (p11.inconclusive.length ? `; INCONCLUSIVE ${p11.inconclusive.join(", ")}` : "")
);
if (p12.rows.length) {
  console.log(
    "P12 stale tap+describe reads (report only): " +
      p12.rows.map((r) => `${r.block} ${r.verb} ${r.stale}/${r.n}`).join(", ")
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
