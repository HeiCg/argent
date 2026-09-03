// ts-node loader for the latency bench (mirrors the p3f run-bench.js). Run from
// the repo root so the flag file + .bench-results resolve there. BENCH_ONLY
// selects a single block; the merge assembles the per-block files afterwards.
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
