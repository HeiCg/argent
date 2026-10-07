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
//   - G3 stage sums; gate verdicts;
//   - the ON-siminput decomposition (iOS-4 ticket 1): p50 of each term of the
//     sim-input ack timing per verb (`verbs[].inputTimings`).
// A block the validity check (ios-validity.js) marks INVALID renders as
// `INVALID (<reasons>)` and none of its latency / landing / scroll numbers.
const fs = require("fs");
const path = require("path");
const { blockValidity, perVerbText, treeReferences, validityLabel } = require("./ios-validity");

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
// The merge's verdict when there is one; otherwise the same check on the block file.
const treeRefs = treeReferences(present.map((n) => bl[n].block));
const validity = Object.fromEntries(
  present.map((n) => [
    n,
    (merged && merged.validity && merged.validity[n]) || blockValidity(bl[n].block, treeRefs),
  ])
);
const invalid = (n) => !validity[n].valid;
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

// Re-baseline (0.27): the simulator-server the OFF arm ran — requested tag, the
// release it resolved to, and the sha256 of the binary actually downloaded.
{
  const pv = merged ? merged.proprietaryProvenance : null;
  L.push("### Proprietary provenance (OFF arm)\n");
  if (!pv || typeof pv !== "object") {
    L.push(
      "_Not recorded (pre-0.27 artifact): the OFF arm's simulator-server release is unknown._\n"
    );
  } else {
    const rel = pv.release || {};
    const a = pv.asset || null;
    L.push("| field | value |");
    L.push("|---|---|");
    L.push(`| repo | ${pv.repo || "—"} |`);
    L.push(
      `| requested tag | ${pv.requestedTag || `(script default: ${pv.scriptDefaultTag || "?"})`} |`
    );
    L.push(
      `| resolved release | ${rel.tagName ? `${rel.tagName}${rel.name && rel.name !== rel.tagName ? ` "${rel.name}"` : ""} (published ${rel.publishedAt || "?"})` : `unresolved (${pv.resolvedTag || "?"})`} |`
    );
    L.push(
      `| asset | ${a ? `${a.name} id ${a.databaseId ?? a.id ?? "?"} (updated ${a.updatedAt || "?"}, ${a.digest || "no digest"})` : "—"} |`
    );
    for (const [f, h] of Object.entries(pv.files || {})) L.push(`| sha256 \`${f}\` | \`${h}\` |`);
    L.push(
      `| digest matches | ${pv.assetDigestMatches == null ? "—" : pv.assetDigestMatches ? "yes" : "NO"} |\n`
    );
  }
}

// simslim: whether the simulator was slimmed, and simslim's memory measure after
// boot and after each block. The measure is descriptive (G4 of the simslim doc).
{
  const sim = merged ? merged.simulator : null;
  L.push("### Simulator (simslim)\n");
  if (!sim || typeof sim !== "object") {
    L.push("_Not recorded (pre-simslim artifact): the simulator's slim state is unknown._\n");
  } else {
    const mib = (b) => (Number.isFinite(b) ? `${(b / 1048576).toFixed(1)} MiB` : "—");
    L.push("| field | value |");
    L.push("|---|---|");
    L.push(`| slim | ${sim.slim ? "yes" : "no"} |`);
    L.push(`| simslim | ${sim.simslimVersion || "not installed"} |`);
    L.push(`| profile sha256 | ${sim.profileSha256 ? `\`${sim.profileSha256}\`` : "—"} |`);
    L.push(
      `| managed labels disabled | ${sim.managedDisabled ?? "—"} / ${sim.managedTotal ?? "—"} |\n`
    );
    L.push("| measured at | processes | phys_footprint |");
    L.push("|---|---|---|");
    const row = (at, r) => {
      const m = r && r.measure;
      L.push(`| ${at} | ${m && m.processes != null ? m.processes : "—"} | ${mib(m && m.bytes)} |`);
    };
    row("boot", sim);
    for (const [n, r] of Object.entries(merged.simulatorByBlock || {})) row(n, r);
    L.push(
      "\n_`simslim measure`: process count and summed phys_footprint of the simulator's process tree. boot = after `bootstatus`; a block row = after that block._\n"
    );
  }
}

// Block validity (fail closed): the serving path every sample recorded decides
// the backend label, not the arm.
L.push("### Block validity\n");
L.push(
  "| block | intended backend | observed tree | observed input | samples on the other arm's path | connection errors | empty describes (timed) | fallbacks (timed) | verdict |"
);
L.push("|---|---|---|---|---|---|---|---|---|");
for (const n of present) {
  const v = validity[n];
  const sb = v.servedBy || {};
  const pv = v.perVerb || {};
  const count = (c) => (c ? perVerbText(c) : "—");
  L.push(
    `| ${n} | ${v.intendedBackend} | ${v.observedTreeBackend} | ${v.observedInput} | ${sb.crossed ?? "—"} / ${sb.total ?? "—"} | ${v.connectionErrors} | ${count(pv.emptyDescribes)} | ${count(pv.fallbacks)} | ${validityLabel(v)} |`
  );
}
L.push(
  "\n_INVALID blocks render no numbers below and are excluded from G2/G4/fidelity. ON blocks must be served only by the open runner (xcuitest-runner tree, open-device-server or sim-input input); OFF blocks only by ax-service + simulator-server. A timed describe with 0 elements invalidates either arm; a fallback inside a timed verb invalidates an ON block._\n"
);

// Verb table per block.
L.push("### Verb latency per block (p50 / p95 ms, N per verb; describe scored per TREE backend)\n");
L.push(
  "| verb | " + present.map((n) => `${n} (${validity[n].observedTreeBackend})`).join(" | ") + " |"
);
L.push("|---|" + present.map(() => "---").join("|") + "|");
for (const verb of VERBS) {
  const cells = present.map((n) => {
    if (invalid(n)) return "INVALID";
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
  for (const [n, why] of Object.entries(merged.g2.excluded || {})) {
    L.push(`\n_${n} excluded from G2: ${why}_`);
  }
  L.push(
    "\n_Verdict at the floor: win = CI entirely below −floor (ON faster than OFF by more than same-run drift); loss = CI entirely above +floor; else parity. Report-only this phase — no promotion._\n"
  );
}

// Landing rates (IOS2-H4: calibrated per-block threshold from the G0 navDiff).
L.push("### G1 — first-attempt landing per block (with denominators)\n");
L.push(
  "| block | input path | landed / checked | rate | G0 navDiff | land threshold | connection errors | sim-input ack timeouts |"
);
L.push("|---|---|---|---|---|---|---|---|");
for (const n of present) {
  const b = bl[n].block;
  if (invalid(n)) {
    L.push(
      `| ${n} | INVALID | INVALID | INVALID | INVALID | INVALID | ${validity[n].connectionErrors} | ${b.simInputAckTimeouts || 0} |`
    );
    continue;
  }
  const c = b.effectCheckedTotal || 0;
  const landed = c - (b.firstTapNoEffectTotal || 0);
  const inputPath = b.inputIsProductTool ? "gesture-tap tool" : "sim-input HID (bench-local)";
  const nav = b.oracle && Number.isFinite(b.oracle.navDiff) ? b.oracle.navDiff : "—";
  const thr =
    b.oracle && Number.isFinite(b.oracle.landingThreshold) ? b.oracle.landingThreshold : "—";
  L.push(
    `| ${n} | ${inputPath} | ${landed} / ${c} | ${c > 0 ? ((landed / c) * 100).toFixed(1) + "%" : "—"} | ${nav} | ${thr} | ${validity[n].connectionErrors} | ${b.simInputAckTimeouts || 0} |`
  );
}
L.push(
  "\n_Landing = neutral-pixel diff ratio ≥ 0.5 × the block's own G0 navDiff (IOS2-H4). The per-tap ratio, coordinate and poll index are persisted in the block JSON `tapRecords`; the OFF and ON arms locate the target with the SAME shared open-tree code (IOS2-H3)._\n"
);

// sim-input decomposition (iOS-4 ticket 1): where an ON-siminput command's time
// goes, p50 of each term over the measured samples of each verb.
{
  const p50 = (xs) => {
    const s = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    return s.length ? s[Math.max(0, Math.ceil(0.5 * s.length) - 1)] : NaN;
  };
  const sum = (xs) => xs.reduce((a, v) => a + v, 0);
  const rows = [];
  for (const n of present) {
    for (const v of bl[n].block.verbs || []) {
      const xs = Array.isArray(v.inputTimings) ? v.inputTimings : [];
      if (!xs.length) continue;
      const label = invalid(n) ? `${n} (INVALID block: diagnostic only)` : n;
      const msgs = xs.map((x) => x.perMessageSendMs || []);
      rows.push(
        `| ${label} | ${v.verb} | ${xs.length} | ${fx(p50(xs.map((x) => x.hostWriteToAck)))} | ` +
          `${fx(p50(xs.map((x) => x.recvToFirstSend)))} | ${fx(p50(msgs.flat()))} | ` +
          `${String(p50(msgs.map((m) => m.length)))} | ${fx(p50(msgs.map(sum)))} | ` +
          `${fx(p50(xs.map((x) => x.gapsMs)))} | ${fx(p50(xs.map((x) => x.lastSendToAck)))} | ` +
          `${fx(p50(xs.map((x) => x.sidecarMs)))} | ${fx(p50(xs.map((x) => x.hostPipeMs)))} |`
      );
    }
  }
  L.push("### sim-input decomposition (ON-siminput, p50 ms)\n");
  if (!rows.length) {
    L.push(
      "_No sim-input timings recorded (no ON-siminput block, or a sim-input binary without ack timing)._\n"
    );
  } else {
    L.push(
      "| block | verb | n | host write→ack | recv→first send | per-message send | messages | Σ send | gaps (sleeps) | last send→ack | sidecar recv→ack | host + pipe |"
    );
    L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    L.push(...rows);
    L.push(
      "\n_Per measured tap / swipe (tap+describe: its tap). host write→ack is `performance.now()` around the stdin write and the ack line; the other terms come from the ack's `timing` (sim-input's monotonic clock). per-message send is the p50 over every HID message's `sendWithMessage:` call; gaps = sidecar − recv→first send − Σ send − last send→ack (the gesture's sleeps); host + pipe = host write→ack − sidecar. Per-sample values are in the block JSON `verbs[].inputTimings`._\n"
    );
  }
}

// Optical scroll offsets (IOS2-H5: screen POINTS, full-res NCC, no half-window clamp).
L.push("### Optical scroll offset per arm (full-res NCC on simctl screenshots; screen POINTS)\n");
L.push(
  "| block | median dyPts | IQR (q1–q3) | median dyPx | raster scale (px/pt) | scale source | confidence refusals | n (accepted) |"
);
L.push("|---|---|---|---|---|---|---|---|");
for (const n of present) {
  const s = bl[n].block.scroll;
  if (invalid(n)) {
    L.push(`| ${n} | INVALID | INVALID | INVALID | INVALID | INVALID | INVALID | INVALID |`);
    continue;
  }
  if (!s) {
    L.push(`| ${n} | — | — | — | — | — | — | — |`);
    continue;
  }
  L.push(
    `| ${n} | ${fx(s.median)} | ${fx(s.q1)}–${fx(s.q3)} (IQR ${fx(s.iqr)}) | ${fx(s.medianPx)} | ${fx(s.rasterScale, 3)} | ${s.rasterScaleSource || "runner-screen-height"} | ${s.refusals} | ${s.n} |`
  );
}
L.push(
  "\n_Offsets are in SCREEN POINTS via `optical-scroll.ts` (full-resolution NCC over the scroll region clipped to the chrome-free band y 0.13–0.90, shifts up to 0.9 of it scored down to a 10 % overlap, refuse only on confidence < 0.6); the framebuffer-px→points scale and its source are stated (`device-profile` = the device type's `mainScreenScale`). Per-swipe `from`/`to`/`region`/`opticalRegion`/`dyPx`/`confidence` are persisted in the block JSON `scroll.records`, with a few before/after PNG pairs under `.bench-results/shots/<block>/`. No ratio gate this phase (the fling gate is 3o/iOS-3)._\n"
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
    `- G1 landing/connection errors/ack: ${status(g.G1)}${g.G1.notes && g.G1.notes.length ? " — " + g.G1.notes.join("; ") : ""}`
  );
  if (g.VALIDITY) {
    L.push(
      `- validity (fail closed): ${status(g.VALIDITY)}${g.VALIDITY.notes && g.VALIDITY.notes.length ? " — " + g.VALIDITY.notes.join("; ") : ""}`
    );
  }
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
