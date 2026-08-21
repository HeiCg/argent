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
import { debuggerInspectElementTool } from "../src/tools/debugger/debugger-inspect-element";
import { debuggerReloadMetroTool } from "../src/tools/debugger/debugger-reload-metro";
import { debuggerComponentTreeTool } from "../src/tools/debugger/debugger-component-tree";

const SKILLS = path.resolve(__dirname, "../../skills/skills");
const DEBUGGER_SKILL = path.join(SKILLS, "argent-metro-debugger/SKILL.md");
const FAILURE_SCENARIOS = path.join(
  SKILLS,
  "argent-metro-debugger/references/failure-scenarios.md"
);
const DEVICE_INTERACT_SKILL = path.join(SKILLS, "argent-device-interact/SKILL.md");

const restartAppTool = createRestartAppTool({} as unknown as Registry);
const restartApp = restartAppTool.capability;

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

/** The platform list a prose row states, e.g. "… on iOS / Android (like …" -> "iOS / Android". */
function proseTag(cell: string): string {
  const words = PLATFORM_WORDS.map(([, word]) => word).join("|");
  const match = new RegExp(` on ((?:${words})(?: / (?:${words}))*)`).exec(cell);
  return match?.[1] ?? "";
}

describe("argent-metro-debugger platform tags match the capability objects", () => {
  it("tags restart-app with the platforms it actually supports", () => {
    // The paren anchors the whole tag, so prose wider than the capability fails
    // as loudly as prose that is narrower.
    expect(row(DEBUGGER_SKILL, "`restart-app`")).toContain(`(${platformTag(restartApp)})`);
  });

  it("tags every RN-only row, in each of the three tables that list one", () => {
    // A bare row beside tagged siblings reads as the platform-agnostic one of
    // the set, so a tag is only worth having where every RN-only row carries it.
    // Each tool is listed twice: once in a Tool-and-Purpose table, which states
    // the tag in the Purpose prose, and once in the Action-and-Tool Quick
    // Reference, which appends it to the Tool cell.
    const rnOnlyRows = [
      [debuggerReloadMetroTool, "`debugger-reload-metro`", "Reload JS"],
      [debuggerComponentTreeTool, "`debugger-component-tree`", "Full component tree"],
      [debuggerInspectElementTool, "`debugger-inspect-element`", "Inspect component at point"],
    ] as const;

    for (const [tool, proseLabel, quickLabel] of rnOnlyRows) {
      // platformTag has no word for chromium, so a tool gaining Chromium support
      // would keep its tag; that is the drift the tag itself cannot catch.
      expect(tool.capability?.chromium, tool.id).toBeUndefined();

      const tag = platformTag(tool.capability);
      expect(proseTag(row(DEBUGGER_SKILL, proseLabel)), tool.id).toBe(tag);
      expect(row(DEBUGGER_SKILL, quickLabel), tool.id).toContain(`(${tag})`);
    }
  });
});

describe("the Chromium recovery names a relaunch that exists", () => {
  it("restart-app declares no chromium support, so every surface routes around it", () => {
    // A chromium key here would make all three carve-outs below wrong in the
    // opposite direction.
    expect(restartApp?.chromium).toBeUndefined();

    // The tool description reaches an agent that has loaded no skill at all, so
    // it is the surface most likely to be the only one read.
    expect(restartAppTool.description).toContain("Not supported on Chromium");
    expect(restartAppTool.description).toContain("electronAppPath");
    expect(restartAppTool.description).toContain("ask the user");
    expect(restartAppTool.description).toContain("chromium-cdp-<port>");
    expect(restartAppTool.description).toContain("list-devices");
    expect(restartAppTool.description).toContain("quit");

    // Offering restart-app to a reader who may be on Chromium obliges each
    // surface to name the relaunch that works, not merely fence restart-app off.
    // The flag marks the surfaces reached while the app is still running:
    // boot-device cannot end it, so those have to say how it exits. The
    // failure-scenarios row is scoped to an app that already crashed or closed,
    // where there is nothing left to quit.
    const surfaces: [string, string, boolean][] = [
      [DEBUGGER_SKILL, "Relaunch app on device", true],
      [FAILURE_SCENARIOS, "**Was connected, then tool fails**", false],
      [DEVICE_INTERACT_SKILL, "Restart an app", true],
    ];
    for (const [file, label, stillRunning] of surfaces) {
      const cell = row(file, label);
      expect(cell, file).toContain("Chromium");
      expect(cell, file).toContain("`boot-device` with `electronAppPath`");
      // The id is derived from the port, so a relaunch can move it, and the
      // browser half is the user's to perform. A surface naming neither the
      // actor nor where to re-read the id leaves the reader unable to finish.
      expect(cell, file).toContain("ask the user");
      expect(cell, file).toContain("`list-devices`");
      if (stillRunning) expect(cell, file).toContain("quit");
    }

    // The Reload & recovery row fences restart-app off and delegates rather than
    // restating the recovery, so the pointer is the only thing carrying it.
    expect(row(DEBUGGER_SKILL, "`restart-app`")).toContain("Quick Reference");

    // cdp_unreachable is not only the dead-app code: CHROMIUM_CDP_NO_PAGE_TARGET
    // maps to it too and fires while the process is alive with its window hidden,
    // where a relaunch starts a second copy rather than recovering. The row has to
    // separate the two, or it sends the live case to the wrong remedy.
    expect(row(FAILURE_SCENARIOS, "**App unreachable**")).toContain("hidden or closed");
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
