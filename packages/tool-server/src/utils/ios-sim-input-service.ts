/**
 * IosSimInputService — long-lived `sim-input` child process per UDID with a
 * per-call FIFO ack queue. It is the host driver for the **ON-siminput** bench
 * arm: it speaks the same id-stamped JSONL wire as the `sim-input` Swift CLI
 * under `packages/ios-sim-input/` (tap / swipe / press / release / text over
 * JSON lines on stdin, `{id, ok}` acks on stdout).
 *
 * Ported from the owner's `device-farm/device-stream`
 * `packages/ios-simulator/src/input-service.ts` (the driver that pairs with the
 * same Swift CLI). Behaviour is unchanged: the service stamps a monotonic `id`
 * onto every command, matches acks by `id` when present, and falls back to FIFO
 * (head of the per-UDID pending queue) otherwise. Since iOS-4 ticket 1 every
 * command resolves with a {@link SimInputAck}: the ack's `timing` block
 * (sim-input's own receive / per-message send / ack times) plus the host's
 * `performance.now()` at the write and at the ack line. Only the default binary path
 * differs — it resolves the product this repo builds under
 * `packages/ios-sim-input/bin/sim-input`, overridable via
 * `IOS_SIM_INPUT_BINARY` (the bench sets it to the CI build output).
 *
 * Nothing here is derived from any closed argent binary.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

type SpawnLike = typeof nodeSpawn;

interface IosSimInputOptions {
  /** Override the path to the sim-input binary. */
  binary?: string;
  /** Override the spawn implementation (for tests). */
  spawn?: SpawnLike;
}

interface TapArgs {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Reserved — sim-input currently treats tap as instantaneous. */
  duration?: number;
  /** Down→Up hold in ms; sim-input defaults to 50 when omitted. */
  holdMs?: number;
}

interface SwipeArgs {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  durationMs?: number;
  width?: number;
  height?: number;
}

/** The ack line's `timing` block, in ms on the sim-input process's monotonic
 * clock (only differences are meaningful; not comparable to the host clock). */
export interface SimInputWireTiming {
  /** The command line was read off stdin. */
  recvAt: number;
  /** One entry per HID message sent for the command, in order. */
  sends: Array<{ sendStart: number; sendEnd: number }>;
  /** Just before the ack line was written. */
  ackAt: number;
}

/** What a command resolves with. */
export interface SimInputAck {
  id: number;
  /** `performance.now()` just before the command line was written to stdin. */
  hostWriteAt: number;
  /** `performance.now()` when the ack line was parsed. */
  hostAckAt: number;
  /** The ack's timing block; null when the ack carried none (older binary). */
  timing: SimInputWireTiming | null;
}

interface PendingAck {
  id: number;
  hostWriteAt: number;
  resolve: (ack: SimInputAck) => void;
  reject: (err: Error) => void;
}

interface ProcEntry {
  proc: ChildProcess;
  pending: PendingAck[];
  buffer: string;
}

// Default: the product built by packages/ios-sim-input/scripts/build-sim-input.sh.
// From dist/utils this resolves to <repo>/packages/ios-sim-input/bin/sim-input.
const DEFAULT_BINARY =
  process.env.IOS_SIM_INPUT_BINARY ??
  path.resolve(__dirname, "..", "..", "..", "ios-sim-input", "bin", "sim-input");

export class IosSimInputService {
  private readonly binary: string;
  private readonly spawnFn: SpawnLike;
  private readonly procs = new Map<string, ProcEntry>();
  private nextId = 1;

  constructor(opts: IosSimInputOptions = {}) {
    this.binary = opts.binary ?? DEFAULT_BINARY;
    this.spawnFn = opts.spawn ?? nodeSpawn;
  }

  // ---- public surface ----

  tap(udid: string, args: TapArgs): Promise<SimInputAck> {
    return this.send(udid, {
      type: "tap",
      x: args.x,
      y: args.y,
      screenWidth: args.width,
      screenHeight: args.height,
      ...(args.holdMs !== undefined ? { holdMs: args.holdMs } : {}),
    });
  }

  swipe(udid: string, args: SwipeArgs): Promise<SimInputAck> {
    const env: Record<string, unknown> = {
      type: "swipe",
      fromX: args.fromX,
      fromY: args.fromY,
      toX: args.toX,
      toY: args.toY,
      durationMs: args.durationMs ?? 250,
    };
    if (args.width !== undefined) env.screenWidth = args.width;
    if (args.height !== undefined) env.screenHeight = args.height;
    return this.send(udid, env);
  }

  typeText(udid: string, text: string): Promise<SimInputAck> {
    return this.send(udid, { type: "text", text });
  }

  /**
   * Raw escape hatch — write an arbitrary envelope. The service stamps `id` onto
   * the object before writing.
   */
  send(udid: string, envelope: object): Promise<SimInputAck> {
    const entry = this.ensureProc(udid);
    const id = this.nextId++;
    return new Promise<SimInputAck>((resolve, reject) => {
      const stamped = { id, ...envelope };
      const line = JSON.stringify(stamped) + "\n";
      const hostWriteAt = performance.now();
      entry.pending.push({ id, hostWriteAt, resolve, reject });
      const stdin = entry.proc.stdin;
      if (!stdin || stdin.destroyed) {
        const idx = entry.pending.findIndex((p) => p.id === id);
        if (idx >= 0) entry.pending.splice(idx, 1);
        reject(new Error("sim-input stdin is not writable"));
        return;
      }
      stdin.write(line, (err) => {
        if (err) {
          const idx = entry.pending.findIndex((p) => p.id === id);
          if (idx >= 0) entry.pending.splice(idx, 1);
          reject(err);
        }
      });
    });
  }

  async stop(udid: string): Promise<void> {
    const entry = this.procs.get(udid);
    if (!entry) return;
    this.procs.delete(udid);
    this.rejectAll(entry, new Error("sim-input stopped"));
    try {
      entry.proc.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }

  async stopAll(): Promise<void> {
    const udids = Array.from(this.procs.keys());
    await Promise.all(udids.map((u) => this.stop(u)));
  }

  // ---- internals ----

  private ensureProc(udid: string): ProcEntry {
    const existing = this.procs.get(udid);
    if (existing) return existing;

    const proc = this.spawnFn(this.binary, ["--udid", udid]);
    const entry: ProcEntry = { proc, pending: [], buffer: "" };
    this.procs.set(udid, entry);

    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => {
      entry.buffer += chunk;
      let idx: number;
      while ((idx = entry.buffer.indexOf("\n")) >= 0) {
        const line = entry.buffer.slice(0, idx);
        entry.buffer = entry.buffer.slice(idx + 1);
        if (line.length === 0) continue;
        this.handleAckLine(entry, line);
      }
    });

    proc.stderr?.setEncoding("utf-8");
    let errBuf = "";
    proc.stderr?.on("data", (chunk: string) => {
      errBuf += chunk;
      let idx: number;
      while ((idx = errBuf.indexOf("\n")) >= 0) {
        const line = errBuf.slice(0, idx);
        errBuf = errBuf.slice(idx + 1);
        if (line.length === 0) continue;
        console.error("[sim-input %s] %s", udid, line);
      }
    });

    proc.on("exit", (code, signal) => {
      const current = this.procs.get(udid);
      if (current === entry) {
        this.procs.delete(udid);
      }
      const reason = signal
        ? `sim-input exited (signal=${signal})`
        : `sim-input exited (code=${code})`;
      this.rejectAll(entry, new Error(reason));
    });

    proc.on("error", (err) => {
      this.rejectAll(entry, err);
    });

    return entry;
  }

  private handleAckLine(entry: ProcEntry, line: string): void {
    const hostAckAt = performance.now();
    let obj: { id?: number; ok?: boolean; error?: string; timing?: unknown };
    try {
      obj = JSON.parse(line);
    } catch {
      console.error("[sim-input] failed to parse ack line: %s", line);
      return;
    }
    const ok = obj.ok === true;
    const err = obj.error ?? "sim-input reported failure";
    const timing = parseWireTiming(obj.timing);
    const settle = (pending: PendingAck): void => {
      if (ok) {
        pending.resolve({ id: pending.id, hostWriteAt: pending.hostWriteAt, hostAckAt, timing });
      } else {
        pending.reject(new Error(err));
      }
    };

    if (typeof obj.id === "number") {
      const idx = entry.pending.findIndex((p) => p.id === obj.id);
      if (idx < 0) {
        console.error("[sim-input] no pending entry for ack id=%d", obj.id);
        return;
      }
      settle(entry.pending.splice(idx, 1)[0]!);
      return;
    }

    // FIFO fallback.
    const pending = entry.pending.shift();
    if (!pending) {
      console.error("[sim-input] received ack with empty pending queue");
      return;
    }
    settle(pending);
  }

  private rejectAll(entry: ProcEntry, err: Error): void {
    const pending = entry.pending.splice(0, entry.pending.length);
    for (const p of pending) {
      p.reject(err);
    }
  }
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The ack's `timing` block when every field is a finite number, else null. */
function parseWireTiming(raw: unknown): SimInputWireTiming | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as { recvAt?: unknown; sends?: unknown; ackAt?: unknown };
  if (!isNum(t.recvAt) || !isNum(t.ackAt) || !Array.isArray(t.sends)) return null;
  const sends: SimInputWireTiming["sends"] = [];
  for (const s of t.sends as unknown[]) {
    const m = (s ?? {}) as { sendStart?: unknown; sendEnd?: unknown };
    if (!isNum(m.sendStart) || !isNum(m.sendEnd)) return null;
    sends.push({ sendStart: m.sendStart, sendEnd: m.sendEnd });
  }
  return { recvAt: t.recvAt, sends, ackAt: t.ackAt };
}
