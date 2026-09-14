// Unit tests for the CI bench GATES (review: "gates never observed to fire").
// Each gate script (merge-blocks.js, merge-fling.js, scoreboard.js) is a standalone
// Node program that reads $BENCH_OUT/*.json and exits non-zero on a violation. These
// tests write synthetic block/fling JSONs into a throwaway BENCH_OUT and assert the
// script's exit code + message, so tap-timeline parity, oracle self-test, vacuous-arm,
// degraded-arm, redir, zero-fallback, landing-rate, missing-ON, the fling parity gate
// (now WITH NO whitelist + floor exclusion) and the F3 tap-parity verdict all have a
// firing/non-firing proof that does not depend on a full device run.
//
// Run: node --test .github/bench-ci/gates.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HERE = __dirname;
const MERGE_BLOCKS = path.join(HERE, "merge-blocks.js");
const MERGE_FLING = path.join(HERE, "merge-fling.js");
const SCOREBOARD = path.join(HERE, "scoreboard.js");

function freshOut() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bench-gate-"));
}

/** Run a gate script; return { code, stdout, stderr }. Never throws on non-zero. */
function run(script, out, extraEnv = {}) {
  try {
    const stdout = execFileSync("node", [script], {
      env: { ...process.env, BENCH_OUT: out, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") };
  }
}

const ENV = {
  androidRelease: "14",
  androidSdk: "34",
  abi: "x86_64",
  screen: "1080x2400",
  density: "420",
  N: 20,
  WARMUP: 3,
  COLD: 3,
  tokenizer: "o200k",
};

/** A healthy per-block file. Override any field of `.block`. */
function block(name, over = {}) {
  const isOff = name.startsWith("OFF");
  return {
    env: ENV,
    block: {
      block: name,
      config: isOff ? "OFF" : "ON",
      fastInject: name === "ON-scrcpy",
      gestureParams: { tapHoldMs: 50, swipeDurationMs: 250, pinchDurationMs: 300 },
      injectedTapTimeline: { holdMs: 50, frameCount: 2, hasMoveFrame: false, backend: name },
      verbs: [{ verb: "gesture-tap", latency: { p50: 52, p95: 54 }, errors: 0, fallbacks: 0 }],
      effectCheckedTotal: isOff ? 40 : 60,
      effectZeroTotal: 0,
      firstTapNoEffectTotal: 0,
      originLostTotal: 0,
      locateFailedTotal: 0,
      coordMovedTotal: 0,
      locateViaTotal: { dump: 0, describe: isOff ? 40 : 60 },
      noEffectSamples: [],
      oracleSelfTestPassed: true,
      transport: isOff ? null : "redir",
      degradedReasons: [],
      fidelitySet: ["a", "b", "c"],
      coldStartMs: [500, 450, 440],
      describeSample: { source: name, bytes: 1894, tokens: 657, elements: 17 },
      screenshot: { bytes: 1000, width: 1080, height: 2400, format: "jpeg" },
      ...over,
    },
  };
}

function writeBlocks(out, blocks) {
  for (const b of blocks) fs.writeFileSync(path.join(out, `bench-block-${b.block.block}.json`), JSON.stringify(b));
}

// Phase 3n.1 fixture helpers: a verb with a per-sample array symmetric around p50
// (median == p50 exactly), so the scoreboard's seeded bootstrap CI is deterministic.
function mkVerb(verb, p50, over = {}) {
  const s = [];
  for (let i = -8; i <= 8; i++) s.push(p50 + i); // 17 samples, median == p50, ±8 spread
  return { verb, latency: { p50, p95: p50 + 8 }, latencySamples: s, errors: 0, fallbacks: 0, ...over };
}
// A 3n.1 latency block with the four gated verbs. v = {tap, swipe, pinch, headline}.
function block31(name, v, over = {}) {
  const verbs = [mkVerb("gesture-tap", v.tap), mkVerb("gesture-swipe", v.swipe), mkVerb("gesture-pinch", v.pinch)];
  if (v.headline != null) {
    verbs.push(mkVerb(name.startsWith("OFF") ? "tap+describe" : "tap+describe(settle:false)", v.headline));
  }
  return block(name, { verbs, ...over });
}
// The five run-2 blocks with run-34853156073's measured p50s (input-manager, scrcpy,
// OFF) plus a plausible ON-uiautomation control — reproduces the review's per-verb
// table: tap parity, swipe win, pinch win, headline parity/win at floor 103.
const RUN2 = (over = {}) => [
  block31("OFF-1", { tap: 53, swipe: 307, pinch: 351, headline: 445 }),
  block31("ON-uiautomation", { tap: 86, swipe: 291, pinch: 340, headline: 422 }),
  block31("ON-input-manager", { tap: 55, swipe: 268, pinch: 323, headline: 400 }, over),
  block31("ON-scrcpy", { tap: 52, swipe: 258, pinch: 307, headline: 340 }),
  block31("OFF-2", { tap: 53, swipe: 300, pinch: 356, headline: 548 }),
];
const RUN2ENV = { BENCH_BLOCKS: "OFF-1,ON-uiautomation,ON-input-manager,ON-scrcpy,OFF-2" };

const FOUR = () => [block("OFF-1"), block("ON-uiautomation"), block("ON-scrcpy"), block("OFF-2")];
const ALLENV = { BENCH_BLOCKS: "OFF-1,ON-uiautomation,ON-scrcpy,OFF-2" };

/* ------------------------------- merge-blocks ----------------------------- */

test("merge-blocks: healthy four-block run passes", () => {
  const out = freshOut();
  writeBlocks(out, FOUR());
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /blocks merged: OFF-1, ON-uiautomation, ON-scrcpy, OFF-2/);
});

test("merge-blocks: tap-timeline parity FIRES on a MOVE frame", () => {
  const out = freshOut();
  const bs = FOUR();
  bs[2].block.injectedTapTimeline = { holdMs: 50, frameCount: 3, hasMoveFrame: true, backend: "ON-scrcpy" };
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /tap-timeline parity/);
});

test("merge-blocks: oracle self-test FIRES", () => {
  const out = freshOut();
  const bs = FOUR();
  bs[2].block.oracleSelfTestPassed = false;
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /oracle self-test failed/);
});

test("merge-blocks: vacuous-arm FIRES (tap verbs but effectChecked 0)", () => {
  const out = freshOut();
  const bs = FOUR();
  bs[1].block.effectCheckedTotal = 0;
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /UNARMED/);
});

test("merge-blocks: degraded-arm FIRES", () => {
  const out = freshOut();
  const bs = FOUR();
  bs[0].block.degradedReasons = ["await-screen-idle capped every iteration"];
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /DEGRADED ARM/);
});

test("merge-blocks: redir gate FIRES when an ON block used adb-forward", () => {
  const out = freshOut();
  const bs = FOUR();
  bs[2].block.transport = "adb-forward";
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /did NOT use the redir transport/);
});

test("merge-blocks: zero-fast-inject-fallback FIRES for ON-scrcpy", () => {
  const out = freshOut();
  const bs = FOUR();
  bs[2].block.verbs = [{ verb: "gesture-tap", latency: { p50: 52, p95: 54 }, errors: 0, fallbacks: 2 }];
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /fast-inject fallback/);
});

test("merge-blocks: landing-rate FIRES below 95% (not a 1-2% drop)", () => {
  const out = freshOut();
  const bs = FOUR();
  bs[2].block.effectZeroTotal = 6; // 6/60 = 90%
  bs[2].block.firstTapNoEffectTotal = 6;
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /landing rate below 95%/);
});

test("merge-blocks: a 1/60 scrcpy async drop does NOT fire the landing gate", () => {
  const out = freshOut();
  const bs = FOUR();
  bs[2].block.effectZeroTotal = 1; // 59/60 = 98.3%
  bs[2].block.firstTapNoEffectTotal = 1;
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 0, r.stderr);
});

test("merge-blocks: a requested ON block that produced no file FIRES", () => {
  const out = freshOut();
  writeBlocks(out, [block("OFF-1"), block("ON-uiautomation"), block("OFF-2")]); // ON-scrcpy missing
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /missing required ON block/);
});

/* -------------------------------- merge-fling ----------------------------- */

function flingBlock(name, cells, extra = {}) {
  return { serial: "emulator-5554", N: 12, config: name, cells, ...extra };
}
// Six cells; `spec` maps "dur|dist" -> [uiaMed, scrMed, offMed].
function flingSet(out, spec, opts = {}) {
  const uia = [], scr = [], off = [], leg = [];
  for (const [k, v] of Object.entries(spec)) {
    const [durationMs, distance] = k.split("|").map(Number);
    const cell = (median) => ({ durationMs, distance, n: 12, median, iqr: [median, median] });
    uia.push(cell(v[0]));
    scr.push(cell(v[1]));
    if (v[2] != null) off.push(cell(v[2]));
    if (v[3] != null) leg.push(cell(v[3]));
  }
  fs.writeFileSync(path.join(out, "fling-block-ON-uiautomation.json"), JSON.stringify(flingBlock("ON-uiautomation", uia)));
  fs.writeFileSync(path.join(out, "fling-block-ON-scrcpy.json"), JSON.stringify(flingBlock("ON-scrcpy", scr, { pacing: "drift" })));
  if (off.length) fs.writeFileSync(path.join(out, "fling-block-OFF.json"), JSON.stringify(flingBlock("OFF", off)));
  if (leg.length) fs.writeFileSync(path.join(out, "fling-block-ON-scrcpy-legacy.json"), JSON.stringify(flingBlock("ON-scrcpy-legacy", leg, { pacing: "legacy" })));
}

test("merge-fling: passes when every informative cell is within ±0.15 on BOTH sides", () => {
  const out = freshOut();
  // Two-sided rule (change 3): scrcpy within ±0.15 of uia AND of off in every cell.
  flingSet(out, {
    "150|0.3": [0.45, 0.46, 0.46],
    "250|0.3": [0.44, 0.45, 0.46],
    "400|0.3": [0.50, 0.52, 0.51],
    "400|0.5": [0.60, 0.58, 0.62],
  });
  const r = run(MERGE_FLING, out);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /FLING VERDICT: PASS \(per-cell ±0.15 on scrcpy\/uia AND scrcpy\/off/);
});

test("merge-fling: TWO-SIDED — scrcpy at parity with uia but NOT with off FAILS (change 3)", () => {
  const out = freshOut();
  // 250|0.3: scrcpy/uia = 0.34/0.36 = 0.944 (inside), scrcpy/off = 0.34/0.46 = 0.739
  // (outside) — a scrcpy under-scroll the one-sided uia gate would have missed.
  flingSet(out, {
    "150|0.3": [0.45, 0.46, 0.46],
    "250|0.3": [0.36, 0.34, 0.46],
  });
  const r = run(MERGE_FLING, out);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /fling parity gate FAILED/);
  assert.match(r.stdout, /scrcpy\/off .* dev/);
});

test("merge-fling: NO whitelist — a cell that used to be whitelisted (400|0.5) now FAILS", () => {
  const out = freshOut();
  // 400|0.5 scrcpy/uia = 0.36/0.50 = 0.72 — outside ±0.15 and formerly whitelisted.
  flingSet(out, {
    "150|0.3": [0.45, 0.46, 0.46],
    "250|0.3": [0.44, 0.45, 0.46],
    "400|0.5": [0.50, 0.36, 0.62],
  });
  const r = run(MERGE_FLING, out);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /fling parity gate FAILED/);
  assert.match(r.stdout, /FLING VERDICT: FAIL/);
});

test("merge-fling: a cell whose uia REFERENCE q25 sits at the floor is NON-INFORMATIVE (change 1)", () => {
  const out = freshOut();
  // uia iqr[0] at the 0.175 floor (bimodal reference) → non-informative, keyed on the
  // reference, never on scrcpy. Only cell → 0 informative → INCONCLUSIVE, which now
  // FAILS the step (3K1-M3): a run with no gradable cell must not exit green.
  const uia = [{ durationMs: 150, distance: 0.3, n: 12, median: 0.45, iqr: [0.175, 0.51] }];
  const scr = [{ durationMs: 150, distance: 0.3, n: 12, median: 0.46, iqr: [0.4, 0.5] }];
  const off = [{ durationMs: 150, distance: 0.3, n: 12, median: 0.46, iqr: [0.44, 0.5] }];
  fs.writeFileSync(path.join(out, "fling-block-ON-uiautomation.json"), JSON.stringify(flingBlock("ON-uiautomation", uia)));
  fs.writeFileSync(path.join(out, "fling-block-ON-scrcpy.json"), JSON.stringify(flingBlock("ON-scrcpy", scr, { pacing: "drift" })));
  fs.writeFileSync(path.join(out, "fling-block-OFF.json"), JSON.stringify(flingBlock("OFF", off)));
  const r = run(MERGE_FLING, out);
  assert.strictEqual(r.code, 1, r.stdout);
  assert.match(r.stdout, /INCONCLUSIVE/);
  assert.match(r.stdout, /uia reference q25=0.175 at the 0.175 floor/);
});

test("merge-fling: POWER FLOOR — an OFF arm with n<10 makes the cell NON-INFORMATIVE (change 2)", () => {
  const out = freshOut();
  const uia = [{ durationMs: 250, distance: 0.3, n: 12, median: 0.45, iqr: [0.42, 0.48] }];
  const scr = [{ durationMs: 250, distance: 0.3, n: 12, median: 0.46, iqr: [0.43, 0.49] }];
  const off = [{ durationMs: 250, distance: 0.3, n: 8, median: 0.46, iqr: [0.43, 0.49] }]; // off underpowered
  fs.writeFileSync(path.join(out, "fling-block-ON-uiautomation.json"), JSON.stringify(flingBlock("ON-uiautomation", uia)));
  fs.writeFileSync(path.join(out, "fling-block-ON-scrcpy.json"), JSON.stringify(flingBlock("ON-scrcpy", scr, { pacing: "drift" })));
  fs.writeFileSync(path.join(out, "fling-block-OFF.json"), JSON.stringify(flingBlock("OFF", off)));
  const r = run(MERGE_FLING, out);
  assert.strictEqual(r.code, 1, r.stdout); // 3K1-M3: INCONCLUSIVE now fails
  assert.match(r.stdout, /INCONCLUSIVE/);
  assert.match(r.stdout, /off n=8 < 10/);
});

test("merge-fling: 3K1-M3 — INCONCLUSIVE (zero informative cells) EXITS NON-ZERO, not a silent green", () => {
  const out = freshOut();
  // Every cell non-informative: one cell with a floored uia reference, one with a
  // floored off reference — so no cell is gradable and the verdict is INCONCLUSIVE.
  // Before 3K1-M3 this exited 0 (a silent no-op gate); it must now fail the step.
  const uia = [
    { durationMs: 150, distance: 0.3, n: 12, median: 0.45, iqr: [0.175, 0.51] }, // uia floored
    { durationMs: 250, distance: 0.3, n: 12, median: 0.45, iqr: [0.42, 0.48] },
  ];
  const scr = [
    { durationMs: 150, distance: 0.3, n: 12, median: 0.46, iqr: [0.4, 0.5] },
    { durationMs: 250, distance: 0.3, n: 12, median: 0.46, iqr: [0.43, 0.49] },
  ];
  const off = [
    { durationMs: 150, distance: 0.3, n: 12, median: 0.46, iqr: [0.44, 0.5] },
    { durationMs: 250, distance: 0.3, n: 12, median: 0.46, iqr: [0.175, 0.49] }, // off floored
  ];
  fs.writeFileSync(path.join(out, "fling-block-ON-uiautomation.json"), JSON.stringify(flingBlock("ON-uiautomation", uia)));
  fs.writeFileSync(path.join(out, "fling-block-ON-scrcpy.json"), JSON.stringify(flingBlock("ON-scrcpy", scr, { pacing: "drift" })));
  fs.writeFileSync(path.join(out, "fling-block-OFF.json"), JSON.stringify(flingBlock("OFF", off)));
  const r = run(MERGE_FLING, out);
  assert.strictEqual(r.code, 1, r.stdout);
  assert.match(r.stdout, /FLING VERDICT: INCONCLUSIVE/);
  assert.match(r.stderr, /::error::fling parity gate INCONCLUSIVE.*3K1-M3/);
});

test("merge-fling: scrcpy/off and uia/off transparency + legacy→drift before/after are printed", () => {
  const out = freshOut();
  flingSet(out, {
    "150|0.3": [0.45, 0.46, 0.46, 0.47],
    "400|0.3": [0.50, 0.52, 0.51, 0.40], // legacy scrcpy under-scrolls (0.40) vs drift 0.52
  });
  const r = run(MERGE_FLING, out);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /scrcpy\/off/);
  assert.match(r.stdout, /uia\/off/);
  assert.match(r.stdout, /legacy\(default\) → drift\(opt-in\)/);
});

/* -- Pre-registered rule validated on the REAL artifacts of run 7 & 34800933407 -- */

const FIX = path.join(HERE, "fixtures");
function copyFixture(out, run) {
  const dir = path.join(FIX, run);
  for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(out, f));
}

test("merge-fling: PRE-REGISTERED rule stays RED on run 7 (33975063607) — 3 informative cells all FAIL", () => {
  const out = freshOut();
  copyFixture(out, "fling-run-33975063607");
  const r = run(MERGE_FLING, out);
  assert.strictEqual(r.code, 1, r.stdout);
  // 3 red cells: 250/0.3, 400/0.3, 400/0.5 (each fails ≥1 side); 3 non-informative.
  assert.match(
    r.stdout,
    /FLING VERDICT: FAIL \(per-cell ±0.15 on scrcpy\/uia AND scrcpy\/off, NO whitelist, over 3 informative cell\(s\); 3 of 6 non-informative at the metric floor\)/
  );
  assert.match(r.stdout, /d=250ms dist=0.3: scrcpy\/uia 0.908 dev 0.092 \| scrcpy\/off 0.712 dev 0.288 {2}OUT — FAIL/);
  assert.match(r.stdout, /d=400ms dist=0.3: scrcpy\/uia 0.717 dev 0.283/);
  assert.match(r.stdout, /d=400ms dist=0.5: scrcpy\/uia 0.71 dev 0.29/);
});

test("merge-fling: PRE-REGISTERED rule yields 3 PASS / 3 non-informative on run 34800933407", () => {
  const out = freshOut();
  copyFixture(out, "fling-run-34800933407");
  const r = run(MERGE_FLING, out);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(
    r.stdout,
    /FLING VERDICT: PASS \(per-cell ±0.15 on scrcpy\/uia AND scrcpy\/off, NO whitelist, over 3 informative cell\(s\); 3 of 6 non-informative at the metric floor\)/
  );
  // The reviewer's per-cell table (findings "Gate recommendation").
  assert.match(r.stdout, /d=250ms dist=0.3: scrcpy\/uia 0.97 dev 0.03 \| scrcpy\/off 0.983 dev 0.017 {2}OK/);
  assert.match(r.stdout, /d=400ms dist=0.3: scrcpy\/uia 1.019 dev 0.019 \| scrcpy\/off 0.886 dev 0.114 {2}OK/);
  assert.match(r.stdout, /d=400ms dist=0.5: scrcpy\/uia 1.085 dev 0.085 \| scrcpy\/off 0.967 dev 0.033 {2}OK/);
  // 150/0.3 non-informative on the reference bimodality AND the off power floor.
  assert.match(r.stdout, /d=150ms dist=0.3:.*off n=8 < 10/);
});

test("merge-fling: missing the drift arm FIRES (hard requirement)", () => {
  const out = freshOut();
  fs.writeFileSync(
    path.join(out, "fling-block-ON-uiautomation.json"),
    JSON.stringify(flingBlock("ON-uiautomation", [{ durationMs: 150, distance: 0.3, n: 12, median: 0.45, iqr: [0.45, 0.45] }]))
  );
  const r = run(MERGE_FLING, out);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr + r.stdout, /fling-block-ON-scrcpy\.json|needs/);
});

/* --------------------------------- scoreboard ----------------------------- */

test("scoreboard: 3n.1 gates reproduce the review's per-verb table (tap FAILs the inequality by 2, swipe/pinch win) vs proprietary", () => {
  const out = freshOut();
  writeBlocks(out, RUN2());
  assert.strictEqual(run(MERGE_BLOCKS, out, RUN2ENV).code, 0);
  const r = run(SCOREBOARD, out);
  assert.strictEqual(r.code, 0, r.stderr);
  // Measured floors (P1), never a constant ±2: tap |53−53|=0, swipe |307−300|=7,
  // pinch |351−356|=5, headline |445−548|=103.
  assert.match(r.stdout, /gesture-tap \| 86 \| 55 \| 53 \| 53 \| ±0 \|/);
  assert.match(r.stdout, /gesture-swipe \| 291 \| 268 \| 307 \| 300 \| ±7 \|/);
  assert.match(r.stdout, /gesture-pinch \| 340 \| 323 \| 351 \| 356 \| ±5 \|/);
  // Phase 3n.2 (review 3N1-H2): the DECISION RULE is the pre-registered point
  // inequality, not the retired `CI lo ≤ floor` rule. tap 55 vs max(OFF) 53 at floor
  // 0 → 55 > 53 → the inequality FAILS by 2 (the CI is reported, not the gate). This
  // is the honest verdict the review demanded; a planner's acceptance of the sub-floor
  // miss is a scoreboard note, never a PASS. swipe & pinch still WIN vs proprietary.
  assert.match(r.stdout, /\*\*P2\*\* — tap RPC non-inferior.*: \*\*FAIL by 2/);
  assert.match(r.stdout, /\*\*P3\*\* — swipe RPC non-inferior.*: \*\*PASS/);
  assert.match(r.stdout, /\*\*P4\*\* — pinch RPC non-inferior.*: \*\*PASS/);
  // Headline ratio ≤ 1.15 vs each OFF (400/445, 400/548, 400/496.5) → P5 PASS.
  assert.match(r.stdout, /\*\*P5\*\*.*: \*\*PASS/);
});

test("scoreboard: P1 — a verb with no OFF comparator floors as N/A, never ±2", () => {
  const out = freshOut();
  // Drop tap+describe from the OFF blocks so the headline row has no comparator.
  const bs = RUN2();
  for (const b of bs) if (b.block.block.startsWith("OFF")) b.block.verbs = b.block.verbs.filter((v) => !/tap\+describe/.test(v.verb));
  writeBlocks(out, bs);
  assert.strictEqual(run(MERGE_BLOCKS, out, RUN2ENV).code, 0);
  const r = run(SCOREBOARD, out);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /tap\+describe\(settle:false\).*\*\*N\/A\*\*/);
  assert.match(r.stdout, /\*\*P5\*\*.*: \*\*N\/A/);
});

test("merge-blocks: P0 — ON-input-manager without the ON-uiautomation control is VOID", () => {
  const out = freshOut();
  const bs = RUN2().filter((b) => b.block.block !== "ON-uiautomation");
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, { BENCH_BLOCKS: "OFF-1,ON-input-manager,ON-scrcpy,OFF-2" });
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /P0 VOID/);
});

test("scoreboard: 3n.1 gate FAILS when input-manager is distinguishably slower beyond the floor", () => {
  const out = freshOut();
  // input-manager swipe 340 vs OFF min 300, floor 7 → clearly slower beyond floor.
  writeBlocks(out, RUN2({ verbs: [mkVerb("gesture-tap", 55), mkVerb("gesture-swipe", 340), mkVerb("gesture-pinch", 323), mkVerb("tap+describe(settle:false)", 400)] }));
  assert.strictEqual(run(MERGE_BLOCKS, out, RUN2ENV).code, 0);
  const r = run(SCOREBOARD, out);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /\*\*P3\*\* — swipe RPC non-inferior.*: \*\*FAIL/);
});

test("merge-fling: 3n.1 instrument-first mode is REPORTED, never gating (P8)", () => {
  const out = freshOut();
  const flingArm = (name, cells, extra = {}) =>
    fs.writeFileSync(path.join(out, `fling-block-${name}.json`), JSON.stringify({ serial: "emulator-5554", N: 12, config: name, cells, ...extra }));
  const cell = (durationMs, distance, median, iqr) => ({ durationMs, distance, n: 12, median, iqr });
  // uia-A vs uia-B diverge wildly on an informative cell → INSTRUMENT-UNRESOLVED, exit 0.
  flingArm("ON-uia-A", [cell(250, 0.3, 0.45, [0.4, 0.5])]);
  flingArm("ON-uia-B", [cell(250, 0.3, 0.9, [0.85, 0.95])]);
  flingArm("ON-input-manager", [cell(250, 0.3, 0.46, [0.4, 0.5])]);
  flingArm("ON-scrcpy", [cell(250, 0.3, 0.3, [0.28, 0.32])], { pacing: "drift" });
  flingArm("OFF", [cell(250, 0.3, 0.46, [0.44, 0.5])]);
  const r = run(MERGE_FLING, out);
  assert.strictEqual(r.code, 0, r.stderr); // NEVER gating (P8)
  assert.match(r.stdout, /INSTRUMENT VERDICT: INSTRUMENT-UNRESOLVED/);
  assert.match(r.stdout, /NEVER gating/);
});

test("scoreboard: locate source (F5) + no-effect identities (F7) are rendered", () => {
  const out = freshOut();
  const bs = FOUR();
  bs[2].block.effectZeroTotal = 1;
  bs[2].block.firstTapNoEffectTotal = 1;
  bs[2].block.noEffectSamples = ["i=7 verb='tap+describe(settle:false)' tapMs=41 coord=(0.5000,0.3200) via=describe originFp='act:Settings' finalFp='act:Settings'"];
  writeBlocks(out, bs);
  assert.strictEqual(run(MERGE_BLOCKS, out, ALLENV).code, 0);
  const r = run(SCOREBOARD, out);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /Locate source & no-effect taps/);
  assert.match(r.stdout, /only the effect fingerprint .*is backend-independent/i);
  assert.match(r.stdout, /i=7 verb=/);
});
