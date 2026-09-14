// Unit tests for the CI bench GATES (review: "gates never observed to fire").
// Each gate script (merge-blocks.js, scoreboard.js) is a standalone
// Node program that reads $BENCH_OUT/*.json and exits non-zero on a violation. These
// tests write synthetic block JSONs into a throwaway BENCH_OUT and assert the
// script's exit code + message, so tap-timeline parity, oracle self-test, vacuous-arm,
// degraded-arm, redir, zero-fallback, landing-rate and missing-ON all have a
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
      // Phase 3n.3 (3N2-H1): every ON block carries the on-device per-strategy counts
      // from getInfo. The input-manager arm reads all-input-manager with no unavailable
      // key; the UiAutomation control reads all-default. The fallback gate reads these.
      ...(isOff
        ? {}
        : {
            injectStrategyCounts: name === "ON-uiautomation" ? { default: 161 } : { "input-manager": 161 },
            injectStrategyTotal: 161,
            measuredInjectRpcs: 100,
          }),
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
// Phase 3n.2 (scrcpy removed): the FOUR run-2 blocks with run-34853156073's measured
// p50s (input-manager, OFF) plus a plausible ON-uiautomation control — reproduces the
// review's per-verb table: tap FAILs the inequality by 2, swipe win, pinch win,
// headline parity/win at floor 103.
const RUN2 = (over = {}) => [
  block31("OFF-1", { tap: 53, swipe: 307, pinch: 351, headline: 445 }),
  block31("ON-uiautomation", { tap: 86, swipe: 291, pinch: 340, headline: 422 }),
  block31("ON-input-manager", { tap: 55, swipe: 268, pinch: 323, headline: 400 }, over),
  block31("OFF-2", { tap: 53, swipe: 300, pinch: 356, headline: 548 }),
];
const RUN2ENV = { BENCH_BLOCKS: "OFF-1,ON-uiautomation,ON-input-manager,OFF-2" };

const FOUR = () => [block("OFF-1"), block("ON-uiautomation"), block("ON-input-manager"), block("OFF-2")];
const ALLENV = { BENCH_BLOCKS: "OFF-1,ON-uiautomation,ON-input-manager,OFF-2" };

/* ------------------------------- merge-blocks ----------------------------- */

test("merge-blocks: healthy four-block run passes", () => {
  const out = freshOut();
  writeBlocks(out, FOUR());
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /blocks merged: OFF-1, ON-uiautomation, ON-input-manager, OFF-2/);
});

test("merge-blocks: tap-timeline parity FIRES on a MOVE frame", () => {
  const out = freshOut();
  const bs = FOUR();
  bs[2].block.injectedTapTimeline = { holdMs: 50, frameCount: 3, hasMoveFrame: true, backend: "ON-input-manager" };
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

test("merge-blocks: fallback gate FIRES on on-device injectStrategyCounts.unavailable (3n.3)", () => {
  const out = freshOut();
  const bs = FOUR();
  // bs[2] is ON-input-manager: 11 of 161 injections fell back to uia-async on-device
  // (hiddenapi). The AUTHORITATIVE signal is injectStrategyCounts.unavailable, NOT the
  // dead host `verb.fallbacks` counter (structurally 0 after the scrcpy removal, 3N2-H1).
  bs[2].block.injectStrategyCounts = { "input-manager": 150, unavailable: 11 };
  bs[2].block.injectStrategyTotal = 161;
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /fell back to uia-async on 11\/161/);
});

test("merge-blocks: fallback gate does NOT fire on host verb.fallbacks (the dead counter, 3n.3)", () => {
  const out = freshOut();
  const bs = FOUR();
  // The dead host counter reads non-zero but the on-device counts are clean — the run
  // is a clean input-manager arm. The old gate would have fired here; the new one must not.
  bs[2].block.verbs = [{ verb: "gesture-tap", latency: { p50: 52, p95: 54 }, errors: 0, fallbacks: 2 }];
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /on-device inject fallbacks .*: 0\/161 \(gate 0\) — OK/);
});

test("merge-blocks: fallback gate FIRES on a missing/zero on-device inject denominator (3n.3)", () => {
  const out = freshOut();
  const bs = FOUR();
  // The counter never ran (getInfo unread / absent counter): no denominator, so the run
  // cannot certify a clean input-manager arm.
  bs[2].block.injectStrategyCounts = {};
  bs[2].block.injectStrategyTotal = 0;
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /NO on-device injections/);
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

test("merge-blocks: a 1/60 input-manager async drop does NOT fire the landing gate", () => {
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
  writeBlocks(out, [block("OFF-1"), block("ON-uiautomation"), block("OFF-2")]); // ON-input-manager missing
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /missing required ON block/);
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
  const r = run(MERGE_BLOCKS, out, { BENCH_BLOCKS: "OFF-1,ON-input-manager,OFF-2" });
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
