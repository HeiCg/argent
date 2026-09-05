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

interface DescribeLine {
  xNorm: number;
  yNorm: number;
  /** Quoted strings on the line (label, value); the label is normally the first. */
  quoted: string[];
  head: string; // lowercased annotations before the frame
  id: string; // lowercased id="…"
}

/**
 * Phase D.3 (D2-H3): resolve the tap target from the describe payload with the
 * SAME precedence as the open path — whole-field EXACT quoted label / exact id
 * first, then a CONTAINS match ONLY when exactly one line matches. Never taps the
 * first contains-hit (`t("Internet")` must not tap "Network & internet").
 */
export function parseDescribeLocate(describeText: string, sel: BenchSelector): LocatedNorm {
  const wantText = sel.text?.trim().toLowerCase();
  const wantId = sel.id?.trim().toLowerCase();
  const lines: DescribeLine[] = [];
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
    const quoted = [...headRaw.matchAll(/"([^"]*)"/g)].map((m) => m[1]!.trim().toLowerCase());
    const idM = /id="([^"]*)"/i.exec(line);
    lines.push({
      xNorm: x + w / 2,
      yNorm: y + h / 2,
      quoted,
      head: headRaw.toLowerCase(),
      id: (idM?.[1] ?? "").toLowerCase(),
    });
  }
  const pick = (cands: DescribeLine[]): LocatedNorm | null => {
    if (cands.length === 1) return { xNorm: cands[0]!.xNorm, yNorm: cands[0]!.yNorm, found: true };
    return null; // 0 → miss here; >1 → ambiguous, do not fall to nodes[0]
  };
  // Exact id, then exact quoted label, then unique contains.
  if (wantId) {
    const exact = lines.filter((l) => l.id === wantId);
    const r = pick(exact);
    if (r) return r;
    if (exact.length > 1) return { xNorm: 0.5, yNorm: 0.5, found: false };
  }
  if (wantText) {
    const exact = lines.filter((l) => l.quoted.includes(wantText));
    let r = pick(exact);
    if (r) return r;
    if (exact.length > 1) return { xNorm: 0.5, yNorm: 0.5, found: false };
    const contains = lines.filter((l) => l.head.includes(wantText));
    r = pick(contains);
    if (r) return r;
  }
  return { xNorm: 0.5, yNorm: 0.5, found: false };
}
