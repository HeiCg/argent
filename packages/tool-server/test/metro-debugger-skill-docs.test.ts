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
import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { listDevicesTool } from "../src/tools/devices/list-devices";
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
const bootDeviceParams = createBootDeviceTool({} as unknown as Registry).zodSchema as unknown as {
  shape: Record<string, { description?: string }>;
};
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
    // The closing paren ends the tag, so a platform added inside it fails exactly
    // as one dropped does. Outside it is out of reach - and deliberately so here,
    // since both rows go on to name Chromium as the platform restart-app refuses.
    // Both copies are derived: the Reload & recovery row delegates Chromium readers
    // to the Quick Reference one, which carries its own tag.
    for (const label of ["`restart-app`", "Relaunch app on device"]) {
      expect(row(DEBUGGER_SKILL, label), label).toContain(`(${platformTag(restartApp)})`);
    }
    // appleRemote is deliberately absent from PLATFORM_WORDS: it is remote-iOS
    // over sim-remote (registry types.ts), which these rows fold into "iOS"
    // rather than naming, so there is no prose claim for a tag to track.
    expect(restartApp?.appleRemote).toBeDefined();
    // The guard the tags rest on. Every capability in these tables has a populated
    // matrix, so nothing above tells `apple: {}` - support the gate rejects - from
    // real iOS support.
    expect(platformTag({ apple: {} } as ToolCapability), "empty matrix is not support").toBe("");
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
      const prose = row(DEBUGGER_SKILL, proseLabel);
      const quick = row(DEBUGGER_SKILL, quickLabel);
      expect(proseTag(prose), tool.id).toBe(tag);
      expect(quick, tool.id).toContain(`(${tag})`);
      // Neither comparison reaches past the tag it reads: proseTag takes the first
      // platform run it finds, and the Quick Reference paren is a substring, so
      // "on iOS / Android, and on Chromium" satisfies both. These rows are RN-only
      // end to end, in both tables, so the claim is barred outright.
      for (const [where, cell] of [
        ["prose", prose],
        ["quick reference", quick],
      ] as const) {
        expect(cell, `${tool.id} (${where})`).not.toMatch(/Chromium/);
      }
    }
  });
});

describe("the Chromium recovery names a relaunch that exists", () => {
  it("restart-app declares no chromium support, so every surface routes around it", () => {
    expect(restartApp?.chromium).toBeUndefined();

    // Every surface that states the recovery, against every fact it rests on. A
    // fact held on one surface and not its twin is how each of these drifted, so
    // they are checked as a matrix rather than one assertion per fix. Markdown
    // backticks the identifiers and a tool description cannot, and a clause that
    // opens a sentence on one surface sits mid-sentence on another, so match on
    // text with the backticks stripped and the case folded.
    const norm = (text: string | undefined) => (text ?? "").replace(/`/g, "").toLowerCase();
    const listsRestartApp: [string, string | undefined][] = [
      [DEBUGGER_SKILL, row(DEBUGGER_SKILL, "Relaunch app on device")],
      [FAILURE_SCENARIOS, row(FAILURE_SCENARIOS, "**Was connected, then tool fails**")],
      [DEVICE_INTERACT_SKILL, row(DEVICE_INTERACT_SKILL, "Restart an app")],
      ["restart-app's description", restartAppTool.description],
    ];
    // The create-flow row is keyed by platform rather than by tool, so it never
    // offers restart-app - but it prescribes the same recovery.
    const statesRecovery: [string, string | undefined][] = [
      ...listsRestartApp,
      [CREATE_FLOW_RECOVERY, row(CREATE_FLOW_RECOVERY, "Chromium")],
    ];

    const facts: [string, string, [string, string | undefined][]][] = [
      // The tool is offered on these surfaces, so the refusal is what the reader
      // needs first; everything else is advice they only reach after it.
      ["restart-app is refused", "not supported on chromium", listsRestartApp],
      // Why the recovery is manual at all.
      ["boot-device cannot stop it", "only starts an app and never stops one", listsRestartApp],
      // One contiguous clause, not two substrings that happen to both be present:
      // a relaunch-first rewrite keeps both halves and still orders a relaunch
      // into a running app.
      [
        "the quit comes first",
        "the user to quit it, then relaunch once it has exited",
        statesRecovery,
      ],
      // Both branches. An Electron app does not come back by restarting a browser,
      // and a browser restarted without the flag exposes no CDP, so a surface
      // carrying one of them strands whoever is on the other.
      ["the Electron branch", "boot-device with electronapppath for electron", statesRecovery],
      ["the browser branch", "ask the user to start the browser again", statesRecovery],
      ["the flag that exposes CDP", "--remote-debugging-port", statesRecovery],
      ["which port it returns on", "on the same cdp port", statesRecovery],
      // list-devices reports a Chromium entry under `id` and ChromiumDevice has no
      // udid field, so naming it anything else sends the reader after a key that
      // is not in the response.
      [
        "where the id is re-read",
        "chromium-cdp-<port> id from boot-device / list-devices",
        statesRecovery,
      ],
      ["when the id changes", "a relaunch on a new port is a new id", statesRecovery],
      // "once it has exited" is the one step with no instrument, and list-devices
      // is named two clauses later - it drops a live-but-windowless app exactly as
      // it drops an exited one, so polling it for the exit relaunches into a
      // running app.
      ["the exit cannot be read off list-devices", "cannot confirm the exit", statesRecovery],
      // Where the new id can be read back at all. Without it the clause above
      // reads as an invitation to relaunch anywhere and look it up.
      [
        "which ports are probed",
        "list-devices only probes 9222, argent_chromium_ports and the ports boot-device opened",
        statesRecovery,
      ],
      // The precondition on the whole sequence. These surfaces are read without
      // the guidance in hand - restart-app's description is alwaysLoad and the
      // device-interact table is open for tap/describe work - so a flat
      // quit-then-relaunch here is what asks the user to quit a healthy app.
      [
        "the relaunch is for a gone app only",
        "only for an app that is actually gone",
        listsRestartApp,
      ],
    ];
    for (const [what, needle, surfaces] of facts) {
      for (const [where, text] of surfaces) pinsOnce(norm(text), needle, `${where} (${what})`);
    }

    // Same split as the App-unreachable row, in the surface a flow author reads:
    // "no reachable CDP session" covers the live-but-windowless case too, where a
    // relaunch is the wrong remedy.
    const createFlow = row(CREATE_FLOW_RECOVERY, "Chromium");
    pinsOnce(createFlow, "the failure names page targets, none at all or only devtools:// ones");
    pinsOnce(createFlow, "ask for one back, since a relaunch recovers nothing there");
    // Its third state: the guidance routes a non-CDP reply away from a relaunch,
    // and this row's "Otherwise" swallowed it into the quit-and-relaunch.
    pinsOnce(createFlow, "something else holds the port, which no relaunch on that port clears");

    // The Reload & recovery row fences restart-app off and delegates rather than
    // restating the recovery, so the pointer is the only thing carrying it - and
    // it is the Chromium reader it exists to redirect, since that table's
    // restart-app row is tagged for the three platforms that are not Chromium.
    pinsOnce(row(DEBUGGER_SKILL, "`restart-app`"), "On Chromium see the Quick Reference row");

    // The shared-surface summary a Chromium reader meets before any table.
    // gesture-swipe declares no chromium and the gate rejects it there, so the
    // verb in this list has to be the one that works.
    pinsOnce(
      readFileSync(DEVICE_INTERACT_SKILL, "utf8"),
      "describe/tap/scroll/keyboard/screenshot"
    );

    // cdp_unreachable is not only the dead-app code: CHROMIUM_CDP_NO_PAGE_TARGET
    // maps to it too and fires while the process is alive, where a relaunch adds a
    // second copy rather than recovering. The row has to separate the two, or it
    // sends the live case to the wrong remedy. Which detail carries the window hint
    // is pinned against the throw sites in debugger/not-connected-map.test.ts.
    const unreachable = row(FAILURE_SCENARIOS, "**App unreachable**");
    pinsOnce(unreachable, "second copy");
    // Both lock shapes: Electron's newcomer exits 0 with no reason given, Chrome
    // refuses outright and names the lock. A reader matching only Electron's
    // shape against Chrome's refusal concludes it hit something else.
    pinsOnce(unreachable, "bare early exit for Electron");
    pinsOnce(unreachable, "SingletonLock: File exists` for Chrome");
    // Of the seven codes behind cdp_unreachable only CHROMIUM_CDP_NO_PAGE_TARGET
    // proves the app alive, and only its devtools:// half names the window, so
    // both the narrowing and the remedy it points to are pinned. "devtools://"
    // alone is not: the row says it twice.
    pinsOnce(unreachable, "none at all, or only devtools:// ones");
    pinsOnce(unreachable, "Only the devtools:// variant names the window");
    pinsOnce(unreachable, "Ask the user to bring a window back");
    // The imperative itself. Naming the consequences and the alternative leaves
    // the instruction free to invert: "relaunch there once, at worst you get a
    // second copy" satisfies every pin above and sends the live case to the one
    // action this row exists to forbid.
    pinsOnce(unreachable, "Do not relaunch there");
    // The dead-app half of this reason is not restated here; the pointer is all
    // that carries it.
    pinsOnce(unreachable, "**Was connected, then tool fails**");
    pinsOnce(unreachable, "`launch-app`, which cannot start a Chromium app");

    // The two sibling descriptions the recovery leans on. list-devices is where
    // the id is re-read, so a reader who cannot see a booted app there concludes
    // it must set the env var; and boot-device's own `force` promised the stop
    // every surface above denies.
    pinsOnce(listDevicesTool.description, "the ports boot-device itself opened");
    expect(bootDeviceParams.shape.force?.description).toContain(
      "Ignored on Chromium: boot-device only ever starts an Electron app"
    );
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
    expect(debuggerStatusTool.description).toContain("(Chromium) is up with no drivable page");
  });
});
