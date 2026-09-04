import type * as net from "node:net";
import { performance } from "node:perf_hooks";

/**
 * Frame a newline-delimited JSON socket on the `\n` byte and nothing else.
 *
 * `readline.createInterface` splits on the four ECMAScript line terminators —
 * `\n`, `\r`, U+2028 and U+2029. JSON permits U+2028/U+2029 unescaped inside a
 * string, and the device daemons (NSJSONSerialization, org.json) emit them
 * raw, so a perfectly valid reply carrying one — any accessibility label with a
 * rich-text line separator — was cut into fragments none of which parsed, and
 * its RPC waited out the timeout. A `\n` byte can never occur inside a
 * multi-byte UTF-8 sequence, so splitting on it alone is exact.
 *
 * Every frame that fails to parse is reported through `onDropped` rather than
 * vanishing: a silent drop is what turned a framing defect into a
 * fifteen-second mystery.
 */
/**
 * Per-frame wire stats handed to `onMessage` alongside the parsed message:
 * `bytes` is the UTF-8 byte length of the raw NDJSON line (the on-the-wire size
 * of this reply, before `JSON.parse` drops it), `parseMs` the `JSON.parse` cost.
 * `firstByteAt`/`lastByteAt` are `performance.now()` timestamps for the socket
 * `data` event that began this frame's accumulation and the one that completed it
 * (its `\n`), so a caller can split time-to-first-byte from the receive/streaming
 * span of a large reply (phase 3i). Other consumers ignore the second argument.
 */
export interface NdjsonFrameStats {
  bytes: number;
  parseMs: number;
  firstByteAt: number;
  lastByteAt: number;
}

interface NdjsonReaderHandlers {
  onMessage: (msg: unknown, stats: NdjsonFrameStats) => void;
  onDropped: (info: { bytes: number; preview: string }) => void;
}

const PREVIEW_CHARS = 80;

function preview(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const printable = raw.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, "·");
  return printable.length > PREVIEW_CHARS ? `${printable.slice(0, PREVIEW_CHARS)}…` : printable;
}

/** The conventional `onDropped`: one stderr line tagged with the owning service. */
export function reportDroppedFrameToStderr(tag: string): NdjsonReaderHandlers["onDropped"] {
  return ({ bytes, preview }) => {
    process.stderr.write(`[${tag}] dropped unparseable frame (${bytes} bytes): ${preview}\n`);
  };
}

export function attachNdjsonReader(socket: net.Socket, handlers: NdjsonReaderHandlers): void {
  socket.setEncoding("utf8");
  let buf = "";
  // `performance.now()` of the socket `data` event that first contributed bytes to
  // the frame now accumulating in `buf`; null between frames. Lets a frame report
  // its time-to-first-byte separately from its receive span (phase 3i).
  let frameStartAt: number | null = null;

  const deliver = (raw: string, firstByteAt: number, lastByteAt: number): void => {
    if (raw.length === 0 || raw === "\r") return;
    const bytes = Buffer.byteLength(raw, "utf8");
    let msg: unknown;
    const t0 = performance.now();
    try {
      msg = JSON.parse(raw);
    } catch {
      handlers.onDropped({ bytes, preview: preview(raw) });
      return;
    }
    const parseMs = performance.now() - t0;
    handlers.onMessage(msg, { bytes, parseMs, firstByteAt, lastByteAt });
  };

  socket.on("data", (chunk: string | Buffer) => {
    const now = performance.now();
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (frameStartAt === null && buf.length > 0) frameStartAt = now;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      deliver(raw, frameStartAt ?? now, now);
      // Any bytes past the newline began arriving in THIS event; a clean buffer
      // means the next frame's first byte is still to come.
      frameStartAt = buf.length > 0 ? now : null;
    }
  });

  // Parity with readline: a final frame without a trailing newline is still
  // delivered when the peer ends the stream.
  socket.on("end", () => {
    const rest = buf;
    buf = "";
    if (rest.length > 0) {
      const now = performance.now();
      deliver(rest, frameStartAt ?? now, now);
    }
    frameStartAt = null;
  });
}
