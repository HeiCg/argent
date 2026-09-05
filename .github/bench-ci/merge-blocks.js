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
// authored holdMs is identical across blocks and every backend injected the SAME
// clean two-frame DOWN→UP (no MOVE anywhere — scrcpy is at parity by shape, not
// just holdMs). Replaces "the gestureParams constant equals itself per block".
const tls = blocks.map((b) => ({ block: b.block, tl: b.injectedTapTimeline })).filter((x) => x.tl);
if (tls.length) {
  const holdMs0 = tls[0].tl.holdMs;
  for (const { block, tl } of tls) {
    if (tl.holdMs !== holdMs0) {
      throw new Error(`tap-timeline parity: ${block} holdMs=${tl.holdMs} != ${tls[0].block} holdMs=${holdMs0}`);
    }
    if (tl.hasMoveFrame || tl.frameCount !== 2) {
      throw new Error(
        `tap-timeline parity: ${block} (backend ${tl.backend}) is not a clean two-frame ` +
          `DOWN→UP (frameCount=${tl.frameCount}, hasMoveFrame=${tl.hasMoveFrame})`
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
    const first = b.firstTapNoEffectTotal != null ? b.firstTapNoEffectTotal : b.effectZeroTotal || 0;
    const self = b.oracleSelfTestPassed === false ? " oracleSelfTest=FAILED" : "";
    return `${n}: firstTapNoEffect=${first}/${b.effectCheckedTotal || 0} originLost=${b.originLostTotal || 0}${self}`;
  })
  .join(" | ");
console.log("tap effect-check per block (first-attempt verdict) — " + effectLine);

// Oracle self-test gate (run-2 review): a block whose backend could not complete a
// single detected+restored navigation before the timed loop has UNTRUSTWORTHY effect
// rows — a DISTINCT verdict from "a tap did not land" and from "degraded arm". Fatal
// on any block (ON or OFF) that ran the check.
const oracleFailed = present.filter((n) => files[n].block.oracleSelfTestPassed === false);
if (oracleFailed.length) {
  throw new Error(
    `oracle self-test failed on block(s): ${oracleFailed.join(", ")} — the backend could not ` +
      `complete one detected+restored navigation, so the effect rows are untrustworthy (NOT the ` +
      `same as a first-attempt miss). Full per-block: ${effectLine}`
  );
}

// First-attempt effect gate. effectZeroTotal IS the first-attempt no-effect count
// (no re-tap masks it — run-2 review). A dropped injection on this runner is the
// backend's real behaviour and stays fatal on ON: the honest result is "N/60 first
// attempts did not land", not a green scored on retries.
const onEffectBad = present
  .filter((n) => n.startsWith("ON") && (files[n].block.effectZeroTotal || 0) > 0)
  .map((n) => `${n}=${files[n].block.effectZeroTotal}`);
if (onEffectBad.length) {
  throw new Error(
    `first-attempt no-effect taps on an ON block: ${onEffectBad.join(", ")} — the FIRST tap did ` +
      `not land (not retried away). Full per-block: ${effectLine}`
  );
}

// Vacuous-arm gate (phase 3h review A2, fix a). The effect gate above passes
// trivially when NOTHING was checked (effectZero 0 of 0). A block that ran tap
// verbs must have ARMED the backend-independent effect oracle (effectCheckedTotal
// > 0) — this holds for OFF too now that the oracle is backend-independent. A block
// with tap verbs and effectCheckedTotal === 0 fails the merge, ON or OFF.
const ranTapVerbs = (b) => (b.verbs || []).some((v) => /tap/i.test(v.verb || ""));
const unarmed = present.filter(
  (n) => ranTapVerbs(files[n].block) && (files[n].block.effectCheckedTotal || 0) === 0
);
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
const degraded = present
  .filter((n) => ((files[n].block.degradedReasons || []).length > 0))
  .map((n) => `${n}: ${files[n].block.degradedReasons.join("; ")}`);
if (degraded.length) {
  throw new Error(
    `DEGRADED ARM on block(s): ${degraded.join(" | ")} — the block was on the wrong ` +
      `screen for part of the run; its rows are not a valid baseline. Rerun.`
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
      {
        effectZero: b.effectZeroTotal || 0,
        firstTapNoEffect: b.firstTapNoEffectTotal != null ? b.firstTapNoEffectTotal : b.effectZeroTotal || 0,
        effectChecked: b.effectCheckedTotal || 0,
        originLost: b.originLostTotal || 0,
        oracleSelfTestPassed: b.oracleSelfTestPassed !== false,
        transport: b.transport || null,
      },
    ])
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
    (scrcpyFallbacks === null ? " (no ON-scrcpy arm)" : `; ON-scrcpy fast-inject fallbacks: ${scrcpyFallbacks} (gate 0) — OK`)
);
console.log("tap effect-check (ON fatal, OFF tolerated) — " + effectLine + " — ON gate OK");
if (tls.length) {
  console.log(
    "tap-timeline parity OK: holdMs=" + tls[0].tl.holdMs + "ms; every backend a clean 2-frame DOWN→UP — " +
      tls.map(({ block, tl }) => `${block}:${tl.frameCount}f${tl.hasMoveFrame ? "+move" : ""}`).join(", ")
  );
}
console.log("MERGED_JSON=" + outPath);
