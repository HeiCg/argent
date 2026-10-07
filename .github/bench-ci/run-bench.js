// ts-node loader for the latency bench (mirrors the p3f run-bench.js). Run from
// the repo root so the flag file + .bench-results resolve there. BENCH_ONLY
// selects a single block; the merge assembles the per-block files afterwards.
//
// Review 2026-10-07 finding 1: this loader no longer self-orchestrates the Kotlin
// injection-strategy arms. It used to spawn ON-input-manager from the FIRST run_block
// call (OFF-1), so the candidate arm ran before OFF-1 and outside the OFF-1↔OFF-2
// drift window, with its ready-gate advisory and its failure reported as OFF-1's. The
// workflow now runs every block explicitly, in order OFF-1, ON-uiautomation,
// ON-input-manager, OFF-2, OFF-legacy, each behind the blocking ready-gate.
//
// Ticket 3o: the optical fling harness still self-orchestrates here — a `FLING` token
// in the `blocks` input runs `run-fling.js` + `merge-fling.js` once, inside the latency
// job's already-booted emulator (animations off, proprietary fetched for the OFF arm),
// on the first invocation, before OFF-1. It is report-only and not part of the merge.
(function orchestrateFling() {
  if (process.env.ARGENT_BENCH_NO_ORCHESTRATE === "1") return; // a spawned child
  const fs = require("node:fs");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const requested = (process.env.BENCH_BLOCKS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const wantFling = requested.includes("FLING");
  if (!wantFling) return;
  const OUT = process.env.BENCH_OUT || path.join(process.cwd(), ".bench-results");
  const LOCK = path.join(OUT, ".bench-fling.lock");
  try {
    fs.mkdirSync(OUT, { recursive: true });
  } catch {
    /* best effort */
  }
  if (fs.existsSync(LOCK)) return; // another invocation already ran the fling harness
  fs.writeFileSync(
    LOCK,
    `fling claimed ${new Date().toISOString()} by BENCH_ONLY=${process.env.BENCH_ONLY}\n`
  );
  const serial = process.env.BENCH_SERIAL || "emulator-5554";
  console.log("[run-bench] self-orchestrating FLING (workflow-scope workaround)");
  // Tell the CI emulator watchdog which block is running (emulator-diagnostics.sh).
  const setContext = (text) => {
    if (!process.env.BENCH_CONTEXT_FILE) return;
    try {
      fs.writeFileSync(process.env.BENCH_CONTEXT_FILE, `${text}\n`);
    } catch {
      /* diagnostics only */
    }
  };
  if (wantFling) {
    setContext("block FLING (self-orchestrated)");
    console.log(
      "########## FLING (self-orchestrated, ticket 3o — optical, report-only) ##########"
    );
    const runFling = path.join(__dirname, "run-fling.js");
    const mergeFling = path.join(__dirname, "merge-fling.js");
    const flingLog = path.join(OUT, "bench-log-FLING.txt");
    // Drop the OFF arm if the proprietary binary cannot exec on this runner (the
    // documented Linux downgrade) — the merge then reports arm/off as NO-OFF instead
    // of the harness dying on a proprietary swipe that never runs.
    const offEnv = process.env.PROP_EXECUTABLE === "1" ? "" : "FLING_INCLUDE_OFF=0 ";
    try {
      execFileSync(
        "bash",
        [path.join(".github", "bench-ci", "ready-gate.sh"), serial, "3", "90", "0"],
        { stdio: "inherit" }
      );
    } catch {
      /* best effort — the harness resets Settings per sample anyway */
    }
    let flingFailure = null;
    try {
      execFileSync(
        "bash",
        [
          "-c",
          `${offEnv}node ${JSON.stringify(runFling)} 2>&1 | tee -a ${JSON.stringify(flingLog)}; exit \${PIPESTATUS[0]}`,
        ],
        { stdio: "inherit", env: process.env }
      );
    } catch (e) {
      flingFailure = e;
      console.log(
        "::error::fling harness exited non-zero (arm-round collapse) — see bench-log-FLING.txt"
      );
    }
    // Always run the merge (report-only, exits 0) so the artifact carries the
    // self-test verdict + raw distributions even on a partial run.
    try {
      execFileSync(
        "bash",
        ["-c", `node ${JSON.stringify(mergeFling)} 2>&1 | tee -a ${JSON.stringify(flingLog)}`],
        {
          stdio: "inherit",
          env: process.env,
        }
      );
    } catch (e) {
      console.log(`[run-bench] fling merge failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // A genuine arm-round collapse must fail the step loudly (a broken run must not
    // look like a clean instrument result).
    if (flingFailure) throw flingFailure;
  }
  setContext(`block ${process.env.BENCH_ONLY}`);
})();

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
require(
  require("node:path").resolve(
    process.cwd(),
    "packages/tool-server/scripts/bench-open-vs-proprietary.ts"
  )
);
