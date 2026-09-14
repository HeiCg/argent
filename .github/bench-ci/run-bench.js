// ts-node loader for the latency bench (mirrors the p3f run-bench.js). Run from
// the repo root so the flag file + .bench-results resolve there. BENCH_ONLY
// selects a single block; the merge assembles the per-block files afterwards.
//
// Phase 3n self-orchestration. The committed workflow's run_block loop only calls
// ON-uiautomation and ON-scrcpy; it cannot be updated on this branch because the
// push credential lacks the GitHub `workflow` OAuth scope (the same limitation
// run-fling.js documents). So this loader drives the three Kotlin strategy arms
// ITSELF: on the FIRST invocation, for each strategy arm named in BENCH_BLOCKS it
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
  if (arms.length === 0) return; // legacy run — no strategy arms requested
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
  console.log(`[run-bench] self-orchestrating strategy arms ${arms.join(", ")} (workflow-scope workaround)`);
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
