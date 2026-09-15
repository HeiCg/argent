import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { isFlagEnabled } from "@argent/configuration-core";
import type { DeviceInfo, Registry } from "@argent/registry";
import {
  openDeviceServerRef,
  type GesturePointerPath,
  type OpenDeviceServerApi,
  type OpenInjectStrategy,
  type OpenServerActionOutcome,
  type OpenServerAwaitChangeResult,
  type OpenServerBatchAction,
  type OpenServerBatchStepResult,
  type OpenServerSelector,
} from "../blueprints/android-open-server";
import { buildIndexElements } from "../tools/describe/platforms/android/index-tier";
import { openDeviceServerMutex } from "./device-mutex";
import {
  getCachedScreenSize,
  setCachedScreenSize,
  __resetOpenServerScreenSizeCache,
} from "./open-server-screen-cache";
import {
  recordOpenServerObservation,
  screenGraphRecordingEnabled,
} from "./screen-graph-open-wiring";
import type { EdgeSelector } from "../screen-graph";
import type { OpenServerElement } from "../tools/describe/platforms/android/open-server-tree";
import {
  resolveVerify,
  boundsCenter,
  type VerifyBounds,
  type VerifyCandidate,
  type VerifyGuard,
  type VerifyResolution,
} from "./open-server-verify";
import { clearIncident } from "./open-server-incident";
import type { QueryNodeLite } from "../screen-graph/bench/locate";

// Defaults for the multi-tap timeline the on-device server builds (F1/F8/F9).
// Kept in sync with the host constants of the same name in `gesture-tap`.
const TAP_HOLD_MS = 50;
const MULTI_TAP_GAP_MS = 100;

/**
 * Phase 3n: the on-device injection strategy threaded onto every tap/swipe/gesture
 * RPC. The `open-device-server-inject-strategy` flag documents the capability, but
 * the boolean flag store cannot hold a value, so the active strategy is carried by
 * the `ARGENT_OPEN_INJECT_STRATEGY` env var, so the bench flips it per block within
 * one CI run. Resolution (kept in sync with the body below, 3N2-M5):
 *   - unset / unknown  → `input-manager` — the SHIPPED default since the 3n.1 flip; the
 *     host sends `inject:"input-manager"` and the on-device server falls back to
 *     `uia-async` by itself on a hiddenapi block.
 *   - `default` / `uia` → undefined — the pre-3n.1 Kotlin DEFAULT path; the `inject`
 *     param is OMITTED so a tap keeps its async UP and a swipe/gesture its blocking UP
 *     (this is what the `ON-uiautomation` control block, gate P0, runs).
 */
export function resolveInjectStrategy(): OpenInjectStrategy | undefined {
  const v = process.env.ARGENT_OPEN_INJECT_STRATEGY;
  if (v === "uia-sync" || v === "uia-async" || v === "input-manager") return v;
  // Phase 3n.1 (run-1 promotion): the default injector is now `input-manager` — the
  // host sends `inject:"input-manager"` on every gesture unless overridden, and the
  // on-device server falls back to `uia-async` by itself on a hiddenapi block. The
  // `default` (alias `uia`) sentinel selects the PRE-3n.1 Kotlin DEFAULT path — the
  // host sends NO `inject`, so tap keeps its async UP and swipe/gesture their sync UP;
  // it is what the `ON-uiautomation` control block (gate P0) runs. Any other value
  // (unset included) is the new default.
  if (v === "default" || v === "uia") return undefined;
  return "input-manager";
}

/** Spread `{ inject }` only when a strategy is active, so DEFAULT RPCs are unchanged. */
function injectOpt(): { inject?: OpenInjectStrategy } {
  const inject = resolveInjectStrategy();
  return inject ? { inject } : {};
}

/** 1/16 grid for the edge selector's bounds bucket (mirrors canonical.ts GRID). */
const EDGE_BUCKET_GRID = 16;

/**
 * The acted element's selector for a coordinate tap (phase D §2): the smallest
 * node in the BEFORE tree whose bounds contain (x, y) and that carries a
 * resource-id / text / content-description. Recorded on the edge so replay
 * re-resolves the element instead of replaying a bare coordinate.
 */
function tappedSelectorFromTree(
  tree: OpenServerElement[],
  x: number,
  y: number,
  size: { width: number; height: number }
): EdgeSelector | undefined {
  let best: OpenServerElement | undefined;
  let bestArea = Infinity;
  for (const el of tree) {
    const b = el.bounds;
    if (x < b.x1 || x > b.x2 || y < b.y1 || y > b.y2) continue;
    if (!(el.resourceId?.trim() || el.text?.trim() || el.contentDesc?.trim())) continue;
    const area = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
    if (area < bestArea) {
      bestArea = area;
      best = el;
    }
  }
  if (!best) return undefined;
  const bucket = {
    x: Math.min(
      EDGE_BUCKET_GRID - 1,
      Math.max(0, Math.floor((x * EDGE_BUCKET_GRID) / Math.max(1, size.width)))
    ),
    y: Math.min(
      EDGE_BUCKET_GRID - 1,
      Math.max(0, Math.floor((y * EDGE_BUCKET_GRID) / Math.max(1, size.height)))
    ),
  };
  const sel: EdgeSelector = {
    className: best.className,
    indexInParent: best.index,
    boundsBucket: bucket,
  };
  const id = best.resourceId?.trim();
  if (id) sel.resourceId = id;
  const text = best.text?.trim();
  if (text) sel.text = text;
  const cd = best.contentDesc?.trim();
  if (cd) sel.contentDescription = cd;
  // Phase D.1 Fix A: choose the key that is UNIQUE on the source tree so replay
  // never resolves a shared resource-id (every Settings list row is
  // `android:id/title`; tapping the first match lands on the wrong sibling and
  // diverges). Count matches over the visible tree and record the chosen `via`;
  // replay honours it and refuses when the live query is not size 1.
  const norm = (s: string | undefined): string => (s ?? "").trim().toLowerCase();
  const idLc = norm(id);
  const textLc = norm(text);
  const cdLc = norm(cd);
  let idCount = 0;
  let textCount = 0;
  let cdCount = 0;
  for (const el of tree) {
    if (id && norm(el.resourceId) === idLc) idCount++;
    if (text && norm(el.text) === textLc) textCount++;
    if (cd && norm(el.contentDesc) === cdLc) cdCount++;
  }
  if (id && idCount === 1) sel.via = "id";
  else if (text && textCount === 1) sel.via = "text";
  else if (cd && cdCount === 1) sel.via = "text";
  else sel.via = "position";
  return sel;
}

/** Drop the action's own `{success}` and keep the outcome fingerprint delta. */
function toOutcome(r: OpenServerActionOutcome & { success?: unknown }): OpenServerActionOutcome {
  return {
    before: r.before,
    after: r.after,
    changed: r.changed,
    newScreen: r.newScreen,
    settled: r.settled,
    firstEventMs: r.firstEventMs,
    idleMs: r.idleMs,
  };
}

/**
 * Open-source input backend: routes touch gestures through
 * `@argent/android-device-server` instead of the proprietary simulator-server,
 * when the `open-device-server` flag is on. This is argent's first fully
 * open-source Android control path.
 *
 * Every entry point here throws on any failure (flag off, server unreachable,
 * RPC error). Callers catch and fall back to the existing simulator-server path,
 * so the open backend is strictly additive.
 */

/** Whether the open-device-server input backend applies to this device. */
export function shouldUseOpenServer(device: DeviceInfo): boolean {
  return device.platform === "android" && isFlagEnabled("open-device-server");
}

// Re-export the reset seam so existing importers keep working; the cache itself
// now lives in `open-server-screen-cache` (see F21).
export { __resetOpenServerScreenSizeCache };

/**
 * Screen-graph Phase A.1: block on the device's AX-event clock until the tree
 * changes (and, with `until`, until that selector matches), settling on the next
 * stable state when `settle` is set. Lets `await-ui-element` wait on-device
 * instead of host-polling `describe`. Serialized under the device mutex like the
 * other open paths; throws on any RPC failure so the caller can fall back to the
 * poll loop.
 */
export function openServerAwaitChange(
  registry: Registry,
  device: DeviceInfo,
  opts: {
    fromVersion: number;
    timeoutMs: number;
    until?: OpenServerSelector;
    settle?: boolean;
    quietMs?: number;
  }
): Promise<OpenServerAwaitChangeResult> {
  const ref = openDeviceServerRef(device);
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    return server.awaitChange(opts);
  });
}

async function withServer<T>(
  registry: Registry,
  device: DeviceInfo,
  fn: (api: OpenDeviceServerApi, size: { width: number; height: number }) => Promise<T>
): Promise<T> {
  const ref = openDeviceServerRef(device);
  // Serialize against describe / other input on the same device.
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    // Peek the cheap, rotation-aware `getScreenSize` (display metrics only, ~1 ms
    // even mid-animation — unlike `getInfo`) on every gesture, and key the cache
    // by rotation (F21). A mid-session rotation reports a new `displayRotation`,
    // so the stored width/height is refreshed instead of converting the gesture
    // against the pre-rotation geometry (the bug: a landscape tap landing at
    // portrait pixels). When the rotation is unchanged the cached dimensions are
    // reused as-is.
    const s = await server.getScreenSize();
    const rotation = s.displayRotation;
    const cached = getCachedScreenSize(device.id);
    let size: { width: number; height: number };
    if (cached && cached.rotation === rotation && cached.width > 0 && cached.height > 0) {
      size = { width: cached.width, height: cached.height };
    } else {
      size = { width: s.screenWidth, height: s.screenHeight };
      if (size.width > 0 && size.height > 0) {
        setCachedScreenSize(device.id, { ...size, rotation });
      } else if (cached) {
        // A transient 0×0 read while the display is reconfiguring: keep the last
        // known-good geometry rather than converting against zero.
        size = { width: cached.width, height: cached.height };
      }
    }
    return fn(server, size);
  });
}

function toPixels(
  size: { width: number; height: number },
  xNorm: number,
  yNorm: number
): { x: number; y: number } {
  return {
    x: Math.round(Math.max(0, Math.min(1, xNorm)) * size.width),
    y: Math.round(Math.max(0, Math.min(1, yNorm)) * size.height),
  };
}

/**
 * Tap `clickCount` times at normalized coordinates via the open server. The whole
 * multi-tap timeline is built server-side in ONE `tap` RPC (F1/F8/F9): the server
 * holds each press `holdMs` and spaces successive taps `gapMs` apart, so a
 * double-tap lands inside the OS double-tap window without the host firing (and
 * having to time) N separate RPCs.
 */
export function openServerTap(
  registry: Registry,
  device: DeviceInfo,
  xNorm: number,
  yNorm: number,
  clickCount: number
): Promise<void> {
  return withServer(registry, device, async (server, size) => {
    const { x, y } = toPixels(size, xNorm, yNorm);
    const res = await server.tap(x, y, {
      clickCount,
      holdMs: TAP_HOLD_MS,
      ...(clickCount > 1 ? { gapMs: MULTI_TAP_GAP_MS } : {}),
      ...injectOpt(),
    });
    // R1 (phase 3g): the on-device dispatcher rejected an injected event, so the
    // tap never landed. Throw so the caller fails this action and falls back to the
    // simulator-server path rather than reporting a tap that did nothing.
    if (res.dropped || res.success === false) {
      throw new Error("open-device-server tap was dropped by the input dispatcher");
    }
  });
}

/**
 * Put `text` on the device clipboard via the open server's `setClipboard` RPC
 * (ClipboardManager). Backs the Android `paste` tool's open path (F20). Resolves
 * to `{ success: true }` when the write round-tripped on-device (the caller then
 * triggers KEYCODE_PASTE); to `{ success: false }` (no `error`) when it did not —
 * ClipboardManager silently drops a background app's `setPrimaryClip` on API 35,
 * so the caller falls back to typing rather than pasting nothing; and to
 * `{ success: false, error }` when the on-device write THREW (a transient blip).
 * The caller must not treat an error-carrying false as proof the clipboard is
 * unsupported (R3, phase 3g). Rejects only on an RPC transport error.
 */
export function openServerSetClipboard(
  registry: Registry,
  device: DeviceInfo,
  text: string
): Promise<{ success: boolean; error?: string }> {
  const ref = openDeviceServerRef(device);
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    const res = await server.setClipboard(text);
    // R3 (phase 3g): thread the on-device `error` through. `error` present ⇒ the
    // write threw (transient), which the caller must NOT treat as proof the
    // clipboard is unsupported. A clean `success:false` is the definitive drop.
    return { success: res.success, ...(res.error ? { error: res.error } : {}) };
  });
}

/**
 * Screen-graph Phase A: tap and report the before/after fingerprint delta in one
 * round-trip. For a multi-tap (`clickCount > 1`) the leading taps run plain and
 * the outcome's `before` is taken from a pre-gesture `getState`, so the delta
 * spans the whole gesture; the final tap carries the server-side idle wait.
 */
export function openServerTapWithOutcome(
  registry: Registry,
  device: DeviceInfo,
  xNorm: number,
  yNorm: number,
  clickCount: number,
  idleTimeoutMs?: number
): Promise<OpenServerActionOutcome> {
  return withServer(registry, device, async (server, size) => {
    const { x, y } = toPixels(size, xNorm, yNorm);
    // Phase D §2: when the screen graph is recording, read the BEFORE tree once so
    // the edge can carry the acted element's selector (re-resolved on replay). The
    // extra read is an internal RPC (not a counted bench round-trip) and only runs
    // while the graph flag is on.
    let actedSelector: EdgeSelector | undefined;
    // Phase E: keep the before tree too, so the recorder can resolve the tap's
    // scrollable container / item template host-side (design D1 option B).
    let beforeTree: OpenServerElement[] | undefined;
    if (screenGraphRecordingEnabled()) {
      try {
        const before = await server.getState({ includeScreenshot: false });
        beforeTree = before.tree;
        actedSelector = tappedSelectorFromTree(before.tree, x, y, size);
      } catch {
        /* best-effort — a coordinate edge without a selector still records */
      }
    }
    // ONE `tap` RPC carries the whole multi-tap timeline (F1/F8/F9 —
    // `clickCount` presses each held `holdMs`, spaced `gapMs` apart, built
    // server-side) AND the outcome request, so a double-tap is a single
    // round-trip that both lands inside the OS double-tap window and reports the
    // before/after fingerprint delta.
    const outcome = toOutcome(
      await server.tapWithOutcome(x, y, {
        clickCount,
        holdMs: TAP_HOLD_MS,
        ...(clickCount > 1 ? { gapMs: MULTI_TAP_GAP_MS } : {}),
        ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
        ...injectOpt(),
      })
    );
    await recordOpenServerObservation(device, server, size, { kind: "tap", x, y }, outcome, {
      ...(actedSelector ? { actedSelector } : {}),
      ...(beforeTree ? { beforeTree, point: { x, y } } : {}),
    });
    return outcome;
  });
}

/* ------------------------------------------------------------------------- */
/* Ticket Artemis A1 (part A) — verified tap / swipe (`verify: { selector }`)  */
/* ------------------------------------------------------------------------- */

/** The `verify` argument shared by the verified tap and swipe-start paths. */
export interface OpenServerVerify {
  selector: OpenServerSelector;
  /** Slack around the match's bounds for the coordinate cross-check; default 0. */
  tolerancePx?: number;
}

/**
 * The reply of a verified tap/swipe. `outcome` is the resolution verdict; the
 * refusal variants carry the context the tool returns to the caller and records
 * as an incident (part B). `version` is the AX version clock at the query (the
 * `query` read arms it, phase 3m lazy-arm), so the caller can key a follow-up
 * `awaitChange` off a fresh clock. `verifyMs` is the host round-trip of the ONE
 * `query` RPC, for the bench.
 */
export interface OpenServerVerifiedResult {
  outcome: "tapped" | "swiped" | "not_found" | "ambiguous" | "mismatch";
  version: number;
  verifyMs: number;
  /** The resolved match's bounds (on `tapped` / `swiped` / `mismatch`). */
  resolvedBounds?: VerifyBounds;
  /** Up to 5 matches on `ambiguous` (label + bounds). */
  candidates?: VerifyCandidate[];
  /** The pixel coordinates the caller proposed, echoed on `mismatch`. */
  requestedPx?: { x: number; y: number };
  /** The element the caller's coordinates actually pointed at (on `mismatch`). */
  label?: string;
  /** Whether the LANDED tap moved the UI (present on `tapped` only). */
  changed?: boolean;
  /** The before/after fingerprint delta of a landed tap (present on `tapped`). */
  actionOutcome?: OpenServerActionOutcome;
}

// Verify `query` limit: 5 candidates to list on ambiguity + 1 to know there are
// more than 5, so a broad selector never serialises the whole matching forest
// (review A1-M3).
const VERIFY_QUERY_LIMIT = 6;

/** Build the coordinate guard only when the caller supplied x AND y (A1-H3). */
function verifyGuard(
  size: { width: number; height: number },
  xNorm: number | undefined,
  yNorm: number | undefined,
  tolerancePx: number | undefined
): { px: { x: number; y: number }; guard: VerifyGuard } | undefined {
  if (xNorm === undefined || yNorm === undefined) return undefined;
  const px = toPixels(size, xNorm, yNorm);
  return { px, guard: { xPx: px.x, yPx: px.y, tolerancePx: tolerancePx ?? 0 } };
}

/**
 * Verify a tap target on the LIVE tree, then tap its bounds CENTER — or refuse
 * without injecting. Runs the server-side `query` RPC (never a cached describe),
 * resolves a unique node with `pickUniqueNode`'s precedence, and — WHEN the caller
 * also supplied x/y — cross-checks that coordinate against the match. With no
 * coordinate the unique match is tapped unconditionally (A1-H3). On a landed tap
 * it reads the before/after delta (via `tapWithOutcome`) so the caller can tell a
 * no-effect tap (recorded as an incident) from a real one. The whole thing runs
 * under ONE device lock so the query and the tap see the same tree.
 */
export function openServerVerifiedTap(
  registry: Registry,
  device: DeviceInfo,
  xNorm: number | undefined,
  yNorm: number | undefined,
  clickCount: number,
  verify: OpenServerVerify
): Promise<OpenServerVerifiedResult> {
  return withServer(registry, device, async (server, size) => {
    const t0 = performance.now();
    // `query` arms the version clock and returns the live matches (capped) — the
    // like-for-like read the screen-graph harness uses (`locateNorm`).
    const q = await server.query(verify.selector, { limit: VERIFY_QUERY_LIMIT });
    const verifyMs = Number((performance.now() - t0).toFixed(3));
    const version = q.version;
    const g = verifyGuard(size, xNorm, yNorm, verify.tolerancePx);
    const res: VerifyResolution = resolveVerify(
      q.nodes as QueryNodeLite[],
      verify.selector,
      g?.guard
    );
    if (res.kind === "not_found") return { outcome: "not_found", version, verifyMs };
    if (res.kind === "ambiguous")
      return { outcome: "ambiguous", version, verifyMs, candidates: res.candidates };
    if (res.kind === "mismatch")
      return {
        outcome: "mismatch",
        version,
        verifyMs,
        resolvedBounds: res.bounds,
        ...(g ? { requestedPx: g.px } : {}),
        label: res.label,
      };
    // Unique match — tap its center. Use the outcome-bearing RPC so a landed but
    // ineffective tap is detectable (`changed:false`).
    const c = boundsCenter(res.bounds);
    const cx = Math.round(c.x);
    const cy = Math.round(c.y);
    const raw = await server.tapWithOutcome(cx, cy, {
      clickCount,
      holdMs: TAP_HOLD_MS,
      ...(clickCount > 1 ? { gapMs: MULTI_TAP_GAP_MS } : {}),
      ...injectOpt(),
    });
    if ((raw as { dropped?: boolean }).dropped || raw.success === false) {
      throw new Error("open-device-server tap was dropped by the input dispatcher");
    }
    const actionOutcome = toOutcome(raw);
    // A1-M8: when the screen graph is recording, record the tap as an observation
    // like `openServerTapWithOutcome` does, so the edge is not lost. The acted
    // node is the verified match, but the compact `query` node lacks the child
    // path an `EdgeSelector` bucket needs, so the coordinate observation (target
    // = the tapped center) is recorded rather than a reconstructed selector.
    if (screenGraphRecordingEnabled()) {
      await recordOpenServerObservation(
        device,
        server,
        size,
        { kind: "tap", x: cx, y: cy },
        actionOutcome
      );
    }
    return {
      outcome: "tapped",
      version,
      verifyMs,
      resolvedBounds: res.bounds,
      changed: actionOutcome.changed,
      actionOutcome,
    };
  });
}

/**
 * Verify a swipe's START point on the LIVE tree, then swipe from the match's
 * CENTER to the given end point — or refuse without injecting. Same resolution
 * and coordinate cross-check as [openServerVerifiedTap]; the end point is taken
 * as authored (only the start is verified). `momentum: false` still rides on
 * `holdEndMs`.
 */
export function openServerVerifiedSwipe(
  registry: Registry,
  device: DeviceInfo,
  fromXNorm: number | undefined,
  fromYNorm: number | undefined,
  toXNorm: number,
  toYNorm: number,
  steps: number,
  verify: OpenServerVerify,
  holdEndMs?: number
): Promise<OpenServerVerifiedResult> {
  return withServer(registry, device, async (server, size) => {
    const to = toPixels(size, toXNorm, toYNorm);
    const t0 = performance.now();
    const q = await server.query(verify.selector, { limit: VERIFY_QUERY_LIMIT });
    const verifyMs = Number((performance.now() - t0).toFixed(3));
    const version = q.version;
    const g = verifyGuard(size, fromXNorm, fromYNorm, verify.tolerancePx);
    const res: VerifyResolution = resolveVerify(
      q.nodes as QueryNodeLite[],
      verify.selector,
      g?.guard
    );
    if (res.kind === "not_found") return { outcome: "not_found", version, verifyMs };
    if (res.kind === "ambiguous")
      return { outcome: "ambiguous", version, verifyMs, candidates: res.candidates };
    if (res.kind === "mismatch")
      return {
        outcome: "mismatch",
        version,
        verifyMs,
        resolvedBounds: res.bounds,
        ...(g ? { requestedPx: g.px } : {}),
        label: res.label,
      };
    const c = boundsCenter(res.bounds);
    const swipeRes = await server.swipe(
      Math.round(c.x),
      Math.round(c.y),
      to.x,
      to.y,
      steps,
      holdEndMs,
      injectOpt()
    );
    if ((swipeRes as { dropped?: boolean }).dropped || swipeRes.success === false) {
      throw new Error("open-device-server swipe was dropped by the input dispatcher");
    }
    return { outcome: "swiped", version, verifyMs, resolvedBounds: res.bounds };
  });
}

/**
 * Swipe between two normalized points via the open server. The server runs its
 * own UiAutomator interpolation (`steps`), so this is one RPC rather than the
 * per-frame Move loop the simulator-server path drives host-side.
 *
 * `holdEndMs > 0` asks the server to hold the last pointer position that long
 * before the lift, so the release velocity decays to ~0 (a momentum-free swipe);
 * omit it for a plain flinging swipe.
 */
export function openServerSwipe(
  registry: Registry,
  device: DeviceInfo,
  fromXNorm: number,
  fromYNorm: number,
  toXNorm: number,
  toYNorm: number,
  steps: number,
  holdEndMs?: number
): Promise<void> {
  return withServer(registry, device, async (server, size) => {
    const from = toPixels(size, fromXNorm, fromYNorm);
    const to = toPixels(size, toXNorm, toYNorm);
    const res = await server.swipe(from.x, from.y, to.x, to.y, steps, holdEndMs, injectOpt());
    if ((res as { dropped?: boolean }).dropped || res.success === false) {
      throw new Error("open-device-server swipe was dropped by the input dispatcher");
    }
  });
}

/** Screen-graph Phase A: swipe and report the before/after fingerprint delta. */
export function openServerSwipeWithOutcome(
  registry: Registry,
  device: DeviceInfo,
  fromXNorm: number,
  fromYNorm: number,
  toXNorm: number,
  toYNorm: number,
  steps: number,
  holdEndMs?: number,
  idleTimeoutMs?: number
): Promise<OpenServerActionOutcome> {
  const opts = {
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    ...injectOpt(),
  };
  return withServer(registry, device, async (server, size) => {
    const from = toPixels(size, fromXNorm, fromYNorm);
    const to = toPixels(size, toXNorm, toYNorm);
    const outcome = toOutcome(
      await server.swipeWithOutcome(from.x, from.y, to.x, to.y, steps, holdEndMs, opts)
    );
    await recordOpenServerObservation(
      device,
      server,
      size,
      { kind: "swipe", startX: from.x, startY: from.y, endX: to.x, endY: to.y },
      outcome
    );
    return outcome;
  });
}

/**
 * Type text via the open server's `typeText` RPC. Backs the Android `paste`
 * tool's open path: phase 2 accepts typing the text over injecting the device
 * clipboard + KEYCODE_PASTE (same observable end — the text lands in the focused
 * field). Throws on any failure; the caller falls back to the clipboard path.
 */
export function openServerTypeText(
  registry: Registry,
  device: DeviceInfo,
  text: string
): Promise<void> {
  const ref = openDeviceServerRef(device);
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    await server.typeText(text);
  });
}

/**
 * Screen-graph Phase A: type text and report the before/after fingerprint delta.
 * `opts.secretsUsed` (Phase B leftover B1) marks the observation as holding a
 * secret so the recorded target node is redacted live, even when the field is
 * not flagged password on-device — the paste tool sets it when the typed text
 * came from a `{{secret:…}}` placeholder.
 */
export function openServerTypeTextWithOutcome(
  registry: Registry,
  device: DeviceInfo,
  text: string,
  opts: { secretsUsed?: boolean; idleTimeoutMs?: number } = {}
): Promise<OpenServerActionOutcome> {
  const ref = openDeviceServerRef(device);
  const outcomeOpts =
    opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : undefined;
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    const outcome = toOutcome(await server.typeTextWithOutcome(text, outcomeOpts));
    // No coordinates for typeText, so bucketing is irrelevant — pass a 0 size.
    await recordOpenServerObservation(
      device,
      server,
      { width: 0, height: 0 },
      { kind: "typeText" },
      outcome,
      opts.secretsUsed ? { secret: true } : {}
    );
    return outcome;
  });
}

/**
 * Screen-graph Phase A: wait for the screen to settle using the device's AX
 * event clock (`awaitChange`) instead of a host poll loop. "Settled" = the
 * screen has content AND no AX event fired for `minStableMs`, which is exactly an
 * `awaitChange` that times out with no change. Content that keeps changing
 * re-arms the wait until the overall `timeoutMs`.
 *
 * Returns the same `{ settled, waitedMs, polls }` shape as the poll path; `polls`
 * counts the round-trips made. Throws on any failure so the caller falls back to
 * the describe-tree poll loop.
 */
export async function awaitScreenIdleViaOpenServer(
  registry: Registry,
  device: DeviceInfo,
  opts: { timeoutMs: number; minStableMs: number },
  signal?: AbortSignal
): Promise<{ settled: boolean; waitedMs: number; polls: number }> {
  const ref = openDeviceServerRef(device);
  const start = Date.now();
  const deadline = start + opts.timeoutMs;
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    let polls = 0;
    // Phase 3m: request fingerprints so this first read ARMS the device AX clock
    // and returns a live `version` before the awaitChange loop below keys off it
    // (with the lazy listener the clock is otherwise 0 until first armed, and an
    // event between this read and the first awaitChange could be missed).
    let state = await server.getState({ includeScreenshot: false, fingerprints: true });
    polls += 1;
    let version = state.version ?? 0;

    const waited = (): number => Date.now() - start;

    for (;;) {
      if (signal?.aborted) return { settled: false, waitedMs: waited(), polls };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { settled: false, waitedMs: waited(), polls };

      const hasContent = state.tree.length > 0;
      if (hasContent && opts.minStableMs === 0) {
        return { settled: true, waitedMs: waited(), polls };
      }

      // Blank screen: wait for anything to appear. Content present: wait for the
      // stability window; a timeout there (no event) means it settled.
      const waitMs = hasContent ? Math.min(opts.minStableMs, remaining) : remaining;
      const change = await server.awaitChange({ fromVersion: version, timeoutMs: waitMs });
      polls += 1;

      if (change.timedOut) {
        // No event within the window. Settled iff there was content to hold still.
        return { settled: hasContent, waitedMs: waited(), polls };
      }

      // Something changed — re-read and keep waiting.
      version = change.version;
      state = await server.getState({ includeScreenshot: false, sinceVersion: version });
      polls += 1;
    }
  });
}

/** One pointer's path in normalized 0–1 coordinates for [openServerGesture]. */
export interface NormalizedPointerPath {
  id?: number;
  points: Array<{ x: number; y: number; tMs: number }>;
}

/**
 * Multi-pointer gesture via the open server: converts each pointer's normalized
 * path to device pixels against the live screen size and injects it in one RPC.
 * Backs the pinch / rotate / custom tools, which `swipe` (a single straight
 * line) cannot express.
 */
export function openServerGesture(
  registry: Registry,
  device: DeviceInfo,
  pointers: NormalizedPointerPath[]
): Promise<void> {
  return withServer(registry, device, async (server, size) => {
    const pixelPointers: GesturePointerPath[] = pointers.map((p) => ({
      ...(p.id !== undefined ? { id: p.id } : {}),
      points: p.points.map((pt) => {
        const { x, y } = toPixels(size, pt.x, pt.y);
        return { x, y, tMs: pt.tMs };
      }),
    }));
    const res = await server.gesture(pixelPointers, injectOpt());
    if ((res as { dropped?: boolean }).dropped || res.success === false) {
      throw new Error("open-device-server gesture was dropped by the input dispatcher");
    }
    // A1-M1: a successful open-driver gesture (pinch / rotate / custom) clears any
    // standing execution incident on this device, like tap and swipe do.
    clearIncident(device.id);
  });
}

/**
 * Capture a screenshot via the open server, written to a temp PNG on the host.
 * Shared by the `screenshot` and `screenshot-diff` tools so neither duplicates
 * the branch. Requests PNG so the callers keep their image/png output contract.
 * Throws on any failure (flag off is the caller's own gate); callers fall back
 * to the simulator-server capture.
 */
export function captureAndroidScreenshot(
  registry: Registry,
  device: DeviceInfo,
  scale?: number
): Promise<{ path: string; width: number; height: number }> {
  const ref = openDeviceServerRef(device);
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    const shot = await server.screenshot({
      format: "png",
      ...(scale !== undefined ? { scale } : {}),
    });
    const bytes = Buffer.from(shot.data, "base64");
    const file = path.join(
      os.tmpdir(),
      `argent-open-screenshot-${device.id.slice(0, 12)}-${crypto.randomBytes(6).toString("hex")}.png`
    );
    await fs.writeFile(file, bytes);
    return { path: file, width: shot.width, height: shot.height };
  });
}

// ---------------------------------------------------------------------------
// Artemis A2 — element-index target + gesture-sequence burst
// ---------------------------------------------------------------------------

/** A `target: { index, version }` reference into the `index` describe tier. */
export interface IndexTarget {
  index: number;
  /** The AX version the index tier was rendered at — must still be current. */
  version: number;
}

/**
 * Thrown when an index `target` cannot be honoured. `code` is stable so
 * callers/tests can branch on it:
 *  - `stale_index` — the device snapshot moved off `target.version`, OR the device
 *    reported NO live version (fail closed, review A2-M6): the index the agent saw
 *    is no longer trustworthy, so re-describe.
 *  - `index_out_of_range` — the index is not on the current screen.
 *  - `stale_index_in_burst` — more than one index `target` in one `gesture-sequence`
 *    burst: every index resolves against the ONE pre-burst snapshot, so a target
 *    after the first acting step would tap stale coordinates (review A2-M5). Only
 *    one index target per burst is allowed.
 */
export class IndexTargetError extends Error {
  constructor(
    readonly code: "stale_index" | "index_out_of_range" | "stale_index_in_burst",
    message: string
  ) {
    super(message);
    this.name = "IndexTargetError";
  }
}

/**
 * Resolve a `target: { index, version }` against a freshly-read tree to the tap
 * point (device-pixel centre) and the element's label. Refuses with
 * `IndexTargetError("stale_index")` when the live `version` moved off
 * `target.version` OR is undefined (fail closed — A2-M6), and `index_out_of_range`
 * when the index is absent on the current screen. Pure over `(tree, version)` so
 * the sequence path and the single tap share it.
 */
export function resolveIndexTarget(
  tree: OpenServerElement[],
  liveVersion: number | undefined,
  target: IndexTarget
): { x: number; y: number; label: string } {
  // Fail closed (A2-M6): a missing live version is NOT proof the snapshot is
  // current, so refuse rather than tapping unverified — the safety this tier sells.
  if (liveVersion === undefined || liveVersion !== target.version) {
    throw new IndexTargetError(
      "stale_index",
      `stale_index: the screen moved or reports no version (index tier version ${target.version}, device now ${liveVersion ?? "unknown"}). Re-describe with tier:"index" and tap the fresh index.`
    );
  }
  const elements = buildIndexElements(tree);
  const el = elements[target.index];
  if (!el) {
    throw new IndexTargetError(
      "index_out_of_range",
      `index_out_of_range: index ${target.index} is not on the current screen (it has ${elements.length} interactive elements).`
    );
  }
  const b = el.bounds;
  return {
    x: Math.round((b.x1 + b.x2) / 2),
    y: Math.round((b.y1 + b.y2) / 2),
    label: el.label,
  };
}

/**
 * Read the current state and resolve an index `target` to NORMALIZED coordinates
 * (0–1) plus the element's label/index — the form the verified-tap path
 * (`openServerVerifiedTap`) consumes, so a `gesture-tap { target, verify }` can
 * tap by index AND cross-check the selector on the live tree (A2-H1). Refuses via
 * {@link IndexTargetError} on a stale/out-of-range index.
 */
export function resolveTargetNorm(
  registry: Registry,
  device: DeviceInfo,
  target: IndexTarget
): Promise<{ xNorm: number; yNorm: number; label: string; index: number }> {
  const ref = openDeviceServerRef(device);
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    const state = await server.getState({ includeScreenshot: false, fingerprints: true });
    const { x, y, label } = resolveIndexTarget(state.tree, state.version, target);
    const w = state.info.screenWidth || 1;
    const h = state.info.screenHeight || 1;
    return { xNorm: x / w, yNorm: y / h, label, index: target.index };
  });
}

/**
 * Tap the element addressed by an index `target` (A2 §B): read the current state,
 * verify the snapshot version (refuse `stale_index` if it moved), and tap the
 * element's bounds centre — all in ONE device lock. Returns the resolved element's
 * `index` and `label` so the tool can name WHAT it tapped (A2-M10). Backs the
 * additive `target` param on `gesture-tap`. Throws {@link IndexTargetError} on a
 * stale/out-of-range index; throws on a dropped injection or RPC failure.
 */
export function openServerTapAtIndex(
  registry: Registry,
  device: DeviceInfo,
  target: IndexTarget,
  clickCount: number
): Promise<{ index: number; label: string }> {
  const ref = openDeviceServerRef(device);
  return openDeviceServerMutex.withDeviceLock(device.id, async () => {
    const server = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
    const state = await server.getState({ includeScreenshot: false, fingerprints: true });
    const { x, y, label } = resolveIndexTarget(state.tree, state.version, target);
    const res = await server.tap(x, y, {
      clickCount,
      holdMs: TAP_HOLD_MS,
      ...(clickCount > 1 ? { gapMs: MULTI_TAP_GAP_MS } : {}),
      ...injectOpt(),
    });
    if (res.dropped || res.success === false) {
      throw new Error("open-device-server tap was dropped by the input dispatcher");
    }
    return { index: target.index, label };
  });
}

// Swipe frame/hold conversion — kept in sync with the `gesture-swipe` host tool so
// a sequenced swipe behaves like a single one (durationMs → interpolation steps;
// momentum:false → a last-pointer hold that decays release velocity to ~0).
const SEQ_DEFAULT_SWIPE_DURATION_MS = 300;
const SEQ_MOMENTUM_FREE_HOLD_MS = 120;

/** One normalized step of a {@link openServerSequence} burst (host-facing). */
export type SequenceStep =
  | {
      kind: "tap";
      x?: number;
      y?: number;
      clickCount?: number;
      target?: IndexTarget;
      delayMs?: number;
    }
  | {
      kind: "swipe";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      durationMs?: number;
      momentum?: boolean;
      delayMs?: number;
    }
  | { kind: "key"; key: string; delayMs?: number }
  | { kind: "wait"; waitMs: number; delayMs?: number };

/** One per-step result from {@link openServerSequence}. */
export interface SequenceStepResult {
  kind: string;
  success: boolean;
  dropped?: boolean;
  skipped?: boolean;
  ms?: number;
  error?: string;
}

/** The whole burst result: per-step rows plus the end-to-end wall time. */
export interface SequenceResult {
  completed: number;
  total: number;
  totalMs: number;
  steps: SequenceStepResult[];
}

/** RPC budget floor before per-step delays are added (§A burst). */
const SEQ_BASE_BUDGET_MS = 15_000;

/**
 * Build the device-pixel `batch` payload for a burst (ticket A2 §A) and the RPC
 * budget. Pure over `(steps, size, resolveTarget)` — the target resolver is
 * injected so this is device-free and unit-testable; the live path passes a
 * closure over the pre-burst read (which refuses a stale index before any action
 * is built). `wait` steps become the `wait` pseudo-method whose `delayMs` is the
 * pause; every tap/swipe threads the shipped inject strategy, matching a single
 * `gesture-tap` / `gesture-swipe`.
 */
export function buildSequenceActions(
  steps: SequenceStep[],
  size: { width: number; height: number },
  resolveTarget: (target: IndexTarget) => { x: number; y: number }
): { actions: OpenServerBatchAction[]; budgetMs: number } {
  // A2-M5: every index target resolves against the ONE pre-burst snapshot, so a
  // second index target (after an earlier step navigated) would tap stale
  // coordinates. Allow at most ONE index target per burst; refuse the rest before
  // anything is injected. Coordinate taps after the index target are fine.
  if (steps.filter((s) => s.kind === "tap" && s.target !== undefined).length > 1) {
    throw new IndexTargetError(
      "stale_index_in_burst",
      "stale_index_in_burst: at most one index `target` per gesture-sequence burst — every index resolves against the pre-burst snapshot, so a later index target would tap stale coordinates. Use it as the first acting step, or split the burst."
    );
  }
  const actions: OpenServerBatchAction[] = [];
  let budgetMs = SEQ_BASE_BUDGET_MS;
  for (const step of steps) {
    const delayMs = step.delayMs;
    if (delayMs && delayMs > 0) budgetMs += delayMs;
    if (step.kind === "tap") {
      const px =
        step.target !== undefined
          ? resolveTarget(step.target)
          : toPixels(size, step.x ?? 0.5, step.y ?? 0.5);
      const clickCount = step.clickCount ?? 1;
      actions.push({
        method: "tap",
        params: {
          x: px.x,
          y: px.y,
          ...(clickCount > 1 ? { clickCount, gapMs: MULTI_TAP_GAP_MS } : {}),
          holdMs: TAP_HOLD_MS,
          ...injectOpt(),
        },
        ...(delayMs !== undefined ? { delayMs } : {}),
      });
    } else if (step.kind === "swipe") {
      const from = toPixels(size, step.fromX, step.fromY);
      const to = toPixels(size, step.toX, step.toY);
      const duration = step.durationMs ?? SEQ_DEFAULT_SWIPE_DURATION_MS;
      const swipeSteps = Math.max(1, Math.round(duration / 16));
      const momentumFree = step.momentum === false;
      actions.push({
        method: "swipe",
        params: {
          startX: from.x,
          startY: from.y,
          endX: to.x,
          endY: to.y,
          steps: swipeSteps,
          ...(momentumFree ? { holdEndMs: SEQ_MOMENTUM_FREE_HOLD_MS } : {}),
          ...injectOpt(),
        },
        ...(delayMs !== undefined ? { delayMs } : {}),
      });
    } else if (step.kind === "key") {
      actions.push({
        method: "key",
        params: { key: step.key },
        ...(delayMs !== undefined ? { delayMs } : {}),
      });
    } else {
      // wait: a pure on-device pause; its duration rides `delayMs` (see the Kotlin
      // executeBatch `wait` branch).
      budgetMs += step.waitMs;
      actions.push({ method: "wait", delayMs: step.waitMs });
    }
  }
  return { actions, budgetMs };
}

/**
 * Map the device's per-step batch results back to {@link SequenceStepResult} rows
 * (pure). A `{skipped:true}` device row → `success:false, skipped:true`; an
 * `error` row → `success:false` + the error string; otherwise `success` follows
 * the device `success` (a bare success-less reply, e.g. from a method that only
 * echoes, counts as success) and `dropped`/`ms` ride through.
 */
export function mapSequenceResults(
  steps: SequenceStep[],
  results: OpenServerBatchStepResult[],
  totalMs: number
): SequenceResult {
  const stepResults: SequenceStepResult[] = steps.map((step, i) => {
    const r = results[i];
    if (!r) return { kind: step.kind, success: false, error: "no result for step" };
    if (r.skipped) return { kind: step.kind, success: false, skipped: true };
    const out: SequenceStepResult = {
      kind: step.kind,
      success: r.success === true || (r.error === undefined && r.success === undefined),
      ...(r.dropped ? { dropped: true } : {}),
      ...(typeof r.ms === "number" ? { ms: r.ms } : {}),
    };
    if (r.error !== undefined) {
      out.success = false;
      out.error = typeof r.error === "string" ? r.error : JSON.stringify(r.error);
    }
    return out;
  });
  return {
    completed: stepResults.filter((s) => s.success).length,
    total: steps.length,
    totalMs,
    steps: stepResults,
  };
}

/**
 * Run a `gesture-sequence` burst (ticket A2 §A) on the open server in ONE `batch`
 * RPC: convert every normalized step to device pixels (and resolve any index
 * `target` against a single pre-burst read — refusing a stale index before
 * injecting anything), send them, and map the device's per-step
 * `{ success, dropped?, ms, skipped? }` back. The `delayMs` on each step pauses
 * ON-DEVICE, so the dismiss→revealed-tap beat costs no host round trip.
 *
 * Throws {@link IndexTargetError} when an index `target` is stale/out-of-range
 * (nothing is injected in that case); any RPC failure throws so the tool can
 * report it.
 */
export function openServerSequence(
  registry: Registry,
  device: DeviceInfo,
  steps: SequenceStep[]
): Promise<SequenceResult> {
  const needsState = steps.some((s) => s.kind === "tap" && s.target !== undefined);
  return withServer(registry, device, async (server, size) => {
    // Resolve index targets against ONE pre-burst read (tree + live version): the
    // burst acts on the screen the index tier was read from, so a stale index is
    // refused here, before any injection.
    let liveTree: OpenServerElement[] | undefined;
    let liveVersion: number | undefined;
    if (needsState) {
      const state = await server.getState({ includeScreenshot: false, fingerprints: true });
      liveTree = state.tree;
      liveVersion = state.version;
    }
    const { actions, budgetMs } = buildSequenceActions(steps, size, (target) =>
      resolveIndexTarget(liveTree ?? [], liveVersion, target)
    );

    const start = Date.now();
    const { results } = await server.batch(actions, budgetMs);
    const totalMs = Date.now() - start;
    return mapSequenceResults(steps, results, totalMs);
  });
}
