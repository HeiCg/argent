/**
 * Ticket Artemis A1 (part A) — server-side target verification for a tap/swipe
 * BEFORE injecting. The host runs the `query` RPC on the LIVE tree, then resolves
 * a UNIQUE node from the matches with the SAME `pickUniqueNode` precedence the
 * screen-graph bench uses (`src/screen-graph/bench/locate.ts`), so the tool and
 * the harness resolve identically — whole-field EXACT id → EXACT text → EXACT
 * contentDescription → a CONTAINS match only when exactly one candidate contains
 * it; a tier with >1 is ambiguous, never tapped as `nodes[0]`.
 *
 * Pure and device-free: it reasons over the compact `query` nodes only, so the
 * unit test drives it directly and the device test feeds it the SAME resolver.
 */
import { z } from "zod";
import { pickUniqueNode, type QueryNodeLite } from "../screen-graph/bench/locate";
import type { BenchSelector } from "../screen-graph/bench/types";
import type { OpenServerSelector, OpenServerStringMatch } from "../blueprints/android-open-server";

/**
 * Zod for a `ScreenSelector`-grammar string field: a bare string (exact match)
 * OR `{ equals | contains | regex, caseInsensitive? }`, mirroring the on-device
 * `ScreenSelector.matchString` (QueryHandler.kt / ScreenSelector.kt).
 */
const stringMatchSchema = z.union([
  z.string(),
  z
    .object({
      equals: z.string().optional(),
      contains: z.string().optional(),
      regex: z.string().optional(),
      caseInsensitive: z.boolean().optional(),
    })
    .strict(),
]);

// Recursive because `containsDescendant` nests a selector; typed explicitly so
// the inferred type stays assignable to `OpenServerSelector`.
const selectorSchema: z.ZodType<OpenServerSelector> = z.lazy(() =>
  z
    .object({
      id: stringMatchSchema.optional(),
      text: stringMatchSchema.optional(),
      class: stringMatchSchema.optional(),
      containsDescendant: selectorSchema.optional(),
      index: z.number().int().min(0).optional(),
      visible: z.boolean().optional(),
    })
    .strict()
);

/**
 * The `verify` tool param (gesture-tap, gesture-swipe start): a `ScreenSelector`
 * to resolve on the LIVE tree before injecting, plus optional coordinate slack.
 */
export const verifyParamSchema = z
  .object({
    selector: selectorSchema,
    tolerancePx: z.number().min(0).optional(),
  })
  .strict();

export interface VerifyBounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface VerifyCandidate {
  label: string;
  bounds: VerifyBounds;
}

/** The pixel coordinate the caller proposed, cross-checked against the match. */
export interface VerifyGuard {
  xPx: number;
  yPx: number;
  /** Slack around the match's bounds; default 0 (must land inside the element). */
  tolerancePx: number;
}

export type VerifyResolution =
  | { kind: "match"; bounds: VerifyBounds; node: QueryNodeLite }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: VerifyCandidate[] }
  | { kind: "mismatch"; bounds: VerifyBounds; node: QueryNodeLite; label: string };

/**
 * Reduce a `ScreenSelector`-grammar string field to the bench needle
 * `pickUniqueNode` reasons over: a bare string is itself; an object matcher
 * yields its `equals`/`contains` literal; a pure `regex` matcher has no literal
 * needle, so it is left to the server's own match (the field is dropped from the
 * bench selector and the query result set already reflects the regex).
 */
function needle(m: OpenServerStringMatch | undefined): string | undefined {
  if (m === undefined) return undefined;
  if (typeof m === "string") return m;
  return m.equals ?? m.contains;
}

/** Project a verify selector onto the `{ id?, text?, class? }` BenchSelector. */
export function toBenchSelector(selector: OpenServerSelector): BenchSelector {
  const out: BenchSelector = {};
  const id = needle(selector.id);
  const text = needle(selector.text);
  const cls = needle(selector.class);
  if (id !== undefined) out.id = id;
  if (text !== undefined) out.text = text;
  if (cls !== undefined) out.class = cls;
  return out;
}

/** A human label for a query node: text, then content-desc, then resource-id. */
export function nodeLabel(n: QueryNodeLite): string {
  return (n.text?.trim() || n.cd?.trim() || n.id?.trim() || "").trim();
}

/**
 * Resolve the verify selector against the live query nodes. `guard` (present
 * because gesture-tap/swipe always carry coordinates) refuses `mismatch` when
 * the caller's point falls outside the match's bounds ± tolerance; the resolved
 * tap still targets the match's CENTER, so the coordinate is a guard, not the
 * tap point.
 */
export function resolveVerify(
  nodes: readonly QueryNodeLite[],
  selector: OpenServerSelector,
  guard?: VerifyGuard
): VerifyResolution {
  const picked = pickUniqueNode(nodes, toBenchSelector(selector));
  // The `pickUniqueNode` tiers reason over id/text/class only. Fields the bench
  // selector cannot carry (`regex`, `containsDescendant`, `visible`, `index`, and
  // a contains-only `id`) are already enforced SERVER-SIDE by the `query` RPC, so
  // every returned node satisfies the full selector. When the projection resolves
  // nothing, accept the server's answer by COUNT: a lone match is unique, several
  // are ambiguous (review A1-H1).
  let node = picked.node;
  let ambiguous = picked.ambiguous;
  // Candidates of the ambiguous set: the colliding tier when `pickUniqueNode`
  // reported it, else the whole server-filtered set (review A1-M6).
  let ambiguousNodes: readonly QueryNodeLite[] = picked.candidates ?? nodes;
  if (!node && !ambiguous) {
    if (nodes.length === 1) {
      node = nodes[0];
    } else if (nodes.length > 1) {
      ambiguous = true;
      ambiguousNodes = nodes;
    }
  }
  if (node) {
    const b = node.bounds;
    if (guard) {
      const t = Math.max(0, guard.tolerancePx);
      const inside =
        guard.xPx >= b.x1 - t &&
        guard.xPx <= b.x2 + t &&
        guard.yPx >= b.y1 - t &&
        guard.yPx <= b.y2 + t;
      if (!inside) {
        return { kind: "mismatch", bounds: b, node, label: nodeLabel(node) };
      }
    }
    return { kind: "match", bounds: b, node };
  }
  if (ambiguous) {
    // List up to 5 of the colliding candidates (label, bounds) so the caller can
    // add a second field.
    const candidates = ambiguousNodes
      .slice(0, 5)
      .map((n) => ({ label: nodeLabel(n), bounds: n.bounds }));
    return { kind: "ambiguous", candidates };
  }
  return { kind: "not_found" };
}

/** Center of a bounds box, for the resolved tap/swipe-start point. */
export function boundsCenter(b: VerifyBounds): { x: number; y: number } {
  return { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 };
}
