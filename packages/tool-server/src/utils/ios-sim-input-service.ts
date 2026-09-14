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
 * (head of the per-UDID pending queue) otherwise. Only the default binary path
 * differs — it resolves the product this repo builds under
 * `packages/ios-sim-input/bin/sim-input`, overridable via
 * `IOS_SIM_INPUT_BINARY` (the bench sets it to the CI build output).
 *
 * Nothing here is derived from any closed argent binary.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";

export type SpawnLike = typeof nodeSpawn;

export interface IosSimInputOptions {
  /** Override the path to the sim-input binary. */
  binary?: string;
  /** Override the spawn implementation (for tests). */
  spawn?: SpawnLike;
}

export interface TapArgs {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Reserved — sim-input currently treats tap as instantaneous. */
  duration?: number;
}

export interface SwipeArgs {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  durationMs?: number;
  width?: number;
  height?: number;
}

interface PendingAck {
  id: number;
  resolve: () => void;
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

  tap(udid: string, args: TapArgs): Promise<void> {
    return this.send(udid, {
      type: "tap",
      x: args.x,
      y: args.y,
      screenWidth: args.width,
      screenHeight: args.height,
    });
  }

  swipe(udid: string, args: SwipeArgs): Promise<void> {
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

  pressKey(udid: string, key: number): Promise<void> {
    return this.send(udid, { type: "press", key });
  }

  releaseKey(udid: string, key: number): Promise<void> {
    // sim-input acks release as a no-op (press brackets down+up atomically). We
    // still go through the wire so callers can observe ordering w.r.t. other
    // queued commands.
    return this.send(udid, { type: "release", key });
  }

  typeText(udid: string, text: string): Promise<void> {
    return this.send(udid, { type: "text", text });
  }

  /**
   * Raw escape hatch — write an arbitrary envelope. The service stamps `id` onto
   * the object before writing.
   */
  send(udid: string, envelope: object): Promise<void> {
    const entry = this.ensureProc(udid);
    const id = this.nextId++;
    return new Promise<void>((resolve, reject) => {
      const stamped = { id, ...envelope };
      const line = JSON.stringify(stamped) + "\n";
      entry.pending.push({ id, resolve, reject });
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
        // eslint-disable-next-line no-console
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
    let obj: { id?: number; ok?: boolean; error?: string };
    try {
      obj = JSON.parse(line);
    } catch {
      // eslint-disable-next-line no-console
      console.error("[sim-input] failed to parse ack line: %s", line);
      return;
    }
    const ok = obj.ok === true;
    const err = obj.error ?? "sim-input reported failure";

    if (typeof obj.id === "number") {
      const idx = entry.pending.findIndex((p) => p.id === obj.id);
      if (idx < 0) {
        // eslint-disable-next-line no-console
        console.error("[sim-input] no pending entry for ack id=%d", obj.id);
        return;
      }
      const pending = entry.pending.splice(idx, 1)[0]!;
      if (ok) pending.resolve();
      else pending.reject(new Error(err));
      return;
    }

    // FIFO fallback.
    const pending = entry.pending.shift();
    if (!pending) {
      // eslint-disable-next-line no-console
      console.error("[sim-input] received ack with empty pending queue");
      return;
    }
    if (ok) pending.resolve();
    else pending.reject(new Error(err));
  }

  private rejectAll(entry: ProcEntry, err: Error): void {
    const pending = entry.pending.splice(0, entry.pending.length);
    for (const p of pending) {
      p.reject(err);
    }
  }
}
