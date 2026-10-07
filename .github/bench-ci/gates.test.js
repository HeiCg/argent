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

// Review 2026-10-07 finding 1: blocks run OFF-1, ON-uiautomation, ON-input-manager,
// OFF-2, OFF-legacy, and the merge asserts that order from each block's env.startedAt.
// Fixtures carry start times in that order, one minute apart.
const ORDER = ["OFF-1", "ON-uiautomation", "ON-input-manager", "OFF-2", "OFF-legacy"];
const startOf = (name) =>
  new Date(Date.UTC(2026, 9, 7, 18, 0) + ORDER.indexOf(name) * 60_000).toISOString();

/** A healthy per-block file. Override any field of `.block`. */
function block(name, over = {}) {
  const isOff = name.startsWith("OFF");
  return {
    env: { ...ENV, startedAt: startOf(name) },
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
            injectStrategyCounts:
              name === "ON-uiautomation" ? { default: 161 } : { "input-manager": 161 },
            injectStrategyTotal: 161,
            measuredInjectRpcs: 100,
            // Review 2026-10-07 finding 3: host-issued gesture tool calls this block.
            // Q4 requires the on-device counter to match it exactly.
            expectedInjectRpcs: 161,
          }),
      ...over,
    },
  };
}

function writeBlocks(out, blocks) {
  for (const b of blocks)
    fs.writeFileSync(path.join(out, `bench-block-${b.block.block}.json`), JSON.stringify(b));
}

// Phase 3n.1 fixture helpers: a verb with a per-sample array symmetric around p50
// (median == p50 exactly), so the scoreboard's seeded bootstrap CI is deterministic.
function mkVerb(verb, p50, over = {}) {
  const s = [];
  for (let i = -8; i <= 8; i++) s.push(p50 + i); // 17 samples, median == p50, ±8 spread
  return {
    verb,
    latency: { p50, p95: p50 + 8 },
    latencySamples: s,
    errors: 0,
    fallbacks: 0,
    ...over,
  };
}
// A 3n.1 latency block with the four gated verbs. v = {tap, swipe, pinch, headline}.
function block31(name, v, over = {}) {
  const verbs = [
    mkVerb("gesture-tap", v.tap),
    mkVerb("gesture-swipe", v.swipe),
    mkVerb("gesture-pinch", v.pinch),
  ];
  if (v.headline != null) {
    verbs.push(
      mkVerb(name.startsWith("OFF") ? "tap+describe" : "tap+describe(settle:false)", v.headline)
    );
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

const FOUR = () => [
  block("OFF-1"),
  block("ON-uiautomation"),
  block("ON-input-manager"),
  block("OFF-2"),
];
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
  bs[2].block.injectedTapTimeline = {
    holdMs: 50,
    frameCount: 3,
    hasMoveFrame: true,
    backend: "ON-input-manager",
  };
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
  bs[2].block.injectStrategyCounts = { "input-manager": 150, "unavailable": 11 };
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
  bs[2].block.verbs = [
    { verb: "gesture-tap", latency: { p50: 52, p95: 54 }, errors: 0, fallbacks: 2 },
  ];
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

/* ------------------------- proprietary provenance -------------------------- */
// Re-baseline (0.27): every OFF block records which proprietary release it ran
// (npm version + sha256 of each binary/APK used). The merge refuses to pool two OFF
// blocks of different provenance as one arm; OFF-legacy is its own arm with a Δ row.

const PROVENANCE = path.join(HERE, "proprietary-provenance.js");

/** A synthetic npm provenance record for `version`; `tag` perturbs the hashes. */
function prov(version, tag = version) {
  const h = (s) => require("crypto").createHash("sha256").update(s).digest("hex");
  return {
    source: "npm",
    package: "@swmansion/argent",
    version,
    files: {
      "linux/simulator-server": h(`sim-${tag}`),
      "argent-android-devtools-0.1.0.apk": h(`apk-${tag}`),
    },
  };
}
const withProv = (b, p) => {
  b.block.proprietaryProvenance = p;
  return b;
};
const FIVE = (cur = prov("0.27.0"), leg = prov("0.22.1")) => [
  withProv(block31("OFF-1", { tap: 53, swipe: 307, pinch: 351, headline: 445 }), cur),
  block31("ON-uiautomation", { tap: 86, swipe: 291, pinch: 340, headline: 422 }),
  block31("ON-input-manager", { tap: 55, swipe: 268, pinch: 323, headline: 400 }),
  withProv(block31("OFF-2", { tap: 53, swipe: 300, pinch: 356, headline: 548 }), cur),
  withProv(block31("OFF-legacy", { tap: 60, swipe: 330, pinch: 351, headline: 470 }), leg),
];
const FIVEENV = { BENCH_BLOCKS: "OFF-1,ON-uiautomation,ON-input-manager,OFF-2,OFF-legacy" };
const mergedOf = (r) => {
  const m = r.stdout.match(/MERGED_JSON=(.+)/);
  assert.ok(m, "merge printed no MERGED_JSON line: " + r.stdout);
  return JSON.parse(fs.readFileSync(m[1].trim(), "utf8"));
};

test("provenance: sha256File hashes a temp file", () => {
  const { sha256File } = require(PROVENANCE);
  const dir = freshOut();
  const f = path.join(dir, "bin");
  fs.writeFileSync(f, "hello\n");
  assert.strictEqual(
    sha256File(f),
    "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
  );
});

/** A fake extracted `npm pack` tree: package/{package.json,bin/...}. */
function fakePkg(version, layout = "0.27") {
  const root = path.join(freshOut(), "package");
  const bin = path.join(root, "bin");
  fs.mkdirSync(path.join(bin, "linux"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@swmansion/argent", version })
  );
  fs.writeFileSync(path.join(bin, "linux", "simulator-server"), `sim ${version}`);
  fs.writeFileSync(path.join(bin, "argent-android-devtools-0.1.0.apk"), `apk ${version}`);
  // 0.22.x kept the screen-sharing agent per platform; 0.27 shares one copy at bin/.
  const res =
    layout === "0.27"
      ? path.join(bin, "resources", "android")
      : path.join(bin, "linux", "resources", "android");
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(res, "screen-sharing-agent.jar"), `jar ${version}`);
  return { root, bin };
}

test("provenance: npmProvenance reads the version and hashes every binary/APK used", () => {
  const { npmProvenance, sha256File } = require(PROVENANCE);
  const { bin } = fakePkg("0.27.0");
  const p = npmProvenance({ simDir: bin, platformKey: "linux", apkVersionName: "0.1.0" });
  assert.strictEqual(p.source, "npm");
  assert.strictEqual(p.package, "@swmansion/argent");
  assert.strictEqual(p.version, "0.27.0");
  assert.deepStrictEqual(Object.keys(p.files).sort(), [
    "argent-android-devtools-0.1.0.apk",
    "linux/simulator-server",
    "resources/android/screen-sharing-agent.jar",
  ]);
  assert.strictEqual(
    p.files["linux/simulator-server"],
    sha256File(path.join(bin, "linux", "simulator-server"))
  );
  // 0.22.x layout: resources under bin/linux/ (simulatorServerRunDir's fallback).
  const legacy = fakePkg("0.22.1", "0.22");
  const lp = npmProvenance({ simDir: legacy.bin, platformKey: "linux", apkVersionName: "0.1.0" });
  assert.ok(lp.files["linux/resources/android/screen-sharing-agent.jar"]);
  assert.notStrictEqual(lp.files["linux/simulator-server"], p.files["linux/simulator-server"]);
});

test("provenance: npmProvenance refuses a package whose version is not the expected one", () => {
  const { npmProvenance } = require(PROVENANCE);
  const { bin } = fakePkg("0.22.1");
  assert.throws(
    () => npmProvenance({ simDir: bin, platformKey: "linux", expectVersion: "0.27.0" }),
    /0\.22\.1.*expected 0\.27\.0/
  );
});

test("provenance: `stamp` CLI writes the provenance into an OFF block JSON from its own env dirs", () => {
  const { bin } = fakePkg("0.27.0");
  const out = freshOut();
  const b = block("OFF-1");
  b.env = { ...b.env, simulatorServerDir: bin, devtoolsAndroidBinDir: bin };
  const f = path.join(out, "bench-block-OFF-1.json");
  fs.writeFileSync(f, JSON.stringify(b));
  execFileSync(
    "node",
    [PROVENANCE, "stamp", f, "--expect-version", "0.27.0", "--platform-key", "linux"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const stamped = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.strictEqual(stamped.block.proprietaryProvenance.version, "0.27.0");
  assert.ok(stamped.block.proprietaryProvenance.files["linux/simulator-server"]);
});

test("merge-blocks: OFF blocks with different provenance are NOT pooled — fails naming both versions", () => {
  const out = freshOut();
  const bs = FOUR();
  withProv(bs[0], prov("0.27.0"));
  withProv(bs[3], prov("0.22.1"));
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /provenance/);
  assert.match(r.stderr, /0\.27\.0/);
  assert.match(r.stderr, /0\.22\.1/);
});

test("merge-blocks: same version but a different binary sha256 is a different arm too", () => {
  const out = freshOut();
  const bs = FOUR();
  withProv(bs[0], prov("0.27.0"));
  withProv(bs[3], prov("0.27.0", "rebuilt"));
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /sha256/);
});

test("merge-blocks: a known and an unknown OFF provenance are not pooled either", () => {
  const out = freshOut();
  const bs = FOUR();
  withProv(bs[0], prov("0.27.0"));
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /unknown/);
});

test("merge-blocks: OFF-legacy is its own arm with a Δ row vs the current OFF", () => {
  const out = freshOut();
  writeBlocks(out, FIVE());
  const r = run(MERGE_BLOCKS, out, FIVEENV);
  assert.strictEqual(r.code, 0, r.stderr);
  const m = mergedOf(r);
  assert.ok(m.blocksRan.includes("OFF-legacy"));
  assert.strictEqual(m.legacyArm.block, "OFF-legacy");
  assert.strictEqual(m.legacyArm.version, "0.22.1");
  assert.strictEqual(m.legacyArm.currentVersion, "0.27.0");
  const tap = m.legacyArm.deltaVsCurrent.find((d) => d.verb === "gesture-tap");
  // legacy 60 vs pooled current (53+53)/2 = 53 → Δ +7.
  assert.deepStrictEqual(
    { legacy: tap.legacy.p50, current: tap.current.p50, delta: tap.delta },
    { legacy: 60, current: 53, delta: 7 }
  );
});

test("merge-blocks: provenance appears in the merged output (per block + current + legacy)", () => {
  const out = freshOut();
  writeBlocks(out, FIVE());
  const r = run(MERGE_BLOCKS, out, FIVEENV);
  assert.strictEqual(r.code, 0, r.stderr);
  const m = mergedOf(r);
  assert.strictEqual(m.proprietaryProvenance.current.version, "0.27.0");
  assert.strictEqual(m.proprietaryProvenance.legacy.version, "0.22.1");
  assert.strictEqual(m.proprietaryProvenance.byBlock["OFF-1"].version, "0.27.0");
  assert.strictEqual(m.proprietaryProvenance.byBlock["OFF-2"].version, "0.27.0");
  assert.strictEqual(m.proprietaryProvenance.byBlock["OFF-legacy"].version, "0.22.1");
  assert.ok(m.proprietaryProvenance.current.files["linux/simulator-server"]);
});

test("merge-blocks: old fixtures with NO provenance still merge (all OFF unknown)", () => {
  const out = freshOut();
  writeBlocks(out, FOUR());
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 0, r.stderr);
  const m = mergedOf(r);
  assert.strictEqual(m.proprietaryProvenance.current, "unknown");
  assert.strictEqual(m.proprietaryProvenance.legacy, null);
  assert.strictEqual(m.legacyArm, null);
});

test("merge-blocks: current OFF provenance must match BENCH_PROPRIETARY_VERSION when set", () => {
  const out = freshOut();
  writeBlocks(out, FIVE());
  const r = run(MERGE_BLOCKS, out, { ...FIVEENV, BENCH_PROPRIETARY_VERSION: "0.26.0" });
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /expected 0\.26\.0/);
});

/* --------------------------------- scoreboard ----------------------------- */

test("scoreboard: renders 'Proprietary baseline: <legacy> vs <current>' with p50/p95, Δ and CI", () => {
  const out = freshOut();
  writeBlocks(out, FIVE());
  assert.strictEqual(run(MERGE_BLOCKS, out, FIVEENV).code, 0);
  const r = run(SCOREBOARD, out);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /### Proprietary baseline: 0\.22\.1 vs 0\.27\.0/);
  // tap: legacy 60/68, OFF-1 53/61, OFF-2 53/61, floor 0, Δ +7, CI, reading.
  assert.match(r.stdout, /\| gesture-tap \| 60\/68 \| 53\/61 \| 53\/61 \| ±0 \| 7 \| \[-?\d/);
  // Provenance is rendered per OFF block.
  assert.match(r.stdout, /### Proprietary provenance/);
  assert.match(r.stdout, /OFF-legacy \| @swmansion\/argent@0\.22\.1/);
  // The P-gates still grade against the CURRENT OFF blocks, never OFF-legacy.
  assert.match(r.stdout, /gesture-tap \| 86 \| 55 \| 53 \| 53 \| ±0 \|/);
});

test("scoreboard: no legacy block → no baseline section, provenance reads unknown", () => {
  const out = freshOut();
  writeBlocks(out, RUN2());
  assert.strictEqual(run(MERGE_BLOCKS, out, RUN2ENV).code, 0);
  const r = run(SCOREBOARD, out);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Proprietary baseline:/);
  assert.match(r.stdout, /OFF-1 \| unknown/);
});

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
  for (const b of bs)
    if (b.block.block.startsWith("OFF"))
      b.block.verbs = b.block.verbs.filter((v) => !/tap\+describe/.test(v.verb));
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
  writeBlocks(
    out,
    RUN2({
      verbs: [
        mkVerb("gesture-tap", 55),
        mkVerb("gesture-swipe", 340),
        mkVerb("gesture-pinch", 323),
        mkVerb("tap+describe(settle:false)", 400),
      ],
    })
  );
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
  bs[2].block.noEffectSamples = [
    "i=7 verb='tap+describe(settle:false)' tapMs=41 coord=(0.5000,0.3200) via=describe originFp='act:Settings' finalFp='act:Settings'",
  ];
  writeBlocks(out, bs);
  assert.strictEqual(run(MERGE_BLOCKS, out, ALLENV).code, 0);
  const r = run(SCOREBOARD, out);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /Locate source & no-effect taps/);
  assert.match(r.stdout, /only the effect fingerprint .*is backend-independent/i);
  assert.match(r.stdout, /i=7 verb=/);
});

// ── Fling merge (ticket 3o): self-test-first, report-only ────────────────────
const MERGE_FLING = path.join(HERE, "merge-fling.js");
const FLING_CELLS = [150, 250, 400].flatMap((d) =>
  [0.3, 0.5].map((dist) => ({ durationMs: d, distance: dist }))
);

// A fling block whose every cell has `n` samples with a chosen median (px). Samples
// are spread ±3 px around the target so the median is exactly the target and the
// permutation test has a real distribution. `medFor(durationMs,distance)` overrides.
function flingBlock(name, strategy, medFor, n = 16) {
  return {
    serial: "emulator-5554",
    N: 16,
    config: name,
    injectStrategy: strategy,
    openServer: strategy !== null,
    mode: "interleaved-optical",
    metric: "optical-scroll-px",
    cells: FLING_CELLS.map((c) => {
      const med = medFor(c.durationMs, c.distance);
      const samples = [];
      for (let i = 0; i < n; i++) {
        const off = med + ((i % 7) - 3); // symmetric-ish spread, median == med for odd/even n
        samples.push({ offsetPx: off, confidence: 0.99, peakShift: Math.round(off) });
      }
      // Force an exact median: sort-insert the target as the middle element set.
      const offs = samples.map((s) => s.offsetPx).sort((a, b) => a - b);
      const mid = Math.floor(offs.length / 2);
      // rewrite samples so the median equals `med` exactly
      const fixed = offs.map((_, i) => ({
        offsetPx: med + (i - mid),
        confidence: 0.99,
        peakShift: med,
      }));
      return {
        durationMs: c.durationMs,
        distance: c.distance,
        config: name,
        n,
        medianPx: med,
        iqrPx: [med - 3, med + 3],
        samples: fixed,
        drops: [],
      };
    }),
  };
}
function writeFling(out, blocks) {
  for (const b of blocks)
    fs.writeFileSync(path.join(out, `fling-block-${b.config}.json`), JSON.stringify(b));
}

test("merge-fling: self-test OK grades arms; input-manager parity → PASS, always exit 0", () => {
  const out = freshOut();
  const same = () => 500; // identical medians everywhere
  writeFling(out, [
    flingBlock("ON-uia-A", "default", same),
    flingBlock("ON-uia-B", "default", same),
    flingBlock("ON-uiautomation", "default", same),
    flingBlock("ON-input-manager", "input-manager", () => 505),
    flingBlock("OFF", null, () => 500),
  ]);
  const r = run(MERGE_FLING, out);
  assert.strictEqual(r.code, 0, r.stderr); // report-only: always exit 0
  assert.match(r.stdout, /SELF-TEST VERDICT: INSTRUMENT-OK/);
  assert.match(r.stdout, /ON-input-manager VERDICT: PASS/);
  assert.match(r.stdout, /does NOT significantly under-scroll/);
});

test("merge-fling: uia-A vs uia-B divergence > 5% → INSTRUMENT-UNRESOLVED, no arm graded", () => {
  const out = freshOut();
  writeFling(out, [
    flingBlock("ON-uia-A", "default", () => 500),
    flingBlock("ON-uia-B", "default", () => 560), // +12% divergence
    flingBlock("ON-uiautomation", "default", () => 500),
    flingBlock("ON-input-manager", "input-manager", () => 500),
    flingBlock("OFF", null, () => 500),
  ]);
  const r = run(MERGE_FLING, out);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /SELF-TEST VERDICT: INSTRUMENT-UNRESOLVED/);
  assert.match(r.stdout, /NO arm is graded/);
  assert.doesNotMatch(r.stdout, /ON-input-manager VERDICT:/);
});

test("merge-fling: an underpowered self-test cell (n<12) → INSTRUMENT-UNRESOLVED", () => {
  const out = freshOut();
  writeFling(out, [
    flingBlock("ON-uia-A", "default", () => 500, 8), // n=8 < 12
    flingBlock("ON-uia-B", "default", () => 500, 8),
    flingBlock("ON-uiautomation", "default", () => 500),
    flingBlock("ON-input-manager", "input-manager", () => 500),
    flingBlock("OFF", null, () => 500),
  ]);
  const r = run(MERGE_FLING, out);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /INSTRUMENT-UNRESOLVED/);
  assert.match(r.stdout, /UNDERPOWERED/);
});

test("merge-fling: input-manager under-scroll vs proprietary is detected (ratio<1, p<0.05)", () => {
  const out = freshOut();
  writeFling(out, [
    flingBlock("ON-uia-A", "default", () => 500),
    flingBlock("ON-uia-B", "default", () => 500),
    flingBlock("ON-uiautomation", "default", () => 500),
    flingBlock("ON-input-manager", "input-manager", () => 300), // 0.6× → under-scroll
    flingBlock("OFF", null, () => 500),
  ]);
  const r = run(MERGE_FLING, out);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /SELF-TEST VERDICT: INSTRUMENT-OK/);
  assert.match(
    r.stdout,
    /UNDER-SCROLL: input-manager under-scrolls vs proprietary on \d+ powered cell/
  );
  assert.match(r.stdout, /ON-input-manager VERDICT: FAIL/); // 0.6 ratio is outside ±0.15
});

/* ------------------- emulator lost: partial merge + emulator record ------------------- */
// 2026-10-04 (runs 37213141861 / 37215518035): the emulator died mid-run. The latency
// merge must still produce a merged JSON + scoreboard for the blocks that completed,
// marked partial, instead of dying on "missing required ON block" / "P0 VOID". The
// emulator/host record (ci-emulator-env.json) is embedded as `emulator`; old fixtures
// without it still merge.

const LOST = {
  lostAt: "2026-10-04T16:38:40Z",
  reason: "adb get-state failed 3 consecutive checks (last: error: closed)",
  context: "block ON-uiautomation",
  serial: "emulator-5554",
};
const EMU_ENV = {
  emulator: {
    version: "37.2.12.0",
    buildId: "16428233",
    pinnedBuild: null,
    gpu: "swiftshader_indirect",
  },
  systemImage: { package: "system-images;android-34;google_apis;x86_64", revision: "14" },
  adb: { version: "1.0.41", platformTools: "36.0.0-13206524" },
  runnerImage: { os: "ubuntu24", version: "20260927.320.1" },
  kernel: "6.11.0-1018-azure",
  nproc: 4,
};
function writeLost(out) {
  const p = path.join(out, "emulator-lost.json");
  fs.writeFileSync(p, JSON.stringify(LOST));
  return p;
}

test("merge-blocks: emulator lost -> merged JSON for the completed blocks, marked partial", () => {
  const out = freshOut();
  // Run 37215518035's shape: OFF-1 and the self-orchestrated ON-input-manager done,
  // the emulator died inside ON-uiautomation (no file), OFF-2/OFF-legacy never ran.
  writeBlocks(out, [block("OFF-1"), block("ON-input-manager")]);
  const r = run(MERGE_BLOCKS, out, { ...ALLENV, BENCH_EMULATOR_LOST_FILE: writeLost(out) });
  assert.strictEqual(r.code, 0, r.stderr);
  const m = mergedOf(r);
  assert.strictEqual(m.partial, true);
  assert.deepStrictEqual(m.blocksRan, ["OFF-1", "ON-input-manager"]);
  assert.deepStrictEqual(m.missingBlocks, ["ON-uiautomation", "OFF-2"]);
  assert.strictEqual(m.emulatorLost.lostAt, "2026-10-04T16:38:40Z");
  assert.match(r.stdout, /PARTIAL/);
});

test("merge-blocks: emulator lost before any block completed -> minimal partial JSON", () => {
  const out = freshOut();
  const r = run(MERGE_BLOCKS, out, { ...ALLENV, BENCH_EMULATOR_LOST_FILE: writeLost(out) });
  assert.strictEqual(r.code, 0, r.stderr);
  const m = mergedOf(r);
  assert.strictEqual(m.partial, true);
  assert.deepStrictEqual(m.blocksRan, []);
});

test("merge-blocks: without the emulator-lost marker the completeness gates still FIRE", () => {
  const out = freshOut();
  writeBlocks(out, [block("OFF-1"), block("ON-input-manager")]);
  const r = run(MERGE_BLOCKS, out, {
    ...ALLENV,
    BENCH_EMULATOR_LOST_FILE: path.join(out, "absent.json"),
  });
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /missing required ON block/);
});

test("merge-blocks: ci-emulator-env.json is embedded as `emulator`; absent -> null", () => {
  const out = freshOut();
  writeBlocks(out, FOUR());
  fs.writeFileSync(path.join(out, "ci-emulator-env.json"), JSON.stringify(EMU_ENV));
  const m = mergedOf(run(MERGE_BLOCKS, out, ALLENV));
  assert.strictEqual(m.emulator.emulator.version, "37.2.12.0");
  assert.strictEqual(m.partial, false);
  const old = freshOut();
  writeBlocks(old, FOUR());
  const m2 = mergedOf(run(MERGE_BLOCKS, old, ALLENV));
  assert.strictEqual(m2.emulator, null);
});

test("scoreboard: PARTIAL banner + emulator rows; old merged JSON without them still renders", () => {
  const out = freshOut();
  writeBlocks(out, [block("OFF-1"), block("ON-input-manager")]);
  fs.writeFileSync(path.join(out, "ci-emulator-env.json"), JSON.stringify(EMU_ENV));
  const r = run(MERGE_BLOCKS, out, { ...ALLENV, BENCH_EMULATOR_LOST_FILE: writeLost(out) });
  assert.strictEqual(r.code, 0, r.stderr);
  const sb = run(SCOREBOARD, out);
  assert.strictEqual(sb.code, 0, sb.stderr);
  assert.match(
    sb.stdout,
    /PARTIAL — emulator lost at 2026-10-04T16:38:40Z \(block ON-uiautomation\)/
  );
  assert.match(sb.stdout, /missing: ON-uiautomation, OFF-2/);
  assert.match(sb.stdout, /\| emulator \| 37\.2\.12\.0 \(build 16428233\) \|/);
  assert.match(sb.stdout, /\| runner image \| 20260927\.320\.1 \|/);
  // An old merged JSON (no partial / emulator keys) still renders, with no banner.
  const old = freshOut();
  writeBlocks(old, FOUR());
  const m = mergedOf(run(MERGE_BLOCKS, old, ALLENV));
  const raw = JSON.parse(
    fs.readFileSync(
      path.join(
        old,
        fs.readdirSync(old).find((f) => f.startsWith("bench-merged-"))
      ),
      "utf8"
    )
  );
  delete raw.partial;
  delete raw.emulator;
  delete raw.emulatorLost;
  delete raw.missingBlocks;
  fs.writeFileSync(
    path.join(
      old,
      fs.readdirSync(old).find((f) => f.startsWith("bench-merged-"))
    ),
    JSON.stringify(raw)
  );
  assert.ok(m);
  const sb2 = run(SCOREBOARD, old);
  assert.strictEqual(sb2.code, 0, sb2.stderr);
  assert.doesNotMatch(sb2.stdout, /PARTIAL/);
});

/* ------------------ review 2026-10-07: findings 1, 2, 3, 6, 7 ------------------ */

const VALIDITY = path.join(HERE, "block-validity.js");
const WORKFLOW = path.join(HERE, "..", "workflows", "bench-open-vs-proprietary.yml");
const RUN_BENCH = path.join(HERE, "run-bench.js");

/** Write $out/validity.json the way the workflow's run_block does (via the CLI). */
function recordValidity(out, entries) {
  for (const e of entries) {
    const args = [VALIDITY, "record", path.join(out, "validity.json"), "--block", e.block];
    args.push("--ready-gate", e.readyGate || "pass");
    if (e.exitCode !== undefined) args.push("--exit-code", String(e.exitCode));
    if (e.stamped) args.push("--stamped", e.stamped);
    args.push("--started-at", startOf(e.block));
    execFileSync("node", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }
}
const ALL_OK = (names) =>
  names.map((b) => ({ block: b, exitCode: 0, stamped: b.startsWith("OFF") ? "yes" : "n/a" }));

// Finding 1: block order.
test("merge-blocks: order OFF-1 < ON-* < OFF-2 holds -> run valid", () => {
  const out = freshOut();
  writeBlocks(out, FOUR());
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 0, r.stderr);
  const m = mergedOf(r);
  assert.strictEqual(m.valid, true);
  assert.deepStrictEqual(m.runInvalidReasons, []);
});

test("merge-blocks: ON-input-manager started before OFF-1 -> run INVALID with the timestamps", () => {
  const out = freshOut();
  const bs = FOUR();
  // Run 37223823613's shape: ON-im self-orchestrated inside OFF-1's process, before it.
  bs[2].env.startedAt = "2026-10-07T17:59:00.000Z";
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 0, r.stderr);
  const m = mergedOf(r);
  assert.strictEqual(m.valid, false);
  const msg = m.runInvalidReasons.join(" ");
  assert.match(
    msg,
    /OFF-1 .*2026-10-07T18:00:00\.000Z.*ON-input-manager .*2026-10-07T17:59:00\.000Z/
  );
  assert.match(r.stdout, /INVALID/);
});

test("merge-blocks: OFF-2 started before an ON block -> run INVALID", () => {
  const out = freshOut();
  const bs = FOUR();
  bs[3].env.startedAt = "2026-10-07T18:00:30.000Z"; // OFF-2 before ON-uiautomation
  writeBlocks(out, bs);
  const m = mergedOf(run(MERGE_BLOCKS, out, ALLENV));
  assert.strictEqual(m.valid, false);
  assert.match(m.runInvalidReasons.join(" "), /OFF-2 .*started before ON-uiautomation/);
});

test("merge-blocks: a block with no start timestamp -> order cannot be verified -> INVALID", () => {
  const out = freshOut();
  const bs = FOUR();
  delete bs[1].env.startedAt;
  writeBlocks(out, bs);
  const m = mergedOf(run(MERGE_BLOCKS, out, ALLENV));
  assert.strictEqual(m.valid, false);
  assert.match(m.runInvalidReasons.join(" "), /no start timestamp for ON-uiautomation/);
});

test("scoreboard: INVALID banner at the top and exit 1 when the order is wrong", () => {
  const out = freshOut();
  const bs = FOUR();
  bs[2].env.startedAt = "2026-10-07T17:59:00.000Z";
  writeBlocks(out, bs);
  assert.strictEqual(run(MERGE_BLOCKS, out, ALLENV).code, 0);
  const sb = run(SCOREBOARD, out);
  assert.strictEqual(sb.code, 1);
  const head = sb.stdout.split("\n").slice(0, 4).join("\n");
  assert.match(head, /INVALID/);
  assert.match(sb.stdout, /ON-input-manager .*17:59:00/);
});

// Finding 6: per-block validity file.
test("block-validity: the record CLI merges per-block entries into validity.json", () => {
  const out = freshOut();
  recordValidity(out, [
    { block: "OFF-1", exitCode: 0, stamped: "yes" },
    { block: "ON-input-manager", readyGate: "fail" },
  ]);
  const v = JSON.parse(fs.readFileSync(path.join(out, "validity.json"), "utf8"));
  assert.strictEqual(v.blocks["OFF-1"].exitCode, 0);
  assert.strictEqual(v.blocks["OFF-1"].stamped, "yes");
  assert.strictEqual(v.blocks["ON-input-manager"].readyGate, "fail");
  assert.strictEqual(v.blocks["ON-input-manager"].exitCode, null);
  const { entryReasons } = require(VALIDITY);
  assert.deepStrictEqual(entryReasons(v.blocks["OFF-1"]), []);
  assert.match(entryReasons(v.blocks["ON-input-manager"]).join(), /ready-gate failed/);
});

test("merge-blocks: all blocks recorded valid -> merged.valid, validity carried", () => {
  const out = freshOut();
  const bs = FOUR().map((b) => (b.block.block.startsWith("OFF") ? withProv(b, prov("0.27.0")) : b));
  writeBlocks(out, bs);
  recordValidity(out, ALL_OK(["OFF-1", "ON-uiautomation", "ON-input-manager", "OFF-2"]));
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 0, r.stderr);
  const m = mergedOf(r);
  assert.strictEqual(m.valid, true);
  assert.deepStrictEqual(m.invalidBlocks, []);
  assert.strictEqual(m.validity["OFF-1"].stamped, "yes");
});

test("merge-blocks + scoreboard: an OFF block that exited non-zero is INVALID (banner, exit 1)", () => {
  const out = freshOut();
  const bs = FOUR().map((b) => (b.block.block.startsWith("OFF") ? withProv(b, prov("0.27.0")) : b));
  writeBlocks(out, bs);
  recordValidity(out, [
    { block: "OFF-1", exitCode: 1, stamped: "no" },
    ...ALL_OK(["ON-uiautomation", "ON-input-manager", "OFF-2"]),
  ]);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 0, r.stderr);
  const m = mergedOf(r);
  assert.strictEqual(m.valid, false);
  assert.deepStrictEqual(
    m.invalidBlocks.map((x) => x.block),
    ["OFF-1"]
  );
  assert.match(m.invalidBlocks[0].reasons.join(), /bench exited 1/);
  const sb = run(SCOREBOARD, out);
  assert.strictEqual(sb.code, 1);
  assert.match(sb.stdout.split("\n").slice(0, 4).join("\n"), /INVALID/);
  assert.match(sb.stdout, /OFF-1: bench exited 1/);
});

test("merge-blocks: an ON block whose ready-gate failed (no file) is INVALID, not a thrown merge", () => {
  const out = freshOut();
  writeBlocks(out, [block("OFF-1"), block("ON-uiautomation"), block("OFF-2")]);
  recordValidity(out, [
    ...ALL_OK(["OFF-1", "ON-uiautomation", "OFF-2"]).map((e) => ({ ...e, stamped: "n/a" })),
    { block: "ON-input-manager", readyGate: "fail" },
  ]);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 0, r.stderr);
  const m = mergedOf(r);
  assert.strictEqual(m.valid, false);
  assert.match(
    m.invalidBlocks.find((x) => x.block === "ON-input-manager").reasons.join(),
    /ready-gate failed/
  );
  assert.strictEqual(run(SCOREBOARD, out).code, 1);
});

test("merge-blocks: a current OFF block recorded unstamped is INVALID", () => {
  const out = freshOut();
  writeBlocks(out, FOUR());
  recordValidity(out, [
    { block: "OFF-1", exitCode: 0, stamped: "no" },
    ...ALL_OK(["ON-uiautomation", "ON-input-manager", "OFF-2"]),
  ]);
  const m = mergedOf(run(MERGE_BLOCKS, out, ALLENV));
  assert.strictEqual(m.valid, false);
  assert.match(m.invalidBlocks.find((x) => x.block === "OFF-1").reasons.join(), /not stamped/);
});

test("merge-blocks: an unstamped OFF-legacy file is INVALID (not 'unknown'); main merge stays valid", () => {
  const out = freshOut();
  const bs = FIVE();
  delete bs[4].block.proprietaryProvenance;
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, FIVEENV);
  assert.strictEqual(r.code, 0, r.stderr);
  const m = mergedOf(r);
  assert.strictEqual(m.valid, true);
  assert.strictEqual(m.legacyArm.invalid, true);
  assert.match(m.legacyArm.invalidReasons.join(), /unstamped/);
  assert.notStrictEqual(m.proprietaryProvenance.legacy, "unknown");
  const sb = run(SCOREBOARD, out);
  assert.strictEqual(sb.code, 0, sb.stderr);
  assert.match(sb.stdout, /Proprietary baseline: .*INVALID/);
  assert.doesNotMatch(sb.stdout.split("\n").slice(0, 4).join("\n"), /INVALID/);
});

test("merge-blocks: a DEGRADED OFF-legacy invalidates only the legacy section, never throws the merge", () => {
  const out = freshOut();
  const bs = FIVE();
  bs[4].block.degradedReasons = ["await-screen-idle capped every iteration"];
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, FIVEENV);
  assert.strictEqual(r.code, 0, r.stderr);
  const m = mergedOf(r);
  assert.strictEqual(m.valid, true);
  assert.strictEqual(m.legacyArm.invalid, true);
  assert.match(m.legacyArm.invalidReasons.join(), /DEGRADED/);
});

test("merge-blocks: OFF-legacy on the wrong release or failed in run_block -> legacy INVALID only", () => {
  const out = freshOut();
  writeBlocks(out, FIVE());
  recordValidity(out, [
    ...ALL_OK(["OFF-1", "ON-uiautomation", "ON-input-manager", "OFF-2"]),
    { block: "OFF-legacy", exitCode: 1, stamped: "no" },
  ]);
  const r = run(MERGE_BLOCKS, out, { ...FIVEENV, BENCH_LEGACY_PROPRIETARY_VERSION: "0.21.0" });
  assert.strictEqual(r.code, 0, r.stderr);
  const m = mergedOf(r);
  assert.strictEqual(m.valid, true);
  const why = m.legacyArm.invalidReasons.join(" | ");
  assert.match(why, /bench exited 1/);
  assert.match(why, /expected 0\.21\.0/);
});

// Finding 3: fallback visibility + Q4 equality.
test("merge-blocks: an ON block that logged an open-server 'falling back' line FIRES", () => {
  const out = freshOut();
  const bs = FOUR();
  bs[1].block.openServerFallbacks = {
    count: 2,
    samples: ["[gesture-swipe] open-device-server failed, falling back to simulator-server: x"],
  };
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /ON-uiautomation=2/);
  assert.match(r.stderr, /falling back/);
});

test("merge-blocks: Q4 FIRES when injectStrategyCounts[input-manager] != expected injections", () => {
  const out = freshOut();
  const bs = FOUR();
  // 9 of 170 host-issued gesture calls never reached the on-device injector (a
  // proprietary fallback leaves no trace in the counter, so the totals differ).
  bs[2].block.injectStrategyCounts = { "input-manager": 161 };
  bs[2].block.expectedInjectRpcs = 170;
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /input-manager.*161.*expected 170/);
});

test("merge-blocks: Q4 FIRES when ON-input-manager carries no expected inject count", () => {
  const out = freshOut();
  const bs = FOUR();
  delete bs[2].block.expectedInjectRpcs;
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /expectedInjectRpcs/);
});

test("scoreboard: Q4 states on-device input-manager count == expected injections", () => {
  const out = freshOut();
  writeBlocks(out, RUN2());
  assert.strictEqual(run(MERGE_BLOCKS, out, RUN2ENV).code, 0);
  const sb = run(SCOREBOARD, out);
  assert.strictEqual(sb.code, 0, sb.stderr);
  assert.match(sb.stdout, /Q4 .*input-manager.*\*\*161\*\* == expected \*\*161\*\*.*PASS/);
});

// Finding 2: swipe/pinch carry a drained timing + the raw no-drain column.
test("scoreboard: swipe/pinch drain table with a no-drain column per block", () => {
  const out = freshOut();
  const nd = (p50) => ({ latency: { p50, p95: p50 + 8 }, latencySamples: [p50] });
  const withDrain = (b, sw, pi) => {
    for (const v of b.block.verbs) {
      if (v.verb === "gesture-swipe") v.noDrain = nd(sw);
      if (v.verb === "gesture-pinch") v.noDrain = nd(pi);
      if (v.verb === "gesture-swipe" || v.verb === "gesture-pinch")
        v.drainRead = "describe(settle:false)";
    }
    return b;
  };
  const bs = RUN2().map((b) => withDrain(b, 250, 310));
  writeBlocks(out, bs);
  assert.strictEqual(run(MERGE_BLOCKS, out, RUN2ENV).code, 0);
  const sb = run(SCOREBOARD, out);
  assert.strictEqual(sb.code, 0, sb.stderr);
  assert.match(sb.stdout, /describe\(settle:false\)/);
  assert.match(sb.stdout, /\| verb \| block \| gesture \+ drain p50\/p95 \| no-drain p50\/p95 \|/);
  assert.match(sb.stdout, /\| gesture-swipe \| ON-input-manager \| 268\/276 \| 250\/258 \|/);
  assert.match(sb.stdout, /\| gesture-pinch \| OFF-1 \| 351\/359 \| 310\/318 \|/);
});

test("scoreboard: no merged JSON -> NO RESULTS and exit 1", () => {
  const out = freshOut();
  const sb = run(SCOREBOARD, out);
  assert.strictEqual(sb.code, 1);
  assert.match(sb.stdout, /NO RESULTS/);
});

// Findings 1, 3, 7: workflow + loader wiring (static: the workflow cannot run here).
test("workflow: run_block order is OFF-1, ON-uiautomation, ON-input-manager, OFF-2, OFF-legacy", () => {
  const y = fs.readFileSync(WORKFLOW, "utf8");
  const calls = [...y.matchAll(/run_block "([A-Za-z0-9-]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(calls, [
    "OFF-1",
    "ON-uiautomation",
    "ON-input-manager",
    "OFF-2",
    "OFF-legacy",
  ]);
});

test("workflow: ready-gate failure returns non-zero from run_block for every block", () => {
  const y = fs.readFileSync(WORKFLOW, "utf8");
  const body = y.slice(y.indexOf("run_block () {"), y.indexOf("RUN_OFF=0"));
  assert.match(body, /if ! bash \.github\/bench-ci\/ready-gate\.sh emulator-5554 3 60 1/);
  // The gate's failure branch records validity and returns before any node run.
  const gateFail = body.slice(body.indexOf("if ! bash .github/bench-ci/ready-gate.sh"));
  assert.ok(
    gateFail.indexOf("return 1") < gateFail.indexOf("run-bench.js"),
    "ready-gate failure must return before the bench runs"
  );
});

test("workflow: ON blocks run with the proprietary dirs unset", () => {
  const y = fs.readFileSync(WORKFLOW, "utf8");
  const step = y.slice(y.indexOf("- name: Latency bench"), y.indexOf("- name: Scoreboard"));
  assert.doesNotMatch(step.split("run: |")[0], /ARGENT_SIMULATOR_SERVER_DIR/);
  assert.match(
    step,
    /env -u ARGENT_SIMULATOR_SERVER_DIR -u ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR -u ARGENT_NATIVE_DEVTOOLS_DIR/
  );
});

test("run-bench.js: no strategy-arm self-orchestration (no hidden block before OFF-1)", () => {
  const src = fs.readFileSync(RUN_BENCH, "utf8");
  assert.doesNotMatch(src, /STRATEGY_ARMS/);
  // No child bench block is spawned from the loader (only the FLING harness is).
  assert.doesNotMatch(src, /ARGENT_BENCH_NO_ORCHESTRATE=1 BENCH_ONLY=/);
  assert.doesNotMatch(src, /proceeding \(the child effect gate is authoritative\)/);
});
