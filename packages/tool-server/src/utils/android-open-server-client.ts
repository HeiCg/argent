import * as net from "node:net";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import {
  attachNdjsonReader,
  reportDroppedFrameToStderr,
  type NdjsonFrameStats,
} from "./ndjson-socket";

/**
 * Newline-delimited JSON-RPC 2.0 client for `@argent/android-device-server`.
 *
 * Ported from device-stream's `android-rpc.ts`, re-expressed on argent's ndjson
 * framing + FailureError. One request per line, one `\n`-terminated reply per
 * request; the server processes requests serially, so this client keeps a single
 * reused connection and issues one request at a time (an in-order chain),
 * correlating replies by `id`. The socket reconnects lazily on the next call
 * after a close/error, and each request has its own timeout that destroys the
 * socket if the server never answers.
 *
 * Unlike `android-devtools-client` (a connect-once client tied to a blueprint's
 * lifecycle), this one owns reconnection: the host reaches the server over an
 * adb-forwarded loopback port that survives a transient socket drop, so the
 * cheapest recovery is to redial the same port on the next call.
 */

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface Pending {
  resolve: (result: unknown, stats: NdjsonFrameStats) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A request's result plus the wire stats of the reply that carried it. */
export interface RequestWithStats<T> {
  result: T;
  /** UTF-8 byte length of the raw NDJSON reply line (on-the-wire size). */
  wireBytes: number;
  /** Host `JSON.parse` cost for that reply, in ms. */
  parseMs: number;
}

interface AndroidOpenServerClientOptions {
  /** Per-request timeout in ms; on expiry the socket is destroyed. Default 10s. */
  timeoutMs?: number;
}

export class AndroidOpenServerClient {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;

  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /**
   * Serialises calls so only one request is in flight at a time — the on-device
   * server processes requests serially on a single UiAutomation thread, so this
   * matches its execution model and avoids interleaving replies on the one shared
   * connection.
   *
   * Consequence for callers: `Promise.all([client.request(a), client.request(b)])`
   * does NOT overlap `a` and `b` — they still run back-to-back on this chain. No
   * caller may rely on parallelism here for latency; two logically-parallel reads
   * are two sequential round-trips. Where one round-trip will do (e.g. describe's
   * tree+info), prefer a combined RPC (`getState`) over a `Promise.all` that only
   * looks concurrent.
   */
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(host: string, port: number, opts: AndroidOpenServerClientOptions = {}) {
    this.host = host;
    this.port = port;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** Invoke a JSON-RPC method; resolves with `result`, rejects on RPC error. */
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.enqueue(() => this.sendOne<T>(method, params)).then((r) => r.result);
  }

  /**
   * Like {@link request}, but also resolves the reply's wire stats (`wireBytes`,
   * `parseMs`). Requests are serialised on one connection, so for a describe that
   * issues exactly one RPC these stats belong unambiguously to that reply. Used by
   * the open describe path to attribute the idle-describe host residual to
   * transport size vs. host parse (phase 3i).
   */
  requestWithStats<T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<RequestWithStats<T>> {
    return this.enqueue(() => this.sendOne<T>(method, params));
  }

  /** Serialise `run` onto the single-in-flight chain, keeping it alive on any outcome. */
  private enqueue<R>(run: () => Promise<R>): Promise<R> {
    const result = this.chain.then(run, run) as Promise<R>;
    this.chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  close(): void {
    this.closed = true;
    this.rejectAll(
      new FailureError("open-device-server client closed", {
        error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_RPC_CLIENT_CLOSED,
        failure_stage: "open_device_server_rpc_client",
        failure_area: "tool_server",
        error_kind: "subprocess",
      })
    );
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  private async sendOne<T>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<RequestWithStats<T>> {
    if (this.closed) {
      throw new FailureError("open-device-server client closed", {
        error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_RPC_CLIENT_CLOSED,
        failure_stage: "open_device_server_rpc_request",
        failure_area: "tool_server",
        error_kind: "subprocess",
      });
    }
    const socket = await this.connect();
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {}, id });

    return new Promise<RequestWithStats<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A wedged request means the connection is suspect: destroy it so the
        // next call reconnects rather than reading a stale reply.
        const err = new FailureError(
          `open-device-server ${method} timed out after ${this.timeoutMs}ms`,
          {
            error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_RPC_TIMEOUT,
            failure_stage: "open_device_server_rpc_request",
            failure_area: "tool_server",
            error_kind: "timeout",
          }
        );
        this.destroySocket(err);
        reject(err);
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (v, stats) => resolve({ result: v as T, wireBytes: stats.bytes, parseMs: stats.parseMs }),
        reject,
        timer,
      });

      socket.write(payload + "\n", (err) => {
        if (err) {
          const p = this.pending.get(id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(id);
          }
          reject(err);
        }
      });
    });
  }

  private connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setNoDelay(true);

      const onConnectError = (err: Error): void => {
        this.connecting = null;
        reject(err);
      };

      socket.once("connect", () => {
        socket.removeListener("error", onConnectError);
        socket.on("error", (err) => this.destroySocket(err));
        socket.on("close", () =>
          this.destroySocket(
            new FailureError("open-device-server connection closed", {
              error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_SOCKET_CLOSED,
              failure_stage: "open_device_server_socket",
              failure_area: "tool_server",
              error_kind: "subprocess",
            })
          )
        );
        attachNdjsonReader(socket, {
          onDropped: reportDroppedFrameToStderr("open-device-server"),
          onMessage: (raw, stats) => this.dispatch(raw as JsonRpcResponse, stats),
        });
        this.socket = socket;
        this.connecting = null;
        resolve(socket);
      });
      socket.once("error", onConnectError);
    });
    return this.connecting;
  }

  private dispatch(res: JsonRpcResponse, stats: NdjsonFrameStats): void {
    const id = typeof res.id === "number" ? res.id : undefined;
    if (id === undefined) return;
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);

    if (res.error) {
      p.reject(
        new FailureError(
          res.error.message ?? `open-device-server error ${res.error.code ?? ""}`.trim(),
          {
            error_code: FAILURE_CODES.OPEN_DEVICE_SERVER_RPC_ERROR,
            failure_stage: "open_device_server_rpc_response",
            failure_area: "tool_server",
            error_kind: "subprocess",
          }
        )
      );
    } else {
      p.resolve(res.result, stats);
    }
  }

  private destroySocket(err: Error): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
    this.rejectAll(err);
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
