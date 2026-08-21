/**
 * The argent-metro-debugger skill tells an agent which platforms `restart-app`
 * and `debugger-reload-metro` cover, and what to reach for on Chromium instead.
 * Those are claims about capability objects the prose cannot see, so a
 * capability change silently falsifies them — which is how the Chromium
 * recovery came to name a tool the capability gate rejects. Pin both halves:
 * the capability, and the sentence that depends on it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRestartAppTool } from "../src/tools/restart-app";
import { RN_ONLY_TOOL_CAPABILITY } from "../src/tools/debugger/debugger-service-ref";

const SKILLS = path.resolve(__dirname, "../../skills/skills");
const DEBUGGER_SKILL = path.join(SKILLS, "argent-metro-debugger/SKILL.md");
const FAILURE_SCENARIOS = path.join(
  SKILLS,
  "argent-metro-debugger/references/failure-scenarios.md"
);
const DEVICE_INTERACT_SKILL = path.join(SKILLS, "argent-device-interact/SKILL.md");

const restartAppCapability = createRestartAppTool({
  resolveService: async () => ({}),
} as unknown as Registry).capability;

/**
 * The single table row whose first cell starts with `label`. Asserting
 * uniqueness matters more than finding it: a renamed row would otherwise make
 * every `toContain` below vacuous against an empty string.
 */
function row(file: string, label: string): string {
  const matches = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.startsWith(`| ${label}`));
  expect(matches, `expected exactly one "${label}" row in ${file}`).toHaveLength(1);
  return matches[0]!;
}

describe("argent-metro-debugger platform tags match the capability objects", () => {
  it("tags restart-app with the platforms it actually declares", () => {
    expect(restartAppCapability?.apple).toBeDefined();
    expect(restartAppCapability?.android).toBeDefined();
    expect(restartAppCapability?.vega).toBeDefined();

    expect(row(DEBUGGER_SKILL, "`restart-app`")).toContain("(iOS / Android / Vega)");
  });

  it("tags debugger-reload-metro as the narrower tool it is", () => {
    // Narrower than restart-app: no vega key, no chromium key. Untagged beside a
    // tagged restart-app, the row reads as the platform-agnostic one.
    expect(RN_ONLY_TOOL_CAPABILITY.vega).toBeUndefined();
    expect(RN_ONLY_TOOL_CAPABILITY.chromium).toBeUndefined();

    expect(row(DEBUGGER_SKILL, "`debugger-reload-metro`")).toContain("on iOS / Android");
  });
});

describe("the Chromium recovery names a relaunch that exists", () => {
  it("restart-app declares no chromium support, so every surface routes around it", () => {
    // The claim the recovery rests on. A chromium key here would make all three
    // carve-outs below wrong in the opposite direction.
    expect(restartAppCapability?.chromium).toBeUndefined();

    // Each surface that lists restart-app for a reader who may be on Chromium
    // must name the relaunch that does work, not just fence restart-app off.
    const surfaces: [string, string][] = [
      [DEBUGGER_SKILL, "Relaunch app on device"],
      [FAILURE_SCENARIOS, "**Was connected, then tool fails**"],
      [DEVICE_INTERACT_SKILL, "Restart an app"],
    ];
    for (const [file, label] of surfaces) {
      const cell = row(file, label);
      expect(cell, file).toContain("Chromium");
      expect(cell, file).toContain("`boot-device` with `electronAppPath`");
    }
  });

  it("keeps a row for the reason a dead Chromium app actually reports", () => {
    // `debugger-status` on a crashed Chromium app returns reason
    // "cdp_unreachable" — the one reason SKILL.md lists that the table used to
    // have no row for, so a reader matching on `reason` fell through it.
    expect(row(FAILURE_SCENARIOS, "**App unreachable**")).toContain("cdp_unreachable");
    expect(readFileSync(DEBUGGER_SKILL, "utf8")).toContain("`cdp_unreachable`");
  });
});
