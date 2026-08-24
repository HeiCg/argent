import { z } from "zod";

export const describeFrameSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().min(0).max(1),
  height: z.number().finite().min(0).max(1),
});

export type DescribeFrame = z.infer<typeof describeFrameSchema>;

export interface DescribeNode {
  role: string;
  frame: DescribeFrame;
  children: DescribeNode[];
  label?: string;
  identifier?: string;
  value?: string;
  // Descendant text hoisted onto container leaves by the flow adapters'
  // flatten (`flow-tree-flatten`): the flat shape drops the child that renders
  // the text, so a flow `text` condition reads this for a testID container.
  // The describe path leaves it unset.
  subtreeText?: string;
  clickable?: boolean;
  longClickable?: boolean;
  scrollable?: boolean;
  checkable?: boolean;
  checked?: boolean;
  disabled?: boolean;
  password?: boolean;
  // Children dropped for falling fully outside an ancestor scroll's clip rect
  // — the agent should swipe before tapping.
  scrollHidden?: number;
  // Distinct on D-pad UIs: input focus vs. the visually highlighted item.
  focused?: boolean;
  selected?: boolean;
}

export const describeNodeSchema: z.ZodType<DescribeNode> = z.lazy(() =>
  z
    .object({
      role: z.string().min(1),
      frame: describeFrameSchema,
      children: z.array(describeNodeSchema),
      label: z.string().optional(),
      identifier: z.string().optional(),
      value: z.string().optional(),
      subtreeText: z.string().optional(),
      clickable: z.boolean().optional(),
      longClickable: z.boolean().optional(),
      scrollable: z.boolean().optional(),
      checkable: z.boolean().optional(),
      checked: z.boolean().optional(),
      disabled: z.boolean().optional(),
      password: z.boolean().optional(),
      scrollHidden: z.number().int().nonnegative().optional(),
      focused: z.boolean().optional(),
      selected: z.boolean().optional(),
    })
    .passthrough()
);

// Where the tree came from. "ax-service" / "native-devtools" come from an iOS
// simulator and "coredevice-ax" from a physical iPhone — the last of which
// reports no geometry, so its frames are synthesised and only its labels/roles
// carry information; "uiautomator" / "android-devtools" come from Android; "cdp-dom" is the
// Chromium branch's DOM walk over Chrome DevTools Protocol; "vega-automation"
// is the Vega on-device automation toolkit; "tv-focus" is the focus-driven view
// returned for a TV target (Apple TV / Android TV), which reports focused /
// focusable elements rather than a tap-oriented tree. Agents that branch on
// `source` (e.g. to decide whether to also call `native-find-views` for a
// richer tree) need to distinguish each provider — which a shared label would
// hide.
export type DescribeSource =
  | "ax-service"
  | "native-devtools"
  | "uiautomator"
  | "android-devtools"
  | "cdp-dom"
  | "vega-automation"
  | "tv-focus"
  | "coredevice-ax";

// Adapter-internal: `tree` is rendered by `format-tree.ts` and then dropped —
// callers get `DescribeResult` below, i.e. only the rendered text.
export interface DescribeTreeData {
  tree: DescribeNode;
  source: DescribeSource;
  should_restart?: boolean;
  hint?: string;
  // Size the frames were normalized against, in the source's native units
  // (Android px, iOS pt), so only the aspect ratio compares across sources —
  // which is what the rotate directive's circle geometry reads it for. Set
  // only by the flow tree adapters that know it.
  screen?: { width: number; height: number };
}

export interface DescribeResult {
  description: string;
  source: DescribeSource;
  should_restart?: boolean;
  hint?: string;
}

export function parseDescribeResult(input: unknown): DescribeNode {
  return describeNodeSchema.parse(input);
}

export function getDescribeTapPoint(frame: DescribeFrame): { x: number; y: number } {
  return {
    x: frame.x + frame.width / 2,
    y: frame.y + frame.height / 2,
  };
}
