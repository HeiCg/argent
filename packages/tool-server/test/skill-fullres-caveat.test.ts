import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getScreenshotScale } from "../src/utils/simulator-client";

const SKILLS_DIR = path.join(__dirname, "../../skills/skills");

// Assigning 1.0 (or 1) to `scale`, in the spellings the skills actually use:
// JSON, a fenced pseudo-call, backticked prose, or "a `scale` of 1.0". A range
// mention ("`scale` accepts values from 0.01 to 1.0") is not a prescription and
// deliberately does not match.
const PRESCRIBES_FULL_RES = /scale["'`]?\s*(?:[:=]|\s+of\s+)\s*1(?:\.0+)?\b/;

function markdownUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? markdownUnder(path.join(dir, entry.name))
        : entry.name.endsWith(".md")
          ? [path.join(dir, entry.name)]
          : []
    );
}

const docs = fs
  .readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => markdownUnder(path.join(SKILLS_DIR, entry.name)))
  .map((file) => ({ name: path.relative(SKILLS_DIR, file), text: fs.readFileSync(file, "utf8") }));

// `screenshot` passes `scale` straight through and simulator-client turns the
// emulator's in-band rejection into a hard SIMULATOR_SCREENSHOT_FAILED, so a
// skill that prescribes a full-resolution capture without naming that failure
// sends an agent at a call it cannot recover from. The prescription is spread
// across skills and keeps being copied into new ones, so pin the pairing rather
// than any one file's wording.
describe("skill docs prescribing a full-resolution screenshot", () => {
  const prescribing = docs.filter(({ text }) => PRESCRIBES_FULL_RES.test(text));

  it("finds some, so the per-file check below cannot pass vacuously", () => {
    expect(prescribing.length).toBeGreaterThan(0);
  });

  it.each(prescribing)("$name names the emulators that reject it", ({ text }) => {
    expect(text).toContain("wrong data size");
  });
});

describe("skill docs quoting the tool-server's screenshot scale", () => {
  // Spelled as a percentage in prose ("30% of original resolution") rather than
  // as the 0.3 the tool descriptions quote, so it drifts out of reach of the
  // cross-surface check in screenshot-diff-tool.test.ts.
  const quoting = docs.filter(({ text }) => text.includes("of original resolution"));

  it("finds some, so the per-file check below cannot pass vacuously", () => {
    expect(quoting.length).toBeGreaterThan(0);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(quoting)("$name quotes the scale getScreenshotScale falls back to", ({ text }) => {
    // Markdown ships as a static file, so it can only ever quote the default —
    // read the ambient env instead and the assertion fails on correct prose for
    // every developer who exports the var these same docs tell them about.
    vi.stubEnv("ARGENT_SCREENSHOT_SCALE", "");
    expect(text).toContain(`${getScreenshotScale() * 100}% of original resolution`);
  });
});
