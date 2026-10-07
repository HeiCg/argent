import { performance } from "node:perf_hooks";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { Registry, ToolDependency } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../contract";
import { adbExecOutBinary, isAndroidTv } from "../../../../utils/adb";
import { resolveDevice } from "../../../../utils/device-info";
import {
  getAndroidScreenSize,
  orientScreenSize,
  parseDumpRotation,
} from "../../../../utils/android-screen";
import { isFlagEnabled } from "@argent/configuration-core";
import { parseUiAutomatorDump } from "./uiautomator-parser";
import {
  androidDevtoolsRef,
  type AndroidDevtoolsApi,
} from "../../../../blueprints/android-devtools";
import {
  openDeviceServerRef,
  type OpenDeviceServerApi,
} from "../../../../blueprints/android-open-server";
import { openServerNestedToDescribeNode, nestedTreeTruncated } from "./open-server-tree";
import { openDeviceServerMutex } from "../../../../utils/device-mutex";
import {
  getIncident,
  incidentHeaderLine,
  type OpenServerIncident,
} from "../../../../utils/open-server-incident";

// Appended to the describe hint when the on-device tree was truncated (F13).
const TRUNCATION_HINT =
  "Note: the accessibility tree was truncated at the server's element cap, so some " +
  "elements may be missing — narrow the screen or scroll to see the rest.";

// Appended to the describe hint when the open server returned no tree.
const EMPTY_TREE_HINT =
  "The device reported no accessibility tree: no window was active when it was read " +
  "(an app starting, closing or crashing). This is not evidence that the screen is " +
  "empty. Run `describe` again or take a `screenshot`.";

// Appended to the describe hint when the open server returned a window root but
// nothing survived the trim on every read (ABBA run 37609765062: a read right
// after a navigating tap lands mid-transition).
const EMPTY_ROOT_HINT =
  "The device reported a root with no elements; the screen may be mid-transition — " +
  "call `describe` again or use `await-screen-idle`.";

// Re-reads of an immediate open-path read whose root has no elements, and the
// pause before each. In run 37609765062 the next read (265-433 ms later) was
// the destination in 26/26 cases.
const EMPTY_ROOT_RETRIES = 2;
const EMPTY_ROOT_RETRY_STEP_MS = 50;

// Open-path describes that returned an empty tree in this process. Read by the
// bench; each one is also logged at console.warn.
let emptyTreeCount = 0;
export function openServerEmptyTreeCount(): number {
  return emptyTreeCount;
}

// Extra immediate reads the open path made because a read had a root but no
// elements after the trim. Exposed for the bench/telemetry; not read yet.
let emptyRootRetryCount = 0;
export function openServerEmptyRootRetryCount(): number {
  return emptyRootRetryCount;
}

export const androidRequires: ToolDependency[] = ["adb"];

// The open describe's idle policy, mapped to the open server's `getNestedState`
// idle-gate cap (`waitTimeoutMs`). Default/`false` = an immediate read
// (`waitTimeoutMs: 0`), matching the proprietary `android-devtools` `getHierarchy`,
// which reads the tree with no quiescence wait — so the two describe backends
// differ in policy, not speed. `true` = `uiDevice.waitForIdle(500)` on the device:
// it waits for UiAutomator idle up to 500 ms (fixed cap; it does not confirm a
// quiet screen), and a number is a custom cap in ms.
const SETTLE_QUIESCENCE_MS = 500;
export function settleToWaitTimeoutMs(settle: boolean | number | undefined): number {
  if (settle === true) return SETTLE_QUIESCENCE_MS;
  if (typeof settle === "number" && Number.isFinite(settle) && settle > 0) {
    return Math.floor(settle);
  }
  return 0;
}

// Android TV keeps a readable uiautomator tree (unlike tvOS, which describe
// short-circuits), so point at the focus-driven tools instead of blocking it.
const ANDROID_TV_HINT =
  "This is an Android TV (leanback) device — it is focus-driven and has no touch. " +
  "Prefer the `describe` tool to read the focused / focusable elements, `tv-remote` " +
  "(up/down/left/right/select/back/menu/home) to move focus, and `keyboard` to type, " +
  "rather than coordinate taps.";

/**
 * Tries the `android-devtools` helper, falling back to `uiautomator dump` on any
 * error: the legacy path fails independently (APK install rejection, helper
 * spawn failure, adb-forward conflict) and still works on locked-down devices
 * that block `adb install -t`.
 */
export async function describeAndroid(
  registry: Registry | undefined,
  serial: string,
  _bundleId?: string,
  // Verdict from a caller that already probed: `getAndroidRuntimeKind` shells out
  // to `adb devices` even on a cache hit and `describe` is an alwaysLoad hot
  // path. `undefined` means "unknown, probe".
  isTv?: boolean,
  // Idle policy for the open path (ignored by the android-devtools / dump paths,
  // which always read immediately). Absent/`false` = immediate read (matches the
  // proprietary getHierarchy); `true` = wait for UiAutomator idle up to 500 ms
  // (fixed cap; it does not confirm a quiet screen); a number = custom cap.
  settle?: boolean | number
): Promise<DescribeTreeData> {
  const hint = (isTv ?? (await isAndroidTv(serial))) ? ANDROID_TV_HINT : undefined;
  // Set when the open path failed and a later backend serves the call.
  let fallback: { backend: "proprietary-fallback"; fallbackReason: string } | undefined;

  // Preferred source when the `open-device-server` flag is on and the open-source
  // on-device server is reachable: it reads the accessibility tree directly from
  // UiAutomation (no `uiautomator dump` round-trip), fixing the ~40% busy-UI dump
  // flakiness. By default it reads immediately, with no idle wait; only `settle`
  // waits for UiAutomator idle, up to a fixed cap. A root with no elements is
  // re-read (see below). An empty tree (no active window) is
  // returned as-is (`treeEmpty`). Any failure falls through to the android-devtools
  // helper, then the raw dump, and the result carries `backend:
  // "proprietary-fallback"`. While this server runs, the dump cannot connect to
  // UiAutomation, so only android-devtools can serve that fallback.
  if (registry && isFlagEnabled("open-device-server")) {
    try {
      const device = resolveDevice(serial);
      const ref = openDeviceServerRef(device);
      const readOnce = () =>
        openDeviceServerMutex.withDeviceLock(serial, async () => {
          const server = await registry.resolveService<OpenDeviceServerApi>(ref.urn, ref.options);
          // ONE round-trip: waitForIdle + the full nested multi-window tree + info,
          // the same call the await-* poll loops use (`utils/open-server-describe.ts`).
          // The previous `Promise.all([getNestedAccessibilityTree, getInfo])` never
          // overlapped — the RPC client serialises every request on one connection
          // (see `android-open-server-client.ts`) — so it was two sequential
          // round-trips AND a second implicit idle gate inside `getInfo`. `getInfo`
          // is also gone from the hot path, so its rotation/package reads no longer
          // trigger `waitForIdle`.
          //
          // Idle policy (phase 3d): default `waitTimeoutMs: 0` = an immediate read,
          // matching the proprietary `android-devtools` `getHierarchy`, which reads
          // the tree with no quiescence wait — so the two backends are like-for-like
          // in *policy*, not just speed. Under `settle` the describe first waits for
          // UiAutomator idle up to 500 ms (or a custom cap) — a fixed cap, it does
          // not confirm a quiet screen (run 37609765062: 50/51 reads hit the
          // cap). `uiDevice.waitForIdle(0)` returns
          // immediately (a 0 window short-circuits the idle loop — measured
          // waitedMs=0), so waitTimeoutMs:0 needs no server change. The await-* paths
          // keep their own (default) timeout — this is describe-only.
          const waitTimeoutMs = settleToWaitTimeoutMs(settle);
          // Phase 3j: compact:true would drop the trim-discarded nodes ON THE DEVICE for
          // a smaller wire payload — BUT the on-device compaction hoists scaffold
          // wrappers, which is NOT output-preserving (it defeats a scrollable parent's
          // child-clip, lets a system-chrome subtree escape, and can drop a borrowed
          // `[password]` label — reviewed counterexamples). Until the device compaction
          // is made output-preserving (hollow nodes + goldens), the describe path ships
          // the FULL tree and runs the proven host v2 trim, which is byte-identical to
          // the dump path. compact stays available for the bench A/B via explicit opt-in.
          const state = await server.getNestedState({ waitTimeoutMs, compact: false });
          // An empty tree is the device's answer, not an open-path failure: the
          // server already re-read the active root for up to ~500 ms (versionCode
          // 27+) before reporting it. Falling back here (bench run 37561512651)
          // reached `uiautomator dump`, which cannot connect while this server
          // holds UiAutomation, so the call errored instead. It is returned below
          // with a `treeEmpty` marker.
          const emptyReason =
            state.tree.length === 0 ? (state.treeEmptyReason ?? "empty_tree") : undefined;
          // Run the SAME v2 interactables-only trim the android-devtools XML path
          // runs, so the compact describe (dropped layout containers, concatenated
          // row labels, package-qualified ids) matches the proprietary token count
          // and label set. `tree` is one nested root per window (active + IME +
          // dialogs), the multi-window shape the dump path also captures. The
          // server's info geometry is rotation-aware (read straight from the
          // Display) and matches getBoundsInScreen's pixel space, so no rotation
          // correction.
          // Time the host tree-lowering + v2 trim (phase 3i): the JSON.parse cost is
          // already captured on the wire as `hostParseMs`; this is the CPU spent
          // turning the parsed nested tree into the rendered DescribeNode.
          const renderT0 = performance.now();
          const node = openServerNestedToDescribeNode(
            state.tree,
            state.info.screenWidth,
            state.info.screenHeight
          );
          const hostRenderMs = performance.now() - renderT0;
          return {
            node,
            emptyReason,
            truncated: nestedTreeTruncated(state.tree),
            waitedMs: state.waitedMs,
            captureMs: state.captureMs,
            timings: state.timings,
            wireBytes: state.wireBytes,
            hostParseMs: state.hostParseMs,
            hostRenderMs,
            hostSentToFirstByteMs: state.hostSentToFirstByteMs,
            hostFirstToLastByteMs: state.hostFirstToLastByteMs,
            hostRoundTripMs: state.hostRoundTripMs,
            transport: state.transport,
          };
        });
      // Same cold-WebView wait as the android-devtools and uiautomator paths
      // below (upstream #1052): without it a describe right after a WebView opens
      // returns the empty WebView node. The device lock is released between reads.
      // A tree without a WebView returns after the first read, with no delay.
      const firstReadAt = Date.now();
      let result = await readOnce();
      let lastReadAt = firstReadAt;
      // An immediate read right after a navigating tap can land between the
      // destination's first frame and the end of the transition: the window root
      // is there but nothing survives the trim, and the server's `treeEmpty`
      // (no active window) does not fire (run 37609765062: 35-45 % of the
      // samples). Re-read it up to EMPTY_ROOT_RETRIES times and return the first
      // read with elements. Only the immediate read: `settle` keeps one read.
      const immediateRead = settleToWaitTimeoutMs(settle) === 0;
      const isEmptyRoot = (r: typeof result) =>
        r.emptyReason === undefined && r.node.children.length === 0;
      let emptyRootRetries = 0;
      while (immediateRead && isEmptyRoot(result) && emptyRootRetries < EMPTY_ROOT_RETRIES) {
        await new Promise((r) => setTimeout(r, EMPTY_ROOT_RETRY_STEP_MS));
        emptyRootRetries += 1;
        lastReadAt = Date.now();
        result = await readOnce();
      }
      emptyRootRetryCount += emptyRootRetries;
      const emptyRoot = immediateRead && isEmptyRoot(result);
      if (emptyRoot) {
        console.warn(
          `[describe.android] open-device-server returned a root with no elements on ` +
            `${emptyRootRetries + 1} reads; returning it with a hint, no other backend`
        );
      }
      await awaitWebViewPublished(result.node, async () => {
        lastReadAt = Date.now();
        result = await readOnce();
        return result.node;
      });
      // Count the wait: the discarded reads (empty-root re-reads, cold-WebView
      // re-reads) and the sleeps between them land in `waitedMs`, so waitedMs +
      // captureMs still accounts for the device time. The other stage timings
      // are the returned (last) read's own.
      const rereadWaitMs = lastReadAt - firstReadAt;
      if (result.emptyReason !== undefined) {
        emptyTreeCount += 1;
        const attempts = result.timings?.rootAttempts;
        const retryMs = result.timings?.rootRetryMs;
        console.warn(
          `[describe.android] open-device-server returned an empty accessibility tree ` +
            `(reason=${result.emptyReason}` +
            (attempts !== undefined ? `, rootAttempts=${attempts}, rootRetryMs=${retryMs}` : "") +
            `); returning it with treeEmpty, no other backend`
        );
      }
      // Surface the runaway-guard hit as a hint (F13), alongside any TV hint, and
      // say why the tree is empty when it is.
      const openHint =
        [
          hint,
          result.truncated ? TRUNCATION_HINT : undefined,
          result.emptyReason !== undefined ? EMPTY_TREE_HINT : undefined,
          emptyRoot ? EMPTY_ROOT_HINT : undefined,
        ]
          .filter(Boolean)
          .join(" ") || undefined;
      // Ticket A1 (part B): prepend the execution-incident line while one is
      // active on this device (a prior verify refusal / no-effect / timeout), so
      // the agent sees the failure IN CONTEXT on its next read. Host state only —
      // no RPC, nothing device-side.
      const incident: OpenServerIncident | undefined = getIncident(serial);
      const incidentLine = incident ? incidentHeaderLine(incident) : undefined;
      // waitedMs/captureMs ride the result metadata (never the rendered text) so
      // the idle-gate-vs-serialization split of describe is measurable.
      return {
        tree: result.node,
        source: "open-device-server",
        hint: openHint,
        ...(incidentLine !== undefined ? { incidentLine } : {}),
        waitedMs: result.waitedMs + rereadWaitMs,
        captureMs: result.captureMs,
        ...(result.timings ? { timings: result.timings } : {}),
        ...(result.wireBytes !== undefined ? { wireBytes: result.wireBytes } : {}),
        ...(result.hostParseMs !== undefined ? { hostParseMs: result.hostParseMs } : {}),
        ...(result.hostRenderMs !== undefined ? { hostRenderMs: result.hostRenderMs } : {}),
        ...(result.hostSentToFirstByteMs !== undefined
          ? { hostSentToFirstByteMs: result.hostSentToFirstByteMs }
          : {}),
        ...(result.hostFirstToLastByteMs !== undefined
          ? { hostFirstToLastByteMs: result.hostFirstToLastByteMs }
          : {}),
        ...(result.hostRoundTripMs !== undefined
          ? { hostRoundTripMs: result.hostRoundTripMs }
          : {}),
        ...(result.transport !== undefined ? { transport: result.transport } : {}),
        ...(result.emptyReason !== undefined
          ? { treeEmpty: true as const, treeEmptyReason: result.emptyReason }
          : {}),
      };
    } catch (serverErr) {
      // Any other open-path failure (server unreachable, RPC error) still falls
      // back, and the result says so (same marker as the open iOS path).
      const reason = serverErr instanceof Error ? serverErr.message : String(serverErr);
      console.warn(`[describe.android] open-device-server failed, falling back: ${reason}`);
      fallback = { backend: "proprietary-fallback", fallbackReason: reason };
    }
  }

  if (registry) {
    try {
      const device = resolveDevice(serial);
      const ref = androidDevtoolsRef(device);
      const devtools = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
      const [{ xml }, size] = await Promise.all([
        devtools.getHierarchy(),
        devtools.getScreenSize(),
      ]);
      const tree = await awaitWebViewPublished(
        parseUiAutomatorDump(xml, size.width, size.height),
        async () =>
          parseUiAutomatorDump((await devtools.getHierarchy()).xml, size.width, size.height)
      );
      return { tree, source: "android-devtools", hint, ...fallback };
    } catch (serviceErr) {
      // Debug level: the legacy path below is expected to recover, so this
      // shouldn't leak into the per-call result.

      console.debug(
        `[describe.android] devtools service failed, falling back to uiautomator dump: ${
          serviceErr instanceof Error ? serviceErr.message : String(serviceErr)
        }`
      );
    }
  }

  const [size, raw] = await Promise.all([getAndroidScreenSize(serial), uiautomatorDump(serial)]);
  const tree = await awaitWebViewPublished(parseDump(raw, size), async () =>
    parseDump(await uiautomatorDump(serial), size)
  );
  return { tree, source: "uiautomator", hint, ...fallback };
}

/**
 * Chromium builds a WebView's accessibility tree on the first request for it,
 * so the read that asks sees the WebView with nothing under it. Re-read until
 * the page is there, within a bound: a small page is complete on the next read
 * (measured 10–400 ms on API 35 / WebView 124), a Chrome tab over a long
 * article needs ~600 ms. A screen without a WebView returns at once; a WebView
 * that never publishes costs at most the bound.
 */
const WEBVIEW_PUBLISH_STEP_MS = 250;
const WEBVIEW_PUBLISH_BUDGET_MS = 1_500;

async function awaitWebViewPublished(
  first: DescribeNode,
  read: () => Promise<DescribeNode>
): Promise<DescribeNode> {
  let tree = first;
  for (let waited = 0; waited < WEBVIEW_PUBLISH_BUDGET_MS && hasUnreadWebView(tree); ) {
    await new Promise((r) => setTimeout(r, WEBVIEW_PUBLISH_STEP_MS));
    waited += WEBVIEW_PUBLISH_STEP_MS;
    tree = await read();
  }
  return tree;
}

async function uiautomatorDump(serial: string): Promise<string> {
  // Per-call dump path so concurrent describes on the same serial don't cat each
  // other's half-written dump.
  const randomSuffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const dumpPath = `/data/local/tmp/argent-ui-dump-${randomSuffix}.xml`;
  // `--compressed` skips nodes `isImportantForAccessibility()` drops (decorative
  // wrappers, RN SVG sub-paths, bounds-less Compose containers) while keeping the
  // text, content-desc, clickable and resource-id the agent contract uses.
  // `;` rather than `&&` before `rm -f` so cleanup fires even when dump/cat fails.
  const rawBuf = await adbExecOutBinary(
    serial,
    `uiautomator dump --compressed ${dumpPath} >/dev/null && cat ${dumpPath}; rm -f ${dumpPath}`,
    { timeoutMs: 20_000 }
  );
  const raw = rawBuf.toString("utf-8");
  const trimmed = raw.trim();
  if (/^ERROR:/i.test(trimmed) || (!trimmed.includes("<hierarchy") && /error/i.test(trimmed))) {
    throw new FailureError(
      `uiautomator could not capture the screen: ${trimmed}. ` +
        `Common causes: device locked / keyguard, DRM or secure overlay, Play Integrity screen. ` +
        `Unlock the device or take a screenshot as a fallback.`,
      {
        // adb exits 0, but uiautomator reported an in-band `ERROR:` line — same
        // adb-exit-0/unusable-output shape as ANDROID_UIAUTOMATOR_PARSE_FAILED.
        error_code: FAILURE_CODES.ANDROID_UIAUTOMATOR_CAPTURE_FAILED,
        failure_stage: "android_uiautomator_capture",
        failure_area: "tool_server",
        error_kind: "subprocess",
      }
    );
  }
  return raw;
}

function parseDump(raw: string, size: { width: number; height: number }): DescribeNode {
  // `wm size` is not rotation-aware, but the dump says which rotation it was
  // taken at. Orienting the divisor here is what keeps a rotated device's frames
  // in the same upright space the android-devtools path already produces — and
  // stops the right-hand half of a landscape screen being pruned away as
  // off-screen (#609).
  const oriented = orientScreenSize(size, parseDumpRotation(raw));
  return parseUiAutomatorDump(raw, oriented.width, oriented.height);
}

/**
 * The shape a WebView has before Chromium publishes its page: the WebView
 * node with nothing under it (a read 6 s after load, with no earlier read, is
 * still this shape — the tree is built on request, not on load).
 *
 * A browser tab has no `android.webkit.WebView` view of its own: before the
 * page is published, Chrome's content view is a childless FrameLayout whose
 * content-desc is "Web View" (English UI only — other locales miss the
 * re-read and see the tab the way they do today).
 */
export function hasUnreadWebView(node: DescribeNode): boolean {
  if (node.children.length === 0 && (node.role === "WebView" || node.label === "Web View")) {
    return true;
  }
  return node.children.some(hasUnreadWebView);
}
