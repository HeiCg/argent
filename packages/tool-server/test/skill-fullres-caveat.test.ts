import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const SKILLS_DIR = path.join(__dirname, "../../skills/skills");

// `screenshot` passes `scale` straight through and simulator-client turns the
// emulator's in-band rejection into a hard SIMULATOR_SCREENSHOT_FAILED, so a
// skill that prescribes a full-resolution capture without naming that failure
// sends an agent at a call it cannot recover from. The prescription is spread
// across skills and keeps being copied into new ones, so pin the pairing rather
// than any one file's wording.
describe("skills prescribing a full-resolution screenshot", () => {
  const prescribing = fs
    .readdirSync(SKILLS_DIR)
    .map((name) => ({ name, file: path.join(SKILLS_DIR, name, "SKILL.md") }))
    .filter(({ file }) => fs.existsSync(file))
    .map((skill) => ({ ...skill, text: fs.readFileSync(skill.file, "utf8") }))
    .filter(({ text }) => /scale["']?[:=]?\s*1\.0/.test(text));

  it("is a non-empty set, so the check below cannot pass vacuously", () => {
    expect(prescribing.map((s) => s.name).sort()).toEqual([
      "argent-device-interact",
      "argent-screenshot-diff",
      "argent-test-ui-flow",
    ]);
  });

  it.each(prescribing)("$name names the emulators that reject it", ({ text }) => {
    expect(text).toContain("wrong data size");
  });
});
