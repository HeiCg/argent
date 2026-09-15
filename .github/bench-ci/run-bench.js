// ts-node loader for the latency bench (mirrors the p3f run-bench.js). Run from
// the repo root so the flag file + .bench-results resolve there. BENCH_ONLY
// selects a single block; the merge assembles the per-block files afterwards.
//
// Phase 3n self-orchestration. The workflow's run_block loop drives the OFF baselines
// and ON-uiautomation directly; the Kotlin injection-STRATEGY arms (ON-uia-sync /
// ON-uia-async / ON-input-manager) are self-orchestrated here so a dispatch can add a
// strategy arm via the `blocks` input without a workflow edit. On the FIRST invocation,
// for each strategy arm named in BENCH_BLOCKS this loader
// spawns an isolated child `node run-bench.js` with BENCH_ONLY=<arm> (per-block
// process isolation preserved — the memory-frugal design), gated by a lock so the
// workflow's later block calls don't re-run them. A dispatch whose `blocks` input
// includes ON-uia-sync / ON-uia-async / ON-input-manager therefore runs those arms
// with NO workflow edit; the OFF baselines and the merge stay with the workflow.
(function orchestrateStrategyArms() {
  if (process.env.ARGENT_BENCH_NO_ORCHESTRATE === "1") return; // a spawned child
  const fs = require("node:fs");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const STRATEGY_ARMS = ["ON-uia-sync", "ON-uia-async", "ON-input-manager"];
  const requested = (process.env.BENCH_BLOCKS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const arms = STRATEGY_ARMS.filter((a) => requested.includes(a));
  // Ticket 3o: the fling job cannot be added to the workflow YAML (no `workflow` OAuth
  // scope to push it), so the optical fling harness self-orchestrates here too — a
  // `FLING` token in the `blocks` input runs `run-fling.js` + `merge-fling.js` once,
  // inside the latency job's already-booted emulator (animations off, proprietary
  // fetched for the OFF arm). Same lock as the strategy arms, so it runs exactly once.
  const wantFling = requested.includes("FLING");
  if (arms.length === 0 && !wantFling) return; // legacy run — nothing to self-orchestrate
  const OUT = process.env.BENCH_OUT || path.join(process.cwd(), ".bench-results");
  const LOCK = path.join(OUT, ".bench-strategy-arms.lock");
  try {
    fs.mkdirSync(OUT, { recursive: true });
  } catch {
    /* best effort */
  }
  if (fs.existsSync(LOCK)) return; // another invocation already ran the arms
  fs.writeFileSync(LOCK, `strategy arms claimed ${new Date().toISOString()} by BENCH_ONLY=${process.env.BENCH_ONLY}\n`);
  const serial = process.env.BENCH_SERIAL || "emulator-5554";
  // eslint-disable-next-line no-console
  console.log(
    `[run-bench] self-orchestrating ${[...arms, ...(wantFling ? ["FLING"] : [])].join(", ") || "(nothing)"} (workflow-scope workaround)`
  );
  for (const arm of arms) {
    // eslint-disable-next-line no-console
    console.log(`########## BLOCK ${arm} (self-orchestrated) ##########`);
    // Readiness gate before each arm (best-effort, mirrors the workflow's per-block
    // ready-gate; a bad screen still trips the child's own effect gate).
    try {
      execFileSync("bash", [path.join(".github", "bench-ci", "ready-gate.sh"), serial, "3", "60", "1"], {
        stdio: "inherit",
      });
    } catch {
      // eslint-disable-next-line no-console
      console.log(`[run-bench] ready-gate warned before ${arm} — proceeding (the child effect gate is authoritative)`);
    }
    // Isolated child process: one block, memory-frugal, cannot re-orchestrate. Tee the
    // child's output to bench-log-<arm>.txt (3N-M5) — staged in the artifact — AND the
    // job log, so a self-orchestrated arm's warnings are reviewable from the zip.
    const logPath = path.join(OUT, `bench-log-${arm}.txt`);
    execFileSync(
      "bash",
      ["-c", `ARGENT_BENCH_NO_ORCHESTRATE=1 BENCH_ONLY=${arm} node ${JSON.stringify(__filename)} 2>&1 | tee -a ${JSON.stringify(logPath)}; exit \${PIPESTATUS[0]}`],
      { stdio: "inherit", env: process.env }
    );
  }
  if (wantFling) {
    // eslint-disable-next-line no-console
    console.log("########## FLING (self-orchestrated, ticket 3o — optical, report-only) ##########");
    const runFling = path.join(__dirname, "run-fling.js");
    const mergeFling = path.join(__dirname, "merge-fling.js");
    const flingLog = path.join(OUT, "bench-log-FLING.txt");
    // Drop the OFF arm if the proprietary binary cannot exec on this runner (the
    // documented Linux downgrade) — the merge then reports arm/off as NO-OFF instead
    // of the harness dying on a proprietary swipe that never runs.
    const offEnv = process.env.PROP_EXECUTABLE === "1" ? "" : "FLING_INCLUDE_OFF=0 ";
    try {
      execFileSync("bash", [path.join(".github", "bench-ci", "ready-gate.sh"), serial, "3", "90", "0"], { stdio: "inherit" });
    } catch {
      /* best effort — the harness resets Settings per sample anyway */
    }
    let flingFailure = null;
    try {
      execFileSync(
        "bash",
        ["-c", `${offEnv}node ${JSON.stringify(runFling)} 2>&1 | tee -a ${JSON.stringify(flingLog)}; exit \${PIPESTATUS[0]}`],
        { stdio: "inherit", env: process.env }
      );
    } catch (e) {
      flingFailure = e;
      // eslint-disable-next-line no-console
      console.log("::error::fling harness exited non-zero (arm-round collapse) — see bench-log-FLING.txt");
    }
    // Always run the merge (report-only, exits 0) so the artifact carries the
    // self-test verdict + raw distributions even on a partial run.
    try {
      execFileSync("bash", ["-c", `node ${JSON.stringify(mergeFling)} 2>&1 | tee -a ${JSON.stringify(flingLog)}`], {
        stdio: "inherit",
        env: process.env,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`[run-bench] fling merge failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // A genuine arm-round collapse must fail the step loudly (a broken run must not
    // look like a clean instrument result).
    if (flingFailure) throw flingFailure;
  }
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
require(require("node:path").resolve(process.cwd(), "packages/tool-server/scripts/bench-open-vs-proprietary.ts"));
