import { spawn, ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import {
  TypedEventEmitter,
  FAILURE_CODES,
  FailureError,
  subprocessFailureMetadata,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
} from "@argent/registry";
import { serverManifest } from "@argent/android-device-server";
import { isFlagEnabled } from "@argent/configuration-core";
import { runAdb } from "../utils/adb";
import type { ScrcpyInjectBackend } from "../utils/scrcpy-inject-backend";
import { resolveAndroidBinary } from "../utils/android-binary";
import { ensureOpenDeviceServerInstalled } from "../utils/android-helper-install";
import { AndroidOpenServerClient } from "../utils/android-open-server-client";
import { invalidateScreenSize } from "../utils/open-server-screen-cache";
import { invalidateClipboardSupport } from "../utils/open-server-clipboard-cache";
import type {
  OpenServerElement,
  OpenServerNestedElement,
} from "../tools/describe/platforms/android/open-server-tree";

const OPEN_DEVICE_SERVER_NAMESPACE = "OpenDeviceServer";

/**
 * Backend for tap/swipe/gesture touch injection (phase 3f):
 * - `'off'`   — inject via the Kotlin `android-device-server` (UiAutomation).
 * - `'scrcpy'`— inject over the scrcpy control channel, skipping the
 *   instrumentation hop; describe/state/screenshot/etc. stay on the Kotlin
 *   channel. Gated by the `open-device-server-fast-inject` flag when the option
 *   is omitted.
 */
export type FastInjectBackend = "off" | "scrcpy";

type OpenDeviceServerFactoryOptions = Record<string, unknown> & {
  device: DeviceInfo;
  fastInject?: FastInjectBackend;
};

export function openDeviceServerRef(device: DeviceInfo): {
  urn: string;
  options: OpenDeviceServerFactoryOptions;
} {
  return {
    urn: `${OPEN_DEVICE_SERVER_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

export interface OpenServerInfo {
  screenWidth: number;
  screenHeight: number;
  currentPackage: string;
  currentActivity?: string;
  keyboardVisible: boolean;
  displayRotation: number;
  /**
   * Phase 3f: count of fast-inject (scrcpy) actions this session that failed and
   * fell back to the Kotlin UiAutomation channel. Absent (undefined) when
   * fast-inject is off; a healthy fast-inject session keeps this at 0. Surfaced
   * here so a caller (and the bench) can assert zero silent degrades.
   */
  fastInjectFallbacks?: number;
}

export interface OpenServerTreeResult {
  tree: OpenServerElement[];
}

export interface OpenServerScreenshot {
  /** Base64-encoded image bytes (no data-URI prefix). */
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Per-stage split of one describe/state capture (phase 3g). `waitedMs`/`captureMs`
 * give the idle-vs-capture halves; this breaks the capture half down further so a
 * bench can attribute the after-tap residual to a concrete binder call rather than
 * guessing from logcat: `rootMs` is the active-root read (from the windows
 * snapshot, or the `rootInActiveWindow` fallback — see `rootSource`), `windowsMs`
 * the `uiAutomation.windows` enumeration, `rootsMs` each kept window's `w.root`,
 * `serializeMs` the node walk, `encodeMs` the JSON encode. `idleMs` mirrors
 * `waitedMs`. Metadata only — never rendered.
 */
export interface OpenServerTimings {
  idleMs: number;
  rootMs: number;
  windowsMs: number;
  rootsMs: number[];
  serializeMs: number;
  encodeMs: number;
  // Which path produced the active root (phase 3g-b): "windows" = read from the
  // interactive-windows snapshot (fast, coherent mid-transition), "activeWindow" =
  // `rootInActiveWindow` fallback. Absent on servers before versionCode 22.
  rootSource?: "windows" | "activeWindow";
  // Server-side request timeline of the PREVIOUS same-method request (phase 3i),
  // piggybacked because a response cannot carry the cost of writing itself. All ms:
  // `prevServerHandleMs` = handler entry → response string ready (capture + JSON
  // build); `prevServerWriteMs` = response write + flush to the socket (t4 − t3);
  // `prevServerTotalMs` = handler entry → flush done (t4 − t2). Absent on servers
  // before versionCode 23. In a describe loop the previous getState is the previous
  // describe/await-idle capture of the same screen, so these characterise it.
  prevServerHandleMs?: number;
  prevServerWriteMs?: number;
  prevServerTotalMs?: number;
}

/**
 * Combined `getState` capture: one round-trip for waitForIdle + tree + info
 * (+ an optional screenshot). `info` lacks `currentActivity` — the server's
 * StateHandler omits it — so callers that need the activity use `getInfo`.
 */
export interface OpenServerStateResult {
  tree: OpenServerElement[];
  info: OpenServerInfo;
  /** Base64 JPEG; empty string when `includeScreenshot` was false. */
  screenshot: string;
  waitedMs: number;
  captureMs: number;
  /** Per-stage capture split (phase 3g); absent on older servers. */
  timings?: OpenServerTimings;
  /** Host/transport timeline of this reply (phase 3i); see {@link getNestedState}. */
  wireBytes?: number;
  hostParseMs?: number;
  hostSentToFirstByteMs?: number;
  hostFirstToLastByteMs?: number;
  hostRoundTripMs?: number;
}

/** One pointer's path for a multi-pointer [OpenDeviceServerApi.gesture]. */
export interface GesturePointerPath {
  /** Stable pointer id; defaults to the array index server-side. */
  id?: number;
  /** Device-pixel samples; `tMs` is the offset from gesture start. */
  points: Array<{ x: number; y: number; tMs: number }>;
}

/**
 * The method surface of the open-source on-device server. Coordinates for
 * tap/longPress/swipe are device PIXELS (the server drives UiAutomator directly);
 * callers holding normalized 0–1 points convert against [getInfo].
 */
export interface OpenDeviceServerApi {
  isReady(): boolean;
  ping(): Promise<{ status: string }>;
  getInfo(): Promise<OpenServerInfo>;
  /**
   * Cheap screen geometry for the gesture hot path. The server reads real size
   * AND rotation from one platform `Display` snapshot (`DisplayReader`), never a
   * `UiDevice` getter: `UiDevice.getDisplayRotation()` / `getCurrentPackageName()`
   * call `UiAutomation.waitForIdle(500, 10_000)` internally, so peeking them
   * mid-gesture stalled this call until the animation settled (the pinch/tap
   * regression). Reading straight from the `Display` is genuinely ~1 ms even
   * mid-animation because it never touches the accessibility pipeline. The
   * tap/swipe/pinch tools use it to convert normalized coordinates to pixels.
   * Rule: never call a `UiDevice` getter that triggers `waitForIdle` on a hot
   * path.
   */
  getScreenSize(): Promise<{
    screenWidth: number;
    screenHeight: number;
    displayRotation: number;
  }>;
  getAccessibilityTree(opts?: {
    maxElements?: number;
    waitTimeoutMs?: number;
    /**
     * Phase 3f: when true the server runs one synchronous input-flush no-op inline
     * before capture (same slot as the tap async-UP drain), so a read that follows
     * a scrcpy fast-inject observes the settled, finger-up tree without a separate
     * `flushInput` round-trip. The blueprint sets it automatically when a
     * fast-inject is pending.
     */
    flush?: boolean;
  }): Promise<OpenServerTreeResult>;
  /**
   * Full, un-pruned accessibility tree as ONE nested node (with raw class names
   * and package-qualified ids). Backs the describe tool's compact path: the host
   * runs the same interactables-only trim the proprietary android-devtools XML
   * path runs, reaching the same token count / label set. `tree[0]` is the
   * window root; empty array if the server reports no active window.
   */
  getNestedAccessibilityTree(opts?: {
    maxElements?: number;
    waitTimeoutMs?: number;
    /** See {@link getAccessibilityTree} `flush`. */
    flush?: boolean;
  }): Promise<{ tree: OpenServerNestedElement[] }>;
  /**
   * Combined waitForIdle + FULL nested tree + info in ONE round-trip, for the
   * await-* poll loops. Unlike [getState] the tree is the same nested, un-pruned
   * multi-window shape [getNestedAccessibilityTree] returns, so the host runs the
   * identical v2 trim the describe tool runs and their label sets / id forms match
   * (F12). No screenshot (the poll loops never read it).
   */
  getNestedState(opts?: { maxElements?: number; waitTimeoutMs?: number; flush?: boolean }): Promise<{
    tree: OpenServerNestedElement[];
    info: OpenServerInfo;
    waitedMs: number;
    captureMs: number;
    /** Per-stage capture split (phase 3g); absent on older servers. */
    timings?: OpenServerTimings;
    /**
     * Host/transport cost of THIS reply (phase 3i), captured by the RPC client.
     * `wireBytes` is the UTF-8 byte length of the raw NDJSON reply line (the full
     * nested tree on the wire), `hostParseMs` the host `JSON.parse` cost, and the
     * `hostSentToFirstByteMs` / `hostFirstToLastByteMs` / `hostRoundTripMs` triple
     * is the host-clock timeline (TTFB, receive/streaming span, whole round-trip)
     * — the clean, per-request decomposition of the idle-describe residual.
     * Metadata only — never rendered.
     */
    wireBytes?: number;
    hostParseMs?: number;
    hostSentToFirstByteMs?: number;
    hostFirstToLastByteMs?: number;
    hostRoundTripMs?: number;
  }>;
  /**
   * Multi-tap (F1/F8/F9): the server builds the whole DOWN/UP timeline —
   * `clickCount` presses each held `holdMs`, spaced `gapMs` apart — so a
   * double-tap lands inside the OS double-tap window without the host firing N
   * separate `tap` RPCs. Defaults: clickCount 1, holdMs 50, gapMs 100.
   */
  tap(
    x: number,
    y: number,
    opts?: { clickCount?: number; holdMs?: number; gapMs?: number }
    // `dropped:true` (phase 3g) when the on-device dispatcher rejected an injected
    // event (no injectable window mid-transition, secure surface, contended input
    // pipe). The caller must treat it as a failed tap and fall back.
  ): Promise<{ success: boolean; dropped?: boolean }>;
  /**
   * Put `text` on the DEVICE clipboard via ClipboardManager (F20). Returns
   * `success:false` (not an error) when the write did not round-trip on-device
   * (some API levels drop a background app's clipboard write), so the paste tool
   * can fall back rather than paste nothing.
   */
  setClipboard(text: string): Promise<{ success: boolean; text: string; error?: string }>;
  longPress(x: number, y: number, durationMs?: number): Promise<{ success: boolean }>;
  swipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    steps?: number,
    // >0 holds the last pointer position that long before the lift, so the OS
    // reads ~0 release velocity and applies little to no fling (a momentum-free
    // swipe). Omit / 0 for the fast `uiDevice.swipe()` path whose lift flings.
    holdEndMs?: number
  ): Promise<{ success: boolean }>;
  /** Inject a synchronized multi-pointer gesture (pinch / rotate / custom). */
  gesture(pointers: GesturePointerPath[]): Promise<{ success: boolean }>;
  /**
   * Synchronously drain the on-device input dispatcher's touch queue (phase 3f).
   * Called after a fast-inject (scrcpy) tap/swipe/gesture so a following
   * `getNestedState`/describe on this channel observes the settled, finger-up
   * tree rather than the mid-press state — scrcpy injects from a separate process
   * this server's async-UP bookkeeping cannot see. A cheap no-op on its own.
   */
  flushInput(): Promise<{ success: boolean }>;
  typeText(text: string): Promise<{ success: boolean; charsTyped: number }>;
  key(key: string): Promise<{ success: boolean }>;
  waitForIdle(timeoutMs?: number): Promise<{ idle: boolean; waitedMs: number }>;
  launchApp(packageName: string): Promise<{ success: boolean; packageName: string }>;
  screenshot(opts?: {
    quality?: number;
    scale?: number;
    format?: "png" | "jpeg" | "webp";
  }): Promise<OpenServerScreenshot>;
  /**
   * Combined waitForIdle + tree + info in one round-trip. `includeScreenshot`
   * defaults false here (the poll loops that use this never read the frame);
   * pass true to also capture one.
   */
  getState(opts?: {
    maxElements?: number;
    waitTimeoutMs?: number;
    includeScreenshot?: boolean;
    quality?: number;
    scale?: number;
    flush?: boolean;
  }): Promise<OpenServerStateResult>;
}

const READY_TIMEOUT_MS = 30_000;
const HELPER_PORT_MARKER = /^INSTRUMENTATION_STATUS:\s*port=(\d+)/;
const ADB_FORWARD_PORT_MARKER = /^(\d+)\s*$/;

interface SpawnedServer {
  proc: ChildProcess;
  devicePort: number;
  localPort: number;
}

async function spawnServer(serial: string): Promise<SpawnedServer> {
  const manifest = serverManifest();
  const adbPath = await resolveAndroidBinary("adb");
  if (!adbPath) {
    throw new FailureError(
      "`adb` not found on PATH or under `$ANDROID_HOME/platform-tools` while spawning the open-device-server.",
      {
        error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_ADB_NOT_FOUND,
        failure_stage: "open_device_server_spawn",
        failure_area: "tool_server",
        error_kind: "dependency_missing",
      }
    );
  }

  const proc = spawn(
    adbPath,
    ["-s", serial, "shell", "am", "instrument", "-w", manifest.instrumentationRunner],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  return new Promise<SpawnedServer>((resolve, reject) => {
    let devicePort: number | null = null;
    let localPort: number | null = null;
    let settled = false;
    let stderrBuf = "";

    const settle = (fn: () => void, cleanup?: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      cleanup?.();
      fn();
    };

    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on("line", async (rawLine: string) => {
      const line = rawLine.trim();
      const portMatch = HELPER_PORT_MARKER.exec(line);
      if (!portMatch || devicePort !== null) return;
      devicePort = parseInt(portMatch[1]!, 10);

      // `tcp:0` makes adb pick a free local port and print it on stdout.
      try {
        const { stdout } = await runAdb(["-s", serial, "forward", "tcp:0", `tcp:${devicePort}`], {
          timeoutMs: 5_000,
        });
        const lpMatch = ADB_FORWARD_PORT_MARKER.exec(stdout.trim());
        if (!lpMatch) {
          throw new FailureError(`adb forward returned unexpected output: ${stdout.trim()}`, {
            error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_ADB_FORWARD_UNEXPECTED,
            failure_stage: "open_device_server_adb_forward",
            failure_area: "tool_server",
            error_kind: "subprocess",
          });
        }
        localPort = parseInt(lpMatch[1]!, 10);
        settle(() => resolve({ proc, devicePort: devicePort!, localPort: localPort! }));
      } catch (err) {
        settle(
          () => reject(err instanceof Error ? err : new Error(String(err))),
          () => proc.kill()
        );
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderrBuf += data.toString("utf-8");
      if (stderrBuf.length > 4 * 1024) stderrBuf = stderrBuf.slice(-4 * 1024);
    });

    proc.on("exit", (code, signal) => {
      const detail = stderrBuf.trim() ? ` stderr=${stderrBuf.trim().slice(0, 400)}` : "";
      settle(() =>
        reject(
          new FailureError(
            `am instrument exited before the open-device-server became ready (code=${code} signal=${signal}).${detail}`,
            {
              error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_EXITED_BEFORE_READY,
              failure_stage: "open_device_server_ready",
              failure_area: "tool_server",
              error_kind: "subprocess",
              ...(typeof code === "number" ? { failure_exit_code: code } : {}),
              ...(signal === "SIGABRT" ||
              signal === "SIGHUP" ||
              signal === "SIGINT" ||
              signal === "SIGKILL" ||
              signal === "SIGQUIT" ||
              signal === "SIGTERM"
                ? { failure_signal: signal }
                : {}),
            }
          )
        )
      );
    });

    proc.on("error", (err) => {
      settle(() =>
        reject(
          new FailureError(
            "open-device-server process error.",
            {
              error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_PROCESS_ERROR,
              failure_stage: "open_device_server_process",
              failure_area: "tool_server",
              error_kind: "subprocess",
              ...subprocessFailureMetadata(err, "android_devtools"),
            },
            { cause: err }
          )
        )
      );
    });

    const timer = setTimeout(() => {
      settle(
        () =>
          reject(
            new FailureError("Timed out waiting for the open-device-server to become ready", {
              error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_READY_TIMEOUT,
              failure_stage: "open_device_server_ready",
              failure_area: "tool_server",
              error_kind: "timeout",
              failure_signal: "SIGTERM",
            })
          ),
        () => proc.kill()
      );
    }, READY_TIMEOUT_MS);
  });
}

async function removeAdbForward(serial: string, localPort: number): Promise<void> {
  try {
    await runAdb(["-s", serial, "forward", "--remove", `tcp:${localPort}`], { timeoutMs: 5_000 });
  } catch {
    /* best-effort */
  }
}

export const androidOpenServerBlueprint: ServiceBlueprint<OpenDeviceServerApi, DeviceInfo> = {
  namespace: OPEN_DEVICE_SERVER_NAMESPACE,

  getURN(device: DeviceInfo) {
    return `${OPEN_DEVICE_SERVER_NAMESPACE}:${device.id}`;
  },

  async factory(_deps, _payload, options) {
    const opts = options as unknown as OpenDeviceServerFactoryOptions | undefined;
    if (!opts?.device) {
      throw new FailureError(
        `${OPEN_DEVICE_SERVER_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use openDeviceServerRef(device) when registering the service ref.`,
        {
          error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_FACTORY_OPTIONS_MISSING,
          failure_stage: "open_device_server_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    const { device } = opts;
    if (device.platform !== "android") {
      throw new FailureError(
        `${OPEN_DEVICE_SERVER_NAMESPACE} is Android-only. The target '${device.id}' classifies as iOS.`,
        {
          error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_WRONG_PLATFORM,
          failure_stage: "open_device_server_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    if (typeof device.id !== "string" || device.id.length === 0) {
      throw new FailureError(
        `${OPEN_DEVICE_SERVER_NAMESPACE}.factory requires a non-empty device.id; got ${JSON.stringify(device.id)}.`,
        {
          error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_DEVICE_ID_INVALID,
          failure_stage: "open_device_server_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    const serial = device.id;
    const events = new TypedEventEmitter<ServiceEvents>();

    await ensureOpenDeviceServerInstalled(serial);

    const spawned = await spawnServer(serial);
    let ready = false;
    let disposed = false;

    const client = new AndroidOpenServerClient("127.0.0.1", spawned.localPort);

    // A forwarded port doesn't prove the server answers; ping is the gate.
    try {
      await client.request("ping");
      ready = true;
    } catch (err) {
      client.close();
      try {
        spawned.proc.kill();
      } catch {
        /* ignore */
      }
      await removeAdbForward(serial, spawned.localPort);
      throw err;
    }

    spawned.proc.on("exit", (code, signal) => {
      if (!disposed) {
        events.emit(
          "terminated",
          new FailureError(`open-device-server exited (code=${code} signal=${signal})`, {
            error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_TERMINATED,
            failure_stage: "open_device_server_lifecycle",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...(typeof code === "number" ? { failure_exit_code: code } : {}),
            ...(signal === "SIGABRT" ||
            signal === "SIGHUP" ||
            signal === "SIGINT" ||
            signal === "SIGKILL" ||
            signal === "SIGQUIT" ||
            signal === "SIGTERM"
              ? { failure_signal: signal }
              : {}),
          })
        );
      }
    });
    spawned.proc.on("error", (err) => {
      if (!disposed) events.emit("terminated", err);
    });

    const api: OpenDeviceServerApi = {
      isReady: () => ready && !disposed,
      ping: () => client.request<{ status: string }>("ping"),
      getInfo: () => client.request<OpenServerInfo>("getInfo"),
      getScreenSize: () =>
        client.request<{ screenWidth: number; screenHeight: number; displayRotation: number }>(
          "getScreenSize"
        ),
      getAccessibilityTree: (getOpts = {}) =>
        client.request<OpenServerTreeResult>("getAccessibilityTree", {
          maxElements: getOpts.maxElements ?? 200,
          waitTimeoutMs: getOpts.waitTimeoutMs ?? 2000,
          ...(getOpts.flush ? { flush: true } : {}),
        }),
      getNestedAccessibilityTree: (getOpts = {}) =>
        client.request<{ tree: OpenServerNestedElement[] }>("getAccessibilityTree", {
          nested: true,
          maxElements: getOpts.maxElements ?? 3000,
          waitTimeoutMs: getOpts.waitTimeoutMs ?? 2000,
          ...(getOpts.flush ? { flush: true } : {}),
        }),
      getNestedState: async (stateOpts = {}) => {
        // requestWithStats so the reply's on-the-wire size (`wireBytes`), host
        // JSON.parse cost, and the host-clock timeline (TTFB / receive / round-trip)
        // ride the result as metadata — the raw bytes and receive timing are
        // otherwise dropped right after parse (phase 3i).
        const {
          result,
          wireBytes,
          parseMs,
          hostSentToFirstByteMs,
          hostFirstToLastByteMs,
          hostRoundTripMs,
        } = await client.requestWithStats<{
          tree: OpenServerNestedElement[];
          info: OpenServerInfo;
          waitedMs: number;
          captureMs: number;
          timings?: OpenServerTimings;
        }>("getState", {
          nested: true,
          includeScreenshot: false,
          maxElements: stateOpts.maxElements ?? 3000,
          waitTimeoutMs: stateOpts.waitTimeoutMs ?? 2000,
          ...(stateOpts.flush ? { flush: true } : {}),
        });
        return {
          ...result,
          wireBytes,
          hostParseMs: parseMs,
          hostSentToFirstByteMs,
          hostFirstToLastByteMs,
          hostRoundTripMs,
        };
      },
      tap: (x, y, tapOpts = {}) =>
        client.request<{ success: boolean; dropped?: boolean }>("tap", {
          x,
          y,
          ...(tapOpts.clickCount !== undefined ? { clickCount: tapOpts.clickCount } : {}),
          ...(tapOpts.holdMs !== undefined ? { holdMs: tapOpts.holdMs } : {}),
          ...(tapOpts.gapMs !== undefined ? { gapMs: tapOpts.gapMs } : {}),
        }),
      setClipboard: (text) =>
        client.request<{ success: boolean; text: string; error?: string }>("setClipboard", { text }),
      longPress: (x, y, durationMs) =>
        client.request<{ success: boolean }>("longPress", { x, y, durationMs: durationMs ?? 1000 }),
      swipe: (startX, startY, endX, endY, steps, holdEndMs) =>
        client.request<{ success: boolean }>("swipe", {
          startX,
          startY,
          endX,
          endY,
          steps: steps ?? 10,
          ...(holdEndMs && holdEndMs > 0 ? { holdEndMs } : {}),
        }),
      gesture: (pointers) => client.request<{ success: boolean }>("gesture", { pointers }),
      flushInput: () => client.request<{ success: boolean }>("flushInput"),
      typeText: (text) =>
        client.request<{ success: boolean; charsTyped: number }>("typeText", { text }),
      key: (key) => client.request<{ success: boolean }>("key", { key }),
      waitForIdle: (timeoutMs) =>
        client.request<{ idle: boolean; waitedMs: number }>("waitForIdle", {
          timeoutMs: timeoutMs ?? 2000,
        }),
      launchApp: (packageName) =>
        client.request<{ success: boolean; packageName: string }>("launchApp", { packageName }),
      screenshot: (ssOpts = {}) =>
        client.request<OpenServerScreenshot>("screenshot", {
          quality: ssOpts.quality ?? 80,
          scale: ssOpts.scale ?? 1.0,
          format: ssOpts.format ?? "png",
        }),
      getState: async (stateOpts = {}) => {
        const { result, wireBytes, parseMs, hostSentToFirstByteMs, hostFirstToLastByteMs, hostRoundTripMs } =
          await client.requestWithStats<OpenServerStateResult>("getState", {
            maxElements: stateOpts.maxElements ?? 200,
            waitTimeoutMs: stateOpts.waitTimeoutMs ?? 2000,
            includeScreenshot: stateOpts.includeScreenshot ?? false,
            ...(stateOpts.flush ? { flush: true } : {}),
            ...(stateOpts.quality !== undefined ? { quality: stateOpts.quality } : {}),
            ...(stateOpts.scale !== undefined ? { scale: stateOpts.scale } : {}),
          });
        return {
          ...result,
          wireBytes,
          hostParseMs: parseMs,
          hostSentToFirstByteMs,
          hostFirstToLastByteMs,
          hostRoundTripMs,
        };
      },
    };

    // Fast-inject seam (phase 3f). When enabled, replace ONLY the tap/swipe/gesture
    // closures with the scrcpy control-channel backend; every other verb stays on
    // the Kotlin NDJSON client. The `@yume-chan` deps are pulled in lazily so the
    // default path (and the pure-timeline unit tests) never load them.
    //
    // Ordering (critical). scrcpy injects from a separate process, so this server's
    // async-UP bookkeeping never sees those events. Rather than a separate
    // `flushInput` RPC after every action — an extra Kotlin round-trip that erased
    // the injection win — we set a host-side `fastInjectPending` flag and fold the
    // synchronous flush INTO the next state/hierarchy capture: the read closures are
    // wrapped to pass `flush:true` (and clear the flag) whenever a fast-inject is
    // pending. The Kotlin StateHandler/HierarchyHandler run the sync no-op inline
    // before capturing, in the same slot as the tap async-UP drain, so a following
    // `getNestedState`/describe (and any before/after outcome capture) observes the
    // settled, finger-up tree at NO extra round-trip.
    //
    // Loud failure. On any scrcpy error the closure falls back to the Kotlin
    // `tap`/`swipe`/`gesture` RPC for that one action (logged at warn + counted,
    // surfaced via getInfo.fastInjectFallbacks) — it must NEVER reach the tool-level
    // proprietary fallback, and the bench asserts this counter is 0 for ON-scrcpy.
    const fastInject: FastInjectBackend =
      opts.fastInject ?? (isFlagEnabled("open-device-server-fast-inject") ? "scrcpy" : "off");
    let scrcpyBackend: ScrcpyInjectBackend | null = null;
    let fastInjectPending = false;
    let fastInjectFallbacks = 0;
    if (fastInject === "scrcpy") {
      const { createScrcpyInjectBackend } = await import("../utils/scrcpy-inject-backend");
      scrcpyBackend = createScrcpyInjectBackend({
        serial,
        getScreenSize: () => api.getScreenSize(),
        log: (msg) => {
          // eslint-disable-next-line no-console
          console.debug(`[open-server-fast-inject] ${msg}`);
        },
      });
      const backend = scrcpyBackend;

      const onFallback = (verb: string, err: unknown): void => {
        fastInjectFallbacks++;
        const detail = err instanceof Error ? err.message : String(err);
        const msg =
          `[open-server-fast-inject] scrcpy ${verb} failed; falling back to the ` +
          `Kotlin UiAutomation channel for this action (fallbacks=${fastInjectFallbacks}): ${detail}`;
        // warn is the operator signal; console.debug keeps it visible to the bench's
        // fallback capture so a degraded ON-scrcpy run cannot be scored as healthy.
        // eslint-disable-next-line no-console
        console.warn(msg);
        // eslint-disable-next-line no-console
        console.debug(msg);
      };

      // Kotlin closures captured BEFORE the swap, so a fallback re-enters the
      // UiAutomation path (not itself). Either way a read must order after the UP,
      // so mark pending in both the scrcpy and the fallback case.
      const kotlinTap = api.tap;
      const kotlinSwipe = api.swipe;
      const kotlinGesture = api.gesture;

      api.tap = async (x, y, tapOpts = {}) => {
        try {
          await backend.tap(x, y, tapOpts);
          fastInjectPending = true;
          return { success: true };
        } catch (err) {
          onFallback("tap", err);
          fastInjectPending = true;
          return kotlinTap(x, y, tapOpts);
        }
      };
      api.swipe = async (startX, startY, endX, endY, steps, holdEndMs) => {
        try {
          await backend.swipe(startX, startY, endX, endY, steps ?? 10, holdEndMs ?? 0);
          fastInjectPending = true;
          return { success: true };
        } catch (err) {
          onFallback("swipe", err);
          fastInjectPending = true;
          return kotlinSwipe(startX, startY, endX, endY, steps, holdEndMs);
        }
      };
      api.gesture = async (pointers) => {
        try {
          await backend.gesture(pointers);
          fastInjectPending = true;
          return { success: true };
        } catch (err) {
          onFallback("gesture", err);
          fastInjectPending = true;
          return kotlinGesture(pointers);
        }
      };

      // Fold the synchronous flush into the next read: when a fast-inject is
      // pending, force `flush:true` (once) so the capture drains the input queue
      // inline. Wraps every read that could observe post-injection state.
      const withFlush = <O extends { flush?: boolean }, R>(
        orig: (opts?: O) => Promise<R>
      ): ((opts?: O) => Promise<R>) => {
        return (readOpts?: O): Promise<R> => {
          if (!fastInjectPending) return orig(readOpts);
          fastInjectPending = false;
          return orig({ ...(readOpts ?? {}), flush: true } as O);
        };
      };
      api.getState = withFlush(api.getState);
      api.getNestedState = withFlush(api.getNestedState);
      api.getAccessibilityTree = withFlush(api.getAccessibilityTree);
      api.getNestedAccessibilityTree = withFlush(api.getNestedAccessibilityTree);

      // Surface the fallback counter on getInfo so callers/tests can assert 0.
      const kotlinGetInfo = api.getInfo;
      api.getInfo = async () => {
        const info = await kotlinGetInfo();
        return { ...info, fastInjectFallbacks };
      };
    }

    const instance: ServiceInstance<OpenDeviceServerApi> = {
      api,
      dispose: async () => {
        disposed = true;
        ready = false;
        // Tear down the scrcpy control channel (F3f) before the Kotlin server.
        if (scrcpyBackend) await scrcpyBackend.dispose().catch(() => undefined);
        // Drop this device's cached screen geometry (F21) so a later session on
        // the same serial re-reads it rather than trusting a stale orientation.
        invalidateScreenSize(serial);
        // Drop the cached "clipboard unsupported" result (R3) so a fresh server
        // session re-probes the clipboard rather than assuming the last verdict.
        invalidateClipboardSupport(serial);
        // Ask the server to exit on its own so `am instrument` ends cleanly.
        try {
          await Promise.race([
            client.request("shutdown"),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("shutdown timeout")), 1_000)
            ),
          ]);
        } catch {
          /* fall through to force-kill */
        }
        client.close();
        try {
          spawned.proc.kill();
        } catch {
          /* ignore */
        }
        await removeAdbForward(serial, spawned.localPort);
      },
      events,
    };

    return instance;
  },
};
