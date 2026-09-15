// ts-node loader for the optical fling harness (ticket 3o). Run from the repo root
// so the flag file + .bench-results resolve there. The harness runs every arm
// (OFF / input-manager / uiautomation / uia-A / uia-B) round-robin in ONE process
// (each arm gets a fresh registry — the touch backend flag is read once at factory
// time), so unlike the latency bench there is no per-block orchestration here.
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
