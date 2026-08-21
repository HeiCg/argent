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
import * as os from "node:os";
import type { Registry, ToolCapability } from "@argent/registry";
import { DEBUGGER_NOT_CONNECTED_REASONS } from "@argent/telemetry";
import { createRestartAppTool } from "../src/tools/restart-app";
import { debuggerInspectElementTool } from "../src/tools/debugger/debugger-inspect-element";
import { debuggerReloadMetroTool } from "../src/tools/debugger/debugger-reload-metro";
import { debuggerComponentTreeTool } from "../src/tools/debugger/debugger-component-tree";
import { createDebuggerStatusTool } from "../src/tools/debugger/debugger-status";
import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { listDevicesTool } from "../src/tools/devices/list-devices";
import { pinsOnce, pinsUnqualified } from "./helpers/pins";
import {
  CHROMIUM_WORDS,
  PLATFORM_WORDS,
  expectTagEndsTheClaim,
  platformTag,
} from "./helpers/platform-tag";
import { getCandidateChromiumPorts } from "../src/utils/chromium-discovery";

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

/** The probe set with the env list and the persisted file out of the way. */
function defaultChromiumPorts(): number[] {
  const prevList = process.env.ARGENT_CHROMIUM_PORTS;
  const prevFile = process.env.ARGENT_CHROMIUM_PORTS_FILE;
  delete process.env.ARGENT_CHROMIUM_PORTS;
  process.env.ARGENT_CHROMIUM_PORTS_FILE = path.join(os.tmpdir(), "argent-absent-ports.json");
  try {
    return getCandidateChromiumPorts();
  } finally {
    if (prevList === undefined) delete process.env.ARGENT_CHROMIUM_PORTS;
    else process.env.ARGENT_CHROMIUM_PORTS = prevList;
    if (prevFile === undefined) delete process.env.ARGENT_CHROMIUM_PORTS_FILE;
    else process.env.ARGENT_CHROMIUM_PORTS_FILE = prevFile;
  }
}

describe("argent-metro-debugger platform tags match the capability objects", () => {
  it("tags restart-app with the platforms it actually supports, in both tables", () => {
    // The closing paren ends the tag, so a platform added inside it fails exactly
    // as one dropped does. Outside it is out of reach - and deliberately so here,
    // since both rows go on to name Chromium as the platform restart-app refuses.
    // Both copies are derived: the Reload & recovery row delegates Chromium readers
    // to the Quick Reference one, which carries its own tag.
    for (const label of ["`restart-app`", "Relaunch app on device"]) {
      expectTagEndsTheClaim(row(DEBUGGER_SKILL, label), platformTag(restartApp), label);
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
      expectTagEndsTheClaim(quick, tag, tool.id);
      // Neither comparison reaches past the tag it reads: proseTag takes the first
      // platform run it finds, so "on iOS / Android (…), and on any CDP browser"
      // satisfies it. These rows are RN-only end to end, in both tables, so naming
      // a Chromium runtime is barred outright - under any of the words for one,
      // since a single-word check reads "browser" as unrelated prose.
      for (const [where, cell] of [
        ["prose", prose],
        ["quick reference", quick],
      ] as const) {
        expect(cell, `${tool.id} (${where})`).not.toMatch(CHROMIUM_WORDS);
      }
    }
  });
});

describe("the Chromium recovery names a relaunch that exists", () => {
  it("restart-app declares no chromium support, so every surface routes around it", () => {
    expect(restartApp?.chromium).toBeUndefined();

    // Every surface that states the recovery, against every fact it rests on. A
    // fact held on one surface and not its twin is the shape these drift in, so
    // they are checked as a cross product rather than one assertion each. Markdown
    // backticks the identifiers and a tool description cannot, and a clause that
    // opens a sentence on one surface sits mid-sentence on another, so match on
    // text with the backticks stripped and the case folded.
    const norm = (text: string | undefined) => (text ?? "").replace(/`/g, "").toLowerCase();
    const deviceInteract = readFileSync(DEVICE_INTERACT_SKILL, "utf8");
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

    // A fact flagged `carveable` is one whose needle ends where an exception
    // would be attached ("not supported on chromium" -> "... except for an app you
    // booted yourself"), which a containment check cannot see.
    const facts: [string, string, [string, string | undefined][], boolean?][] = [
      // The tool is offered on these surfaces, so the refusal is what the reader
      // needs first; everything else is advice they only reach after it.
      ["restart-app is refused", "not supported on chromium", listsRestartApp, true],
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
        `list-devices only probes ${defaultChromiumPorts().join(", ")}, argent_chromium_ports and the ports boot-device opened`,
        statesRecovery,
      ],
      // The escape from the one state discovery cannot show. The clause above
      // enumerates the probe set and stops there on its own, which is the dead end
      // a user who relaunched on any other port lands in - and these surfaces are
      // read without a debugger-status guidance in hand.
      [
        "the id drives without discovery",
        "if the user names the port, use chromium-cdp-<that port> directly",
        statesRecovery,
      ],
      // The precondition on the whole sequence, in the three claims it rests on.
      // These surfaces are read without the guidance - restart-app's description is
      // alwaysLoad and the device-interact table is open for tap/describe work - so
      // a flat quit-then-relaunch here is what asks the user to quit a healthy app.
      // The guard and its evidence are separate needles because a needle covering
      // only the evidence is satisfied by a sentence that inverts the guard.
      [
        "the relaunch needs a gone app",
        "only when the app is gone: a failure naming page targets means it is still up",
        listsRestartApp,
      ],
      // Which detail proves a squatted port, tied to the prefix only the discovery
      // request produces. Without that anchor the claim reads onto the raw ws
      // message a live app's closed page produces ("Unexpected server response:
      // 500") and sends a healthy id to the relaunch.
      [
        "a squatted port is not a live app",
        "a detail naming chromium cdp discovery: get confirms the exit when it says could " +
          "not connect, and when it names a status or a bad body means the port answered as " +
          "something that is not a cdp endpoint",
        listsRestartApp,
      ],
      // And the class that names neither prefix, which is the one the ws layer
      // produces after discovery has already answered.
      [
        "a socket-level detail is not a dead port",
        "is the cdp socket failing after discovery answered, so the app was up moments ago",
        listsRestartApp,
      ],
      // Through the imperative. The claim without it is satisfied by "so the app
      // was up moments ago: relaunch it once" - the duplicate boot this arm exists
      // to prevent, on the one class where the app is provably alive.
      [
        "and its remedy is the user, not a relaunch",
        "so the app was up moments ago: have the user check it",
        listsRestartApp,
      ],
      // And why the port matters for one half of the recovery only: bootElectronApp
      // takes its own free port unless electronPort pins one, so gating the Electron
      // remedy on the old port being free strands a reader whose port was taken.
      [
        "only the browser needs that port back",
        "an electron relaunch takes a fresh port, a browser needs one nothing else holds",
        listsRestartApp,
      ],
    ];
    for (const [what, needle, surfaces, carveable] of facts) {
      const pin = carveable ? pinsUnqualified : pinsOnce;
      for (const [where, text] of surfaces) pin(norm(text), needle, `${where} (${what})`);
    }

    // Same split as the App-unreachable row, in the surface a flow author reads:
    // "no reachable CDP session" covers the live-but-windowless case too, where a
    // relaunch is the wrong remedy.
    const createFlow = row(CREATE_FLOW_RECOVERY, "Chromium");
    pinsOnce(createFlow, "the failure names page targets, none at all or only devtools:// ones");
    pinsOnce(createFlow, "ask for one back, since a relaunch recovers nothing there");
    // Its third and fourth states. Without arms of their own they fall into the
    // row's "Otherwise", which is the quit-and-relaunch the guidance routes both
    // away from - and this row is a flow author's only copy of the split.
    pinsOnce(
      createFlow,
      "the port answered with something that is not a CDP endpoint, usually another service " +
        "holding it, which no relaunch on that port clears"
    );
    pinsOnce(
      createFlow,
      "A `detail` naming neither — a WebSocket error, a closed connection — is the CDP socket " +
        "failing after discovery answered, so the app was up moments ago: have the user check " +
        "it before anything else."
    );
    // The row's opening diagnosis, which decides which arm a reader looks at.
    pinsOnce(createFlow, "Still up with no window — the failure names page targets");

    // The Reload & recovery row fences restart-app off and delegates rather than
    // restating the recovery, so the pointer is the only thing carrying it - and
    // it is the Chromium reader it exists to redirect, since that table's
    // restart-app row is tagged for the three platforms that are not Chromium.
    pinsOnce(row(DEBUGGER_SKILL, "`restart-app`"), "On Chromium see the Quick Reference row");

    // Two rows above the restart-app carve-out, so a Chromium reader refused there
    // reads this one next. Its handler is a no-op that returns launched: true, and
    // the guidance fences it by name - an unqualified "Always" here contradicts both.
    pinsUnqualified(
      row(DEVICE_INTERACT_SKILL, "Open an app"),
      "on Chromium it confirms the running renderer and starts nothing"
    );
    // The shared-surface summary a Chromium reader meets before any table.
    // gesture-swipe declares no chromium and the gate rejects it there, so the
    // verb in this list has to be the one that works.
    pinsOnce(deviceInteract, "describe/tap/scroll/keyboard/screenshot surface drives all of them.");

    // cdp_unreachable is not only the dead-app code: CHROMIUM_CDP_NO_PAGE_TARGET
    // maps to it too and fires while the process is alive, where a relaunch adds a
    // second copy rather than recovering. The row has to separate the two, or it
    // sends the live case to the wrong remedy. Which detail carries the window hint
    // is pinned against the throw sites in debugger/not-connected-map.test.ts.
    const unreachable = row(FAILURE_SCENARIOS, "**App unreachable**");
    pinsOnce(unreachable, "second copy");
    pinsOnce(unreachable, "or exposed no page to drive");
    // The row's third state, the one its create-flow twin already branched on.
    // Without an arm of its own it falls into the crashed-or-exited pointer below,
    // which is the relaunch the guidance routes it away from.
    pinsOnce(
      unreachable,
      "A `detail` naming `Chromium CDP discovery: GET` with a status or a body that is not " +
        "JSON is neither of those: the port answered with something that is not a CDP endpoint"
    );
    // And its own remedy, rather than the neighbouring one: "second copy" and
    // "bring a window back" answer a live app, which a squatted port is not. The
    // row states three states in one cell, so position is what keeps each remedy
    // with the state it answers.
    pinsOnce(unreachable, "`boot-device` with `electronAppPath` takes a free port");
    expect(
      unreachable.indexOf("the port answered with something that is not a CDP endpoint"),
      "the squatted-port state must follow the window remedy it would otherwise borrow"
    ).toBeGreaterThan(unreachable.indexOf("Ask the user to bring a window back instead."));
    // Why restart-app is not the answer here. The conclusion without the mechanism
    // reads as a preference.
    pinsOnce(
      row(FAILURE_SCENARIOS, "**Was connected, then tool fails**"),
      "the capability gate rejects it"
    );
    // The remedy for a squatted port on the flow-authoring surface. The diagnosis
    // without it leaves a flow author with nothing to do about the state.
    pinsOnce(
      createFlow,
      "`boot-device` with `electronAppPath` takes a free one and returns the new id"
    );
    // list-devices is where the recovery sends the reader to check, and its own
    // description documents absence for every other platform - so on Chromium the
    // silence reads as an exit unless it says otherwise.
    pinsOnce(
      listDevicesTool.description,
      "A missing Chromium entry does not mean the app exited: a probe needs a drivable page, " +
        "so an app that is up with no window is dropped exactly as an exited one is."
    );
    // Section 1 is where a tap/describe agent arrives, and the only Chromium
    // instruction it reads: on an absent entry the obvious move is to boot, which
    // for a windowless-but-live app is the duplicate the row forbids. Claim and
    // mechanism in one needle - the claim alone reads as a caution to ignore.
    pinsOnce(
      deviceInteract,
      "An absent Chromium entry is not proof nothing is running: `list-devices` drops an app " +
        "that is up with no drivable page exactly as it drops an exited one"
    );
    // And its remedy. Section 1 pointed at the Restart-an-app row, whose leading
    // instruction is the quit - the wrong half for an app that is merely windowless.
    pinsOnce(
      deviceInteract,
      "If the app is up with no window, have the user reopen one — that is the whole recovery."
    );
    // The same probe set this file states a second time, in the prose a reader
    // meets before any table. Derived, like every other copy.
    pinsOnce(
      deviceInteract,
      "on port `" +
        defaultChromiumPorts().join("`, `") +
        "`, anything in `ARGENT_CHROMIUM_PORTS`, and the ports `boot-device` opened"
    );
    // Which of the two relaunch outcomes carries the early exit. A second copy
    // BOOTS (boot-electron resolves { booted: true }), so attaching the exit to
    // both leaves a reader who got a clean result concluding no copy was made.
    pinsOnce(
      unreachable,
      "a second copy — which boots successfully, so nothing in the result says you now have " +
        "two — or, behind a single-instance lock, a failed boot, reaching you as `child " +
        "process exited with code N before CDP was ready`"
    );
    pinsOnce(
      unreachable,
      "`boot-device` pipes the child's stderr to the tool-server's own and keeps none of it"
    );
    pinsOnce(unreachable, "is in the server log, not in the result");
    // Of the seven codes behind cdp_unreachable only CHROMIUM_CDP_NO_PAGE_TARGET
    // proves the app alive, and only its devtools:// half names the window, so
    // both the narrowing and the remedy it points to are pinned. "devtools://"
    // alone is not: the row says it twice.
    pinsOnce(unreachable, "none at all, or only devtools:// ones");
    pinsOnce(unreachable, "since the endpoint answered to say so");
    pinsOnce(unreachable, "and the app itself may well be gone");
    pinsOnce(unreachable, "Only the devtools:// variant names the window");
    pinsOnce(unreachable, "Ask the user to bring a window back instead.");
    // The imperative itself. Naming the consequences and the alternative leaves
    // the instruction free to invert: "relaunch there once, at worst you get a
    // second copy" satisfies every pin above and sends the live case to the one
    // action this row exists to forbid.
    pinsOnce(unreachable, "Do not relaunch there: that recovers nothing");
    // The dead-app half of this reason is not restated here; the pointer is all
    // that carries it.
    pinsOnce(
      unreachable,
      "lands here and recovers the same way as **Was connected, then tool fails**"
    );
    pinsOnce(unreachable, "`launch-app`, which cannot start a Chromium app");

    // The two sibling descriptions the recovery leans on. list-devices is where
    // the id is re-read, so a reader who cannot see a booted app there concludes
    // it must set the env var; and boot-device's `force` is the one parameter that
    // reads as the stop every surface above denies.
    // Derived, like the guidance's copy: a restated literal drifts off the probe
    // set and the env-var name with nothing red.
    for (const port of defaultChromiumPorts()) pinsOnce(listDevicesTool.description, String(port));
    pinsOnce(listDevicesTool.description, "ARGENT_CHROMIUM_PORTS=<comma-separated-ports>");
    pinsOnce(listDevicesTool.description, "the ports boot-device itself opened");
    // Through to the end of the sentence: the clause after the carve-out is where
    // the contradiction would go, and it re-asserts the behaviour #867 files.
    pinsUnqualified(
      bootDeviceParams.shape.force?.description,
      "Ignored on Chromium: boot-device only ever starts an Electron app, so a running one is " +
        "left alone and the new one lands beside it, fails on its single-instance lock, or — with " +
        "electronPort pinned to a port that app already holds — comes up unable to bind it, " +
        "leaving the id you get back pointed at the old app."
    );
    // Nothing may follow it either: the sentence is the last in the description,
    // and anything appended re-opens the flag it just closed.
    expect(bootDeviceParams.shape.force?.description?.trimEnd()).toMatch(
      /pointed at the old app\.$/
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
    // The one instruction attached to that list. Without it the reasons read as a
    // taxonomy, and the reason most likely to be retry-looped waits out a full CDP
    // timeout per attempt.
    pinsOnce(debuggerStatusTool.description, "Follow the guidance field — do not retry in a loop.");
  });
});
