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
  type OpenDeviceServerApi,
  type OpenServerSelector,
} from "../../blueprints/android-open-server";
import { resolveStoreForCurrentApp } from "../../utils/screen-graph-open-wiring";
import {
  DEFAULT_STABLE_MATCH_THRESHOLD,
  GRID,
  buildSummary,
  hash8,
  multisetJaccard,
  nodeResourceIds,
  parseSelectorKey,
  plan,
  planToSelectorStable,
  renderSummary,
  runNavigation,
  selectorKeys,
  type CanonicalAction,
  type EdgeSelector,
  type GraphSelector,
  type PlanResult,
  type PlanStep,
  type ScreenGraphStore,
  type ScreenNode,
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

export interface NavigateToResult {
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
        return idOf(await server.getState({ includeScreenshot: false }));
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
      return idOf(await server.getState({ includeScreenshot: false }));
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
  const centreOf = (n: { bounds: { x1: number; y1: number; x2: number; y2: number } }): TapResolution => ({
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
        c.field === "id"
          ? norm(n.id) === want
          : norm(n.text) === want || norm(n.cd) === want
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
      throw new FailureError(
        "navigate-to requires the `open-device-server` flag (its backend).",
        {
          error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
          failure_stage: "navigate_to_backend",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
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
      const state = await server.getState({ includeScreenshot: false });
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
        const holders = Object.values(graph.nodes).filter((n) =>
          keys.some((k) => k in n.index)
        );
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
      const planned: PlanResult | null = params.target.screen
        ? plan(graph, currentHash, params.target.screen)
        : stablePlan;
      const fromVia = stablePlan?.fromVia ?? (currentHash && graph.nodes[currentHash] ? "exact" : "none");
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
          const fromIndex = store.getNode(stepFrom)?.index;
          await executeCanonicalAction(server, size, action, fromIndex, step.selector, (reason) => {
            if (reason) divergeReason = reason;
          });
          // Re-read the landed screen for its H_id and resource-id multiset.
          const after = await server.getState({ includeScreenshot: false });
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
