// CI variant of the phase-3f run-bench-merge.js. Same gates (gesture-param drift,
// ON-scrcpy zero-fast-inject-fallback), but TOLERANT of a missing OFF arm: on a
// hosted Linux runner the proprietary simulator-server may refuse to run (it
// ships bin/linux/ but discovery/exec can fail), in which case only the ON blocks
// are present and the run is scored ON-only. Also folds the CI runner facts
// (nproc / RAM / KVM / emulator image+arch) written by the workflow to
// $BENCH_OUT/ci-runner-env.json into the merged `env` block.
const fs = require("fs");
const path = require("path");

const OUT = process.env.BENCH_OUT || path.join(process.cwd(), ".bench-results");
const ALL = ["OFF-1", "ON-uiautomation", "ON-scrcpy", "OFF-2"];

const files = {};
for (const n of ALL) {
  const p = path.join(OUT, `bench-block-${n}.json`);
  if (fs.existsSync(p)) files[n] = JSON.parse(fs.readFileSync(p, "utf8"));
}
const present = ALL.filter((n) => files[n]);
if (present.length === 0) throw new Error(`no bench-block-*.json found under ${OUT}`);

const blocks = present.map((n) => files[n].block);

// Gesture-param drift gate across the blocks that ran.
const gp = blocks.map((b) => JSON.stringify(b.gestureParams));
if (new Set(gp).size !== 1) {
  throw new Error("gesture params drifted across blocks: " + gp.join(" | "));
}

// Zero-fast-inject-fallback gate for ON-scrcpy (only if that arm ran).
let scrcpyFallbacks = null;
if (files["ON-scrcpy"]) {
  const scrcpy = files["ON-scrcpy"].block;
  scrcpyFallbacks = (scrcpy.verbs || []).reduce((s, v) => s + (v.fallbacks || 0), 0);
  if (scrcpyFallbacks > 0) {
    throw new Error(
      `ON-scrcpy took ${scrcpyFallbacks} fast-inject fallback(s) to the Kotlin channel — ` +
        `the measurement is NOT a clean scrcpy arm. Verbs: ` +
        (scrcpy.verbs || []).filter((v) => v.fallbacks).map((v) => `${v.verb}=${v.fallbacks}`).join(", ")
    );
  }
}

// Fidelity: OFF-1 vs ON-uiautomation, only when both arms ran.
const jaccard = (a, b) => {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni === 0 ? 1 : Number((inter / uni).toFixed(3));
};
let fidelity = null;
if (files["OFF-1"] && files["ON-uiautomation"]) {
  const off1 = files["OFF-1"].block;
  const on = files["ON-uiautomation"].block;
  fidelity = {
    off1_vs_on_jaccard: jaccard(off1.fidelitySet, on.fidelitySet),
    onlyOff: off1.fidelitySet.filter((x) => !on.fidelitySet.includes(x)),
    onlyOn: on.fidelitySet.filter((x) => !off1.fidelitySet.includes(x)),
    offCount: off1.fidelitySet.length,
    onCount: on.fidelitySet.length,
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
  env: { ...baseEnv, ci: ciEnv },
  envPerBlock: Object.fromEntries(present.map((n) => [n, files[n].env])),
  blocksRan: present,
  offArmPresent: !!(files["OFF-1"] || files["OFF-2"]),
  blocks,
  scrcpyFallbacks,
  fidelity,
  finishedAt: new Date().toISOString(),
};

const outPath = path.join(OUT, `bench-merged-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(
  `blocks merged: ${present.join(", ")}` +
    (scrcpyFallbacks === null ? " (no ON-scrcpy arm)" : `; ON-scrcpy fast-inject fallbacks: ${scrcpyFallbacks} (gate 0) — OK`)
);
console.log("MERGED_JSON=" + outPath);
