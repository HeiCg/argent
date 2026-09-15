/**
 * Screen-graph — locate a tap target LIVE from a `describe` payload (B1's own
 * describe+tap loop). `describe` renders one line per node ending in a normalized
 * frame `(x, y, w, h)` (see `tools/describe/format-tree.ts`); the tap point is the
 * frame centre.
 *
 * Phase D.4: B1 and the open configs now share ONE resolution policy. This parses
 * each describe line into a `QueryNodeLite` (label→text, value→cd, id, frame→
 * bounds) — and, phase D.4.1 (D4-H3), splits a collapsed `"<title> / <summary>"`
 * label into `text`/`cd` so the EXACT-text/EXACT-cd tiers are reachable for B1's
 * collapsed rows exactly as they are for the open title/summary nodes — and runs
 * the SAME `pickUniqueNode` the open path uses on its query
 * nodes: whole-field EXACT id → EXACT text → EXACT contentDescription → a CONTAINS
 * match ONLY when exactly one candidate matches; an ambiguous set is refused
 * (`found:false`, `ambiguous:true`), never tapped as `nodes[0]`. The only
 * difference between B1 and the open configs is the RENDERING fed in, not the
 * resolver — so B1's outcome on a task reflects its describe rendering, not a
 * relaxed policy. Pure and device-free.
 */
import type { BenchSelector } from "./types";
import { pickUniqueNode, type QueryNodeLite } from "./locate";

interface LocatedNorm {
  xNorm: number;
  yNorm: number;
  found: boolean;
  /** >1 candidate matched and none uniquely — the tap is NOT issued (symmetric with open). */
  ambiguous?: boolean;
}

/** The frame is the LAST parenthesised 4-tuple on the line. */
const FRAME_RE = /\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)\s*$/;

/**
 * Parse a describe payload into `QueryNodeLite` candidates (one per framed line),
 * in normalized coordinates. Exposed for the symmetric-resolver unit test.
 */
export function describeLinesToNodes(describeText: string): QueryNodeLite[] {
  const nodes: QueryNodeLite[] = [];
  for (const raw of describeText.split("\n")) {
    const line = raw.trimEnd();
    const frameM = FRAME_RE.exec(line);
    if (!frameM) continue;
    const x = Number(frameM[1]);
    const y = Number(frameM[2]);
    const w = Number(frameM[3]);
    const h = Number(frameM[4]);
    if (![x, y, w, h].every(Number.isFinite)) continue;
    const headRaw = line.slice(0, frameM.index);
    const quoted = [...headRaw.matchAll(/"([^"]*)"/g)].map((m) => m[1]!.trim());
    const idM = /id="([^"]*)"/i.exec(line);
    // label = first quoted string (the node's text); value = second (cd-like).
    const node: QueryNodeLite = {
      bounds: { x1: x, y1: y, x2: x + w, y2: y + h },
    };
    if (idM?.[1]) node.id = idM[1];
    if (quoted[0] !== undefined) node.text = quoted[0];
    if (quoted[1] !== undefined) node.cd = quoted[1];
    // Phase D.4.1 (D4-H3): a Settings list row is rendered by the proprietary
    // describe as ONE quoted string `"<title> / <summary>"` (e.g.
    // `"Display / Dark theme, font size, brightness"`), whereas the open tree
    // carries the title and summary as two separate nodes (`{id:"title",…}` and
    // `{id:"summary",…}`). With the whole label in `text`, the EXACT-text and
    // EXACT-contentDescription tiers of `pickUniqueNode` are unreachable for
    // every collapsed B1 row, so `t("Display")` could only ever hit the
    // contains tier (and refuse as ambiguous when a second row also contained
    // it). Split the collapsed label on the FIRST `" / "` into `text` (before) /
    // `cd` (after), mirroring the open title/summary split, so both renderings
    // feed `pickUniqueNode` the same fields. A row with no `" / "`, or one that
    // already carried two quoted strings, is left unchanged.
    if (node.cd === undefined && node.text !== undefined) {
      const sep = node.text.indexOf(" / ");
      if (sep !== -1) {
        node.cd = node.text.slice(sep + 3).trim();
        node.text = node.text.slice(0, sep).trim();
      }
    }
    nodes.push(node);
  }
  return nodes;
}

export function parseDescribeLocate(describeText: string, sel: BenchSelector): LocatedNorm {
  const nodes = describeLinesToNodes(describeText);
  const picked = pickUniqueNode(nodes, sel);
  if (picked.node) {
    const b = picked.node.bounds;
    return { xNorm: (b.x1 + b.x2) / 2, yNorm: (b.y1 + b.y2) / 2, found: true };
  }
  return { xNorm: 0.5, yNorm: 0.5, found: false, ...(picked.ambiguous ? { ambiguous: true } : {}) };
}
