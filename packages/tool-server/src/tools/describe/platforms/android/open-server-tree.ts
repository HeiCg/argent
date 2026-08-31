import type { DescribeFrame, DescribeNode } from "../../contract";
import { clipBoundsToScreen, deriveUiAutomatorRole } from "./uiautomator-parser";

/**
 * One element in the `getAccessibilityTree` reply from `@argent/android-device-server`.
 * The on-device server already compresses the tree (drops empty containers, keeps
 * interactables) and flattens it into a 1-indexed list with screen-pixel bounds.
 */
export interface OpenServerElement {
  index: number;
  className: string;
  resourceId?: string;
  text?: string;
  contentDesc?: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  clickable?: boolean;
  scrollable?: boolean;
  focused?: boolean;
  enabled?: boolean;
  checked?: boolean;
  selected?: boolean;
}

/**
 * Lower the server's flat element list to the `DescribeNode` contract the rest of
 * `describe` renders, matching the field conventions of the uiautomator-dump path
 * (`content-desc` wins the label, a diverging `text` becomes `value`, resource-id
 * is the identifier, `enabled: false` → `disabled`). The server's output is
 * already a flat, compressed list, so every element becomes a direct child of a
 * synthetic `Screen` root rather than a reconstructed hierarchy.
 */
export function openServerElementsToDescribeNode(
  elements: OpenServerElement[],
  screenW: number,
  screenH: number
): DescribeNode {
  const children: DescribeNode[] = [];
  for (const el of elements) {
    const node = elementToNode(el, screenW, screenH);
    if (node) children.push(node);
  }
  return {
    role: "Screen",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  };
}

function elementToNode(
  el: OpenServerElement,
  screenW: number,
  screenH: number
): DescribeNode | null {
  const px = {
    x: el.bounds.x1,
    y: el.bounds.y1,
    w: Math.max(0, el.bounds.x2 - el.bounds.x1),
    h: Math.max(0, el.bounds.y2 - el.bounds.y1),
  };
  const clipped = clipBoundsToScreen(px, screenW, screenH);
  // Drop zero-area elements that clip fully off-screen — no tap target there.
  if (clipped.w <= 0 || clipped.h <= 0) return null;

  const frame: DescribeFrame = {
    x: screenW > 0 ? clipped.x / screenW : 0,
    y: screenH > 0 ? clipped.y / screenH : 0,
    width: screenW > 0 ? clipped.w / screenW : 0,
    height: screenH > 0 ? clipped.h / screenH : 0,
  };

  const contentDesc = (el.contentDesc ?? "").trim();
  const text = (el.text ?? "").trim();
  // Prefer content-desc as the label, mirroring `labelOf` in the dump parser.
  const label = contentDesc || text;

  const out: DescribeNode = {
    role: deriveUiAutomatorRole(el.className),
    frame,
    children: [],
  };
  if (label) out.label = label;
  if (el.resourceId) out.identifier = el.resourceId;
  // A diverging `text` (EditText content while content-desc is the placeholder)
  // becomes `value`, same as the dump path.
  if (text && text !== label) out.value = text;
  if (el.clickable) out.clickable = true;
  if (el.scrollable) out.scrollable = true;
  if (el.checked) out.checked = true;
  if (el.selected) out.selected = true;
  if (el.focused) out.focused = true;
  if (el.enabled === false) out.disabled = true;
  return out;
}
