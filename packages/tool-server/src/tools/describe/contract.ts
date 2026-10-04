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

// Where the tree came from. "ax-service" / "native-devtools": iOS.
// "uiautomator" / "android-devtools" / "open-device-server": Android
// ("open-device-server" is the open-source on-device control server, gated behind
// the `open-device-server` flag). "cdp-dom": the Chromium DOM walk over Chrome
// DevTools Protocol. "vega-automation": the Vega on-device automation toolkit.
// "tv-focus": the focus-driven view for a TV target (Apple TV / Android TV),
// which reports focused / focusable elements rather than a tap-oriented tree.
export type DescribeSource =
  | "ax-service"
  | "native-devtools"
  | "uiautomator"
  | "android-devtools"
  | "open-device-server"
  // Physical iOS, and the iOS open-device-server path: the XCUITest runner
  // accessibility snapshot.
  | "xcuitest-runner"
  | "cdp-dom"
  | "vega-automation"
  | "tv-focus";

// Adapter-internal: `tree` is rendered by `format-tree.ts` and then dropped —
// callers get `DescribeResult` below, i.e. only the rendered text.
export interface DescribeTreeData {
  tree: DescribeNode;
  source: DescribeSource;
  should_restart?: boolean;
  // "degraded" means boot-state on the simulator path and a truncated snapshot on the device path.
  // Each path writes this hint once.
  hint?: string;
  // Size the frames were normalized against, in the source's native units
  // (Android px, iOS pt), so only the aspect ratio compares across sources —
  // which is what the rotate directive's circle geometry reads it for. Set
  // only by the flow tree adapters that know it.
  screen?: { width: number; height: number };
  // Server-measured split of the open-device-server describe capture:
  // `waitedMs` is the idle gate, `captureMs` the post-idle serialization
  // (screenshot skipped). Metadata only — never rendered into `description`.
  // Set solely by the Android open path; lets a bench separate the idle wait
  // from the tree serialization cost.
  waitedMs?: number;
  captureMs?: number;
  // Finer per-stage split of the open-device-server capture (phase 3g): the
  // sub-costs of `captureMs` (rootInActiveWindow, windows enumeration, each
  // window's root, node serialize, JSON encode) plus `idleMs` (== waitedMs).
  // Metadata only — never rendered; a bench reads it to locate the residual.
  timings?: DescribeStageTimings;
  // Host/transport split of the open-device-server describe (phase 3i), the piece
  // that lives OUTSIDE the on-device `timings`: `wireBytes` is the raw NDJSON reply
  // size on the wire (the full nested tree), `hostParseMs` the host `JSON.parse`
  // cost, `hostRenderMs` the host tree-lowering + trim (`openServerNestedToDescribeNode`).
  // The `hostSentToFirstByteMs` / `hostFirstToLastByteMs` / `hostRoundTripMs` triple
  // is the host-clock RPC timeline (TTFB, receive/streaming span, whole round-trip).
  // Metadata only — never rendered; a bench reads them to attribute the idle
  // describe residual to transport vs. host CPU. Set solely by the Android open path.
  wireBytes?: number;
  hostParseMs?: number;
  hostRenderMs?: number;
  hostSentToFirstByteMs?: number;
  hostFirstToLastByteMs?: number;
  hostRoundTripMs?: number;
  // Which host↔device transport carried the open-path reply (phase 3j):
  // "adb-forward" (default) or "redir". Metadata only.
  transport?: "adb-forward" | "redir";
  // Ticket A1 (part B): the ONE execution-incident line the open describe path
  // prepends to its rendered `description` while an incident is active on the
  // device (a prior verify refusal / no-effect tap / timeout). Set solely by the
  // Android open path; `withDescription` prepends it to the text. Absent when no
  // incident is active.
  incidentLine?: string;
  // How the UI lies on the space the frames are in, when the two differ: the
  // iOS simulator adapter frames in the screen's fixed (portrait-native)
  // space, the space touches are taken in, and a landscape UI — a rotated
  // device, an unfolded foldable — is rotated on it. The flow directions
  // (`swipe: down`, `scroll-to` `direction`) are the UI's, and are mapped
  // into the frame space with this. Absent when the source does not report
  // it, which is when its frames are in the UI's own space.
  uiOrientation?: UiOrientation;
}

export interface DescribeStageTimings {
  idleMs: number;
  rootMs: number;
  windowsMs: number;
  rootsMs: number[];
  serializeMs: number;
  encodeMs: number;
  // Fingerprint (hash) build cost (phase 3m). 0 / absent when fingerprints were
  // not requested — the plain describe path never computes them.
  fingerprintMs?: number;
  // Phase 3n.2 (residual gate): `infoMs` = the `info` block (DisplayReader.read +
  // isKeyboardVisible's window enumeration), `recycleMs` = the forest recycle, both
  // previously unaccounted inside captureMs; `otherMs` = server-computed leftover
  // (captureMs − Σ(named stages)). Absent on older servers.
  infoMs?: number;
  recycleMs?: number;
  otherMs?: number;
  // Which path produced the active root (phase 3g-b): "windows" =
  // `windows.firstOrNull { it.isActive }?.root` (the fast, mid-transition-safe
  // path), "activeWindow" = `rootInActiveWindow` fallback. Absent on older servers.
  rootSource?: "windows" | "activeWindow";
  // Server-side request timeline of the PREVIOUS same-method request (phase 3i),
  // piggybacked because a response cannot time its own write: `prevServerHandleMs`
  // = handler entry → response ready, `prevServerWriteMs` = response write + flush
  // (t4 − t3), `prevServerTotalMs` = handler entry → flush done (t4 − t2). Absent
  // on older servers.
  prevServerHandleMs?: number;
  prevServerWriteMs?: number;
  prevServerTotalMs?: number;
}

/** Interface orientation as UIKit names it, relative to the portrait-native screen. */
export type UiOrientation = "portrait" | "landscapeLeft" | "landscapeRight" | "portraitUpsideDown";

const UI_ORIENTATIONS: readonly UiOrientation[] = [
  "portrait",
  "portraitUpsideDown",
  "landscapeLeft",
  "landscapeRight",
];

export function asUiOrientation(v: unknown): UiOrientation | undefined {
  return typeof v === "string" && (UI_ORIENTATIONS as readonly string[]).includes(v)
    ? (v as UiOrientation)
    : undefined;
}

export interface DescribeResult {
  description: string;
  source: DescribeSource;
  should_restart?: boolean;
  hint?: string;
  // Idle-gate vs. serialization split (open-device-server only), carried through
  // as metadata alongside the rendered `description` — see DescribeTreeData.
  waitedMs?: number;
  captureMs?: number;
  // Per-stage capture split (open-device-server only, phase 3g).
  timings?: DescribeStageTimings;
  // Host/transport split (open-device-server only, phase 3i): reply wire size,
  // host JSON.parse cost, host tree-lowering cost, and the host-clock timeline.
  // See DescribeTreeData.
  wireBytes?: number;
  hostParseMs?: number;
  hostRenderMs?: number;
  hostSentToFirstByteMs?: number;
  hostFirstToLastByteMs?: number;
  hostRoundTripMs?: number;
  // Which host↔device transport carried the open-path reply (phase 3j item 3d):
  // "adb-forward" or "redir". Undefined on the proprietary / dump paths.
  transport?: "adb-forward" | "redir";
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
