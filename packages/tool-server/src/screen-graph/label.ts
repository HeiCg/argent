/**
 * Screen-graph Phase B labels (ticket B3): a deterministic, heuristic label for
 * a screen. Optional LLM labelling is out of scope. The label is
 *   `<ActivityShort>: <title text>`
 * where the activity short name comes from `getInfo` / `state.screen.activity`
 * and the title is the first toolbar / action-bar text (else the largest text
 * near the top). Either half may be absent.
 */

/** Minimal node shape the label heuristic reads. */
export interface LabelNode {
  id?: string;
  text?: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
}

export interface LabelInput {
  /** Fully-qualified activity, e.g. `com.android.settings.SubSettings`. */
  activity?: string;
  /** The screen's flat nodes (id / text / bounds). */
  nodes: LabelNode[];
  /** Screen height in the node bounds' pixel space, for "near the top". */
  screenHeight?: number;
}

/** Last dotted segment of an activity name; strips a `.../foo.Bar` suffix too. */
export function activityShortName(activity: string | undefined): string | undefined {
  if (!activity) return undefined;
  // A component can arrive as `pkg/.Inner` or `pkg/com.pkg.Inner`.
  const afterSlash = activity.includes("/") ? activity.split("/").pop()! : activity;
  const short = afterSlash.split(".").filter(Boolean).pop();
  return short && short.trim() !== "" ? short.trim() : undefined;
}

const TITLE_ID_STRONG = /(?:^|[:/])(action_bar_title|toolbar_title|title)$/i;
const TITLE_ID_CONTAINER = /(action_bar|toolbar)/i;

function text(node: LabelNode): string {
  return (node.text ?? "").trim();
}

/**
 * Best-effort title text for the screen. Priority:
 *  1. a node whose id ends in `title` / `action_bar_title` / `toolbar_title`;
 *  2. a node whose id contains `action_bar` / `toolbar` with non-empty text;
 *  3. the tallest text node in the top 25% of the screen.
 */
export function titleText(nodes: LabelNode[], screenHeight?: number): string | undefined {
  for (const n of nodes) {
    if (n.id && TITLE_ID_STRONG.test(n.id) && text(n)) return text(n);
  }
  for (const n of nodes) {
    if (n.id && TITLE_ID_CONTAINER.test(n.id) && text(n)) return text(n);
  }

  const topCut =
    screenHeight && screenHeight > 0
      ? screenHeight * 0.25
      : // No screen height: infer a cutoff from the shallowest quarter of content.
        (() => {
          const ys = nodes.map((n) => n.bounds.y1);
          if (ys.length === 0) return 0;
          const min = Math.min(...ys);
          const max = Math.max(...ys);
          return min + (max - min) * 0.25;
        })();

  let best: { text: string; height: number } | undefined;
  for (const n of nodes) {
    const t = text(n);
    if (!t) continue;
    if (n.bounds.y1 > topCut) continue;
    const height = n.bounds.y2 - n.bounds.y1;
    if (!best || height > best.height) best = { text: t, height };
  }
  return best?.text;
}

/** Compose the screen label from activity + title (either half optional). */
export function deriveLabel(input: LabelInput): string | undefined {
  const activity = activityShortName(input.activity);
  const title = titleText(input.nodes, input.screenHeight);
  if (activity && title) return `${activity}: ${title}`;
  return activity ?? title ?? undefined;
}
