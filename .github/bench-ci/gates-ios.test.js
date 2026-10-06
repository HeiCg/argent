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
