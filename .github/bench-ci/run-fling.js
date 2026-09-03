// ts-node loader for the fling-fidelity A/B (mirrors the p3f run-fling.js).
// FLING_CONFIG selects one config (ON-uiautomation | ON-scrcpy | OFF); the merge
// assembles the per-config files afterwards.
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
require("./packages/tool-server/scripts/bench-fling-fidelity.ts");
