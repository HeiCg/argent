import http from "node:http";
import net from "node:net";
import { requireTimeRemaining, type Deadline } from "./usbmux";
import { IosDeviceTransportError } from "./usbmux-protocol";

/**
 * One HTTP POST per connection to the XCUITest runner's /command endpoint.
 *
 * The runner speaks plain HTTP/1.1, but on a physical device the "connection"
 * is a usbmux socket that is already established before HTTP enters the
 * picture. node:http cannot dial such a socket itself, so each request gets a
 * throwaway Agent whose createConnection hands back the pre-connected socket.
 * One request per connection (Connection: close) keeps the lifecycle trivial:
 * no keep-alive pooling of muxed sockets whose device may unplug between
 * requests, and every error path can simply destroy both agent and socket.
 */

/**
 * Large snapshot/screenshot payloads are legitimate, but the length is
 * attacker-adjacent data from a USB peripheral; cap it so a corrupt stream
 * cannot drive an unbounded allocation.
 */
const RUNNER_HTTP_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

interface PostRunnerCommandOptions {
  /**
   * Produces the connected socket for this one request. A factory rather than
   * a socket so the (potentially slow) usbmux handshake only happens once the
   * caller actually commits to sending, and so its typed errors flow through
   * this function's error path.
   */
  socketFactory: () => Promise<net.Socket>;
  /** JSON-serialized as the POST body. */
  body: unknown;
  /**
   * Whole-send budget, already ticking and shared with the usbmux handshake
   * inside socketFactory: the HTTP exchange gets only what the handshake has
   * not already spent.
   */
  deadline: Deadline;
}

/** POST one runner command over a pre-connected socket; resolves with the parsed JSON body. */
export async function postRunnerCommand(options: PostRunnerCommandOptions): Promise<unknown> {
  requireTimeRemaining(options.deadline.remainingMs(), "send runner command");
  const socket = await options.socketFactory();
  const agent = new http.Agent({ keepAlive: false });
  // @types/node exposes createConnection on Agent instances; returning the
  // pre-connected socket short-circuits the dial step entirely.
  agent.createConnection = ((
    _options: unknown,
    callback?: (err: Error | null, stream: net.Socket) => void
  ) => {
    callback?.(null, socket);
    return socket;
  }) as typeof agent.createConnection;
  try {
    const payload = Buffer.from(JSON.stringify(options.body), "utf8");
    // Re-read the budget now that the handshake has spent its share; a
    // handshake that ate everything must fail here, not start a zero-ms HTTP
    // request.
    const httpTimeoutMs = options.deadline.remainingMs();
    requireTimeRemaining(httpTimeoutMs, "send runner command");
    const response = await requestOverAgent(agent, socket, payload, httpTimeoutMs);
    return parseRunnerResponseBody(response.statusCode, response.body);
  } finally {
    agent.destroy();
    socket.destroy();
  }
}

async function requestOverAgent(
  agent: http.Agent,
  socket: net.Socket,
  payload: Buffer,
  timeoutMs: number
): Promise<{ statusCode: number; body: Buffer }> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  try {
    return await new Promise((resolve, reject) => {
      const request = http.request(
        {
          method: "POST",
          // Host header only: the actual connection is the injected socket.
          host: "127.0.0.1",
          path: "/command",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": payload.length,
            "Connection": "close",
          },
          agent,
          signal: timeoutSignal,
        },
        (response) => {
          readBoundedBody(response).then(
            (body) => resolve({ statusCode: response.statusCode ?? 500, body }),
            reject
          );
        }
      );
      request.once("error", reject);
      // The usbmux layer leaves the socket paused with any early bytes
      // unshifted; resume so the response can flow.
      socket.resume();
      request.end(payload);
    });
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new IosDeviceTransportError(
        "timeout",
        `Timed out waiting for XCUITest runner response after ${timeoutMs}ms`,
        { retryable: true, cause: error }
      );
    }
    if (error instanceof IosDeviceTransportError) throw error;
    throw new IosDeviceTransportError(
      "http",
      `Runner HTTP request failed: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true, cause: error }
    );
  }
}

async function readBoundedBody(response: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    totalBytes += buffer.length;
    if (totalBytes > RUNNER_HTTP_MAX_RESPONSE_BYTES) {
      throw new IosDeviceTransportError(
        "protocol",
        `Runner response exceeded ${RUNNER_HTTP_MAX_RESPONSE_BYTES} bytes`,
        { retryable: false }
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * The runner encodes command failures inside its JSON envelope (ok:false), so
 * a parseable body is returned regardless of HTTP status and left to the
 * client layer to interpret. Only an unparseable body is a transport-level
 * failure; at that point the status code is the best diagnostic available.
 */
function parseRunnerResponseBody(statusCode: number, body: Buffer): unknown {
  const text = body.toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new IosDeviceTransportError(
      "http",
      `Runner returned non-JSON response (HTTP ${statusCode})`,
      { retryable: false }
    );
  }
}
