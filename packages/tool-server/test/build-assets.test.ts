import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const COPY_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "copy-build-assets.mjs");

/**
 * The files `tsc` leaves behind, and the one build step that puts them in
 * `dist/`.
 *
 * Nothing asserted this. `flow-script-protocol.test.ts` hand-copies the three
 * `.mjs` files into a temporary directory, so it stays green with the copy
 * script deleted, and the CI `test -f` guards only the published bundle, which
 * copies from `src`. A `dist/` missing any of these boots as a tool server that
 * fails every flow `script` step, and `windows-e2e.yml` and the Vega E2E script
 * both boot exactly that `dist/`.
 */
const ASSETS = [
  "utils/ios-profiler/Argent.tracetemplate",
  "tools/flows/script/flow-script-runner.mjs",
  "tools/flows/script/flow-script-watchdog-lifeline.mjs",
  "tools/flows/script/flow-script-watchdog-deadline.mjs",
];

describe("tool-server build assets", () => {
  it("copies every non-TypeScript runtime file into dist, byte for byte", () => {
    // Run rather than assume: a suite that only checked an existing `dist/`
    // would pass on whatever the last build left there, including a build that
    // predates a file being added to the list. `cpSync` creates parents, so
    // this works on a tree that has never been built.
    execFileSync(process.execPath, [COPY_SCRIPT], { stdio: "pipe" });

    for (const asset of ASSETS) {
      const source = path.join(PACKAGE_ROOT, "src", asset);
      const copied = path.join(PACKAGE_ROOT, "dist", asset);
      expect(fs.existsSync(copied), `${asset} is missing from dist/`).toBe(true);
      expect(fs.readFileSync(copied)).toEqual(fs.readFileSync(source));
    }
  });

  it("refuses to finish when a listed asset is not there", () => {
    // The list is hand-maintained against four other places, so the failure
    // mode that matters is a rename. It has to stop the build rather than
    // produce a dist that is quietly short a file.
    const listed = fs
      .readFileSync(COPY_SCRIPT, "utf8")
      .match(/"src\/[^"]+"/g)
      ?.map((quoted) => quoted.slice(1, -1));

    expect(listed).toBeDefined();
    for (const asset of listed ?? []) {
      expect(fs.existsSync(path.join(PACKAGE_ROOT, asset)), `${asset} is listed but absent`).toBe(
        true
      );
    }
    expect(listed?.map((asset) => path.relative("src", asset)).sort()).toEqual([...ASSETS].sort());
  });
});
