import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DeviceInfo, Registry, ToolDefinition } from "@argent/registry";
import {
  isInjectableBundleId,
  nativeDevtoolsRef,
  type NativeDevtoolsApi,
} from "../../blueprints/native-devtools";
import {
  chooseFrontmostConnectedApp,
  inspectConnectedNativeApps,
} from "../../utils/native-target-app";
import {
  requireRecordingSession,
  appendStepToFlow,
  appIdForPlatform,
  parseFlow,
  assertSafeFlowName,
  getFlowsDir,
  describeSelector,
  type FlowSavedTo,
  type FlowSelector,
  type FlowStep,
  type RecordingSession,
} from "./flow-utils";
import {
  AWAIT_UI_ELEMENT_TOOL_ID,
  isUnmetUiWaitResult,
  vacuousHiddenSelectors,
} from "../await-ui-element";
import { AWAIT_SCREEN_IDLE_TOOL_ID } from "../await-screen-idle";
import { selectorEstablishedInSteps } from "./flow-selector-evidence";
import { runSequenceFailure } from "../run-sequence";
import { probeWhenCondition } from "./flow-actions";
import { NATIVE_READY_POLL_MS, NATIVE_READY_TIMEOUT_MS } from "./flow-run";
import { summarizeStep } from "./flow-finish-recording";
import { invokeSubTool } from "../../utils/sub-invoke";
import { settleWithin, sleepOrAbort } from "../../utils/timing";
import { resolveDevice } from "../../utils/device-info";
import { stripDeviceKeys } from "./flow-device";
import { fetchFlowTree } from "./flow-tree";
import type { DescribeFrame, DescribeNode, DescribeSource } from "../describe/contract";
import {
  nodeAtPoint,
  deriveSelector,
  selectorToFrame,
  frameContains,
  GENERIC_ROLES,
  type Selector,
  type TextMatchMode,
  type WaitCondition,
} from "../../utils/ui-tree-match";

const zodSchema = z.object({
  name: z
    .string()
    .describe("Name of the flow being recorded — the one passed to flow-start-recording."),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root of the flow being recorded — the same value passed to flow-start-recording. Together with `name` it identifies which recording this step belongs to."
    ),
  command: z.string().describe('MCP tool name (e.g. "gesture-tap", "screenshot", "launch-app")'),
  args: z
    .string()
    .optional()
    .describe(
      'Tool arguments as a JSON string, e.g. \'{"udid": "ABC", "x": 0.5, "y": 0.3}\'. Omit for tools with no arguments.'
    ),
  delayMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Milliseconds to sleep before executing this step during replay."),
});

// The full-hierarchy source replay gates on per platform (`treeSourceGate` in
// flow-run.ts). A capture from the fallback source was derived against a tree
// the replay will refuse to degrade to, so the selector deserves a caveat even
// when it derives cleanly. Chromium/Vega have a single source — no caveat.
const REPLAY_TREE_SOURCES: Record<string, DescribeSource> = {
  ios: "native-devtools",
  android: "android-devtools",
};

function fallbackSourceWarning(source: DescribeSource, platform: string): string | undefined {
  const expected = REPLAY_TREE_SOURCES[platform];
  if (!expected || source === expected) return undefined;
  return `selector captured from the fallback ${source} tree (${expected} unavailable) — replay resolves against the full hierarchy, which may not match it`;
}

/**
 * Recording has no counterpart to replay's launch readiness gate
 * (`waitForNativeDevtools` in flow-run.ts): a live `restart-app` returns before
 * the injected dylib dials back, so a tap recorded right after it would read
 * the tree before the app has connected and silently keep coordinates. Ride
 * out that window: when the recording has a leading launch, poll the exact
 * bundle's synchronous connection bit (the same check replay uses); otherwise
 * poll until auto-targeting finds one connected, foreground-like app. Stop when
 * the budget lapses, then let the single tree read report whatever is really
 * there. The budget mirrors replay's NATIVE_READY_TIMEOUT_MS: a cold start the
 * replay gate would ride out, recording rides out too. When the app was never
 * Argent-launched this adds one budget's worth of latency before the (accurate)
 * capture warning; that beats silently downgrading a post-launch tap.
 */
type CaptureReadiness = "ready" | "unavailable" | "timed-out" | "aborted";

// A third-party app started outside Argent can never connect during the active
// recording. Remember one exhausted/unavailable readiness probe per device and
// session so a 20-tap walkthrough does not pay the full budget 20 times. A
// successful tree read below or a successful app launch/restart clears the
// entry, allowing recovery when instrumentation becomes available later.
const captureReadinessMisses = new WeakMap<RecordingSession, Set<string>>();

function readinessMissesFor(session: RecordingSession): Set<string> {
  let misses = captureReadinessMisses.get(session);
  if (!misses) {
    misses = new Set<string>();
    captureReadinessMisses.set(session, misses);
  }
  return misses;
}

async function awaitIosDevtoolsTarget(
  registry: Registry,
  device: DeviceInfo,
  bundleId?: string,
  signal?: AbortSignal
): Promise<CaptureReadiness> {
  if (signal?.aborted) return "aborted";
  let api: NativeDevtoolsApi;
  try {
    const ndRef = nativeDevtoolsRef(device);
    api = await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options);
  } catch {
    return signal?.aborted ? "aborted" : "unavailable";
  }
  const deadline = Date.now() + NATIVE_READY_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) return "aborted";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timed-out";

    if (bundleId) {
      try {
        if (api.isConnected(bundleId)) return "ready";
      } catch {
        // Treat a transient connection read as not-ready and keep polling.
      }
    } else {
      // Fragment auto-targeting must inspect app state, whose RPC can itself
      // wedge. Race it against the remaining budget so the advertised
      // 8-second gate stays a hard cap rather than 8 seconds between
      // potentially multi-second getAppState calls.
      const inspected = await settleWithin(inspectConnectedNativeApps(api), remaining, signal);
      if (inspected.type === "aborted") return "aborted";
      if (inspected.type === "timeout") return "timed-out";
      if (inspected.type === "value" && chooseFrontmostConnectedApp(inspected.value)) {
        return "ready";
      }
    }

    const delayMs = Math.min(NATIVE_READY_POLL_MS, deadline - Date.now());
    if (delayMs <= 0) return "timed-out";
    if (!(await sleepOrAbort(delayMs, signal))) return "aborted";
  }
}

function leadingLaunch(session: RecordingSession): Extract<FlowStep, { kind: "launch" }> | null {
  const first = session.flow.steps.find((step) => step.kind !== "echo");
  return first?.kind === "launch" ? first : null;
}

function recordedLaunchApp(session: RecordingSession, platform: string): string | null {
  const launch = leadingLaunch(session);
  return launch ? appIdForPlatform(launch.app, platform) : null;
}

function invalidateReadinessMissAfterAppStart(
  session: RecordingSession,
  command: string,
  args: Record<string, unknown>,
  result: unknown
): void {
  const didStart =
    typeof result === "object" &&
    result !== null &&
    ((command === "restart-app" && (result as { restarted?: unknown }).restarted === true) ||
      (command === "launch-app" && (result as { launched?: unknown }).launched === true));
  if (!didStart) return;

  const misses = readinessMissesFor(session);
  // Both tools require a device id, but clearing all misses is the safe fallback
  // for older/custom registry adapters that omit it: a successful app start is
  // fresh evidence and another bounded probe is preferable to a stale miss.
  if (typeof args.udid === "string") misses.delete(args.udid);
  else misses.clear();
}

function platformOf(udid: unknown): string | undefined {
  try {
    if (typeof udid === "string") return resolveDevice(udid).platform;
  } catch {
    // Unresolvable device — callers fall back to platform-neutral wording.
  }
  return undefined;
}

/**
 * How to read the tree the RUNNER resolves against, on this device's platform.
 *
 * `native-find-views` declares Apple capability only, so naming it to an
 * Android or Chromium author points at a tool they cannot call — and the
 * refusals that quote it are the ones an author most needs to act on.
 */
function treeReaderFor(udid: unknown): string {
  const platform = platformOf(udid);
  if (platform === "ios" || platform === "ios-remote") return "`native-find-views`/`describe`";
  if (platform === "chromium") return "`describe` (this platform's DOM walker)";
  return "`describe`";
}

/**
 * WHY the recorder's tree and the runner's tree can disagree — which is a
 * different story per platform, and stating the iOS one everywhere makes the
 * message false exactly where the author is trying to act on it.
 */
function treeDivergenceFor(udid: unknown): string {
  const platform = platformOf(udid);
  if (platform === "ios" || platform === "ios-remote") {
    return (
      "The recorder reads the accessibility tree and the runner reads the full native view " +
      "hierarchy; they overlap but neither contains the other."
    );
  }
  if (platform === "chromium") {
    return (
      "Both read the same DOM, but the flow tree keeps only addressable nodes — an element with " +
      "no id, label, value, clickable or focused state never reaches the runner."
    );
  }
  if (platform === "android") {
    return (
      "The recorder reads the trimmed accessibility tree and the runner reads the full " +
      "hierarchy including not-important views; each holds elements the other drops."
    );
  }
  return "The recorder and the runner read different projections of the screen.";
}

function abortError(): Error {
  const err = new Error("flow-add-step aborted before the recorded tool was executed");
  err.name = "AbortError";
  return err;
}

/**
 * The recorder and the runner read DIFFERENT trees. `await-ui-element`
 * evaluates against the accessibility tree; the `await:`/`assert:` DIRECTIVE
 * that polish converts this step into is evaluated against the runner's tree.
 * They overlap but neither contains the other — an id present in one can be
 * absent from the other, and on iOS even the role vocabularies are disjoint.
 * So a check can pass live and fail once converted, which makes "each step is
 * executed live so you verify it works" untrue exactly where it matters.
 *
 * Re-probe the same condition against the runner's tree and report the answer.
 * It is a WARNING, never a refusal: the step is recorded as a raw
 * `tool: await-ui-element`, and at replay that tool reads the SAME
 * accessibility tree it just passed against — so "it would fail every run" was
 * false for the form actually written. What the probe really tells the author
 * is whether the conversion is safe, which is a polish-time decision, and the
 * blocking audit is where a flow is held to it.
 */
async function probeAgainstRunnerTree(
  registry: Registry,
  ctx: Parameters<typeof invokeSubTool>[1],
  args: Record<string, unknown>
): Promise<{ warning?: string }> {
  const selector = args.selector;
  const condition = args.condition;
  if (typeof condition !== "string" || selector === null || typeof selector !== "object") {
    return {};
  }
  if (typeof args.udid !== "string") return {}; // nothing to probe against
  let device: DeviceInfo;
  try {
    device = resolveDevice(args.udid);
  } catch {
    return {}; // unresolvable device; the live result stands
  }
  const outcome = await probeWhenCondition(
    // The signal rides on ActionEnv separately from `ctx`, so pass it too:
    // a cancelled flow-add-step must stop this probe rather than polling on.
    { registry, ctx, device, signal: ctx?.signal },
    {
      condition: condition as WaitCondition,
      selector: selector as FlowSelector,
      expectedText: typeof args.expectedText === "string" ? args.expectedText : undefined,
      textMatch: args.textMatch as TextMatchMode | undefined,
    }
  );
  if (outcome.ok) return {};
  if (outcome.aborted) throw abortError();
  if (outcome.indeterminate) {
    return {
      // No trailing period: the caller joins this with ". " and a second one
      // renders as "..". And no claim that the two trees DIFFER — nothing was
      // compared. The runner's tree could not be read at all, which is an
      // environment failure; reporting it as a known divergence sends the
      // author to rewrite a selector that may be perfectly good.
      warning:
        `this check could not be re-verified against the tree the RUNNER reads ` +
        `(${outcome.reason}), so it passed against the accessibility tree only. Whether it ` +
        `would convert to \`await:\`/\`assert:\` is UNKNOWN, not known-bad — re-probe once that ` +
        `tree source is back before trusting the conversion`,
    };
  }
  return {
    warning:
      `recorded, but this condition does NOT hold against the tree the runner resolves ` +
      `directives against (${outcome.reason ?? "no match"}). As the raw ` +
      `\`tool: ${AWAIT_UI_ELEMENT_TOOL_ID}\` step it replays fine — it reads the same tree it ` +
      `just passed against — but converting it to \`await:\`/\`assert:\` at polish WILL fail. ` +
      `Either keep it raw deliberately, or re-record the wait with a selector present in both`,
  };
}

/**
 * A tap target has to be small enough that tapping its CENTRE reproduces the
 * tap. Frames are normalized to the viewport, so this is a share of the screen.
 *
 * The number is a judgement, and the two failures it sits between are both
 * real and both were observed. Too permissive and a container gets recorded:
 * a tap on blank space in a drawer resolved to the drawer's whole scroll area
 * (0.72 of the screen), and replay — which taps a selector's centre — hit the
 * "Chat" item and reported pass while navigating somewhere the walkthrough
 * never went. Too strict and ordinary widgets become unrecordable: a feed post
 * is half the screen and tapping it is a perfectly normal QA step.
 */
const MAX_TAP_TARGET_AREA = 0.6;

function isContainerSized(frame: DescribeFrame): boolean {
  return frame.width * frame.height > MAX_TAP_TARGET_AREA;
}

/**
 * Narrower forms of a selector that resolved to the WRONG element, best first.
 *
 * A derived selector is the plainest thing that describes the tapped node, so
 * on a screen with repeats — a "Search" label shared by a field and a tab — it
 * is ambiguous rather than absent. Ambiguity is not the same failure as "this
 * element cannot be addressed", and it must not be answered with coordinates:
 * the runner resolves either of these forms.
 *
 * Only the node's OWN attributes are added — its role, then its identifier
 * when the text was chosen over one. A `within` scope is deliberately NOT
 * derived here, even though it would separate one feed row's button from
 * another's: the flow tree is flattened, so a container can only be found
 * geometrically, and geometry is z-order blind. With a modal open, the
 * background screen's elements are still the smallest nodes under the point
 * and the FOREGROUND modal's container is a perfectly good geometric
 * ancestor — a tap on the composer's text input recorded as a feed post
 * "inside" the composer, which then failed on any screen whose feed content
 * differed. The scopes that survive are the ones an author writes knowingly
 * at polish, against a container they have chosen.
 */
function narrowedSelectors(node: DescribeNode, base: Selector): Selector[] {
  const out: Selector[] = [];
  if (base.role === undefined && node.role && !GENERIC_ROLES.has(node.role.toLowerCase())) {
    out.push({ ...base, role: node.role });
  }
  if (base.identifier === undefined && node.identifier?.trim()) {
    out.push({ ...base, identifier: node.identifier });
  }
  return out;
}

/**
 * Would replaying this selector reproduce the tap?
 *
 * Two things have to hold, and it is worth saying why it is not one.
 *
 * The frame must CONTAIN the tapped point — otherwise the selector matched
 * some other element and lost the ranking, so the step targets the wrong
 * control from the start.
 *
 * And the frame must be small enough to be a control rather than a container
 * (see {@link MAX_TAP_TARGET_AREA}), because replay taps its CENTRE, not the
 * point recorded here. A tap on blank space inside a drawer resolved to the
 * drawer's whole scroll area and replayed onto the "Chat" item, reporting
 * pass while navigating somewhere the walkthrough never went.
 *
 * What this deliberately does NOT do is require the centre to resolve back to
 * the same tree node. That test was tried and is wrong on a FLATTENED tree: a
 * control's own label is a SIBLING rect sitting on its centre, so a like
 * button, a search field, a full-width row and every grid cell were refused —
 * while replaying perfectly, because the touch is still inside the control.
 * Node identity cannot tell a label from an independent control; size can tell
 * a control from a container, which is the distinction that matters here.
 */
function replayReproducesTap(
  frame: DescribeFrame,
  point: { x: number; y: number }
): "ok" | "container" | "retargets" {
  if (isContainerSized(frame)) return "container";
  if (!frameContains(frame, point.x, point.y)) return "retargets";
  return "ok";
}

/**
 * For a recorded `gesture-tap`, look up the element under the tapped point and
 * record a portable `tap: { selector }` step instead of raw coordinates.
 * Returns the selector (possibly with a caveat warning), or a warning
 * describing why coordinates were kept.
 *
 * The lookup reads `fetchFlowTree` — the same tree source the runner resolves
 * selectors against at replay — NOT the agent-facing describe tree. The two
 * differ exactly where recording matters: on iOS the AX tree collapses an
 * `accessible` container into one leaf whose merged label exists on no single
 * view in the replay hierarchy, and on Android the interactables trim drops
 * the testID-only containers the replay tree keeps. A selector derived from
 * the describe tree could fail — or hit a different element — at replay while
 * recording reported success.
 */
async function captureTapSelector(
  registry: Registry,
  session: RecordingSession,
  udid: string,
  point: { x: number; y: number },
  signal?: AbortSignal
): Promise<{ selector?: Selector; warning?: string; ambiguous?: boolean }> {
  try {
    const device = resolveDevice(udid);
    // iOS's tree source connects asynchronously after launch — absorb the
    // post-restart-app window replay's launch gate covers (see above). Apple
    // system apps can never connect, and an exhausted probe is cached for this
    // recording session so later taps do not each wait another full budget.
    if (device.platform === "ios") {
      const misses = readinessMissesFor(session);
      const launchApp = recordedLaunchApp(session, device.platform);
      if (!misses.has(device.id) && (!launchApp || isInjectableBundleId(launchApp))) {
        const readiness = await awaitIosDevtoolsTarget(
          registry,
          device,
          launchApp ?? undefined,
          signal
        );
        if (readiness === "aborted") throw abortError();
        if (readiness !== "ready") misses.add(device.id);
      }
    }
    if (signal?.aborted) throw abortError();
    const { tree, source } = await fetchFlowTree(registry, device);
    readinessMissesFor(session).delete(device.id);
    const node = nodeAtPoint(tree, point);
    if (!node) return { warning: "no element found under the tap" };
    const selector = deriveSelector(node);
    if (!selector) return { warning: "tapped element has no stable text/id" };
    // Replay resolves through selectorToFrame, whose ranking (exact match →
    // smallest frame → reading order) is free to elect a DIFFERENT element
    // than the tapped one — e.g. the same label on an earlier row. Re-resolve
    // now and require the winning frame to cover the tapped point; otherwise
    // the recorded step would silently retarget, and coordinates are safer.
    const resolved = selectorToFrame(tree, selector);
    if (!resolved) {
      // Defensive: a selector derived from a visible node matches that node
      // under matchNode's semantics, so re-resolving the same tree should
      // always find something. Keep the guard (and an accurate message) in
      // case derivation and matching ever drift apart again.
      return {
        warning: `selector ${describeSelector(selector)} matches no element on this screen`,
      };
    }
    const verdict = replayReproducesTap(resolved, point);
    if (verdict === "container") {
      // The tap landed on a container rather than a control — on some trees a
      // point on empty margin resolves to the screen root itself, which is
      // addressable and looks like a perfectly good `{ id: <screen> }`.
      // Narrowing cannot help: the problem is the element, not the selector.
      return {
        warning:
          `the tap landed on ${describeSelector(selector)}, which covers most of the screen — ` +
          `it is a container, not a control, and replay taps a selector's CENTRE, so a step ` +
          `recorded with it would fire somewhere else entirely`,
      };
    }
    if (verdict === "retargets") {
      // The selector matches the tapped element AND something else, and ranks
      // the other one first. Narrow it before giving up — the runner resolves
      // either narrower form, so answering ambiguity with coordinates would
      // throw away a perfectly good target.
      for (const candidate of narrowedSelectors(node, selector)) {
        const frame = selectorToFrame(tree, candidate);
        if (frame && replayReproducesTap(frame, point) === "ok") {
          return { selector: candidate, warning: fallbackSourceWarning(source, device.platform) };
        }
      }
      return {
        ambiguous: true,
        warning:
          `selector ${describeSelector(selector)} also matches another element on this screen, ` +
          `and ranks it first — adding the tapped element's role or identifier did not single ` +
          `it out`,
      };
    }
    return { selector, warning: fallbackSourceWarning(source, device.platform) };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    return {
      warning: `selector capture failed (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * How far the recording has got, without mutating anything — for responses
 * that record nothing but must still say where the flow stands. Host mode
 * re-reads the file so manual edits made mid-recording are honored; client
 * mode's in-memory copy is authoritative.
 *
 * Deliberately NOT the flow's YAML. Returning the whole growing file on every
 * call made the recorder the single largest consumer of a session's context,
 * and that pressure was observed removing checks from tests. The full file
 * comes back once, from `flow-finish-recording`.
 */
async function activeFlowState(
  session: RecordingSession
): Promise<{ stepCount: number; note?: string }> {
  if (session.persist === "host") {
    try {
      session.flow = parseFlow(await fs.readFile(session.filePath, "utf8"));
    } catch (err) {
      return {
        stepCount: session.flow.steps.length,
        note:
          `The persisted flow could not be read and parsed (${err instanceof Error ? err.message : String(err)}); ` +
          `the step count is from the last valid in-memory snapshot.`,
      };
    }
  }
  return { stepCount: session.flow.steps.length };
}

/**
 * `command` names an MCP tool, but the names an author has in mind while
 * recording are the flow file's own directives — so `command: "echo"` reaches
 * here and the registry answers "Tool not found", which says nothing about
 * what to do instead. Name the tool that records that directive.
 */
interface DirectiveHint {
  /** The tool to call instead. */
  tool: string;
  /**
   * Whether the recorder REWRITES that tool call into this directive. Only the
   * commands the step-shaping switch handles are rewritten; everything else is
   * stored as a raw `tool:` step that the polish pass converts. Claiming a
   * rewrite that does not happen sends the author looking for a directive that
   * is not in the file.
   */
  rewritten: boolean;
}

const DIRECTIVE_COMMAND_HINTS: Record<string, DirectiveHint> = {
  tap: { tool: "gesture-tap", rewritten: true },
  launch: { tool: "restart-app", rewritten: true },
  run: { tool: "flow-execute", rewritten: true },
  type: { tool: "keyboard", rewritten: false },
  await: { tool: AWAIT_UI_ELEMENT_TOOL_ID, rewritten: false },
  assert: { tool: AWAIT_UI_ELEMENT_TOOL_ID, rewritten: false },
  // `echo`, `wait` and `long-press` are deliberately absent — each needs an
  // answer this table cannot express, so `directiveCommandHint` handles them
  // directly: `echo` is recorded by a tool called on its OWN (routing it
  // through flow-add-step records a second, replay-breaking step), and neither
  // `wait` nor `long-press` has a recording tool at all.
};

/**
 * Recorder tools, which must never be `flow-add-step`'s `command`. Each one
 * mutates the recording itself, so running it as a nested step records the
 * action twice — once as the directive the inner tool wrote, once as a raw
 * `tool:` step that re-runs it at replay, when no recording is open.
 */
const NESTED_RECORDER_TOOLS: Record<string, string> = {
  "flow-add-echo":
    "`flow-add-echo` records a step itself, so it must be called DIRECTLY, not through " +
    "flow-add-step — nesting it would write the echo AND a `tool: flow-add-echo` step that " +
    "fails on every replay.",
  "flow-add-step":
    "flow-add-step cannot record itself. Pass the MCP tool you want to execute as `command`.",
  "flow-start-recording":
    "`flow-start-recording` truncates the flow it names. Recording it as a step would erase " +
    "this flow at replay; call it directly when you want to start a recording.",
  "flow-finish-recording":
    "`flow-finish-recording` ends the recording, so it cannot also be a step in it. Call it " +
    "directly when the walkthrough is complete.",
};

/**
 * Whether an invocation failed because the registry has no such tool, as
 * opposed to the tool itself failing. Keyed on the message because the
 * registry throws a plain Error; a false negative only costs the nicer
 * message, and a false positive is impossible for a tool that ran.
 */
function isToolNotFound(err: unknown, command: string): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return m.includes("not found") && m.includes(command.toLowerCase());
}

function directiveCommandHint(command: string): string | undefined {
  if (command === "echo") {
    return (
      `"echo" is a flow directive, not a tool. Call \`flow-add-echo\` DIRECTLY — not through ` +
      `flow-add-step, which would run it as a nested tool AND record a \`tool: flow-add-echo\` ` +
      `step that fails on every replay.`
    );
  }
  if (command === "wait") {
    return (
      `"wait" is a flow directive, not a tool, and there is no tool that records one — a fixed ` +
      `sleep is not a readiness signal. Record the thing you are actually waiting for with ` +
      `\`${AWAIT_UI_ELEMENT_TOOL_ID}\` instead.`
    );
  }
  if (command === "long-press") {
    return (
      `"long-press" is a flow directive, not a tool, and no tool records one — there is no ` +
      `gesture-long-press. Record the rest of the path, then add the \`long-press:\` step by ` +
      `hand during polish and prove it with the replay.`
    );
  }
  const hint = DIRECTIVE_COMMAND_HINTS[command];
  if (!hint) return undefined;
  return (
    `"${command}" is a flow directive, not a tool. Record it by calling \`${hint.tool}\` ` +
    `through flow-add-step` +
    (hint.rewritten
      ? ` — the recorder rewrites it into the \`${command}:\` step for you.`
      : `. It is stored as a raw \`tool: ${hint.tool}\` step; converting it to \`${command}:\` ` +
        `is part of the polish pass.`)
  );
}

/**
 * What to do about a tap whose selector could not be captured, now that the
 * raw point has been kept.
 *
 * Two different failures, and they call for opposite responses: an element
 * nothing can address, versus one that several things address equally. Saying
 * "no selector could be derived" for the second sends the author to
 * re-discover a selector they already have. The advice rides on the recorded
 * step's warning because that is the only moment it is read while the screen
 * is still there to retarget against — a coordinate step replays fine today
 * and breaks on the first layout change, which is why the skills treat this
 * warning as a stop rather than a note.
 */
function coordinateRemedy(captured: { ambiguous?: boolean }, udid: unknown): string {
  return captured.ambiguous
    ? `Disambiguate it: give the intended element its own testID, or tap a target whose id is ` +
        `unique on this screen. At polish, a hand-written \`within\`/\`after\`/\`next\` scope can ` +
        `also single out the element this point hit.`
    : `Find the real target with ${treeReaderFor(udid)} and tap its centre; an element with no ` +
        `id or label is usually worth fixing in the app.`;
}

function rawCoordinateWarning(
  command: string,
  args: Record<string, unknown>,
  delayMs: number | undefined
): string | undefined {
  if (command === "gesture-tap" && delayMs !== undefined) {
    return (
      "gesture-tap was kept as a raw coordinate tool step because flow-add-step delayMs prevents " +
      "selector capture; remove delayMs, add a separate wait step before the tap if the pre-action " +
      "delay is necessary, then record the tap again"
    );
  }
  if (command === "restart-app" && delayMs !== undefined) {
    return (
      "restart-app was kept as a raw tool step because flow-add-step delayMs prevents the launch rewrite; " +
      "remove delayMs so restart-app records as the leading launch, then record a post-launch " +
      "await-ui-element readiness gate"
    );
  }
  if (command === "gesture-custom") {
    return (
      "gesture-custom was recorded with raw coordinates because it has no selector-capture rewrite; " +
      "if it contains a tap, record that tap individually with gesture-tap so selector capture can run"
    );
  }
  if (
    command === "run-sequence" &&
    Array.isArray(args.steps) &&
    args.steps.some(
      (step) =>
        typeof step === "object" &&
        step !== null &&
        (step as { tool?: unknown }).tool === "gesture-tap"
    )
  ) {
    return (
      "run-sequence contains coordinate taps and was recorded as one opaque raw step; record taps " +
      "individually so each can become a tap selector"
    );
  }
  return undefined;
}

/**
 * True when the flow being recorded has ALREADY established this selector
 * positively — acted on it, or proved it present — in an earlier step.
 *
 * This is what makes a later `hidden` check falsifiable. The wait tool itself
 * can only see its own poll window, so an element removed by the immediately
 * preceding action reads as "never matched" even though the flow proves it
 * existed two steps ago. Without this lookup the recorder would reject the
 * correct authoring order (prove visible -> act -> prove gone) and push authors
 * into adding absence checks by hand in YAML, which the skill forbids.
 */
function selectorEstablishedInFlow(session: RecordingSession, selector: unknown): boolean {
  return selectorEstablishedInSteps(session.flow.steps, selector);
}

function flowExecuteRecordBlock(
  result: unknown
): { reason: string; mayHaveMutated: boolean } | null {
  if (typeof result !== "object" || result === null) return null;
  const value = result as { ok?: unknown; notice?: unknown };
  if (value.ok === false) {
    return { reason: "flow-execute returned ok: false", mayHaveMutated: true };
  }
  if (Object.prototype.hasOwnProperty.call(value, "notice")) {
    return {
      reason:
        typeof value.notice === "string"
          ? `flow-execute returned a prerequisite notice: ${value.notice}`
          : "flow-execute returned a prerequisite notice without executing steps",
      mayHaveMutated: false,
    };
  }
  return null;
}

function partialMutationWarning(command: "flow-execute" | "run-sequence"): string {
  const stepKind = command === "flow-execute" ? "composed" : "nested";
  return (
    `Prior ${stepKind} steps may already have mutated device state. ` +
    "Restore the device to the state produced by the recorded prefix before adding another " +
    "step, or the remaining recording may not be reproducible."
  );
}

function runSequenceProgress(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const { completed, total } = result as { completed?: unknown; total?: unknown };
  return typeof completed === "number" && typeof total === "number"
    ? `${completed}/${total} nested steps completed`
    : null;
}

// Replaying a fragment to set up state during recording is done by running it
// through `flow-execute`. Recorded verbatim that becomes a brittle
// `tool: flow-execute` step (baked-in project_root + device, no portability).
// Instead, capture it as a `run: <name>` composition directive — mirroring the
// gesture-tap → tap rewrite.
const RUN_TARGET_COMMAND = "flow-execute";

/**
 * The flows dir of a root, or null if it is not a valid one. Used only to
 * compare the executed flow's project against the recording's — a comparison
 * that decides a warning, never whether the step is recorded — so a throw here
 * must not escape into {@link captureRunTarget}'s catch, which would divert an
 * already-resolved target into the keep-the-raw-step branch.
 *
 * Nothing reaching it today can be malformed. `captureRunTarget` runs only
 * after the nested `flow-execute` has already RETURNED, so its `project_root`
 * cleared both `Registry.invokeTool`'s zod parse (`project_root: z.string()`)
 * and flow-execute's own `getFlowsDir` → `assertValidProjectRoot`, which is
 * unconditional and ahead of every early return there. The guard stays because
 * what a throw here would cost is decided by the enclosing catch rather than by
 * this function, and that coupling is the fragile part, not the input.
 */
function safeFlowsDir(root: string): string | null {
  try {
    return getFlowsDir(root);
  } catch {
    return null;
  }
}

/**
 * For a recorded `flow-execute` call, decide whether to record it as a
 * `run: <name>` directive. Returns the flow name to compose, or a warning
 * explaining why the raw `flow-execute` step was kept.
 *
 * `run:` composes any sibling flow — fragment or e2e — resolved in the
 * recording's `.argent/flows` dir (host-resolved composition, design §12). An
 * e2e target's `launch` simply runs inline. So we keep the raw step only when
 * the target can't be resolved as a sibling, or the recording is remote (the
 * host can't read the client's sibling files to validate).
 */
async function captureRunTarget(
  session: RecordingSession,
  args: Record<string, unknown>
): Promise<{ flow?: string; warning?: string }> {
  const name = args.name;
  if (typeof name !== "string") {
    return { warning: "flow-execute call had no flow name; kept the raw step" };
  }
  if (session.persist !== "host") {
    return {
      warning: `kept the raw flow-execute step — run: composition is host-resolved, so a remote recording can't reference "${name}" portably`,
    };
  }
  try {
    assertSafeFlowName(name);
    // Resolve against THIS recording's own flows dir: `run:` composes siblings
    // of the flow being recorded, which is not necessarily the project the
    // nested flow-execute ran in. Parsing validates the sibling exists and is a
    // well-formed flow; a failure falls through to keeping the raw step.
    const flowsDir = path.dirname(session.filePath);
    const fragPath = path.join(flowsDir, `${name}.yaml`);
    parseFlow(await fs.readFile(fragPath, "utf8"));
    // Same name, two projects: the sibling that will run at REPLAY is a
    // different file from the one that just ran LIVE. Recording `run:` is still
    // correct — composition is defined against the recording's own siblings —
    // but concurrent agents record across projects now, and generic fragment
    // names ("login", "setup") are exactly the ones that exist in both. Say it,
    // or the substitution stays invisible until the flow replays wrong.
    const ranIn = args.project_root;
    // null means "not a usable project root" (unparseable or absent), which is
    // not evidence of a different project — only a resolvable, differing dir
    // is. Neither null branch is reachable from a returned `flow-execute` (see
    // {@link safeFlowsDir}); they keep the warning silent rather than wrong if
    // one ever becomes so.
    const ranDir = typeof ranIn === "string" ? safeFlowsDir(ranIn) : null;
    const ranElsewhere = ranDir !== null && ranDir !== flowsDir;
    return {
      flow: name,
      warning: ranElsewhere
        ? `recorded "run: ${name}", which replays THIS project's ${name}.yaml — the step ran ${name} from ${String(ranIn)}, a different project`
        : undefined,
    };
  } catch (err) {
    return {
      warning: `could not resolve "${name}" as a sibling fragment (${err instanceof Error ? err.message : String(err)}); kept the raw flow-execute step`,
    };
  }
}

export function createFlowAddStepTool(registry: Registry): ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    message: string;
    toolResult: unknown;
    stepCount: number;
    recorded?: string;
    savedTo?: FlowSavedTo;
  }
> {
  return {
    id: "flow-add-step",
    interaction: {
      // Name the flow: recordings are concurrent, so several of these lines can
      // interleave in one log and "the recorded flow" would not identify which.
      startedMsg: ({ params }) => `Adding ${params.command} step to flow ${params.name}`,
      completedMsg: ({ params }) => `Added ${params.command} step to flow ${params.name}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to add ${params.command} step to flow ${params.name}: ${failureSignal.error_code}`,
    },
    description: `Execute a tool call and record it as a step in the flow named by \`name\` + \`project_root\` (the recording must already be open — see flow-start-recording). Use when recording a flow and you want to run and capture each action. A coordinate \`gesture-tap\` is recorded as a portable \`tap: { selector }\` step when the tapped element has stable text/identifier (otherwise coordinates are kept with a warning); a \`restart-app\` is recorded as a \`launch\` step (record one FIRST to make the flow a self-contained e2e flow).
Returns { message, toolResult, stepCount, recorded, savedTo } - \`recorded\` is the one line that was appended, and \`stepCount\` how many steps the flow now has. The flow's full YAML is deliberately NOT returned per step; read it back from \`flow-finish-recording\`. \`savedTo\` is where the YAML landed: a host path, or, against a remote client, the directive that has the client write it (the only field naming the destination in that mode). If it fails an error is returned and nothing is recorded.
If a step was recorded by mistake, remove it from the .yaml after \`flow-finish-recording\` — editing the file while the recording is active can be overwritten by the in-memory copy.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params, ctx) {
      const session = requireRecordingSession(params.project_root, params.name);
      const args: Record<string, unknown> = params.args ? JSON.parse(params.args) : {};

      // Selector capture must read the tree BEFORE the tap runs: a navigating
      // tap (e.g. a list row that opens a detail screen) replaces the screen, so
      // the tapped element is gone by the time the tap returns. Resolve the
      // element under the point against the pre-tap tree, then execute.
      const isTap =
        params.command === "gesture-tap" &&
        params.delayMs === undefined &&
        typeof args.udid === "string" &&
        typeof args.x === "number" &&
        typeof args.y === "number";

      // A recorder tool is not a step. Nesting one appends TWICE — the inner
      // tool writes its own directive and this call additionally records a
      // raw `tool: <recorder>` step, which then fails on every replay because
      // no recording is open then. It reports success either way, so nothing
      // signals the corruption; refuse before anything is written.
      const nested = NESTED_RECORDER_TOOLS[params.command];
      if (nested) {
        const { stepCount, note } = await activeFlowState(session);
        return {
          message: `${nested} Nothing was executed and no step was recorded.${note ? ` ${note}` : ""}`,
          toolResult: undefined,
          stepCount,
          savedTo: session.filePath,
        };
      }

      let captured: { selector?: Selector; warning?: string; ambiguous?: boolean } | undefined;
      if (isTap) {
        captured = await captureTapSelector(
          registry,
          session,
          args.udid as string,
          {
            x: args.x as number,
            y: args.y as number,
          },
          ctx?.signal
        );
      }

      // A disconnect during the readiness poll must cancel the live action,
      // not merely stop polling and execute the tap anyway.
      if (ctx?.signal?.aborted) throw abortError();

      let toolResult: unknown;
      try {
        toolResult = await invokeSubTool(registry, ctx, params.command, args);
      } catch (err) {
        // `command` names an MCP tool, but the vocabulary an author has in
        // mind while recording is the flow file's own directives — so
        // `command: "echo"` lands here as a bare "Tool not found", which says
        // nothing about what to do instead. Only rewrite a genuine not-found:
        // a tool that ran and failed must report its own error.
        const hint = isToolNotFound(err, params.command)
          ? directiveCommandHint(params.command)
          : undefined;
        if (!hint) throw err;
        const { stepCount, note } = await activeFlowState(session);
        return {
          message: `${hint} Nothing was executed and no step was recorded.${note ? ` ${note}` : ""}`,
          toolResult: undefined,
          stepCount,
          savedTo: session.filePath,
        };
      }
      invalidateReadinessMissAfterAppStart(session, params.command, args, toolResult);

      // An `await-ui-element` whose condition never held reports
      // { success: false } instead of throwing — the same shape flow-run and
      // run-sequence special-case to stop a sequence. Without this gate the
      // wait would record as a passing step and bake a gate that fails every
      // replay. Hand the full result back, record nothing.
      if (isUnmetUiWaitResult(params.command, toolResult)) {
        const { stepCount, note } = await activeFlowState(session);
        const waitNote = (toolResult as { note?: unknown }).note;
        const cancelled = ctx?.signal?.aborted === true;
        return {
          message: cancelled
            ? `await-ui-element was cancelled — step NOT recorded${typeof waitNote === "string" ? `: ${waitNote}` : ""}.${note ? ` ${note}` : ""}`
            : "await-ui-element condition not met — step NOT recorded. Fix the wait (a longer " +
              `timeoutMs or a different selector) and re-run this flow-add-step call.${note ? ` ${note}` : ""}`,
          toolResult,
          stepCount,
          savedTo: session.filePath,
        };
      }

      // `await-screen-idle` reports "did not settle" as a SOFT `settled: false`
      // rather than a failure, so persisting it bakes a step that is green on
      // every replay whatever the screen does — the same unfalsifiable class
      // the `hidden` gate below exists to block. The skills already say never
      // to persist it; without this gate the recorder did it silently.
      if (params.command === AWAIT_SCREEN_IDLE_TOOL_ID) {
        const { stepCount, note } = await activeFlowState(session);
        const settled = (toolResult as { settled?: unknown }).settled;
        return {
          message:
            "`await-screen-idle` is a live diagnostic, not a gate — step NOT recorded. It " +
            "reports a screen that never settled as `settled: false` instead of failing, so a " +
            "recorded one passes on every replay no matter what the screen does" +
            (settled === false ? " — and it just reported `settled: false`" : "") +
            ". Record readiness as the element you actually need next (`await-ui-element`), or " +
            "add `await: { idle: true }` during polish, which FAILS when the screen never " +
            `settles.${note ? ` ${note}` : ""}`,
          toolResult,
          stepCount,
          savedTo: session.filePath,
        };
      }

      // A `hidden` wait that passed without the selector EVER matching is not
      // proof of dismissal — it is a check that cannot fail. Recorded, it
      // becomes a permanently-green gate: a typo'd selector, a renamed id, or
      // the wrong screen all satisfy it.
      //
      // "Ever matched" is scoped to the wait's own poll window, which is too
      // narrow on its own: the action that removes an element runs BEFORE the
      // check, so the normal authoring order (prove visible -> act -> prove
      // gone) always reaches here with everMatched false. The flow itself is
      // the wider evidence — if an earlier recorded step established this
      // selector, the check is falsifiable and is recorded.
      //
      // Read from `vacuousHiddenSelectors` rather than the wait's own args, so
      // a wait NESTED in a `run-sequence` is judged too. Refusing only the
      // direct call left the gate one wrapper away from being bypassed.
      const vacuousHidden = vacuousHiddenSelectors(params.command, toolResult, args).filter(
        (selector) => !selectorEstablishedInFlow(session, selector)
      );
      if (vacuousHidden.length > 0) {
        const { stepCount, note } = await activeFlowState(session);
        const wrapped = params.command !== AWAIT_UI_ELEMENT_TOOL_ID;
        return {
          message:
            `the \`hidden\` condition was met without the selector ever matching, and no earlier ` +
            `step in this flow established it — step NOT recorded.${
              wrapped
                ? ` (Inside the \`${params.command}\` you passed; wrapping the wait does not make it provable, so the whole step is refused.)`
                : ""
            } This check cannot fail, so ` +
            "it would prove nothing on replay. Record a `visible` check for the same selector " +
            "while the element IS on screen first, then act, then record this one; the flow " +
            "then proves the element went away. If the element is never present at all, the " +
            `selector is wrong — find the real one with ${treeReaderFor(args.udid)}.${note ? ` ${note}` : ""}`,
          toolResult,
          stepCount,
          savedTo: session.filePath,
        };
      }

      // The wait held against the accessibility tree. Ask the tree the runner
      // resolves DIRECTIVES against too, so the author learns now — rather than
      // after polish — whether the conversion is safe.
      let crossTreeWarning: string | undefined;
      if (params.command === AWAIT_UI_ELEMENT_TOOL_ID) {
        const probe = await probeAgainstRunnerTree(registry, ctx, args);
        crossTreeWarning = probe.warning
          ? `${probe.warning}. ${treeDivergenceFor(args.udid)} ${treeReaderFor(args.udid)} reads the runner's side`
          : undefined;
      }

      const sequenceFailure = runSequenceFailure(params.command, toolResult);
      if (sequenceFailure) {
        const { stepCount, note } = await activeFlowState(session);
        return {
          message:
            `run-sequence stopped on a failed nested step: ${sequenceFailure} — step NOT recorded. ` +
            `${partialMutationWarning("run-sequence")}${note ? ` ${note}` : ""}`,
          toolResult,
          stepCount,
          savedTo: session.filePath,
        };
      }

      // run-sequence honours cancellation between nested steps by returning a
      // partial result rather than throwing. A post-invoke guard is therefore
      // required: otherwise that partial sequence would be recorded as if all
      // nested actions had run successfully.
      if (params.command === "run-sequence" && ctx?.signal?.aborted) {
        const { stepCount, note } = await activeFlowState(session);
        const progress = runSequenceProgress(toolResult);
        return {
          message:
            `run-sequence was cancelled${progress ? ` with ${progress}` : ""} — step NOT recorded. ` +
            `${partialMutationWarning("run-sequence")}${note ? ` ${note}` : ""}`,
          toolResult,
          stepCount,
          savedTo: session.filePath,
        };
      }

      if (params.command === RUN_TARGET_COMMAND) {
        const recordBlock = flowExecuteRecordBlock(toolResult);
        if (recordBlock) {
          const { stepCount, note } = await activeFlowState(session);
          const mutationWarning = recordBlock.mayHaveMutated
            ? ` ${partialMutationWarning("flow-execute")}`
            : "";
          return {
            message:
              `${recordBlock.reason} — step NOT recorded.${mutationWarning}` +
              `${note ? ` ${note}` : ""}`,
            toolResult,
            stepCount,
            savedTo: session.filePath,
          };
        }
      }

      // Running a fragment via flow-execute mid-recording is recorded as a
      // `run:` composition directive rather than a raw, non-portable tool call.
      const runTarget =
        params.command === RUN_TARGET_COMMAND && params.delayMs === undefined
          ? await captureRunTarget(session, args)
          : undefined;

      // A recorded `restart-app` is captured as the portable `launch` directive
      // (same terminate-and-relaunch semantics, plus the runner's post-launch
      // settle and readiness gate at replay). Recorded first, it makes the flow
      // an e2e flow. Only the plain bundleId form maps; extra args (e.g. an
      // Android `activity`) keep the raw tool step. `launch-app` is NOT
      // rewritten — it foregrounds without terminating, a different semantic.
      const strippedArgs = stripDeviceKeys(args);
      const isLaunch =
        params.command === "restart-app" &&
        params.delayMs === undefined &&
        typeof strippedArgs.bundleId === "string" &&
        Object.keys(strippedArgs).length === 1;

      // A multi-tap (`clickCount: 2` = double-tap) must survive the rewrite as
      // `times`, or replay would silently fire a single tap for a recorded
      // double. Bounds match the tool's clickCount; 1 is the default (absent).
      const cc = args.clickCount;
      const tapTimes =
        isTap && typeof cc === "number" && Number.isInteger(cc) && cc >= 2 && cc <= 10
          ? { times: cc }
          : {};

      let step: FlowStep;
      let warning: string | undefined;
      if (captured?.selector) {
        step = { kind: "tap", selector: captured.selector, ...tapTimes };
        warning = captured.warning;
      } else if (isTap) {
        // No stable selector — keep a coordinate tap, but still as a `tap:`
        // directive so every tap reads uniformly.
        // No stable selector — keep a coordinate tap, but recording the point
        // is not an endorsement of it: say what failed AND what to do instead,
        // since this warning is the whole of the author's signal that the flow
        // just took on a step that survives only until the layout moves.
        step = { kind: "tap", x: args.x as number, y: args.y as number, ...tapTimes };
        warning = captured?.warning
          ? `${captured.warning}; kept coordinates, which replay at a fixed point and break on ` +
            `any layout change. ${coordinateRemedy(captured, args.udid)} Keep the point only for ` +
            `a genuinely unaddressable target (a canvas, a map, an unlabeled image), preceded by ` +
            `an echo naming what it is.`
          : undefined;
      } else if (isLaunch) {
        step = { kind: "launch", app: strippedArgs.bundleId as string };
      } else if (runTarget?.flow) {
        step = { kind: "run", flow: runTarget.flow };
        // A resolved target can still carry a warning (a same-named sibling in
        // another project), so this branch surfaces it too — not only the
        // kept-the-raw-step one below.
        warning = runTarget.warning;
      } else {
        warning =
          crossTreeWarning ??
          runTarget?.warning ??
          rawCoordinateWarning(params.command, args, params.delayMs);
        // The step ran live with the full args (incl. the device id), but the
        // recorded form drops the device id so the flow stays portable — the
        // runner injects whatever device it resolves at replay.
        step = {
          kind: "tool",
          name: params.command,
          args: strippedArgs,
          delayMs: params.delayMs,
        };
      }

      const { savedTo } = await appendStepToFlow(session, step);
      const stepCount = session.flow.steps.length;

      return {
        message: `Step added to "${params.name}" flow${warning ? ` — ${warning}` : ""}`,
        toolResult,
        stepCount,
        recorded: summarizeStep(step, stepCount),
        // Host mode: a path. Client mode: the directive that carries the YAML
        // to the client, which IS the persistence mechanism there — the one
        // place the full file still has to travel per step.
        savedTo,
      };
    },
  };
}
