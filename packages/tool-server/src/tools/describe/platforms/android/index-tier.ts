/**
 * Screen-graph / Artemis A2 §B — the `index` describe tier (a NEW tier module,
 * wired behind the `tier` param so it never touches the A1 describe header).
 *
 * Each interactive element on the current screen is rendered as one line
 * `[i] label (role)`, with a per-screen index `i` and a header carrying the
 * device AX `version` at capture. An agent taps by passing that index back on
 * `gesture-tap` / `gesture-sequence` as `target: { index: i, version }` — the
 * "element-index observation" from the 2026-09-13 Artemis note.
 *
 * The index list and the tap resolution share ONE builder ([buildIndexElements]):
 * the tier renders it, and the `target` resolver rebuilds it against a fresh
 * device read and picks the same i-th element — but only while the snapshot has
 * not moved (the version check that yields `stale_index`, in `open-server-input`).
 */
import type { DeviceInfo, Registry } from "@argent/registry";
import type { DescribeResult } from "../../contract";
import {
  openDeviceServerRef,
  type OpenDeviceServerApi,
} from "../../../../blueprints/android-open-server";
import { openDeviceServerMutex } from "../../../../utils/device-mutex";
import type { OpenServerElement } from "./open-server-tree";
import { deriveUiAutomatorRole } from "./uiautomator-parser";

/** One entry of the `index` tier: a tappable element with its per-screen index. */
export interface IndexElement {
  /** 0-based position in the per-screen interactive list — the `target.index`. */
  index: number;
  /** content-desc (preferred) or text; may be "" for a bare clickable/scrollable. */
  label: string;
  /** UiAutomator-derived role (button, textfield, image, …). */
  role: string;
  /** Device-pixel bounds; the tap point is the centre. */
  bounds: { x1: number; y1: number; x2: number; y2: number };
}

/** content-desc wins the label, else text (both trimmed). */
function labelOf(el: OpenServerElement): string {
  const cd = (el.contentDesc ?? "").trim();
  if (cd) return cd;
  return (el.text ?? "").trim();
}

/**
 * Whether the flat-tree element is a tap/scroll target worth an index: clickable
 * or scrollable, or any node carrying a label (a settings-row title whose tap is
 * handled by its clickable parent — tapping its centre still lands the row). Bare
 * unlabelled scaffolding is dropped so the index list is the actionable set.
 */
function isIndexable(el: OpenServerElement): boolean {
  return Boolean(el.clickable || el.scrollable || labelOf(el).length > 0);
}

/**
 * Build the per-screen index list from the open server's flat accessibility tree,
 * in document order (the order the server already flattens). The SAME function
 * backs both the tier rendering and the `target: { index }` tap resolution, so an
 * index always denotes the same element for a given snapshot.
 */
export function buildIndexElements(tree: OpenServerElement[]): IndexElement[] {
  const out: IndexElement[] = [];
  for (const el of tree) {
    if (!isIndexable(el)) continue;
    out.push({
      index: out.length,
      label: labelOf(el),
      role: deriveUiAutomatorRole(el.className),
      bounds: el.bounds,
    });
  }
  return out;
}

/**
 * Render the index list to the tier's text: a header naming the `version` (so the
 * agent knows what to echo in `target`) and one `[i] label (role)` line each. An
 * unlabelled target renders its role in place of the label so the line is never
 * `[i]  (role)` with an empty slot.
 */
export function renderIndexTier(elements: IndexElement[], version: number | undefined): string {
  const header =
    version !== undefined
      ? `index tier (version ${version}) — tap with target: { index, version: ${version} }`
      : "index tier — tap with target: { index, version }";
  const lines = [header];
  for (const el of elements) {
    const shown = el.label.length > 0 ? el.label : `(${el.role})`;
    lines.push(
      el.label.length > 0 ? `[${el.index}] ${shown} (${el.role})` : `[${el.index}] ${shown}`
    );
  }
  if (elements.length === 0) lines.push("(no interactive elements)");
  return lines.join("\n");
}

/**
 * The `index` describe tier on the Android open path: read the current flat tree
 * (+ fingerprints for the `version`) and render the index list. Best-effort — any
 * failure throws to the describe dispatcher, which falls back to the standard
 * describe, so an `index` request never regresses describe.
 */
export async function describeAndroidIndexTier(
  registry: Registry,
  device: DeviceInfo
): Promise<DescribeResult> {
  const ref = openDeviceServerRef(device);
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    const state = await server.getState({ includeScreenshot: false, fingerprints: true });
    const elements = buildIndexElements(state.tree);
    return {
      description: renderIndexTier(elements, state.version),
      source: "open-device-server" as const,
    };
  });
}
