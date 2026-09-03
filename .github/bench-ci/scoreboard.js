// Render the latency-bench scoreboard as Markdown from the merged bench JSON
// (and the fling A/B JSON when present). Written to stdout; the workflow tees it
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
const flingPath = latest("^fling-ab-.*\\.json$");
const fling = flingPath ? JSON.parse(fs.readFileSync(flingPath, "utf8")) : null;

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

// ON-scrcpy beats ON-uiautomation and OFF on tap?
const onUia = blocks.find((b) => b.block === "ON-uiautomation");
const onScr = blocks.find((b) => b.block === "ON-scrcpy");
const tapP50 = (b) => b && (b.verbs || []).find((x) => x.verb === "gesture-tap")?.latency.p50;
if (onScr) {
  const s = tapP50(onScr), u = tapP50(onUia), o = tapP50(off1);
  L.push("### tap verdict (gesture-tap p50)");
  L.push("");
  L.push(`- ON-scrcpy: **${s ?? "-"}ms** · ON-uiautomation: ${u ?? "-"}ms · OFF-1: ${o ?? "-"}ms`);
  const beatsUia = s != null && u != null ? (s < u ? "YES" : "NO") : "n/a";
  const beatsOff = s != null && o != null ? (s < o ? "YES" : "NO") : "n/a (OFF absent)";
  L.push(`- ON-scrcpy beats ON-uiautomation on tap: **${beatsUia}**`);
  L.push(`- ON-scrcpy beats OFF on tap: **${beatsOff}**`);
  L.push("");
}

// Effect-check + tap-timeline parity (phase 3h) — the taps actually landed and the
// injected shape was as intended.
const ez = merged.effectZeroByBlock;
if (ez && Object.keys(ez).length) {
  L.push("### tap effect-check & timeline parity (phase 3h)");
  L.push("");
  L.push("| block | no-effect taps | tap frames | MOVE |");
  L.push("| --- | --- | --- | --- |");
  const tt = merged.tapTimelines || {};
  for (const b of blocks) {
    const tl = tt[b.block];
    L.push(`| ${b.block} | ${ez[b.block] ?? "-"} | ${tl ? tl.frameCount : "-"} | ${tl ? (tl.hasMoveFrame ? "yes" : "no") : "-"} |`);
  }
  const allZero = Object.values(ez).every((v) => (v || 0) === 0);
  L.push("");
  L.push(`- effect gate (no-effect tap iterations per block == 0): **${allZero ? "PASS" : "FAIL"}**`);
  L.push("");
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

// Fling A/B
if (fling) {
  L.push("### Fling A/B (scrcpy vs uiautomation median scroll)");
  L.push("");
  L.push(`OFF reference present: ${fling.offReferencePresent ? "yes" : "no"}`);
  if (fling.flingGate) {
    L.push("");
    L.push(`Fling parity gate (±${fling.flingGate.tolerance} on informative cells): **${fling.flingGate.verdict}**`);
  }
  L.push("");
  L.push("| dur(ms) | dist | uia med | scrcpy med | scrcpy/uia | off med | reliable |");
  L.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const g of fling.grid || []) {
    L.push(`| ${g.durationMs} | ${g.distance} | ${g.uiautomation?.median ?? "-"} | ${g.scrcpy?.median ?? "-"} | ${g.scrcpyOverUia} | ${g.off?.median ?? "-"} | ${g.reliable ? "✓" : "saturated"} |`);
  }
  L.push("");
}

L.push(`_merged: ${path.basename(mergedPath)}${fling ? `, fling: ${path.basename(flingPath)}` : ""}_`);

process.stdout.write(L.join("\n") + "\n");
