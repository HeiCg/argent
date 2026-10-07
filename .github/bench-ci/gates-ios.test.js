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

/** The serving path every sample of a healthy block records (C.1): the tree
 * source for describe, the injector for gestures, both for tap+describe. */
function healthyPaths(name) {
  const isOff = name.startsWith("OFF");
  const tree = isOff ? "ax-service" : "xcuitest-runner";
  const input = isOff
    ? "simulator-server"
    : name === "ON-siminput"
      ? "sim-input"
      : "open-device-server";
  return { tree, input, both: `${input}+${tree}` };
}

/** A healthy per-block file. Override any field of `.block`. */
function block(name, over = {}) {
  const isOff = name.startsWith("OFF");
  const p = healthyPaths(name);
  const served = (path) => ({ servedBy: samples(path) });
  const measured = [
    verb("describe", served(p.tree)),
    verb("gesture-tap", { effectChecked: N, effectZero: 0, ...served(p.input) }),
    verb("tap+describe", served(p.both)),
    verb("gesture-swipe", served(p.input)),
  ];
  const awaits = isOff
    ? [verb("await-screen-idle"), verb("await-ui-element")]
    : [naVerb("await-screen-idle"), naVerb("await-ui-element")];
  return {
    env: { N, runId: "test", sha: "deadbeef" },
    block: {
      block: name,
      config: isOff ? "OFF" : "ON",
      intendedBackend: isOff ? "ax-service" : "xcuitest",
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
      connectionErrors: 0,
      firstConnectionError: null,
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
  assert.match(r.stdout, /G0\/G1\/G3 \+ gesture-drift \+ validity gates: OK/);
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

test("C.3: connectionErrors > 0 fails the merge and quotes the first error", () => {
  const out = freshOut();
  const blocks = ALL();
  blocks[1].block.connectionErrors = 2;
  blocks[1].block.firstConnectionError = "connect ECONNREFUSED 127.0.0.1:64039";
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(
    r.stderr,
    /G1: ON-xcuitest connectionErrors=2 \(must be 0\); first: "connect ECONNREFUSED 127\.0\.0\.1:64039"/
  );
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

// ── Re-baseline (0.27): the OFF arm's simulator-server provenance ─────────────
// The download step records the requested tag, the release that tag resolved to
// (gh release view) and the sha256 of the downloaded binary; the merge folds it
// into the merged JSON and the scoreboard renders it.
const PROVENANCE = path.join(HERE, "proprietary-provenance.js");
const SCOREBOARD = path.join(HERE, "scoreboard-ios.js");

function releaseJson(binSha) {
  return {
    tagName: "radon-main",
    name: "radon-main",
    publishedAt: "2026-10-02T14:09:49Z",
    createdAt: "2026-10-02T14:00:00Z",
    url: "https://github.com/software-mansion-labs/simulator-server-releases/releases/tag/radon-main",
    assets: [
      {
        name: "simulator-server-argent-macos",
        id: "RA_kwDONufWMs4kGvpq",
        apiUrl:
          "https://api.github.com/repos/software-mansion-labs/simulator-server-releases/releases/assets/605747818",
        digest: `sha256:${binSha}`,
        size: 18217840,
        updatedAt: "2026-10-02T14:09:49Z",
      },
    ],
  };
}

test("provenance: gh-release records requested/resolved tag, asset id and binary sha256", () => {
  const { githubReleaseProvenance, sha256File } = require(PROVENANCE);
  const dir = freshOut();
  const bin = path.join(dir, "simulator-server");
  fs.writeFileSync(bin, "mach-o bytes");
  const sha = sha256File(bin);
  const p = githubReleaseProvenance({
    repo: "software-mansion-labs/simulator-server-releases",
    requestedTag: "",
    scriptDefaultTag: "radon-main",
    resolvedTag: "radon-main",
    release: releaseJson(sha),
    assetName: "simulator-server-argent-macos",
    files: [bin],
  });
  assert.equal(p.source, "github-release");
  assert.equal(p.requestedTag, null);
  assert.equal(p.scriptDefaultTag, "radon-main");
  assert.equal(p.release.tagName, "radon-main");
  assert.equal(p.release.publishedAt, "2026-10-02T14:09:49Z");
  assert.equal(p.asset.databaseId, 605747818);
  assert.equal(p.files[bin], sha);
  assert.equal(p.assetDigestMatches, true);
});

test("merge + scoreboard: the OFF arm's simulator-server provenance is recorded and rendered", () => {
  const out = freshOut();
  writeBlocks(out, ALL());
  const bin = path.join(out, "simulator-server");
  fs.writeFileSync(bin, "mach-o bytes");
  fs.writeFileSync(path.join(out, "release.json"), JSON.stringify(releaseJson("0".repeat(64))));
  execFileSync(
    "node",
    [
      PROVENANCE,
      "gh-release",
      "--repo",
      "software-mansion-labs/simulator-server-releases",
      "--requested-tag",
      "",
      "--script-default-tag",
      "radon-main",
      "--resolved-tag",
      "radon-main",
      "--release-json",
      path.join(out, "release.json"),
      "--asset",
      "simulator-server-argent-macos",
      "--file",
      bin,
      "--out",
      path.join(out, "proprietary-provenance.json"),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const r = run(out);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  const m = JSON.parse(fs.readFileSync(r.stdout.match(/MERGED_JSON=(.+)/)[1].trim(), "utf8"));
  assert.equal(m.proprietaryProvenance.release.tagName, "radon-main");
  assert.equal(m.proprietaryProvenance.assetDigestMatches, false);
  const sb = execFileSync("node", [SCOREBOARD], {
    env: { ...process.env, BENCH_OUT: out },
    encoding: "utf8",
  });
  assert.match(sb, /### Proprietary provenance \(OFF arm\)/);
  assert.match(sb, /requested tag \| \(script default: radon-main\)/);
  assert.match(sb, /resolved release \| radon-main \(published 2026-10-02T14:09:49Z\)/);
  assert.match(sb, /asset \| simulator-server-argent-macos id 605747818/);
  assert.match(sb, /digest matches \| NO/);
});

test("merge: no provenance file (pre-0.27 artifacts) → provenance reads unknown, still merges", () => {
  const out = freshOut();
  writeBlocks(out, ALL());
  const r = run(out);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  const m = JSON.parse(fs.readFileSync(r.stdout.match(/MERGED_JSON=(.+)/)[1].trim(), "utf8"));
  assert.equal(m.proprietaryProvenance, "unknown");
});

// ── simslim: the simulator's slim state per block ─────────────────────────────
// Every block runs on the same simulator boot, so the slim state is shared by
// construction; the workflow stamps each block with block.simulator (simslim
// status + measure) and the merge refuses blocks whose slim state differs.
function simRecord(over = {}) {
  return {
    slim: true,
    simslimVersion: "v0.11.0",
    profileSha256: "a".repeat(64),
    managedDisabled: 168,
    managedTotal: 171,
    measure: { processes: 61, bytes: 943718400 },
    ...over,
  };
}
function withSim(blocks, rec) {
  for (const b of blocks) b.block.simulator = typeof rec === "function" ? rec(b) : rec;
  return blocks;
}
const mergedFiles = (out) => fs.readdirSync(out).filter((f) => /^bench-ios-merged-/.test(f));

test("simulator: the merge refuses blocks whose slim state differs, and writes no merged JSON", () => {
  const out = freshOut();
  writeBlocks(
    out,
    withSim(ALL(), (b) =>
      b.block.block === "ON-siminput"
        ? simRecord({ slim: false, profileSha256: null, managedDisabled: 0 })
        : simRecord()
    )
  );
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /slim state differs: OFF-1 vs ON-siminput: slim true vs false/);
  assert.deepEqual(mergedFiles(out), []);
});

test("simulator: a block without a record among recorded blocks is refused", () => {
  const out = freshOut();
  const blocks = withSim(ALL(), simRecord());
  delete blocks[3].block.simulator;
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /slim state differs: OFF-1 vs OFF-2: record present on one side only/);
});

test("simulator: a different measure alone is not a state change", () => {
  const out = freshOut();
  writeBlocks(
    out,
    withSim(ALL(), (b) =>
      simRecord({ measure: { processes: 60, bytes: 900000000 + b.block.block.length } })
    )
  );
  const r = run(out);
  assert.equal(r.code, 0, r.stderr || r.stdout);
});

test("simulator: merge + scoreboard record and render the slim state and measure", () => {
  const out = freshOut();
  writeBlocks(out, withSim(ALL(), simRecord()));
  fs.writeFileSync(
    path.join(out, "simulator.json"),
    JSON.stringify(simRecord({ measure: { processes: 58, bytes: 912261120 } }))
  );
  const r = run(out);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  const m = JSON.parse(fs.readFileSync(r.stdout.match(/MERGED_JSON=(.+)/)[1].trim(), "utf8"));
  assert.equal(m.simulator.slim, true);
  assert.equal(m.simulator.measure.bytes, 912261120);
  assert.equal(m.simulatorByBlock["OFF-2"].measure.bytes, 943718400);
  const sb = execFileSync("node", [SCOREBOARD], {
    env: { ...process.env, BENCH_OUT: out },
    encoding: "utf8",
  });
  assert.match(sb, /### Simulator \(simslim\)/);
  assert.match(sb, /\| slim \| yes \|/);
  assert.match(sb, /\| simslim \| v0\.11\.0 \|/);
  assert.match(sb, /\| managed labels disabled \| 168 \/ 171 \|/);
  assert.match(sb, /\| boot \| 58 \| 870\.0 MiB \|/);
  assert.match(sb, /\| OFF-2 \| 61 \| 900\.0 MiB \|/);
});

test("simulator: the run-level record must match the blocks too", () => {
  const out = freshOut();
  writeBlocks(out, withSim(ALL(), simRecord()));
  fs.writeFileSync(
    path.join(out, "simulator.json"),
    JSON.stringify(simRecord({ slim: false, profileSha256: null }))
  );
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /slim state differs: boot vs OFF-1: slim false vs true/);
});

test("simulator: no records (pre-simslim artifacts) → unknown, still merges, scoreboard says so", () => {
  const out = freshOut();
  writeBlocks(out, ALL());
  const r = run(out);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  const m = JSON.parse(fs.readFileSync(r.stdout.match(/MERGED_JSON=(.+)/)[1].trim(), "utf8"));
  assert.equal(m.simulator, "unknown");
  const sb = execFileSync("node", [SCOREBOARD], {
    env: { ...process.env, BENCH_OUT: out },
    encoding: "utf8",
  });
  assert.match(sb, /### Simulator \(simslim\)\n\n_Not recorded/);
});

test("simulator CLI: stamps block.simulator; hashes the profile only for a slim run", () => {
  const { sha256File } = require(PROVENANCE);
  const out = freshOut();
  writeBlocks(out, ALL());
  const profile = path.join(out, "ci.json");
  fs.writeFileSync(profile, '{"name":"ci","keep":["com.apple.swcd"]}');
  fs.writeFileSync(
    path.join(out, "status.json"),
    JSON.stringify({ managedDisabled: 168, managedTotal: 171, verdict: "slim" })
  );
  fs.writeFileSync(
    path.join(out, "measure.json"),
    JSON.stringify({ processes: 61, bytes: 1, cpu: 3.5 })
  );
  const blockFile = path.join(out, "bench-block-OFF-1.json");
  const cli = (slim, extra) =>
    execFileSync(
      "node",
      [
        PROVENANCE,
        "simulator",
        "--slim",
        slim,
        "--simslim-version",
        "simslim v0.11.0",
        "--profile",
        profile,
        "--status-json",
        path.join(out, "status.json"),
        "--measure-json",
        path.join(out, "measure.json"),
        ...extra,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  cli("true", ["--block", blockFile]);
  const stamped = JSON.parse(fs.readFileSync(blockFile, "utf8")).block.simulator;
  assert.deepEqual(stamped, {
    slim: true,
    simslimVersion: "v0.11.0",
    profileSha256: sha256File(profile),
    managedDisabled: 168,
    managedTotal: 171,
    measure: { processes: 61, bytes: 1 },
  });
  cli("false", ["--out", path.join(out, "stock.json")]);
  const stock = JSON.parse(fs.readFileSync(path.join(out, "stock.json"), "utf8"));
  assert.equal(stock.slim, false);
  assert.equal(stock.profileSha256, null);
  assert.deepEqual(stock.measure, { processes: 61, bytes: 1 });
});

// ── Fail-closed validity (2026-10-04 harness repair) ──────────────────────────
// Run 37213144359 reported ON-xcuitest `describeTokens=1126@30el backend=xcuitest`
// while describe.source was `ax-service`, and recorded n=20 gesture-swipe latencies
// that the tool layer served from simulator-server. A block is INVALID when any
// measured sample was served by the other arm's path, when its oracle self-test
// failed, when the runner connection errored, or when simulator-server was not
// ready. INVALID numbers are not rendered; the merge exits non-zero after writing.
const R1 = path.join(HERE, "fixtures", "ios-run-37213144359");

function copyR1(out, names = ["OFF-1", "ON-xcuitest", "ON-siminput", "OFF-2"]) {
  for (const n of names) {
    fs.copyFileSync(
      path.join(R1, `bench-block-${n}.json`),
      path.join(out, `bench-block-${n}.json`)
    );
  }
}
function scoreboard(out) {
  return execFileSync("node", [SCOREBOARD], {
    env: { ...process.env, BENCH_OUT: out },
    encoding: "utf8",
  });
}
function mergedOf(r) {
  return JSON.parse(fs.readFileSync(r.stdout.match(/MERGED_JSON=(.+)/)[1].trim(), "utf8"));
}
/** A scoreboard table row for `block` (the first cell is the block name). */
function rowOf(sb, heading, block) {
  const section = sb.split(heading)[1] || "";
  return (section.split("\n").find((l) => l.startsWith(`| ${block} |`)) || "").trim();
}

test("C.1 (run 37213144359): ON-xcuitest served by ax-service is INVALID; merge exits non-zero after writing", () => {
  const out = freshOut();
  copyR1(out);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /VALIDITY: ON-xcuitest INVALID \(fell back to proprietary: 1\/1 samples/);
  assert.match(r.stderr, /VALIDITY: ON-siminput INVALID \(fell back to proprietary: 1\/1 samples/);
  // Artifacts are written before the non-zero exit.
  assert.equal(mergedFiles(out).length, 1);
  const m = mergedOf(r);
  assert.equal(m.validity["ON-xcuitest"].valid, false);
  assert.equal(m.validity["ON-xcuitest"].intendedBackend, "xcuitest");
  // C.2: the label is the OBSERVED backend, not the arm's fixed one.
  assert.equal(m.validity["ON-xcuitest"].observedTreeBackend, "ax-service");
  assert.equal(m.gates.VALIDITY.passed, false);
  // G4 must not carry a fallback's tokens under the xcuitest label.
  assert.equal(m.g4.backends.xcuitest, undefined);
  const sb = scoreboard(out);
  assert.match(
    rowOf(sb, "### Block validity", "ON-xcuitest"),
    /INVALID \(fell back to proprietary: 1\/1 samples/
  );
  // INVALID blocks render no latency numbers (the r1 describe p50 was 238 ms).
  const describeRow = sb.split("\n").find((l) => l.startsWith("| describe |"));
  assert.ok(describeRow, sb);
  assert.doesNotMatch(describeRow, /238/);
  assert.match(describeRow, /INVALID/);
});

test("C.3 (old key): run 37213144359 `runnerCrashes` still parses as connectionErrors", () => {
  const out = freshOut();
  copyR1(out);
  const r = run(out);
  assert.match(
    r.stderr,
    /G1: ON-xcuitest connectionErrors=66 \(must be 0\); first: "\(no message recorded\)"/
  );
  assert.match(r.stderr, /G1: ON-siminput connectionErrors=88/);
  assert.doesNotMatch(r.stderr + r.stdout, /runnerCrashes|crashes=/);
  const sb = scoreboard(out);
  assert.match(sb, /connection errors/);
  assert.doesNotMatch(sb, /runner crashes/);
});

test("C.4 (run 37213144359): an oracle self-test failure marks the block INVALID, no landing/latency rendered", () => {
  const out = freshOut();
  copyR1(out);
  const r = run(out);
  assert.match(
    r.stderr,
    /VALIDITY: OFF-1 INVALID \(.*oracle self-test failed: self-test threw: no target app set/
  );
  const sb = scoreboard(out);
  const landing = rowOf(sb, "### G1", "OFF-1");
  assert.match(landing, /INVALID/);
  assert.doesNotMatch(landing, /0 \/ 0/);
  // OFF-1 gesture-swipe p50 in the r1 fixture must not appear in the swipe row.
  const off1Swipe = JSON.parse(
    fs.readFileSync(path.join(R1, "bench-block-OFF-1.json"), "utf8")
  ).block.verbs.find((v) => v.verb === "gesture-swipe").latency.p50;
  const swipeRow = sb.split("\n").find((l) => l.startsWith("| gesture-swipe |"));
  assert.doesNotMatch(swipeRow, new RegExp(`\\b${off1Swipe}\\.0/`));
});

test("C.1: a clean synthetic ON block (every sample on the open path) is valid", () => {
  const out = freshOut();
  writeBlocks(out, ALL());
  const r = run(out);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  const m = mergedOf(r);
  for (const n of ["OFF-1", "ON-xcuitest", "ON-siminput", "OFF-2"]) {
    assert.equal(m.validity[n].valid, true, `${n}: ${m.validity[n].reasons.join("; ")}`);
  }
  assert.equal(m.validity["ON-xcuitest"].observedTreeBackend, "xcuitest");
  assert.equal(m.validity["ON-xcuitest"].observedInput, "xcuitest");
  assert.equal(m.validity["ON-siminput"].observedInput, "sim-input");
  assert.equal(m.gates.VALIDITY.passed, true);
  const sb = scoreboard(out);
  assert.match(rowOf(sb, "### Block validity", "ON-xcuitest"), /\| valid \|/);
});

test("C.1: gesture-swipe samples served by simulator-server make an ON block INVALID with N/M", () => {
  const out = freshOut();
  const blocks = ALL();
  const swipe = blocks[1].block.verbs.find((v) => v.verb === "gesture-swipe");
  swipe.servedBy = samples("simulator-server");
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  // 1 describe sample + 4 verbs × 20 = 81 samples, 20 of them on simulator-server.
  assert.match(
    r.stderr,
    /VALIDITY: ON-xcuitest INVALID \(fell back to proprietary: 20\/81 samples\)/
  );
  const m = mergedOf(r);
  assert.equal(m.validity["ON-xcuitest"].observedInput, "mixed(simulator-server,xcuitest)");
  // The invalid arm is excluded from G2; the valid one is kept.
  assert.equal(m.g2.verbs["gesture-swipe"].arms["ON-xcuitest"], undefined);
  assert.ok(m.g2.verbs["gesture-swipe"].arms["ON-siminput"]);
  assert.match(m.g2.excluded["ON-xcuitest"], /fell back to proprietary/);
  const sb = scoreboard(out);
  assert.match(
    rowOf(sb, "### Block validity", "ON-xcuitest"),
    /INVALID \(fell back to proprietary: 20\/81 samples\)/
  );
});

test("C.2: one describe sample on ax-service flips the observed tree label to mixed", () => {
  const out = freshOut();
  const blocks = ALL();
  const d = blocks[2].block.verbs.find((v) => v.verb === "describe");
  d.servedBy[7] = "ax-service";
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(
    r.stderr,
    /VALIDITY: ON-siminput INVALID \(fell back to proprietary: 1\/81 samples\)/
  );
  assert.equal(
    mergedOf(r).validity["ON-siminput"].observedTreeBackend,
    "mixed(ax-service,xcuitest)"
  );
});

test("C.2: an OFF block served by the open path is INVALID too", () => {
  const out = freshOut();
  const blocks = ALL();
  blocks[3].block.verbs.find((v) => v.verb === "describe").servedBy = samples("xcuitest-runner");
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /VALIDITY: OFF-2 INVALID \(served by the open path: 20\/81 samples\)/);
  // An invalid OFF block withholds G2 entirely (no valid OFF pool).
  assert.equal(mergedOf(r).g2, null);
});

test("C.1: measured samples without a recorded serving path are INVALID (fail closed)", () => {
  const out = freshOut();
  const blocks = ALL();
  delete blocks[1].block.verbs.find((v) => v.verb === "tap+describe").servedBy;
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(
    r.stderr,
    /VALIDITY: ON-xcuitest INVALID \(serving path not recorded for 20 measured sample\(s\)\)/
  );
});

test("E: simulator-server not ready marks an OFF block INVALID", () => {
  const out = freshOut();
  const blocks = ALL();
  blocks[0].block.proprietaryReady = {
    checked: true,
    ready: false,
    error: "Timed out waiting for simulator-server to become ready",
  };
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(
    r.stderr,
    /VALIDITY: OFF-1 INVALID \(simulator-server not ready: Timed out waiting for simulator-server to become ready\)/
  );
});

test("same standard both arms: an empty timed describe makes an OFF or ON block INVALID, counted per verb", () => {
  const out = freshOut();
  const blocks = ALL();
  // Run 37223296646 OFF-1: ax-service returned 0 elements.
  blocks[0].block.verbs.find((v) => v.verb === "describe").emptyDescribes = 2;
  blocks[1].block.verbs.find((v) => v.verb === "tap+describe").emptyDescribes = 1;
  for (const b of blocks.slice(2)) {
    for (const v of b.block.verbs) {
      if (v.verb === "describe" || v.verb === "tap+describe") v.emptyDescribes = 0;
    }
  }
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(
    r.stderr,
    /VALIDITY: OFF-1 INVALID \(empty describe \(0 elements\) in timed verbs: describe=2\)/
  );
  assert.match(
    r.stderr,
    /VALIDITY: ON-xcuitest INVALID \(empty describe \(0 elements\) in timed verbs: tap\+describe=1\)/
  );
  assert.doesNotMatch(r.stderr, /VALIDITY: (ON-siminput|OFF-2)/);
  const m = mergedOf(r);
  assert.deepEqual(m.validity["OFF-1"].perVerb.emptyDescribes, { describe: 2 });
  assert.deepEqual(m.validity["OFF-2"].perVerb.emptyDescribes, {});
  assert.match(r.stdout, /OFF-1: INVALID .* timedEmptyDescribes=describe=2 timedFallbacks=0/);
  const sb = scoreboard(out);
  assert.match(rowOf(sb, "### Block validity", "OFF-1"), /\| describe=2 \| 0 \|/);
  assert.match(rowOf(sb, "### Block validity", "OFF-2"), /\| 0 \| 0 \| valid \|/);
});

test("a fallback inside a timed verb makes an ON block INVALID even when servedBy stayed on the open path", () => {
  const out = freshOut();
  const blocks = ALL();
  blocks[2].block.verbs.find((v) => v.verb === "describe").fallbacks = 1;
  blocks[2].block.verbs.find((v) => v.verb === "gesture-swipe").fallbacks = 3;
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(
    r.stderr,
    /VALIDITY: ON-siminput INVALID \(fallback inside timed verbs: describe=1, gesture-swipe=3\)/
  );
  const m = mergedOf(r);
  assert.deepEqual(m.validity["ON-siminput"].perVerb.fallbacks, {
    "describe": 1,
    "gesture-swipe": 3,
  });
  assert.match(
    rowOf(scoreboard(out), "### Block validity", "ON-siminput"),
    /\| 0 \| describe=1, gesture-swipe=3 \| INVALID/
  );
});

test("pre-repair blocks without the per-verb counters keep their verdict", () => {
  const out = freshOut();
  writeBlocks(out, ALL());
  const r = run(out);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  const m = mergedOf(r);
  assert.deepEqual(m.validity["ON-xcuitest"].perVerb, { emptyDescribes: {}, fallbacks: {} });
});

// ── iOS-4 ticket 2: tree-suspect describes (run 37572773799) ──────────────────
// Both ON arms' describe read 3 elements / 551 bytes on the Settings root while
// ax-service read 30. A timed describe with < 10 elements while the OTHER config's
// median on the same screen is >= 20 is `treeSuspect`; more than 10 % suspect
// samples make the block INVALID. Same rule both ways.
function setElements(b, xs) {
  b.block.verbs.find((v) => v.verb === "describe").elementsSamples = xs;
}

test("treeSuspect: ON describes of 3 elements vs OFF 30 make the ON blocks INVALID", () => {
  const out = freshOut();
  const blocks = ALL();
  setElements(blocks[0], samples(30));
  setElements(blocks[3], samples(31));
  setElements(blocks[1], samples(3));
  setElements(blocks[2], samples(3));
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(
    r.stderr,
    /VALIDITY: ON-xcuitest INVALID \(tree suspect: 20\/20 timed describe\(s\) < 10 elements while the OFF median on the same screen is 30\)/
  );
  assert.match(r.stderr, /VALIDITY: ON-siminput INVALID \(tree suspect: 20\/20/);
  assert.doesNotMatch(r.stderr, /VALIDITY: OFF-/);
  const m = mergedOf(r);
  assert.deepEqual(m.validity["ON-xcuitest"].treeSuspect, {
    suspect: 20,
    n: 20,
    samples: "timed",
    other: "OFF",
    reference: 30,
    invalid: true,
  });
  assert.match(
    rowOf(scoreboard(out), "### Block validity", "ON-siminput"),
    /INVALID \(tree suspect: 20\/20/
  );
});

test("treeSuspect: symmetric — an OFF describe of 3 while ON reads 54 makes the OFF block INVALID", () => {
  const out = freshOut();
  const blocks = ALL();
  setElements(blocks[1], samples(54));
  setElements(blocks[2], samples(54));
  setElements(blocks[3], samples(3));
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(
    r.stderr,
    /VALIDITY: OFF-2 INVALID \(tree suspect: 20\/20 timed describe\(s\) < 10 elements while the ON median on the same screen is 54\)/
  );
  assert.doesNotMatch(r.stderr, /VALIDITY: (OFF-1|ON-)/);
});

test("treeSuspect: 10 % suspect samples is tolerated, more is INVALID", () => {
  const atTen = ALL();
  setElements(atTen[2], [...samples(30).slice(0, 18), 3, 4]);
  let out = freshOut();
  writeBlocks(out, atTen);
  let r = run(out);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  assert.equal(mergedOf(r).validity["ON-siminput"].treeSuspect.suspect, 2);

  const overTen = ALL();
  setElements(overTen[2], [...samples(30).slice(0, 17), 3, 4, 5]);
  out = freshOut();
  writeBlocks(out, overTen);
  r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /VALIDITY: ON-siminput INVALID \(tree suspect: 3\/20/);
});

test("treeSuspect: no flag when the other config's median is under 20 (a small screen on both)", () => {
  const out = freshOut();
  const blocks = ALL();
  for (const b of blocks) setElements(b, samples(b.block.config === "OFF" ? 12 : 5));
  writeBlocks(out, blocks);
  const r = run(out);
  assert.equal(r.code, 0, r.stderr || r.stdout);
});

test("treeSuspect: blocks without per-sample counts use the idle describe (run 37572773799 shape)", () => {
  const out = freshOut();
  const blocks = ALL();
  blocks[1].block.describe.elements = 3;
  blocks[2].block.describe.elements = 3;
  writeBlocks(out, blocks);
  const r = run(out);
  assert.notEqual(r.code, 0);
  assert.match(
    r.stderr,
    /VALIDITY: ON-xcuitest INVALID \(tree suspect: 1\/1 idle describe\(s\) < 10 elements while the OFF median on the same screen is 30\)/
  );
});

// ── iOS-4 ticket 1: sim-input decomposition in the scoreboard ─────────────────
function simSample(over = {}) {
  return {
    hostWriteToAck: 185,
    recvToFirstSend: 0.4,
    perMessageSendMs: [66, 68],
    lastSendToAck: 0.3,
    sidecarMs: 184.5,
    gapsMs: 49.8,
    hostPipeMs: 0.5,
    ...over,
  };
}

test("scoreboard: the ON-siminput decomposition table shows the p50 of each term per verb", () => {
  const out = freshOut();
  const blocks = ALL();
  const sim = blocks[2].block;
  sim.verbs.find((v) => v.verb === "gesture-tap").inputTimings = [
    simSample(),
    simSample({ hostWriteToAck: 190, perMessageSendMs: [70, 72] }),
    simSample({ hostWriteToAck: 180, perMessageSendMs: [60, 62] }),
  ];
  sim.verbs.find((v) => v.verb === "gesture-swipe").inputTimings = [
    simSample({
      hostWriteToAck: 1480,
      perMessageSendMs: Array.from({ length: 12 }, () => 105),
      gapsMs: 220,
    }),
  ];
  writeBlocks(out, blocks);
  const r = run(out);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  const sb = scoreboard(out);
  assert.match(sb, /### sim-input decomposition \(ON-siminput, p50 ms\)/);
  const heading = "### sim-input decomposition";
  const section = sb.split(heading)[1];
  const tapRow = section.split("\n").find((l) => l.startsWith("| ON-siminput | gesture-tap |"));
  assert.ok(tapRow, section);
  // n | host write→ack | recv→first send | per-message send | messages | Σ send | gaps | last send→ack | sidecar | host+pipe
  assert.match(
    tapRow,
    /\| 3 \| 185\.0 \| 0\.4 \| 66\.0 \| 2 \| 134\.0 \| 49\.8 \| 0\.3 \| 184\.5 \| 0\.5 \|/
  );
  const swipeRow = section.split("\n").find((l) => l.startsWith("| ON-siminput | gesture-swipe |"));
  assert.match(swipeRow, /\| 1 \| 1480\.0 \| 0\.4 \| 105\.0 \| 12 \| 1260\.0 \| 220\.0 \|/);
  // No ON-siminput timings → no table rows for the other blocks.
  assert.doesNotMatch(section.split("\n###")[0], /\| OFF-1 \|/);
});

test("scoreboard: no sim-input timings recorded → the decomposition section says so", () => {
  const out = freshOut();
  writeBlocks(out, ALL());
  const r = run(out);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  assert.match(
    scoreboard(out),
    /### sim-input decomposition[^\n]*\n\n_No sim-input timings recorded/
  );
});
