// Local runner for the screen-graph bench (moved out of the repo root, phase D.4).
// The package's composite tsconfig rejects files under scripts/, so register
// ts-node with skipProject. Run from anywhere: `node packages/tool-server/scripts/run-bench-sg.cjs`.
// CI does not use this file; it inlines the same loader (see bench-open-vs-proprietary.yml).
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
require(require("node:path").resolve(__dirname, "bench-screen-graph.ts"));
