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
              name === "ON-uiautomation" || name === "ON-uia"
                ? { default: 161 }
                : { "input-manager": 161 },
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
  // tap: legacy 60/68, OFF-1 53/61, OFF-2 53/61, bootstrap margin, Δ +7, CI, reading.
  assert.match(
    r.stdout,
    /\| gesture-tap \| 60\/68 \| 53\/61 \| 53\/61 \| ±[\d.]+ \| 7 \| \[-?[\d.]+, -?[\d.]+\] \| (win|loss|parity|inconclusive) \|/
  );
  // Provenance is rendered per OFF block.
  assert.match(r.stdout, /### Proprietary provenance/);
  assert.match(r.stdout, /OFF-legacy \| @swmansion\/argent@0\.22\.1/);
  // The P-gates still grade against the CURRENT OFF blocks, never OFF-legacy.
  // Columns: row | ON-im block p50s | ON-uia | OFF block p50s | margin | …
  assert.match(r.stdout, /\| gesture-tap \| 55 \| 86 \| 53 \/ 53 \| ±[\d.]+ \|/);
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

test("scoreboard: RUN2 gates — drift row + bootstrap margin; tap +2 ms is INCONCLUSIVE, not 'FAIL by 2'", () => {
  const out = freshOut();
  writeBlocks(out, RUN2());
  assert.strictEqual(run(MERGE_BLOCKS, out, RUN2ENV).code, 0);
  const r = run(SCOREBOARD, out);
  assert.strictEqual(r.code, 0, r.stderr);
  // Drift (OFF-1 − OFF-2 p50) stays published in the drift table; the gate margin is
  // never 0. Gate table columns: row | ON-im p50s | ON-uia | OFF p50s | margin | …
  assert.match(r.stdout, /\| gesture-tap \| 55 \| 86 \| 53 \/ 53 \| ±[1-9][\d.]* \|/);
  assert.match(r.stdout, /\| swipe\+describe \| 268 \| 291 \| 307 \/ 300 \| ±[\d.]+ \|/);
  assert.match(r.stdout, /\| pinch\+describe \| 323 \| 340 \| 351 \/ 356 \| ±[\d.]+ \|/);
  assert.match(r.stdout, /\| swipe\+describe \(gesture-swipe\) \| 307 \| 300 \| 7 \| ±[\d.]+ \|/);
  assert.match(r.stdout, /\| pinch\+describe \(gesture-pinch\) \| 351 \| 356 \| -5 \| ±[\d.]+ \|/);
  // Review 2026-10-07 finding 5: one rule. tap Δ +2 with a CI spanning the margin is
  // INCONCLUSIVE (not a pass, not a fail); swipe/pinch are clear wins vs pooled OFF.
  assert.match(r.stdout, /\*\*P2\*\* — tap .*: \*\*INCONCLUSIVE\*\*/);
  // No gesture-only samples in these blocks: P3/P4 name the one row they decide on.
  assert.match(r.stdout, /\*\*P3\*\* — swipe\+describe: .*swipe\+describe only.*: \*\*PASS\*\*/);
  assert.match(r.stdout, /\*\*P4\*\* — pinch\+describe: .*: \*\*PASS\*\*/);
  assert.doesNotMatch(r.stdout, /min\(OFF\)|max\(OFF\)/);
  // Run 37591260027: P5 is pre-registered on tap+await-idle+describe; none here → N/A.
  assert.match(r.stdout, /\*\*P5\*\*.*no tap\+await-idle\+describe samples.*: \*\*N\/A\*\*$/m);
  assert.match(r.stdout, /tap\+describe variants, interleaved per sample/);
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
  // No comparator: the row is not in the gated family (no ±2 floor), P5 is N/A.
  assert.doesNotMatch(r.stdout, /\| tap\+describe[^|]*time-to-correct \|/);
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
  assert.match(r.stdout, /\| swipe\+describe \|.*\| loss \|/);
  assert.match(r.stdout, /\*\*P3\*\* — swipe.*: \*\*FAIL\*\*/);
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
  assert.match(
    sb.stdout,
    /\| verb \| block \| gesture \+ describe p50\/p95 \| gesture only p50\/p95 \|/
  );
  assert.match(sb.stdout, /\| swipe\+describe \| ON-input-manager \| 268\/276 \| 250\/258 \|/);
  assert.match(sb.stdout, /\| pinch\+describe \| OFF-1 \| 351\/359 \| 310\/318 \|/);
});

test("scoreboard: no merged JSON -> NO RESULTS and exit 1", () => {
  const out = freshOut();
  const sb = run(SCOREBOARD, out);
  assert.strictEqual(sb.code, 1);
  assert.match(sb.stdout, /NO RESULTS/);
});

// Findings 1, 3, 7: workflow + loader wiring (static: the workflow cannot run here).
test("workflow: blocks run in the BENCH_BLOCKS order; the default is the ABBA sequence", () => {
  // Review 2026-10-07 run 37591260027 ("Next run"): interleaved ABBA, ≥ 3 blocks per arm.
  const y = fs.readFileSync(WORKFLOW, "utf8");
  assert.match(y, /default: "OFF-1,ON-im-1,ON-uia,OFF-2,ON-im-2,OFF-3,ON-im-3,OFF-legacy"/);
  const step = y.slice(y.indexOf("- name: Latency bench"), y.indexOf("- name: Scoreboard"));
  // One loop over the requested list, in its order; no hard-coded block sequence.
  assert.match(step, /IFS=',' read -r -a REQ_BLOCKS <<< "\$BENCH_BLOCKS"/);
  assert.match(step, /for b in "\$\{REQ_BLOCKS\[@\]\}"; do/);
  assert.doesNotMatch(step, /grep -q "OFF-1"/);
  for (const pat of ["OFF-legacy)", "OFF-*)", "ON-*)"]) assert.ok(step.includes(pat), pat);
  // ON-uia and OFF-legacy run at n_secondary (runtime budget), the rest at n.
  assert.match(step, /ON-uia\|OFF-legacy\) echo "\$\{BENCH_N_SECONDARY:-\$BENCH_N\}"/);
  assert.match(y, /n_secondary:[\s\S]*default: "30"/);
  assert.match(y, /timeout-minutes: 240/);
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

/* ------------------- stats (review 2026-10-07 findings 4, 5) ------------------- */
// Literal require so knip traces the test-only exports.
const stats = require("./stats");
const BENCH_TS = path.join(
  HERE,
  "..",
  "..",
  "packages",
  "tool-server",
  "scripts",
  "bench-open-vs-proprietary.ts"
);
// n samples evenly spread over [center - spread, center + spread] (median == center).
const spreadAround = (center, spread, n = 41) =>
  Array.from({ length: n }, (_, i) => center - spread + (2 * spread * i) / (n - 1));

test("stats: one median definition — true median (mean of the two middle values for even n)", () => {
  const { median, summarize } = stats;
  assert.strictEqual(median([3, 1, 2]), 2);
  // The old bench pct() returned the lower-middle value (2) here.
  assert.strictEqual(median([4, 1, 3, 2]), 2.5);
  // Finding 4's tap+describe case: bimodal even-n samples, lower-middle 382 vs true 396.5.
  assert.strictEqual(median([380, 381, 382, 411, 412, 413]), 396.5);
  // p95 uses the same linear-interpolation quantile (h = (n − 1) · 0.95).
  assert.strictEqual(
    summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]).p95,
    19.05
  );
  const s = summarize([0.25, 1.5, 2.75, 10.125]);
  assert.strictEqual(s.p50, 2.125);
  assert.strictEqual(s.p50, median([0.25, 1.5, 2.75, 10.125]));
  assert.strictEqual(s.n, 4);
});

test("stats: the bench script takes its quantiles from stats.js, with sub-ms timing", () => {
  const src = fs.readFileSync(BENCH_TS, "utf8");
  const has = (rx) => rx.test(src);
  assert.ok(has(/from "\.\.\/\.\.\/\.\.\/\.github\/bench-ci\/stats(\.js)?"/), "no stats.js import");
  assert.ok(!has(/function pct\(/), "local pct() still defined");
  assert.ok(!has(/function summarize\(/), "local summarize() still defined");
  // Every timed window is performance.now(); Date.now() survives only for deadlines.
  assert.ok(!has(/const t[0-2] = Date\.now\(\)/), "a timed window still uses Date.now()");
  assert.ok(!has(/\.push\(Date\.now\(\) - t0\)/), "a sample still uses Date.now()");
});

test("stats: readCI — the four readings against ±margin", () => {
  const { readCI } = stats;
  assert.strictEqual(readCI([-20, -8], 5), "win");
  assert.strictEqual(readCI([6, 30], 5), "loss");
  assert.strictEqual(readCI([-4, 5], 5), "parity");
  // A wide CI that spans the margin is no longer parity.
  assert.strictEqual(readCI([-152, 128.5], 29), "inconclusive");
  assert.strictEqual(readCI([-6, 2], 5), "inconclusive");
  assert.strictEqual(readCI(null, 5), "N/A");
  assert.strictEqual(readCI([-1, 1], null), "N/A");
});

test("stats: gradeFamily produces win / loss / parity / inconclusive from samples", () => {
  const { gradeFamily } = stats;
  const fam = gradeFamily([
    { key: "win", a: spreadAround(100, 4), b: spreadAround(150, 4), margin: 5 },
    { key: "loss", a: spreadAround(150, 4), b: spreadAround(100, 4), margin: 5 },
    { key: "parity", a: spreadAround(100, 2), b: spreadAround(100, 2), margin: 10 },
    { key: "inconclusive", a: spreadAround(104, 60), b: spreadAround(100, 60), margin: 5 },
  ]);
  const by = Object.fromEntries(fam.map((r) => [r.key, r]));
  assert.strictEqual(by.win.reading, "win");
  assert.strictEqual(by.win.gate, "PASS");
  assert.strictEqual(by.loss.reading, "loss");
  assert.strictEqual(by.loss.gate, "FAIL");
  assert.strictEqual(by.parity.reading, "parity");
  assert.strictEqual(by.parity.gate, "PASS");
  assert.strictEqual(by.inconclusive.reading, "inconclusive");
  assert.strictEqual(by.inconclusive.gate, "INCONCLUSIVE");
  assert.strictEqual(by.win.delta, -50);
  for (const r of fam) assert.strictEqual(r.m, 4);
  // Deterministic: the same input grades to the same numbers.
  assert.deepStrictEqual(
    gradeFamily([{ key: "x", a: spreadAround(100, 4), b: spreadAround(150, 4), margin: 5 }]),
    gradeFamily([{ key: "x", a: spreadAround(100, 4), b: spreadAround(150, 4), margin: 5 }])
  );
});

test("stats: Holm — per-verb adjusted alpha by rank, CI widened to 1 - alpha_k", () => {
  const { gradeFamily, compareOnce } = stats;
  const fam = gradeFamily([
    { key: "tight", a: spreadAround(100, 4), b: spreadAround(150, 4), margin: 5 },
    { key: "mid", a: spreadAround(100, 10), b: spreadAround(130, 10), margin: 5 },
    { key: "wide", a: spreadAround(104, 60), b: spreadAround(100, 60), margin: 5 },
    { key: "wider", a: spreadAround(110, 90), b: spreadAround(100, 90), margin: 5 },
  ]);
  // Ranked by the CI rule's bootstrap p (ascending); rank k gets 0.05 / (m − k + 1).
  const byRank = fam.slice().sort((x, y) => x.rank - y.rank);
  assert.deepStrictEqual(
    byRank.map((r) => r.rank),
    [1, 2, 3, 4]
  );
  for (let k = 1; k < byRank.length; k++) assert.ok(byRank[k - 1].p <= byRank[k].p, "p ascending");
  assert.deepStrictEqual(
    byRank.map((r) => r.alpha),
    [0.0125, 0.05 / 3, 0.025, 0.05]
  );
  for (const r of fam) assert.strictEqual(r.level, 1 - r.alpha);
  assert.strictEqual(fam.find((r) => r.key === "tight").rank, 1);
  // A wider level gives a CI that contains the 95% one.
  const c95 = compareOnce(spreadAround(104, 60), spreadAround(100, 60), { level: 0.95 }).ci;
  const c99 = compareOnce(spreadAround(104, 60), spreadAround(100, 60), { level: 0.99 }).ci;
  assert.ok(c99[0] <= c95[0] && c99[1] >= c95[1], `${c99} must contain ${c95}`);
});

test("stats: Holm step-down — after the first non-decisive verb every later verb is retained", () => {
  const { gradeFamily, readCI, compareOnce } = stats;
  // A (p 0.0274) is rank 1 at alpha 0.025: its 97.5% CI [-21.5, -1.5] does not clear the
  // ±2 margin. It excludes zero with the point (-11.5) beyond the margin, so since run
  // 37591260027 finding 7 it reads "win (within/at margin)" (gate PASS), not inconclusive;
  // it still does not settle the margin hypothesis, so Holm stops there. B (p 0.0486)
  // would read win on its own 95% CI, but Holm stops at A, so B is retained.
  const base = spreadAround(100, 20);
  const fam = gradeFamily([
    { key: "A", a: spreadAround(88.5, 20), b: base, margin: 2 },
    { key: "B", a: spreadAround(89.5, 20), b: base, margin: 2 },
  ]);
  const [a, b] = fam;
  assert.deepStrictEqual(
    [a.rank, a.alpha, a.reading, a.holmStop, a.gate],
    [1, 0.025, stats.WIN_WITHIN, false, "PASS"]
  );
  assert.deepStrictEqual([b.rank, b.alpha, b.reading, b.holmStop], [2, 0.05, "inconclusive", true]);
  assert.strictEqual(readCI(b.ci, 2), "win", "B's own CI is decisive; only Holm retains it");
  assert.strictEqual(b.gate, "INCONCLUSIVE");
  assert.deepStrictEqual(compareOnce(spreadAround(89.5, 20), base).ci, b.ci);
});

test("stats: drift margin is the bootstrap 95th percentile of |Δp50|, not one point difference", () => {
  const { driftMargin, pooledNullMargin, median } = stats;
  // Identical blocks: the point difference is 0, the bootstrap margin is not.
  const a = spreadAround(53, 8, 40);
  const b = spreadAround(53, 8, 40);
  assert.strictEqual(median(a) - median(b), 0);
  const m = driftMargin(a, b);
  assert.ok(m > 0, `margin ${m} must be > 0 for noisy identical blocks`);
  // A real block shift widens it.
  assert.ok(driftMargin(a, spreadAround(63, 8, 40)) > m);
  // P6's null margin pools the two arms recentred on their own medians: the shift under
  // test does not inflate it (same margin for a 10 ms and a 30 ms shift, same noise).
  assert.ok(pooledNullMargin(a, spreadAround(63, 8, 40)) < driftMargin(a, spreadAround(63, 8, 40)));
  assert.strictEqual(
    pooledNullMargin(a, spreadAround(63, 8, 40)),
    pooledNullMargin(a, spreadAround(83, 8, 40))
  );
  assert.strictEqual(driftMargin([1], b), null);
});

/* ------------- scoreboard: one rule for table + P lines (finding 5) ------------- */
// A verb with explicit per-sample arrays (n=40, evenly spread ± spread around p50).
const vS = (verb, p50, spread = 8, n = 40) => ({
  verb,
  latency: { p50, p95: p50 + spread },
  latencySamples: spreadAround(p50, spread, n),
  errors: 0,
  fallbacks: 0,
});
// A tap+describe row that also carries a time-to-correct (run 37578606526): the same
// evenly spread samples for both, so the P5 headline row reads like the old one did.
const vTd = (verb, p50, spread) => ({
  ...vS(verb, p50, spread),
  timeToCorrect: {
    samples: spreadAround(p50, spread, 40),
    censoredAtMs: [],
    timedOut: 0,
    measured: 40,
    firstRead: 20,
  },
});
// Fixed merged input: tap win, swipe loss, pinch parity, headline inconclusive.
const FAMILY = () => [
  block("OFF-1", {
    verbs: [
      vS("gesture-tap", 60, 2),
      vS("gesture-swipe", 300, 2),
      vS("gesture-pinch", 350, 1),
      vTd("tap+await-idle+describe", 400, 80),
    ],
  }),
  block("ON-uiautomation", {
    verbs: [
      vS("gesture-tap", 60, 2),
      vS("gesture-swipe", 300, 2),
      vS("gesture-pinch", 350, 1),
      vTd("tap+await-idle+describe", 400, 80),
    ],
  }),
  block("ON-input-manager", {
    verbs: [
      vS("gesture-tap", 40, 2),
      vS("gesture-swipe", 330, 2),
      vS("gesture-pinch", 350, 1),
      vTd("tap+await-idle+describe", 412, 80),
    ],
  }),
  block("OFF-2", {
    verbs: [
      vS("gesture-tap", 60, 2),
      vS("gesture-swipe", 300, 2),
      vS("gesture-pinch", 350, 1),
      vTd("tap+await-idle+describe", 400, 80),
    ],
  }),
];
const scoreboardOf = (bs, env = ALLENV) => {
  const out = freshOut();
  writeBlocks(out, bs);
  const m = run(MERGE_BLOCKS, out, env);
  assert.strictEqual(m.code, 0, m.stderr);
  const r = run(SCOREBOARD, out);
  assert.strictEqual(r.code, 0, r.stderr);
  return r.stdout;
};
// Gate table rows (run 37591260027): | row | ON-im block p50s | ON-uia | OFF block p50s |
// margin | Δ | Holm α | CI (primary) | reading | within-block secondary |
const gateRows = (md) => {
  const sec = md.slice(md.indexOf("### Promotion gates"), md.indexOf("- **P2**"));
  const rows = {};
  for (const line of sec.split("\n")) {
    const c = line.split("|").map((x) => x.trim());
    if (c.length === 12 && /^(gesture-|swipe|pinch|tap\+)/.test(c[1]))
      rows[c[1]] = {
        im: c[2],
        off: c[4],
        margin: c[5],
        delta: c[6],
        holm: c[7],
        ci: c[8],
        reading: c[9],
        secondary: c[10],
      };
  }
  return rows;
};
const pLine = (md, id) => {
  const l = md.split("\n").find((x) => x.startsWith(`- **${id}**`));
  assert.ok(l, `no ${id} line`);
  return l;
};

test("scoreboard: table reading and P2/P3/P4 come from the same rule and the same numbers", () => {
  const md = scoreboardOf(FAMILY());
  const rows = gateRows(md);
  // Run 37591260027: the P5 rows are the pre-registered await variant.
  const TTC = "tap+await-idle+describe time-to-correct";
  const CAFR = "tap+await-idle+describe correct-at-first-read";
  assert.deepStrictEqual(Object.keys(rows).sort(), [
    "gesture-tap",
    "pinch+describe",
    "swipe+describe",
    CAFR,
    TTC,
  ]);
  assert.strictEqual(rows["gesture-tap"].reading, "win");
  assert.strictEqual(rows["swipe+describe"].reading, "loss");
  assert.strictEqual(rows["pinch+describe"].reading, "parity");
  assert.match(rows[TTC].reading, /^inconclusive/);
  const { gateOf } = stats;
  for (const [id, vn] of [
    ["P2", "gesture-tap"],
    ["P3", "swipe+describe"],
    ["P4", "pinch+describe"],
  ]) {
    const l = pLine(md, id);
    const row = rows[vn];
    // Same Δ, margin, CI and reading as the table row; verdict = gateOf(reading).
    assert.ok(l.includes(`Δ ${row.delta}`), `${id} Δ: ${l}`);
    assert.ok(l.includes(`CI ${row.ci}`), `${id} CI: ${l}`);
    assert.ok(l.includes(`vs ${row.margin}`), `${id} margin: ${l}`);
    assert.ok(l.includes(`reading ${row.reading}`), `${id} reading: ${l}`);
    assert.ok(l.endsWith(`**${gateOf(row.reading.split(" ")[0])}**`), `${id} verdict: ${l}`);
  }
  assert.match(pLine(md, "P2"), /\*\*PASS\*\*$/);
  assert.match(pLine(md, "P3"), /\*\*FAIL\*\*$/);
  assert.match(pLine(md, "P4"), /\*\*PASS\*\*$/);
  // P5: both pre-registered rows; time-to-correct reads inconclusive, so P5 is not a PASS.
  const p5 = pLine(md, "P5");
  assert.ok(p5.includes(`${TTC}: Δ ${rows[TTC].delta}`), p5);
  assert.ok(p5.includes(`reading ${rows[TTC].reading}`), p5);
  assert.ok(p5.includes(CAFR), p5);
  assert.match(p5, /\*\*INCONCLUSIVE\*\*$/);
});

test("scoreboard: Holm alpha per verb is printed in the table and documented in the footer", () => {
  const md = scoreboardOf(FAMILY());
  const rows = gateRows(md);
  const alphas = Object.values(rows)
    .filter((r) => r.holm !== "-") // the pre-ABBA rate row is read outside the Holm family
    .map((r) => r.holm.match(/α=([\d.]+) \(rank (\d)\/4\)/))
    .map((m) => {
      assert.ok(m, "Holm cell");
      return { a: Number(m[1]), rank: Number(m[2]) };
    })
    .sort((x, y) => x.rank - y.rank);
  assert.deepStrictEqual(
    alphas.map((x) => x.rank),
    [1, 2, 3, 4]
  );
  assert.deepStrictEqual(
    alphas.map((x) => x.a),
    [0.0125, 0.0167, 0.025, 0.05]
  );
  assert.match(md, /Holm/);
  assert.match(md, /α_k = 0\.05 \/ \(m − k \+ 1\)/);
  assert.match(md, /Not captured: block-level variance/);
  assert.match(md, /ABBA/);
});

test("scoreboard: p95 Δ with CI is a report-only row, not gated", () => {
  const md = scoreboardOf(FAMILY());
  assert.match(md, /p95 Δ.*report only, not gated/i);
  assert.match(md, /\| gesture-tap \| [-\d.]+ \| \[-?[\d.]+, -?[\d.]+\] \|/);
});

test("scoreboard: P6 grades ON-input-manager vs ON-uiautomation at the pair's own null margin", () => {
  const md = scoreboardOf(FAMILY());
  // im tap 40 vs uia 60 → win; swipe 330 vs 300 → loss → P6 FAIL naming swipe.
  const p6 = pLine(md, "P6");
  assert.match(p6, /null margin/);
  assert.match(p6, /swipe\+describe/);
  assert.match(p6, /\*\*FAIL\*\*$/);
  // RUN2: input-manager is faster than the control on every verb → PASS.
  const md2 = scoreboardOf(RUN2(), RUN2ENV);
  assert.match(pLine(md2, "P6"), /\*\*PASS\*\*$/);
});

test("scoreboard: await-* rows are labelled host-algorithm differences (finding 9)", () => {
  const bs = FOUR();
  for (const b of bs)
    b.block.verbs.push(vS("await-screen-idle", b.block.block.startsWith("OFF") ? 504 : 309, 20));
  const md = scoreboardOf(bs);
  assert.match(md, /\| await-screen-idle \(host algorithm\) \|/);
  assert.match(md, /host-algorithm difference/i);
});

test("scoreboard: build provenance (git SHA, Node, js-tiktoken, installed APK sha256) per block", () => {
  const bs = FOUR();
  for (const b of bs)
    b.block.buildProvenance = {
      gitSha: "a1de2cd2aaaabbbbccccddddeeeeffff00001111",
      node: "v20.19.0",
      jsTiktoken: "1.0.21",
      installedApk: {
        package:
          b.block.config === "ON" ? "com.argent.devicecontrol" : "com.argent.androiddevtools",
        files: [
          {
            path: "/data/app/x/base.apk",
            sha256: `${b.block.config === "ON" ? "ab" : "cd"}`.repeat(32),
          },
        ],
      },
    };
  const md = scoreboardOf(bs);
  assert.match(md, /### Build provenance/);
  assert.match(
    md,
    /\| ON-input-manager \| `a1de2cd2aaaa` \| v20\.19\.0 \| 1\.0\.21 \| com\.argent\.devicecontrol \| `(ab){32}` \|/
  );
  assert.match(md, /\| OFF-1 \| .* \| com\.argent\.androiddevtools \| `(cd){32}` \|/);
});

/* ---------- run 37561512651 / Review 2026-10-07: B (fallbacks, empty trees) ---------- */

test("bench: the fallback counter hooks console.warn and console.error, not only console.debug", () => {
  const src = fs.readFileSync(BENCH_TS, "utf8");
  // The open/main host logs open-path fallbacks at console.warn since PR #20.
  assert.match(src, /console\.warn = /);
  assert.match(src, /console\.error = /);
  assert.match(src, /console\.debug = /);
  // Empty trees are counted per timed sample from the describe result itself.
  assert.match(src, /treeEmpty === true/);
  assert.match(src, /openServerEmptyTreeCount\(\)/);
});

const withTreeEmpty = (b, verb, n) => {
  b.block.verbs = b.block.verbs.map((v) =>
    v.verb === verb ? { ...v, treeEmpty: n, treeEmptySamples: [`i=3 verb='${verb}'`] } : v
  );
  return b;
};

// Run 37571460849: an empty describe inside a timed verb no longer invalidates the
// block (rule d). It is excluded from that verb's latency on both arms (rule a) and
// graded by P11 (empty rate per timed verb per block, Wilson 95 % CI vs 25 %).
test("merge-blocks: a timed treeEmpty alone no longer makes a block INVALID, on either arm", () => {
  const out = freshOut();
  const bs = FOUR();
  withTreeEmpty(bs[2], "gesture-tap", 9);
  withTreeEmpty(bs[0], "gesture-tap", 2);
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 0, r.stderr);
  const m = mergedOf(r);
  assert.strictEqual(m.valid, true, JSON.stringify(m.invalidBlocks));
  assert.deepStrictEqual(m.invalidBlocks, []);
});

test("merge-blocks: treeEmpty 0 on every timed verb keeps the run valid", () => {
  const out = freshOut();
  const bs = FOUR();
  for (const b of bs) withTreeEmpty(b, "gesture-tap", 0);
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(mergedOf(r).valid, true);
});

test("merge-blocks: an ON fallback line logged at console.warn still FIRES the fallback gate", () => {
  const out = freshOut();
  const bs = FOUR();
  bs[2].block.openServerFallbacks = {
    count: 1,
    samples: ["[describe.android] open-device-server failed, falling back: ECONNRESET"],
  };
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /ON-input-manager=1/);
});

test("scoreboard: treeEmpty column per verb and resetWaitMs mean/max per block", () => {
  const bs = FOUR();
  for (const b of bs) {
    withTreeEmpty(b, "gesture-tap", 0);
    b.block.resetWait = { n: 4, meanMs: 312.5, maxMs: 1840.25, timeouts: 0, relaunches: 1 };
  }
  const md = scoreboardOf(bs);
  assert.match(md, /### Fallbacks, empty trees and resets/);
  assert.match(md, /\| verb \| block \| fallbacks \| treeEmpty \|/);
  assert.match(md, /\| gesture-tap \| ON-input-manager \| 0 \| 0 \|/);
  assert.match(
    md,
    /\| block \| resets \| resetWaitMs mean \| resetWaitMs max \| timeouts \| relaunches \|/
  );
  assert.match(md, /\| OFF-2 \| 4 \| 312\.5 \| 1840\.3 \| 0 \| 1 \|/);
});

/* ------------- run 37561512651 / Review 2026-10-07: C (practical margin) ------------- */

test("stats: equivalenceMargin = max(bootstrap OFF drift margin, 2 % of pooled OFF p50, 1 ms)", () => {
  const { equivalenceMargin, driftMargin } = stats;
  // Bootstrap binding: two OFF blocks 10 ms apart, p50 ~58 ms (2 % = 1.2 ms).
  const a = spreadAround(53, 8, 40);
  const b = spreadAround(63, 8, 40);
  const boot = equivalenceMargin(a, b);
  assert.strictEqual(boot.bootstrap, driftMargin(a, b));
  assert.strictEqual(boot.margin, boot.bootstrap);
  assert.strictEqual(boot.binding, "bootstrap");
  // 2 % binding: tight blocks at 1000 ms, bootstrap well under 20 ms.
  const t = spreadAround(1000, 1, 40);
  const pct = equivalenceMargin(t, t.slice());
  assert.ok(pct.bootstrap < 20, `bootstrap ${pct.bootstrap}`);
  assert.strictEqual(pct.pctOfP50, 20);
  assert.strictEqual(pct.margin, 20);
  assert.strictEqual(pct.binding, "2% of p50");
  // 1 ms floor: tight blocks at 20 ms (2 % = 0.4 ms).
  const f = spreadAround(20, 0.2, 40);
  const floor = equivalenceMargin(f, f.slice());
  assert.strictEqual(floor.margin, 1);
  assert.strictEqual(floor.binding, "1 ms floor");
  // No samples: no margin (the gate reads N/A, never a default).
  assert.strictEqual(equivalenceMargin([1], b), null);
  assert.strictEqual(equivalenceMargin(null, b), null);
});

test("stats: the four readings against the equivalence margin (parity no longer needs a sub-ms CI)", () => {
  const { equivalenceMargin, compareOnce, readCI, driftMargin } = stats;
  const off = spreadAround(1000, 1, 40);
  const M = equivalenceMargin(off, off.slice()).margin; // 20 ms, the 2 % term
  const pooled = off.concat(off);
  const read = (cand) => readCI(compareOnce(cand, pooled).ci, M);
  assert.strictEqual(read(spreadAround(950, 1, 40)), "win");
  assert.strictEqual(read(spreadAround(1050, 1, 40)), "loss");
  assert.strictEqual(read(spreadAround(1010, 1, 40)), "parity");
  assert.strictEqual(read(spreadAround(1000, 400, 40)), "inconclusive");
  // The same +10 ms on 1000 ms read against the bootstrap margin alone was a "loss".
  const bootOnly = driftMargin(off, off.slice());
  assert.strictEqual(readCI(compareOnce(spreadAround(1010, 1, 40), pooled).ci, bootOnly), "loss");
});

test("stats: Holm over a family graded at the equivalence margin", () => {
  const { equivalenceMargin, gradeFamily } = stats;
  const off = spreadAround(1000, 1, 40);
  const pooled = off.concat(off);
  const M = equivalenceMargin(off, off.slice()).margin;
  const fam = gradeFamily([
    { key: "win", a: spreadAround(950, 1, 40), b: pooled, margin: M },
    { key: "loss", a: spreadAround(1050, 1, 40), b: pooled, margin: M },
    { key: "parity", a: spreadAround(1010, 1, 40), b: pooled, margin: M },
    { key: "inconclusive", a: spreadAround(1000, 400, 40), b: pooled, margin: M },
  ]);
  const by = Object.fromEntries(fam.map((r) => [r.key, r]));
  assert.deepStrictEqual(
    ["win", "loss", "parity", "inconclusive"].map((k) => by[k].reading),
    ["win", "loss", "parity", "inconclusive"]
  );
  assert.deepStrictEqual(
    ["win", "loss", "parity", "inconclusive"].map((k) => by[k].gate),
    ["PASS", "FAIL", "PASS", "INCONCLUSIVE"]
  );
  for (const r of fam) assert.strictEqual(r.margin, 20);
  // The undecided verb ranks last; Holm alphas by rank are 0.05 / (m − k + 1).
  assert.strictEqual(by.inconclusive.rank, 4);
  assert.deepStrictEqual(
    fam
      .slice()
      .sort((x, y) => x.rank - y.rank)
      .map((r) => r.alpha),
    [0.0125, 0.05 / 3, 0.025, 0.05]
  );
});

test("scoreboard: gate margin is the equivalence margin; footer states the pre-registered rule", () => {
  const md = scoreboardOf(FAMILY());
  const rows = gateRows(md);
  // OFF swipe 300 ± 2 and pinch 350 ± 1: the 2 % term (6, 7 ms) binds.
  assert.strictEqual(rows["swipe+describe"].margin, "±6");
  assert.strictEqual(rows["pinch+describe"].margin, "±7");
  assert.strictEqual(rows["pinch+describe"].reading, "parity");
  assert.match(
    md,
    /pre-registered equivalence margin: 2 % of the proprietary p50 or 1 ms, whichever is larger, never below the measured OFF drift/
  );
  // The drift table publishes the bootstrap margin and the equivalence margin side by side.
  assert.match(
    md,
    /\| verb \| OFF-1 p50 \| OFF-2 p50 \| drift \| bootstrap margin \| equivalence margin \|/
  );
  assert.match(
    md,
    /\| pinch\+describe \(gesture-pinch\) \| 350 \| 350 \| 0 \| ±[\d.]+ \| ±7 \(2% of p50\) \|/
  );
});

/* ------- run 37571460849: empty describes as a quality metric (P11), TTNE ------- */

test("stats: wilsonCI matches the Wilson score interval (95 %)", () => {
  const { wilsonCI } = stats;
  assert.deepStrictEqual(wilsonCI(0, 40), [0, 0.0876]);
  assert.deepStrictEqual(wilsonCI(4, 40), [0.0396, 0.2305]);
  assert.deepStrictEqual(wilsonCI(9, 40), [0.1232, 0.375]);
  assert.deepStrictEqual(wilsonCI(23, 40), [0.422, 0.7149]);
  assert.strictEqual(wilsonCI(0, 0), null);
});

test("stats: p11Gate — PASS if the CI upper bound ≤ 25 %, FAIL if the lower > 25 %, else INCONCLUSIVE; no denominator FAILs", () => {
  const { p11Gate, P11_THRESHOLD } = stats;
  assert.strictEqual(P11_THRESHOLD, 0.25);
  assert.strictEqual(p11Gate(0, 40).gate, "PASS");
  assert.strictEqual(p11Gate(4, 40).gate, "PASS");
  assert.strictEqual(p11Gate(5, 40).gate, "INCONCLUSIVE");
  assert.strictEqual(p11Gate(15, 40).gate, "INCONCLUSIVE");
  assert.strictEqual(p11Gate(16, 40).gate, "FAIL");
  assert.strictEqual(p11Gate(23, 40).gate, "FAIL");
  // Fail closed: empties counted with no denominator, or no denominator at all.
  assert.strictEqual(p11Gate(3, 0).gate, "FAIL");
  assert.strictEqual(p11Gate(0, 0).gate, "FAIL");
  const r = p11Gate(9, 40);
  assert.strictEqual(r.rate, 0.225);
  assert.deepStrictEqual(r.ci, [0.1232, 0.375]);
});

// A verb whose timed window reads a describe: `describeWindows` is the P11 denominator,
// `treeEmpty` the windows with an empty describe (excluded from latencySamples).
const withEmpties = (b, verb, empty, n = 40, extra = {}) => {
  const has = b.block.verbs.some((v) => v.verb === verb);
  if (!has) b.block.verbs.push(mkVerb(verb, 400));
  b.block.verbs = b.block.verbs.map((v) =>
    v.verb === verb ? { ...v, treeEmpty: empty, describeWindows: n, ...extra } : v
  );
  return b;
};
const TD_ON = "tap+describe(settle:false)";
const TD_OFF = "tap+describe";
const p11Run = (offEmpty, onEmpty) => {
  const bs = FOUR();
  for (const b of bs)
    withEmpties(
      b,
      b.block.config === "ON" ? TD_ON : TD_OFF,
      b.block.config === "ON" ? onEmpty : offEmpty
    );
  return bs;
};

test("merge-blocks: P11 grades every timed describe verb per block and fails closed on either arm", () => {
  const cases = [
    [2, 1, "PASS"],
    [2, 9, "INCONCLUSIVE"], // ON 9/40: CI [12.3 %, 37.5 %] straddles 25 %
    [2, 23, "FAIL"], // ON-uiautomation's run 37571460849 rate
    [16, 1, "FAIL"], // the OFF arm alone fails it
  ];
  for (const [offE, onE, want] of cases) {
    const out = freshOut();
    writeBlocks(out, p11Run(offE, onE));
    const r = run(MERGE_BLOCKS, out, ALLENV);
    assert.strictEqual(r.code, 0, r.stderr);
    const m = mergedOf(r);
    assert.strictEqual(m.valid, true, "P11 is a gate, not run validity");
    assert.strictEqual(m.p11.verdict, want, `off ${offE} on ${onE}: ${JSON.stringify(m.p11)}`);
    const row = m.emptyRates.find((x) => x.block === "ON-input-manager" && x.verb === TD_ON);
    assert.deepStrictEqual([row.empty, row.n], [onE, 40]);
    // gesture-tap reads no describe in its timed window: not graded.
    assert.ok(!m.emptyRates.some((x) => x.verb === "gesture-tap"));
  }
});

test("merge-blocks: P11 counts empties with no denominator as FAIL (fail closed)", () => {
  const out = freshOut();
  const bs = FOUR();
  withTreeEmpty(bs[1], "gesture-tap", 3); // old shape: no describeWindows
  writeBlocks(out, bs);
  const m = mergedOf(run(MERGE_BLOCKS, out, ALLENV));
  assert.strictEqual(m.p11.verdict, "FAIL");
  const row = m.emptyRates.find((x) => x.block === "ON-uiautomation");
  assert.strictEqual(row.gate, "FAIL");
  assert.strictEqual(row.n, 0);
});

test("merge-blocks: an ON fallback still throws with P11 in place (fallbacks invalidate, empties do not)", () => {
  const out = freshOut();
  const bs = p11Run(0, 0);
  bs[1].block.openServerFallbacks = {
    count: 2,
    samples: ["[describe.android] open-device-server failed, falling back: x"],
  };
  writeBlocks(out, bs);
  const r = run(MERGE_BLOCKS, out, ALLENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /ON-uiautomation=2/);
});

test("scoreboard: empty-rate rows with Wilson CI, the P11 line, and the time-to-non-empty table", () => {
  const bs = p11Run(9, 23);
  const ttne = {
    measured: 23,
    reached: 22,
    timedOut: 1,
    fromTapMs: { p50: 912.4, p95: 1480.2 },
    afterEmptyMs: { p50: 401.3, p95: 960 },
    fromTapSamples: [],
    afterEmptySamples: [],
  };
  for (const b of bs) for (const v of b.block.verbs) if (v.verb === TD_ON) v.timeToNonEmpty = ttne;
  const md = scoreboardOf(bs);
  assert.match(md, /### Empty describes in timed verbs — quality metric \(P11\)/);
  assert.match(
    md,
    /\| verb \| block \| empty \/ windows \| rate \| Wilson 95% CI \| P11 \(≤ 25 %\) \|/
  );
  assert.match(
    md,
    /\| tap\+describe\(settle:false\) \| ON-uiautomation \| 23\/40 \| 57\.5% \| \[42\.2%, 71\.5%\] \| FAIL \|/
  );
  assert.match(
    md,
    /\| tap\+describe \| OFF-1 \| 9\/40 \| 22\.5% \| \[12\.3%, 37\.5%\] \| INCONCLUSIVE \|/
  );
  assert.match(md, /- \*\*P11\*\* — empty rate ≤ 25 % per timed verb per block.*: \*\*FAIL\*\*/);
  assert.match(md, /excluded from that verb's latency/);
  assert.match(md, /### tap\+describe time-to-non-empty/);
  assert.match(
    md,
    /\| ON-input-manager \| tap\+describe\(settle:false\) \| 23 \| 22 \| 1 \| 912\.4\/1480\.2 \| 401\.3\/960 \|/
  );
  // treeEmpty no longer reads as invalidating.
  assert.doesNotMatch(md, /Any treeEmpty or ON fallback invalidates the block/);
});

test("scoreboard: the reset table carries the probe's decision-reason histogram", () => {
  const bs = FOUR();
  for (const b of bs)
    b.block.resetWait = {
      n: 4,
      meanMs: 900,
      maxMs: 1200,
      timeouts: 0,
      relaunches: 1,
      reasons: {
        "wait:kill-guard": 30,
        "wait:dead-record": 3,
        "relaunch:dead-record": 1,
        "outcome:ready": 4,
      },
    };
  const md = scoreboardOf(bs);
  assert.match(
    md,
    /\| block \| resets \| resetWaitMs mean \| resetWaitMs max \| timeouts \| relaunches \| probe reasons \|/
  );
  assert.match(
    md,
    /\| OFF-1 \| 4 \| 900 \| 1200 \| 0 \| 1 \| wait:kill-guard=30, outcome:ready=4, wait:dead-record=3, relaunch:dead-record=1 \|/
  );
});

test("bench: empty samples leave the latency stats on both arms; TTNE from the 50 ms / 3 s loop; no treeEmpty fatal", () => {
  const src = fs.readFileSync(BENCH_TS, "utf8");
  assert.doesNotMatch(src, /assertNoTimedTreeEmpty\(blocks\)/);
  assert.match(src, /emptyLatencySamples/);
  assert.match(src, /describeWindows/);
  // Run 37578606526: time-to-non-empty is the first non-empty read of the time-to-correct
  // loop (tap-describe-destination.js: 50 ms apart, up to 3 s, was 2 s).
  assert.strictEqual(require("./tap-describe-destination").TTC_POLL_MS, 50);
  assert.strictEqual(require("./tap-describe-destination").TTC_BUDGET_MS, 3000);
  // TTNE runs for every tap+describe variant, through the same timeTapEffect hook.
  assert.match(src, /timeToNonEmpty/);
});

/* ---------- run 37571460849: every requested block runs or says it did not ---------- */

test("block-validity: --did-not-run records an explicit not-run entry that is not INVALID by itself", () => {
  const out = freshOut();
  execFileSync(
    "node",
    [
      VALIDITY,
      "record",
      path.join(out, "validity.json"),
      "--block",
      "OFF-2",
      "--did-not-run",
      "emulator lost",
    ],
    { encoding: "utf8" }
  );
  const v = JSON.parse(fs.readFileSync(path.join(out, "validity.json"), "utf8"));
  assert.strictEqual(v.blocks["OFF-2"].ran, false);
  assert.strictEqual(v.blocks["OFF-2"].notRunReason, "emulator lost");
  const { entryReasons } = require(VALIDITY);
  assert.deepStrictEqual(entryReasons(v.blocks["OFF-2"]), []);
});

test("merge-blocks: a requested block with neither a JSON nor a validity entry makes the run INVALID", () => {
  const out = freshOut();
  const bs = FOUR().filter((b) => b.block.block !== "OFF-2");
  writeBlocks(out, bs);
  recordValidity(
    out,
    ALL_OK(["OFF-1", "ON-uiautomation", "ON-input-manager"]).map((e) => ({ ...e, stamped: "n/a" }))
  );
  const m = mergedOf(run(MERGE_BLOCKS, out, ALLENV));
  assert.strictEqual(m.valid, false);
  assert.match(
    m.runInvalidReasons.join(" "),
    /requested block OFF-2 has no bench-block-OFF-2\.json and no validity entry/
  );
});

test("merge-blocks: the same gap with BENCH_REQUIRE_VALIDITY=1 and no validity.json at all is INVALID", () => {
  const out = freshOut();
  writeBlocks(
    out,
    FOUR().filter((b) => b.block.block !== "OFF-2")
  );
  const m = mergedOf(run(MERGE_BLOCKS, out, { ...ALLENV, BENCH_REQUIRE_VALIDITY: "1" }));
  assert.strictEqual(m.valid, false);
  assert.match(m.runInvalidReasons.join(" "), /requested block OFF-2/);
});

test("merge-blocks: an explicit did-not-run entry accounts for the block and is listed in notRun", () => {
  const out = freshOut();
  writeBlocks(
    out,
    FOUR().filter((b) => b.block.block !== "OFF-2")
  );
  recordValidity(
    out,
    ALL_OK(["OFF-1", "ON-uiautomation", "ON-input-manager"]).map((e) => ({ ...e, stamped: "n/a" }))
  );
  execFileSync("node", [
    VALIDITY,
    "record",
    path.join(out, "validity.json"),
    "--block",
    "OFF-2",
    "--did-not-run",
    "proprietary not executable on this runner",
  ]);
  const m = mergedOf(run(MERGE_BLOCKS, out, ALLENV));
  assert.ok(
    !m.runInvalidReasons.some((x) => /requested block OFF-2/.test(x)),
    JSON.stringify(m.runInvalidReasons)
  );
  assert.deepStrictEqual(m.notRun, [
    { block: "OFF-2", reason: "proprietary not executable on this runner" },
  ]);
});

test("workflow: every block runs regardless of an earlier block's failure; every skip records did-not-run", () => {
  const y = fs.readFileSync(WORKFLOW, "utf8");
  const step = y.slice(y.indexOf("- name: Latency bench"), y.indexOf("- name: Scoreboard"));
  // Run 37571460849: a block condition must never read an earlier block's result.
  const loop = step.slice(step.indexOf('for b in "${REQ_BLOCKS[@]}"'), step.indexOf("done\n"));
  assert.doesNotMatch(loop, /if \[ "\$(OFF|ON|LEGACY)_FAILED"/);
  // The emulator-lost early return, the ON-only downgrade and the legacy skips record it.
  assert.ok((step.match(/--did-not-run/g) || []).length >= 1);
  assert.ok((step.match(/record_not_run /g) || []).length >= 4, "record_not_run call sites");
  assert.match(step, /BENCH_REQUIRE_VALIDITY: "1"/);
});

/* ------ run 37578606526 / finding 12: tap+describe destination check, P5 time-to-correct ------ */

// Literal require so knip traces the test-only exports.
const dest = require("./tap-describe-destination");
const HEADER =
  "Source: open-device-server\nMode: nested\nCoordinates are normalized [0,1] fractions of the screen.\n\n";
// Settings root (homepage) and the Network & internet sub-screen, formatDescribeTree shape.
const ROOT_TREE =
  HEADER +
  "ROOT  Screen (0.000, 0.000, 1.000, 1.000)\n\n" +
  '  ScrollView id="settings_homepage_container" [scrollable]  (0.000, 0.053, 1.000, 0.921)\n' +
  '  TextView "Search settings" id="search_action_bar_title"  (0.100, 0.080, 0.600, 0.030)\n' +
  '  StaticText "Network & internet" id="title"  (0.175, 0.200, 0.400, 0.030)\n' +
  '  StaticText "Mobile, Wi‑Fi, hotspot" id="summary"  (0.175, 0.230, 0.400, 0.021)\n' +
  '  StaticText "Connected devices" id="title"  (0.175, 0.300, 0.400, 0.030)\n' +
  '  StaticText "Apps" id="title"  (0.175, 0.400, 0.400, 0.030)\n';
const DEST_TREE =
  HEADER +
  "ROOT  Screen (0.000, 0.000, 1.000, 1.000)\n\n" +
  '  FrameLayout "Network & internet" id="collapsing_toolbar"  (0.000, 0.000, 1.000, 0.249)\n' +
  '  Button "Navigate up" [clickable]  (0.000, 0.053, 0.136, 0.061)\n' +
  '  StaticText "Internet" id="title"  (0.175, 0.267, 0.167, 0.030)\n' +
  '  StaticText "AndroidWifi" id="summary"  (0.175, 0.296, 0.178, 0.021)\n' +
  '  StaticText "SIMs" id="title"  (0.175, 0.438, 0.109, 0.030)\n';
const EMPTY_TREE = HEADER + "ROOT  Screen (0.000, 0.000, 1.000, 1.000)\n\n";

test("destination: markers are the id+text keys on one settled tree and not the other", () => {
  const m = dest.deriveDestinationMarkers(ROOT_TREE, DEST_TREE);
  assert.strictEqual(m.valid, true);
  // On both screens (the root row and the sub-screen title; the shared ids): neither.
  for (const k of ["text:Network & internet", "id:title", "id:summary"]) {
    assert.ok(!m.dest.includes(k) && !m.root.includes(k), k);
  }
  for (const k of ["text:Navigate up", "text:Internet", "text:SIMs", "id:collapsing_toolbar"])
    assert.ok(m.dest.includes(k), k);
  for (const k of ["text:Connected devices", "text:Apps", "id:settings_homepage_container"])
    assert.ok(m.root.includes(k), k);
  // A destination read that was still the root yields no markers: invalid, re-derive.
  assert.strictEqual(dest.deriveDestinationMarkers(ROOT_TREE, ROOT_TREE).valid, false);
  assert.strictEqual(dest.classifyDestination({ description: EMPTY_TREE }, m), "empty");
});

test("destination: classifier — correct / pre-transition / empty / other on fixed trees", () => {
  const m = dest.deriveDestinationMarkers(ROOT_TREE, DEST_TREE);
  const c = (description, extra = {}) => dest.classifyDestination({ description, ...extra }, m);
  assert.strictEqual(c(DEST_TREE), "correct");
  assert.strictEqual(c(ROOT_TREE), "preTransition");
  assert.strictEqual(c(EMPTY_TREE), "empty");
  // The open server's marker counts as empty even with a window line.
  assert.strictEqual(c(DEST_TREE, { treeEmpty: true }), "empty");
  // Mixed (both windows in the tree mid-transition): a root-only marker present → pre-transition/mixed (run 37591260027 finding 2: not a cached tree, the screen as it was).
  assert.strictEqual(
    c(DEST_TREE + '  StaticText "Apps" id="title"  (0.1, 0.9, 0.2, 0.03)\n'),
    "preTransition"
  );
  // Neither marker set: a dialog or another app.
  const dialog =
    HEADER +
    "ROOT  Screen (0, 0, 1, 1)\n\n" +
    '  StaticText "Settings keeps stopping" id="alertTitle"  (0.1, 0.4, 0.8, 0.05)\n';
  assert.strictEqual(c(dialog), "other");
  // Only the shared title, nothing screen-specific: other, never correct.
  assert.strictEqual(
    c(
      HEADER +
        'ROOT  Screen (0, 0, 1, 1)\n\n  StaticText "Network & internet" id="title"  (0, 0, 1, 0.1)\n'
    ),
    "other"
  );
  // A failed call or no markers: other.
  assert.strictEqual(dest.classifyDestination(undefined, m), "other");
  assert.strictEqual(dest.classifyDestination({ description: DEST_TREE }, null), "other");
  // Same selector on the OFF rendering (different id spelling): its own markers classify it.
  const offRoot = ROOT_TREE.replace(/id="/g, 'id="com.android.settings:id/');
  const offDest = DEST_TREE.replace(/id="/g, 'id="com.android.settings:id/');
  const mo = dest.deriveDestinationMarkers(offRoot, offDest);
  assert.strictEqual(dest.classifyDestination({ description: offDest }, mo), "correct");
  assert.strictEqual(dest.classifyDestination({ description: offRoot }, mo), "preTransition");
});

test("destination: rates with Wilson CIs; correct-only latency; time-to-correct per sample", () => {
  const r = dest.destinationRates(
    { correct: 19, stale: 0, empty: 21 } /* pre-run-37591260027 key */
  );
  assert.strictEqual(r.n, 40);
  assert.deepStrictEqual(r.counts, { correct: 19, preTransition: 0, empty: 21, other: 0 });
  assert.strictEqual(r.rates.correct.rate, 0.475);
  assert.deepStrictEqual(r.rates.correct.ci, stats.wilsonCI(19, 40));
  assert.deepStrictEqual(r.rates.preTransition.ci, [0, 0.0876]);
  assert.deepStrictEqual(r.rates.empty.ci, stats.wilsonCI(21, 40));
  assert.strictEqual(dest.destinationRates({}).rates.correct.ci, null);

  const s = dest.summarizeDestination([
    { cls: "correct", latencyMs: 300, ttcMs: 300, censoredAtMs: null, polls: 0 },
    {
      i: 2,
      cls: "stale" /* old name, counted as preTransition */,
      latencyMs: 200,
      ttcMs: 1100,
      censoredAtMs: null,
      polls: 12,
    },
    { cls: "empty", latencyMs: 700, ttcMs: 900, censoredAtMs: null, polls: 3 },
    { cls: "correct", latencyMs: 500, ttcMs: 500, censoredAtMs: null, polls: 0 },
    { cls: "other", latencyMs: 250, ttcMs: null, censoredAtMs: 3260, polls: 50 },
  ]);
  assert.deepStrictEqual(s.destination.counts, {
    correct: 2,
    preTransition: 1,
    empty: 1,
    other: 1,
  });
  // The honest headline: latency over CORRECT reads only (the 200 ms pre-transition read is out).
  assert.deepStrictEqual(s.destination.correctLatencySamples, [300, 500]);
  assert.strictEqual(s.destination.correctLatency.p50, 400);
  const t = s.timeToCorrect;
  assert.deepStrictEqual([t.measured, t.reached, t.timedOut, t.firstRead], [5, 4, 1, 2]);
  assert.strictEqual(t.fromTapMs.p50, 700);
  assert.deepStrictEqual([t.pollMs, t.budgetMs], [50, 3000]);
  // A timed-out sample enters a gate at the give-up time and is counted.
  assert.deepStrictEqual(dest.ttcGateSamples(t), {
    samples: [300, 1100, 900, 500, 3260],
    timedOut: 1,
  });
  assert.strictEqual(dest.ttcGateSamples(null), null);
});

// A tap+describe verb with a first-read latency centre and a time-to-correct centre.
const tdVerb = (verb, firstRead, ttc, o = {}) => {
  const n = o.n || 40;
  const v = vS(verb, firstRead, o.spread || 8, n);
  const t = spreadAround(ttc, o.spread || 8, n);
  const timedOut = o.timedOut || 0;
  const counts = o.counts || { correct: n, stale: 0, empty: 0, other: 0 };
  const samples = t.map((x, i) => (i < timedOut ? null : x));
  v.destination = {
    classes: [],
    ...dest.destinationRates(counts),
    correctLatency: { p50: firstRead, p95: firstRead + 8 },
    correctLatencySamples: [],
  };
  v.timeToCorrect = {
    pollMs: 50,
    budgetMs: 3000,
    measured: n,
    reached: n - timedOut,
    timedOut,
    firstRead: counts.correct,
    fromTapMs: { p50: ttc, p95: ttc + 8 },
    samples,
    censoredAtMs: samples.map((x, i) => (x == null ? t[i] : null)),
    polls: [],
  };
  return v;
};
// Run 37578606526's shape: OFF reads first at ~265 ms but its destination arrives late;
// ON settle:false reads first at ~330 ms, settle:true at ~810 ms.
const TTC_RUN = (o = {}) => {
  const tap = (p50) => vS("gesture-tap", p50, 2);
  const swipe = vS("gesture-swipe", 300, 2);
  const pinch = vS("gesture-pinch", 350, 1);
  const off = (name, ttc) =>
    block(name, {
      verbs: [
        tap(60),
        swipe,
        pinch,
        tdVerb("tap+describe", 265, ttc, {
          counts: { correct: 14, stale: 17, empty: 8, other: 1 },
          ...(o.offTd || {}),
        }),
      ],
    });
  const on = (name) =>
    block(name, {
      verbs: [
        tap(60),
        swipe,
        pinch,
        tdVerb("tap+describe(settle:false)", 330, o.onFalse ?? 800, {
          counts: { correct: 15, stale: 4, empty: 21, other: 0 },
          ...(o.onTd || {}),
        }),
        tdVerb("tap+describe(settle:true)", 810, o.onTrue ?? 900, {
          counts: { correct: 33, stale: 6, empty: 1, other: 0 },
        }),
      ],
    });
  return [
    off("OFF-1", o.off1 ?? 1000),
    on("ON-uiautomation"),
    on("ON-input-manager"),
    off("OFF-2", o.off2 ?? 1000),
  ];
};

test("merge-blocks: destination rows (correct/pre-transition/empty/other + Wilson CIs) and P12 pre-transition rates per block", () => {
  const out = freshOut();
  writeBlocks(out, TTC_RUN());
  const m = mergedOf(run(MERGE_BLOCKS, out, ALLENV));
  const row = m.destinationRates.find((x) => x.block === "OFF-1" && x.verb === "tap+describe");
  assert.deepStrictEqual(row.counts, { correct: 14, preTransition: 17, empty: 8, other: 1 });
  assert.strictEqual(row.n, 40);
  assert.deepStrictEqual(row.rates.preTransition.ci, stats.wilsonCI(17, 40));
  assert.strictEqual(row.timeToCorrect.reached, 40);
  // Both ON rows carry it.
  assert.ok(
    m.destinationRates.some(
      (x) => x.block === "ON-input-manager" && x.verb === "tap+describe(settle:true)"
    )
  );
  // P12: report only, one pre-transition/mixed rate per (block, verb).
  assert.strictEqual(m.p12.reportOnly, true);
  const p12 = m.p12.rows.find(
    (x) => x.block === "ON-uiautomation" && x.verb === "tap+describe(settle:false)"
  );
  assert.deepStrictEqual([p12.preTransition, p12.n, p12.rate], [4, 40, 0.1]);
  assert.deepStrictEqual(p12.ci, stats.wilsonCI(4, 40));
  assert.strictEqual(m.valid, true, "P12 is report only");
});

test("bench: tap+describe classifies every timed read and runs time-to-correct on ALL samples (50 ms / 3 s)", () => {
  const src = fs.readFileSync(BENCH_TS, "utf8");
  assert.match(src, /from "\.\.\/\.\.\/\.\.\/\.github\/bench-ci\/tap-describe-destination(\.js)?"/);
  assert.match(src, /classifyDestination\(/);
  assert.match(src, /deriveDestinationMarkers\(/);
  assert.match(src, /summarizeDestination\(/);
  assert.match(src, /TTC_POLL_MS/);
  assert.match(src, /TTC_BUDGET_MS/);
  // The loop no longer runs only after an empty window.
  assert.doesNotMatch(src, /if \(wasEmpty && onEmpty\)/);
  assert.strictEqual(dest.TTC_POLL_MS, 50);
  assert.strictEqual(dest.TTC_BUDGET_MS, 3000);
});

/* ---- Review 2026-10-07 run 37591260027: ABBA, block-level CI, P3/P4/P5 rows, Part A ---- */

// Literal destructured require so knip traces the test-only exports.
const { tCdf, tQuantile, welchBlocks, LOSS_WITHIN, WIN_WITHIN } = require("./stats");

test("stats: Student t quantiles and the Welch block-level interval", () => {
  // Reference values (R: qt(0.975, df)).
  for (const [p, df, want] of [
    [0.975, 2, 4.302653],
    [0.975, 4, 2.776445],
    [0.975, 10, 2.228139],
    [0.995, 4, 4.604095],
  ])
    assert.ok(Math.abs(tQuantile(p, df) - want) < 1e-5, `qt(${p}, ${df})`);
  assert.strictEqual(tCdf(0, 3), 0.5);
  assert.ok(Math.abs(tCdf(2.776445, 4) - 0.975) < 1e-6);
  // Welch on block values: Δ = mean(a) − mean(b), se from the between-block variances.
  const w = welchBlocks([836, 840, 844], [896, 900, 904]);
  assert.strictEqual(w.delta, -60);
  assert.ok(Math.abs(w.se - Math.sqrt(16 / 3 + 16 / 3)) < 1e-9);
  assert.strictEqual(w.df, 4);
  assert.strictEqual(welchBlocks([1], [2, 3]), null, "one block: no between-block variance");
  assert.strictEqual(stats.readCI([1.0, 1.7], 1.1, 1.3), LOSS_WITHIN);
  assert.strictEqual(stats.readCI([-1.7, -1.0], 1.1, -1.3), WIN_WITHIN);
});

const ABBA = ["OFF-1", "ON-im-1", "ON-uia", "OFF-2", "ON-im-2", "OFF-3", "ON-im-3"];
const ABBAENV = { BENCH_BLOCKS: ABBA.join(",") };
const abbaStart = (n) =>
  new Date(Date.UTC(2026, 9, 8, 10, 0) + ABBA.indexOf(n) * 60_000).toISOString();
const withNoDrain = (v, p50) => ({
  ...v,
  drainRead: "describe(settle:false)",
  noDrain: { latency: { p50, p95: p50 + 8 }, latencySamples: spreadAround(p50, 8, 40) },
});
// Run 37591260027's shape, with a small per-block offset so the between-block variance is
// not zero: swipe+describe OFF 900 vs ON 840, swipe alone 295 vs 272; pinch+describe 720
// vs 216, pinch alone 354 vs 317; tap+await-idle+describe time-to-correct OFF 1300 vs ON
// 900, correct at first read OFF 5/40 vs ON 30/40. ON settle:false has the SMALLEST
// time-to-correct (500 ms): P5 must not pick it.
const ABBA_RUN = (o = {}) =>
  ABBA.map((name) => {
    const off = name.startsWith("OFF");
    const k = ABBA.filter((x) => x.startsWith(off ? "OFF" : name.slice(0, 5))).indexOf(name);
    const d = (k - 1) * 4;
    const tap = o.tap ? o.tap(name, off, k) : (off ? 60 : 58) + d / 4;
    const verbs = [
      vS("gesture-tap", tap, o.tapSpread ?? 2),
      ...(o.onlyTap
        ? []
        : [
            withNoDrain(vS("gesture-swipe", (off ? 900 : 840) + d, 8), (off ? 295 : 272) + d),
            withNoDrain(vS("gesture-pinch", (off ? 720 : 216) + d, 8), (off ? 354 : 317) + d),
            tdVerb("tap+describe(settle:false)", off ? 265 : 330, (off ? 1500 : 500) + d, {
              counts: { correct: off ? 2 : 10, preTransition: off ? 30 : 5, empty: 8, other: 0 },
            }),
            tdVerb("tap+describe(settle:true)", off ? 265 : 810, (off ? 1500 : 950) + d, {
              counts: { correct: off ? 2 : 25, preTransition: off ? 30 : 5, empty: 8, other: 0 },
            }),
            tdVerb("tap+await-idle+describe", off ? 900 : 700, (off ? 1300 : 900) + d, {
              counts: {
                correct: off ? 5 : 30,
                preTransition: off ? 25 : 2,
                empty: off ? 10 : 8,
                other: 0,
              },
            }),
          ]),
    ];
    const b = block(name, { verbs, ...(o.over && o.over[name] ? o.over[name] : {}) });
    b.env.startedAt = abbaStart(name);
    return b;
  });

test("merge-blocks (ABBA): the BENCH_BLOCKS order holds → valid; an out-of-order block → INVALID", () => {
  const out = freshOut();
  writeBlocks(out, ABBA_RUN());
  const m = mergedOf(run(MERGE_BLOCKS, out, ABBAENV));
  assert.strictEqual(m.valid, true, JSON.stringify(m.runInvalidReasons));
  assert.deepStrictEqual(m.blocksRan, ABBA);
  assert.deepStrictEqual(Object.keys(m.q4ByBlock), ["ON-im-1", "ON-im-2", "ON-im-3"]);
  const out2 = freshOut();
  const bs = ABBA_RUN();
  bs[ABBA.indexOf("OFF-3")].env.startedAt = "2026-10-08T10:03:30.000Z"; // before ON-im-2
  writeBlocks(out2, bs);
  const m2 = mergedOf(run(MERGE_BLOCKS, out2, ABBAENV));
  assert.strictEqual(m2.valid, false);
  assert.match(
    m2.runInvalidReasons.join(" "),
    /ON-im-2 .*did not start after OFF-2|OFF-3 .*did not start after ON-im-2/
  );
});

test("merge-blocks (ABBA): Q4 applies to every ON-im block; P0 needs the ON-uia control", () => {
  const out = freshOut();
  writeBlocks(
    out,
    ABBA_RUN({ over: { "ON-im-2": { injectStrategyCounts: { "input-manager": 160 } } } })
  );
  const r = run(MERGE_BLOCKS, out, ABBAENV);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /Q4: ON-im-2 on-device injectStrategyCounts\["input-manager"\]=160/);
  const out2 = freshOut();
  writeBlocks(
    out2,
    ABBA_RUN().filter((b) => b.block.block !== "ON-uia")
  );
  const r2 = run(MERGE_BLOCKS, out2, {
    BENCH_BLOCKS: ABBA.filter((n) => n !== "ON-uia").join(","),
  });
  assert.strictEqual(r2.code, 1);
  assert.match(r2.stderr, /P0 VOID: ON-im-1, ON-im-2, ON-im-3 ran/);
});

test("scoreboard (ABBA): primary CI = Welch t on the block p50s (between-block variance); within-block CI secondary", () => {
  const md = scoreboardOf(ABBA_RUN(), ABBAENV);
  assert.match(
    md,
    /Primary CI: \*\*block-level: Welch t on the block p50s \(3 ON-im vs 3 OFF blocks\)\*\*/
  );
  const rows = gateRows(md);
  assert.deepStrictEqual(Object.keys(rows).sort(), [
    "gesture-tap",
    "pinch (gesture only)",
    "pinch+describe",
    "swipe (gesture only)",
    "swipe+describe",
    "tap+await-idle+describe correct-at-first-read",
    "tap+await-idle+describe time-to-correct",
  ]);
  // Per-block p50s are printed; Δ = mean(ON-im block p50s) − mean(OFF block p50s).
  assert.strictEqual(rows["swipe+describe"].im, "836 / 840 / 844");
  assert.strictEqual(rows["swipe+describe"].off, "896 / 900 / 904");
  assert.strictEqual(rows["swipe+describe"].delta, "-60");
  // The primary CI is the stats.gradeFamilyBlocks interval; the secondary is the pooled bootstrap.
  const fam = stats.gradeFamilyBlocks([
    { key: "x", a: [836, 840, 844], b: [896, 900, 904], margin: 18 },
  ]);
  assert.strictEqual(fam[0].method, "Welch t on block values");
  assert.match(rows["swipe+describe"].ci, /^\[-?[\d.]+, -?[\d.]+\] @\d/);
  assert.match(rows["swipe+describe"].secondary, /^-60, \[-?[\d.]+, -?[\d.]+\], /);
  // Rates are in percentage points, higher is better.
  assert.strictEqual(rows["tap+await-idle+describe correct-at-first-read"].margin, "±10 pp");
  assert.match(md, /### Current OFF arm per block \(ABBA\)/);
  assert.match(md, /Welch t interval on the block p50s/);
  assert.match(md, /Block-level variance captured: 3 ON-im and 3 OFF blocks/);
});

test("scoreboard (ABBA): P3/P4 report swipe+describe AND the gesture alone; the decision names both", () => {
  const md = scoreboardOf(ABBA_RUN(), ABBAENV);
  const rows = gateRows(md);
  for (const [id, a, b] of [
    ["P3", "swipe+describe", "swipe (gesture only)"],
    ["P4", "pinch+describe", "pinch (gesture only)"],
  ]) {
    const l = pLine(md, id);
    for (const k of [a, b]) {
      assert.ok(l.includes(`${k}: Δ ${rows[k].delta}`), `${id} ${k}: ${l}`);
      assert.ok(l.includes(`reading ${rows[k].reading}`), `${id} ${k} reading: ${l}`);
    }
    assert.ok(l.includes(`Promotion decision: both rows (${a} AND ${b}); PASS needs both`), l);
    const gates = [rows[a], rows[b]].map((r) =>
      stats.gateOf(r.reading.replace(/ \(Holm stop\)$/, ""))
    );
    if (gates.every((g) => g === "PASS")) assert.match(l, /\*\*PASS\*\*$/);
    else assert.doesNotMatch(l, /\*\*PASS\*\*$/);
  }
  // Relabelled everywhere a verb name is printed.
  assert.match(md, /\| swipe\+describe \(gesture-swipe\) \|/);
  assert.match(md, /### swipe\+describe \/ pinch\+describe and the gesture alone/);
});

test("scoreboard (ABBA): P5 is the await variant (time-to-correct AND correct-at-first-read); faster settle variants stay report only", () => {
  const md = scoreboardOf(ABBA_RUN(), ABBAENV);
  const rows = gateRows(md);
  assert.ok(!Object.keys(rows).some((k) => /settle/.test(k)), Object.keys(rows).join(", "));
  const p5 = pLine(md, "P5");
  assert.match(p5, /pre-registered on tap\+await-idle\+describe on both arms/);
  assert.match(p5, /tap\+await-idle\+describe time-to-correct: Δ -400/);
  assert.match(p5, /tap\+await-idle\+describe correct-at-first-read: Δ 62\.5 pp/);
  assert.doesNotMatch(p5, /settle:false/);
  assert.match(p5, /\*\*PASS\*\*$/);
  // The other variants are printed, labelled report only, with the gated one marked.
  assert.match(md, /only tap\+await-idle\+describe is gated \(P5\); the others are report only/);
  assert.match(md, /\| tap\+describe\(settle:false\) \| ON-im \| [\d.]+ \| 500 \|/);
  assert.match(md, /\| tap\+await-idle\+describe \(gated, P5\) \| OFF \|/);
});

test("stats + scoreboard: finding 7 — CI excluding zero with the point outside the margin reads loss (within/at margin), NOT PASSED", () => {
  const { readCI, gateOf } = stats;
  // Run 37591260027 P2: Δ +1.3, CI [1.0, 1.7], margin ±1.1.
  assert.strictEqual(readCI([1.0, 1.7], 1.1, 1.3), LOSS_WITHIN);
  assert.strictEqual(gateOf(LOSS_WITHIN), "NOT PASSED");
  assert.strictEqual(readCI([-1.7, -1.0], 1.1, -1.3), WIN_WITHIN);
  assert.strictEqual(gateOf(WIN_WITHIN), "PASS");
  // Point inside the margin, or no point given: still inconclusive.
  assert.strictEqual(readCI([0.3, 1.3], 1.1, 0.8), "inconclusive");
  assert.strictEqual(readCI([1.0, 1.7], 1.1), "inconclusive");
  // Block-level P2 with OFF block p50s 51.6/52/52.4 and ON-im 53.1/53.3/53.5.
  const tapP50 = {
    "OFF-1": 52,
    "OFF-2": 52.4,
    "OFF-3": 51.6,
    "ON-im-1": 53.3,
    "ON-im-2": 53.5,
    "ON-im-3": 53.1,
    "ON-uia": 53,
  };
  const md = scoreboardOf(
    ABBA_RUN({ onlyTap: true, tapSpread: 0.2, tap: (name) => tapP50[name] }),
    ABBAENV
  );
  const p2 = pLine(md, "P2");
  assert.match(p2, /Δ 1\.3 \(\+2\.5 % of OFF\)/);
  assert.match(p2, /reading loss \(within\/at margin\)/);
  assert.match(p2, /NOT PASSED: ON 1\.3 ms slower/);
  assert.match(p2, /\*\*NOT PASSED\*\*$/);
});

test("merge + scoreboard: transition timeline from the BENCH markers, CPU per phase, Part A statement", () => {
  const out = freshOut();
  writeBlocks(out, ABBA_RUN());
  const { markerMessage } = require("./logcat-timeline");
  fs.writeFileSync(
    path.join(out, "logcat-bench.txt"),
    [
      `10-08 10:00:45.300  4321  4321 I BENCH   : ${markerMessage("OFF-1", "tap+await-idle+describe", 0)}`,
      "10-08 10:00:46.236   843   910 V WindowManagerShell: onTransitionReady android.os.BinderProxy@1: {id=136 t=OPEN f=0x0}",
      "10-08 10:00:46.239   524   545 I ActivityTaskManager: Displayed com.android.settings/.SubSettings for user 0: +782ms",
      "10-08 10:00:46.730   524   545 V WindowManager: Finish Transition #136: created at 10-08 10:00:45.366 ready=1ms finished=1363ms",
    ].join("\n") + "\n"
  );
  const S = (t, ctx, q, sim, dev) => ({
    epochMs: t * 1000,
    context: ctx,
    qemu: [{ pid: 1, ticks: q }],
    simServer: sim == null ? [] : [{ pid: 2, ticks: sim }],
    device: [{ pid: 3, name: "com.argent.androiddevtools", ticks: dev }],
  });
  fs.writeFileSync(
    path.join(out, "load-samples.jsonl"),
    [
      S(0, "block OFF-1 phase tap+describe", 0, 0, 0),
      S(10, "block OFF-1 phase tap+describe", 2500, 100, 50),
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n"
  );
  fs.writeFileSync(
    path.join(out, "prop-background.json"),
    JSON.stringify({
      probe: {
        workload: "8× adb input swipe",
        windows: [
          {
            window: "A: no simulator-server",
            seconds: 12,
            qemuCpuPct: 150,
            simServerCpuPct: 0,
            simServerAlive: false,
            simLines: 0,
            streamLines: 0,
          },
          {
            window: "B: spawned, no call",
            seconds: 12,
            qemuCpuPct: 210,
            simServerCpuPct: 30,
            simServerAlive: true,
            simLines: 9,
            streamLines: 2,
          },
        ],
        firstStreamLineWindow: "B: spawned, no call",
        debugLogHonoured: true,
        streamLineSamples: [
          "B: spawned, no call: [sim emulator] DEBUG Requesting screenshot stream",
        ],
        qemuDeltaVsNoServerPct: { spawnedIdle: -24.2, afterScreenshot: -36.2 },
        stream: "on-at-spawn",
        verdict: "stream=on: simulator-server opens its screen stream at spawn",
        cpuDeltaCaveat: "The per-window CPU deltas are not evidence of load (fixture caveat).",
      },
    })
  );
  const m = mergedOf(run(MERGE_BLOCKS, out, ABBAENV));
  const tl = m.transitionTimeline["OFF-1"]["tap+await-idle+describe"];
  assert.strictEqual(tl.finishedMs.p50, 1430);
  assert.strictEqual(tl.firstFrameMs.p50, 939);
  assert.strictEqual(m.loadByBlock["OFF-1"]["tap+describe"].qemuCpuPct.p50, 250);
  assert.strictEqual(m.propBackground.stream, "on-at-spawn");
  // Review run 37609765062 findings 2 and 6: the caveat travels through the merge.
  assert.match(m.propBackground.cpuDeltaCaveat, /not evidence of load/);
  const sb = run(SCOREBOARD, out);
  assert.strictEqual(sb.code, 0, sb.stderr);
  assert.match(
    sb.stdout,
    /proprietary stack background: stream=on\*\* because stream=on: simulator-server opens/
  );
  assert.match(sb.stdout, /\| B: spawned, no call \| 12 \| 210 \| 30 \| yes \| 9 \| 2 \|/);
  // Only what the run proves: stream on at spawn, OFF guest more loaded, cause not isolated.
  assert.doesNotMatch(sb.stdout, /cost of the proprietary driver/);
  assert.match(sb.stdout, /CPU deltas are not evidence of load \(fixture caveat\)/);
  assert.match(sb.stdout, /does not isolate the cause/);
  assert.match(sb.stdout, /`ON-im \+ simulator-server idle`/);
  assert.match(sb.stdout, /crossed-await arm/);
  assert.match(sb.stdout, /under-load timeline of each arm/);
  assert.match(sb.stdout, /### CPU per phase \(10 s intervals\)/);
  assert.match(
    sb.stdout,
    /\| OFF-1 \| tap\+describe \| 1 \| 250 \| 10 \(1\/1\) \| 5 \| androiddevtools 5 \|/
  );
  assert.match(sb.stdout, /### Transition timeline per block/);
  assert.match(
    sb.stdout,
    /\| OFF-1 \| tap\+await-idle\+describe \| 1 \| 939\/939 \(1\) \| 1430\/1430 \(1\) \|/
  );
  // Without a probe: said, not guessed.
  const out2 = freshOut();
  writeBlocks(out2, ABBA_RUN());
  assert.strictEqual(run(MERGE_BLOCKS, out2, ABBAENV).code, 0);
  assert.match(run(SCOREBOARD, out2).stdout, /stream=unknown\*\* because no PROBE-BG result/);
});

test("scoreboard: the class reads pre-transition/mixed; no 'stale = a wrong answer' (finding 2)", () => {
  const md = scoreboardOf(TTC_RUN());
  const lines = md.split("\n");
  const i11 = lines.findIndex((l) => l.startsWith("- **P11**"));
  const i12 = lines.findIndex((l) => l.startsWith("- **P12**"));
  assert.ok(i11 >= 0 && i12 === i11 + 1, `P12 right after P11 (${i11}, ${i12})`);
  assert.match(lines[i12], /pre-transition\/mixed tap\+describe reads/);
  assert.match(lines[i12], /OFF-1 tap\+describe 17\/40 = 42\.5% \[/);
  assert.match(
    md,
    /### tap\+describe destination check — correct \/ pre-transition\/mixed \/ empty \/ other/
  );
  assert.match(md, /no sign of a cached tree/);
  assert.doesNotMatch(md, /stale read is a wrong answer/i);
  assert.doesNotMatch(md, /\| stale \|/);
});

test("tap+describe variants: seeded per-sample schedule, N for the gated variant and N/2 for the others", () => {
  assert.deepStrictEqual(dest.TD_VARIANTS, [
    "tap+describe(settle:false)",
    "tap+describe(settle:true)",
    "tap+await-idle+describe",
  ]);
  assert.strictEqual(dest.TD_GATED_VARIANT, "tap+await-idle+describe");
  assert.deepStrictEqual(dest.variantCounts(40), [20, 20, 40]);
  assert.deepStrictEqual(dest.variantCounts(30), [15, 15, 30]);
  const a = dest.variantSchedule([20, 20, 40], "OFF-1");
  assert.deepStrictEqual(a, dest.variantSchedule([20, 20, 40], "OFF-1"), "same seed, same order");
  assert.notDeepStrictEqual(a, dest.variantSchedule([20, 20, 40], "ON-im-1"));
  assert.deepStrictEqual(
    [0, 1, 2].map((v) => a.filter((x) => x === v).length),
    [20, 20, 40]
  );
  // Interleaved: no variant runs as one contiguous block.
  const longest = a.reduce(
    (acc, x, i) => {
      const run = i && a[i - 1] === x ? acc.cur + 1 : 1;
      return { cur: run, max: Math.max(acc.max, run) };
    },
    { cur: 0, max: 0 }
  ).max;
  assert.ok(longest < 10, `longest same-variant run ${longest}`);
});

test("bench: ABBA blocks, interleaved tap+describe variants, screenshot after the last timed verb, ON diagnostics in ON-im-1 only, PROBE-BG", () => {
  const src = fs.readFileSync(BENCH_TS, "utf8");
  const abba = src.slice(src.indexOf("const ABBA_BLOCKS"), src.indexOf("const ALL_BLOCKS"));
  assert.deepStrictEqual(
    [...abba.matchAll(/\["([A-Za-z0-9-]+)", "(?:ON|OFF)"/g)].map((m) => m[1]),
    ["OFF-1", "ON-im-1", "ON-uia", "OFF-2", "ON-im-2", "OFF-3", "ON-im-3", "OFF-legacy"]
  );
  const rb = src.slice(src.indexOf("async function runBlock("));
  assert.match(rb, /variantSchedule\(tdCounts, block\)/);
  assert.match(rb, /timeTapEffectVariants\(\s*tdVariants,\s*tdSchedule,/);
  assert.match(rb, /await reg\.invokeTool\("await-screen-idle", \{ udid: SERIAL \}\)/);
  // The screenshot is taken after the pinch (the last timed verb), not at block start.
  const pinch = rb.indexOf('"gesture-pinch",');
  const shot = rb.indexOf('reg.invokeTool("screenshot"');
  assert.ok(pinch > 0 && shot > pinch, "screenshot after gesture-pinch");
  assert.match(
    src,
    /const ON_DIAGNOSTIC_BLOCKS = new Set\(\["ON-im-1", "ON-input-manager", "ON-uiautomation"\]\)/
  );
  assert.match(rb, /const ping = onDiagnostics \? await measurePing/);
  assert.match(
    src,
    /const INJECT_VERB = \/\^\(gesture-tap\|gesture-swipe\|gesture-pinch\|tap\\\+\)\//
  );
  assert.match(src, /if \(only === PROBE_BG\)/);
  assert.match(src, /SIMSERVER_LOG = "simulator_server=debug"/);
  // Review run 37609765062 findings 2 and 6: the PROBE-BG verdict is the log conclusion
  // only; the CPU deltas stay in the JSON as raw data, next to a fixed caveat.
  const probe = src.slice(
    src.indexOf("async function runPropBackgroundProbe("),
    src.indexOf("function assertNoOpenServerFallback(")
  );
  const vAt = probe.indexOf("const verdict =");
  const verdict = probe.slice(vAt, probe.indexOf("return {", vAt));
  assert.ok(vAt > 0 && verdict.length > 0, "verdict expression found");
  assert.doesNotMatch(verdict, /qemu CPU vs/);
  assert.doesNotMatch(verdict, /\bpp\b/);
  assert.doesNotMatch(verdict, /delta\.|CPU windows/);
  assert.match(probe, /qemuDeltaVsNoServerPct: delta,/);
  assert.match(probe, /cpuDeltaCaveat: PROBE_CPU_DELTA_CAVEAT,/);
  const caveat = src.slice(
    src.indexOf("const PROBE_CPU_DELTA_CAVEAT ="),
    src.indexOf("const PROBE_SWIPES")
  );
  assert.match(caveat, /not evidence of load/);
  assert.match(caveat, /am start/);
  assert.match(caveat, /slower guest/);
  assert.match(caveat, /lifecycle line/);
});

test("workflow: PROBE-BG runs before the first block on the current release; the load sampler runs across the blocks", () => {
  const y = fs.readFileSync(WORKFLOW, "utf8");
  const step = y.slice(y.indexOf("- name: Latency bench"), y.indexOf("- name: Scoreboard"));
  const probe = step.indexOf("BENCH_ONLY=PROBE-BG");
  assert.ok(
    probe > 0 && probe < step.indexOf('for b in "${REQ_BLOCKS[@]}"'),
    "probe before the loop"
  );
  assert.match(
    step,
    /ARGENT_SIMULATOR_SERVER_DIR="\$PROP_PKG\/bin" \\\n\s+ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR="\$PROP_PKG\/bin" \\\n\s+ARGENT_NATIVE_DEVTOOLS_DIR="\$PROP_PKG\/dylibs" \\\n\s+BENCH_ONLY=PROBE-BG/
  );
  assert.match(
    step,
    /node \.github\/bench-ci\/load-sampler\.js --serial emulator-5554 --context "\$BENCH_CONTEXT_FILE"/
  );
  assert.match(step, /stop_load_sampler\n\s+node \.github\/bench-ci\/merge-blocks\.js/);
});
