/**
 * Screen-graph Phase B — map a tool invocation to a {@link CanonicalAction}
 * (ticket B1 `canonical.ts`). The canonicalization rule is: prefer a
 * resource-id, else visible text, else the tap coordinates bucketed to a 1/16
 * screen grid, so the same intent produces the same edge across runs regardless
 * of exact pixels.
 */
import type { CanonicalAction } from "./types";

/** Number of grid cells per axis for the coordinate fallback (1/16 screen). */
export const GRID = 16;

/** What a caller knows about an action at the point it happened. */
export type ActionInvocation =
  | { kind: "tap" | "longPress"; target?: { id?: string; text?: string }; x?: number; y?: number }
  | { kind: "swipe"; startX: number; startY: number; endX: number; endY: number }
  | { kind: "typeText"; target?: { id?: string; text?: string } }
  | { kind: "key"; key: string }
  | { kind: "back" };

/** Screen dimensions in the same pixel space as tap coordinates. */
export interface ScreenSize {
  width: number;
  height: number;
}

function bucketAxis(value: number, dim: number): number {
  if (dim <= 0) return 0;
  const cell = Math.floor((value * GRID) / dim);
  return Math.min(GRID - 1, Math.max(0, cell));
}

function nonEmpty(s: string | undefined): string | undefined {
  const t = (s ?? "").trim();
  return t === "" ? undefined : t;
}

function targetFrom(t?: { id?: string; text?: string }): { id?: string; text?: string } | undefined {
  const id = nonEmpty(t?.id);
  if (id) return { id };
  const text = nonEmpty(t?.text);
  if (text) return { text };
  return undefined;
}

/** Direction of a swipe from its endpoints (dominant axis wins). */
export function swipeDirection(
  startX: number,
  startY: number,
  endX: number,
  endY: number
): "up" | "down" | "left" | "right" {
  const dx = endX - startX;
  const dy = endY - startY;
  if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? "up" : "down";
  return dx < 0 ? "left" : "right";
}

/**
 * Lower an {@link ActionInvocation} to its {@link CanonicalAction}. `size` is
 * required only for the coordinate-bucket fallback on a tap/longPress that
 * carries no id/text.
 */
export function canonicalAction(inv: ActionInvocation, size?: ScreenSize): CanonicalAction {
  switch (inv.kind) {
    case "tap":
    case "longPress": {
      const target = targetFrom(inv.target);
      if (target) return { kind: inv.kind, target };
      if (inv.x !== undefined && inv.y !== undefined && size) {
        return {
          kind: inv.kind,
          bucket: { x: bucketAxis(inv.x, size.width), y: bucketAxis(inv.y, size.height) },
        };
      }
      return { kind: inv.kind };
    }
    case "swipe":
      return { kind: "swipe", dir: swipeDirection(inv.startX, inv.startY, inv.endX, inv.endY) };
    case "typeText": {
      const target = targetFrom(inv.target);
      return target ? { kind: "typeText", target } : { kind: "typeText" };
    }
    case "key": {
      const key = nonEmpty(inv.key);
      // BACK is its own canonical kind; every other key keeps its name.
      if (key && /^(back|keycode_back)$/i.test(key)) return { kind: "back" };
      return key ? { kind: "key", key } : { kind: "key" };
    }
    case "back":
      return { kind: "back" };
  }
}
