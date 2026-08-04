import type { DeviceInfo, Registry, ToolContext } from "@argent/registry";
import {
  getDescribeTapPoint,
  type DescribeFrame,
  type DescribeNode,
  type DescribeSource,
} from "../describe/contract";
import {
  selectorToFrame,
  findAll,
  evaluateCondition,
  firstInReadingOrder,
  frameContains,
  isVisible,
  assertText,
  frameWithin,
  nodeText,
  treeFingerprint,
  confusableTextNote,
  compatibilityVariantOf,
  type Selector,
  type WaitCondition,
  type TextMatchMode,
} from "../../utils/ui-tree-match";
import { sleepOrAbort } from "../../utils/timing";
import { invokeSubTool } from "../../utils/sub-invoke";
import {
  connectRouteReader,
  verifyRouteFingerprint,
  type RouteReader,
} from "../../utils/route-identity";
import { metroServerRunning } from "../../utils/debugger/discovery";
import { selectorIdentityTerms } from "./flow-selector-evidence";
import { bindDeviceArgs } from "./flow-device";
import { fetchFlowTree } from "./flow-tree";
import {
  buildAxisCandidate,
  decomposePinch,
  selectPinchCandidate,
  systemEdgeGuards,
  PINCH_SETTLE_MS,
  type PinchCandidate,
} from "./flow-pinch-geometry";
import {
  buildRotateCandidate,
  deriveRotateDurationMs,
  selectRotateCandidate,
  type RotateCandidate,
} from "./flow-rotate-geometry";
import {
  describeSelector,
  describeTextExpectation,
  SELECTOR_RELATIONS,
  type FlowSelector,
  type FlowStep,
  type ScrollDirection,
} from "./flow-utils";

/**
 * Per-run scratch for `await: { screen: … }` gates. Connecting the RN debugger
 * costs a Metro discovery plus a CDP attach, so the reader is established once
 * and reused for every gate in the run. A failed connect is memoized as `null`
 * (not retried), because "this app has no route reader" is a property of the
 * build, not a transient.
 */
export interface ScreenIdentityState {
  /** App id of the last executed `launch` step — the default a gate reads. */
  launchedAppId?: string;
  /**
   * Memoized readers keyed `<appId>@<metroPort>`. SUCCESSES ONLY — a failed
   * connect is never stored, because the debugger session comes and goes with
   * the app: a `launch` invalidates it, and the first gate after one routinely
   * connects too early. Caching that failure made every later gate on the run
   * fail instantly with no wait, which no per-step `timeout:` could rescue.
   */
  readers: Map<string, RouteReader>;
  /**
   * Keys whose platform can never have a route reader (chromium has no React
   * Navigation). Permanent for the run — unlike a failed connect, retrying
   * cannot change the answer.
   */
  unsupported: Set<string>;
  /**
   * Keys whose connect exhausted its whole retry budget since the last
   * `launch`. NOT the cache R2 forbids: this one is scoped to the launch
   * epoch and cleared by every launch, so the case that poisoned runs — a
   * gate that connected into the post-launch gap and condemned the rest of
   * the run — cannot recur.
   *
   * It is a backstop, not a load-bearing optimization, and the difference is
   * worth stating because the obvious reading ("it saves the flow's LATER
   * gates from paying the budget again") does not hold: an exhausted connect
   * makes the step `indeterminate`, the runner scores that `error`, and an
   * errored step stops the run — so no later step gets to consult this set.
   * What it does cover is a second `routeReaderFor` inside ONE step, and the
   * only such caller (the reconnect after an all-null poll) deliberately
   * clears the key first. Keep it as the guard that bounds any future caller;
   * do not credit it with saving time on today's paths.
   */
  connectExhausted: Set<string>;
  /**
   * True while the app is in the window right after a `launch` (and at the
   * start of a run, whose first step is a launch for an e2e flow). The first
   * connect of such an epoch is allowed a much larger budget, because the app
   * is not slow to answer — it is not registered with Metro yet at all.
   * Cleared by the first successful connect.
   */
  coldSinceLaunch: boolean;
}

/** Everything a directive needs to act on the run's device. */
export interface ActionEnv {
  registry: Registry;
  ctx?: ToolContext;
  device: DeviceInfo;
  signal?: AbortSignal;
  /**
   * Present for a flow run; absent for one-off directive callers. A `screen`
   * gate without it fails with authoring guidance rather than silently passing.
   */
  screenIdentity?: ScreenIdentityState;
  /**
   * Selector identity terms (`id:…`/`text:…`) the run has positively
   * established so far — populated by the runner as each step passes. Absent
   * for one-off directive callers, which have no flow around them to carry
   * evidence. Read by the `hidden` falsifiability guard.
   */
  establishedSelectors?: Set<string>;
}

/** Outcome of a selector directive: ok, or a machine-readable reason it failed. */
export interface DirectiveOutcome {
  ok: boolean;
  reason?: string;
  /** The run was cancelled mid-step — reported as a skip, not a step failure. */
  aborted?: boolean;
  /**
   * The condition could not be evaluated — unknown, not false: the window
   * never produced a trustworthy read (every fetch threw or returned a
   * blind/degraded tree), or a `hidden` check ended on a blind or failed
   * read after the element had matched. Read by the `when:` guard probe,
   * which must error rather than silently skip a block a broken tree source
   * can't vouch for; a plain `assert` reports it as an ordinary failure.
   */
  indeterminate?: boolean;
  /**
   * The step passed, but something about HOW it passed weakens it as proof —
   * currently only a `hidden` check that held without its selector ever
   * matching, in a run that never established it. Not a failure: the condition
   * genuinely held, and three legitimate patterns reach it (a scoped `hidden`
   * whose match sits outside the container, a fragment whose
   * `executionPrerequisite` established the element, a baseline absence check).
   * But it is indistinguishable from a typo'd selector, so it must not read as
   * a clean pass either — the recorder refuses to WRITE one of these, and a
   * hand-written flow deserves to be told what it bought.
   */
  warning?: string;
}

/**
 * The uniform outcome for a step cut short by run cancellation (directives
 * here, `launch` in flow-run.ts). The runner reports it as skip + "run aborted"
 * (matching the pre-step guard and `wait`) — an aborted run says nothing about
 * the app, so it must never read as a genuine step failure with a misleading
 * reason.
 */
export const ABORTED_OUTCOME: DirectiveOutcome = {
  ok: false,
  aborted: true,
  reason: "run aborted",
};

/** The condition/action steps {@link runDirective} handles. */
export type DirectiveStep = Extract<
  FlowStep,
  {
    kind:
      | "tap"
      | "long-press"
      | "type"
      | "await"
      | "assert"
      | "screen"
      | "idle"
      | "scroll-to"
      | "pinch"
      | "rotate";
  }
>;

/** Dispatch a tool with the run's resolved device id bound into its args. */
export function invokeOnDevice(
  env: ActionEnv,
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return invokeSubTool(
    env.registry,
    env.ctx,
    tool,
    bindDeviceArgs(env.registry, tool, env.device.id, args)
  );
}

const DEFAULT_ACTION_TIMEOUT_MS = 7500;
const POLL_INTERVAL_MS = 300;

// `type` focus handshake: the focus tap resolves as soon as its Up event is
// enqueued, but the app still has to move input focus there (first responder /
// IME focus; an RN TextInput adds a JS round-trip) — keys injected before that
// land in the previously-focused element. TYPE_FOCUS_SETTLE_MS is an
// unconditional head start after the tap; `waitForFocus` then polls, on
// sources that report focus, until the tapped frame holds it.
const TYPE_FOCUS_SETTLE_MS = 500;
const TYPE_FOCUS_TIMEOUT_MS = 3000;

// Tree sources that surface `focused` (see flow-ios-tree / flow-android-tree /
// the chromium DOM walker). A source outside this set (e.g. Vega's toolkit
// page source) never reports it, so polling would burn the whole timeout on
// every type step — skip the focus wait there instead.
const FOCUS_REPORTING_SOURCES: ReadonlySet<DescribeSource> = new Set([
  "native-devtools",
  "android-devtools",
  "cdp-dom",
]);

// Settle detection: re-read the tree until two consecutive reads match, so a tap
// never lands mid-fling and a resolved frame can't go stale before we act.
const SETTLE_POLL_MS = 250;
const SETTLE_TIMEOUT_MS = 3000;

// `scroll-to`: a bounded number of momentum-free increments. Each travels half
// the clip window along the scroll axis (half the screen when no `within`
// container is named) — < 1 viewport, so consecutive viewports overlap and a
// target can never be skipped over between two settle checkpoints. The floor
// keeps the gesture in a tiny container large enough to register as a scroll
// rather than a tap.
const MAX_SCROLL_ITERATIONS = 25;
const SCROLL_INCREMENT = 0.5;
const MIN_SCROLL_INCREMENT = 0.05;

const FULL_SCREEN: DescribeFrame = { x: 0, y: 0, width: 1, height: 1 };

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Edge tolerance (normalized) for "is this frame flush against a clip edge".
// A hair above the frame-fingerprint rounding (1e-3) so sub-pixel jitter never
// reads as a clip, but small enough that a genuinely clipped edge lands on it.
const EDGE_EPS = 0.005;

/**
 * Is `frame` as visible as it can get within `clip` along the scroll axis?
 * True in either of two shapes:
 *
 * 1. Fully within the clip, with its *entry* edge cleared of the clip boundary
 *    by a margin. Every describe adapter clips a partly-scrolled element's
 *    frame to the viewport (iOS/Chromium clamp their rects to [0,1]; Android
 *    uiautomator reports bounds already clipped to the scroll container), so
 *    such an element sits exactly flush against the edge it is being revealed
 *    from — a row entering from the bottom has `y+h == clip.bottom`. "Flush
 *    against the entry edge" is therefore the universal clipped signal.
 *    Requiring the entry edge strictly inside (by `EDGE_EPS`), with the
 *    opposite edge still within the clip, means the whole element has cleared
 *    the fold. The entry edge is set by the scroll direction: `down` reveals
 *    from the bottom, `up` from the top, etc.
 * 2. Spanning the whole clip along the axis (both clip edges covered, with
 *    `EDGE_EPS` slack). A target as tall/wide as the clip — or larger — can
 *    never fit both edges inside it, so shape 1 is arithmetically
 *    unsatisfiable for it; once it covers the clip, no scroll can reveal more
 *    of it, so it is accepted where it stands. Without this, a full-screen
 *    target would scroll (and could burn every iteration when an in-region
 *    animation defeats the end-of-scroll fingerprint) despite being on screen
 *    the whole time.
 */
function axisFullyInside(
  frame: DescribeFrame,
  direction: ScrollDirection,
  clip: DescribeFrame
): boolean {
  const vertical = direction === "down" || direction === "up";
  const clipStart = vertical ? clip.y : clip.x;
  const clipEnd = clipStart + (vertical ? clip.height : clip.width);
  const fStart = vertical ? frame.y : frame.x;
  const fEnd = fStart + (vertical ? frame.height : frame.width);
  // Shape 2: the target covers the whole clip window along the axis.
  if (fStart <= clipStart + EDGE_EPS && fEnd >= clipEnd - EDGE_EPS) return true;
  // Shape 1: both edges inside, entry edge (per direction) cleared by EDGE_EPS.
  // `down`/`right` reveal from the end edge; `up`/`left` from the start edge.
  return direction === "down" || direction === "right"
    ? fEnd <= clipEnd - EDGE_EPS && fStart >= clipStart - EDGE_EPS
    : fStart >= clipStart + EDGE_EPS && fEnd <= clipEnd + EDGE_EPS;
}

// `assert` is a correctness check, not an open-ended wait — but UI updates after
// an action land asynchronously, so a strictly one-shot read races the
// re-render (e.g. a counter that increments a frame after a tap). Like
// Playwright's web-first assertions, assert retries for a short grace window so
// it absorbs that latency; a genuinely-false assertion still fails quickly.
const DEFAULT_ASSERT_TIMEOUT_MS = 1000;

// Evidence-gap bound for `waitForCondition`'s post-timeout verdict: how far
// behind the loop's exit the last TRUSTED read may lie before a determinate
// "condition false" verdict stops being honest. Two poll intervals budgets
// the worst genuine last-poll blip — up to one interval of sleep since the
// last clean read, plus an interval's worth of latency for the deadline poll
// and its back-to-back final retry both failing.
// Anything longer means consecutive polls went dark, and a verdict narrated
// from the reads before the darkness would describe a screen nobody saw at
// the deadline.
const CONDITION_DARK_TAIL_TOLERANCE_MS = POLL_INTERVAL_MS * 2;

/**
 * Evaluate a `when:` block's UI guard — the same engine as `assert`, on the
 * same assert grace window: a skipped block must not add an await-sized dead
 * wait to every clean run. `ok` is "condition met"; `indeterminate`
 * distinguishes an unreadable tree (the caller errors — unknown is not false)
 * from a plainly unmet condition (the caller skips).
 */
export function probeWhenCondition(
  env: ActionEnv,
  cond: {
    condition: WaitCondition;
    selector: FlowSelector;
    expectedText?: string;
    textMatch?: TextMatchMode;
  }
): Promise<DirectiveOutcome> {
  return waitForCondition(env, cond, DEFAULT_ASSERT_TIMEOUT_MS);
}

/**
 * The strict selectors a flow selector resolves through, in order. A loose
 * selector (bare-string sugar, `tap: foo`) tries the identifier locator first
 * and falls back to text (label/value) only when that finds nothing — so a
 * hand-written `foo` matches a `testID="foo"` as well as visible text. Explicit
 * `{ text }` / `{ id }` selectors carry no flag and match strictly.
 * Lives in the flow runner only; the shared match engine and the tools that
 * consume it are untouched.
 *
 * Every relational scope (`within`/`after`/`next`) expands recursively: each
 * level's alternatives cross-combine (a bare-string `within: foo` contributes
 * an identifier pass and a text pass, a map level contributes itself), ordered
 * identifier-first at every level so the doctrine matches the top level's. The
 * returned selectors are fully strict — no `loose` flag survives at any depth.
 *
 * The product is exponential in the number of BARE-STRING scopes, which is what
 * bounds it: only a bare string is loose, a bare string carries no scope of its
 * own, and the parser caps a selector's whole relation tree at
 * MAX_SELECTOR_SCOPES — so the worst case is a few dozen passes and a
 * hand-authored selector is one or two. (That cap is a tree-SIZE bound for
 * exactly this reason: a depth bound alone would admit 3^depth loose leaves.)
 *
 * `any` is dropped here: it is the flow-side marker that legitimizes a
 * field-less selector, and a field-less selector is already what the match
 * engine reads as "every element".
 */
function selectorAlternatives(sel: FlowSelector): Selector[] {
  const { loose, any: _any, within, after, next, ...own } = sel;
  const scopes = { within, after, next };
  let alts: Selector[] =
    loose && own.text !== undefined ? [{ identifier: own.text }, { text: own.text }] : [own];
  for (const relation of SELECTOR_RELATIONS) {
    const scope = scopes[relation];
    if (scope === undefined) continue;
    const scopeAlts = selectorAlternatives(scope);
    alts = alts.flatMap((o) => scopeAlts.map((s) => ({ ...o, [relation]: s })));
  }
  return alts;
}

/**
 * Resolve a selector's matches honoring the bare-string `loose` fallback. A
 * pass only wins outright when it has a *visible* match — the same criterion
 * {@link flowSelectorToFrame} uses to fall through — so `await`/`assert` and
 * `tap`/`type` resolve a bare string to the same element. A pass whose matches
 * are all zero-area is kept only as a last resort (so `exists`, which
 * deliberately accepts zero-area nodes, still sees them) instead of blocking
 * the text pass from finding the visible element.
 */
function flowFindAll(tree: DescribeNode, sel: FlowSelector): DescribeNode[] {
  let fallback: DescribeNode[] = [];
  for (const s of selectorAlternatives(sel)) {
    const matches = findAll(tree, s);
    if (matches.some(isVisible)) return matches;
    if (fallback.length === 0) fallback = matches;
  }
  return fallback;
}

/** Identifier-first-then-text frame resolution for a (possibly loose) selector. */
function flowSelectorToFrame(tree: DescribeNode, sel: FlowSelector): DescribeFrame | undefined {
  for (const s of selectorAlternatives(sel)) {
    const frame = selectorToFrame(tree, s);
    if (frame) return frame;
  }
  return undefined;
}

/**
 * Re-read the describe tree until two consecutive reads are identical — the UI
 * has settled (a scroll's fling has stopped, an animation finished). Returns the
 * stable tree, the last tree read on timeout (best effort), or undefined if the
 * run was aborted. Resolving a frame from a settled tree is what keeps a tap
 * from landing mid-deceleration (where a scroll view swallows it) or acting on a
 * frame that has already moved.
 *
 * Throws when EVERY read in the window failed: that is a tree-source outage
 * (e.g. native devtools disconnected mid-run — `fetchFlowTree` refuses to
 * degrade to a trimmed tree), not a mid-animation blip, and swallowing it would
 * convert the outage into a misleading "element not found" downstream. The
 * throw lands in the step's structured report via `execLeafStep`'s catch.
 */
export async function settleTree(env: ActionEnv): Promise<DescribeNode | undefined> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let prevFp: string | undefined;
  let prevTree: DescribeNode | undefined;
  let lastError: Error | undefined;
  for (;;) {
    if (env.signal?.aborted) return undefined;
    let tree: DescribeNode | undefined;
    try {
      ({ tree } = await fetchFlowTree(env.registry, env.device));
    } catch (err) {
      // transient describe failure mid-navigation — retry until the deadline
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    // The abort can land while the read above is in flight (e.g. the HTTP
    // client disconnecting mid-flow trips the run's AbortController). Without
    // this re-check the two-identical-reads return below — or the deadline's
    // best-effort tree — would hand the caller a settled tree to act on, and a
    // gesture would still be dispatched after cancellation with the step
    // recorded as a pass instead of the uniform aborted skip.
    if (env.signal?.aborted) return undefined;
    if (tree !== undefined) {
      const fp = treeFingerprint(tree);
      if (prevFp !== undefined && fp === prevFp) return tree;
      prevFp = fp;
      prevTree = tree;
    }
    if (Date.now() >= deadline) {
      if (prevTree === undefined && lastError !== undefined) throw lastError;
      return prevTree;
    }
    if (!(await sleepOrAbort(SETTLE_POLL_MS, env.signal))) return undefined;
  }
}

/**
 * Poll until a visible element matches the selector, resolving against a
 * *settled* tree each round so the returned frame is stable. Returns the frame,
 * undefined once the deadline passes, or "aborted" when the run was cancelled —
 * the two misses must stay distinguishable, or a cancelled `tap`/`type` would
 * be reported as a genuine "element not found" failure.
 *
 * Exported for `snapshot: { cropOn }` (flow-visual.ts), which resolves the
 * crop element's frame with the same settle + auto-wait the directives get.
 */
export async function waitForFrame(
  env: ActionEnv,
  selector: FlowSelector
): Promise<DescribeFrame | "aborted" | undefined> {
  const deadline = Date.now() + DEFAULT_ACTION_TIMEOUT_MS;
  for (;;) {
    if (env.signal?.aborted) return "aborted";
    const tree = await settleTree(env);
    if (tree) {
      const frame = flowSelectorToFrame(tree, selector);
      if (frame) return frame;
    } else if (env.signal?.aborted) {
      return "aborted"; // settleTree bailed on the abort, not on a blank read
    }
    if (Date.now() >= deadline) return undefined;
    const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, env.signal))) return "aborted";
  }
}

function framesOverlap(a: DescribeFrame, b: DescribeFrame): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * How much larger than the typed-into element a focused ANCESTOR may be and
 * still count as evidence about it. A wrapper around an input is roughly the
 * input's size; anything far bigger is a different thing that merely encloses
 * it.
 */
const FOCUS_ANCESTOR_AREA_RATIO = 4;

function frameArea(f: DescribeFrame): number {
  return f.width * f.height;
}

/**
 * Is `focused` evidence that `target` has keyboard focus?
 *
 * Not a bare intersection: an element that only clips a corner of the target
 * says nothing. Not bare nesting either, which is where this first landed and
 * was wrong in one direction — a modal composer three quarters of the screen
 * tall CONTAINS every node of the screen behind it, so it confirmed focus for
 * any of them, and `type:` then injected the keys at HID level into the
 * composer while reporting a pass on a static label behind it. Silent, and
 * wrong in the worst way: the text lands somewhere real.
 *
 * The direction that carries evidence is `focused` inside `target` — the
 * documented case where the selector matches a testID container and the input
 * inside it reports the focus. The reverse, a focused ancestor, is accepted
 * only while it stays close to the target's own size, because a platform may
 * legitimately mark a field's immediate wrapper focused rather than the field.
 */
function framesNest(focused: DescribeFrame, target: DescribeFrame): boolean {
  if (frameWithin(focused, target)) return true;
  return (
    frameWithin(target, focused) &&
    frameArea(focused) <= frameArea(target) * FOCUS_ANCESTOR_AREA_RATIO
  );
}

/**
 * Is this node a scroll container? Android's uiautomator dump flags one
 * directly (`scrollable`); the iOS full-hierarchy adapter carries no such flag
 * but maps UIScrollView/UITableView/UICollectionView class names to the
 * AXScrollArea role, which the role test catches. The Chromium DOM walker sets
 * `scrollable` on overflow scrollers too, but the flow adapter
 * (`projectChromiumNode`) only emits leaves that are otherwise addressable
 * (identifier/label/value/clickable/focused) — an ANONYMOUS overflow scroller
 * never reaches the flow tree, so on Chromium only addressable scrollers are
 * detected here and the caller falls back to the whole screen otherwise.
 */
function isScrollContainer(node: DescribeNode): boolean {
  return node.scrollable === true || /scroll/i.test(node.role);
}

/**
 * Frames of every visible scroll container whose frame contains the swipe
 * anchor. The OS routes a scroll gesture to a scroller hit-tested at the
 * anchor, so the container that will actually move is always among these. ALL
 * of them are returned rather than just the innermost: the innermost may not
 * scroll along the requested axis at all (a horizontal carousel under a
 * vertical swipe hands the gesture to an ancestor), and an end-of-scroll
 * fingerprint scoped to it alone would misread the outer scroller's real
 * progress as "stuck". Empty when the tree surfaces no scroll container at the
 * anchor (e.g. a page-level scroller the source doesn't emit as a node).
 */
function anchorScrollFrames(tree: DescribeNode, anchor: { x: number; y: number }): DescribeFrame[] {
  const frames: DescribeFrame[] = [];
  const walk = (node: DescribeNode): void => {
    if (
      isScrollContainer(node) &&
      isVisible(node) &&
      frameContains(node.frame, anchor.x, anchor.y)
    ) {
      frames.push(node.frame);
    }
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return frames;
}

function collectFocused(node: DescribeNode, acc: DescribeNode[]): DescribeNode[] {
  if (node.focused) acc.push(node);
  for (const child of node.children) collectFocused(child, acc);
  return acc;
}

/**
 * Poll until an element reporting `focused` nests with the typed-into element,
 * per {@link framesNest} — containment, not identity and not bare overlap. The
 * selector often matches a testID container while focus is reported by the
 * input inside it, which is why identity is too strict; an element that merely
 * clips a corner of the target is evidence of nothing, which is why overlap is
 * too loose. The target's frame is re-resolved each round — the keyboard
 * sliding up routinely scrolls the field away from where it was tapped
 * (keyboard avoidance), and the focused element must be compared against where
 * the field is NOW; `tappedFrame` covers rounds where the selector momentarily
 * doesn't resolve.
 *
 * The verdict is returned rather than swallowed, and the three ways of not
 * saying "confirmed" are kept apart, because they warrant opposite responses:
 *
 * - `unreported` — the source cannot surface focus at all (Vega). Nothing to
 *   wait for and nothing to conclude; typing proceeds as it always has.
 * - `unreadable` — the source can, but every read of the window threw. That is
 *   an environment problem, not evidence about where focus went.
 * - `unconfirmed` — reads succeeded and no focused element overlapped the
 *   field. This is real evidence the keys would land somewhere else.
 */
type FocusVerdict = "confirmed" | "unconfirmed" | "unreported" | "unreadable" | "aborted";

async function waitForFocus(
  env: ActionEnv,
  into: FlowSelector,
  tappedFrame: DescribeFrame
): Promise<FocusVerdict> {
  const deadline = Date.now() + TYPE_FOCUS_TIMEOUT_MS;
  let read = false;
  for (;;) {
    if (env.signal?.aborted) return "aborted";
    try {
      const { tree, source } = await fetchFlowTree(env.registry, env.device);
      if (!FOCUS_REPORTING_SOURCES.has(source)) return "unreported";
      read = true;
      const target = flowSelectorToFrame(tree, into) ?? tappedFrame;
      if (collectFocused(tree, []).some((n) => framesNest(n.frame, target))) return "confirmed";
    } catch {
      // transient describe failure — retry until the deadline
    }
    if (Date.now() >= deadline) return read ? "unconfirmed" : "unreadable";
    const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, env.signal))) return "aborted";
  }
}

interface ScrollResolve {
  /** The target's frame once it became visible. */
  frame?: DescribeFrame;
  /** Why the scroll stopped without finding the target. */
  reason?: string;
  /** The run was cancelled mid-scroll. */
  aborted?: boolean;
}

/**
 * Dispatch one momentum-free scroll increment anchored at the center of
 * `region`. The anchor (the touch-down / wheel point) is what selects the scroll
 * container — the OS routes the gesture to the innermost scroller hit-tested
 * there — so anchoring inside a `within` region is how nested scrollers are
 * disambiguated. The travel is half the region along the axis (only the end
 * point is clamped, so the down stays at the anchor and keeps latching to the
 * right container) — sized to the clip window rather than the screen, so
 * consecutive views of a small container's content still overlap and a target
 * can't be scrolled fully past between settle checkpoints. Touch platforms use
 * a `settle` swipe (no fling); Chromium uses wheel events (already
 * momentum-free).
 */
async function scrollIncrement(
  env: ActionEnv,
  direction: ScrollDirection,
  region: DescribeFrame
): Promise<void> {
  const cx = clamp01(region.x + region.width / 2);
  const cy = clamp01(region.y + region.height / 2);
  const extent = direction === "up" || direction === "down" ? region.height : region.width;
  const dist = Math.min(SCROLL_INCREMENT, Math.max(MIN_SCROLL_INCREMENT, extent / 2));

  if (env.device.platform === "chromium") {
    // Positive deltaY/deltaX reveals content below / to the right (see gesture-scroll).
    const delta =
      direction === "down"
        ? { deltaY: dist }
        : direction === "up"
          ? { deltaY: -dist }
          : direction === "right"
            ? { deltaX: dist }
            : { deltaX: -dist };
    await invokeOnDevice(env, "gesture-scroll", { x: cx, y: cy, ...delta });
    return;
  }

  // To reveal content below the fold the finger travels UP (toY < fromY), etc.
  let to: { x: number; y: number };
  switch (direction) {
    case "down":
      to = { x: cx, y: clamp01(cy - dist) };
      break;
    case "up":
      to = { x: cx, y: clamp01(cy + dist) };
      break;
    case "right":
      to = { x: clamp01(cx - dist), y: cy };
      break;
    case "left":
      to = { x: clamp01(cx + dist), y: cy };
      break;
  }
  await invokeOnDevice(env, "gesture-swipe", {
    fromX: cx,
    fromY: cy,
    toX: to.x,
    toY: to.y,
    settle: true,
    durationMs: 600,
  });
}

/**
 * Scroll until `target` is as visible as it can get within the scroll viewport
 * along the scroll axis — fully inside it, or (for a target as tall/wide as the
 * viewport or larger) spanning it — returning its frame. Each round settles the
 * tree, checks the target, then — if it isn't fully in view — does one
 * momentum-free increment. Stopping only once the target has cleared the entry
 * edge (not on the first sliver) is what keeps a following `tap`/`snapshot`
 * off a half-clipped element. If a
 * round's settled tree — fingerprinted within the scrolled region only (the
 * `within` container, or the scroll containers under the gesture anchor when
 * none is named) — is identical to the previous round's, the container has hit
 * its end (or the anchor scrolls nothing): the target is then as visible as it
 * will ever be, so it's accepted wherever it landed — the LAST item sits flush
 * against the far edge and can never clear it, and a genuinely stuck partial
 * can't be improved either. A target already fully on screen returns
 * immediately (no scroll).
 */
async function scrollToVisible(
  env: ActionEnv,
  target: FlowSelector,
  direction: ScrollDirection,
  within: FlowSelector | undefined
): Promise<ScrollResolve> {
  let prevFp: string | undefined;
  for (let i = 0; i < MAX_SCROLL_ITERATIONS; i++) {
    if (env.signal?.aborted) return { aborted: true };

    const tree = await settleTree(env);
    if (!tree) return { aborted: true }; // settleTree only returns undefined on abort

    // Anchor the gesture inside the container (so the right nested scroller
    // moves), or over the whole screen when none is named. Its frame is also the
    // clip window the axis check measures the target against.
    const region = within ? flowSelectorToFrame(tree, within) : FULL_SCREEN;
    if (!region) {
      return { reason: `scroll container ${describeSelector(within!)} is not visible` };
    }

    const frame = flowSelectorToFrame(tree, target);
    if (frame && axisFullyInside(frame, direction, region)) return { frame };

    // Fingerprint only the scrolled content: a continuously-animating node
    // outside it (a spinner, a ticking clock) would keep a wider fingerprint
    // changing on every read, so a container that stopped moving would never
    // read as "end of scroll" and the loop would burn all its iterations. The
    // scope is the `within` container's region when one is named; otherwise the
    // gesture anchors at the screen centre and the OS routes it to a scroller
    // hit-tested there, so the scope is every visible scroll container under
    // that anchor (their union — not the innermost; see anchorScrollFrames).
    // Only when the tree surfaces no scroll container at the anchor does the
    // scope stay the whole screen — a screen-level animator can then still mask
    // end-of-scroll, and the loop falls back to the iteration cap. Text stays
    // in the fingerprint for in-scope nodes — a snapping list recycles
    // identical frames with new content, so structure alone would misread real
    // progress as a stuck scroll — which also means an animating node INSIDE
    // the scrolled content remains a known limitation.
    const scope = within ? [region] : anchorScrollFrames(tree, getDescribeTapPoint(region));
    if (scope.length === 0) scope.push(FULL_SCREEN);
    const fp = treeFingerprint(tree, (node) => scope.some((r) => framesOverlap(node.frame, r)));
    if (prevFp !== undefined && fp === prevFp) {
      // End of the scroll — accept the target wherever it landed (best effort).
      if (frame) return { frame };
      return {
        reason: `reached the end of the scroll without finding ${describeSelector(target)}`,
      };
    }
    prevFp = fp;

    await scrollIncrement(env, direction, region);
  }
  return {
    reason: `${describeSelector(target)} not found after ${MAX_SCROLL_ITERATIONS} scroll attempts`,
  };
}

// `tap`/`type` auto-wait but deliberately do NOT auto-scroll: an implicit
// scroll would widen a loose selector's match scope from the viewport to the
// whole page, mutate scroll state even when the step fails, and stretch a
// failure to the scroll search's worst case. Off-screen targets take an
// explicit `scroll-to` step — the failure reason points there.
export function offscreenHint(sel: FlowSelector): string {
  return `no visible element matched selector ${describeSelector(sel)} — if it is off-screen, add a scroll-to step before this one`;
}

/** Execute one selector-acting directive (`tap` / `long-press` / `type` / `await` / `assert` / `scroll-to` / `pinch` / `rotate`). */
export async function runDirective(env: ActionEnv, step: DirectiveStep): Promise<DirectiveOutcome> {
  // Vega is remote-driven — there is no touch input, so the touch directives
  // can never act on it. Fail upfront with authoring guidance instead of a
  // low-level gesture dispatch error after the selector resolves.
  if (
    env.device.platform === "vega" &&
    (step.kind === "tap" ||
      step.kind === "long-press" ||
      step.kind === "type" ||
      step.kind === "scroll-to" ||
      step.kind === "pinch" ||
      step.kind === "rotate")
  ) {
    return {
      ok: false,
      reason: `${step.kind} is a touch directive and Vega is remote-driven — move focus with \`tool: tv-remote\` steps (and type via \`tool: keyboard\`) instead`,
    };
  }
  // Chromium: not "no backend" — CDP can dispatch two-finger touch, but a
  // mouse-driven desktop app has no uniform pinch-zoom mapping (and no
  // rotate-gesture idiom at all) for it to hit.
  if ((step.kind === "pinch" || step.kind === "rotate") && env.device.platform === "chromium") {
    return {
      ok: false,
      reason:
        step.kind === "pinch"
          ? "pinch is unsupported on chromium — desktop apps have no uniform pinch-zoom mapping (they zoom via ctrl+wheel or their own controls); drive the app's zoom UI with tap/keyboard instead"
          : "rotate is unsupported on chromium — desktop apps have no rotate-gesture idiom; drive the app's rotate controls with tap/keyboard instead",
    };
  }
  switch (step.kind) {
    case "tap":
      return runTap(env, step);
    case "long-press":
      return runLongPress(env, step);
    case "type":
      return runType(env, step);
    case "await":
      return waitForCondition(env, step, step.timeout ?? DEFAULT_ACTION_TIMEOUT_MS);
    case "assert":
      return waitForCondition(env, step, DEFAULT_ASSERT_TIMEOUT_MS);
    case "screen":
      return waitForScreen(env, step);
    case "idle":
      return waitForIdle(env, step);
    case "scroll-to": {
      const r = await scrollToVisible(env, step.target, step.direction, step.within);
      if (r.aborted) return ABORTED_OUTCOME;
      return { ok: Boolean(r.frame), reason: r.reason };
    }
    case "pinch":
      return runPinch(env, step);
    case "rotate":
      return runRotate(env, step);
  }
}

/**
 * Resolve a gesture target (`tap`/`long-press`) to a normalized point: a
 * selector resolves to its frame centre (settled tree + auto-wait); raw
 * coordinates pass through untouched. Coordinate targets are the fallback for
 * elements with no stable selector (e.g. an unlabeled view).
 */
async function resolveTargetPoint(
  env: ActionEnv,
  target: { selector?: FlowSelector; x?: number; y?: number }
): Promise<{ x: number; y: number } | { fail: DirectiveOutcome }> {
  if (target.selector) {
    const frame = await waitForFrame(env, target.selector);
    if (frame === "aborted") return { fail: ABORTED_OUTCOME };
    if (!frame) {
      return { fail: { ok: false, reason: offscreenHint(target.selector) } };
    }
    return getDescribeTapPoint(frame);
  }
  if (typeof target.x === "number" && typeof target.y === "number") {
    return { x: target.x, y: target.y };
  }
  return { fail: { ok: false, reason: "gesture needs a selector or x/y coordinates" } };
}

/**
 * Tap a resolved target point. `times` rides the gesture-tap tool's
 * `clickCount`: one resolution, one dispatched multi-tap gesture — never N
 * separate calls, whose RPC gaps could fall outside the OS double-tap window.
 */
async function runTap(
  env: ActionEnv,
  target: { selector?: FlowSelector; x?: number; y?: number; times?: number }
): Promise<DirectiveOutcome> {
  const point = await resolveTargetPoint(env, target);
  if ("fail" in point) return point.fail;
  await invokeOnDevice(env, "gesture-tap", {
    ...point,
    ...(target.times !== undefined ? { clickCount: target.times } : {}),
  });
  return { ok: true };
}

/**
 * Long-press defaults comfortably past both platforms' recognizers — iOS
 * UILongPressGestureRecognizer's 500ms minimum and Android's ~400ms
 * long-press timeout (RN's Pressable uses 500ms) — without dragging every
 * step out.
 */
const DEFAULT_LONG_PRESS_MS = 800;

/**
 * Press-and-hold on a target (same resolution as tap: selector → frame
 * centre, or a raw point) for `duration` ms. Touch platforms dispatch ONE
 * `gesture-custom` train (Down, then Up delayed by the duration) so the hold
 * length is exact; Chromium has no touch, so the closest honest mapping is a
 * mouse press-hold-release (`gesture-drag` with from == to) — apps
 * implementing pointer-based long-press respond, anything else sees a slow
 * click. A desktop context menu is a *right*-click, deliberately not aliased
 * here.
 */
async function runLongPress(
  env: ActionEnv,
  step: { selector?: FlowSelector; x?: number; y?: number; duration?: number }
): Promise<DirectiveOutcome> {
  const point = await resolveTargetPoint(env, step);
  if ("fail" in point) return point.fail;
  const duration = step.duration ?? DEFAULT_LONG_PRESS_MS;
  if (env.device.platform === "chromium") {
    await invokeOnDevice(env, "gesture-drag", {
      fromX: point.x,
      fromY: point.y,
      toX: point.x,
      toY: point.y,
      durationMs: duration,
    });
  } else {
    await invokeOnDevice(env, "gesture-custom", {
      events: [
        { type: "Down", x: point.x, y: point.y, delayMs: 0 },
        { type: "Up", x: point.x, y: point.y, delayMs: duration },
      ],
    });
  }
  return { ok: true };
}

/**
 * Pinch-zoom by `scale` centered on a selector's frame (settled tree +
 * auto-wait, like tap) or on the screen center when no selector is given. The
 * scale decomposes into equal-ratio sub-gestures chained with a recognizer
 * reset delay; per sub-gesture, a horizontal and a vertical candidate are
 * built from the axis-matching frame dimension and the better one dispatched
 * (see flow-pinch-geometry). Open-loop by design: there is no "current zoom"
 * to read back, so flows assert on the result, not the multiplier.
 */
async function runPinch(
  env: ActionEnv,
  step: { selector?: FlowSelector; scale: number }
): Promise<DirectiveOutcome> {
  let center = { x: 0.5, y: 0.5 };
  let frame: DescribeFrame | undefined;
  if (step.selector) {
    const resolved = await waitForFrame(env, step.selector);
    if (resolved === "aborted") return ABORTED_OUTCOME;
    if (!resolved) return { ok: false, reason: offscreenHint(step.selector) };
    frame = resolved;
    center = getDescribeTapPoint(resolved);
  }

  const { n, per } = decomposePinch(step.scale);
  // Guards are resolved exactly once per directive; geometry only ever
  // receives them as data (the seam for a future per-device query).
  const guards = systemEdgeGuards(env.device);
  const candidates = [
    buildAxisCandidate({ angle: 0, center, targetSpan: frame?.width, per, guards }),
    buildAxisCandidate({ angle: 90, center, targetSpan: frame?.height, per, guards }),
  ].filter((c): c is PinchCandidate => c !== undefined);
  const selected = selectPinchCandidate(candidates);
  if (!selected) {
    // The only geometry failure: literally no room to move the fingers —
    // never "target too small" (a tiny target is still attempted).
    return {
      ok: false,
      reason: `pinch found no on-screen finger travel around (${center.x}, ${center.y})`,
    };
  }

  const args: Record<string, unknown> = {
    centerX: center.x,
    centerY: center.y,
    startDistance: selected.start,
    endDistance: selected.end,
    angle: selected.angle,
  };
  // Centroid drift rides the gesture only on the moving axis, and only when
  // the clamp actually moved it.
  const startCenter = selected.angle === 0 ? center.x : center.y;
  if (selected.endCenter !== startCenter) {
    args[selected.angle === 0 ? "endCenterX" : "endCenterY"] = selected.endCenter;
  }

  for (let i = 0; i < n; i++) {
    if (env.signal?.aborted) return ABORTED_OUTCOME;
    await invokeOnDevice(env, "gesture-pinch", args);
    if (i < n - 1 && !(await sleepOrAbort(PINCH_SETTLE_MS, env.signal))) return ABORTED_OUTCOME;
  }
  return { ok: true };
}

/**
 * Best-effort screen aspect (width / height) for the rotate directive's
 * physical-circle geometry. One dedicated tree read instead of threading
 * dimensions through settleTree/waitForFrame: the settle loop already reads
 * the tree several times per step, so the extra fetch is noise, and the
 * resolution path every other directive shares stays untouched.
 */
async function fetchScreenAspect(env: ActionEnv): Promise<number | undefined> {
  try {
    const { screen } = await fetchFlowTree(env.registry, env.device);
    return screen && screen.width > 0 && screen.height > 0
      ? screen.width / screen.height
      : undefined;
  } catch {
    return undefined; // fail soft: the caller falls back to the legacy ellipse
  }
}

/**
 * Rotate by `by` degrees (+ clockwise) about a selector's frame centre
 * (settled tree + auto-wait, like tap) or the screen centre. One continuous
 * gesture — fingers orbit the fixed centroid at a constant physical radius,
 * so any angle dispatches without decomposition or settle delays, and the
 * angular delta is exact with zero pan/pinch coupling. The initial finger
 * axis is the safer of horizontal and vertical (see flow-rotate-geometry);
 * duration derives from the angle at the fixed ~90°/300ms pace — `by` is
 * bounded at parse. NOT the `rotate` tool — that changes device orientation.
 */
async function runRotate(
  env: ActionEnv,
  step: { selector?: FlowSelector; by: number }
): Promise<DirectiveOutcome> {
  let center = { x: 0.5, y: 0.5 };
  let frame: DescribeFrame | undefined;
  if (step.selector) {
    const resolved = await waitForFrame(env, step.selector);
    if (resolved === "aborted") return ABORTED_OUTCOME;
    if (!resolved) return { ok: false, reason: offscreenHint(step.selector) };
    frame = resolved;
    center = getDescribeTapPoint(resolved);
  }

  // Unknown aspect (source without dimensions, or a failed read) degrades to
  // aspect 1: the legacy normalized-space orbit — a physical ellipse — rather
  // than a hard error.
  const aspect = await fetchScreenAspect(env);

  // Guards are resolved exactly once per directive; geometry only ever
  // receives them as data (the seam for a future per-device query).
  const guards = systemEdgeGuards(env.device);
  const candidates = [
    buildRotateCandidate({
      startAngle: 0,
      center,
      targetSpan: frame?.width,
      guards,
      aspect: aspect ?? 1,
    }),
    buildRotateCandidate({
      startAngle: 90,
      center,
      targetSpan: frame?.height,
      guards,
      aspect: aspect ?? 1,
    }),
  ].filter((c): c is RotateCandidate => c !== undefined);
  const selected = selectRotateCandidate(candidates);
  if (!selected) {
    // The only geometry failure: no positive on-screen orbit radius — never
    // "target too small" (a tiny target is still attempted).
    return {
      ok: false,
      reason: `rotate found no on-screen orbit radius around (${center.x}, ${center.y})`,
    };
  }

  if (env.signal?.aborted) return ABORTED_OUTCOME;
  try {
    await invokeOnDevice(env, "gesture-rotate", {
      centerX: center.x,
      centerY: center.y,
      ...(aspect === undefined
        ? { radius: selected.radiusX }
        : { radiusX: selected.radiusX, radiusY: selected.radiusY }),
      startAngle: selected.startAngle,
      // endAngle > startAngle = clockwise in the tool, matching +by.
      endAngle: selected.startAngle + step.by,
      durationMs: deriveRotateDurationMs(step.by),
    });
  } catch (err) {
    // The tool rejects when cancelled mid-gesture; per ABORTED_OUTCOME that must
    // read as an aborted skip, never a step failure with the tool's message.
    if (env.signal?.aborted) return ABORTED_OUTCOME;
    throw err;
  }
  return { ok: true };
}

/**
 * Tap a field's centre and wait for focus to land there, re-resolving the
 * field's frame first (the keyboard sliding up can scroll it).
 */
async function tapForFocus(
  env: ActionEnv,
  into: FlowSelector,
  frame: DescribeFrame
): Promise<FocusVerdict> {
  await invokeOnDevice(env, "gesture-tap", getDescribeTapPoint(frame));
  // Keys are injected at the HID level and go to whatever holds focus, so the
  // tap→type gap must cover the app's focus round-trip (see the constants).
  if (!(await sleepOrAbort(TYPE_FOCUS_SETTLE_MS, env.signal))) return "aborted";
  return waitForFocus(env, into, frame);
}

/**
 * Resolve `into` → tap to focus → wait for focus to land → type text via the
 * keyboard tool. Unless `submit` is explicitly `false`, a trailing Enter is
 * pressed to commit the value and dismiss the keyboard, so it can't obscure
 * later steps (chained form fields that end in an explicit submit `tap` should
 * pass `submit: false`).
 *
 * Typing is refused when focus was NOT confirmed on a source that reports it.
 * Keys go to the HID layer, not to the element — unfocused, they land wherever
 * the app last put the caret, and the damage shows up much later: the observed
 * case was a dropped leading character that iOS autocorrect then completed into
 * a different word, which the app saved. One retry first, because losing the
 * focus race is far more common than the field being untappable.
 */
async function runType(
  env: ActionEnv,
  step: { into: FlowSelector; text: string; submit?: boolean }
): Promise<DirectiveOutcome> {
  const frame = await waitForFrame(env, step.into);
  if (frame === "aborted") return ABORTED_OUTCOME;
  if (!frame) {
    return { ok: false, reason: offscreenHint(step.into) };
  }
  let focus = await tapForFocus(env, step.into, frame);
  if (focus === "unconfirmed") {
    const retryFrame = await waitForFrame(env, step.into);
    if (retryFrame === "aborted") return ABORTED_OUTCOME;
    if (retryFrame) focus = await tapForFocus(env, step.into, retryFrame);
  }
  // waitForFocus reports abort separately from focus/timeout — re-check before
  // every keyboard dispatch (the keyboard tool has no abort handling of its
  // own), so a cancelled run can never type into, or submit, whatever the app
  // has focused after the caller gave up.
  if (focus === "aborted" || env.signal?.aborted) return ABORTED_OUTCOME;
  if (focus === "unconfirmed") {
    return {
      ok: false,
      reason:
        `${describeSelector(step.into)} did not take keyboard focus within ` +
        `${TYPE_FOCUS_TIMEOUT_MS}ms, after two taps — nothing was typed. Keys are injected at ` +
        `the HID level and would have gone to whatever else holds focus. Something is likely ` +
        `covering the field (a sheet mid-animation, a toast), or it is not a text input.`,
    };
  }
  if (focus === "unreadable") {
    return {
      ok: false,
      indeterminate: true,
      reason:
        `could not read the UI tree while waiting for ${describeSelector(step.into)} to take ` +
        `keyboard focus, so nothing was typed. Whether focus landed is unknown, not wrong — ` +
        `this is an environment failure.`,
    };
  }
  await invokeOnDevice(env, "keyboard", { text: step.text });
  if (step.submit !== false) {
    if (env.signal?.aborted) return ABORTED_OUTCOME;
    // Press Enter as a separate keyboard call — the tool dispatches `key`
    // before `text`, so a combined `{ text, key }` would submit before typing.
    await invokeOnDevice(env, "keyboard", { key: "enter" });
  }
  return { ok: true };
}

/**
 * Conditions whose verdict is "the element is there" and which therefore have
 * to survive a second read before they pass. `hidden` is excluded on purpose:
 * it already carries the blind-read guard, and there is no such thing as a
 * node that is stale into existence.
 */
const NEEDS_SECOND_READ: ReadonlySet<WaitCondition> = new Set(["exists", "visible", "text"]);

/**
 * Whether a `hidden` check that never saw its selector can still fail — i.e.
 * whether an earlier step of the run positively established that selector.
 * With no evidence set at all (a one-off directive caller outside a flow run)
 * the answer is yes: only a FLOW can carry the wider evidence, and refusing a
 * bare directive would break callers that never had the guard.
 */
function hiddenCheckIsFalsifiable(
  env: ActionEnv,
  step: { selector: FlowSelector },
  lastTree: DescribeNode | undefined
): boolean {
  const established = env.establishedSelectors;
  if (established === undefined) return true;
  const terms = selectorIdentityTerms(step.selector);
  // A selector this evidence model cannot name (role-only, a regex text
  // locator) is not something it may condemn either.
  if (terms.length === 0) return true;
  if (terms.some((term) => established.has(term))) return true;
  // A SCOPED check whose selector matches once the scope is dropped is doing
  // real work: the element is on screen, just not in the container/position
  // the check names, so it would fail the moment it appeared there. Only the
  // scope made the match empty, and saying "this proves nothing" about it
  // would be false.
  if (lastTree !== undefined && SELECTOR_RELATIONS.some((rel) => rel in step.selector)) {
    const unscoped = { ...step.selector };
    for (const rel of SELECTOR_RELATIONS) delete unscoped[rel];
    if (flowFindAll(lastTree, unscoped).length > 0) return true;
  }
  return false;
}

export function vacuousHiddenReason(selector: FlowSelector): string {
  return (
    `the \`hidden\` condition held without ${describeSelector(selector)} ever matching, and no ` +
    `earlier step in this run established it — so this check cannot fail and proves nothing. ` +
    `Prove the element is present first (a \`visible\` check on the same selector, before the ` +
    `action that removes it), or fix the selector if the element is never there at all.`
  );
}

/**
 * Identity of the set of nodes a selector matched, for comparing one read
 * against the next. Frames are included: an element still sliding into place
 * has not settled, and a `tap` resolved against a moving frame lands where the
 * element no longer is.
 */
function matchFingerprint(matches: DescribeNode[]): string {
  return matches
    .map(
      (n) =>
        `${n.role}|${Math.round(n.frame.x * 1000)},${Math.round(n.frame.y * 1000)},` +
        `${Math.round(n.frame.width * 1000)},${Math.round(n.frame.height * 1000)}` +
        `|${n.label ?? ""}|${n.value ?? ""}|${n.identifier ?? ""}|${n.subtreeText ?? ""}`
    )
    .join("\n");
}

/**
 * Poll a condition against the flow tree until it holds or `timeoutMs` passes.
 * One engine behind both conditional directives — they differ only in budget
 * and intent:
 *
 * - `await` (action-length default timeout, overridable per step via
 *   `timeout:`) — a real wait for a transition. Evaluating it here, rather
 *   than delegating to the `await-ui-element` tool, gives it the same loose
 *   bare-string semantics (identifier-first, then text) and the same
 *   full-hierarchy tree source as every other selector directive; the raw
 *   `tool: await-ui-element` step remains the escape hatch for custom
 *   poll/bundleId.
 * - `assert` (short grace window, {@link DEFAULT_ASSERT_TIMEOUT_MS}) — a
 *   correctness check that only absorbs the latency of an update landing a
 *   frame after an action; a genuinely-false assertion still fails quickly.
 *
 * Mirrors `await-ui-element`'s blind-read guard: an EMPTY tree is not
 * trustworthy evidence for `hidden` (the only condition an empty tree
 * satisfies) when the adapter flagged the read as degraded or the selector had
 * matched on an earlier poll — a transient blank frame mid-navigation must not
 * confirm the element left.
 *
 * A POSITIVE verdict additionally has to survive a second read (see
 * {@link matchFingerprint}). A silently-wrong green is worse than a flake: the
 * test has stopped testing, and nothing downstream will ever flag it.
 */
async function waitForCondition(
  env: ActionEnv,
  step: {
    condition: WaitCondition;
    selector: FlowSelector;
    expectedText?: string;
    textMatch?: TextMatchMode;
  },
  timeoutMs: number
): Promise<DirectiveOutcome> {
  const deadline = Date.now() + timeoutMs;

  let lastMatches: ReturnType<typeof findAll> = [];
  // The last tree a trusted read produced — the evidence a miss note draws on.
  let lastTree: DescribeNode | undefined;
  let fetchError: string | undefined;
  let everMatched = false;
  // State from the previous read, for confirming a POSITIVE condition. `heldPrev`
  // is the weak form (the condition held), the fingerprints are the strong one
  // (the same elements, on the same settled screen). All three reset whenever
  // the condition stops holding or a read cannot be trusted.
  let heldPrev = false;
  let pendingMatch: string | undefined;
  let pendingTree: string | undefined;
  // Date.now() of the most recent TRUSTED read — undefined until one lands.
  // Post-loop it anchors the dark-tail measurement: how long the window's
  // final stretch went without a trustworthy look at the screen.
  let lastTrustedReadAt: number | undefined;
  // Whether the LAST completed read attempt was trusted — assigned on every
  // pass through the loop (true on a trusted fetch, false on a blind one or a
  // throw), so post-loop it describes the final poll.
  let lastReadTrusted: boolean;
  let finalPoll = false;

  for (;;) {
    if (env.signal?.aborted) return ABORTED_OUTCOME;
    try {
      const data = await fetchFlowTree(env.registry, env.device);
      lastMatches = flowFindAll(data.tree, step.selector);
      lastTree = data.tree;
      fetchError = undefined;
      everMatched ||= lastMatches.length > 0;
      const blind =
        data.tree.children.length === 0 && Boolean(data.hint || data.should_restart || everMatched);
      if (!blind) lastTrustedReadAt = Date.now();
      lastReadTrusted = !blind;
      if (
        !blind &&
        evaluateCondition(step.condition, step.expectedText, lastMatches, step.textMatch)
      ) {
        if (!NEEDS_SECOND_READ.has(step.condition)) {
          // `hidden` satisfied without the selector ever matching, by a flow
          // that never showed it present, is a gate that cannot fail — a typo,
          // a renamed id and the wrong screen all pass it. The recorder refuses
          // to WRITE one; refuse to score one, or a hand-written (or
          // hand-edited) flow keeps the permanently-green check the recorder
          // exists to prevent. Indeterminate, not failed: nothing was learned
          // about the app, and reporting a regression here would be a lie.
          if (
            step.condition === "hidden" &&
            !everMatched &&
            !hiddenCheckIsFalsifiable(env, step, lastTree)
          ) {
            return { ok: true, warning: vacuousHiddenReason(step.selector) };
          }
          return { ok: true };
        }
        const fp = matchFingerprint(lastMatches);
        const treeFp = treeFingerprint(data.tree);
        // Two consecutive reads must agree. Inside the budget the bar is the
        // strong one — the SAME elements, on a tree that did not change — so a
        // node the tree has not finished evicting cannot be mistaken for the
        // live screen: it is surrounded by churn, and one settled beat is
        // enough for it to disappear.
        //
        // Once the budget is spent the bar drops to "it held on the previous
        // read too". Anything stricter would REGRESS this check: an element
        // sliding into place reports a new frame on every read and would never
        // produce two identical ones, and a screen with something permanently
        // in motion never produces two identical trees — both used to pass and
        // must keep passing. The weak form is still strictly stronger than the
        // single read this replaced.
        const strong = pendingMatch === fp && pendingTree === treeFp;
        if (heldPrev && (strong || Date.now() >= deadline)) return { ok: true };
        heldPrev = true;
        pendingMatch = fp;
        pendingTree = treeFp;
      } else {
        heldPrev = false;
        pendingMatch = undefined;
        pendingTree = undefined;
      }
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
      // A throw is as blind as an empty tree — `lastMatches` still holds the
      // previous successful read, which must not pass for current evidence,
      // and it breaks the chain of consecutive reads. That means `heldPrev`
      // too, not just the fingerprints: it is the weak form's entire claim
      // ("it held on the previous read as well"), and leaving it set let the
      // post-deadline branch honour that claim across a read that never
      // happened. The blind-read branch above clears all three for the same
      // reason, and a throw is strictly blinder than a blank tree.
      lastReadTrusted = false;
      heldPrev = false;
      pendingMatch = undefined;
      pendingTree = undefined;
    }
    if (Date.now() >= deadline) {
      if (finalPoll) break;
      finalPoll = true;
      continue;
    }
    const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, env.signal))) {
      return ABORTED_OUTCOME;
    }
  }

  // Post-timeout verdict — unknown must not masquerade as false. Three tiers
  // of evidence quality:
  //
  // 1. No trusted read in the whole window: every fetch either threw or
  //    returned a blind tree (empty + degraded hint, or empty after the
  //    selector had matched). A probe that never got a trustworthy look at
  //    the screen cannot vouch for "condition false" for ANY condition.
  // 2. Trusted reads existed but the window went dark at the end: the FINAL
  //    read attempt was blind or threw AND the last trusted read lies more
  //    than {@link CONDITION_DARK_TAIL_TOLERANCE_MS} behind the loop's exit.
  //    The condition becoming true is exactly the transition being waited on,
  //    so a "condition false" observation from before the reads went dark
  //    says nothing about the deadline — a determinate verdict built from it
  //    would let a dying tree source fake a clean report (and green-skip a
  //    `when:` guard whose dismissal target may well be on screen). `hidden`
  //    is held to a stricter bar: there "condition false" means the element
  //    was VISIBLE, and the element leaving is the transition itself — so ANY
  //    untrusted final read, however short the tail, leaves gone-ness
  //    unconfirmable.
  // 3. Dark tail within the tolerance — a genuine last-poll blip: trusted
  //    reads showed the condition false until at most ~one poll interval
  //    before the deadline, so they still describe the window and a transient
  //    fetch error on the trailing poll must not flip a clean skip into a
  //    hard error. The determinate verdict stands, with the failed final read
  //    appended so the error is not silently dropped from the report.
  if (lastTrustedReadAt === undefined) {
    return {
      ok: false,
      indeterminate: true,
      reason: fetchError
        ? `could not read the UI tree: ${fetchError}`
        : "could not evaluate the condition — every read of the UI tree was empty or degraded",
    };
  }
  if (!lastReadTrusted) {
    // `hidden` with an evidence gap: the element matched on an earlier
    // trusted read and the FINAL read attempt was blind or threw, so
    // gone-ness can't be confirmed — no blip tolerance here (tier 2's
    // stricter bar). (A trusted read WITHOUT a visible match would have
    // satisfied `hidden` inside the loop, so a trusted final read implies it
    // saw the element — that falls through to the determinate "still
    // visible" below with `lastMatches` fresh from that read.)
    if (step.condition === "hidden") {
      return {
        ok: false,
        indeterminate: true,
        reason: fetchError
          ? `could not confirm the element is hidden — it was visible earlier, but the last UI read failed: ${fetchError}`
          : "could not confirm the element is hidden — it was visible earlier, but the last UI reads were empty",
      };
    }
    const darkTailMs = Date.now() - lastTrustedReadAt;
    if (darkTailMs > CONDITION_DARK_TAIL_TOLERANCE_MS) {
      return {
        ok: false,
        indeterminate: true,
        reason: fetchError
          ? `could not evaluate the condition — the UI tree was unreadable for the final ${darkTailMs}ms of the window: ${fetchError}`
          : `could not evaluate the condition — the UI tree reads were empty or degraded for the final ${darkTailMs}ms of the window`,
      };
    }
  }
  // Tier 3 (or a trusted final read): the verdict is determinate; a blip's
  // failed final read is appended, not dropped.
  const blipNote =
    !lastReadTrusted && fetchError
      ? ` (the final poll could not read the UI tree: ${fetchError})`
      : "";
  return {
    ok: false,
    reason:
      assertReason(step.condition, step.selector, step.expectedText, step.textMatch, lastMatches) +
      compatibilityMissNote(lastTree, step.selector, step.expectedText) +
      blipNote,
  };
}

/**
 * When a selector (or a `text` expectation) missed and the ONLY thing standing
 * between it and a match is a compatibility variant, say which one.
 *
 * Those variants are deliberately not folded away — a blackletter name must
 * not match the account it imitates — but the common case is innocent: an
 * author types `...` for a label the app renders with a single `…`, and gets
 * "no element matched", which points at nothing. Naming the character on
 * screen turns an unexplainable miss into a one-line fix.
 */
function compatibilityMissNote(
  tree: DescribeNode | undefined,
  selector: FlowSelector,
  expectedText: string | undefined
): string {
  const wanted = typeof selector.text === "string" ? selector.text : expectedText;
  if (tree === undefined || wanted === undefined || wanted === "") return "";
  let hit: string | undefined;
  const walk = (node: DescribeNode): void => {
    if (hit !== undefined) return;
    for (const candidate of [node.label, node.value, node.subtreeText]) {
      if (candidate && compatibilityVariantOf(candidate, wanted)) {
        hit = candidate;
        return;
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return hit === undefined
    ? ""
    : ` — the screen does show "${hit}", which differs only by a typographic variant ` +
        `(a rendered "…" is ONE character, not three dots; likewise ligatures and fullwidth ` +
        `forms). Those are not folded together, because doing so would also equate a styled ` +
        `display name with the plain one it imitates. Copy the characters the app actually renders.`;
}

// ── Screen identity and readiness ────────────────────────────────────
//
// Two checks a selector condition cannot express, and which the flows that
// prompted them were substituting fixed `wait:` steps for:
//
//   screen  — WHICH screen, from the app's own navigation state
//   idle    — has it stopped moving
//
// They are deliberately separate. A dropped tap leaves the source screen
// perfectly idle, so readiness cannot prove identity; navigation state commits
// before the transition animates, so identity cannot prove readiness.

/** Route-fingerprint poll cadence. `assert` uses timeout 0 — one probe. */
const SCREEN_POLL_MS = 250;
const SCREEN_DEFAULT_TIMEOUT_MS = 7500;
const DEFAULT_METRO_PORT = 8081;

/** `idle` poll cadence, matching `await-screen-idle`'s defaults. */
const IDLE_POLL_MS = 200;
const IDLE_DEFAULT_TIMEOUT_MS = 7500;
const IDLE_DEFAULT_MIN_STABLE_MS = 250;

/**
 * How long a route-reader connect may keep retrying. Floored so an `assert`
 * (budget 0) still rides out a connect that is merely early, and otherwise the
 * step's own `timeout:` — connecting is setup, so it is NOT charged against the
 * route-polling budget (see {@link waitForScreen}); a `timeout:` therefore buys
 * time for both phases rather than being silently spent on one.
 */
const CONNECT_RETRY_FLOOR_MS = 2500;
const CONNECT_RETRY_INTERVAL_MS = 400;

/**
 * The floor for the FIRST connect after a `launch`, which is a cold one: the
 * app has just been terminated and relaunched, and it re-registers with Metro
 * on its own schedule — measured at ~12.5s for a React Native app on a loaded
 * simulator host. The previous 5s cap made the gate in the position both flow
 * skills mandate (`launch:` then identity) unreachable: the connect gave up
 * before the app came back, no `timeout:` could raise the cap, and the step
 * reported an environment failure naming three causes that were all false.
 *
 * Spent only while Metro is actually REACHABLE on the port (see
 * {@link metroReachable}). An app with no Metro at all — a release build, a
 * fully native app — still fails fast on the floor above rather than making
 * every run wait out this window to be told what it could learn immediately.
 */
const POST_LAUNCH_CONNECT_FLOOR_MS = 20_000;

function connectBudgetMs(stepTimeoutMs: number): number {
  return Math.max(CONNECT_RETRY_FLOOR_MS, stepTimeoutMs);
}

/**
 * The run's route reader for `appId`, connecting on first use and retrying
 * within `budgetMs` until one lands.
 *
 * Only a SUCCESSFUL connect is memoized. The debugger session is tied to the
 * app process, so a `launch` invalidates it and the gate that follows connects
 * into the gap while the app re-registers with Metro; remembering that failure
 * poisoned every later gate on the run. Retrying inside the step's budget is
 * also what makes `flow-execute` own connection setup end to end — recycling
 * the simulator services before a run no longer needs an external ordering
 * ritual to be survivable.
 */
async function routeReaderFor(
  env: ActionEnv,
  appId: string,
  metroPort: number,
  budgetMs: number
): Promise<RouteReader | null> {
  const state = env.screenIdentity;
  if (state === undefined) return null;
  const key = `${appId}@${metroPort}`;
  const cached = state.readers.get(key);
  if (cached !== undefined) return cached;
  if (state.unsupported.has(key) || state.connectExhausted.has(key)) return null;
  // chromium has no React Navigation; ios-remote is an iOS simulator over a
  // remote bridge and reads exactly like a local one.
  const platform = env.device.platform === "ios-remote" ? "ios" : env.device.platform;
  if (platform === "chromium") {
    state.unsupported.add(key);
    return null;
  }
  let deadline = Date.now() + budgetMs;
  // A cold epoch is the window after a `launch`, where the app is not merely
  // slow to answer but absent from Metro entirely while it boots. Extending the
  // budget there is only justified while Metro itself is up: that is what
  // distinguishes "the app has not re-registered YET" from "this build has no
  // reader at all", and only the first is worth waiting out.
  if (state.coldSinceLaunch && budgetMs < POST_LAUNCH_CONNECT_FLOOR_MS) {
    if (await metroReachable(metroPort)) {
      deadline = Math.max(deadline, Date.now() + POST_LAUNCH_CONNECT_FLOOR_MS);
    }
  }
  for (;;) {
    if (env.signal?.aborted) return null;
    const reader = await connectRouteReader(env.registry, env.ctx, {
      udid: env.device.id,
      bundleId: appId,
      metroPort,
      platform,
    });
    if (reader) {
      state.readers.set(key, reader);
      // The app is registered and attached; a later connect in this run is a
      // reconnect, not a cold boot, and must not buy the launch window again.
      state.coldSinceLaunch = false;
      return reader;
    }
    if (Date.now() >= deadline) {
      state.connectExhausted.add(key);
      return null;
    }
    const sleepMs = Math.min(CONNECT_RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, env.signal))) return null;
  }
}

/**
 * Whether a Metro dev server is answering on `port` at all. Never throws.
 *
 * Asks only whether the SERVER is up, not whether an app is attached to it —
 * see {@link metroServerRunning}. Both callers below are in the window right
 * after a `launch`, where the app under test has deregistered and a Metro
 * serving only that app reports an empty target list. Answering this question
 * with target discovery made both of them read that normal window as "Metro is
 * down": the connect budget lost its post-launch extension, and the failure
 * told the author to start a server that was already running.
 */
async function metroReachable(port: number): Promise<boolean> {
  return metroServerRunning(port);
}

/**
 * Drop a memoized reader whose debugger session has gone dead (the app
 * reloaded, the services were recycled) so the next gate reconnects instead of
 * reusing a handle that can only ever return null.
 */
function evictRouteReader(env: ActionEnv, appId: string, metroPort: number): boolean {
  const key = `${appId}@${metroPort}`;
  // Re-arm the budget alongside the eviction: this path exists precisely to
  // spend one more connect, so an exhaustion recorded earlier in the epoch
  // must not short-circuit it.
  env.screenIdentity?.connectExhausted.delete(key);
  return env.screenIdentity?.readers.delete(key) ?? false;
}

/**
 * Forget every route reader, and re-arm the retry budget — called by `launch`,
 * which terminates the app and with it the JS runtime each reader is attached
 * to. Without this a post-launch gate would probe a handle onto a process that
 * no longer exists, and a connect that failed before the relaunch would keep
 * standing in for one that has every reason to succeed now.
 */
export function resetRouteReaders(state: ScreenIdentityState | undefined): void {
  state?.readers.clear();
  state?.connectExhausted.clear();
  // The app is coming back from a cold start; the next connect must be allowed
  // to wait out its Metro re-registration (see POST_LAUNCH_CONNECT_FLOOR_MS).
  if (state) state.coldSinceLaunch = true;
}

/**
 * Prove the app is on the screen the step names, by exact route match.
 *
 * Every failure mode is distinct in the reason, because they call for opposite
 * responses: a DIFFERENT route means the app is genuinely elsewhere (a dropped
 * tap, or a real regression — the thing the flow exists to catch); NO route
 * means the check itself could not run, which is never allowed to read as a
 * pass.
 */
async function waitForScreen(
  env: ActionEnv,
  step: Extract<FlowStep, { kind: "screen" }>
): Promise<DirectiveOutcome> {
  const appId = step.app ?? env.screenIdentity?.launchedAppId;
  if (appId === undefined) {
    return {
      ok: false,
      indeterminate: true,
      reason:
        "no app to read the route from — add `app:` to the screen check, or a `launch` step " +
        "before it so the flow declares which app it drives",
    };
  }
  const metroPort = step.metroPort ?? DEFAULT_METRO_PORT;
  const timeoutMs = step.mode === "assert" ? 0 : (step.timeout ?? SCREEN_DEFAULT_TIMEOUT_MS);

  const reader = await routeReaderFor(env, appId, metroPort, connectBudgetMs(timeoutMs));
  // Deliberately anchored AFTER the connect. `timeout:` is the author's answer
  // to "how long may this screen take to arrive", and attaching the debugger is
  // not the screen arriving: charging setup to the same budget made a generous
  // timeout buy nothing on exactly the gate that needed it (the one after a
  // `launch`), and made "waited 7500ms" describe a window that was mostly spent
  // connecting.
  const deadline = Date.now() + timeoutMs;
  if (env.signal?.aborted) return ABORTED_OUTCOME;
  if (reader === null) {
    // A platform that can never have a route reader is a different answer from
    // a connect that did not land, and it deserves to be said: telling a
    // Chromium author that "Metro is down" and to "fix the connection" sends
    // them after something that does not exist and cannot be repaired — and
    // since an indeterminate step reports as `errored`, the QA contract's
    // "fix the environment and rerun" would loop forever on it.
    const unsupported = env.screenIdentity?.unsupported.has(`${appId}@${metroPort}`) === true;
    if (unsupported) {
      return {
        ok: false,
        indeterminate: true,
        reason:
          `\`screen\` reads the focused React Navigation route over the Metro debugger, and ` +
          `${env.device.platform} has neither — no retry or environment change will make this ` +
          `work. Gate this navigation on a destination-only element instead.`,
      };
    }
    // Which of the causes actually holds is checkable, so check it rather than
    // listing all of them: naming "Metro is down" while Metro is demonstrably
    // up sends the author to repair something that is not broken, and the
    // conclusion they draw — that this app can only be gated on elements —
    // deletes the identity proof for the rest of the flow.
    const metroUp = await metroReachable(metroPort);
    return {
      ok: false,
      indeterminate: true,
      reason: metroUp
        ? `Metro is running on port ${metroPort}, but no debuggable target for "${appId}" ` +
          `registered there in time. The app re-registers a few seconds AFTER it relaunches, so ` +
          `a gate this close to a \`launch\` can outrun it. The fix is the readiness gate the ` +
          `launch itself is supposed to have: an \`await\` on the real first screen, recorded ` +
          `directly after \`launch:\`, which holds until the app is actually up and leaves this ` +
          `route readable. (That is the launch's own gate — it does NOT reorder identity and ` +
          `readiness within a navigation, where identity still comes first.) Failing that, ` +
          `raise this step's \`timeout:\`. Otherwise this build is not a debuggable RN build, ` +
          `or the port serves a different app. Screen identity is unknown, not wrong.`
        : `no Metro dev server is answering on port ${metroPort}, so the route cannot be read ` +
          `for "${appId}". This is an environment failure, not a verdict about the app: start ` +
          `Metro (or point the step at the right \`metroPort:\`), or gate on a destination-only ` +
          `element instead of \`screen\`.`,
    };
  }
  // The polling budget is the step's whole `timeout:`, because `deadline` was
  // anchored after the connect (above) — the connect is setup and is NOT
  // charged here. A function rather than a constant because the reconnect path
  // below re-enters this with time already spent, and an `assert` (budget 0)
  // still gets its single probe, the same floor it runs on everywhere.
  const pollMs = () => Math.max(0, deadline - Date.now());
  let outcome = await verifyRouteFingerprint(
    reader,
    step.route,
    pollMs(),
    SCREEN_POLL_MS,
    env.signal
  );
  // Every probe came back null: either the screen genuinely has no route, or
  // the memoized reader is attached to a runtime that has since gone away (a
  // Fast Refresh reload, recycled services). The two are indistinguishable
  // from here, so spend one reconnect finding out rather than reporting an
  // environment problem the run could have repaired itself.
  if (!outcome.ok && !outcome.aborted && outcome.observedRoute === undefined) {
    if (env.signal?.aborted) return ABORTED_OUTCOME;
    if (evictRouteReader(env, appId, metroPort)) {
      const fresh = await routeReaderFor(env, appId, metroPort, connectBudgetMs(timeoutMs));
      if (env.signal?.aborted) return ABORTED_OUTCOME;
      if (fresh) {
        outcome = await verifyRouteFingerprint(
          fresh,
          step.route,
          pollMs(),
          SCREEN_POLL_MS,
          env.signal
        );
      }
    }
  }
  if (outcome.aborted) return ABORTED_OUTCOME;
  if (outcome.ok) return { ok: true };
  if (outcome.observedRoute !== undefined) {
    return {
      ok: false,
      reason:
        `the app is on "${outcome.observedRoute}", not "${step.route}"` +
        (timeoutMs > 0 ? ` (waited ${timeoutMs}ms)` : "") +
        " — the navigation did not land where this step expects",
    };
  }
  return {
    ok: false,
    indeterminate: true,
    reason:
      `no focused route could be read within ${timeoutMs}ms — the screen is native, the app ` +
      `reloaded, or the transition never settled. Screen identity is unknown, not wrong.`,
  };
}

/**
 * Wait until the UI tree has content and holds it identical for `minStableMs`.
 *
 * This is `await-screen-idle`'s question asked against the tree the directives
 * actually resolve against, and — unlike that tool — it FAILS when the screen
 * never settles, which is what makes it safe to persist in a flow. It says
 * nothing about which screen settled: pair it with a `screen` or element check.
 */
async function waitForIdle(
  env: ActionEnv,
  step: Extract<FlowStep, { kind: "idle" }>
): Promise<DirectiveOutcome> {
  const timeoutMs = step.timeout ?? IDLE_DEFAULT_TIMEOUT_MS;
  const minStableMs = step.minStableMs ?? IDLE_DEFAULT_MIN_STABLE_MS;
  const deadline = Date.now() + timeoutMs;
  let stableSignature: string | undefined;
  let stableSince = 0;
  let sawContent = false;
  let fetchError: string | undefined;

  for (;;) {
    if (env.signal?.aborted) return ABORTED_OUTCOME;
    try {
      const { tree } = await fetchFlowTree(env.registry, env.device);
      fetchError = undefined;
      if (tree.children.length === 0) {
        // Blank or still loading — never "settled", and it resets the hold.
        stableSignature = undefined;
        stableSince = 0;
      } else {
        sawContent = true;
        const signature = treeFingerprint(tree);
        const now = Date.now();
        if (signature === stableSignature) {
          if (now - stableSince >= minStableMs) return { ok: true };
        } else {
          stableSignature = signature;
          stableSince = now;
          if (minStableMs === 0) return { ok: true };
        }
      }
    } catch (err) {
      // A tree-source blip mid-animation is expected; keep polling. Only its
      // persistence to the deadline is reportable.
      fetchError = err instanceof Error ? err.message : String(err);
      stableSignature = undefined;
      stableSince = 0;
    }
    if (env.signal?.aborted) return ABORTED_OUTCOME;
    if (Date.now() >= deadline) break;
    if (!(await sleepOrAbort(IDLE_POLL_MS, env.signal))) return ABORTED_OUTCOME;
  }

  // "Never stopped moving" is a real verdict about the app. "Never got a
  // readable tree" is not — it must not masquerade as one.
  if (!sawContent) {
    return {
      ok: false,
      indeterminate: true,
      reason: fetchError
        ? // The underlying reader reports an instrumentation failure, whose
          // remedy (relaunch the app) is the wrong repair for the commonest
          // cause of it here: the app is simply not in the foreground, which
          // reads exactly the same from the tree source. Name that first so
          // the author checks it before relaunching anything.
          `could not read the UI tree while waiting for the screen to settle — check the app is ` +
          `still in the foreground (a backgrounded app reads the same as an uninstrumented one). ` +
          `Underlying error: ${fetchError}`
        : `the UI tree stayed empty for ${timeoutMs}ms — the screen never rendered content`,
    };
  }
  return {
    ok: false,
    reason:
      `the screen never held still for ${minStableMs}ms within ${timeoutMs}ms — it is still ` +
      `animating, or something on it is permanently in motion (a spinner, a looping animation). ` +
      `Gate on the element you actually need instead of on stillness.`,
  };
}

function assertReason(
  condition: WaitCondition,
  selector: FlowSelector,
  expectedText: string | undefined,
  textMatch: TextMatchMode | undefined,
  matches: ReturnType<typeof findAll>
): string {
  const sel = describeSelector(selector);
  switch (condition) {
    case "exists":
      return `no element matched selector ${sel}`;
    case "visible":
      return matches.length > 0
        ? `element(s) matched ${sel} but none was visible (zero-area frame)`
        : `no element matched selector ${sel}`;
    case "hidden":
      // Reached only when the final read was trusted (waitForCondition
      // returns indeterminate when it was blind or threw), and a trusted read
      // without a visible match satisfies `hidden` inside the poll loop — so
      // `matches` holds what that read saw: the element, still on screen.
      return `an element matching ${sel} was still visible`;
    case "text": {
      const first = firstInReadingOrder(matches.filter(isVisible)) ?? firstInReadingOrder(matches);
      if (!first) return `no element matched selector ${sel}`;
      const wanted = describeTextExpectation(expectedText, textMatch, "infinitive");
      // The check accepts the element's own label/value as well as its hoisted
      // subtree text (see evaluateCondition), so when they differ quote both —
      // the author may have been asserting against either.
      const shown = assertText(first);
      const own = nodeText(first);
      const ownNote = own && own !== shown ? ` (own text "${own}")` : "";
      // The two quoted strings can be indistinguishable on screen and still
      // compare unequal (an NBSP in a currency label, a stray variation
      // selector). Say which codepoints differ rather than printing the same
      // text twice and calling it a mismatch.
      //
      // Only for the LITERAL modes: in `matches` the "expected" string is a
      // regular expression, not text, so comparing its code points against the
      // element's would describe a mismatch that has nothing to do with the
      // pattern that failed.
      const confusable =
        expectedText !== undefined && textMatch !== "matches"
          ? (confusableTextNote(shown, expectedText) ?? confusableTextNote(own, expectedText))
          : undefined;
      return (
        `element matched ${sel} but its text was "${shown}"${ownNote} (wanted to ${wanted})` +
        (confusable ? ` — ${confusable}` : "")
      );
    }
    default:
      return `assertion failed for selector ${sel}`;
  }
}
