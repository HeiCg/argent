// ts-node loader for the iOS-4 sim-input discriminating test (mirrors
// run-bench-ios.js). Run from the repo root so the flag file + .bench-results
// resolve there. ON-siminput only, no OFF arms — a SHORT job that characterises
// the sim-input landing failure (recogniser timing vs delivery recipe).
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
    "packages/tool-server/scripts/bench-ios-siminput-discriminating.ts"
  )
);
