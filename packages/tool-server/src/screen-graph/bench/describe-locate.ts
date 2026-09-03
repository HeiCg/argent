/**
 * Screen-graph Phase C.4 — locate a tap target LIVE from a proprietary `describe`
 * payload (work item A, B1's own describe+tap loop).
 *
 * `describe` renders one line per node ending in a normalized frame
 * `(x, y, w, h)` (see `tools/describe/format-tree.ts`); the tap point is the frame
 * centre. We match the FIRST line whose annotations (role + "label" + value + id)
 * CONTAIN the selector, case-insensitively — the same "topmost match" an open
 * `query({limit:1})` returns. A miss yields `found:false`, which the caller turns
 * into a `locateFailed` exclusion, never a centre tap. Pure and device-free so the
 * unit test drives it directly (the bench script self-executes on import).
 */
import type { BenchSelector } from "./types";

export interface LocatedNorm {
  xNorm: number;
  yNorm: number;
  found: boolean;
}

/** The frame is the LAST parenthesised 4-tuple on the line. */
const FRAME_RE = /\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)\s*$/;

export function parseDescribeLocate(describeText: string, sel: BenchSelector): LocatedNorm {
  const wantText = sel.text?.toLowerCase();
  const wantId = sel.id?.toLowerCase();
  for (const raw of describeText.split("\n")) {
    const line = raw.trimEnd();
    const frameM = FRAME_RE.exec(line);
    if (!frameM) continue;
    // The annotations precede the frame; `contains`-match the target text there,
    // mirroring the open `query` selector's contains semantics.
    const head = line.slice(0, frameM.index).toLowerCase();
    const labelHit = wantText ? head.includes(wantText) : false;
    const idM = /id="([^"]*)"/i.exec(line);
    const idHit = wantId && idM ? idM[1]!.toLowerCase().includes(wantId) : false;
    if (!labelHit && !idHit) continue;
    const x = Number(frameM[1]);
    const y = Number(frameM[2]);
    const w = Number(frameM[3]);
    const h = Number(frameM[4]);
    if (![x, y, w, h].every(Number.isFinite)) continue;
    return { xNorm: x + w / 2, yNorm: y + h / 2, found: true };
  }
  return { xNorm: 0.5, yNorm: 0.5, found: false };
}
