/**
 * The skill's prose claims things only code knows — which platforms a tool
 * supports, which not-connected reasons it can report — so a capability or
 * reason change falsifies it silently. Derive every expectation below from the
 * source of truth; restating one as a literal reintroduces the same drift.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { Registry, ToolCapability } from "@argent/registry";
import { DEBUGGER_NOT_CONNECTED_REASONS } from "@argent/telemetry";
import { createRestartAppTool } from "../src/tools/restart-app";
import { RN_ONLY_TOOL_CAPABILITY } from "../src/tools/debugger/debugger-service-ref";

const SKILLS = path.resolve(__dirname, "../../skills/skills");
const DEBUGGER_SKILL = path.join(SKILLS, "argent-metro-debugger/SKILL.md");
const FAILURE_SCENARIOS = path.join(
  SKILLS,
  "argent-metro-debugger/references/failure-scenarios.md"
);
const DEVICE_INTERACT_SKILL = path.join(SKILLS, "argent-device-interact/SKILL.md");

const restartApp = createRestartAppTool({} as unknown as Registry).capability;

/** The skill's platform vocabulary, in the order its tables list it. */
const PLATFORM_WORDS = [
  ["apple", "iOS"],
  ["android", "Android"],
  ["vega", "Vega"],
] as const satisfies readonly (readonly [keyof ToolCapability, string])[];

/**
 * The platform tag a row should carry — read off the support flags, not key
 * presence: `apple: {}` is a declared key supporting no Apple device, and a tag
 * built from it would document support the capability gate rejects.
 */
function platformTag(capability: ToolCapability | undefined): string {
  return PLATFORM_WORDS.filter(([key]) => {
    const matrix = capability?.[key];
    return matrix !== undefined && Object.values(matrix).some(Boolean);
  })
    .map(([, word]) => word)
    .join(" / ");
}

/**
 * The single table row whose first cell starts with `label`. The uniqueness
 * assertion is what names a renamed row — without it the failure surfaces as a
 * `toContain` against undefined, naming neither the row nor the file.
 */
function row(file: string, label: string): string {
  const matches = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.startsWith(`| ${label}`));
  expect(matches, `expected exactly one "${label}" row in ${file}`).toHaveLength(1);
  return matches[0]!;
}

describe("argent-metro-debugger platform tags match the capability objects", () => {
  it("tags restart-app with the platforms it actually supports", () => {
    // The paren anchors the whole tag, so prose wider than the capability fails
    // as loudly as prose that is narrower.
    expect(row(DEBUGGER_SKILL, "`restart-app`")).toContain(`(${platformTag(restartApp)})`);
  });

  it("tags debugger-reload-metro as the narrower tool it is", () => {
    // Left untagged beside a tagged restart-app, the row reads as the
    // platform-agnostic one of the pair.
    expect(RN_ONLY_TOOL_CAPABILITY.vega).toBeUndefined();
    expect(RN_ONLY_TOOL_CAPABILITY.chromium).toBeUndefined();

    const tag = platformTag(RN_ONLY_TOOL_CAPABILITY);
    expect(row(DEBUGGER_SKILL, "`debugger-reload-metro`")).toContain(`on ${tag} (`);
  });
});

describe("the Chromium recovery names a relaunch that exists", () => {
  it("restart-app declares no chromium support, so every surface routes around it", () => {
    // A chromium key here would make all three carve-outs below wrong in the
    // opposite direction.
    expect(restartApp?.chromium).toBeUndefined();

    // Offering restart-app to a reader who may be on Chromium obliges each
    // surface to name the relaunch that works, not merely fence restart-app off.
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

  it("answers every not-connected reason the debugger can report", () => {
    // The skill tells the agent to match debugger-status's coded `reason`
    // against this table, so a reason with no row is a reader with no recovery.
    const table = readFileSync(FAILURE_SCENARIOS, "utf8");
    const skill = readFileSync(DEBUGGER_SKILL, "utf8");
    for (const reason of DEBUGGER_NOT_CONNECTED_REASONS) {
      expect(skill, `${reason} is missing from SKILL.md's reason list`).toContain(`\`${reason}\``);
      expect(table, `${reason} has no row in failure-scenarios.md`).toContain(reason);
    }
  });
});
