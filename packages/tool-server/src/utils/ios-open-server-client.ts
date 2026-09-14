import * as net from "node:net";
import { AndroidOpenServerClient } from "./android-open-server-client";

/**
 * NDJSON JSON-RPC 2.0 client for `@argent/ios-device-server` (the open iOS
 * XCUITest server). It speaks the SAME wire framing as the Android open server —
 * one request per line, one `\n`-terminated reply per request — so the transport
 * is the shared, well-tested {@link AndroidOpenServerClient} (an NDJSON JSON-RPC
 * client that is platform-agnostic despite its name). This file adds the iOS
 * method surface and reply shapes on top of it; it does NOT reuse base B's
 * HTTP-per-command client.
 *
 * On the simulator the socket is plain loopback (`127.0.0.1:<port>`), because the
 * simulator shares the host loopback. On a physical device the same `request()`
 * runs over a usbmux-forwarded socket (`utils/ios-device/usbmux*.ts`, copied from
 * base B); that path is compiled but not exercised in hosted CI (iOS-1).
 */

/**
 * The single source of truth for the iOS open-server method names on the host.
 * The method-parity test asserts this list equals the Swift `RunnerMethod` enum
 * (read off `ArgentRunnerSession`'s source), so the two never drift.
 */
export const IOS_OPEN_SERVER_METHODS = [
  "ping",
  "getInfo",
  "getScreenSize",
  "getState",
  "getNestedState",
  "tap",
  "longPress",
  "swipe",
  "typeText",
  "key",
  "screenshot",
  "launchApp",
  "terminateApp",
  "flushInput",
  "batch",
  "shutdown",
] as const;

export type IosOpenServerMethod = (typeof IOS_OPEN_SERVER_METHODS)[number];

// ---- reply shapes (mirror RunnerProtocol.swift) ---------------------------

export interface IosOpenServerInfo {
  bundleId: string;
  orientation: string;
  keyboardVisible: boolean;
  screenWidth: number;
  screenHeight: number;
  scale: number;
  version: number;
}

export interface IosOpenServerScreenSize {
  screenWidth: number;
  screenHeight: number;
  scale: number;
}

/** One nested node: SCREEN-POINT bounds and `children` arrays. */
export interface IosOpenServerNode {
  type: string;
  label?: string;
  identifier?: string;
  value?: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  enabled: boolean;
  hittable: boolean;
  selected: boolean;
  focused: boolean;
  children: IosOpenServerNode[];
}

export interface IosOpenServerTimings {
  snapshotMs: number;
  serializeMs: number;
  encodeMs: number;
  captureMs: number;
}

export interface IosOpenServerStateInfo {
  bundleId: string;
  orientation: string;
  keyboardVisible: boolean;
  screenWidth: number;
  screenHeight: number;
  scale: number;
}

export interface IosOpenServerState {
  tree: IosOpenServerNode[];
  truncated: boolean;
  info: IosOpenServerStateInfo;
  version: number;
  timings: IosOpenServerTimings;
  /** Present only on `getState` with a screenshot; never on `getNestedState`. */
  screenshot?: string;
}

export interface IosOpenServerScreenshot {
  /** Base64 image bytes (no data-URI prefix). */
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

/** The connection facts for a simulator (loopback) target. */
export interface IosOpenServerClientOptions {
  host?: string;
  port: number;
  timeoutMs?: number;
  /**
   * Physical-device seam: supply a usbmux-forwarded socket instead of loopback.
   * Unused on the simulator. Kept so the physical path (iOS-4) drops in without
   * changing `request()`.
   */
  connect?: () => net.Socket;
}

/**
 * Typed façade over the shared NDJSON JSON-RPC transport. Every app-scoped
 * method operates on the app `launchApp` last targeted (Settings), or an
 * explicit `bundleId` param.
 */
export class IosOpenServerClient {
  private readonly rpc: AndroidOpenServerClient;

  constructor(opts: IosOpenServerClientOptions) {
    this.rpc = new AndroidOpenServerClient(opts.host ?? "127.0.0.1", opts.port, {
      timeoutMs: opts.timeoutMs,
    });
  }

  request<T = unknown>(
    method: IosOpenServerMethod,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number }
  ): Promise<T> {
    return this.rpc.request<T>(method, params, opts);
  }

  ping(): Promise<{ status: string }> {
    return this.request("ping");
  }

  getInfo(bundleId?: string): Promise<IosOpenServerInfo> {
    return this.request("getInfo", bundleId ? { bundleId } : undefined);
  }

  getScreenSize(): Promise<IosOpenServerScreenSize> {
    return this.request("getScreenSize");
  }

  getState(opts: {
    includeScreenshot?: boolean;
    maxElements?: number;
    bundleId?: string;
  } = {}): Promise<IosOpenServerState> {
    return this.request("getState", { ...opts });
  }

  getNestedState(opts: { maxElements?: number; bundleId?: string } = {}): Promise<IosOpenServerState> {
    return this.request("getNestedState", { ...opts });
  }

  tap(
    x: number,
    y: number,
    opts: { clickCount?: number; holdMs?: number; gapMs?: number; bundleId?: string } = {}
  ): Promise<{ success: boolean; dropped: boolean; dropReporting: string }> {
    return this.request("tap", { x, y, ...opts });
  }

  longPress(x: number, y: number, opts: { durationMs?: number; bundleId?: string } = {}): Promise<{ success: boolean }> {
    return this.request("longPress", { x, y, ...opts });
  }

  swipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    opts: { steps?: number; holdEndMs?: number; durationMs?: number; bundleId?: string } = {}
  ): Promise<{ success: boolean }> {
    return this.request("swipe", { startX, startY, endX, endY, ...opts });
  }

  typeText(text: string, bundleId?: string): Promise<{ success: boolean; charsTyped: number }> {
    return this.request("typeText", { text, ...(bundleId ? { bundleId } : {}) });
  }

  key(key: string, bundleId?: string): Promise<{ success: boolean }> {
    return this.request("key", { key, ...(bundleId ? { bundleId } : {}) });
  }

  screenshot(
    opts: { format?: "png" | "jpeg"; quality?: number; scale?: number } = {}
  ): Promise<IosOpenServerScreenshot> {
    return this.request("screenshot", { ...opts });
  }

  launchApp(bundleId: string): Promise<{ success: boolean; bundleId: string }> {
    return this.request("launchApp", { bundleId });
  }

  terminateApp(bundleId?: string): Promise<{ success: boolean; bundleId: string }> {
    return this.request("terminateApp", bundleId ? { bundleId } : undefined);
  }

  flushInput(): Promise<{ success: boolean }> {
    return this.request("flushInput");
  }

  shutdown(): Promise<{ status: string }> {
    return this.request("shutdown");
  }

  close(): void {
    this.rpc.close();
  }
}
