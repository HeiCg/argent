import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { Registry, ToolDependency } from "@argent/registry";
import type { DescribeTreeData } from "../../contract";
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

// Appended to the describe hint when the on-device tree was truncated (F13).
const TRUNCATION_HINT =
  "Note: the accessibility tree was truncated at the server's element cap, so some " +
  "elements may be missing — narrow the screen or scroll to see the rest.";

export const androidRequires: ToolDependency[] = ["adb"];

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
  isTv?: boolean
): Promise<DescribeTreeData> {
  const hint = (isTv ?? (await isAndroidTv(serial))) ? ANDROID_TV_HINT : undefined;

  // Preferred source when the `open-device-server` flag is on and the open-source
  // on-device server is reachable: it reads the accessibility tree directly from
  // UiAutomation (no `uiautomator dump` round-trip, and it settles with
  // waitForIdle first), fixing the ~40% busy-UI dump flakiness. Any failure falls
  // through to the android-devtools helper, then the raw dump — same one-way
  // recovery the two legacy sources already have.
  if (registry && isFlagEnabled("open-device-server")) {
    try {
      const device = resolveDevice(serial);
      const ref = openDeviceServerRef(device);
      const result = await openDeviceServerMutex.withDeviceLock(serial, async () => {
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
        // `waitTimeoutMs: 500` matches the proprietary comparator's idle cap: the
        // describe path used to wait up to 2000 ms, which on a busy screen let the
        // in-flight navigation's `waitForIdle` dominate the verb (measured: 690 of
        // 839 ms on tap+describe). The await-* paths keep their own (default)
        // timeout — this cap change is describe-only.
        const state = await server.getNestedState({ waitTimeoutMs: 500 });
        if (state.tree.length === 0) {
          throw new FailureError("open-device-server returned an empty accessibility tree", {
            error_code: FAILURE_CODES.ANDROID_UIAUTOMATOR_CAPTURE_FAILED,
            failure_stage: "android_open_device_server_tree",
            failure_area: "tool_server",
            error_kind: "subprocess",
          });
        }
        // Run the SAME v2 interactables-only trim the android-devtools XML path
        // runs, so the compact describe (dropped layout containers, concatenated
        // row labels, package-qualified ids) matches the proprietary token count
        // and label set. `tree` is one nested root per window (active + IME +
        // dialogs), the multi-window shape the dump path also captures. The
        // server's info geometry is rotation-aware (read straight from the
        // Display) and matches getBoundsInScreen's pixel space, so no rotation
        // correction.
        const node = openServerNestedToDescribeNode(
          state.tree,
          state.info.screenWidth,
          state.info.screenHeight
        );
        return {
          node,
          truncated: nestedTreeTruncated(state.tree),
          waitedMs: state.waitedMs,
          captureMs: state.captureMs,
        };
      });
      // Surface the runaway-guard hit as a hint (F13), alongside any TV hint.
      const openHint = result.truncated
        ? [hint, TRUNCATION_HINT].filter(Boolean).join(" ")
        : hint;
      // waitedMs/captureMs ride the result metadata (never the rendered text) so
      // the idle-gate-vs-serialization split of describe is measurable.
      return {
        tree: result.node,
        source: "open-device-server",
        hint: openHint,
        waitedMs: result.waitedMs,
        captureMs: result.captureMs,
      };
    } catch (serverErr) {
      console.debug(
        `[describe.android] open-device-server failed, falling back: ${
          serverErr instanceof Error ? serverErr.message : String(serverErr)
        }`
      );
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
      const tree = parseUiAutomatorDump(xml, size.width, size.height);
      return { tree, source: "android-devtools", hint };
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

  // Per-call dump path so concurrent describes on the same serial don't cat each
  // other's half-written dump.
  const randomSuffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const dumpPath = `/data/local/tmp/argent-ui-dump-${randomSuffix}.xml`;
  // `--compressed` skips nodes `isImportantForAccessibility()` drops (decorative
  // wrappers, RN SVG sub-paths, bounds-less Compose containers) while keeping the
  // text, content-desc, clickable and resource-id the agent contract uses.
  // `;` rather than `&&` before `rm -f` so cleanup fires even when dump/cat fails.
  const [size, rawBuf] = await Promise.all([
    getAndroidScreenSize(serial),
    adbExecOutBinary(
      serial,
      `uiautomator dump --compressed ${dumpPath} >/dev/null && cat ${dumpPath}; rm -f ${dumpPath}`,
      { timeoutMs: 20_000 }
    ),
  ]);
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
  // `wm size` is not rotation-aware, but the dump says which rotation it was
  // taken at. Orienting the divisor here is what keeps a rotated device's frames
  // in the same upright space the android-devtools path already produces — and
  // stops the right-hand half of a landscape screen being pruned away as
  // off-screen (#609).
  const oriented = orientScreenSize(size, parseDumpRotation(raw));
  const tree = parseUiAutomatorDump(raw, oriented.width, oriented.height);
  return { tree, source: "uiautomator", hint };
}
