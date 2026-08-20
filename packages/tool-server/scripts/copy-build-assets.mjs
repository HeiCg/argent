#!/usr/bin/env node
// Copy the non-TypeScript files `tsc` leaves behind into dist/, preserving their
// path inside the package.
//
// Every one of these is resolved at runtime through `path.join(__dirname, ...)`
// from the module that sits next to it, so the destination has to mirror the
// source layout exactly.
//
// The workspace `build` script runs this, which is what keeps it from being
// forgotten: `packages/tool-server/dist` is booted as a real tool server by
// CI, and a dist without these files fails every flow `script` step at
// flow-execute time.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Source paths, relative to the package root. Each is copied to dist/<same path minus src/>. */
const ASSETS = [
  // Instruments template for iOS native profiling.
  "src/utils/ios-profiler/Argent.tracetemplate",
  // The flow `script` child process and its two watchdog threads. They import
  // nothing from this package, so `tsc` never sees them.
  "src/tools/flows/script/flow-script-runner.mjs",
  "src/tools/flows/script/flow-script-watchdog-lifeline.mjs",
  "src/tools/flows/script/flow-script-watchdog-deadline.mjs",
];

for (const asset of ASSETS) {
  const from = path.join(packageRoot, asset);
  const to = path.join(packageRoot, "dist", path.relative("src", asset));
  if (!fs.existsSync(from)) {
    throw new Error(`Build asset missing: ${from}`);
  }
  fs.cpSync(from, to);
}

console.log(`Copied ${ASSETS.length} build assets into dist/`);
