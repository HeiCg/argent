import type { CoreDeviceAxTree } from "../../../../utils/simulator-client";
import { parseDescribeResult, type DescribeNode } from "../../contract";

/**
 * Adapts a physical iPhone's on-screen accessibility tree (from the iOS-26+
 * axAudit service, read app-free over CoreDevice) into a describe tree.
 *
 * The audit gives a rich VoiceOver caption (label + value + traits) and reading
 * order for EVERY on-screen element, but Apple doesn't expose per-element
 * geometry app-free on hardware. **Today the sim-server therefore sends no
 * geometry at all** — no `screen`, no per-element `rect` — so in practice every
 * frame below is interpolated: elements are laid out as full-width rows spread
 * top to bottom in reading order. That's enough to tap a row in a vertical list;
 * the tool's hint tells the agent to confirm with screenshot for anything else.
 *
 * `parseRect` (with `tree.screen` as the normalizing basis) is nonetheless
 * honoured whenever the payload does carry geometry, so re-adding a geometry
 * source on the sim-server side (a tracked follow-up) is a producer-only change.
 * radon's `ax_tree_payload_carries_no_geometry` test pins the current
 * no-geometry shape, and `ios-coredevice-ax-adapter.test.ts` covers both.
 */

// AX trait tokens that appear (comma-separated) at the tail of a VoiceOver
// caption, mapped to a describe role. Order matters: the first structural trait
// found wins.
const TRAIT_ROLE: Array<[RegExp, string]> = [
  [/^Button$/i, "AXButton"],
  [/^Link$/i, "AXLink"],
  [/^Header$/i, "AXHeader"],
  [/^(Toggle|Switch)$/i, "AXSwitch"],
  [/^Adjustable$/i, "AXSlider"],
  [/^Search Field$/i, "AXSearchField"],
  [/^Text Field$/i, "AXTextField"],
  [/^Tab$/i, "AXTab"],
  [/^Image$/i, "AXImage"],
];
// Trailing tokens that are traits/states (stripped from the label).
const TRAIT_TOKEN =
  /^(Button|Link|Header|Toggle|Switch|Adjustable|Search Field|Text Field|Tab|Image|Selected|Not Selected|Dimmed|Disabled)$/i;

function parseCaption(caption: string): { label: string; role: string } {
  const tokens = caption.split(/,\s*/).filter((t) => t.length > 0);
  let role = "AXStaticText";
  for (const [re, r] of TRAIT_ROLE) {
    if (tokens.some((t) => re.test(t))) {
      role = r;
      break;
    }
  }
  // Drop trailing trait/state tokens to get a cleaner label; keep the full
  // caption if that would leave nothing.
  let end = tokens.length;
  while (end > 0 && TRAIT_TOKEN.test(tokens[end - 1])) end--;
  const label = (end > 0 ? tokens.slice(0, end) : tokens).join(", ") || caption;
  return { label, role };
}

const RECT_RE = /-?\d+(?:\.\d+)?/g;

/** Parse "{{x, y}, {w, h}}" (points) → normalized frame, or null. */
function parseRect(rect: string | undefined, sw: number, sh: number): DescribeNode["frame"] | null {
  if (!rect || sw <= 0 || sh <= 0) return null;
  const nums = rect.match(RECT_RE);
  if (!nums || nums.length < 4) return null;
  const [x, y, w, h] = nums.slice(0, 4).map(Number);
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return {
    x: clamp(x / sw),
    y: clamp(y / sh),
    width: clamp(w / sw),
    height: clamp(h / sh),
  };
}

const MARGIN_X = 0.04;
const APPROX_HEIGHT = 0.05;

/** Full-width approximate frame centred at normalized y. */
function approxFrame(yCenter: number): DescribeNode["frame"] {
  const y = Math.max(0, Math.min(1 - APPROX_HEIGHT, yCenter - APPROX_HEIGHT / 2));
  return { x: MARGIN_X, y, width: 1 - 2 * MARGIN_X, height: APPROX_HEIGHT };
}

/**
 * Fill frames for elements the audit didn't give a rect: interpolate each gap's
 * y-centres between the nearest real rects above and below (reading order), so a
 * list row lands roughly where it should. Falls back to an even top-to-bottom
 * spread when there are no anchoring rects.
 */
function fillFrames(frames: Array<DescribeNode["frame"] | null>): DescribeNode["frame"][] {
  const n = frames.length;
  const yc = (f: DescribeNode["frame"]) => f.y + f.height / 2;
  const out = frames.slice();
  for (let i = 0; i < n; i++) {
    if (out[i]) continue;
    let prev = i - 1;
    while (prev >= 0 && !out[prev]) prev--;
    let next = i + 1;
    while (next < n && !out[next]) next++;
    const top = prev >= 0 ? yc(out[prev]!) : 0.06;
    const bottom = next < n ? yc(out[next]!) : 0.94;
    const span = next < n ? next : n; // denominator for even spread in the run
    const start = prev >= 0 ? prev : -1;
    const frac = (i - start) / (span - start);
    out[i] = approxFrame(top + (bottom - top) * frac);
  }
  return out as DescribeNode["frame"][];
}

export function adaptCoreDeviceAxToDescribeResult(tree: CoreDeviceAxTree): DescribeNode {
  const sw = tree.screen?.w ?? 0;
  const sh = tree.screen?.h ?? 0;
  const els = tree.elements ?? [];

  const rectFrames = els.map((e) => parseRect(e.rect, sw, sh));
  const frames = fillFrames(rectFrames);

  const children: DescribeNode[] = els.map((e, i) => {
    const { label, role } = parseCaption(e.caption ?? "");
    const node: DescribeNode = { role, frame: frames[i], children: [] };
    if (label) node.label = label;
    return node;
  });

  return parseDescribeResult({
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
}
