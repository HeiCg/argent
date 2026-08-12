import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// `await-ui-element` evaluates against the agent-facing describe tree; the
// `await:`/`assert:` directive that polish converts the step into is evaluated
// against `fetchFlowTree`'s. On no platform does one contain the other, so a
// check can pass live and fail once converted — which makes "each step is
// executed live so you verify it works before it's recorded" untrue exactly
// where it matters.
//
// These tests serve the RUNNER's tree (what `fetchFlowTree` returns) while the
// await-ui-element tool is stubbed to report success, i.e. the recorder's tree
// agreed. Every runner tree here is built by the REAL per-platform flow adapter
// from a raw payload of that platform's own shape, so the divergence each test
// describes is the one that platform's projection actually produces — not a
// platform label pinned on one shared fixture.

let fetchCount: number;
// The whole fetch is the seam, not just the tree it yields: a test that needs
// the read itself to hang (rather than to throw or to return) replaces this.
// Reset in beforeEach so no test leaks its implementation into the next.
let fetchRunnerTree: () => Promise<DescribeTreeData>;
// Forces `probeWhenCondition` to REJECT for the one test whose subject is that
// arm. Every other test leaves it undefined and runs the real poll loop.
let probeRejection: Error | undefined;
vi.mock("../../src/tools/flows/flow-actions", async () => {
  const actual = await vi.importActual<typeof import("../../src/tools/flows/flow-actions")>(
    "../../src/tools/flows/flow-actions"
  );
  return {
    ...actual,
    probeWhenCondition: (...args: Parameters<typeof actual.probeWhenCondition>) =>
      probeRejection ? Promise.reject(probeRejection) : actual.probeWhenCondition(...args),
  };
});

vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn((): Promise<DescribeTreeData> => {
    fetchCount += 1;
    return fetchRunnerTree();
  }),
}));

import { createAwaitUiElementTool, evaluateMatches } from "../../src/tools/await-ui-element";
import { assertSupported } from "../../src/utils/capability";
import { resolveDevice } from "../../src/utils/device-info";
import { findAll, type Selector } from "../../src/utils/ui-tree-match";
import { adaptFullHierarchyToDescribeResult } from "../../src/tools/flows/flow-ios-tree";
import { adaptFullAndroidHierarchyToDescribeResult } from "../../src/tools/flows/flow-android-tree";
import { parseUiAutomatorDump } from "../../src/tools/describe/platforms/android/uiautomator-parser";
import { adaptChromiumTreeForFlows } from "../../src/tools/flows/flow-chromium-tree";
import { adaptVegaTreeForFlows } from "../../src/tools/flows/flow-vega-tree";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowFinishRecordingTool } from "../../src/tools/flows/flow-finish-recording";
import { flowInsertEchoTool } from "../../src/tools/flows/flow-insert-echo";
import {
  __resetRecordingsForTesting,
  parseFlow,
  serializeFlow,
} from "../../src/tools/flows/flow-utils";
import { n } from "./harness";

const IOS = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const ANDROID = "emulator-5554"; // adb-serial shape → classifies android
const CHROMIUM = "chromium-cdp-9222"; // chromium-cdp- prefix → classifies chromium
const VEGA = "amazon-4a27df03c9777152"; // amazon- prefix → classifies vega

const FULL: DescribeNode["frame"] = { x: 0, y: 0, width: 1, height: 1 };
const ROW: DescribeNode["frame"] = { x: 0.1, y: 0.1, width: 0.5, height: 0.05 };

let tmpDir: string;

// ── Runner trees, each through its own platform's real flow adapter ──────────

const IOS_SCREEN = { x: 0, y: 0, width: 390, height: 844 };
const IOS_ROW = { x: 0, y: 100, width: 390, height: 40 };

interface RawIosView {
  className?: string;
  label?: string;
  identifier?: string;
  alpha?: number;
  hidden?: boolean;
  frame?: typeof IOS_ROW;
  windowFrame?: typeof IOS_ROW;
  children?: RawIosView[];
}

/** `ViewHierarchy.getFullHierarchy`'s payload shape, through the iOS adapter. */
function iosRunnerTree(views: RawIosView[]): DescribeNode {
  return adaptFullHierarchyToDescribeResult({
    windows: [
      {
        className: "UIWindow",
        frame: IOS_SCREEN,
        windowFrame: IOS_SCREEN,
        children: views,
      },
    ],
  });
}

function iosLabel(label: string, extra: Partial<RawIosView> = {}): RawIosView {
  return {
    className: "UILabel",
    label,
    frame: IOS_ROW,
    windowFrame: IOS_ROW,
    children: [],
    ...extra,
  };
}

const ANDROID_W = 1080;
const ANDROID_H = 1920;

/**
 * One `android-devtools` getHierarchy dump. Both Android sides read THIS —
 * `describe`'s default path and the flow tree are two parses of the same XML,
 * so an Android divergence has to be demonstrated on identical input or it is
 * not a divergence at all.
 */
function androidDump(rows: string): string {
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    ${rows}
  </node>
</hierarchy>`;
}

/** That dump through the Android FLOW adapter — what the runner resolves. */
function androidRunnerTree(rows: string): DescribeNode {
  return adaptFullAndroidHierarchyToDescribeResult(androidDump(rows), ANDROID_W, ANDROID_H);
}

/** The same dump through the TRIM — what `await-ui-element` read live. */
function androidRecorderTree(rows: string): DescribeNode {
  return parseUiAutomatorDump(androidDump(rows), ANDROID_W, ANDROID_H);
}

/** The CDP DOM walker's own `DescribeNode` output, through the Chromium adapter. */
function chromiumRunnerTree(children: DescribeNode[]): DescribeNode {
  return adaptChromiumTreeForFlows(n({ role: "html", frame: FULL, children }));
}

/** The Vega toolkit's parsed page source, through the Vega adapter. */
function vegaRunnerTree(children: DescribeNode[]): DescribeNode {
  return adaptVegaTreeForFlows(n({ role: "Screen", frame: FULL, children }));
}

// ── Recording harness ────────────────────────────────────────────────────────

/** A registry whose `await-ui-element` always reports the condition met. */
function registryWhereWaitSucceeds(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "await-ui-element") return { success: true, elapsed: 120 };
      if (id === "gesture-tap") return { tapped: true };
      throw new Error(`Tool "${id}" not found`);
    }),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

/**
 * A registry whose `await-ui-element` reports the condition NEVER held — the
 * `{ success: false }` shape the tool returns instead of throwing.
 */
function registryWhereWaitTimesOut(): Registry {
  return registryWhereWaitFails("no element matched the selector");
}

/**
 * A registry whose `await-ui-element` returns `{ success: false }` carrying
 * `note`, and optionally the `cause` the real tool decides in its poll loop.
 *
 * Without `cause` this is the LEGACY shape — a result that crossed a boundary
 * before the field existed — where the recorder has only the note to read. With
 * it, the note may say anything: on `visible`/`exists`/`text` a wholly blind
 * window produces prose byte-identical to a genuine miss, which is the whole
 * reason the cause is carried on the result rather than parsed back out.
 */
function registryWhereWaitFails(note: string, extra: { cause?: string } = {}): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "await-ui-element") return { success: false, elapsed: 1500, note, ...extra };
      throw new Error(`Tool "${id}" not found`);
    }),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

type WaitArgs = {
  udid?: string;
  condition: "visible" | "hidden" | "exists" | "text";
  selector: Record<string, unknown>;
  expectedText?: string;
  textMatch?: "contains" | "equals";
};

async function startRecording(name: string): Promise<void> {
  await flowStartRecordingTool.execute(
    {},
    { name, project_root: tmpDir, executionPrerequisite: "on the form" }
  );
}

/**
 * Start a recording in "client" (remote) mode — the arm where the in-memory
 * flow is authoritative and this host never owns the file. `flow-start-recording`
 * picks the mode from the `project_root` file probe: a root that is NOT present
 * on this host means the caller is remote.
 */
async function startRemoteRecording(name: string): Promise<void> {
  await flowStartRecordingTool.execute(
    {},
    { name, project_root: tmpDir, executionPrerequisite: "on the form" },
    { fileInputs: { project_root: { presentOnHost: false } } } as never
  );
}

async function recordWait(
  name: string,
  wait: WaitArgs,
  opts: { registry?: Registry; delayMs?: number; signal?: AbortSignal } = {}
) {
  const tool = createFlowAddStepTool(opts.registry ?? registryWhereWaitSucceeds());
  return tool.execute(
    {},
    {
      name,
      project_root: tmpDir,
      command: "await-ui-element",
      args: JSON.stringify({ udid: IOS, ...wait }),
      delayMs: opts.delayMs,
    },
    (opts.signal ? { signal: opts.signal } : undefined) as never
  );
}

async function recordedSteps(name: string) {
  const yaml = await fs.readFile(path.join(tmpDir, ".argent", "flows", `${name}.yaml`), "utf8");
  return parseFlow(yaml).steps;
}

/**
 * The probe's own reason, as the determinate warning quotes it back — the only
 * part of the message carrying screen content, and so the only part the cap
 * governs. Asserting on the whole warning instead measures the fixed prose
 * around it, which moves whenever the explanation is reworded.
 */
function echoedReasonOf(warning: string): string {
  const open = "directives against (";
  const close = "). As the raw";
  const start = warning.indexOf(open);
  const end = warning.indexOf(close);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return warning.slice(start + open.length, end);
}

/**
 * The warning half of `message`, or undefined when there is none.
 *
 * Asserting `message` contains "Step added" proves nothing — that is the
 * unconditional prefix of EVERY message, warnings included — so a regression
 * that nags on every correctly-recorded wait would sail through. Split the
 * prefix off and require the remainder to be absent instead.
 */
function warningOf(result: { message: string }, name: string): string | undefined {
  const prefix = `Step added to "${name}" flow`;
  expect(result.message.startsWith(prefix)).toBe(true);
  const rest = result.message.slice(prefix.length);
  return rest === "" ? undefined : rest.replace(/^ — /, "");
}

/**
 * The verdicts a finished `summary` carries, keyed by the step number each one
 * follows.
 *
 * A verdict is its own ARRAY ELEMENT, indented under its step: the finish has
 * no bespoke MCP renderer, so the result is stringified with
 * `JSON.stringify(value, null, 2)` and a newline folded into the step's own
 * element would reach the agent escaped, inside one long string. This also
 * pins the association a positional index would only assume.
 */
function verdictsIn(summary: string[]): Map<number, string> {
  const prefix = "   warning: ";
  const byStep = new Map<number, string>();
  let step: number | undefined;
  for (const line of summary) {
    const numbered = /^(\d+)\. /.exec(line);
    if (numbered) {
      step = Number(numbered[1]);
      continue;
    }
    // Anything that is not a step line must be a verdict for the step above it.
    expect(line.startsWith(prefix)).toBe(true);
    expect(step).toBeDefined();
    byStep.set(step as number, line.slice(prefix.length));
  }
  return byStep;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-cross-tree-"));
  __resetRecordingsForTesting();
  fetchCount = 0;
  probeRejection = undefined;
  fetchRunnerTree = async () => ({
    tree: iosRunnerTree([iosLabel("Continue")]),
    source: "native-devtools",
    screen: { width: 390, height: 844 },
  });
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

/**
 * Serve one runner-tree read.
 *
 * `source` is labelling only — it makes each fixture say which real adapter
 * produced its tree, and nothing reads it: the probe never inspects
 * `data.source`, and the platform arm of every clause is chosen from the UDID's
 * shape alone. So a test passing "cdp-dom" is not exercising a Chromium tree
 * SOURCE; it is exercising the Chromium tree SHAPE, which the fixture built by
 * running the real `adaptChromiumTreeForFlows` over it.
 */
const serveTree = (tree: DescribeNode, source: DescribeTreeData["source"] = "native-devtools") => {
  fetchRunnerTree = async () => ({ tree, source });
};

describe("a recorded wait is re-probed against the runner's tree", () => {
  it("records the step, with no warning, when both trees agree", async () => {
    await startRecording("agree");

    const result = await recordWait("agree", {
      condition: "visible",
      selector: { text: "Continue" },
    });

    expect(warningOf(result, "agree")).toBeUndefined();
    // The whole recorded artifact, not just its count: a step of the wrong
    // shape (device id left in, condition dropped) would pass a length check.
    expect(await recordedSteps("agree")).toEqual([
      {
        kind: "tool",
        name: "await-ui-element",
        args: { condition: "visible", selector: { text: "Continue" } },
        delayMs: undefined,
      },
    ]);
  });

  // ── The evaluators on the two sides must not drift ────────────────────────
  //
  // The probe re-evaluates the recorded condition with the flow runner's engine
  // (flowFindAll + evaluateCondition, inside waitForCondition); the live wait
  // used await-ui-element's (findAll + evaluateMatches). Nothing else in this
  // file would notice them drifting apart — the tree is mocked and the live
  // tool is stubbed — and if they did, the recorder would warn on every
  // correctly-recorded wait forever while the suite stayed green. So feed the
  // SAME tree to both engines and require them to agree.
  const AGREEMENT: Array<{ name: string; wait: WaitArgs; tree: () => DescribeNode }> = [
    {
      name: "visible",
      wait: { condition: "visible", selector: { text: "Continue" } },
      tree: () => iosRunnerTree([iosLabel("Continue")]),
    },
    {
      name: "exists",
      wait: { condition: "exists", selector: { identifier: "row" } },
      tree: () => iosRunnerTree([iosLabel("Continue", { identifier: "row" })]),
    },
    {
      name: "hidden",
      wait: { condition: "hidden", selector: { text: "Spinner" } },
      tree: () => iosRunnerTree([iosLabel("Continue")]),
    },
    {
      name: "text/contains",
      wait: { condition: "text", selector: { text: "Total" }, expectedText: "$5.00" },
      tree: () => iosRunnerTree([iosLabel("Total: $5.00")]),
    },
    {
      name: "text/equals",
      wait: {
        condition: "text",
        selector: { text: "Total" },
        expectedText: "Total: $5.00",
        textMatch: "equals",
      },
      tree: () => iosRunnerTree([iosLabel("Total: $5.00")]),
    },
    {
      name: "role selector",
      wait: { condition: "visible", selector: { role: "StaticText" } },
      tree: () => iosRunnerTree([iosLabel("Continue")]),
    },
  ];

  for (const testCase of AGREEMENT) {
    it(`agrees with the live evaluator on a \`${testCase.name}\` wait`, async () => {
      const tree = testCase.tree();
      serveTree(tree);

      // What await-ui-element's OWN evaluator decides about this very tree.
      // The fixture is only meaningful if the live side passes: that is the
      // premise the probe is being asked to confirm.
      const liveVerdict = evaluateMatches(
        { udid: IOS, ...testCase.wait } as Parameters<typeof evaluateMatches>[0],
        findAll(tree, testCase.wait.selector as Selector)
      );
      expect(liveVerdict).toBe(true);

      await startRecording("agreecase");
      const result = await recordWait("agreecase", testCase.wait);

      expect(warningOf(result, "agreecase")).toBeUndefined();
    });
  }

  // ── The live wait itself never held ───────────────────────────────────────
  //
  // `await-ui-element` reports an unmet condition by returning
  // { success: false }, so the recorder's success path records the step. The
  // cross-tree warning must not be attached there: it says the raw step
  // "replays fine — it reads the same tree it just passed against", and this
  // one never passed. At replay an unmet wait fails the step and stops the run.
  it("does not claim a wait that never held replays fine", async () => {
    // The runner's tree AGREES with the selector, so the probe — had it run —
    // would have found nothing to warn about and the step would have been
    // narrated as clean.
    await startRecording("unmet");

    const result = await recordWait(
      "unmet",
      { condition: "visible", selector: { text: "Continue" } },
      { registry: registryWhereWaitTimesOut() }
    );

    const warning = warningOf(result, "unmet");
    expect(warning).toContain("the wait itself never held");
    expect(warning).toContain("stops the run there");
    expect(warning).not.toContain("replays fine");
    // Nothing was compared, so nothing may blame a tree divergence or send the
    // author to re-record against "a selector present in both".
    expect(warning).not.toContain("neither contains the other");
    expect(warning).not.toContain("present in both");
    // "Delete it from the .yaml" holds in host mode only: against a remote
    // client the in-memory copy is authoritative mid-recording and the next
    // append writes the step straight back, with nothing reporting the restore.
    expect(warning).toContain("after `flow-finish-recording`");
    // The probe never ran, so the runner's tree was never read.
    expect(fetchCount).toBe(0);
    // Recording the step anyway is the pre-existing behaviour; only the
    // narration changes.
    expect(await recordedSteps("unmet")).toHaveLength(1);
  });

  // `success: false` is also how the tool reports that it never got to look at
  // the screen — the tree source failed for the whole wait, or the caller
  // cancelled. Neither observed anything, so neither may be narrated as the
  // condition being false, and neither may prescribe deleting the step: the
  // check can be perfectly good and the source merely down.
  it("does not call an unreadable tree source a condition that never held", async () => {
    await startRecording("blind");

    const result = await recordWait(
      "blind",
      { condition: "visible", selector: { text: "Continue" } },
      { registry: registryWhereWaitFails("last tree fetch failed: CDP not connected") }
    );

    const warning = warningOf(result, "blind");
    expect(warning).toContain("without a trustworthy read of the UI tree");
    expect(warning).toContain("UNKNOWN, not known-bad");
    // The note carries an error only where a fetch threw; an empty or degraded
    // tree produces none, and the warning must not send the author looking for
    // one that is not there.
    expect(warning).toContain("names the tree-source error where a fetch threw");
    expect(warning).not.toContain("read `toolResult.note` for the tree-source error");
    // Nor may it claim nothing was compared: a window that goes dark only at
    // the end classifies here too, and its earlier reads did compare.
    expect(warning).not.toContain("nothing was ever compared");
    // The two claims the unmet text makes, and this one must not.
    expect(warning).not.toContain("the wait itself never held");
    expect(warning).not.toContain("re-record it once the condition can actually hold");
    expect(warning).not.toContain("delete the step from the .yaml");
    // Nor may it blame a tree divergence: nothing was compared on either side.
    expect(warning).not.toContain("present in both");
    expect(fetchCount).toBe(0);
    expect(await recordedSteps("blind")).toHaveLength(1);
  });

  it("reads the cause off the RESULT, not off a note that reads like a miss", async () => {
    // Every other recorder test here hands back `{ success, elapsed, note }`
    // with no `cause`, which exercises only the note fallback in
    // `unmetUiWaitCause`. The case the field exists for is the one the note
    // cannot express: on `visible`/`exists`/`text` a wholly blind window
    // produces prose byte-identical to a genuine miss, so this result is
    // exactly what the tool returns when the tree source never answered — and
    // the note alone would send the author to delete the step.
    await startRecording("carried");

    const result = await recordWait(
      "carried",
      { condition: "visible", selector: { text: "Continue" } },
      {
        registry: registryWhereWaitFails("no element matched the selector before timeout", {
          cause: "unreadable",
        }),
      }
    );

    const warning = warningOf(result, "carried");
    expect(warning).toContain("without a trustworthy read of the UI tree");
    expect(warning).toContain("UNKNOWN, not known-bad");
    expect(warning).not.toContain("the wait itself never held");
    // The control: the SAME note with no cause is the legacy shape, and there
    // `unmet` is the only answer available.
    await startRecording("bare");
    const bare = await recordWait(
      "bare",
      { condition: "visible", selector: { text: "Continue" } },
      { registry: registryWhereWaitFails("no element matched the selector before timeout") }
    );
    expect(warningOf(bare, "bare")).toContain("the wait itself never held");
  });

  // The unmet warning tells the author to delete the failed step, and it must
  // say when: after the finish, in both persistence modes. Against a remote
  // client the in-memory copy is authoritative and the next append writes the
  // step straight back; in host mode the re-read makes the edit part of the
  // take and renumbers the steps the verdicts are anchored to. Every other
  // test here records in host mode, so the remote arm never ran.
  it("records against a remote client, and defers the delete to the finish", async () => {
    await startRemoteRecording("remoteunmet");

    const result = await recordWait(
      "remoteunmet",
      { condition: "visible", selector: { text: "Continue" } },
      { registry: registryWhereWaitTimesOut() }
    );

    const warning = warningOf(result, "remoteunmet");
    expect(warning).toContain("the wait itself never held");
    expect(warning).toContain("after `flow-finish-recording` rather than mid-recording");
    // The advice the create-flow skill forbids in two places, and which is what
    // renumbers the steps a verdict is anchored to.
    expect(warning).not.toContain("in host (local) mode, where the recorder re-reads");
    // The host never wrote a file in this mode, so the step lives in memory —
    // and the verdict still has to travel with it.
    expect(result.savedTo).not.toBe(null);
  });

  it("re-probes a wait recorded against a remote client too", async () => {
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await startRemoteRecording("remoteprobe");

    const result = await recordWait("remoteprobe", {
      condition: "visible",
      selector: { text: "Continue" },
    });

    expect(warningOf(result, "remoteprobe")).toContain(
      "does NOT hold against the tree the runner resolves"
    );
    // The probe reads the device the same way in either mode — persistence is
    // where the two differ, not the verdict.
    expect(fetchCount).toBeGreaterThan(0);
  });

  it("does not call an unconfirmable `hidden` a condition that never held", async () => {
    await startRecording("blindhidden");

    const result = await recordWait(
      "blindhidden",
      { condition: "hidden", selector: { text: "Continue" } },
      {
        registry: registryWhereWaitFails(
          "could not confirm the element is hidden — the UI tree was empty or unreadable at timeout"
        ),
      }
    );

    const warning = warningOf(result, "blindhidden");
    expect(warning).toContain("UNKNOWN, not known-bad");
    expect(warning).not.toContain("the wait itself never held");
  });

  it("does not call a cancelled wait a condition that never held", async () => {
    await startRecording("cancelledwait");

    const result = await recordWait(
      "cancelledwait",
      { condition: "visible", selector: { text: "Continue" } },
      { registry: registryWhereWaitFails("wait was cancelled before the condition was met") }
    );

    const warning = warningOf(result, "cancelledwait");
    expect(warning).toContain("cancelled before its deadline");
    expect(warning).toContain("UNKNOWN, not known-bad");
    expect(warning).not.toContain("the wait itself never held");
    expect(fetchCount).toBe(0);
  });

  // ── The probe's early-return guards ───────────────────────────────────────
  //
  // Each guard returns before the probe reads anything, so `fetchCount` is what
  // proves it fired: a guard that stopped guarding would read the device and
  // then compose a verdict from arguments it could not evaluate.
  it.each([
    ["a non-string condition", { condition: 7, selector: { text: "Continue" } }],
    ["a null selector", { condition: "visible", selector: null }],
    ["a non-object selector", { condition: "visible", selector: "Continue" }],
    ["a non-string udid", { condition: "visible", selector: { text: "Continue" }, udid: 42 }],
  ])("does not probe a wait carrying %s", async (label, badArgs) => {
    const name = `guard${label.replace(/\W/g, "")}`;
    await startRecording(name);
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());

    const result = await tool.execute(
      {},
      {
        name,
        project_root: tmpDir,
        command: "await-ui-element",
        args: JSON.stringify({ udid: IOS, ...badArgs }),
      }
    );

    expect(warningOf(result, name)).toBeUndefined();
    expect(fetchCount).toBe(0);
    expect(await recordedSteps(name)).toHaveLength(1);
  });

  // ── The probe is gated on the command ─────────────────────────────────────
  it("does not re-probe a command that is not a wait", async () => {
    await startRecording("tap");
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());

    const result = await tool.execute(
      {},
      {
        name: "tap",
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: IOS, x: 0.2, y: 0.15 }),
      }
    );

    expect(warningOf(result, "tap")).toBeUndefined();
    // Exactly one read — the tap's own selector capture. A second would mean
    // the cross-tree probe ran on a command that has no condition to re-probe.
    expect(fetchCount).toBe(1);
  });

  // A wait carrying `delayMs` is still a wait: the delay is a replay-time sleep
  // before the step, and says nothing about which tree the condition resolves
  // against. (Contrast the tap and restart-app rewrites, which a delayMs
  // deliberately opts out of.)
  it("still re-probes a wait that carries delayMs", async () => {
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await startRecording("delayed");

    const result = await recordWait(
      "delayed",
      { condition: "visible", selector: { text: "Continue" } },
      { delayMs: 250 }
    );

    expect(warningOf(result, "delayed")).toContain("does NOT hold against the tree the runner");
    expect(await recordedSteps("delayed")).toEqual([
      {
        kind: "tool",
        name: "await-ui-element",
        args: { condition: "visible", selector: { text: "Continue" } },
        delayMs: 250,
      },
    ]);
  });

  // ── Which SPELLING of the conversion the verdict is about ────────────────
  //
  // The probe evaluates `args.selector` strictly, as the recorded step carries
  // it. The directive grammar's bare-string sugar is a LOOSE selector, which
  // the runner resolves identifier-first and only falls back to text — so on a
  // screen where some node's id equals the recorded text the two spellings
  // resolve different elements and the verdict flips. These two pin the strict
  // reading and the clause that names it; the skill's polish step prescribes
  // the strict map spelling for the same reason.
  //
  // Both trees below are the live Chromium repro's shape:
  // `<button id="Continue">Proceed</button>`.
  const CONTINUE_BUTTON = () =>
    chromiumRunnerTree([
      n({ role: "button", identifier: "Continue", value: "Proceed", frame: ROW, children: [] }),
    ]);

  it("judges the recorded selector strictly, not as the loose bare string", async () => {
    const tree = CONTINUE_BUTTON();
    serveTree(tree, "cdp-dom");

    // The premise: the two spellings really do disagree on this tree. The
    // identifier pass — the bare string's FIRST alternative — matches the
    // button, while the strict `text` the step recorded matches nothing.
    expect(findAll(tree, { identifier: "Continue" })).toHaveLength(1);
    expect(findAll(tree, { text: "Continue" })).toHaveLength(0);

    await startRecording("strictclean");
    const result = await recordWait("strictclean", {
      udid: CHROMIUM,
      condition: "hidden",
      selector: { text: "Continue" },
    });

    // Strict reading: nothing matches `text=Continue`, so `hidden` holds and
    // there is nothing to warn about. Were the probe to adopt the bare
    // string's loose fallback it would find the button and warn here — and
    // then be wrong about the spelling the skill prescribes.
    expect(warningOf(result, "strictclean")).toBeUndefined();
  });

  it("names the strict spelling the verdict is about when it warns", async () => {
    serveTree(CONTINUE_BUTTON(), "cdp-dom");
    await startRecording("strictwarn");

    const result = await recordWait("strictwarn", {
      udid: CHROMIUM,
      condition: "visible",
      selector: { text: "Continue" },
    });
    const warning = warningOf(result, "strictwarn") ?? "";

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    // Without this clause the author converts to `{ visible: Continue }`, whose
    // identifier pass resolves the button — a check the probe never made.
    expect(warning).toContain("convert it in the strict map spelling");
    expect(warning).toContain("re-parses as a LOOSE selector");
  });

  // ── The `text` comparator the recorded step does NOT carry ───────────────
  //
  // `await-ui-element` compares with `contains` unless the step passed
  // `textMatch: equals`, and the recorded YAML omits the field entirely when it
  // was defaulted — while the `text:` directive has no default and forces the
  // author to pick one. So the comparator is a polish-time decision the
  // artifact does not record, and picking the other one fails on the very
  // screen the probe approved. Pin both readings of one tree: the skill's
  // conversion rule (no `textMatch` ⇒ `contains:`) is only sound while they
  // differ this way.
  it("judges a text wait with the tool's `contains` default, not `equals`", async () => {
    const totalRow = () => iosRunnerTree([iosLabel("Total: $5.00")]);

    serveTree(totalRow());
    await startRecording("textdefault");
    const defaulted = await recordWait("textdefault", {
      condition: "text",
      selector: { text: "Total" },
      expectedText: "$5.00",
    });
    expect(warningOf(defaulted, "textdefault")).toBeUndefined();

    serveTree(totalRow());
    await startRecording("textequals");
    const exact = await recordWait("textequals", {
      condition: "text",
      selector: { text: "Total" },
      expectedText: "$5.00",
      textMatch: "equals",
    });
    // Same tree, same expectedText — only the comparator differs, and it flips
    // the verdict. That is exactly the trap when polish converts a defaulted
    // step to the `equals:` spelling.
    expect(warningOf(exact, "textequals")).toContain('its text was "Total: $5.00"');
  });

  // ── Per-platform divergences, each produced by that platform's adapter ────

  // iOS: an `accessible` container. The AX tree the recorder read merges it
  // into ONE leaf whose label aggregates its children — this repo says so in
  // `captureTapSelector`'s own comment ("the AX tree collapses an `accessible`
  // container into one leaf whose merged label exists on no single view in the
  // replay hierarchy") and the skill names it as the iOS divergence. So the
  // author records the merged string and it resolves nothing for the runner:
  // the flow projection keeps the container as an addressable leaf and hoists
  // the children's text into `subtreeText`, which `findAll` does not match on.
  //
  // This test USED to serve an `alpha: 0` view, on the premise that the AX tree
  // still reports a fully transparent one. UIKit generally excludes hidden and
  // transparent views from accessibility, and nothing in this repo re-adds
  // them, so that premise is a device question the suite cannot settle — while
  // the merge above is settled by the sources on both sides. (The adapter rule
  // it was reaching for is asserted directly below, as what it is: a statement
  // about the projection, not about a divergence.)
  const IOS_ACCESSIBLE_CONTAINER = [
    {
      className: "UIView",
      identifier: "total-row",
      frame: IOS_ROW,
      windowFrame: IOS_ROW,
      children: [
        iosLabel("Total", { frame: { x: 0, y: 100, width: 100, height: 40 } }),
        iosLabel("$5.00", { frame: { x: 120, y: 100, width: 100, height: 40 } }),
      ],
    },
  ];

  it("iOS: warns when the AX tree's merged label exists on no single view", async () => {
    const tree = iosRunnerTree(IOS_ACCESSIBLE_CONTAINER);
    // The premise on the runner's side: the merged string names no node, even
    // though the container is present and carries the pieces as hoisted text.
    expect(findAll(tree, { text: "Total $5.00" })).toHaveLength(0);
    expect(findAll(tree, { identifier: "total-row" })[0]?.subtreeText).toBe("Total $5.00");

    serveTree(tree);
    await startRecording("ios");

    const result = await recordWait("ios", {
      condition: "visible",
      selector: { text: "Total $5.00" },
    });
    const warning = warningOf(result, "ios");

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    // The probe reads on the same short grace an `assert:` uses, so it predicts
    // that conversion exactly — but only on the branch where the two trees
    // really differ, which is this fixture (the merged label names no node in a
    // hierarchy nothing changed). The consequence is stated conditionally
    // because the same verdict also comes back from a screen that merely moved
    // on, where the conversion is fine; an `await:` polls longer, so it carries
    // the extra escape hatch on top.
    expect(warning).toContain(
      "if the trees really do differ over this element, an `assert:` conversion fails the same way"
    );
    expect(warning).toContain("an `await:` does too unless the element reaches that tree");
    expect(warning).toContain(
      "if the SCREEN simply moved on since the live wait, this verdict is no evidence"
    );
    expect(warning).not.toContain("WILL fail");
    // WHY the two disagree, in iOS's own terms — the one platform arm nothing
    // else here reaches. The two places this text is named elsewhere (the
    // unmet-wait and indeterminate cases) pin its ABSENCE, so without a
    // positive assertion the whole arm could return "" and ship green.
    expect(warning).toContain(
      "The recorder reads the accessibility tree and the runner reads the full native view " +
        "hierarchy; they overlap but neither contains the other."
    );
    // And the admission that no tree story rules out — appended per arm, so
    // dropping it from iOS alone is its own mutation. The consequence sentence
    // upstream conditions itself on this cause ("if the SCREEN simply moved
    // on…"); an arm that never raises it leaves that conditional groundless.
    expect(warning).toContain("changed between the live wait and this re-probe");
    // iOS must NOT be told a tool "reads the runner's side": the Apple-only
    // full-hierarchy readers return the RAW view tree — both UILabels included,
    // and still no view carrying the merged label — and they match
    // identifier/label/className exactly, while a recorded selector's
    // `text`/`role` are substrings. Anchored on the preceding sentence's end so
    // it also pins the join: the reader clause is its own sentence, not
    // "…first. no read-only…".
    expect(warning).toContain(
      "rule that out first. No read-only tool reports the runner's projection on iOS"
    );
    // The two tools fail the question DIFFERENTLY, and pooling them names a
    // query one of them cannot be asked: `native-full-hierarchy` takes no
    // matcher at all (`udid, bundleId, fields, skipClasses, skipClassPrefixes,
    // maxDepth`), so an author sent to "check the runner's side" there has
    // nothing to run. Only `native-find-views` has the exact-match behaviour.
    expect(warning).toContain(
      "`native-find-views` matches `identifier`/`label`/`className` EXACTLY"
    );
    expect(warning).toContain("`native-full-hierarchy` takes no matcher at all");
    // Nor may it answer "re-record". The skill's own workflow for a testID the
    // trimmed tree hides is to gate on visible text and retarget the id at
    // polish — which is what PRODUCES this divergence — so sending the author
    // back to the recorder asks for the step the skill just said cannot be
    // recorded live, and lands them on the unmet-wait warning instead.
    expect(warning).not.toContain("re-record");
    expect(warning).toContain("retarget the DIRECTIVE at an `id` the full hierarchy carries");
    expect(await recordedSteps("ios")).toHaveLength(1);
  });

  // The projection rule the transparent-view fixture was reaching for, asserted
  // as what it actually is. Whether the AX tree still reports an `alpha: 0`
  // view — and so whether this rule ever produces a cross-tree divergence — is
  // a device question; that the runner's projection drops one is not.
  it("iOS: the runner's projection drops a transparent view", () => {
    expect(findAll(iosRunnerTree([iosLabel("Continue")]), { text: "Continue" })).toHaveLength(1);
    expect(
      findAll(iosRunnerTree([iosLabel("Continue", { alpha: 0 })]), { text: "Continue" })
    ).toHaveLength(0);
  });

  // What the longer `await:` timeout would be waiting FOR is per condition, and
  // on `hidden` it is the opposite event: the wait passes when the element
  // LEAVES. Saying "unless the element reaches that tree" there describes the
  // one outcome that would keep it failing.
  it("does not tell a `hidden` wait to wait for the element to arrive", async () => {
    serveTree(iosRunnerTree([iosLabel("Spinner")]));
    await startRecording("hiddenaway");

    const result = await recordWait("hiddenaway", {
      condition: "hidden",
      selector: { text: "Spinner" },
    });
    const warning = warningOf(result, "hiddenaway") ?? "";

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    expect(warning).toContain("unless the element LEAVES that tree within its longer timeout");
    expect(warning).not.toContain("the element reaches that tree");
    // The remedy inverts with the condition for the same reason. A `hidden`
    // verdict fires because the runner's tree still HAS the element, so
    // "retarget at an id the full hierarchy definitely carries" points at the
    // opposite of the criterion that would help.
    expect(warning).toContain("this verdict says that tree still HAS the element");
    expect(warning).toContain("narrow the selector until it matches only what you expect to leave");
    expect(warning).not.toContain("retarget the DIRECTIVE at an `id` the full hierarchy carries");
  });

  it("Android: inverts the retarget remedy for `hidden` too", async () => {
    // The clause is per platform AND per condition; Android names a
    // `resource-id` where iOS names an `id`, and both invert the same way.
    serveTree(androidRunnerTree(ANDROID_ROW), "android-devtools");
    await startRecording("hiddenandroid");

    const result = await recordWait(
      "hiddenandroid",
      { udid: ANDROID, condition: "hidden", selector: { identifier: "continue-row" } },
      {}
    );
    const warning = warningOf(result, "hiddenandroid") ?? "";

    expect(warning).toContain("this verdict says that tree still HAS the element");
    expect(warning).toContain("retargeting at a `resource-id` it definitely carries");
    expect(warning).not.toContain("retarget the DIRECTIVE at a `resource-id` the full hierarchy");
  });

  // Android: a testID'd label inside a testID'd clickable row — an everyday RN
  // `Pressable testID` wrapping a `Text testID`.
  //
  // The TRIM collapses the pair: the row is clickable with no own label, so it
  // BORROWS its descendant's text and the inner TextView disappears into it —
  // `describe` shows one node, `id=continue-row label="Continue"`. The FLOW
  // parse keeps both, and the inner node's own resource-id SHIELDS its text
  // from hoisting, so the row reaches the runner carrying no text at all. A
  // `text` check on the row therefore holds live and not for the runner.
  //
  // This test USED to model the target inside a `com.android.systemui` node.
  // That divergence cannot occur: both parses drop system chrome (the flow
  // adapter's `isSystemChrome`, the trim's `!opts.includeSystem && isSystemChrome`),
  // so the live wait would have failed too and the recorder would have reported
  // the unmet-wait warning instead. It only went green because the live tool is
  // stubbed to succeed — it pinned the Android wording and proved nothing about
  // Android.
  const ANDROID_ROW = `<node index="0" class="android.widget.LinearLayout" resource-id="com.acme.app:id/continue-row" clickable="true" package="com.acme.app" bounds="[40,400][1040,480]">
           <node index="0" class="android.widget.TextView" resource-id="com.acme.app:id/continue-label" text="Continue" package="com.acme.app" bounds="[60,410][600,470]" />
         </node>`;

  it("Android: warns when the trim's collapse gave the runner's node no text", async () => {
    const wait: WaitArgs = {
      udid: ANDROID,
      condition: "text",
      selector: { identifier: "com.acme.app:id/continue-row" },
      expectedText: "Continue",
    };

    // The premise, on the same dump: the LIVE side really does pass. Without
    // this the fixture only proves the stub returns success.
    const recorderTree = androidRecorderTree(ANDROID_ROW);
    expect(
      evaluateMatches(
        wait as Parameters<typeof evaluateMatches>[0],
        findAll(recorderTree, wait.selector as Selector)
      )
    ).toBe(true);

    serveTree(androidRunnerTree(ANDROID_ROW), "android-devtools");
    await startRecording("android");

    const result = await recordWait("android", wait);
    const warning = warningOf(result, "android");

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    // The reader clause is its own sentence after the divergence sentence's
    // period, so it must start capitalized — not "…first. no read-only…".
    expect(warning).toContain(
      "first. No read-only tool exposes the runner's full hierarchy on Android"
    );
    // No tree story rules out the screen having moved on between the live wait
    // and the re-probe, so every platform's must say so.
    expect(warning).toContain("changed between the live wait and this re-probe");
    expect(warning).not.toContain("native-find-views");
    // Pin Android's OWN divergence story, not merely that it differs from the
    // others: "four distinct strings" is satisfied by four wrong ones, so
    // swapping this arm for the iOS text passed. Android's story is one dump
    // parsed two ways on this host — there is no view tree on this platform,
    // and no second read either: `describeAndroid` and `flow-android-tree` both
    // call `devtools.getHierarchy()`.
    expect(warning).toContain("Both read the same `getHierarchy` dump");
    expect(warning).toContain("this host then parses it two ways");
    expect(warning).toContain("each holds elements the other drops");
    expect(warning).not.toContain("full native view hierarchy");
    // The claim that made it read as two sources.
    expect(warning).not.toContain("the runner reads the full hierarchy");
    expect(await recordedSteps("android")).toHaveLength(1);
  });

  // Chromium: `projectChromiumNode` drops a node with no on-screen frame, and
  // the walker clamps an off-viewport element's frame to zero area. `describe`
  // still lists it — so `exists` holds live and not for the runner.
  it("Chromium: warns when the runner's projection drops an off-viewport node", async () => {
    serveTree(
      chromiumRunnerTree([
        // Addressable by id AND by text — the node is dropped purely for having
        // no on-screen frame, so the message must not blame the selector.
        n({
          role: "div",
          identifier: "far",
          value: "Continue",
          frame: { x: 0.03, y: 1, width: 0.94, height: 0 },
        }),
      ]),
      "cdp-dom"
    );
    await startRecording("chromium");

    const result = await recordWait("chromium", {
      udid: CHROMIUM,
      condition: "exists",
      selector: { identifier: "far" },
    });
    const warning = warningOf(result, "chromium");

    // `projectChromiumNode` keeps a node only when it is onScreen AND
    // addressable. Naming addressability alone reads as a verdict on the
    // selector, and sends an author whose element is merely below the fold
    // hunting for an id it already carries.
    expect(warning).toContain("addressable nodes");
    expect(warning).toContain("clamp");
    expect(warning).toContain("off-viewport");
    expect(warning).toContain("`scroll-to` before the check rather than a different selector");
    // Both axes. `normRect` clamps each edge to the viewport on its own, so a
    // node scrolled sideways comes back zero-WIDTH at full height — and an
    // author told only about height reads a normal height as "on screen" and
    // skips the scroll that would fix it.
    expect(warning).toContain("zero width for one left or right of it");
    // And NOT the other direction, which this condition rules out: the live
    // `exists` passed, so the recorder's tree held the node and its own walk
    // limit cannot be why the runner's does not.
    expect(warning).toContain("5000-node walk limit is not what went wrong");
    expect(warning).not.toContain("past the end of what it read");

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    // Capitalized, as its own sentence after the divergence sentence's period.
    expect(warning).toContain(
      "first. No read-only tool exposes the runner's trimmed tree on Chromium"
    );
    expect(warning).not.toContain("native-find-views");
    expect(await recordedSteps("chromium")).toHaveLength(1);
  });

  it("Chromium: inverts its own remedy for a `hidden` divergence", async () => {
    // The chromium arm used to be one fixed string for every condition, so a
    // `hidden` verdict — which means that tree still HAS the element — came
    // with the two tips that make the directive match MORE surely.
    serveTree(
      chromiumRunnerTree([
        n({
          role: "div",
          identifier: "still-here",
          value: "Loading",
          frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 },
        }),
      ]),
      "cdp-dom"
    );
    await startRecording("chromiumhidden");

    const result = await recordWait("chromiumhidden", {
      udid: CHROMIUM,
      condition: "hidden",
      selector: { identifier: "still-here" },
    });
    const warning = warningOf(result, "chromiumhidden") ?? "";

    // The one piece of chromium advice that survives every cause.
    expect(warning).toContain("settle it by running the conversion");
    expect(warning).toContain("This verdict says that tree still HAS the element");
    expect(warning).toContain("matches only what you expect to leave");
    // …and not the two that point the other way.
    expect(warning).not.toContain("the fix there is a `scroll-to` before the check");
    expect(warning).not.toContain("only an `id`/`role` selector can match it");
    // The divergence half inverts with it. On `hidden` the runner's tree KEPT
    // the element, so the flow tree's own drops cannot be the cause and naming
    // them sends the author to the one end that is provably fine.
    expect(warning).toContain("it is the RECORDER that never saw the element");
    expect(warning).toContain("past the end of what it read");
    expect(warning).not.toContain("keeps only addressable nodes");
  });

  // A divergence that is not about MEMBERSHIP at all. Both trees hold both
  // nodes; the two sides simply elect different ones, because `text` inspects a
  // single winner and `firstInReadingOrder` breaks an exact (y, x) tie by
  // encounter order — and the two enumerate in opposite orders (`findAll`
  // pre-order, `flattenHoisting` post-order). The verdict is right and every
  // other explanation in the message is wrong for it.
  it("Chromium: names the multi-match cause when a `text` wait elects two different winners", async () => {
    // A block-level wrapper and its text child on the SAME frame — the default
    // for a labelled block element, and routine in React Native.
    const TIE = { x: 0.007, y: 0.062, width: 0.98, height: 0.014 };
    const recorderRow = n({
      role: "div",
      identifier: "row",
      label: "Total",
      frame: TIE,
      children: [n({ role: "span", value: "Total: $5.00", frame: TIE })],
    });
    serveTree(chromiumRunnerTree([recorderRow]), "cdp-dom");
    await startRecording("tie");

    // Guard the premise this test exists for: the two enumeration orders really
    // do hand back opposite winners from the same nodes.
    const sel: Selector = { text: "Total" };
    const recorderMatches = findAll(n({ role: "html", frame: FULL, children: [recorderRow] }), sel);
    const runnerMatches = findAll(chromiumRunnerTree([recorderRow]), sel);
    expect(recorderMatches).toHaveLength(2);
    expect(runnerMatches).toHaveLength(2);
    expect(recorderMatches[0].identifier).toBe("row"); // container first
    expect(runnerMatches[0].value).toBe("Total: $5.00"); // child first

    const result = await recordWait("tie", {
      udid: CHROMIUM,
      condition: "text",
      selector: { text: "Total" },
      expectedText: "Total",
      textMatch: "equals",
    });
    const warning = warningOf(result, "tie");

    // The cause, and the remedy no other clause offers.
    expect(warning).toContain("selector matches more than one element");
    expect(warning).toContain("elect DIFFERENT ones from the very same nodes");
    expect(warning).toContain("narrow the selector until it resolves a single node");
    // Membership and timing are both inapplicable here, and the message has to
    // say so rather than leave four explanations standing that are all false.
    expect(warning).toContain("both trees hold both elements");
    expect(warning).toContain("a longer `await:` timeout cannot help");
    // …and it must not claim the two sides judged the same element. `text` has
    // its own `awaitStillNeeds` arm for this: deleting it silently gives a
    // `text` wait the `visible` clause, which names the wrong event.
    expect(warning).toContain(
      "unless the element THAT tree elects comes to match on it within its longer timeout"
    );
    expect(warning).not.toContain("that element's text comes to match");
    expect(warning).not.toContain("the element reaches that tree");
    // The MECHANISM, which is the shape this fixture is built out of: a nested
    // recorder tree read pre-order against a flattened runner tree read
    // post-order. It holds on Chromium, Android and Vega — and not on iOS.
    expect(warning).toContain("lists a container before its children");
  });

  it("iOS: explains the `text` tie without a container neither of its trees has", async () => {
    // On iOS both sides are FLAT: `adaptAXDescribeToDescribeResult` emits every
    // element as a leaf under one synthetic `AXGroup`, and the flow tree
    // flattens too. The tie is still reachable — two flat lists built from
    // different sources can order an exact frame tie differently — but the
    // container-over-child story sends an author hunting a shape that does not
    // exist on the platform. The clause is gated on `condition === "text"`
    // alone, so nothing else keeps it off this arm.
    serveTree(iosRunnerTree([iosLabel("Total: $5.00")]));
    await startRecording("iostie");

    const result = await recordWait("iostie", {
      condition: "text",
      selector: { text: "Total" },
      expectedText: "Total",
      textMatch: "equals",
    });
    const warning = warningOf(result, "iostie") ?? "";

    expect(warning).toContain("elect DIFFERENT ones from the very same nodes");
    expect(warning).toContain("flat lists built from different sources");
    expect(warning).not.toContain("lists a container before its children");
  });

  it("does not raise the multi-match cause on a condition that cannot have it", async () => {
    // `exists`/`visible`/`hidden` quantify over every match, so enumeration
    // order cannot change their answer — raising it there is noise.
    serveTree(
      chromiumRunnerTree([
        n({ role: "div", identifier: "far", value: "Continue", frame: { ...ROW, height: 0 } }),
      ]),
      "cdp-dom"
    );
    await startRecording("notie");

    const result = await recordWait("notie", {
      udid: CHROMIUM,
      condition: "exists",
      selector: { identifier: "far" },
    });
    const warning = warningOf(result, "notie");

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    expect(warning).not.toContain("elect DIFFERENT ones");
  });

  // Chromium, the OTHER direction: a node the runner KEEPS. `projectChromiumNode`
  // redacts a password leaf's name to `[password]`, so the element reaches the
  // runner (an `id` selector resolves it) while no text/label selector ever can.
  // A message that only knows how to say "the runner dropped it" is false here in
  // both halves, and its "re-record with a text or label" remedy is unreachable
  // by construction.
  it("Chromium: does not claim the runner dropped a password field it kept", async () => {
    const tree = chromiumRunnerTree([
      n({
        role: "input",
        identifier: "pw-field",
        label: "Enter your secret",
        password: true,
        clickable: true,
        frame: ROW,
      }),
    ]);
    serveTree(tree, "cdp-dom");

    // The premise, straight off the real adapter: the node is present and
    // addressable by id, and its name is the redaction — not the placeholder
    // `describe` shows.
    expect(findAll(tree, { identifier: "pw-field" })).toHaveLength(1);
    expect(findAll(tree, { text: "secret" })).toHaveLength(0);
    expect(findAll(tree, { text: "[password]" })).toHaveLength(1);

    await startRecording("chromiumpw");
    const result = await recordWait("chromiumpw", {
      udid: CHROMIUM,
      condition: "visible",
      selector: { text: "secret" },
    });
    const warning = warningOf(result, "chromiumpw") ?? "";

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    // The verdict is right; the explanation must not be the one cause that is
    // provably not what happened here.
    expect(warning).not.toContain("never reaches the runner");
    expect(warning).toContain("`[password]`");
    expect(warning).toContain("only an `id`/`role` selector");
    // Nor may it promise `describe` is a superset the author can read the
    // runner's side off: past its shorter walk it omits nodes the runner keeps.
    expect(warning).not.toContain("full DOM the recorder read");
    expect(warning).toContain("omits nodes the runner keeps");
  });

  // Vega is the one platform whose runner tree CANNOT disagree on an unchanged
  // screen: `projectVegaNode` skips nothing and emits every node as a leaf, so
  // membership, frames and visibility are identical, and the only edit is a
  // hoisted `subtreeText` — which `evaluateCondition` treats as additional
  // evidence beside a node's own text, never as a replacement. The two
  // assertions below pin both halves: the hoist never flips a passing check,
  // and when a warning does fire the message blames the screen, not the trees.
  it("Vega: the text hoist alone never turns a passing check into a warning", async () => {
    const parsed = [
      n({
        identifier: "totals",
        label: "Total",
        frame: ROW,
        children: [n({ role: "text", label: "$5.00", frame: { ...ROW, y: 0.16 }, children: [] })],
      }),
    ];
    const flowTree = vegaRunnerTree(parsed);
    serveTree(flowTree, "vega-automation");
    await startRecording("vegahoist");

    // The container's hoisted text is strictly longer than its own — the
    // divergence the earlier wording claimed could break an `equals`.
    expect(findAll(flowTree, { identifier: "totals" })[0]?.subtreeText).toContain("$5.00");

    const result = await recordWait("vegahoist", {
      udid: VEGA,
      condition: "text",
      selector: { identifier: "totals" },
      expectedText: "Total",
      textMatch: "equals",
    });

    expect(warningOf(result, "vegahoist")).toBeUndefined();
  });

  it("Vega: blames a changed screen, not two different projections", async () => {
    // The only way a Vega probe disagrees: the screen moved on between the
    // live wait and the re-probe.
    serveTree(
      vegaRunnerTree([n({ role: "text", label: "Proceed", frame: ROW })]),
      "vega-automation"
    );
    await startRecording("vega");

    const result = await recordWait("vega", {
      udid: VEGA,
      condition: "visible",
      selector: { text: "Continue" },
    });
    const warning = warningOf(result, "vega");

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    expect(warning).toContain("the SCREEN changed between the live wait and this re-probe");
    expect(warning).toContain("`describe` reads the same source the runner does");
    expect(warning).not.toContain("different projections of the screen");
    // Vega is where an absolute consequence is most plainly wrong: the arm
    // below states outright that a disagreement here MEANS the screen changed,
    // and on that cause the conversion passes. So the conversion clause may not
    // decide against it — it has to leave the verdict to the cause.
    expect(warning).not.toContain("WILL fail");
    expect(warning).toContain(
      "if the SCREEN simply moved on since the live wait, this verdict is no evidence"
    );
    // The other three platforms' imperative. Here the selector is fine and the
    // screen is what moved, so nothing may send the author to rewrite it.
    expect(warning).not.toContain("retarget the DIRECTIVE");
    expect(warning).not.toContain("re-record with a selector");
    expect(warning).toContain("re-run the wait");
    expect(await recordedSteps("vega")).toHaveLength(1);
  });

  it("Vega: admits the tie its own text clause names two sentences later", async () => {
    // The tie mechanism is not a platform difference — it is the two
    // enumeration orders, and Vega has them too (`flattenHoisting` emits
    // post-order, `findAll` collects pre-order). So on `text` the screen is not
    // the only cause, and saying it is contradicts the clause the same message
    // carries.
    const TIE = { x: 0.1, y: 0.1, width: 0.5, height: 0.05 };
    const row = n({
      identifier: "row",
      label: "Total",
      frame: TIE,
      children: [n({ role: "text", label: "Total: $5.00", frame: TIE, children: [] })],
    });
    serveTree(vegaRunnerTree([row]), "vega-automation");
    await startRecording("vegatie");

    const result = await recordWait("vegatie", {
      udid: VEGA,
      condition: "text",
      selector: { text: "Total" },
      expectedText: "Total",
      textMatch: "equals",
    });
    const warning = warningOf(result, "vegatie") ?? "";

    expect(warning).toContain("elect DIFFERENT ones from the very same nodes");
    expect(warning).toContain("either the SCREEN changed");
    expect(warning).toContain("or the two sides elected different elements");
    // The absolute belongs only to the conditions that cannot have a tie.
    expect(warning).not.toContain("disagreement means the SCREEN changed");
  });

  // Each platform's remedy must be its own. Pinning them only by "does this
  // string appear" lets a reworded clause collapse two platforms onto one
  // wording while every negative assertion above still passes.
  it("gives each platform a distinct remedy", async () => {
    const warnings = new Map<string, string>();
    for (const [name, udid] of [
      ["ios", IOS],
      ["android", ANDROID],
      ["chromium", CHROMIUM],
      ["vega", VEGA],
    ] as const) {
      serveTree(iosRunnerTree([iosLabel("Proceed")]));
      await startRecording(`distinct-${name}`);
      const result = await recordWait(`distinct-${name}`, {
        udid,
        condition: "visible",
        selector: { text: "Continue" },
      });
      warnings.set(name, warningOf(result, `distinct-${name}`) ?? "");
    }

    expect(new Set(warnings.values()).size).toBe(4);
    // And none of them may fall through to the unreachable-platform fallback.
    for (const warning of warnings.values()) {
      expect(warning).not.toContain("on this platform — keep the step raw");
    }
  }, 15_000);

  // ── Indeterminate: unknown must never be dressed up as a verdict ──────────

  it("records with a warning when the runner's tree cannot be read at all", async () => {
    // The injection-free case: the runner's tree source is unavailable on this
    // device. Indeterminate is not a verdict, so refusing here would block a
    // form the skill explicitly sanctions.
    fetchRunnerTree = async () => {
      throw new Error("native devtools is unavailable");
    };
    await startRecording("blind");

    const result = await recordWait("blind", {
      condition: "visible",
      selector: { text: "Continue" },
    });
    const warning = warningOf(result, "blind");

    expect(warning).toContain("could not be re-verified against the tree the RUNNER reads");
    expect(warning).toContain("is UNKNOWN, not known-bad");
    // Its own rule: nothing was compared, so nothing may claim the two trees
    // differ — nor append the remedy that follows from a comparison.
    expect(warning).not.toContain("neither contains the other");
    expect(warning).not.toContain("No read-only tool");
    expect(warning).not.toContain("re-record");
    expect(await recordedSteps("blind")).toHaveLength(1);
  });

  // "the accessibility tree" is the recorder's tree only on iOS and Android. On
  // Chromium the recorder read the CDP DOM and on Vega the toolkit page source,
  // so the indeterminate message must name the READER, not a tree source
  // neither side touched.
  it("does not call the recorder's tree the accessibility tree on Chromium", async () => {
    fetchRunnerTree = async () => {
      throw new Error("CDP session closed");
    };
    await startRecording("blindchromium");

    const result = await recordWait("blindchromium", {
      udid: CHROMIUM,
      condition: "visible",
      selector: { text: "Continue" },
    });
    const warning = warningOf(result, "blindchromium");

    expect(warning).toContain("the tree `await-ui-element` reads");
    expect(warning).not.toContain("accessibility tree");
    // The bundleId caveat is iOS-only — nothing on Chromium resolves a target
    // app, so raising the subject here would invent a knob that does not exist.
    expect(warning).not.toContain("no directive takes a bundleId");
  });

  // On iOS the indeterminate reason is quoted from the shared native-target
  // error, whose recovery ends "provide bundleId explicitly". `await-ui-element`
  // takes a `bundleId`, so that reads as actionable — and it is not: the probe
  // predicts a directive, and no directive carries one. Correct the quoted
  // advice rather than leaving the author to act on it.
  it("iOS: says the bundleId its quoted reason recommends cannot reach the probe", async () => {
    fetchRunnerTree = async () => {
      throw new Error(
        "No native-devtools-connected apps are available for auto-targeting. " +
          "Launch or restart the app first, provide bundleId explicitly, or use screenshot " +
          "to inspect visible Home/system UI."
      );
    };
    await startRecording("iosblind");

    const result = await recordWait("iosblind", {
      condition: "visible",
      selector: { text: "General" },
    });
    const warning = warningOf(result, "iosblind");

    // The quoted reason still arrives whole — its tail is the recovery.
    expect(warning).toContain("provide bundleId explicitly");
    // …followed by what actually applies here.
    expect(warning).toContain("no directive takes a bundleId");
    expect(warning).toContain("`launch-app`");
    expect(warning).toContain("keep the check as a raw `tool:` step");
  });

  it("iOS: the caveat holds when the step DID carry a bundleId", async () => {
    fetchRunnerTree = async () => {
      throw new Error("no connected app; provide bundleId explicitly");
    };
    await startRecording("iosblindbundle");

    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());
    const result = await tool.execute(
      {},
      {
        name: "iosblindbundle",
        project_root: tmpDir,
        command: "await-ui-element",
        args: JSON.stringify({
          udid: IOS,
          bundleId: "com.apple.Preferences",
          condition: "visible",
          selector: { text: "General" },
        }),
      }
    );

    // Supplying one changes nothing, so the warning must not imply it might.
    expect(warningOf(result, "iosblindbundle")).toContain(
      "the `bundleId` on this step reached the live wait only"
    );
  });

  // `probeWhenCondition` budgets its POLL LOOP at the 1s assert grace, but each
  // tree read inside it is awaited unbounded and the clock is only checked
  // between reads — so a slow source (10s on Chromium CDP, up to the Android
  // devtools RPC's 15s `getHierarchy` bound) stalls the recorder far past the
  // window the warning advertises. The probe must be ceilinged, and an overrun
  // reported as indeterminate rather than as a verdict.
  it("gives up on a tree read that outruns the probe budget, and stops it", async () => {
    // A read the test holds open past the ceiling and then releases — the shape
    // that exposes what "giving up" has to mean. A read that NEVER settles
    // would prove the bound and nothing else: the loop stays parked on it, so
    // it could not have issued a second read whether or not it was stopped.
    let releaseRead: () => void = () => {};
    const readLanded = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    fetchRunnerTree = async () => {
      await readLanded;
      // A tree that does NOT satisfy the condition. One that did would end the
      // loop on the spot and prove nothing: the post-deadline read only fires
      // when the read that landed left the condition unmet.
      return { tree: iosRunnerTree([iosLabel("Proceed")]), source: "native-devtools" };
    };
    await startRecording("slow");

    const startedAt = Date.now();
    const result = await recordWait("slow", {
      condition: "visible",
      selector: { text: "Continue" },
    });
    const elapsed = Date.now() - startedAt;
    const warning = warningOf(result, "slow");

    expect(warning).toContain("could not be re-verified against the tree the RUNNER reads");
    // The source answered, just too slowly — so the message must not describe
    // it as absent, nor send the author to wait for a recovery that is not
    // pending.
    expect(warning).toContain("the source is slow, not down");
    expect(warning).toContain("when the device is quieter");
    expect(warning).not.toContain("once that tree source is back");
    // Never a verdict: nothing was compared, so the conversion is UNKNOWN.
    expect(warning).not.toContain("does NOT hold");
    // The ceiling is 6s; the bound that matters is that this never costs a full
    // Chromium (10s) or Android devtools (15s) read, so it is set just under
    // the first of those rather than tight against the ceiling — the recorder
    // waited out that ceiling on purpose here, and host load lands on top of
    // it. The generous per-test timeout below is for the same reason.
    expect(elapsed).toBeLessThan(9500);
    expect(await recordedSteps("slow")).toHaveLength(1);
    expect(fetchCount).toBe(1);

    // Now let the abandoned read land. Past its own deadline the poll loop
    // takes one more full read (`finalPoll`) unless it has been stopped — which
    // would put a second device read behind whatever step the recorder runs
    // next, relocating the stall the ceiling exists to remove instead of
    // removing it.
    releaseRead();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchCount).toBe(1);
  }, 15_000);

  // The budget has to cover the branch the probe exists for. A determinate
  // verdict costs TWO full reads — the loop checks its deadline only after a
  // completed read, then fires one more back-to-back — so a ceiling sized for
  // "the grace plus one in-flight read" gave the divergence warning half the
  // per-read tolerance of the clean case, and silently substituted the
  // indeterminate warning on a device that was only slow.
  it("still reaches a determinate verdict when each read is slower than the grace window", async () => {
    // 1.9s per read: over the 1s grace, so the loop takes exactly two reads and
    // the total lands near 3.8s. The clean case tolerated a read this slow all
    // along — it returns from the first one — while the determinate branch
    // needs two, and any ceiling under that total loses the verdict.
    //
    // Both bounds this sits between are one-directional under load, which is
    // what keeps it from flaking: host load only pushes the total UP, so it
    // stays above the 3500ms ceiling this test exists to reject (grace + ONE
    // read), while leaving 2.2s of headroom under the real 6000ms budget.
    fetchRunnerTree = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1900));
      return { tree: iosRunnerTree([iosLabel("Proceed")]), source: "native-devtools" };
    };
    await startRecording("slowdeterminate");

    const result = await recordWait("slowdeterminate", {
      condition: "visible",
      selector: { text: "Continue" },
    });
    const warning = warningOf(result, "slowdeterminate");

    expect(fetchCount).toBe(2);
    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    expect(warning).not.toContain("could not be re-verified");
  }, 20_000);

  // A `text` reason quotes the matched element's rendered content, and on the
  // flow tree that content is HOISTED — a container carries every descendant's
  // text, space-joined. Unbounded, one failed check can paste a whole log pane
  // into the tool result the agent reads in full. Before this branch a recorded
  // wait's message carried no screen content at all.
  it("caps the screen text it echoes back", async () => {
    const wall = "Lorem ipsum dolor sit amet ".repeat(60); // ~1600 chars
    serveTree(iosRunnerTree([iosLabel(`Total ${wall}`)]));
    await startRecording("long");

    const result = await recordWait("long", {
      condition: "text",
      selector: { text: "Total" },
      expectedText: "$5.00",
    });
    const warning = warningOf(result, "long") ?? "";

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    expect(warning).toContain("more chars)");
    // Enough of the text to be actionable, not the whole screen.
    expect(warning).toContain("Lorem ipsum");
    // Bound the ECHOED REASON, not the whole message: the fixed prose around it
    // is longer than this fixture, so `warning.length < wall.length` passes or
    // fails on how much explanation the message carries and says nothing about
    // the cap. Pin the cap itself — the EMITTED string, marker included — so
    // raising the constant fails here.
    const echoed = echoedReasonOf(warning);
    expect(echoed.length).toBeLessThanOrEqual(200);
    const [, tail] = echoed.split(/… \(\d+ more chars\) …/);
    expect(tail).toHaveLength(60);
  });

  // The cap bounds what is EMITTED, not what is kept. Budgeting the kept
  // content instead let the marker push the result past the cap — and, just
  // over the boundary, past the input it was meant to shorten: a 201-character
  // reason came out at 218 announcing "(1 more chars)".
  it("never emits a reason over the cap, or longer than the reason itself", async () => {
    // `element matched text="Total" but its text was "<label>" (wanted to
    // contain "$5.00")` is 76 characters around the label, so the label length
    // sets the reason length exactly.
    const FIXED = 76;
    for (const reasonLength of [199, 200, 201, 205, 220, 260]) {
      const label = `Total ${"z".repeat(reasonLength - FIXED - "Total ".length)}`;
      serveTree(iosRunnerTree([iosLabel(label)]));
      const name = `cap${reasonLength}`;
      await startRecording(name);

      const result = await recordWait(name, {
        condition: "text",
        selector: { text: "Total" },
        expectedText: "$5.00",
      });
      const echoed = echoedReasonOf(warningOf(result, name) ?? "");

      expect(echoed.length).toBeLessThanOrEqual(200);
      expect(echoed.length).toBeLessThanOrEqual(reasonLength);
      // Either it fit and is verbatim, or it was elided — never "elided and
      // longer".
      if (reasonLength <= 200) expect(echoed).not.toContain("more chars)");
      else expect(echoed).toContain("more chars)");
    }
  }, 30_000);

  // The cap only ever ELIDES THE MIDDLE, because `waitForCondition` puts the
  // note recording that its final poll went dark at the END of the reason —
  // and that note qualifies the very verdict the warning is built on. Head-only
  // truncation dropped it silently.
  it("keeps the tail of an over-long reason, where the final-poll note lives", async () => {
    const wall = "Lorem ipsum dolor sit amet ".repeat(60);
    // Trusted reads that leave the condition false right up to the deadline,
    // then a source that dies on the last poll. That is the blip tier: the dark
    // tail is inside CONDITION_DARK_TAIL_TOLERANCE_MS, so the verdict stays
    // determinate and `waitForCondition` appends the failed final read to the
    // reason rather than discarding the window.
    const probeStartedAt = Date.now();
    fetchRunnerTree = async () => {
      if (Date.now() - probeStartedAt > 900) throw new Error("native devtools went away");
      return { tree: iosRunnerTree([iosLabel(`Total ${wall}`)]), source: "native-devtools" };
    };
    await startRecording("tail");

    const result = await recordWait("tail", {
      condition: "text",
      selector: { text: "Total" },
      expectedText: "$5.00",
    });
    const warning = warningOf(result, "tail") ?? "";

    // This tier holds only while the last trusted read lies within
    // CONDITION_DARK_TAIL_TOLERANCE_MS (2 poll intervals, 600ms) of the loop's
    // exit. Host load is the one thing that can stretch it past that, and the
    // verdict then turns indeterminate — so say which premise broke.
    expect(
      warning,
      "expected the blip tier: under host load the dark tail can exceed CONDITION_DARK_TAIL_TOLERANCE_MS, which turns this indeterminate"
    ).toContain("does NOT hold against the tree the runner resolves");
    expect(warning).toContain("Lorem ipsum");
    expect(warning).toContain("more chars)");
    // The note the head-only cap threw away.
    expect(warning).toContain("native devtools went away");
  });

  it("reports a probe that threw outright as indeterminate, not as a verdict", async () => {
    // The arm no tree fixture reaches: every "cannot be read" case here makes
    // `fetchFlowTree` throw, and `waitForCondition` catches that into an
    // indeterminate VALUE. This is the other half — the probe itself rejecting,
    // which is what the `settled.type === "error"` branch exists for, and it
    // must read as "the tree did not answer" rather than as a divergence.
    probeRejection = new Error("probe blew up");
    await startRecording("threw");

    const result = await recordWait("threw", {
      condition: "visible",
      selector: { text: "Continue" },
    });
    const warning = warningOf(result, "threw") ?? "";

    expect(warning).toContain("could not be re-verified against the tree the RUNNER reads");
    expect(warning).toContain("reading the runner's tree failed: probe blew up");
    expect(warning).toContain("UNKNOWN, not known-bad");
    // A throw is an outage, not slowness: the two get different next moves.
    expect(warning).toContain("re-probe once that tree source is back");
    expect(warning).not.toContain("the source is slow, not down");
    expect(warning).not.toContain("does NOT hold");
    expect(await recordedSteps("threw")).toHaveLength(1);
  });

  it("raises no warning for a wait nested inside a recorded run-sequence", async () => {
    // `flow-start-recording`'s description tells the author this, and nothing
    // pinned it: the recorder keys every wait warning off the tool id, so a
    // `run-sequence` — whose own result carries no `success` key — is neither
    // probed nor reported on, however its nested wait ended. The author has to
    // read `toolResult` themselves, so the claim has to stay true.
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "run-sequence") return { completed: 0, total: 2, steps: [] };
        throw new Error(`Tool "${id}" not found`);
      }),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;
    await startRecording("nested");

    const tool = createFlowAddStepTool(registry);
    const result = await tool.execute(
      {},
      {
        name: "nested",
        project_root: tmpDir,
        command: "run-sequence",
        args: JSON.stringify({
          udid: IOS,
          steps: [
            {
              tool: "await-ui-element",
              args: { condition: "visible", selector: { text: "Nope" } },
            },
            { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
          ],
        }),
      }
    );

    expect(warningOf(result, "nested")).toBeUndefined();
    expect(fetchCount).toBe(0);
    expect(result.toolResult).toMatchObject({ completed: 0, total: 2 });
  });

  // Two boundary cases the "wall of text" fixture cannot reach.
  it("quotes a reason at or under the cap verbatim", async () => {
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await startRecording("short");

    const result = await recordWait("short", {
      condition: "visible",
      selector: { text: "Continue" },
    });

    // Well under 200 chars, so nothing may be elided and nothing appended.
    expect(echoedReasonOf(warningOf(result, "short") ?? "")).toBe(
      'no element matched selector text="Continue"'
    );
  });

  it("does not truncate the reason when the runner's tree cannot be read", async () => {
    // An environment error carries no screen content, and its TAIL is the
    // recovery instruction — the case where a cap costs the reader the fix.
    const advice =
      "native devtools is unavailable on this device — the app was not launched through " +
      "argent, so the injected helper never attached; relaunch it with `launch-app` (or " +
      "`restart-app`) and re-record the step, or use screenshot to inspect visible Home/Settings";
    expect(advice.length).toBeGreaterThan(200);
    fetchRunnerTree = async () => {
      throw new Error(advice);
    };
    await startRecording("blindlong");

    const result = await recordWait("blindlong", {
      condition: "visible",
      selector: { text: "Continue" },
    });
    const warning = warningOf(result, "blindlong") ?? "";

    expect(warning).toContain("could not be re-verified against the tree the RUNNER reads");
    expect(warning).toContain(advice);
    expect(warning).not.toContain("more chars)");
  });

  // ── The verdict has to reach the moment it is FOR ────────────────────────
  //
  // The probe answers a polish-time question, and polish begins after
  // flow-finish-recording. A warning that lives only in one step's `message` is
  // gone from every artifact by then.

  it("carries each step's verdict into flow-finish-recording", async () => {
    await startRecording("polish");

    // Step 1 agrees — the runner's tree has the element, so no warning.
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("polish", { condition: "visible", selector: { text: "Continue" } });
    // Step 2 diverges.
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("polish", { condition: "visible", selector: { text: "Continue" } });

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "polish", project_root: tmpDir }
    );

    // Two step lines plus the one verdict line, each its own element.
    expect(finished.summary).toHaveLength(3);
    const verdicts = verdictsIn(finished.summary);
    // The verdict is anchored to the step it judged, not to the recording.
    expect([...verdicts.keys()]).toEqual([2]);
    expect(verdicts.get(2)).toContain("does NOT hold against the tree the runner resolves");
    // …and `message` says one exists, for a caller that reads only that.
    expect(finished.message).toContain("1 step carries a cross-tree warning");
  });

  it("says nothing about warnings when every recorded wait agreed", async () => {
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await startRecording("clean");
    await recordWait("clean", { condition: "visible", selector: { text: "Continue" } });

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "clean", project_root: tmpDir }
    );

    expect(finished.message).toBe('Finished recording "clean" flow (1 steps)');
    expect(finished.summary[0]).not.toContain("warning:");
  });

  it("does not headline a wait that never held as a conversion warning", async () => {
    // The re-probe is skipped on any `success: false` — the warning says so
    // itself. What it reports is a step that failed LIVE and stops the run at
    // replay, which is the opposite of a polish-time question about converting,
    // and a caller that reads only `message` and is not converting anything
    // would take the old headline as licence to skip the summary.
    await startRecording("neverheld");
    await recordWait(
      "neverheld",
      { condition: "visible", selector: { text: "NoSuchThing" } },
      { registry: registryWhereWaitTimesOut() }
    );

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "neverheld", project_root: tmpDir }
    );

    expect(verdictsIn(finished.summary).get(1)).toContain("the wait itself never held");
    expect(finished.message).toContain("1 step recorded a wait that did not pass");
    expect(finished.message).not.toContain("cross-tree warning");
  });

  it("counts a probed verdict and an unpassed wait separately", async () => {
    await startRecording("mixed");
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("mixed", { condition: "visible", selector: { text: "Continue" } });
    await recordWait(
      "mixed",
      { condition: "visible", selector: { text: "NoSuchThing" } },
      { registry: registryWhereWaitTimesOut() }
    );

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "mixed", project_root: tmpDir }
    );

    expect(finished.message).toBe(
      'Finished recording "mixed" flow (2 steps) — 1 step carries a cross-tree warning about ' +
        "converting a recorded wait, and 1 step recorded a wait that did not pass; read " +
        "`summary` before converting or replaying"
    );
  });

  it("keeps every verdict when the recording ends with an echo", async () => {
    // `flow-add-echo` appends through the same helper and files no verdict, so
    // a trailing echo used to leave the recording one step longer than the
    // count flow-add-step kept and drop every verdict it had — from `summary`
    // and from `message` alike. Labelling a recording with echoes is what
    // flow-start-recording's own description asks for, and an append after the
    // warned steps moves none of them: their positions are still correct.
    await startRecording("echolast");
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("echolast", { condition: "visible", selector: { text: "Continue" } });
    await recordWait("echolast", { condition: "visible", selector: { text: "Sign in" } });
    await flowInsertEchoTool.execute(
      {},
      { name: "echolast", project_root: tmpDir, message: "form submitted" }
    );

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "echolast", project_root: tmpDir }
    );

    // Three steps and two verdicts, interleaved.
    expect(finished.summary).toHaveLength(5);
    expect([...verdictsIn(finished.summary).keys()]).toEqual([1, 2]);
    expect(finished.summary[4]).toContain("3. echo:");
    // The plural arm of the count, and the only place it is asserted.
    expect(finished.message).toContain("2 steps carry a cross-tree warning");
  });

  it("drops every verdict when a hand edit renumbered the steps", async () => {
    // Editing the .yaml mid-recording is documented, and host mode re-reads the
    // file on every append — so deleting a step renumbers each one after it.
    // These anchors are positions, so an innocent step can inherit the number a
    // verdict was left on.
    await startRecording("edited");
    // Step 1 agrees, so its probe returns on the first read and costs no grace
    // window. Step 2 diverges and carries the verdict. Step 3 agrees.
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("edited", { condition: "visible", selector: { text: "Continue" } });
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("edited", { condition: "visible", selector: { text: "Continue" } });
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("edited", { condition: "visible", selector: { text: "Continue" } });

    // Delete the MIDDLE step: the innocent third slides into position 2, the
    // one the verdict is anchored to. Dropping only out-of-range numbers would
    // convict it.
    const file = path.join(tmpDir, ".argent", "flows", "edited.yaml");
    const parsed = parseFlow(await fs.readFile(file, "utf8"));
    parsed.steps = [parsed.steps[0], parsed.steps[2]];
    await fs.writeFile(file, serializeFlow(parsed), "utf8");

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "edited", project_root: tmpDir }
    );

    expect(finished.summary).toHaveLength(2);
    for (const line of finished.summary) expect(line).not.toContain("warning:");
    // …and `message` must not advertise what the summary no longer carries —
    // nor read like a recording in which nothing was ever wrong. The drop is
    // the right call; reporting it as a pass is not.
    expect(finished.message).toBe(
      'Finished recording "edited" flow (2 steps) — 1 warning raised during this recording is ' +
        "NOT in `summary`: a hand edit to the .yaml moved the step it judged, so which step it " +
        "belongs to is no longer knowable — re-record that wait to see it again"
    );
  });

  it("drops the verdict when a hand edit REORDERED the steps", async () => {
    // A reorder needs no second condition: the flow is still the length the
    // recorder appended, so nothing about the count says anything happened.
    await startRecording("swapped");
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("swapped", { condition: "visible", selector: { text: "Continue" } });
    // Diverges — the verdict lands on step 2.
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("swapped", { condition: "hidden", selector: { text: "Continue" } });
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("swapped", { condition: "exists", selector: { text: "Continue" } });

    // Hand-swap steps 2 and 3. The step that inherits number 2 is a check that
    // agrees across both trees, and a verdict left on the number would convict
    // it while the wait that really diverges reads clean.
    const file = path.join(tmpDir, ".argent", "flows", "swapped.yaml");
    const parsed = parseFlow(await fs.readFile(file, "utf8"));
    parsed.steps = [parsed.steps[0], parsed.steps[2], parsed.steps[1]];
    await fs.writeFile(file, serializeFlow(parsed), "utf8");

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "swapped", project_root: tmpDir }
    );

    expect(finished.summary).toHaveLength(3);
    for (const line of finished.summary) expect(line).not.toContain("warning:");
    expect(finished.message).toContain(
      "1 warning raised during this recording is NOT in `summary`"
    );
  });

  it("drops the verdict of a step deleted before the recording went on", async () => {
    // The append after the edit re-reads the edited file, so the recorder's own
    // view agrees with it and nothing about the file says an edit happened —
    // while every key past the deletion now points one step too far.
    await startRecording("deleted");
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("deleted", { condition: "visible", selector: { text: "Continue" } });
    serveTree(iosRunnerTree([iosLabel("Sign in")]));
    await recordWait("deleted", { condition: "visible", selector: { text: "Sign in" } });

    // Delete the diverging step 1 — the remedy `UNMET_WAIT_WARNING` itself
    // offers — then keep recording.
    const file = path.join(tmpDir, ".argent", "flows", "deleted.yaml");
    const parsed = parseFlow(await fs.readFile(file, "utf8"));
    parsed.steps = parsed.steps.slice(1);
    await fs.writeFile(file, serializeFlow(parsed), "utf8");

    serveTree(iosRunnerTree([iosLabel("Done")]));
    await recordWait("deleted", { condition: "visible", selector: { text: "Done" } });

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "deleted", project_root: tmpDir }
    );

    expect(finished.summary).toHaveLength(2);
    // Step 1 is now the "Sign in" wait, which was judged clean; the verdict that
    // was filed under 1 judged a step that is no longer in the file.
    expect(finished.summary[0]).toContain('"Sign in"');
    expect(verdictsIn(finished.summary).size).toBe(0);
    for (const line of finished.summary) expect(line).not.toContain("warning:");
    expect(finished.message).toContain(
      "1 warning raised during this recording is NOT in `summary`"
    );
  });

  it("drops the verdict a hand edit moved onto an identical twin step", async () => {
    // The case both content checks are blind to. A verdict is not a function of
    // the step's content — the probe reads the live device at that step's
    // moment — so the byte-identical wait can diverge at one position and agree
    // at another. Renumber the two and the anchor cannot tell them apart: the
    // step that will really break on conversion reads clean, and the one that
    // converts fine carries the warning.
    await startRecording("twins");
    serveTree(iosRunnerTree([iosLabel("Ready marker")]));
    await recordWait("twins", { condition: "visible", selector: { text: "Ready marker" } });
    // Step 2 diverges: the runner's tree does not hold "Continue".
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("twins", { condition: "visible", selector: { text: "Continue" } });
    // Step 3 is the byte-identical call against a tree that DOES hold it.
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("twins", { condition: "visible", selector: { text: "Continue" } });

    const file = path.join(tmpDir, ".argent", "flows", "twins.yaml");
    const parsed = parseFlow(await fs.readFile(file, "utf8"));
    parsed.steps = parsed.steps.slice(1);
    await fs.writeFile(file, serializeFlow(parsed), "utf8");

    // …and record on, so the append re-reads the edited file and the recorder's
    // view agrees with it again.
    serveTree(iosRunnerTree([iosLabel("Ready marker")]));
    await recordWait("twins", { condition: "visible", selector: { text: "Ready marker" } });

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "twins", project_root: tmpDir }
    );

    // Step 1 is the wait that diverged; step 2 is the twin that passed the
    // probe. A verdict on either is a lie — on step 2 it convicts the clean
    // one, on step 1 it is right by accident and unprovable from here.
    expect(finished.summary).toHaveLength(3);
    expect(verdictsIn(finished.summary).size).toBe(0);
    expect(finished.summary[1]).toContain('"Continue"');
    for (const line of finished.summary) expect(line).not.toContain("warning:");
  });

  it("keeps a live verdict when a delete makes the next append reuse its number", async () => {
    // TWO verdicts alive across the edit, which is what makes the reused key
    // reachable: the file loses a step, so the next append comes back with a
    // `stepCount` a verdict already holds. Overwriting it loses a warning on a
    // step that is still in the flow and still diverges — and the headline then
    // states a count that says so.
    await startRecording("collide");
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("collide", { condition: "visible", selector: { text: "Alpha" } });
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("collide", { condition: "visible", selector: { text: "Beta" } });

    // Delete "Alpha": the file is one step long again, so the next append is
    // step 2 — the number "Beta"'s verdict is filed under.
    const file = path.join(tmpDir, ".argent", "flows", "collide.yaml");
    const parsed = parseFlow(await fs.readFile(file, "utf8"));
    parsed.steps = parsed.steps.slice(1);
    await fs.writeFile(file, serializeFlow(parsed), "utf8");

    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    const third = await recordWait("collide", {
      condition: "visible",
      selector: { text: "Gamma" },
    });
    expect(third.stepCount).toBe(2);

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "collide", project_root: tmpDir }
    );

    // "Beta" moved from 2 to 1, so its verdict cannot be reported against a
    // number any more — but it must be COUNTED, not silently replaced by
    // "Gamma"'s, which is what filing under a reused key did. Three verdicts
    // were raised, one survives, and the two that did not are stated: "Alpha"'s
    // went with the step the author deleted, "Beta"'s with the renumbering.
    expect(finished.summary[0]).toContain('"Beta"');
    expect([...verdictsIn(finished.summary).keys()]).toEqual([2]);
    expect(finished.summary[2]).toContain('"Gamma"');
    expect(finished.message).toContain("1 step carries a cross-tree warning");
    expect(finished.message).toContain(
      "2 warnings raised during this recording are NOT in `summary`"
    );
  });

  it("is declared longRunning, so the probe's budget is not spent from a 30s cap", () => {
    // The recorded tool runs inside this call, so it is as long as whatever it
    // wraps — and the three it most often wraps all declare this. Without it
    // the MCP adapter caps the POST at FETCH_TIMEOUT_MS and retries the
    // identical body MAX_RETRIES more times; each retry re-runs the recorded
    // action on the device and appends another step, since an aborted request
    // still appends its first. The re-probe spends up to PROBE_BUDGET_MS from
    // that same ceiling, so the flag is what keeps the budget from buying
    // duplicate steps.
    expect(createFlowAddStepTool(registryWhereWaitSucceeds()).longRunning).toBe(true);
    // The tool it proxies most often, and the asymmetry that made this sharp:
    // a wait that ran fine standalone duplicated itself once recorded.
    expect(createAwaitUiElementTool(registryWhereWaitSucceeds()).longRunning).toBe(true);
  });

  it("says nothing about discarded verdicts when none were", async () => {
    // The other side of the count: a clean recording's `message` must stay the
    // bare line, or every finish grows a paragraph about an edit nobody made.
    await startRecording("nodrop");
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("nodrop", { condition: "visible", selector: { text: "Continue" } });

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "nodrop", project_root: tmpDir }
    );

    expect(finished.message).toBe('Finished recording "nodrop" flow (1 steps)');
  });

  it("keeps the verdicts a hand edit left in place", async () => {
    // The other half of the anchor rule: an edit that removes an UNwarned step
    // must not cost the steps before it their verdicts, or the guard would be
    // the length heuristic again under another name.
    await startRecording("kept");
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("kept", { condition: "visible", selector: { text: "Continue" } });
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("kept", { condition: "visible", selector: { text: "Continue" } });

    // Delete the clean step 2, then record one more warned step.
    const file = path.join(tmpDir, ".argent", "flows", "kept.yaml");
    const parsed = parseFlow(await fs.readFile(file, "utf8"));
    parsed.steps = parsed.steps.slice(0, 1);
    await fs.writeFile(file, serializeFlow(parsed), "utf8");

    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("kept", { condition: "visible", selector: { text: "Sign in" } });

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "kept", project_root: tmpDir }
    );

    expect([...verdictsIn(finished.summary).keys()]).toEqual([1, 2]);
    expect(finished.message).toContain("2 steps carry a cross-tree warning");
  });

  // ── Cancellation ─────────────────────────────────────────────────────────

  it("keeps the step when the run is cancelled during the re-probe", async () => {
    // The live await-ui-element still "passes" (the mock ignores the signal), so
    // the abort lands in the re-probe — strictly AFTER the recorded tool ran.
    // Throwing there discards the record of a step that already happened, which
    // is the thing `captureRunTarget` refuses to do from the same position.
    await startRecording("cancel");
    const controller = new AbortController();
    controller.abort();

    const result = await recordWait(
      "cancel",
      { condition: "visible", selector: { text: "Continue" } },
      { signal: controller.signal }
    );

    const warning = warningOf(result, "cancel");
    expect(warning).toContain("re-probe against the tree the RUNNER reads was cancelled");
    // Nothing was compared, so the verdict is unknown — not a divergence.
    expect(warning).toContain("UNKNOWN, not known-bad");
    expect(warning).not.toContain("does NOT hold");
    // The step the device already executed survives.
    expect(await recordedSteps("cancel")).toHaveLength(1);
    // ZERO reads. The caller's signal has to reach the POLL LOOP, not just the
    // wait for it: `waitForCondition` tests it before its first fetch, so an
    // already-cancelled call must never touch the device. Dropping `ctx.signal`
    // from the probe signal leaves `settleWithin` to report the abort while the
    // loop still issues its first read, which this number catches.
    expect(fetchCount).toBe(0);
  });

  it("aborts mid-probe in band rather than as a tool failure", async () => {
    // The abort arrives while the probe is polling, not before it starts — the
    // window the reproduction hits, and the one where a throw is both a lost
    // step and an unclassified `REGISTRY_TOOL_EXECUTION_FAILED`.
    const controller = new AbortController();
    fetchRunnerTree = async () => {
      controller.abort();
      throw new Error("cancelled mid-read");
    };
    await startRecording("cancelmid");

    const result = await recordWait(
      "cancelmid",
      { condition: "visible", selector: { text: "Continue" } },
      { signal: controller.signal }
    );

    expect(warningOf(result, "cancelmid")).toContain("was cancelled before it answered");
    expect(await recordedSteps("cancelmid")).toHaveLength(1);
  });

  // The clause tables carry no `ios-remote` arm, and this is why: a remote sim
  // never reaches the probe at all. `await-ui-element` declares no appleRemote
  // capability, so assertSupported throws while the step is still executing
  // live and flow-add-step returns no warning. If that capability is ever
  // added, both tables need an ios-remote arm — the AX-vs-full-hierarchy story
  // is the iOS one, not the generic fallback they would otherwise get.
  it("cannot be reached on ios-remote: await-ui-element refuses the device", () => {
    const tool = createAwaitUiElementTool(registryWhereWaitSucceeds());
    expect(tool.capability?.appleRemote).toBeUndefined();
    expect(() =>
      assertSupported("await-ui-element", tool.capability, resolveDevice(`remote:${IOS}`))
    ).toThrow(/not supported on ios-remote/);
  });
});
