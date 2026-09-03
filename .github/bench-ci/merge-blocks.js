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

// ON blocks are the hard requirement: a requested ON-* block that produced no
// file must fail loudly (a silent drop would score an incomplete run as healthy).
// OFF-* may be absent — a proprietary refusal on Linux legitimately downgrades to
// ON-only.
const requested = (process.env.BENCH_BLOCKS || ALL.join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);
const missingOn = requested.filter((n) => n.startsWith("ON") && ALL.includes(n) && !files[n]);
if (missingOn.length) {
  throw new Error(`missing required ON block file(s): ${missingOn.join(", ")}`);
}

const blocks = present.map((n) => files[n].block);

// Gesture-param drift gate across the blocks that ran.
const gp = blocks.map((b) => JSON.stringify(b.gestureParams));
if (new Set(gp).size !== 1) {
  throw new Error("gesture params drifted across blocks: " + gp.join(" | "));
}

// Tap-timeline parity gate (phase 3h). The bench records the ACTUAL injected tap
// timeline per block (frame count, per-frame tMs, holdMs, MOVE flag); assert the
// authored holdMs is identical across blocks and the same-point MOVE is present in
// EXACTLY the scrcpy block (the tap-landing fix) and absent everywhere else. This
// replaces "the gestureParams constant equals itself per block" — meaningless
// under BENCH_ONLY — with a check on the real shape each backend drove.
const tls = blocks.map((b) => ({ block: b.block, tl: b.injectedTapTimeline })).filter((x) => x.tl);
if (tls.length) {
  const holdMs0 = tls[0].tl.holdMs;
  for (const { block, tl } of tls) {
    if (tl.holdMs !== holdMs0) {
      throw new Error(`tap-timeline parity: ${block} holdMs=${tl.holdMs} != ${tls[0].block} holdMs=${holdMs0}`);
    }
    const expectMove = tl.backend === "scrcpy";
    if (!!tl.hasMoveFrame !== expectMove) {
      throw new Error(
        `tap-timeline parity: ${block} (backend ${tl.backend}) hasMoveFrame=${tl.hasMoveFrame} ` +
          `but expected ${expectMove} (only the scrcpy fast-inject tap carries a same-point MOVE)`
      );
    }
  }
}

// Effect gate (phase 3h). Runs at the END, after all four per-block JSONs exist, so
// one failing block never hides the others. A block's effect-checked taps must have
// landed (effectZeroTotal 0, from the timing-independent poll oracle). ON blocks are
// FATAL; OFF (proprietary) is tolerated and only reported (its arm is best-effort on
// Linux). originLost is reported for context.
const effectLine = present
  .map((n) => {
    const b = files[n].block;
    return `${n}: effectZero=${b.effectZeroTotal || 0}/${b.effectCheckedTotal || 0} originLost=${b.originLostTotal || 0}`;
  })
  .join(" | ");
console.log("tap effect-check per block — " + effectLine);
const onEffectBad = present
  .filter((n) => n.startsWith("ON") && (files[n].block.effectZeroTotal || 0) > 0)
  .map((n) => `${n}=${files[n].block.effectZeroTotal}`);
if (onEffectBad.length) {
  throw new Error(
    `no-effect tap iterations on an ON block: ${onEffectBad.join(", ")} — the tap did not land. ` +
      `Full per-block: ${effectLine}`
  );
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
  // Phase 3h: parity + effect evidence carried into the scoreboard.
  tapTimelines: Object.fromEntries(tls.map(({ block, tl }) => [block, tl])),
  effectByBlock: Object.fromEntries(
    blocks.map((b) => [
      b.block,
      { effectZero: b.effectZeroTotal || 0, effectChecked: b.effectCheckedTotal || 0, originLost: b.originLostTotal || 0 },
    ])
  ),
  effectZeroByBlock: Object.fromEntries(blocks.map((b) => [b.block, b.effectZeroTotal || 0])),
  fidelity,
  finishedAt: new Date().toISOString(),
};

const outPath = path.join(OUT, `bench-merged-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(
  `blocks merged: ${present.join(", ")}` +
    (scrcpyFallbacks === null ? " (no ON-scrcpy arm)" : `; ON-scrcpy fast-inject fallbacks: ${scrcpyFallbacks} (gate 0) — OK`)
);
console.log("tap effect-check (ON fatal, OFF tolerated) — " + effectLine + " — ON gate OK");
if (tls.length) {
  console.log(
    "tap-timeline parity OK: holdMs=" + tls[0].tl.holdMs + "ms; MOVE present only on scrcpy — " +
      tls.map(({ block, tl }) => `${block}:${tl.frameCount}f${tl.hasMoveFrame ? "+move" : ""}`).join(", ")
  );
}
console.log("MERGED_JSON=" + outPath);
