// iOS bench block validity, fail closed (2026-10-04 harness repair). Shared by
// merge-blocks-ios.js (gates) and scoreboard-ios.js (rendering), so both read the
// same verdict. Run 37213144359 recorded an ON-xcuitest describe served by
// ax-service under the label `xcuitest`, and n=20 gesture-swipe latencies the tool
// layer served from simulator-server; nothing caught either.
//
// A block is INVALID when:
//   - any measured sample was served by the other arm's path (ON → proprietary
//     ax-service / native-devtools / simulator-server; OFF → the open runner);
//   - a measured sample carries no serving path at all;
//   - its oracle self-test failed;
//   - the runner connection errored (connectionErrors > 0);
//   - simulator-server reported not ready (OFF);
//   - a timed describe returned 0 elements (`emptyDescribes` per verb), on either
//     arm: the same standard for both (run 37223296646 OFF-1 read an empty
//     ax-service tree);
//   - the tool layer fell back from the open path inside a timed verb
//     (`fallbacks` per verb), on an ON block.
// INVALID blocks' numbers are not rendered and do not enter G2/G4/fidelity.

// Serving-path tokens a sample records (`servedBy`): the tree source for describe,
// the injector for gestures, `<input>+<tree>` for tap+describe.
const PROPRIETARY = new Set(["ax-service", "native-devtools", "simulator-server"]);
const OPEN = new Set(["xcuitest-runner", "open-device-server", "sim-input"]);
const TREE_OF = {
  "xcuitest-runner": "xcuitest",
  "ax-service": "ax-service",
  "native-devtools": "native-devtools",
};
const INPUT_OF = {
  "open-device-server": "xcuitest",
  "sim-input": "sim-input",
  "simulator-server": "simulator-server",
};
// The verbs whose samples go through a describe or gesture path.
const PATH_VERBS = ["describe", "gesture-tap", "tap+describe", "gesture-swipe"];

const tokensOf = (entry) =>
  String(entry)
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);

/** The arm's intended tree backend. Pre-repair blocks only carry `treeBackend`,
 * which was fixed per arm (= intended); the config decides it for them. */
function intendedBackendOf(b) {
  if (b.intendedBackend) return b.intendedBackend;
  if (b.config === "ON") return "xcuitest";
  if (b.config === "OFF") return "ax-service";
  return b.treeBackend || "unknown";
}

/** Connection-class errors on the runner. `runnerCrashes` is the pre-repair key
 * (it always counted connection errors, never app crashes). */
function connectionErrorsOf(b) {
  const count = Number(b.connectionErrors ?? b.runnerCrashes ?? 0) || 0;
  return { count, first: b.firstConnectionError || null };
}

function pathVerbs(b) {
  return (b.verbs || []).filter((v) => PATH_VERBS.includes(v.verb) && !(v.extra && v.extra.na));
}

/** Every recorded serving path: the idle describe sample plus each measured
 * attempt of the path verbs. Pre-repair blocks carry only `describe.source`. */
function servedByEntries(b) {
  const out = [];
  if (b.describe && b.describe.source) out.push(b.describe.source);
  for (const v of pathVerbs(b)) {
    if (Array.isArray(v.servedBy)) out.push(...v.servedBy);
  }
  return out;
}

/** Measured attempts (latency samples + errors) with no recorded serving path. */
function unrecordedSamples(b) {
  let missing = 0;
  for (const v of pathVerbs(b)) {
    const attempts =
      (Array.isArray(v.latencySamples) ? v.latencySamples.length : 0) + (v.errors || 0);
    const got = Array.isArray(v.servedBy) ? v.servedBy.length : 0;
    if (got < attempts) missing += attempts - got;
  }
  return missing;
}

/** `{verb: n}` for the measured path verbs with a non-zero `key`. Blocks written
 * before the counter existed carry none and read as `{}`. */
function perVerbCounts(b, key) {
  const out = {};
  for (const v of pathVerbs(b)) {
    const n = Number(v[key] || 0);
    if (n > 0) out[v.verb] = n;
  }
  return out;
}

/** `verb=n, …` for a per-verb count, `0` when empty. */
function perVerbText(counts) {
  const xs = Object.entries(counts).map(([verb, n]) => `${verb}=${n}`);
  return xs.length ? xs.join(", ") : "0";
}

function labelOf(set) {
  const xs = [...set].sort();
  if (xs.length === 0) return "unknown";
  if (xs.length === 1) return xs[0];
  return `mixed(${xs.join(",")})`;
}

/** The tree backend and input path the samples were actually served by. */
function observedPaths(b) {
  const tree = new Set();
  const input = new Set();
  for (const e of servedByEntries(b)) {
    for (const t of tokensOf(e)) {
      if (TREE_OF[t]) tree.add(TREE_OF[t]);
      if (INPUT_OF[t]) input.add(INPUT_OF[t]);
    }
  }
  return { tree: labelOf(tree), input: labelOf(input) };
}

/** The validity verdict of one block (the `.block` object of a block file). */
function blockValidity(b) {
  const reasons = [];
  const entries = servedByEntries(b);
  const total = entries.length;
  const offPath = (set) => entries.filter((e) => tokensOf(e).some((t) => set.has(t))).length;
  let crossed = 0;
  if (b.config === "ON") {
    crossed = offPath(PROPRIETARY);
    if (crossed > 0) reasons.push(`fell back to proprietary: ${crossed}/${total} samples`);
  } else if (b.config === "OFF") {
    crossed = offPath(OPEN);
    if (crossed > 0) reasons.push(`served by the open path: ${crossed}/${total} samples`);
  }
  const missing = unrecordedSamples(b);
  if (missing > 0) reasons.push(`serving path not recorded for ${missing} measured sample(s)`);
  if (!(b.oracle && b.oracle.selfTestPassed)) {
    reasons.push(`oracle self-test failed: ${(b.oracle && b.oracle.note) || "not run"}`);
  }
  const ce = connectionErrorsOf(b);
  if (ce.count > 0) {
    reasons.push(
      `connectionErrors=${ce.count} (first: ${JSON.stringify(ce.first || "(no message recorded)")})`
    );
  }
  if (b.proprietaryReady && b.proprietaryReady.ready === false) {
    reasons.push(`simulator-server not ready: ${b.proprietaryReady.error || "no error recorded"}`);
  }
  const perVerb = {
    emptyDescribes: perVerbCounts(b, "emptyDescribes"),
    fallbacks: perVerbCounts(b, "fallbacks"),
  };
  if (Object.keys(perVerb.emptyDescribes).length > 0) {
    reasons.push(
      `empty describe (0 elements) in timed verbs: ${perVerbText(perVerb.emptyDescribes)}`
    );
  }
  if (b.config === "ON" && Object.keys(perVerb.fallbacks).length > 0) {
    reasons.push(`fallback inside timed verbs: ${perVerbText(perVerb.fallbacks)}`);
  }
  const observed = observedPaths(b);
  return {
    valid: reasons.length === 0,
    reasons,
    intendedBackend: intendedBackendOf(b),
    observedTreeBackend: observed.tree,
    observedInput: observed.input,
    servedBy: { crossed, total, unrecorded: missing },
    connectionErrors: ce.count,
    firstConnectionError: ce.first,
    perVerb,
  };
}

/** `INVALID (<reasons>)` for an invalid verdict, `valid` otherwise. */
function validityLabel(v) {
  return v.valid ? "valid" : `INVALID (${v.reasons.join("; ")})`;
}

module.exports = { blockValidity, connectionErrorsOf, perVerbText, validityLabel };
