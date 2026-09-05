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
  const at = (l: DescribeLine): LocatedNorm => ({ xNorm: l.xNorm, yNorm: l.yNorm, found: true });
  // Phase D.3 (D2-H3): PREFER a whole-field EXACT quoted label / exact id — so
  // `t("Internet")` takes the exact "Internet" row, never the "Network & internet"
  // toolbar title a plain contains-scan hits first. Fall back to the topmost
  // CONTAINS match only when nothing matched exactly (the pre-D.3 behaviour, kept
  // so B1's proprietary describe rendering — where a row may not surface as a
  // clean quoted label — still locates rather than refusing).
  if (wantId) {
    const exact = lines.find((l) => l.id === wantId);
    if (exact) return at(exact);
  }
  if (wantText) {
    const exactLabel = lines.find((l) => l.quoted.includes(wantText));
    if (exactLabel) return at(exactLabel);
    const contains = lines.find((l) => l.head.includes(wantText));
    if (contains) return at(contains);
  }
  return { xNorm: 0.5, yNorm: 0.5, found: false };
}
