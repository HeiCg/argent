/**
 * The skill's prose claims things only code knows — which platforms a tool
 * supports, which not-connected reasons it can report — so a capability or
 * reason change falsifies it silently. Derive every expectation below from the
 * source of truth; restating one as a literal reintroduces the same drift. The
 * recovery wording below is the exception with no source to derive from: it is
 * matched literally, and its facts are pinned against the code that produces
 * them in debugger/not-connected-map.test.ts.
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
import { createDebuggerStatusTool } from "../src/tools/debugger/debugger-status";
import { pinsOnce } from "./helpers/pins";

const SKILLS = path.resolve(__dirname, "../../skills/skills");
const DEBUGGER_SKILL = path.join(SKILLS, "argent-metro-debugger/SKILL.md");
const FAILURE_SCENARIOS = path.join(
  SKILLS,
  "argent-metro-debugger/references/failure-scenarios.md"
);
const DEVICE_INTERACT_SKILL = path.join(SKILLS, "argent-device-interact/SKILL.md");
const CREATE_FLOW_RECOVERY = path.join(
  SKILLS,
  "argent-create-flow/references/reliability-and-recovery.md"
);

const restartAppTool = createRestartAppTool({} as unknown as Registry);
const debuggerStatusTool = createDebuggerStatusTool({} as unknown as Registry);
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

/**
 * The platform list a prose row states, e.g. "… on iOS / Android (like …" ->
 * "iOS / Android". Chromium is in the vocabulary here but not in PLATFORM_WORDS:
 * platformTag has no word for it, so a row claiming Chromium has to land inside
 * the captured tag to fail the comparison rather than be trimmed off it.
 */
function proseTag(cell: string): string {
  const words = [...PLATFORM_WORDS.map(([, word]) => word), "Chromium"].join("|");
  const match = new RegExp(` on ((?:${words})(?: / (?:${words}))*)`).exec(cell);
  return match?.[1] ?? "";
}

describe("argent-metro-debugger platform tags match the capability objects", () => {
  it("tags restart-app with the platforms it actually supports, in both tables", () => {
    // The paren anchors the whole tag, so prose wider than the capability fails
    // as loudly as prose that is narrower. Both copies are derived: the Reload &
    // recovery row delegates Chromium readers to the Quick Reference one, which
    // carries its own tag.
    for (const label of ["`restart-app`", "Relaunch app on device"]) {
      expect(row(DEBUGGER_SKILL, label), label).toContain(`(${platformTag(restartApp)})`);
    }
    // platformTag has no word for appleRemote, so the tags cannot show it moving.
    // The description promises an Apple TV slice refresh, which only runs where
    // the capability reaches an Apple TV.
    expect(restartAppTool.description).toContain("Apple TV");
    expect(restartApp?.appleRemote).toBeDefined();
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
    expect(restartApp?.chromium).toBeUndefined();

    expect(restartAppTool.description).toContain("Not supported on Chromium");
    expect(restartAppTool.description).toContain("electronAppPath");
    // Pin the browser half specifically: a bare "ask the user" is already
    // satisfied by the quit step, so it would survive dropping the actor here.
    expect(restartAppTool.description).toContain("ask the user to start the browser again");
    expect(restartAppTool.description).toContain("chromium-cdp-<port>");
    expect(restartAppTool.description).toContain("list-devices");

    const rows: [string, string][] = [
      [DEBUGGER_SKILL, "Relaunch app on device"],
      [FAILURE_SCENARIOS, "**Was connected, then tool fails**"],
      [DEVICE_INTERACT_SKILL, "Restart an app"],
    ];
    for (const [file, label] of rows) {
      const cell = row(file, label);
      expect(cell, file).toContain("Chromium");
    }

    // Every surface that states the recovery. boot-device stops nothing, so the
    // exit is the user's to cause and the relaunch has to wait for it; a surface
    // keeping the sequence but dropping the actor leaves the reader waiting on
    // nobody, and one keeping the actor but dropping the sequence sends them to
    // relaunch into a single-instance lock. Both halves are pinned, on all of them.
    const spelledOut: [string, string | undefined][] = [
      ...rows.map(([file, label]): [string, string] => [file, row(file, label)]),
      ["restart-app's description", restartAppTool.description],
      [CREATE_FLOW_RECOVERY, row(CREATE_FLOW_RECOVERY, "Chromium")],
    ];
    for (const [where, text] of spelledOut) {
      pinsOnce(text, "the user to quit it", where);
      pinsOnce(text, "once it has exited", where);
    }

    // The id re-read is one sentence on every surface that spells it out;
    // both runtime guidance strings state it too and are pinned against
    // buildNotConnected in debugger/not-connected-map.test.ts. It carries the
    // token (list-devices reports a Chromium entry under `id`, and ChromiumDevice
    // has no udid field, so naming it anything else sends the reader after a key
    // that is not in the response), both places it can be read, and the one
    // condition that moves it. Markdown backticks the identifiers and a tool
    // description cannot, so match with them stripped.
    const unticked = (text: string | undefined) => (text ?? "").replace(/`/g, "");
    for (const [where, text] of spelledOut) {
      pinsOnce(unticked(text), "chromium-cdp-<port> id from boot-device / list-devices", where);
      pinsOnce(unticked(text), "a relaunch on a new port is a new id", where);
      // Both branches. An Electron app does not come back by restarting a browser,
      // and a browser restarted without the flag exposes no CDP, so a surface
      // carrying one of them strands whoever is on the other. Each cell says "ask
      // the user" more than once, so pin the occurrence that carries the step.
      pinsOnce(unticked(text), "boot-device with electronAppPath", where);
      pinsOnce(unticked(text), "ask the user to start the browser again", where);
      pinsOnce(unticked(text), "--remote-debugging-port", where);
    }

    // The Reload & recovery row fences restart-app off and delegates rather than
    // restating the recovery, so the pointer is the only thing carrying it.
    expect(row(DEBUGGER_SKILL, "`restart-app`")).toContain("Quick Reference");

    // cdp_unreachable is not only the dead-app code: CHROMIUM_CDP_NO_PAGE_TARGET
    // maps to it too and fires while the process is alive, where a relaunch adds a
    // second copy rather than recovering. The row has to separate the two, or it
    // sends the live case to the wrong remedy. Which detail carries the window hint
    // is pinned against the throw sites in debugger/not-connected-map.test.ts.
    // Naming list-devices as the id source without this reads as an invitation to
    // poll it for the exit, which it cannot answer - it drops a live-but-windowless
    // app exactly as it drops an exited one. Both guidance strings carry the same
    // guard, pinned in debugger/not-connected-map.test.ts.
    pinsOnce(
      row(FAILURE_SCENARIOS, "**Was connected, then tool fails**"),
      "cannot tell you whether it exited"
    );

    const unreachable = row(FAILURE_SCENARIOS, "**App unreachable**");
    pinsOnce(unreachable, "second copy");
    // Both lock shapes: Electron's newcomer exits 0 with no reason given, Chrome
    // refuses outright and names the lock. A reader matching only Electron's
    // shape against Chrome's refusal concludes it hit something else.
    pinsOnce(unreachable, "bare early exit");
    pinsOnce(unreachable, "SingletonLock");
    // Of the seven codes behind cdp_unreachable only CHROMIUM_CDP_NO_PAGE_TARGET
    // proves the app alive, and only its devtools:// half names the window, so
    // both the narrowing and the remedy it points to are pinned. "devtools://"
    // alone is not: the row says it twice.
    pinsOnce(unreachable, "variant names the window");
    pinsOnce(unreachable, "Ask the user to bring a window back");
    // The imperative itself. Naming the consequences and the alternative leaves
    // the instruction free to invert: "relaunch there once, at worst you get a
    // second copy" satisfies every pin above and sends the live case to the one
    // action this row exists to forbid.
    pinsOnce(unreachable, "Do not relaunch there");
    // The dead-app half of this reason is not restated here; the pointer is all
    // that carries it.
    pinsOnce(unreachable, "**Was connected, then tool fails**");
  });

  it("answers every not-connected reason the debugger can report", () => {
    // The skill tells the agent to match debugger-status's coded `reason`
    // against this table, so a reason with no row is a reader with no recovery.
    const table = readFileSync(FAILURE_SCENARIOS, "utf8");
    const skill = readFileSync(DEBUGGER_SKILL, "utf8");
    for (const reason of DEBUGGER_NOT_CONNECTED_REASONS) {
      expect(skill, `${reason} is missing from SKILL.md's reason list`).toContain(`\`${reason}\``);
      expect(table, `${reason} is missing from failure-scenarios.md`).toContain(reason);
      expect(
        debuggerStatusTool.description,
        `${reason} is missing from debugger-status's description`
      ).toContain(reason);
    }
    // cdp_unreachable covers three unlike states and the reason name says none of
    // them; the Chromium one is the reason the recovery had to split.
    expect(debuggerStatusTool.description).toContain("is up with no drivable page");
  });
});
