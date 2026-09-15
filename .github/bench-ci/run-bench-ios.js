// ts-node loader for the iOS latency bench (mirrors run-bench.js). Run from the
// repo root so the flag file + .bench-results resolve there. BENCH_ONLY selects a
// single block; merge-blocks-ios.js assembles the per-block files afterwards.
//
// Unlike the Android loader there are no self-orchestrated strategy arms: the iOS
// blocks (OFF-1, ON-xcuitest, ON-siminput, OFF-2) are driven one-per-invocation by
// the workflow's run_block loop.
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
    "packages/tool-server/scripts/bench-ios-open-vs-proprietary.ts"
  )
);
