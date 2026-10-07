/**
 * `navigate-to` (ticket B2, design §2.2): replay a planned action path to a
 * target screen or selector, verifying the device's structural hash at each
 * step and stopping on divergence. Android + open-device-server only, gated
 * behind the `screen-graph` flag (and hidden without `open-device-server`).
 */
import { z } from "zod";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { Registry, ToolCapability, ToolContext, ToolDefinition } from "@argent/registry";
import { isFlagEnabled } from "@argent/configuration-core";
import { resolveDevice } from "../../utils/device-info";
import { openDeviceServerMutex } from "../../utils/device-mutex";
import {
  openDeviceServerRef,
  scrollNodeId,
  type OpenDeviceServerApi,
  type OpenServerSelector,
} from "../../blueprints/android-open-server";
import {
  resolveStoreForCurrentApp,
  screenGraphTemplatesEnabled,
} from "../../utils/screen-graph-open-wiring";
import {
  DEFAULT_STABLE_MATCH_THRESHOLD,
  GRID,
  buildSummary,
  hash8,
  isScrollingElement,
  multisetJaccard,
  nodeResourceIds,
  nonScrollRids,
  parseSelectorKey,
  plan,
  planToSelectorStable,
  planToTemplate,
  renderSummary,
  resolveContainer,
  runNavigation,
  selectorKeys,
  stripId,
  type CanonicalAction,
  type EdgeSelector,
  type GraphSelector,
  type PlanGraph,
  type PlanResult,
  type PlanStep,
  type ScreenGraphStore,
  type ScreenNode,
  type TemplateElement,
} from "../../screen-graph";
import type { OpenServerElement } from "../describe/platforms/android/open-server-tree";

export const NAVIGATE_TO_TOOL_ID = "navigate-to";

/** Device-facing methods counted as one RPC each (phase D.2 HIGH-2). */
const RPC_METHODS = new Set<string>([
  "getInfo",
  "getState",
  "getNestedState",
  "query",
  "diff",
  "awaitChange",
  "waitForIdle",
  "screenshot",
  "getScreenSize",
  "getAccessibilityTree",
  "getNestedAccessibilityTree",
  "tap",
  "tapWithOutcome",
  "longPress",
  "longPressWithOutcome",
  "swipe",
  "swipeWithOutcome",
  "gesture",
  "gestureWithOutcome",
  "key",
  "keyWithOutcome",
  "typeText",
  "typeTextWithOutcome",
]);

const selectorSchema = z
  .object({
    id: z.string().optional(),
    text: z.string().optional(),
  })
  .refine((s) => s.id !== undefined || s.text !== undefined, {
    message: "selector needs an id or text",
  });

const zodSchema = z.object({
  udid: z.string().min(1).describe("Android serial from `list-devices`."),
  target: z
    .object({
      screen: z.string().optional().describe("Target screen hash (a graph node id)."),
      selector: selectorSchema
        .optional()
        .describe("Reach the nearest screen whose index holds this resource-id / text."),
    })
    .refine((t) => t.screen !== undefined || t.selector !== undefined, {
      message: "target needs a screen or a selector",
    }),
});

type Params = z.infer<typeof zodSchema>;

interface NavigateToResult {
  reached: boolean;
  /** Label or hash8 of the screen navigation ended on. */
  finalScreen: string;
  completedSteps: number;
  totalSteps: number;
  /** Rendered summary of the final screen, when it is a known node. */
  summary?: string;
  /** Present when a step landed on an unexpected screen. */
  divergence?: { reachedStep: number; expected: string; actual: string };
  /** Present when no plan could be produced. */
  error?: string;
  /**
   * How the CURRENT screen was localized to a graph node before planning (C.4):
   * `exact` (its hash was a node), `jaccard` (a resource-id match recovered a
   * drifted node), or `none` (no node matched — planning ran from the raw hash).
   */
  fromVia?: "exact" | "jaccard" | "none";
  /** Resource-id Jaccard score when `fromVia === "jaccard"`. */
  fromScore?: number;
  /**
   * Why a step diverged during replay when the acted element could not be
   * uniquely re-resolved on the live tree (phase D.1 Fix A): `selector ambiguous
   * on live tree` (a recorded key matched >1 live node) or `selector unresolved
   * on live tree` (matched 0). Absent when divergence was a plain hash mismatch.
   */
  divergeReason?: string;
  /**
   * Measured count of device RPCs this navigate-to issued (phase D.2 HIGH-2):
   * the initial getState + getInfo, plus per planned step a query (resolveTapPoint)
   * + a tap + a getState. Replaces the modelled "1 navigate + 1 verify".
   */
  rpcCount?: number;
}

/** Resource-id multiset of a live open-server tree (C.4 stable localization). */
function resourceIdsOf(tree: OpenServerElement[]): string[] {
  const ids: string[] = [];
  for (const el of tree) {
    const id = (el.resourceId ?? "").trim();
    if (id) ids.push(id);
  }
  return ids;
}

const capability: ToolCapability = {
  android: { emulator: true, device: true, unknown: true },
};

function toOpenSelector(target: { id?: string; text?: string }): OpenServerSelector {
  const sel: OpenServerSelector = {};
  if (target.id) sel.id = target.id;
  if (target.text) sel.text = target.text;
  return sel;
}

/**
 * Which 1/16 grid cell a point falls in (mirrors `canonical.ts` bucketing), so a
 * stored index entry can be matched back to a bucketed tap.
 */
function bucketAxis(value: number, dim: number): number {
  if (dim <= 0) return 0;
  return Math.min(GRID - 1, Math.max(0, Math.floor((value * GRID) / dim)));
}

/**
 * The selector of the FROM node's index entry whose bounds centre falls in
 * `bucket` (Phase B leftover B1). A bucketed tap has no stored id/text, so before
 * tapping the bare coordinate we recover the selector that was there last time to
 * `query` for it on the live screen. Returns null when nothing was indexed in
 * that cell.
 */
export function indexEntryForBucket(
  index: ScreenNode["index"],
  bucket: { x: number; y: number },
  size: { width: number; height: number }
): GraphSelector | null {
  for (const [key, entry] of Object.entries(index)) {
    const cx = (entry.bounds.x1 + entry.bounds.x2) / 2;
    const cy = (entry.bounds.y1 + entry.bounds.y2) / 2;
    if (bucketAxis(cx, size.width) === bucket.x && bucketAxis(cy, size.height) === bucket.y) {
      const sel = parseSelectorKey(key);
      if (sel) return sel;
    }
  }
  return null;
}

/** A resolved tap point, or a signal to diverge (the stored element is gone). */
type TapResolution = { cx: number; cy: number } | { diverge: true; reason?: string };

/** The resulting screen's IDENTITY hash `H_id` (phase D §1), else the raw hash. */
function idOf(state: { idHash?: string; hash?: string }): string {
  return state.idHash ?? state.hash ?? "";
}

/** Execute one canonical action on the device, returning the resulting H_id. */
async function executeCanonicalAction(
  server: OpenDeviceServerApi,
  size: { width: number; height: number },
  action: CanonicalAction,
  fromIndex?: ScreenNode["index"],
  selector?: EdgeSelector,
  onDiverge?: (reason?: string) => void
): Promise<string> {
  switch (action.kind) {
    case "tap":
    case "longPress": {
      const point = await resolveTapPoint(server, size, action, fromIndex, selector);
      if ("diverge" in point) {
        // The acted element could not be re-resolved on the live screen: don't tap
        // blindly (phase D §2 — "an edge whose selector cannot be resolved is not
        // taken"). Surface the reason and report the current H_id so runNavigation
        // records a divergence.
        onDiverge?.(point.reason);
        return idOf(await server.getState({ includeScreenshot: false, fingerprints: true }));
      }
      const { cx, cy } = point;
      const res =
        action.kind === "tap"
          ? await server.tapWithOutcome(cx, cy)
          : await server.longPressWithOutcome(cx, cy);
      return res.after.idHash ?? res.after.hash;
    }
    case "swipe": {
      const { sx, sy, ex, ey } = swipeVector(size, action.dir);
      const res = await server.swipeWithOutcome(sx, sy, ex, ey, 10);
      return res.after.idHash ?? res.after.hash;
    }
    case "back": {
      const res = await server.keyWithOutcome("KEYCODE_BACK");
      return res.after.idHash ?? res.after.hash;
    }
    case "key": {
      const res = await server.keyWithOutcome(action.key ?? "KEYCODE_ENTER");
      return res.after.idHash ?? res.after.hash;
    }
    case "typeText": {
      if (action.target?.text) {
        const res = await server.typeTextWithOutcome(action.target.text);
        return res.after.idHash ?? res.after.hash;
      }
      // Nothing to type without stored text — read the current H_id instead.
      return idOf(await server.getState({ includeScreenshot: false, fingerprints: true }));
    }
  }
}

/**
 * Live tap point for a canonical action. Phase D §2: PREFER the recorded edge
 * selector — re-resolve it on the live screen by resource-id, then text, then
 * content-description — and DIVERGE when a selector was recorded but none of its
 * fields resolve (never replay the stale coordinate). Fall back to the bucket only
 * when the edge carries no selector at all.
 */
export async function resolveTapPoint(
  server: OpenDeviceServerApi,
  size: { width: number; height: number },
  action: CanonicalAction,
  fromIndex?: ScreenNode["index"],
  selector?: EdgeSelector
): Promise<TapResolution> {
  const centreOf = (n: {
    bounds: { x1: number; y1: number; x2: number; y2: number };
  }): TapResolution => ({
    cx: Math.round((n.bounds.x1 + n.bounds.x2) / 2),
    cy: Math.round((n.bounds.y1 + n.bounds.y2) / 2),
  });
  // Ordered candidate keys. Phase D.1 Fix A: honour the key that was UNIQUE at
  // record time (`selector.via`) FIRST, then the remaining keys as fallback.
  // `action.target` (folded from `via` at record time) is included so a plan step
  // without an explicit `selector` still routes.
  type Cand = { field: "id" | "text"; value: string };
  const candidates: Cand[] = [];
  const seen = new Set<string>();
  const push = (c: Cand | undefined): void => {
    if (!c || !c.value) return;
    const key = `${c.field}:${c.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(c);
  };
  const rid = selector?.resourceId ?? action.target?.id;
  const txt = selector?.text ?? action.target?.text;
  const cd = selector?.contentDescription;
  const idC: Cand | undefined = rid ? { field: "id", value: rid } : undefined;
  const txtC: Cand | undefined = txt ? { field: "text", value: txt } : undefined;
  const cdC: Cand | undefined = cd ? { field: "text", value: cd } : undefined;
  if (selector?.via === "id") push(idC);
  else if (selector?.via === "text") {
    push(txtC);
    push(cdC);
  }
  // Remaining fallbacks in the default precedence (id → text → cd).
  push(idC);
  push(txtC);
  push(cdC);
  if (candidates.length > 0) {
    // Phase D.1 Fix A: require a UNIQUE live match. A resource-id shared by many
    // rows (every Settings list row is `android:id/title`) must NOT resolve to
    // `nodes[0]` — that lands on the wrong sibling and diverges. Query with a
    // (device-supported) case-insensitive CONTAINS matcher, then filter the
    // returned nodes to an EXACT (whole-field, case-insensitive) match — the same
    // uniqueness the recorder used — and tap only when exactly ONE remains.
    // Refuse (diverge) when a key matched >1 or 0, rather than tap blindly.
    const norm = (s: string | undefined): string => (s ?? "").trim().toLowerCase();
    let sawAmbiguous = false;
    for (const c of candidates) {
      const want = norm(c.value);
      const sel: OpenServerSelector =
        c.field === "id"
          ? { id: { contains: c.value, caseInsensitive: true } }
          : { text: { contains: c.value, caseInsensitive: true } };
      const q = await server.query(sel, { limit: 20 });
      const exact = q.nodes.filter((n) =>
        c.field === "id" ? norm(n.id) === want : norm(n.text) === want || norm(n.cd) === want
      );
      if (exact.length === 1) return centreOf(exact[0]!);
      if (exact.length > 1) sawAmbiguous = true;
    }
    // A selector was recorded but no key uniquely resolved — the edge is not taken.
    return {
      diverge: true,
      reason: sawAmbiguous ? "selector ambiguous on live tree" : "selector unresolved on live tree",
    };
  }
  if (action.bucket) {
    // Phase B leftover B1: a bucketed tap has no id/text. If the FROM node's
    // index recorded something in that cell, `query` for it and tap its LIVE
    // position (robust to layout shift); diverge when it — or nothing indexed
    // there — is no longer present, rather than tapping empty space.
    if (fromIndex) {
      const sel = indexEntryForBucket(fromIndex, action.bucket, size);
      if (!sel) return { diverge: true };
      const q = await server.query(toOpenSelector(sel), { limit: 1 });
      const node = q.nodes[0];
      if (!node) return { diverge: true };
      return {
        cx: Math.round((node.bounds.x1 + node.bounds.x2) / 2),
        cy: Math.round((node.bounds.y1 + node.bounds.y2) / 2),
      };
    }
    // No stored index for the from-screen (cold graph): tap the bucket centre.
    const cellW = size.width / GRID;
    const cellH = size.height / GRID;
    return {
      cx: Math.round((action.bucket.x + 0.5) * cellW),
      cy: Math.round((action.bucket.y + 0.5) * cellH),
    };
  }
  // Fall back to the screen centre.
  return { cx: Math.round(size.width / 2), cy: Math.round(size.height / 2) };
}

/**
 * Phase E (design D1): safety cap on how many times `navigate-to` scrolls the
 * container while looking for the concrete item behind a template step. The
 * search normally ends earlier: when the item shows up, or after one gap-free
 * pass from one end of the list to the other (the item is not in the list).
 * On the churn app's 50 rows a held scroll moves ~819 px, so a pass is 9 moving
 * scrolls + TEMPLATE_END_UNCHANGED still ones, and down + back up is 22.
 */
const TEMPLATE_MAX_SCROLLS = 30;

/** Consecutive no-change swipes that mean the container is at its end. */
const TEMPLATE_END_UNCHANGED = 2;

/**
 * Settled read of the container after a swipe (run 37572199458): the server's
 * `changed` outcome is `false` whenever no AX event lands within its 600 ms
 * first-event window (`settled:"no-event"`), which a janky emulator misses
 * (Davey frames of ~800 ms in that run), so it is not trusted to mean "the list
 * did not move". Instead the step reads the container's visible texts until two
 * consecutive reads agree (at most TEMPLATE_SETTLE_MAX_READS, TEMPLATE_SETTLE_PAUSE_MS
 * apart; the pause exceeds Android's 100 ms scroll-event throttle) and compares
 * that stable window with the one before the swipe.
 */
const TEMPLATE_SETTLE_MAX_READS = 5;
const TEMPLATE_SETTLE_PAUSE_MS = 150;

/**
 * The template scroll is momentum-free, with the steps and hold `gesture-swipe`
 * sends for `momentum: false` at its default 300 ms (19 steps, 120 ms held at the
 * end point before the lift): the OS reads ~0
 * release velocity, so the list moves by the drag alone (0.44 of the container,
 * less than one viewport) and consecutive queries see overlapping windows. Run 2
 * used a flinging swipe: the lift carried ~5 px/ms, the fling added ~1700 px to
 * the 840 px drag, one swipe moved more than the 1908 px viewport, and rows
 * between two windows were never queried (12/40 `selector unresolved`).
 */
const TEMPLATE_SCROLL_STEPS = 19;
const TEMPLATE_SCROLL_HOLD_MS = 120;

const norm = (s: string | undefined): string => (s ?? "").trim().toLowerCase();

type Box = { x1: number; y1: number; x2: number; y2: number };

/** A live flat-tree element as the template step reads it (text for matching). */
export type LiveElement = TemplateElement & { text?: string; contentDesc?: string };

/** One read of the scroll container: where it is and what it shows. */
interface ContainerRead {
  /** The container's bounds; null when the tree has none (or not the requested one). */
  bounds: Box | null;
  /**
   * The container element (review E-1 2026-10-07 finding 3): the template's own
   * container when the step names one (`containerId`), else the largest live
   * scrollable. Exact matches count only when this is the SMALLEST scrollable
   * holding their centre, so a carousel card or a title-bar text never resolves
   * a list item.
   */
  container: LiveElement | null;
  /** Every live scrollable (the smallest-container test's input). */
  scrollables: LiveElement[];
  /**
   * The visible texts inside the container with their top edge, in tree order.
   * Empty when nothing readable is inside (the step then falls back to the
   * server's `changed` outcome).
   */
  sig: string;
  /** Texts that appear once in the window (the overlap test's keys). */
  texts: Set<string>;
  /** Every label inside the container in this window (the presence sweep's input). */
  labels: string[];
}

const EMPTY_READ: ContainerRead = {
  bounds: null,
  container: null,
  scrollables: [],
  sig: "",
  texts: new Set(),
  labels: [],
};

function boxArea(b: Box): number {
  return Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
}

/**
 * The container a template step searches: the largest live scrollable whose
 * stripped resource id is `containerId` when one is named, else the largest live
 * scrollable (the pre-review behaviour, kept for a graph-free search).
 */
function pickContainer(scrollables: LiveElement[], containerId?: string): LiveElement | null {
  const pool =
    containerId === undefined
      ? scrollables
      : scrollables.filter((el) => stripId(el.resourceId) === containerId);
  let best: LiveElement | null = null;
  let bestArea = -1;
  for (const el of pool) {
    const a = boxArea(el.bounds);
    if (a > bestArea) {
      bestArea = a;
      best = el;
    }
  }
  return best;
}

/** Whether a point belongs to the read's container (it is the smallest scrollable there). */
function ownedByContainer(read: ContainerRead, x: number, y: number): boolean {
  if (!read.container) return true;
  return resolveContainer(read.scrollables, x, y) === read.container;
}

async function readContainer(
  server: OpenDeviceServerApi,
  containerId?: string
): Promise<ContainerRead> {
  let tree: LiveElement[];
  try {
    const st = await server.getState({ includeScreenshot: false });
    tree = (st?.tree ?? []) as unknown as LiveElement[];
  } catch {
    return EMPTY_READ;
  }
  const scrollables = tree.filter((el) => isScrollingElement(el));
  const container = pickContainer(scrollables, containerId);
  if (!container) return { ...EMPTY_READ, scrollables };
  const read: ContainerRead = {
    bounds: container.bounds,
    container,
    scrollables,
    sig: "",
    texts: new Set(),
    labels: [],
  };
  const parts: string[] = [];
  const counts = new Map<string, number>();
  for (const el of tree) {
    const label = (el.text ?? "").trim() || (el.contentDesc ?? "").trim();
    if (!label) continue;
    const cx = (el.bounds.x1 + el.bounds.x2) / 2;
    const cy = (el.bounds.y1 + el.bounds.y2) / 2;
    if (!ownedByContainer(read, cx, cy)) continue;
    parts.push(`${label}@${el.bounds.y1}`);
    read.labels.push(label);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  for (const [t, n] of counts) if (n === 1) read.texts.add(t);
  read.sig = parts.join("|");
  return read;
}

/**
 * Read the container until two consecutive reads agree (the list is no longer
 * animating), bounded by TEMPLATE_SETTLE_MAX_READS; returns the last read.
 */
async function stableRead(
  server: OpenDeviceServerApi,
  pauseMs: number,
  containerId?: string
): Promise<ContainerRead> {
  let prev = await readContainer(server, containerId);
  for (let i = 1; i < TEMPLATE_SETTLE_MAX_READS; i++) {
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    const cur = await readContainer(server, containerId);
    if (cur.sig === prev.sig) return cur;
    prev = cur;
  }
  return prev;
}

/** One container scroll's outcome and timing (review E-1 finding 4). */
interface SwipeTiming {
  /** The server's `changed` outcome (undefined when it gave none). */
  changed: boolean | undefined;
  /** Host wall time of the scroll RPC, ms. */
  ms: number;
  /** Device-measured DOWN-to-UP span (APK >= 0.1.24); undefined when not reported. */
  deliveredMs: number | undefined;
  /** Device-measured hold before the UP (APK >= 0.1.24); undefined when not reported. */
  heldMs: number | undefined;
  /** `"scroll-action"` for an accessibility scroll, `"motion"` for a held swipe. */
  method: "scroll-action" | "motion";
}

/**
 * Swipe the container held (momentum-free) inside its bounds (else the screen).
 * `down` reveals later items; `up` reveals earlier ones. A container wider than
 * tall (a carousel) is swiped horizontally, so a carousel template never scrolls
 * the vertical list (review E-1 finding 3).
 */
async function scrollContainer(
  server: OpenDeviceServerApi,
  size: { width: number; height: number },
  bounds: Box | null,
  dir: "down" | "up"
): Promise<SwipeTiming> {
  const b = bounds ?? { x1: 0, y1: 0, x2: size.width, y2: size.height };
  const horizontal = b.x2 - b.x1 > b.y2 - b.y1;
  let sx: number;
  let sy: number;
  let ex: number;
  let ey: number;
  if (horizontal) {
    const cy = Math.round((b.y1 + b.y2) / 2);
    const right = Math.round(b.x1 + (b.x2 - b.x1) * 0.72);
    const left = Math.round(b.x1 + (b.x2 - b.x1) * 0.28);
    [sx, ex] = dir === "down" ? [right, left] : [left, right];
    sy = cy;
    ey = cy;
  } else {
    const cx = Math.round((b.x1 + b.x2) / 2);
    const low = Math.round(b.y1 + (b.y2 - b.y1) * 0.72);
    const high = Math.round(b.y1 + (b.y2 - b.y1) * 0.28);
    [sy, ey] = dir === "down" ? [low, high] : [high, low];
    sx = cx;
    ex = cx;
  }
  const t0 = Date.now();
  const out = await server.swipeWithOutcome(
    sx,
    sy,
    ex,
    ey,
    TEMPLATE_SCROLL_STEPS,
    TEMPLATE_SCROLL_HOLD_MS
  );
  const delivered = out?.deliveredMs;
  const held = out?.heldMs;
  return {
    changed: out?.changed,
    ms: Date.now() - t0,
    deliveredMs: typeof delivered === "number" && delivered >= 0 ? delivered : undefined,
    heldMs: typeof held === "number" && held >= 0 ? held : undefined,
    method: "motion",
  };
}

/**
 * Scroll the template's container by one accessibility scroll action (APK
 * 0.1.25+) instead of a held swipe: no touch, so no fling, and the server settles
 * before it replies, so one read follows instead of a settled-read loop. `down`
 * (later items) is `forward`. Returns the scroll's timing when the server took
 * the action, `"refused"` when it answered `accepted:false` (the list end, or a
 * node that does not take the action), and throws when the RPC failed (an older
 * APK, a node the server could not resolve).
 */
async function scrollContainerByAction(
  server: OpenDeviceServerApi,
  container: LiveElement,
  dir: "down" | "up"
): Promise<SwipeTiming | "refused"> {
  const rid = stripId(container.resourceId);
  const t0 = Date.now();
  const res = await server.scrollContainer({
    nodeId: scrollNodeId(container.bounds),
    ...(rid ? { resourceId: rid } : {}),
    direction: dir === "down" ? "forward" : "backward",
    count: 1,
  });
  if (res?.accepted !== true) return "refused";
  return {
    changed: res.performed > 0,
    ms: Date.now() - t0,
    deliveredMs: undefined,
    heldMs: undefined,
    method: "scroll-action",
  };
}

/** The result of resolving a template step's concrete item on the live tree. */
interface TemplateStepOutcome {
  tapped: boolean;
  afterHash: string;
  afterResourceIds: string[];
  /** Container scrolls spent before the item resolved (or the search gave up). */
  scrolls: number;
  /** Times the search reached an end of the list and turned around. */
  reversals: number;
  /**
   * Scrolls whose settled window shared no text with the window before it: rows
   * may have been skipped (a swipe that still flung, run 37572199458).
   */
  gaps: number;
  /**
   * The search covered the list end to end in one direction with no gap and did
   * not see the item: on an unresolved outcome, the item is not in the list.
   */
  swept: boolean;
  /** Wall time of the whole step (search + tap + landed read), ms (review E-1 finding 4). */
  wallMs: number;
  /** Host wall time of each swipe RPC, ms, in order. */
  swipeMs: number[];
  /** Device-reported DOWN-to-UP span of each swipe that reported one, ms. */
  deliveredMs: number[];
  /** Device-reported hold before the UP of each held swipe that reported one, ms. */
  heldMs: number[];
  /** Scrolls done by accessibility action (`scrollContainer`), not by a swipe. */
  scrollActions: number;
  /**
   * Action scrolls whose window shared no text with the window before it. Not
   * counted in `gaps` (a page step is expected to be contiguous), but measured so
   * that assumption is checked, not asserted (a sticky header or a custom page
   * step can still skip rows).
   */
  actionNoOverlap: number;
  reason?: string;
}

export interface TemplateStepOptions {
  /** Pause between the settle reads after a swipe (tests pass 0). */
  settlePauseMs?: number;
  /**
   * The template's container (stripped resource id, `PlanStep.template.containerId`).
   * When set, the step searches and matches ONLY inside it, and fails closed when
   * it is not on the live tree. Unset: the largest live scrollable (graph-free).
   */
  containerId?: string;
}

/**
 * Phase E (design D1): resolve the concrete item for a template step. Query the
 * live tree for `wantedText`, requiring exactly one EXACT match inside the
 * template's container (the same uniqueness discipline as D.1 Fix A); when it is
 * not yet on screen, scroll the container (momentum-free, less than a viewport)
 * and re-query. The search is bidirectional: it scrolls toward the end first and,
 * when the list stops moving (TEMPLATE_END_UNCHANGED settled reads in a row equal
 * the one before the swipe), turns around, so an item ABOVE the starting window,
 * or one a flung swipe skipped, is still reached. It stops when the item
 * resolves, after one gap-free pass from end to end (`swept`), or at
 * TEMPLATE_MAX_SCROLLS; it fails closed (never taps) on an ambiguous or
 * unresolved item, or when the named container is not on screen.
 *
 * When the server offers `scrollContainer` (APK 0.1.25+) each scroll is one
 * accessibility scroll action on the container instead of a held swipe plus a
 * settled-read loop. A refused action counts as "the list did not move" once an
 * action has moved this container; before that it may mean the node does not
 * take the action, so that scroll is a held swipe. An RPC failure (older APK)
 * switches the rest of the step to the held swipe.
 */
export async function executeTemplateStep(
  server: OpenDeviceServerApi,
  size: { width: number; height: number },
  wantedText: string,
  opts: TemplateStepOptions = {}
): Promise<TemplateStepOutcome> {
  const t0 = Date.now();
  const pauseMs = opts.settlePauseMs ?? TEMPLATE_SETTLE_PAUSE_MS;
  const containerId = opts.containerId;
  const want = norm(wantedText);
  let scrolls = 0;
  let unchanged = 0;
  let reversals = 0;
  let gaps = 0;
  let swept = false;
  let dir: "down" | "up" = "down";
  const swipeMs: number[] = [];
  const deliveredMs: number[] = [];
  const heldMs: number[] = [];
  let scrollActions = 0;
  let actionNoOverlap = 0;
  // Accessibility scroll: offered by the server, not yet failed, and whether an
  // action has moved this container (a refusal before that is not trusted).
  let actionScroll = typeof server.scrollContainer === "function";
  let actionMoved = false;
  // A pass is clean when it started at an end and no scroll in it left a gap.
  let passFromEnd = false;
  let passGap = false;
  let prev = await stableRead(server, pauseMs, containerId);
  const telemetry = () => ({
    scrolls,
    reversals,
    gaps,
    swept,
    wallMs: Date.now() - t0,
    swipeMs,
    deliveredMs,
    heldMs,
    scrollActions,
    actionNoOverlap,
  });
  const giveUp = async (reason: string): Promise<TemplateStepOutcome> => {
    const cur = await server.getState({ includeScreenshot: false, fingerprints: true });
    return {
      tapped: false,
      afterHash: idOf(cur),
      afterResourceIds: resourceIdsOf(cur.tree),
      ...telemetry(),
      reason,
    };
  };
  if (containerId !== undefined && !prev.container) {
    return giveUp("template container not on live tree");
  }
  for (;;) {
    const q = await server.query(
      { text: { contains: wantedText, caseInsensitive: true }, visible: true },
      { limit: 20 }
    );
    const exact = q.nodes.filter((n) => {
      if (norm(n.text) !== want && norm(n.cd) !== want) return false;
      const b = n.bounds;
      return ownedByContainer(prev, (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2);
    });
    if (exact.length === 1) {
      const b = exact[0]!.bounds;
      const cx = Math.round((b.x1 + b.x2) / 2);
      const cy = Math.round((b.y1 + b.y2) / 2);
      await server.tapWithOutcome(cx, cy);
      const after = await server.getState({ includeScreenshot: false, fingerprints: true });
      return {
        tapped: true,
        afterHash: idOf(after),
        // Phase E: a template node stores the destination's NON-scroll rid multiset
        // (system + inside-scroll ids removed), so the arrival Jaccard must compare
        // the live side the SAME way — else the live `statusBar`/`navigationBar`
        // decor ids drop the score below 0.9 (run 34957934222: 7/9 = 0.78).
        afterResourceIds: nonScrollRids(after.tree as unknown as TemplateElement[], ""),
        ...telemetry(),
      };
    }
    if (exact.length > 1) return giveUp("selector ambiguous on live tree");
    if (swept || scrolls >= TEMPLATE_MAX_SCROLLS) break;
    let sw: SwipeTiming | null = null;
    let cur: ContainerRead | null = null;
    if (actionScroll && prev.container) {
      try {
        const r = await scrollContainerByAction(server, prev.container, dir);
        if (r !== "refused") {
          sw = r;
          actionMoved = true;
          // The server settled before replying: one read is the final window.
          cur = await readContainer(server, containerId);
        } else if (actionMoved) {
          // The container took actions before: a refusal is its end.
          sw = {
            changed: false,
            ms: 0,
            deliveredMs: undefined,
            heldMs: undefined,
            method: "scroll-action",
          };
          cur = prev;
        }
      } catch {
        actionScroll = false;
      }
    }
    if (!sw || !cur) {
      sw = await scrollContainer(server, size, prev.bounds, dir);
      cur = await stableRead(server, pauseMs, containerId);
    }
    scrolls += 1;
    if (sw.method === "scroll-action") scrollActions += 1;
    swipeMs.push(sw.ms);
    if (sw.deliveredMs !== undefined) deliveredMs.push(sw.deliveredMs);
    if (sw.heldMs !== undefined) heldMs.push(sw.heldMs);
    // Trust the settled window when the container shows readable content;
    // without it, fall back to the server's outcome (unknown counts as moved).
    const readable = prev.sig !== "" || cur.sig !== "";
    const moved = readable ? cur.sig !== prev.sig : sw.changed !== false;
    if (moved) {
      unchanged = 0;
      const overlap = readable && [...cur.texts].some((t) => prev.texts.has(t));
      // An accessibility scroll moves the container by its own page step, the
      // window right after the previous one, so it is expected to skip no row
      // even when the two windows share no text: only a swipe (which can still
      // fling) counts a gap. The action case is counted on its own
      // (`actionNoOverlap`) so the assumption is measured.
      if (!overlap && sw.method === "scroll-action") {
        actionNoOverlap += 1;
      } else if (!overlap) {
        gaps += 1;
        passGap = true;
      }
    } else {
      unchanged += 1;
    }
    prev = cur;
    if (unchanged >= TEMPLATE_END_UNCHANGED) {
      // At an end. A pass that ran end to end without a gap saw every row.
      if (passFromEnd && !passGap) {
        swept = true;
        continue;
      }
      dir = dir === "down" ? "up" : "down";
      reversals += 1;
      unchanged = 0;
      passFromEnd = true;
      passGap = false;
    }
  }
  return giveUp("selector unresolved on live tree");
}

/** A full sweep of a container (review E-1 finding 5): what rows are actually there. */
interface SweepOutcome {
  /** Every label seen inside the container during the sweep. */
  labels: Set<string>;
  scrolls: number;
  gaps: number;
  /** Both ends reached and the return pass (bottom to top) had no gap. */
  complete: boolean;
  wallMs: number;
  swipeMs: number[];
  deliveredMs: number[];
  reason?: string;
}

/**
 * Sweep a container end to end with the template step's own held swipe and
 * settled reads, collecting every label inside it: down until the list stops
 * moving, then back up to the top. A bench instrument (observed presence for
 * the churn experiment), not a navigation step: it never taps.
 */
export async function sweepContainer(
  server: OpenDeviceServerApi,
  size: { width: number; height: number },
  opts: TemplateStepOptions & { maxScrolls?: number } = {}
): Promise<SweepOutcome> {
  const t0 = Date.now();
  const pauseMs = opts.settlePauseMs ?? TEMPLATE_SETTLE_PAUSE_MS;
  const maxScrolls = opts.maxScrolls ?? 2 * TEMPLATE_MAX_SCROLLS;
  const labels = new Set<string>();
  const swipeMs: number[] = [];
  const deliveredMs: number[] = [];
  let prev = await stableRead(server, pauseMs, opts.containerId);
  for (const l of prev.labels) labels.add(l);
  const done = (complete: boolean, gaps: number, scrolls: number, reason?: string) => ({
    labels,
    scrolls,
    gaps,
    complete,
    wallMs: Date.now() - t0,
    swipeMs,
    deliveredMs,
    ...(reason ? { reason } : {}),
  });
  if (opts.containerId !== undefined && !prev.container) {
    return done(false, 0, 0, "template container not on live tree");
  }
  let dir: "down" | "up" = "down";
  let scrolls = 0;
  let gaps = 0;
  let upGaps = 0;
  let unchanged = 0;
  while (scrolls < maxScrolls) {
    const sw = await scrollContainer(server, size, prev.bounds, dir);
    scrolls += 1;
    swipeMs.push(sw.ms);
    if (sw.deliveredMs !== undefined) deliveredMs.push(sw.deliveredMs);
    const cur = await stableRead(server, pauseMs, opts.containerId);
    for (const l of cur.labels) labels.add(l);
    const readable = prev.sig !== "" || cur.sig !== "";
    const moved = readable ? cur.sig !== prev.sig : sw.changed !== false;
    if (moved) {
      unchanged = 0;
      if (readable && ![...cur.texts].some((t) => prev.texts.has(t))) {
        gaps += 1;
        if (dir === "up") upGaps += 1;
      }
    } else {
      unchanged += 1;
    }
    prev = cur;
    if (unchanged >= TEMPLATE_END_UNCHANGED) {
      if (dir === "up") return done(upGaps === 0, gaps, scrolls);
      dir = "up";
      unchanged = 0;
    }
  }
  return done(false, gaps, scrolls, "scroll cap reached");
}

/**
 * The requested item's container on the live tree (review E-1 finding 3): when
 * exactly one element shows `wantedText` exactly, the stripped resource id of the
 * smallest scrollable holding it; otherwise (not on screen, ambiguous, outside
 * every scrollable, no resource id) undefined.
 */
export function requestedContainerId(
  tree: readonly LiveElement[],
  wantedText: string
): string | undefined {
  const want = norm(wantedText);
  const hits = tree.filter((el) => norm(el.text) === want || norm(el.contentDesc) === want);
  if (hits.length !== 1) return undefined;
  const b = hits[0]!.bounds;
  const c = resolveContainer(tree, (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2);
  return stripId(c?.resourceId) || undefined;
}

/**
 * Phase E (design D1) template route for an item no node indexes: only when
 * template mode is on (`ARGENT_SG_TEMPLATES=1`, review E-1 finding 8), routed by
 * the requested item's container (see `planToTemplate`).
 */
export function planTemplateRoute(
  graph: PlanGraph,
  from: string,
  wantedText: string,
  liveTree: readonly LiveElement[],
  templatesOn: boolean,
  now: number = Date.now()
): (PlanResult & { templateNode: string }) | null {
  if (!templatesOn) return null;
  const containerId = requestedContainerId(liveTree, wantedText);
  return planToTemplate(graph, from, now, {
    itemText: wantedText,
    ...(containerId !== undefined ? { containerId } : {}),
  });
}

function swipeVector(
  size: { width: number; height: number },
  dir: CanonicalAction["dir"]
): { sx: number; sy: number; ex: number; ey: number } {
  const cx = Math.round(size.width / 2);
  const cy = Math.round(size.height / 2);
  const dx = Math.round(size.width * 0.3);
  const dy = Math.round(size.height * 0.3);
  switch (dir) {
    case "up":
      return { sx: cx, sy: cy + dy, ex: cx, ey: cy - dy };
    case "down":
      return { sx: cx, sy: cy - dy, ex: cx, ey: cy + dy };
    case "left":
      return { sx: cx + dx, sy: cy, ex: cx - dx, ey: cy };
    case "right":
    default:
      return { sx: cx - dx, sy: cy, ex: cx + dx, ey: cy };
  }
}

function finalSummary(store: ScreenGraphStore, hash: string): { name: string; summary?: string } {
  const node = store.getNode(hash);
  if (!node) return { name: hash8(hash) };
  const name = node.label ?? hash8(node.hash);
  const summary = renderSummary(buildSummary(node, store.outgoingEdges(hash), store.nodes));
  return { name, summary };
}

export function createNavigateToTool(registry: Registry): ToolDefinition<Params, NavigateToResult> {
  async function execute(
    _services: Record<string, unknown>,
    params: Params,
    _ctx?: ToolContext
  ): Promise<NavigateToResult> {
    const device = resolveDevice(params.udid);
    if (device.platform !== "android") {
      throw new FailureError("navigate-to is Android-only.", {
        error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
        failure_stage: "navigate_to_platform",
        failure_area: "tool_server",
        error_kind: "validation",
      });
    }
    // The `screen-graph` gate is enforced by the registry; the open server is
    // this tool's only backend, so refuse clearly when it is off.
    if (!isFlagEnabled("open-device-server")) {
      throw new FailureError("navigate-to requires the `open-device-server` flag (its backend).", {
        error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
        failure_stage: "navigate_to_backend",
        failure_area: "tool_server",
        error_kind: "validation",
      });
    }

    const ref = openDeviceServerRef(device);
    return openDeviceServerMutex.withDeviceLock(device.id, async () => {
      const rawServer = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
      // Phase D.2 HIGH-2: count the REAL device RPCs this route issues (getState /
      // query / tap / getState …) so the published cost is measured, not the
      // hand-written "1 navigate + 1 verify = 2". A proxy increments on every
      // device-facing method call.
      let rpcCount = 0;
      const server = new Proxy(rawServer, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== "function") return value;
          if (RPC_METHODS.has(prop as string)) {
            return (...args: unknown[]) => {
              rpcCount += 1;
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return (value as (...a: unknown[]) => unknown).bind(target);
        },
      }) as OpenDeviceServerApi;
      const { store } = await resolveStoreForCurrentApp(device.id, server);
      const state = await server.getState({ includeScreenshot: false, fingerprints: true });
      // The graph keys nodes by H_id (phase D §1): localize, plan and verify on
      // the identity hash, which is stable across scroll/focus so the FROM screen
      // matches its node exactly (the C.4 structural-`H` drift is gone).
      const currentHash = idOf(state);
      const size = { width: state.info.screenWidth, height: state.info.screenHeight };
      const liveResourceIds = resourceIdsOf(state.tree);

      const graph = { edges: store.edges, nodes: store.nodes };

      // Phase D §3: route only when the target is UNAMBIGUOUS — a selector that
      // several distinct screens index cannot identify one destination, so refuse
      // rather than route to an arbitrary one.
      if (params.target.selector) {
        const keys = selectorKeys(params.target.selector);
        const holders = Object.values(graph.nodes).filter((n) => keys.some((k) => k in n.index));
        if (holders.length > 1) {
          const { name, summary } = finalSummary(store, currentHash);
          return {
            reached: false,
            finalScreen: name,
            completedSteps: 0,
            totalSteps: 0,
            error: `ambiguous target: ${holders.length} screens index this selector`,
            fromVia: currentHash && graph.nodes[currentHash] ? "exact" : "none",
            rpcCount,
            ...(summary ? { summary } : {}),
          };
        }
      }

      // Localize the FROM screen through a resource-id Jaccard fallback (retained
      // as a safety net; with H_id it should hit exactly). Screen-hash targets
      // plan exactly.
      const stablePlan = params.target.selector
        ? planToSelectorStable(graph, currentHash, liveResourceIds, params.target.selector)
        : null;
      // Phase E (design D1): when the target selector names an ITEM that no node
      // indexes (per R5 item text is not indexed), fall back to a TEMPLATE route —
      // plan to the container's template node, and resolve the concrete item on the
      // live tree at execute time. Only used when a plain plan does not exist.
      const wantedItemText = params.target.selector?.text;
      let planned: PlanResult | null = params.target.screen
        ? plan(graph, currentHash, params.target.screen)
        : stablePlan;
      if (!planned && wantedItemText) {
        const tpl = planTemplateRoute(
          graph,
          currentHash,
          wantedItemText,
          state.tree as unknown as LiveElement[],
          screenGraphTemplatesEnabled()
        );
        if (tpl) planned = tpl;
      }
      const fromVia =
        stablePlan?.fromVia ?? (currentHash && graph.nodes[currentHash] ? "exact" : "none");
      const fromScore = stablePlan?.fromScore;

      if (!planned) {
        const { name, summary } = finalSummary(store, currentHash);
        return {
          reached: false,
          finalScreen: name,
          completedSteps: 0,
          totalSteps: 0,
          error: "no known path from the current screen to the target",
          fromVia,
          ...(fromScore !== undefined ? { fromScore } : {}),
          rpcCount,
          ...(summary ? { summary } : {}),
        };
      }

      // Track the from-screen per step so a bucketed tap can consult that node's
      // stored index (B1). The first step starts on the current screen; each
      // later step starts on the previous step's planned target (runNavigation
      // only advances when the observed hash matched it).
      let stepFrom = currentHash;
      let divergeReason: string | undefined;
      const nav = await runNavigation(currentHash, planned.steps, {
        execute: async (action, step: PlanStep) => {
          // Phase E (design D1): a TEMPLATE step resolves the concrete item on the
          // live tree (query + bounded in-container scroll), never a stale
          // coordinate. On failure it records the miss on the template edge so its
          // weight decays (design D1 step 5), then diverges.
          if (step.template && wantedItemText) {
            const out = await executeTemplateStep(
              server,
              size,
              wantedItemText,
              step.template.containerId !== undefined
                ? { containerId: step.template.containerId }
                : {}
            );
            if (!out.tapped) {
              if (out.reason) divergeReason = out.reason;
              store.observe(stepFrom, action, step.to, { success: false });
            }
            stepFrom = step.to;
            return { afterHash: out.afterHash, afterResourceIds: out.afterResourceIds };
          }
          const fromIndex = store.getNode(stepFrom)?.index;
          await executeCanonicalAction(server, size, action, fromIndex, step.selector, (reason) => {
            if (reason) divergeReason = reason;
          });
          // Re-read the landed screen for its H_id and resource-id multiset.
          const after = await server.getState({ includeScreenshot: false, fingerprints: true });
          stepFrom = step.to;
          return { afterHash: idOf(after), afterResourceIds: resourceIdsOf(after.tree) };
        },
        // Arrival is verified by H_id equality (phase D §3): H_id is stable across
        // scroll/focus, so a correct tap lands on the target identity even when the
        // structural `H` differs — that IS the tolerant match. The resource-id
        // Jaccard stays as a secondary safety net.
        matches: (step, outcome) => {
          if (outcome.afterHash && outcome.afterHash === step.to) return true;
          const node = store.getNode(step.to);
          if (!node || !outcome.afterResourceIds) return false;
          return (
            multisetJaccard(outcome.afterResourceIds, nodeResourceIds(node)) >=
            DEFAULT_STABLE_MATCH_THRESHOLD
          );
        },
      });

      const { name, summary } = finalSummary(store, nav.finalHash);
      return {
        reached: nav.ok,
        finalScreen: name,
        completedSteps: nav.completedSteps,
        totalSteps: planned.steps.length,
        fromVia,
        ...(fromScore !== undefined ? { fromScore } : {}),
        ...(nav.divergence ? { divergence: nav.divergence } : {}),
        ...(divergeReason ? { divergeReason } : {}),
        rpcCount,
        ...(summary ? { summary } : {}),
      };
    });
  }

  return {
    id: NAVIGATE_TO_TOOL_ID,
    interaction: {
      startedMsg: () => "Navigating",
      completedMsg: ({ result }) =>
        result.reached ? `Reached ${result.finalScreen}` : `Stopped at ${result.finalScreen}`,
      failedMsg: ({ failureSignal }) => `Navigation failed: ${failureSignal.error_code}`,
    },
    description: `Replay a known action path to a target screen using the app's screen graph.

Plans a route over the recorded screen graph (edges weighted by success and recency) from the CURRENT
screen to either a target screen hash or the nearest screen whose index holds a given resource-id / text,
then executes it step by step, verifying the device's structural hash after each step. On divergence it
stops and reports { reachedStep, expected, actual }. Returns the final screen summary.

Android + open-device-server only; requires the \`screen-graph\` flag.`,
    searchHint: "navigate screen graph route plan path replay android",
    longRunning: true,
    featureFlag: "screen-graph",
    hideWhen: () => !isFlagEnabled("open-device-server"),
    zodSchema,
    capability,
    services: () => ({}),
    execute,
  };
}
