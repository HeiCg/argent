// Unit tests for the iOS bench merge GATES (iOS-2.1, review IOS2-M4/M9/H3). The
// merge (merge-blocks-ios.js) reads $BENCH_OUT/bench-block-*.json and exits
// non-zero on a violation. These tests write synthetic block JSONs into a
// throwaway BENCH_OUT and assert the merge's exit code + message, so the new
// gates (per-verb errors, short latency runs `n < N`, runner crashes, tap-coord
// drift) each have a firing / non-firing proof with no device run.
//
// Run: node --test .github/bench-ci/gates-ios.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HERE = __dirname;
const MERGE = path.join(HERE, "merge-blocks-ios.js");

function freshOut() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bench-ios-gate-"));
}

/** Run the merge; return { code, stdout, stderr }. Never throws on non-zero. */
function run(out, extraEnv = {}) {
  try {
    const stdout = execFileSync("node", [MERGE], {
      env: { ...process.env, BENCH_OUT: out, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") };
  }
}

const N = 20;
const samples = (v) => Array.from({ length: N }, () => v);

/** One measured verb with a full N-length latency sample and no errors. */
function verb(name, over = {}) {
  return {
    verb: name,
    latency: { n: N, p50: 100, p95: 120, max: 130, min: 90, mean: 100 },
    latencySamples: samples(100),
    errors: 0,
    errorSamples: [],
    locateFailed: 0,
    ...over,
  };
}
/** An N/A verb (no product path) — exempt from the measured-verb gates. */
function naVerb(name) {
  return { verb: name, latency: { n: 0 }, latencySamples: [], errors: 0, extra: { na: "N/A" } };
}

/** A healthy per-block file. Override any field of `.block`. */
function block(name, over = {}) {
  const isOff = name.startsWith("OFF");
  const measured = [
    verb("describe"),
    verb("gesture-tap", { effectChecked: N, effectZero: 0 }),
    verb("tap+describe"),
    verb("gesture-swipe"),
  ];
  const awaits = isOff
    ? [verb("await-screen-idle"), verb("await-ui-element")]
    : [naVerb("await-screen-idle"), naVerb("await-ui-element")];
  return {
    env: { N, runId: "test", sha: "deadbeef" },
    block: {
      block: name,
      config: isOff ? "OFF" : "ON",
      treeBackend: isOff ? "ax-service" : "xcuitest",
      inputIsProductTool: name !== "ON-siminput",
      hasAwaitProduct: isOff,
      gestureParams: {
        tapHoldMs: 0,
        swipeDurationMs: 250,
        swipeSteps: 12,
        swipeMomentumFree: true,
      },
      verbs: [...measured, ...awaits, naVerb("paste"), naVerb("gesture-pinch")],
      describe: {
        backend: isOff ? "ax-service" : "xcuitest",
        source: isOff ? "ax-service" : "xcuitest-runner",
        elements: isOff ? 30 : 54,
        bytes: 2744,
        tokens: isOff ? 1126 : 1775,
        tokensCharsDiv4: 900,
        cap: 400,
        capElements: isOff ? 30 : 54,
        capTokens: isOff ? 1126 : 1775,
      },
      describeStages: isOff
        ? null
        : { n: N, maxDelta: 0.003, samples: [{ delta: 0.003, sum: 100, captureMs: 100 }] },
      scroll: {
        arm: name,
        unit: "screen-points",
        rasterScale: 3,
        offsetsPoints: [40, 42, 41],
        median: 41,
        q1: 40,
        q3: 42,
        iqr: 2,
        refusals: 0,
        n: 3,
        records: [],
      },
      oracle: {
        selfTestPassed: true,
        target: "General",
        navDiff: 0.18,
        rootDiff: 0.004,
        navMin: 0.1,
        landingThreshold: 0.09,
        note: "ok",
      },
      effectCheckedTotal: N,
      firstTapNoEffectTotal: 0,
      effectZeroTotal: 0,
      locateFailedTotal: 0,
      landingRate: 1,
      medianTapCoord: { x: 0.5, y: 0.42 },
      tapRecords: [],
      noEffectSamples: [],
      simInputAckTimeouts: 0,
      runnerCrashes: 0,
      degradedReasons: [],
      fidelitySet: ["id:General", "text:General"],
      notes: [],
    },
    ...over,
  };
}

function writeBlocks(out, blocks) {
  for (const b of blocks) {
    fs.writeFileSync(path.join(out, `bench-block-${b.block.block}.json`), JSON.stringify(b));
  }
}
const ALL = () => [block("OFF-1"), block("ON-xcuitest"), block("ON-siminput"), block("OFF-2")];

test("healthy four blocks: all gates green, exit 0", () => {
  const out = freshOut();
  writeBlocks(out, ALL());
  const r = run(out);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /G0\/G1\/G3 \+ gesture-drift gates: OK/);
});

test("M4: a verb that errors fails the merge", () => {
  const out = freshOut();
  const blocks = ALL();
  const off1 = blocks[0].block;
  off1.verbs.find((v) => v.verb === "gesture-swipe").errors = 20;
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /M4: OFF-1 verb "gesture-swipe" errors=20/);
});

test("M4: a short latency run (n < N) fails the merge", () => {
  const out = freshOut();
  const blocks = ALL();
  const onx = blocks[1].block;
  onx.verbs.find((v) => v.verb === "describe").latencySamples = samples(100).slice(0, 12);
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /M4: ON-xcuitest verb "describe" latencySamples=12 != N=20/);
});

test("M4: a locate miss (locateFailedTotal) fails the merge", () => {
  const out = freshOut();
  const blocks = ALL();
  blocks[2].block.locateFailedTotal = 3;
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /M4: ON-siminput locateFailedTotal=3/);
});

test("M4: a block note fails the merge (masked fallback)", () => {
  const out = freshOut();
  const blocks = ALL();
  blocks[1].block.notes = [
    'describe.source="ax-service" (expected xcuitest-runner) — masked fallback',
  ];
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /M4: ON-xcuitest carries notes/);
});

test("M9: a runner crash fails the merge (crashCount now real)", () => {
  const out = freshOut();
  const blocks = ALL();
  blocks[1].block.runnerCrashes = 2;
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /G1: ON-xcuitest runnerCrashes=2/);
});

test("H3: tap-coordinate drift across arms fails the merge", () => {
  const out = freshOut();
  const blocks = ALL();
  // ON-siminput aimed a long way from where OFF located "General".
  blocks[2].block.medianTapCoord = { x: 0.62, y: 0.85 };
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /H3: tap coordinate drift/);
});

test("N/A await verbs on the ON arms do NOT trip the n < N gate", () => {
  const out = freshOut();
  // ON blocks carry await-* as N/A (empty samples); the healthy run is green,
  // proving the measured-verb gates skip `extra.na` rows.
  writeBlocks(out, ALL());
  const r = run(out);
  assert.equal(r.code, 0, r.stderr);
});
