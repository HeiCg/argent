// iOS bench scoreboard renderer (ticket iOS-2). A NEW file — it does NOT touch
// the Android scoreboard.js, and it does NOT write the shared
// 2026-09-03-scoreboard.md (the planner adds an iOS section there after
// adversarial review). It renders the merged iOS JSON + per-block files into a
// markdown report for the job summary and the results file:
//   - process header (run id, xcodebuild, runtime, device type, tokenizer, N);
//   - the verb table per block (p50/p95, errors), describe split per TREE backend;
//   - G2 Δ vs OFF with the drift floor + bootstrap 95% CI + win/parity/loss;
//   - landing rates with denominators;
//   - optical scroll offsets per arm (median, IQR, refusals);
//   - G4 tokens per tree backend at the stated cap (+ denominators);
//   - G3 stage sums; gate verdicts.
const fs = require("fs");
const path = require("path");

const OUT = process.env.BENCH_OUT || path.join(process.cwd(), ".bench-results");
const ALL = ["OFF-1", "ON-xcuitest", "ON-siminput", "OFF-2"];
const VERBS = [
  "describe",
  "gesture-tap",
  "tap+describe",
  "gesture-swipe",
  "await-screen-idle",
  "await-ui-element",
];

function latestMerged() {
  const cands = fs
    .readdirSync(OUT)
    .filter((f) => /^bench-ios-merged-\d+\.json$/.test(f))
    .map((f) => ({ f, m: Number(f.match(/(\d+)/)[1]) }))
    .sort((a, b) => b.m - a.m);
  return cands.length ? JSON.parse(fs.readFileSync(path.join(OUT, cands[0].f), "utf8")) : null;
}
function blocks() {
  const out = {};
  for (const n of ALL) {
    const p = path.join(OUT, `bench-block-${n}.json`);
    if (fs.existsSync(p)) out[n] = JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return out;
}
const fx = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—");

const merged = latestMerged();
const bl = blocks();
const present = ALL.filter((n) => bl[n]);
const L = [];
L.push(
  "## iOS-2 open-driver bench — scoreboard (NOT the shared scoreboard; planner adds the iOS section after review)\n"
);

// Process header (G5).
const env = merged ? merged.env : present[0] ? bl[present[0]].env : {};
L.push("### Process (G5)\n");
L.push("| field | value |");
L.push("|---|---|");
L.push(`| run id | ${env.runId || process.env.GITHUB_RUN_ID || "—"} |`);
L.push(`| tested sha | ${env.sha || process.env.GITHUB_SHA || "—"} |`);
L.push(`| xcodebuild | ${(env.xcodebuild || "—").replace(/\n/g, " ")} |`);
L.push(`| runtime | ${env.runtime || "—"} |`);
L.push(`| device type | ${env.deviceType || "—"} |`);
L.push(`| tokenizer | ${env.tokenizer || "—"} |`);
L.push(`| N per verb | ${env.N || "—"} |`);
L.push(
  `| describe cap (G4) | ${env.describeCap || (merged && merged.g4 && merged.g4.cap) || "—"} |`
);
L.push(`| blocks ran | ${present.join(", ") || "—"} |\n`);

// Verb table per block.
L.push("### Verb latency per block (p50 / p95 ms, N per verb; describe scored per TREE backend)\n");
L.push("| verb | " + present.map((n) => `${n} (${bl[n].block.treeBackend})`).join(" | ") + " |");
L.push("|---|" + present.map(() => "---").join("|") + "|");
for (const verb of VERBS) {
  const cells = present.map((n) => {
    const v = (bl[n].block.verbs || []).find((x) => x.verb === verb);
    if (!v) return "—";
    const na = v.extra && v.extra.na;
    if (na) return na;
    return `${fx(v.latency.p50)}/${fx(v.latency.p95)} (n=${v.latency.n}${v.errors ? `, err=${v.errors}` : ""})`;
  });
  L.push(`| ${verb} | ${cells.join(" | ")} |`);
}
// paste / pinch N/A row is emitted by the verbs themselves above.
L.push(
  "\n_describe has two TREE-backend rows by construction: ax-service (OFF-1/OFF-2) vs XCUITest snapshot (ON-xcuitest/ON-siminput). ON-siminput shares the ON-xcuitest tree — its describe row is the XCUITest backend, not a separate input arm. `paste` and `gesture-pinch` are `N/A (iOS-4)`._\n"
);

// G2 Δ vs OFF.
if (merged && merged.g2) {
  L.push(
    "### G2 (report-only) — Δ vs pooled OFF per verb, drift floor, bootstrap 95% CI on the p50 Δ, verdict\n"
  );
  L.push("| verb | OFF p50 (OFF-1/OFF-2) | floor | arm | ON p50 | Δ | CI95 | verdict |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const verb of VERBS) {
    const row = merged.g2.verbs[verb];
    if (!row) continue;
    const armNames = Object.keys(row.arms);
    if (armNames.length === 0) {
      L.push(
        `| ${verb} | ${fx(row.offP50)} (${fx(row.off1P50)}/${fx(row.off2P50)}) | ${fx(row.floor, 2)} | — | — | — | — | — |`
      );
      continue;
    }
    armNames.forEach((a, i) => {
      const arm = row.arms[a];
      L.push(
        `| ${i === 0 ? verb : ""} | ${i === 0 ? `${fx(row.offP50)} (${fx(row.off1P50)}/${fx(row.off2P50)})` : ""} | ${i === 0 ? fx(row.floor, 2) : ""} | ${a} | ${fx(arm.onP50)} | ${fx(arm.delta, 2)} | [${fx(arm.ci95[0], 2)}, ${fx(arm.ci95[1], 2)}] | ${arm.verdict} |`
      );
    });
  }
  L.push(
    "\n_Verdict at the floor: win = CI entirely below −floor (ON faster than OFF by more than same-run drift); loss = CI entirely above +floor; else parity. Report-only this phase — no promotion._\n"
  );
}

// Landing rates (IOS2-H4: calibrated per-block threshold from the G0 navDiff).
L.push("### G1 — first-attempt landing per block (with denominators)\n");
L.push(
  "| block | input path | landed / checked | rate | G0 navDiff | land threshold | runner crashes | sim-input ack timeouts |"
);
L.push("|---|---|---|---|---|---|---|---|");
for (const n of present) {
  const b = bl[n].block;
  const c = b.effectCheckedTotal || 0;
  const landed = c - (b.firstTapNoEffectTotal || 0);
  const inputPath = b.inputIsProductTool ? "gesture-tap tool" : "sim-input HID (bench-local)";
  const nav = b.oracle && Number.isFinite(b.oracle.navDiff) ? b.oracle.navDiff : "—";
  const thr =
    b.oracle && Number.isFinite(b.oracle.landingThreshold) ? b.oracle.landingThreshold : "—";
  L.push(
    `| ${n} | ${inputPath} | ${landed} / ${c} | ${c > 0 ? ((landed / c) * 100).toFixed(1) + "%" : "—"} | ${nav} | ${thr} | ${b.runnerCrashes || 0} | ${b.simInputAckTimeouts || 0} |`
  );
}
L.push(
  "\n_Landing = neutral-pixel diff ratio ≥ 0.5 × the block's own G0 navDiff (IOS2-H4). The per-tap ratio, coordinate and poll index are persisted in the block JSON `tapRecords`; the OFF and ON arms locate the target with the SAME shared open-tree code (IOS2-H3)._\n"
);

// Optical scroll offsets (IOS2-H5: screen POINTS, full-res NCC, no half-window clamp).
L.push("### Optical scroll offset per arm (full-res NCC on simctl screenshots; screen POINTS)\n");
L.push(
  "| block | median dyPts | IQR (q1–q3) | raster scale (px/pt) | confidence refusals | n (accepted) |"
);
L.push("|---|---|---|---|---|---|");
for (const n of present) {
  const s = bl[n].block.scroll;
  if (!s) {
    L.push(`| ${n} | — | — | — | — | — |`);
    continue;
  }
  L.push(
    `| ${n} | ${fx(s.median)} | ${fx(s.q1)}–${fx(s.q3)} (IQR ${fx(s.iqr)}) | ${fx(s.rasterScale, 3)} | ${s.refusals} | ${s.n} |`
  );
}
L.push(
  "\n_Offsets are in SCREEN POINTS via `optical-scroll.ts` (full-resolution NCC, maxShift 0.9 of the region, refuse only on confidence < 0.6 — no half-window clamp); the framebuffer-px→points scale is stated. Per-swipe `from`/`to`/`scrollRegion`/`dyPx`/`confidence` are persisted in the block JSON `scroll.records`, with a few before/after PNG pairs under `.bench-results/shots/<block>/`. No ratio gate this phase (the fling gate is 3o/iOS-3)._\n"
);

// G4 tokens.
if (merged && merged.g4) {
  L.push(
    `### G4 — describe tokens per TREE backend at the equal element cap (cap = ${merged.g4.cap})\n`
  );
  L.push(
    "| tree backend | source | elements (denominator) | tokens (uncapped) | tok/element | tokens@cap | capElements |"
  );
  L.push("|---|---|---|---|---|---|---|");
  for (const [backend, d] of Object.entries(merged.g4.backends)) {
    const tokPerEl = d.elements > 0 ? (d.tokens / d.elements).toFixed(1) : "—";
    L.push(
      `| ${backend} | ${d.source} | ${d.elements} | ${d.tokens} | ${tokPerEl} | ${d.capTokens} | ${d.capElements} |`
    );
  }
  L.push(
    "\n_o200k tokens. The cap is the equal element budget; the denominator is the per-backend element count at the idle Settings root._\n"
  );
}

// G3 stage sums.
if (merged && merged.gates && merged.gates.G3) {
  L.push("### G3 — Σ(stages) ≈ captureMs on the open tree (direct socket; bench-local)\n");
  // IOS2-L3: escape the pipes in |Σ−capture| so the header renders (5 cells before,
  // against a 3-cell separator).
  L.push("| block | samples | max \\|Σ−capture\\| (ms) |");
  L.push("|---|---|---|");
  for (const [n, s] of Object.entries(merged.gates.G3.sums || {})) {
    L.push(`| ${n} | ${s.n} | ${fx(s.maxDelta, 3)} |`);
  }
  L.push("");
}

// Fidelity.
if (merged && merged.fidelity) {
  L.push(
    `### Fidelity — OFF-1 (ax-service) vs ${merged.fidelity.off1_vs} (XCUITest) describe identity\n`
  );
  L.push(
    `Jaccard = ${merged.fidelity.jaccard} (OFF identity tokens ${merged.fidelity.offCount}, ON identity tokens ${merged.fidelity.onCount} — id:/text: tokens, NOT element counts, IOS2-L2).\n`
  );
}

// Gate verdicts.
L.push("### Gate verdicts\n");
if (merged && merged.gates) {
  const g = merged.gates;
  const status = (x) => (x.passed ? "GREEN" : "RED");
  L.push(
    `- G0 control: ${status(g.G0)}${g.G0.notes && g.G0.notes.length ? " — " + g.G0.notes.join("; ") : ""}`
  );
  L.push(
    `- G1 landing/crashes/ack: ${status(g.G1)}${g.G1.notes && g.G1.notes.length ? " — " + g.G1.notes.join("; ") : ""}`
  );
  L.push(`- G2 report-only: reported above (no pass/fail)`);
  L.push(
    `- G3 stage sums: ${status(g.G3)}${g.G3.notes && g.G3.notes.length ? " — " + g.G3.notes.join("; ") : ""}`
  );
  L.push(`- G4 tokens: reported above (no pass/fail)`);
  L.push(`- G5 process: header above`);
} else {
  L.push("_no merged JSON found — gates not evaluated._");
}
L.push("");

process.stdout.write(L.join("\n") + "\n");
