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
import { runAdb } from "../utils/adb";
import { resolveAndroidBinary } from "../utils/android-binary";
import { ensureOpenDeviceServerInstalled } from "../utils/android-helper-install";
import { AndroidOpenServerClient } from "../utils/android-open-server-client";
import type { OpenServerElement } from "../tools/describe/platforms/android/open-server-tree";

const OPEN_DEVICE_SERVER_NAMESPACE = "OpenDeviceServer";

type OpenDeviceServerFactoryOptions = Record<string, unknown> & { device: DeviceInfo };

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
}

export interface OpenServerTreeResult {
  tree: OpenServerElement[];
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
  getAccessibilityTree(opts?: {
    maxElements?: number;
    waitTimeoutMs?: number;
  }): Promise<OpenServerTreeResult>;
  tap(x: number, y: number): Promise<{ success: boolean }>;
  longPress(x: number, y: number, durationMs?: number): Promise<{ success: boolean }>;
  swipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    steps?: number
  ): Promise<{ success: boolean }>;
  typeText(text: string): Promise<{ success: boolean; charsTyped: number }>;
  key(key: string): Promise<{ success: boolean }>;
  waitForIdle(timeoutMs?: number): Promise<{ idle: boolean; waitedMs: number }>;
  launchApp(packageName: string): Promise<{ success: boolean; packageName: string }>;
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
      getAccessibilityTree: (getOpts = {}) =>
        client.request<OpenServerTreeResult>("getAccessibilityTree", {
          maxElements: getOpts.maxElements ?? 200,
          waitTimeoutMs: getOpts.waitTimeoutMs ?? 2000,
        }),
      tap: (x, y) => client.request<{ success: boolean }>("tap", { x, y }),
      longPress: (x, y, durationMs) =>
        client.request<{ success: boolean }>("longPress", { x, y, durationMs: durationMs ?? 1000 }),
      swipe: (startX, startY, endX, endY, steps) =>
        client.request<{ success: boolean }>("swipe", {
          startX,
          startY,
          endX,
          endY,
          steps: steps ?? 10,
        }),
      typeText: (text) =>
        client.request<{ success: boolean; charsTyped: number }>("typeText", { text }),
      key: (key) => client.request<{ success: boolean }>("key", { key }),
      waitForIdle: (timeoutMs) =>
        client.request<{ idle: boolean; waitedMs: number }>("waitForIdle", {
          timeoutMs: timeoutMs ?? 2000,
        }),
      launchApp: (packageName) =>
        client.request<{ success: boolean; packageName: string }>("launchApp", { packageName }),
    };

    const instance: ServiceInstance<OpenDeviceServerApi> = {
      api,
      dispose: async () => {
        disposed = true;
        ready = false;
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
