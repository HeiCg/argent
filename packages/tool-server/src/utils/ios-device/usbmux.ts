import net from "node:net";
import {
  buildUsbmuxPlistMessage,
  decodeUsbmuxPacket,
  encodeUsbmuxPacket,
  hostToNetworkPort,
  IosDeviceTransportError,
  readUsbmuxDeviceIdForSerial,
  readUsbmuxResultCode,
} from "./usbmux-protocol";

export {
  IosDeviceTransportError,
  isIosDeviceTransportError,
  type IosDeviceTransportErrorKind,
} from "./usbmux-protocol";

/**
 * Dependency-free usbmuxd client (node:net only). Opening a runner socket is
 * two exchanges on two separate connections, because usbmuxd repurposes a
 * connection after a successful `Connect`:
 *
 * 1. `ListDevices` (tag 1) on a throwaway socket resolves the mux DeviceID for
 *    the dashed hardware UDID.
 * 2. `Connect` (tag 2) on a FRESH socket binds that socket to device:port.
 *    After result 0 the socket stops being a usbmuxd control channel and
 *    becomes a raw byte pipe to the XCUITest runner on the device.
 */

const USBMUXD_SOCKET_PATH = "/var/run/usbmuxd";
const USBMUX_DEFAULT_TIMEOUT_MS = 5_000;

/**
 * usbmuxd `Connect` result codes, confirmed against the daemon on macOS:
 * connecting with a DeviceID usbmuxd does not know answers 2, and connecting
 * to a closed port on an attached device answers 3.
 */
const USBMUX_RESULT_OK = 0;
const USBMUX_RESULT_BAD_DEVICE = 2;
const USBMUX_RESULT_CONNECTION_REFUSED = 3;

const DEVICE_UNATTACHED_HINT =
  "Connect the device by cable, trust this Mac, keep it unlocked, and retry.";

export interface OpenUsbmuxRunnerSocketOptions {
  /** Dashed hardware UDID (e.g. 00008110-000978540290401E). */
  udid: string;
  /** TCP port the XCUITest runner listens on ON the device. */
  port: number;
  /** Budget for the whole lookup + connect exchange. Default 5s. */
  timeoutMs?: number;
  /** Test seam: a fake usbmuxd can listen on an alternative unix socket. */
  socketPath?: string;
}

/**
 * Open a socket that is a raw pipe to `device:port` on the given physical
 * device, multiplexed over USB by usbmuxd. The returned socket is paused; the
 * HTTP layer resumes it when it starts its request.
 */
export async function openUsbmuxRunnerSocket(
  options: OpenUsbmuxRunnerSocketOptions
): Promise<net.Socket> {
  const socketPath = options.socketPath ?? USBMUXD_SOCKET_PATH;
  const deadline = createDeadline(options.timeoutMs ?? USBMUX_DEFAULT_TIMEOUT_MS);
  const deviceId = await resolveUsbmuxDeviceId(socketPath, options.udid, deadline);
  return await connectToDevicePort(socketPath, options.udid, deviceId, options.port, deadline);
}

/**
 * Map a non-zero `Connect` result to the typed verdict the route resolver
 * branches on. Result 2 (device gone) must land on the same unattached path as
 * a missing `ListDevices` entry — it covers the device being unplugged between
 * the lookup and the connect, and a CoreDevice-backed device can then fall
 * back to its Wi-Fi tunnel instead of failing with a cable hint. Result 3
 * means the opposite: the device is attached and only the runner port is not
 * bound yet, which resolves on its own once the runner finishes starting — so
 * it is the one retryable verdict.
 *
 * Exported for tests; pure so the result-code mapping can be verified without
 * sockets.
 */
export function buildUsbmuxConnectError(
  result: number | undefined,
  context: { udid: string; port: number }
): IosDeviceTransportError {
  if (result === USBMUX_RESULT_BAD_DEVICE) {
    return new IosDeviceTransportError(
      "device-unattached",
      `iOS device ${context.udid} is no longer available through usbmux`,
      { retryable: false, hint: DEVICE_UNATTACHED_HINT }
    );
  }
  if (result === USBMUX_RESULT_CONNECTION_REFUSED) {
    return new IosDeviceTransportError(
      "runner-not-listening",
      `XCUITest runner is not listening on device port ${context.port}`,
      {
        retryable: true,
        hint: "The device is reachable but nothing is bound to the runner port yet; this resolves once the runner finishes starting.",
      }
    );
  }
  return new IosDeviceTransportError(
    "protocol",
    `Failed to connect to XCUITest runner through usbmux (result ${result ?? "missing"})`,
    { retryable: false, hint: DEVICE_UNATTACHED_HINT }
  );
}

async function resolveUsbmuxDeviceId(
  socketPath: string,
  udid: string,
  deadline: Deadline
): Promise<number> {
  const socket = await connectToUsbmuxd(socketPath, deadline);
  try {
    await writePacket(socket, buildUsbmuxPlistMessage("ListDevices"), 1);
    const payload = await readOnePacket(socket, deadline);
    const deviceId = readUsbmuxDeviceIdForSerial(payload.toString("utf8"), udid);
    if (deviceId !== undefined) return deviceId;
    throw new IosDeviceTransportError(
      "device-unattached",
      `iOS device ${udid} is not available through usbmux`,
      { retryable: false, hint: DEVICE_UNATTACHED_HINT }
    );
  } finally {
    // The lookup connection is single-purpose either way; usbmuxd expects a
    // fresh socket for Connect.
    socket.destroy();
  }
}

async function connectToDevicePort(
  socketPath: string,
  udid: string,
  deviceId: number,
  port: number,
  deadline: Deadline
): Promise<net.Socket> {
  const socket = await connectToUsbmuxd(socketPath, deadline);
  try {
    const message = buildUsbmuxPlistMessage("Connect", {
      DeviceID: deviceId,
      PortNumber: hostToNetworkPort(port),
    });
    await writePacket(socket, message, 2);
    const payload = await readOnePacket(socket, deadline);
    const result = readUsbmuxResultCode(payload.toString("utf8"));
    if (result !== USBMUX_RESULT_OK) {
      throw buildUsbmuxConnectError(result, { udid, port });
    }
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function connectToUsbmuxd(socketPath: string, deadline: Deadline): Promise<net.Socket> {
  const timeoutMs = deadline.remainingMs();
  requireTimeRemaining(timeoutMs, "connect to usbmuxd");
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const timer = setTimeout(() => {
      finish(
        new IosDeviceTransportError("timeout", `Timed out connecting to usbmuxd at ${socketPath}`, {
          retryable: true,
        })
      );
    }, timeoutMs);
    const onConnect = () => finish();
    const onError = (error: Error) =>
      finish(
        new IosDeviceTransportError("protocol", `Cannot reach usbmuxd at ${socketPath}`, {
          retryable: false,
          hint: "usbmuxd runs on every macOS install; a missing socket usually means this is not a Mac or a sandbox blocks /var/run.",
          cause: error,
        })
      );
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

async function writePacket(socket: net.Socket, payloadXml: string, tag: number): Promise<void> {
  const packet = encodeUsbmuxPacket(tag, payloadXml);
  if (socket.write(packet)) return;
  await new Promise<void>((resolve, reject) => {
    socket.once("drain", resolve);
    socket.once("error", reject);
  });
}

/**
 * Read exactly one framed packet, then pause the socket. Pausing matters on
 * the Connect socket: any bytes past the Result packet already belong to the
 * raw device pipe, so they are pushed back with `unshift` for the HTTP layer
 * to consume once it resumes the socket.
 */
async function readOnePacket(socket: net.Socket, deadline: Deadline): Promise<Buffer> {
  const timeoutMs = deadline.remainingMs();
  requireTimeRemaining(timeoutMs, "read usbmuxd response");
  return await new Promise<Buffer>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      finish(
        new IosDeviceTransportError("timeout", "Timed out reading usbmuxd response", {
          retryable: true,
        })
      );
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let packet;
      try {
        packet = decodeUsbmuxPacket(buffer);
      } catch (error) {
        finish(error as Error);
        return;
      }
      if (!packet) return;
      const remainder = buffer.subarray(packet.bytesConsumed);
      finish(undefined, packet.payload, remainder.length > 0 ? remainder : undefined);
    };
    const onError = (error: Error) => finish(error);
    const onClose = () =>
      finish(
        new IosDeviceTransportError("protocol", "usbmuxd closed the connection unexpectedly", {
          retryable: false,
        })
      );
    const finish = (error?: Error, payload?: Buffer, remainder?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.pause();
      if (remainder) socket.unshift(remainder);
      if (error) reject(error);
      else resolve(payload as Buffer);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();
  });
}

interface Deadline {
  remainingMs(): number;
}

function createDeadline(timeoutMs: number): Deadline {
  const expiresAt = Date.now() + timeoutMs;
  return { remainingMs: () => expiresAt - Date.now() };
}

function requireTimeRemaining(timeoutMs: number, action: string): void {
  if (timeoutMs > 0) return;
  throw new IosDeviceTransportError("timeout", `No time remaining to ${action}`, {
    retryable: true,
  });
}
