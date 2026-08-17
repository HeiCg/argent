import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getScreenshotScale } from "../src/utils/simulator-client";

const SKILLS_DIR = path.join(__dirname, "../../skills/skills");

// Assigning 1.0 (or 1) to `scale`, in the spellings the skills actually use —
// JSON, a fenced pseudo-call, backticked prose, "a `scale` of 1.0", "set
// `scale` to 1.0", a bare "`scale` 1.0" — plus the spellings that name no
// parameter at all, which already ship in two of these files. Those are matched
// as vocabulary rather than as an imperative, because the claim arrives just as
// often as an assertion about what already happens ("baselines are captured at
// full resolution") as it does as an instruction, and an inflected verb is not
// a weaker prescription than a bare one.
//
// A range mention ("`scale` accepts values from 0.01 to 1.0") is not a claim
// about a capture and deliberately does not match; the leading boundary keeps
// `grayscale = 1` and `upscale: 1` out. "native resolution" is deliberately
// absent: argent-screen-recording uses it correctly for h264 frames, which do
// not go through this parameter at all.
const REACHES_FOR_FULL_RES =
  /full[- ](?:resolution|res\b)|\bunscaled\b|100% scale|\b1:1\b|\bscale["'`]?\s*(?:[:=]|\s+(?:of|to)\s+)?\s*1(?:\.0+)?\b/i;

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
// skill that sends an agent at a full-resolution capture without naming that
// failure sends it at a call it cannot recover from. The claim is spread across
// skills and keeps being copied into new ones, so pin the pairing rather than
// any one file's wording.
describe("skill docs reaching for a full-resolution screenshot", () => {
  const reaching = docs.filter(({ text }) => REACHES_FOR_FULL_RES.test(text));

  it("finds some, so the per-file check below cannot pass vacuously", () => {
    expect(reaching.length).toBeGreaterThan(0);
  });

  it.each(reaching)("$name names the emulators that reject it", ({ text }) => {
    expect(text).toContain("wrong data size");
  });

  // Carrying the caveat somewhere in the file says nothing about a line added
  // later, and the claim these files get wrong arrives as an extra sentence
  // rather than an edit to an existing one. So count them: a new line reaching
  // for this vocabulary has to be checked against captureLiveInput and
  // writeDiffArtifacts, and updating the count here is where that happens.
  it("holds the size claims to the lines that were checked against the code", () => {
    const perFile = Object.fromEntries(
      reaching.map(({ name, text }) => [
        name,
        text.split("\n").filter((line) => REACHES_FOR_FULL_RES.test(line)).length,
      ])
    );
    expect(perFile).toEqual({
      "argent-device-interact/SKILL.md": 4,
      "argent-screenshot-diff/SKILL.md": 3,
      "argent-test-ui-flow/SKILL.md": 3,
    });
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
    const quote = text.split("\n").find((line) => line.includes("of original resolution"))!;
    expect(quote).toContain(`${getScreenshotScale() * 100}% of original resolution`);
    // …and the same paragraph says which platforms that is the default for.
    // Chromium passes no scale of its own, so an unqualified claim is false
    // there, which is how this line read before. Scoped to the line, since
    // these files name Chromium in a dozen unrelated places.
    expect(quote).toContain("Chromium");
  });
});
