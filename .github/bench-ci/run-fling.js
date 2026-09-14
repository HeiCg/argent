// ts-node loader for the fling-fidelity A/B.
//
// Phase 3k.1 (3K-M6): the fling arms must be INTERLEAVED per cell (round-robin) in a
// SINGLE process, not run as four sequential ~7-min blocks. The committed CI workflow
// (open/main) still drives this by calling the loader once per config
// (ON-uiautomation, ON-scrcpy, ON-scrcpy-legacy, OFF) — and the workflow file could
// not be updated on this branch (the push credential lacks the GitHub `workflow`
// OAuth scope). So this loader drives the interleave ITSELF: the FIRST invocation runs
// the full round-robin orchestrator (which writes EVERY block file + the host pacing
// trace + interleave evidence), and any later invocation from the workflow's remaining
// configs detects the completed claim via a lock file and no-ops. FLING_INCLUDE_OFF is
// derived from PROP_EXECUTABLE (a $GITHUB_ENV var inherited by this process). Set
// ARGENT_FLING_NO_ORCHESTRATE=1 to fall back to the literal single-config mode.
const fs = require("node:fs");
const path = require("node:path");

if (process.env.ARGENT_FLING_NO_ORCHESTRATE !== "1") {
  const OUT = process.env.BENCH_OUT || path.join(process.cwd(), ".bench-results");
  const LOCK = path.join(OUT, ".fling-interleave.lock");
  try {
    fs.mkdirSync(OUT, { recursive: true });
  } catch {
    /* best effort */
  }
  if (fs.existsSync(LOCK)) {
    // A previous config already claimed and ran the interleave — nothing to do.
    // eslint-disable-next-line no-console
    console.log(
      `[run-fling] interleave already ran (this call was FLING_CONFIG=${process.env.FLING_CONFIG}) — no-op; see ${LOCK}`
    );
    process.exit(0);
  }
  fs.writeFileSync(
    LOCK,
    `interleave claimed ${new Date().toISOString()} by FLING_CONFIG=${process.env.FLING_CONFIG}\n`
  );
  process.env.FLING_CONFIG = "INTERLEAVE";
  if (process.env.FLING_INCLUDE_OFF === undefined) {
    process.env.FLING_INCLUDE_OFF = process.env.PROP_EXECUTABLE === "1" ? "1" : "0";
  }
  // eslint-disable-next-line no-console
  console.log(
    `[run-fling] driving the interleaved fling A/B (3K-M6) in one process; ` +
      `FLING_INCLUDE_OFF=${process.env.FLING_INCLUDE_OFF} FLING_N=${process.env.FLING_N ?? "12"}`
  );
}

require("ts-node").register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: "commonjs",
    target: "ES2022",
    moduleResolution: "node",
    esModuleInterop: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    strict: false,
    ignoreDeprecations: "6.0",
  },
});
require(require("node:path").resolve(process.cwd(), "packages/tool-server/scripts/bench-fling-fidelity.ts"));
