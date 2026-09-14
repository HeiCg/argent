import {
  TypedEventEmitter,
  FAILURE_CODES,
  FailureError,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
} from "@argent/registry";
import {
  IosOpenServerClient,
  type IosOpenServerInfo,
  type IosOpenServerScreenSize,
  type IosOpenServerState,
  type IosOpenServerScreenshot,
} from "../utils/ios-open-server-client";
import { spawnIosRunner, type IosRunnerTarget } from "../utils/ios-open-server-runner";

/**
 * Registry blueprint for the open iOS XCUITest server
 * (`@argent/ios-device-server`), the iOS counterpart of `androidOpenServerBlueprint`.
 * The factory builds (cached) and launches the runner, pings it ready, and
 * exposes the NDJSON JSON-RPC method surface. Simulator-first: the target is a
 * simulator UDID on loopback; the physical-device path is compiled but not
 * exercised in hosted CI.
 */

const IOS_OPEN_SERVER_NAMESPACE = "IosOpenDeviceServer";

type IosOpenServerFactoryOptions = Record<string, unknown> & {
  device: DeviceInfo;
};

export function iosOpenServerRef(device: DeviceInfo): {
  urn: string;
  options: IosOpenServerFactoryOptions;
} {
  return {
    urn: `${IOS_OPEN_SERVER_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

/**
 * The method surface of the open iOS server. Coordinates for tap/longPress/swipe
 * are SCREEN POINTS; callers holding normalized 0–1 points convert against
 * [getScreenSize] / [getInfo].
 */
export interface IosOpenDeviceServerApi {
  isReady(): boolean;
  ping(): Promise<{ status: string }>;
  getInfo(bundleId?: string): Promise<IosOpenServerInfo>;
  getScreenSize(): Promise<IosOpenServerScreenSize>;
  getState(opts?: { includeScreenshot?: boolean; maxElements?: number; bundleId?: string }): Promise<IosOpenServerState>;
  getNestedState(opts?: { maxElements?: number; bundleId?: string }): Promise<IosOpenServerState>;
  tap(
    x: number,
    y: number,
    opts?: { clickCount?: number; holdMs?: number; gapMs?: number; bundleId?: string }
  ): Promise<{ success: boolean; dropped: boolean; dropReporting: string }>;
  longPress(x: number, y: number, opts?: { durationMs?: number; bundleId?: string }): Promise<{ success: boolean }>;
  swipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    opts?: { steps?: number; holdEndMs?: number; durationMs?: number; bundleId?: string }
  ): Promise<{ success: boolean }>;
  typeText(text: string, bundleId?: string): Promise<{ success: boolean; charsTyped: number }>;
  key(key: string, bundleId?: string): Promise<{ success: boolean }>;
  screenshot(opts?: { format?: "png" | "jpeg"; quality?: number; scale?: number }): Promise<IosOpenServerScreenshot>;
  launchApp(bundleId: string): Promise<{ success: boolean; bundleId: string }>;
  terminateApp(bundleId?: string): Promise<{ success: boolean; bundleId: string }>;
  flushInput(): Promise<{ success: boolean }>;
}

/** Whether this iOS device is a simulator (loopback) or a physical device (usbmux). */
function targetForDevice(device: DeviceInfo): IosRunnerTarget {
  // iOS-1 is simulator-first. A physical device is opted into with
  // ARGENT_IOS_TEAM_ID (base B's signing gate); absent it, treat as a simulator.
  const kind: IosRunnerTarget["kind"] = process.env.ARGENT_IOS_OPEN_SERVER_PHYSICAL === "1" ? "device" : "simulator";
  return { udid: device.id, kind };
}

export const iosOpenServerBlueprint: ServiceBlueprint<IosOpenDeviceServerApi, DeviceInfo> = {
  namespace: IOS_OPEN_SERVER_NAMESPACE,

  getURN(device: DeviceInfo) {
    return `${IOS_OPEN_SERVER_NAMESPACE}:${device.id}`;
  },

  async factory(_deps, _payload, options) {
    const opts = options as unknown as IosOpenServerFactoryOptions | undefined;
    if (!opts?.device) {
      throw new FailureError(
        `${IOS_OPEN_SERVER_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use iosOpenServerRef(device) when registering the service ref.`,
        {
          error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_FACTORY_OPTIONS_MISSING,
          failure_stage: "ios_open_server_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    const { device } = opts;
    if (device.platform !== "ios") {
      throw new FailureError(
        `${IOS_OPEN_SERVER_NAMESPACE} is iOS-only. The target '${device.id}' classifies as ${device.platform}.`,
        {
          error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_WRONG_PLATFORM,
          failure_stage: "ios_open_server_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    const events = new TypedEventEmitter<ServiceEvents>();
    const { spawned, client } = await spawnIosRunner(targetForDevice(device));
    let ready = true;
    let disposed = false;

    spawned.proc.on("exit", (code, signal) => {
      if (!disposed) {
        events.emit(
          "terminated",
          new FailureError(`ios-open-server exited (code=${code} signal=${signal})`, {
            error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_TERMINATED,
            failure_stage: "ios_open_server_lifecycle",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...(typeof code === "number" ? { failure_exit_code: code } : {}),
          })
        );
      }
    });
    spawned.proc.on("error", (err) => {
      if (!disposed) events.emit("terminated", err);
    });

    const api: IosOpenDeviceServerApi = {
      isReady: () => ready && !disposed,
      ping: () => client.ping(),
      getInfo: (bundleId) => client.getInfo(bundleId),
      getScreenSize: () => client.getScreenSize(),
      getState: (stateOpts = {}) => client.getState(stateOpts),
      getNestedState: (stateOpts = {}) => client.getNestedState(stateOpts),
      tap: (x, y, tapOpts = {}) => client.tap(x, y, tapOpts),
      longPress: (x, y, lpOpts = {}) => client.longPress(x, y, lpOpts),
      swipe: (startX, startY, endX, endY, swOpts = {}) => client.swipe(startX, startY, endX, endY, swOpts),
      typeText: (text, bundleId) => client.typeText(text, bundleId),
      key: (key, bundleId) => client.key(key, bundleId),
      screenshot: (ssOpts = {}) => client.screenshot(ssOpts),
      launchApp: (bundleId) => client.launchApp(bundleId),
      terminateApp: (bundleId) => client.terminateApp(bundleId),
      flushInput: () => client.flushInput(),
    };

    const instance: ServiceInstance<IosOpenDeviceServerApi> = {
      api,
      dispose: async () => {
        disposed = true;
        ready = false;
        try {
          await Promise.race([
            client.shutdown(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown timeout")), 1_000)),
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
      },
      events,
    };

    return instance;
  },
};
