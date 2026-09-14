// Render the latency-bench scoreboard as Markdown from the merged bench JSON
// Written to stdout; the workflow tees it
// into $GITHUB_STEP_SUMMARY and uploads it as an artifact. This is x86_64/KVM on
// a hosted runner — NOT comparable to the local arm64/HVF numbers; only OFF vs ON
// within THIS run is like-for-like.
const fs = require("fs");
const path = require("path");

const OUT = process.env.BENCH_OUT || path.join(process.cwd(), ".bench-results");
const latest = (glob) => {
  const rx = new RegExp(glob);
  const hits = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((f) => rx.test(f)) : [];
  if (hits.length === 0) return null;
  hits.sort();
  return path.join(OUT, hits[hits.length - 1]);
};

const mergedPath = latest("^bench-merged-.*\\.json$");
if (!mergedPath) {
  console.log("## Latency bench — NO RESULTS\n\nNo `bench-merged-*.json` was produced.");
  process.exit(0);
}
const merged = JSON.parse(fs.readFileSync(mergedPath, "utf8"));

const env = merged.env || {};
const ci = env.ci || {};
const L = [];

L.push("## Open vs proprietary — latency bench (CI)");
L.push("");
L.push("> **x86_64 / KVM on a GitHub-hosted runner.** These numbers are NOT comparable");
L.push("> to the local arm64 / HVF results (v4–v6). Only OFF vs ON *within this run* is");
L.push("> like-for-like.");
L.push("");
L.push(`Blocks run: **${(merged.blocksRan || []).join(", ") || "?"}**` +
  (merged.offArmPresent ? "" : "  — **ON-only** (proprietary OFF arm absent/refused)"));
L.push("");

// Environment
L.push("### Environment");
L.push("");
L.push("| key | value |");
L.push("| --- | --- |");
const row = (k, v) => L.push(`| ${k} | ${v === undefined || v === null ? "-" : String(v).replace(/\|/g, "\\|")} |`);
row("android release", env.androidRelease);
row("android sdk", env.androidSdk);
row("abi", env.abi);
row("screen", env.screen);
row("density", env.density);
row("N / warmup / cold", `${env.N} / ${env.WARMUP} / ${env.COLD}`);
row("tokenizer", env.tokenizer);
row("nproc", ci.nproc);
row("RAM (free -m total)", ci.memTotalMb ? `${ci.memTotalMb} MB` : undefined);
row("RAM available", ci.memAvailMb ? `${ci.memAvailMb} MB` : undefined);
row("swap total", ci.swapTotalMb !== undefined ? `${ci.swapTotalMb} MB` : undefined);
row("KVM present", ci.kvm);
row("emulator image", ci.emulatorImage);
row("emulator arch", ci.emulatorArch);
row("runner", ci.runner);
L.push("");

// Per-block verb latency (p50/p95 ms)
const blocks = merged.blocks || [];
const verbNames = [];
for (const b of blocks) for (const v of b.verbs || []) if (!verbNames.includes(v.verb)) verbNames.push(v.verb);

// Phase 3n.1 P1/P3/H5 helpers: measured drift floor (never a constant), per-sample
// arrays, and a seeded 10 000-draw bootstrap 95% CI on the p50 difference.
const verbOf = (b, vn) => b && (b.verbs || []).find((x) => x.verb === vn);
const p50Of = (b, vn) => {
  const v = verbOf(b, vn);
  return v ? v.latency.p50 : null;
};
const samplesOf = (b, vn) => {
  const v = verbOf(b, vn);
  return v && Array.isArray(v.latencySamples) ? v.latencySamples : null;
};
const medianOf = (arr) => {
  if (!arr || !arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 95% CI on p50(a) − p50(b) by paired-independent bootstrap resampling, seeded so the
// scoreboard is deterministic across re-renders. Returns [lo, hi] or null if a verb
// has no per-sample array (pre-3n.1 blocks).
function bootstrapDiffCI(aS, bS, B = 10000, seed = 0x3e1f005) {
  if (!aS || !bS || aS.length < 2 || bS.length < 2) return null;
  const rnd = mulberry32(seed);
  const diffs = new Array(B);
  const ra = new Array(aS.length);
  const rb = new Array(bS.length);
  for (let i = 0; i < B; i++) {
    for (let j = 0; j < aS.length; j++) ra[j] = aS[(rnd() * aS.length) | 0];
    for (let j = 0; j < bS.length; j++) rb[j] = bS[(rnd() * bS.length) | 0];
    diffs[i] = medianOf(ra) - medianOf(rb);
  }
  diffs.sort((a, b) => a - b);
  return [Number(diffs[(0.025 * B) | 0].toFixed(1)), Number(diffs[(0.975 * B) | 0].toFixed(1))];
}
// P1: the measured OFF↔OFF drift floor on a verb — |OFF-1 p50 − OFF-2 p50|, NEVER a
// constant. null (→ rendered N/A) when either OFF block lacks the verb.
const off1Blk = blocks.find((b) => b.block === "OFF-1");
const off2Blk = blocks.find((b) => b.block === "OFF-2");
function measuredFloor(vn) {
  const a = p50Of(off1Blk, vn), b = p50Of(off2Blk, vn);
  return a != null && b != null ? Math.abs(a - b) : null;
}

L.push("### Verb latency p50 / p95 (ms)");
L.push("");
L.push("| verb | " + blocks.map((b) => b.block).join(" | ") + " |");
L.push("| --- | " + blocks.map(() => "---").join(" | ") + " |");
for (const vn of verbNames) {
  const cells = blocks.map((b) => {
    const v = (b.verbs || []).find((x) => x.verb === vn);
    if (!v) return "-";
    const fb = v.fallbacks ? ` ⚠fb${v.fallbacks}` : "";
    const err = v.errors ? ` err${v.errors}` : "";
    return `${v.latency.p50}/${v.latency.p95}${err}${fb}`;
  });
  L.push(`| ${vn} | ${cells.join(" | ")} |`);
}
L.push("");

// describe sample + screenshot dims
L.push("### describe sample & screenshot");
L.push("");
L.push("| block | source | bytes | tokens | elements | screenshot |");
L.push("| --- | --- | --- | --- | --- | --- |");
for (const b of blocks) {
  const d = b.describeSample || {};
  const s = b.screenshot || {};
  L.push(`| ${b.block} | ${d.source ?? "-"} | ${d.bytes ?? "-"} | ${d.tokens ?? "-"} | ${d.elements ?? "-"} | ${s.width}x${s.height} ${s.bytes}b |`);
}
L.push("");

// cold start
L.push("### Cold-start describe (ms)");
L.push("");
L.push("| block | samples |");
L.push("| --- | --- |");
for (const b of blocks) L.push(`| ${b.block} | ${JSON.stringify(b.coldStartMs)} |`);
L.push("");

// Fidelity
if (merged.fidelity) {
  const f = merged.fidelity;
  L.push("### Fidelity (OFF-1 describe vs ON-uiautomation describe)");
  L.push("");
  L.push(`- Jaccard(id+text set): **${f.off1_vs_on_jaccard}** (OFF ${f.offCount} vs ON ${f.onCount} keys)`);
  if (f.onlyOff && f.onlyOff.length) L.push(`- only OFF: ${f.onlyOff.slice(0, 12).join(", ")}${f.onlyOff.length > 12 ? " …" : ""}`);
  if (f.onlyOn && f.onlyOn.length) L.push(`- only ON: ${f.onlyOn.slice(0, 12).join(", ")}${f.onlyOn.length > 12 ? " …" : ""}`);
  L.push("");
} else {
  L.push("### Fidelity");
  L.push("");
  L.push("_Not computed — the OFF-1 proprietary arm did not produce a describe sample this run._");
  L.push("");
}

// OFF drift
const off1 = blocks.find((b) => b.block === "OFF-1");
const off2 = blocks.find((b) => b.block === "OFF-2");
if (off1 && off2) {
  L.push("### OFF-1 vs OFF-2 drift (proprietary self-consistency)");
  L.push("");
  L.push("| verb | OFF-1 p50 | OFF-2 p50 |");
  L.push("| --- | --- | --- |");
  for (const vn of verbNames) {
    const a = (off1.verbs || []).find((x) => x.verb === vn);
    const b = (off2.verbs || []).find((x) => x.verb === vn);
    if (a || b) L.push(`| ${vn} | ${a ? a.latency.p50 : "-"} | ${b ? b.latency.p50 : "-"} |`);
  }
  L.push("");
}

// Phase 3n.1 promotion gates P2–P6 — `ON-input-manager` graded against the PROPRIETARY
// OFF blocks at the MEASURED drift floor (P1: |OFF-1 − OFF-2| per verb, never a
// constant), each Δ carrying a 10 000-draw bootstrap 95% CI on the p50 difference
// (3N-H5). ON-uiautomation is the control (P6). (Phase 3n.2: the ON-scrcpy arm was
// removed.)
const onUia = blocks.find((b) => b.block === "ON-uiautomation");
const onIm = blocks.find((b) => b.block === "ON-input-manager");
if (onIm && off1Blk && off2Blk) {
  // comparator verb name in the OFF blocks (tap+describe(settle:false) → tap+describe).
  const offVerb = (vn) => (vn === "tap+describe(settle:false)" ? "tap+describe" : vn);
  const pooledOff = (vn) => {
    const a = p50Of(off1Blk, offVerb(vn)), b = p50Of(off2Blk, offVerb(vn));
    return a != null && b != null ? (a + b) / 2 : null;
  };
  const pooledOffSamples = (vn) => {
    const a = samplesOf(off1Blk, offVerb(vn)), b = samplesOf(off2Blk, offVerb(vn));
    return a && b ? a.concat(b) : null;
  };
  const ciVerdict = (delta, ci, floor) => {
    if (floor == null) return "N/A (no OFF comparator)";
    if (!ci) return delta < -floor ? "win (no CI)" : delta > floor ? "loss (no CI)" : "parity (no CI)";
    if (ci[1] < -floor) return `win (CI [${ci[0]},${ci[1]}] < −floor)`;
    if (ci[0] > floor) return `loss (CI [${ci[0]},${ci[1]}] > +floor)`;
    return `parity (CI [${ci[0]},${ci[1]}] overlaps ±${floor})`;
  };

  L.push("### phase 3n.1 — promotion gates P2–P6 (ON-input-manager vs PROPRIETARY, measured floor + bootstrap CI)");
  L.push("");
  L.push("| verb | ON-uiautomation | ON-input-manager | OFF-1 | OFF-2 | floor | Δ(im−pooledOFF) | 95% CI | reading |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const gatedVerbs = ["gesture-tap", "gesture-swipe", "gesture-pinch", "tap+describe(settle:false)"].filter((vn) =>
    verbNames.includes(vn)
  );
  for (const vn of gatedVerbs) {
    const imP = p50Of(onIm, vn);
    const po = pooledOff(vn);
    const floor = measuredFloor(offVerb(vn));
    const delta = imP != null && po != null ? Number((imP - po).toFixed(1)) : null;
    const ci = bootstrapDiffCI(samplesOf(onIm, vn), pooledOffSamples(vn));
    L.push(
      "| " +
        [
          vn,
          p50Of(onUia, vn) ?? "-",
          imP ?? "-",
          p50Of(off1Blk, offVerb(vn)) ?? "-",
          p50Of(off2Blk, offVerb(vn)) ?? "-",
          floor == null ? "**N/A**" : `±${floor}`,
          delta == null ? "-" : delta,
          ci ? `[${ci[0]}, ${ci[1]}]` : "no samples",
          delta == null ? "-" : ciVerdict(delta, ci, floor),
        ].join(" | ") +
        " |"
    );
  }
  L.push("");

  // Explicit P2–P6 PASS/FAIL/N/A. Phase 3n.2 (review 3N1-H2 / Conditions item 3): the
  // DECISION RULE is the PRE-REGISTERED POINT INEQUALITY `im p50 ≤ bound.p + floor`.
  // The bootstrap 95% CI on the p50 difference (same comparator, 3N1-M1) is REPORTED
  // for context — it is NEVER substituted for the gate. The retired `CI lo ≤ floor`
  // rule was the wrong tail (an arm with Δ +292 and a wide CI passed) and, on the
  // headline row's floor, could never fail. A planner's acceptance of a sub-floor miss
  // (e.g. tap +1 ms) is a scoreboard NOTE, printed alongside — never rendered as PASS.
  const pline = (id, text, verdict) => L.push(`- **${id}** — ${text}: **${verdict}**`);
  const offBound = (vn, kind) => {
    const a = p50Of(off1Blk, vn), b = p50Of(off2Blk, vn);
    if (a == null || b == null) return null;
    const useA = kind === "max" ? a >= b : a <= b;
    return { blk: useA ? off1Blk : off2Blk, p: useA ? a : b };
  };
  const niGate = (vn, kind) => {
    const im = p50Of(onIm, vn);
    const bound = offBound(vn, kind);
    const floor = measuredFloor(vn);
    if (im == null || bound == null || floor == null) return "N/A";
    const delta = im - bound.p;
    const ci = bootstrapDiffCI(samplesOf(onIm, vn), samplesOf(bound.blk, vn));
    const ciStr = ci ? `CI [${ci[0]}, ${ci[1]}]` : "no CI";
    // The pre-registered point inequality is the gate; the CI is reported, not the gate.
    if (im <= bound.p + floor) return `PASS (Δ ${delta} ≤ floor ${floor}, ${ciStr})`;
    return `FAIL by ${im - bound.p - floor} (Δ ${delta} > floor ${floor}, ${ciStr})`;
  };
  pline("P2", "tap RPC non-inferior to max(OFF) + floor", niGate("gesture-tap", "max"));
  pline("P3", "swipe RPC non-inferior to min(OFF) + floor", niGate("gesture-swipe", "min"));
  pline("P4", "pinch RPC non-inferior to min(OFF) + floor", niGate("gesture-pinch", "min"));
  // P5: headline ratio ≤ 1.15 vs each OFF-1, OFF-2, pooled.
  {
    const im = p50Of(onIm, "tap+describe(settle:false)");
    const o1 = p50Of(off1Blk, "tap+describe"), o2 = p50Of(off2Blk, "tap+describe");
    const po = o1 != null && o2 != null ? (o1 + o2) / 2 : null;
    const ratios = [o1, o2, po].map((d) => (im != null && d != null && d > 0 ? im / d : null));
    const ok = ratios.every((r) => r != null && r <= 1.15);
    const anyNa = ratios.some((r) => r == null);
    pline(
      "P5",
      `headline tap+describe(settle:false) ÷ OFF tap+describe ≤ 1.15 vs each OFF-1/OFF-2/pooled (${ratios.map((r) => (r == null ? "-" : r.toFixed(2))).join(" / ")})`,
      anyNa ? "N/A" : ok ? "PASS" : "FAIL"
    );
  }
  // P6: input-manager not slower than the ON-uiautomation control by more than the
  // floor on any gated verb (CI-based, same non-inferiority rule).
  {
    if (!onUia) {
      pline("P6", "not slower than ON-uiautomation (control) by more than the floor on any gated verb", "N/A");
    } else {
      const bad = [];
      let na = false;
      for (const vn of gatedVerbs) {
        const im = p50Of(onIm, vn), u = p50Of(onUia, vn), f = measuredFloor(offVerb(vn));
        if (im == null || u == null || f == null) {
          na = true;
          continue;
        }
        const ci = bootstrapDiffCI(samplesOf(onIm, vn), samplesOf(onUia, vn));
        // Point inequality (3N1-H2): FAIL only if input-manager is more than the floor
        // slower than the control; the CI is reported in the failure text, never used
        // as the gate (the old `CI lo > floor` rule could never fail on a wide row).
        const fail = im > u + f;
        if (fail) bad.push(`${vn} +${im - u}${ci ? ` (CI [${ci[0]}, ${ci[1]}])` : ""}`);
      }
      pline("P6", "not slower than ON-uiautomation (control) by more than the floor on any gated verb", na && !bad.length ? "N/A (missing samples)" : bad.length ? `FAIL (${bad.join(", ")})` : "PASS");
    }
  }
  // P7 fallback count from the block's echo.
  if (onIm.injectStrategyReported) {
    L.push(`- **P7 echo** — ON-input-manager \`injectStrategyReported\`: ${onIm.injectStrategyReported}`);
  }
  L.push("");
  L.push("_Gates are graded vs the proprietary OFF blocks at the measured floor (P1); the promotion decision (P0–P7 + P9 + P10 green) is the planner's, from these numbers._");
  L.push("");
}

// Effect-check + tap-timeline parity (phase 3h) — the taps actually landed and the
// injected shape was as intended.
// Print zero/checked, never the numerator alone (phase 3h review A2, fix a): a
// block that checked NOTHING (0/0) rendered "0" here and passed vacuously. The gate
// now requires every tap block to have ARMED the oracle (checked > 0) AND landed
// every tap (zero === 0). `effectByBlock` carries {effectZero, effectChecked}.
const eb = merged.effectByBlock || {};
const ez = merged.effectZeroByBlock; // legacy fallback for the block-key list
const effKeys = Object.keys(eb).length ? Object.keys(eb) : ez ? Object.keys(ez) : [];
if (effKeys.length) {
  L.push("### tap first-attempt landing & timeline parity (phase 3h)");
  L.push("");
  L.push("| block | firstTapLanding (landed/checked) | rate | oracle self-test | transport | tap frames | MOVE |");
  L.push("| --- | --- | --- | --- | --- | --- | --- |");
  const tt = merged.tapTimelines || {};
  const rate = (e) => {
    const c = e.effectChecked || 0;
    if (!c) return null;
    const miss = e.firstTapNoEffect != null ? e.firstTapNoEffect : e.effectZero || 0;
    return (c - miss) / c;
  };
  for (const b of blocks) {
    const tl = tt[b.block];
    const e = eb[b.block] || { effectZero: ez ? ez[b.block] : undefined, effectChecked: undefined };
    const c = e.effectChecked;
    const miss = e.firstTapNoEffect != null ? e.firstTapNoEffect : e.effectZero;
    const cell = c === undefined ? "-" : `${c - (miss ?? 0)}/${c}`;
    const r = rate(e);
    const self = c === undefined ? "-" : e.oracleSelfTestPassed === false ? "FAILED" : "pass";
    L.push(
      `| ${b.block} | ${cell} | ${r === null ? "-" : (r * 100).toFixed(1) + "%"} | ${self} | ${e.transport ?? "-"} | ${tl ? tl.frameCount : "-"} | ${tl ? (tl.hasMoveFrame ? "yes" : "no") : "-"} |`
    );
  }
  // Symmetric first-attempt LANDING-RATE gate (team-lead run-6 decision): every tap
  // block must be armed (checked > 0), pass the oracle self-test, and land >= 95% of
  // its first-attempt taps (catches a tap that never lands, not a 1-2% async drop).
  const tapBlocks = Object.values(eb).filter((e) => e && e.effectChecked !== undefined);
  const armed = tapBlocks.length > 0 && tapBlocks.every((e) => (e.effectChecked || 0) > 0);
  const landOk = tapBlocks.every((e) => {
    const r = rate(e);
    return r === null || r >= 0.95;
  });
  const selfOk = tapBlocks.every((e) => e.oracleSelfTestPassed !== false);
  const pass = armed && landOk && selfOk;
  L.push("");
  L.push(
    `- first-attempt landing gate (every tap block armed, oracle self-test passed, landing rate >= 95%): **${pass ? "PASS" : "FAIL"}**` +
      (tapBlocks.length ? "" : " (no tap block reported effect counts)")
  );
  L.push("");
}

// Locate source per block (review F5) + no-effect diagnostics (review F7). The
// per-iteration untimed locate is NOT backend-independent: its primary source, a
// `uiautomator dump` file, is unusable while a backend holds UiAutomation, so it
// falls through to the block's OWN backend describe. Only the effect FINGERPRINT
// (mResumedActivity via dumpsys) is backend-independent. Print the split so the
// asymmetry is visible, and surface any first-attempt no-effect tap's identity.
if (blocks.some((b) => b.locateViaTotal || (b.noEffectSamples && b.noEffectSamples.length))) {
  L.push("### Locate source & no-effect taps (F5 / F7)");
  L.push("");
  L.push("Locate is per-backend (dump primary, backend-describe fallback); only the effect fingerprint (`mResumedActivity`) is backend-independent.");
  L.push("");
  L.push("| block | locate dump/describe | first-attempt no-effect |");
  L.push("| --- | --- | --- |");
  for (const b of blocks) {
    const lv = b.locateViaTotal;
    const via = lv ? `${lv.dump}/${lv.describe}` : "-";
    const ne = b.noEffectSamples && b.noEffectSamples.length ? String(b.noEffectSamples.length) : "0";
    L.push(`| ${b.block} | ${via} | ${ne} |`);
  }
  L.push("");
  const withMisses = blocks.filter((b) => b.noEffectSamples && b.noEffectSamples.length);
  if (withMisses.length) {
    L.push("First-attempt no-effect tap identities (F7):");
    L.push("");
    for (const b of withMisses) {
      for (const s of b.noEffectSamples) L.push(`- **${b.block}** ${s}`);
    }
    L.push("");
  }
}

// Notes
L.push("### Notes per block");
L.push("");
for (const b of blocks) {
  if (b.notes && b.notes.length) {
    L.push(`**${b.block}**`);
    for (const n of b.notes) L.push(`- ${n}`);
    L.push("");
  }
}

// Phase 3n.2: the Fling A/B section was removed with scrcpy. The fling metric is
// instrument-unresolved and deferred to ticket 3o (metric repair); no fling artifact
// is produced by this run and none is rendered here.

// Phase 3j: serialize-once + compact in-run A/B and the transport experiment.
// Defensive — only rendered for ON blocks that carry a `phase3j` object.
const p50p95 = (st) => (st && st.p50 !== null && st.p50 !== undefined ? `${st.p50}/${st.p95 ?? "?"}` : "-");
const on3j = blocks.filter((b) => b.phase3j);
if (on3j.length) {
  L.push("### Phase 3j — serialize-once + compact (before | after, p50/p95)");
  L.push("");
  for (const b of on3j) {
    const p = b.phase3j;
    L.push(`**${b.block}**`);
    L.push("");
    L.push("| metric | serialize legacy | serialize once | compact off | compact on |");
    L.push("| --- | --- | --- | --- | --- |");
    const el = p.encodeLegacy, eo = p.encodeOnce, co = p.compactOff, cn = p.compactOn;
    L.push(`| server handleMs (t3-t2) | ${p50p95(el?.serverHandleMs)} | ${p50p95(eo?.serverHandleMs)} | ${p50p95(co?.serverHandleMs)} | ${p50p95(cn?.serverHandleMs)} |`);
    L.push(`| server encodeMs | ${p50p95(el?.serverEncodeMs)} | ${p50p95(eo?.serverEncodeMs)} | ${p50p95(co?.serverEncodeMs)} | ${p50p95(cn?.serverEncodeMs)} |`);
    L.push(`| wireBytes | ${p50p95(el?.wireBytes)} | ${p50p95(eo?.wireBytes)} | ${p50p95(co?.wireBytes)} | ${p50p95(cn?.wireBytes)} |`);
    L.push(`| hostRttMs | ${p50p95(el?.hostRttMs)} | ${p50p95(eo?.hostRttMs)} | ${p50p95(co?.hostRttMs)} | ${p50p95(cn?.hostRttMs)} |`);
    L.push("");
    if (p.transport && p.transport.arms) {
      L.push(`Transport experiment (N per arm; pad target ${p.transport.paddingTarget}B) — rttMs / recvMs / wireB p50/p95:`);
      L.push("");
      L.push("| arm | rttMs | recvMs | wireB | note |");
      L.push("| --- | --- | --- | --- | --- |");
      for (const a of p.transport.arms) {
        const note = (a.available ? "" : "N/A: ") + (a.note || "");
        L.push(`| ${a.label} | ${p50p95(a.rtt)} | ${p50p95(a.recv)} | ${p50p95(a.wire)} | ${note.replace(/\|/g, "\\|")} |`);
      }
      L.push("");
    }
  }
}

L.push(`_merged: ${path.basename(mergedPath)}_`);

process.stdout.write(L.join("\n") + "\n");
