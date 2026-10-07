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
 * (head of the per-UDID pending queue) otherwise. Every command resolves with
 * one {@link SimInputAck}: the host's `performance.now()` at the write and at
 * the ack line, the ack's `timing` block (iOS-4 ticket 1: sim-input's own
 * receive / per-message send / ack times) and, on a tap / swipe from a binary
 * with the deadline pacer, the gesture's pacing (iOS-4 ticket 3). The
 * `*WithAck` names are aliases kept for the ticket-3 callers. Only the default binary path
 * differs — it resolves the product this repo builds under
 * `packages/ios-sim-input/bin/sim-input`, overridable via
 * `IOS_SIM_INPUT_BINARY` (the bench sets it to the CI build output).
 *
 * Product use (iOS-4 ticket 5): the `IosSimInput` registry blueprint
 * (`blueprints/ios-sim-input.ts`) owns one service per simulator and turns on
 * the opt-in guards below: a per-call `timeoutMs` that drops the pending entry
 * so later calls are not stuck behind it, and a crash budget (`maxRestarts`
 * unexpected exits per `restartWindowMs`; a crashed process is restarted on the
 * next call) after which every call fails with the give-up error. Without the
 * options (the bench) the service behaves as before.
 *
 * Nothing here is derived from any closed argent binary.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

type SpawnLike = typeof nodeSpawn;

export interface IosSimInputOptions {
  /** Override the path to the sim-input binary. */
  binary?: string;
  /** Override the spawn implementation (for tests). */
  spawn?: SpawnLike;
  /**
   * Per-call ack timeout in ms. On expiry the call rejects and its pending
   * entry is dropped (a late ack for it is ignored). Unset: no timeout.
   */
  timeoutMs?: number;
  /**
   * Unexpected exits allowed per `restartWindowMs` before the service gives up
   * on a UDID; the next one fails every later call. Unset: no limit.
   */
  maxRestarts?: number;
  /** The crash budget window in ms. Default 60 000. */
  restartWindowMs?: number;
  /** Clock for the crash budget (ms). Default `Date.now`. */
  now?: () => number;
  /**
   * Shared crash history per UDID, so a new service for the same UDID (the
   * registry re-creating it) keeps counting in the same window.
   */
  crashLog?: Map<string, number[]>;
  /** Called once when a UDID runs out of its crash budget. */
  onGiveUp?: (udid: string, err: Error) => void;
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
  /** Hold at the end point this long before the lift (momentum-free swipe). */
  holdEndMs?: number;
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

/**
 * What a command resolves with. The host stamps `hostWriteAt` / `hostAckAt`
 * on every ack. Every field read from the wire is optional: `timing` is null
 * when the ack has no valid block (older binary), and the four pacing fields
 * (ms, sim-input's monotonic clock) are present only on tap / swipe acks from
 * a binary with the deadline pacer (a non-finite value on the wire is dropped).
 */
export interface SimInputAck {
  id: number;
  /** `performance.now()` just before the command line was written to stdin. */
  hostWriteAt: number;
  /** `performance.now()` when the ack line was parsed. */
  hostAckAt: number;
  /** The ack's timing block; null when the ack carried none (older binary). */
  timing: SimInputWireTiming | null;
  /** Last frame's deadline after the Down: the sum of the scheduled frames. */
  scheduledMs?: number;
  /** Down→Up as measured by sim-input. */
  actualMs?: number;
  /** `actualMs - scheduledMs`. */
  overshootMs?: number;
  /** Worst frame wake past its deadline. */
  maxFrameLateMs?: number;
}

const PACING_FIELDS = ["scheduledMs", "actualMs", "overshootMs", "maxFrameLateMs"] as const;

interface PendingAck {
  id: number;
  hostWriteAt: number;
  resolve: (ack: SimInputAck) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
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

/** The command never reached sim-input (no process, a dead pipe, a given-up udid). */
export class SimInputNotSentError extends Error {
  override readonly name = "SimInputNotSentError";
}

/**
 * The command got no ack in time. The service killed the process, so neither
 * this command nor any queued after it lands later.
 */
export class SimInputTimeoutError extends Error {
  override readonly name = "SimInputTimeoutError";
}

/**
 * Whether a sim-input stderr line may be forwarded to the tool-server log. A
 * line that can carry typed input is dropped: a binary built before the
 * per-key log was removed writes `[hid] key page=7 usage=N modifiers=[...]` per
 * character, and ASCII maps one-to-one to usage + shift, so the line would
 * rebuild the text (a resolved `{{secret:...}}` included).
 */
export function isForwardableLogLine(line: string): boolean {
  return !/\[hid\] key\b|usage=|character/i.test(line);
}

/**
 * The give-up error when `udid` already used its crash budget at `now`, else
 * null. Prunes entries older than the window.
 */
export function simInputCrashBudgetError(
  crashLog: Map<string, number[]>,
  udid: string,
  now: number,
  maxRestarts: number,
  windowMs: number
): Error | null {
  const recent = (crashLog.get(udid) ?? []).filter((t) => now - t < windowMs);
  crashLog.set(udid, recent);
  if (recent.length <= maxRestarts) return null;
  const retryInS = Math.ceil((recent[0]! + windowMs - now) / 1000);
  return new Error(
    `sim-input crashed ${recent.length} times in ${Math.round(windowMs / 1000)} s ` +
      `for ${udid}; not restarting it (retry in ${retryInS} s)`
  );
}

export class IosSimInputService {
  private readonly binary: string;
  private readonly spawnFn: SpawnLike;
  private readonly procs = new Map<string, ProcEntry>();
  private readonly timeoutMs: number | undefined;
  private readonly maxRestarts: number | undefined;
  private readonly restartWindowMs: number;
  private readonly now: () => number;
  private readonly crashLog: Map<string, number[]>;
  private readonly onGiveUp: ((udid: string, err: Error) => void) | undefined;
  /** UDIDs that ran out of crash budget, with the error every call gets. */
  private readonly givenUp = new Map<string, Error>();
  private nextId = 1;

  constructor(opts: IosSimInputOptions = {}) {
    this.binary = opts.binary ?? DEFAULT_BINARY;
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.timeoutMs = opts.timeoutMs;
    this.maxRestarts = opts.maxRestarts;
    this.restartWindowMs = opts.restartWindowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.crashLog = opts.crashLog ?? new Map();
    this.onGiveUp = opts.onGiveUp;
  }

  /** Spawn the process for `udid` now instead of on the first command. */
  start(udid: string): void {
    this.ensureProc(udid);
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

  /** Alias of `tap` (iOS-4 ticket 3 name). */
  tapWithAck(udid: string, args: TapArgs): Promise<SimInputAck> {
    return this.tap(udid, args);
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
    if (args.holdEndMs !== undefined && args.holdEndMs > 0) env.holdEndMs = args.holdEndMs;
    if (args.width !== undefined) env.screenWidth = args.width;
    if (args.height !== undefined) env.screenHeight = args.height;
    return this.send(udid, env);
  }

  /** Alias of `swipe` (iOS-4 ticket 3 name). */
  swipeWithAck(udid: string, args: SwipeArgs): Promise<SimInputAck> {
    return this.swipe(udid, args);
  }

  typeText(udid: string, text: string, opts: { timeoutMs?: number } = {}): Promise<SimInputAck> {
    return this.send(udid, { type: "text", text }, opts);
  }

  /** Alias of `send` (iOS-4 ticket 3 name). */
  sendWithAck(udid: string, envelope: object): Promise<SimInputAck> {
    return this.send(udid, envelope);
  }

  /**
   * Raw escape hatch — write an arbitrary envelope and resolve with its ack. The
   * service stamps `id` onto the object before writing. `opts.timeoutMs`
   * overrides the service's per-call timeout (a long `text` needs more than a
   * tap). A failure before the line is written rejects with
   * {@link SimInputNotSentError}; a timeout with {@link SimInputTimeoutError}.
   */
  send(udid: string, envelope: object, opts: { timeoutMs?: number } = {}): Promise<SimInputAck> {
    let entry: ProcEntry;
    try {
      entry = this.ensureProc(udid);
    } catch (err) {
      return Promise.reject(
        new SimInputNotSentError(err instanceof Error ? err.message : String(err))
      );
    }
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    return new Promise<SimInputAck>((resolve, reject) => {
      const stamped = { id, ...envelope };
      const line = JSON.stringify(stamped) + "\n";
      const hostWriteAt = performance.now();
      const pending: PendingAck = { id, hostWriteAt, resolve, reject };
      entry.pending.push(pending);
      const drop = (): void => {
        if (pending.timer) clearTimeout(pending.timer);
        const idx = entry.pending.indexOf(pending);
        if (idx >= 0) entry.pending.splice(idx, 1);
      };
      const stdin = entry.proc.stdin;
      if (!stdin || stdin.destroyed) {
        drop();
        reject(new SimInputNotSentError("sim-input stdin is not writable"));
        return;
      }
      if (timeoutMs !== undefined) {
        const type = (envelope as { type?: unknown }).type;
        pending.timer = setTimeout(() => {
          this.abortOnTimeout(
            udid,
            entry,
            new SimInputTimeoutError(
              `sim-input ${typeof type === "string" ? type : "command"} timed out after ${timeoutMs} ms`
            )
          );
        }, timeoutMs);
      }
      stdin.write(line, (err) => {
        if (err) {
          drop();
          reject(new SimInputNotSentError(err.message));
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
    const gaveUp = this.givenUp.get(udid);
    if (gaveUp) throw gaveUp;

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
        if (line.length === 0 || !isForwardableLogLine(line)) continue;
        console.error("[sim-input %s] %s", udid, line);
      }
    });

    proc.on("exit", (code, signal) => {
      const current = this.procs.get(udid);
      // Still registered = nobody called stop(): an unexpected exit (crash).
      const crashed = current === entry;
      if (crashed) {
        this.procs.delete(udid);
      }
      const reason = signal
        ? `sim-input exited (signal=${signal})`
        : `sim-input exited (code=${code})`;
      this.rejectAll(entry, new Error(reason));
      if (crashed) this.recordCrash(udid);
    });

    proc.on("error", (err) => {
      // A spawn failure (ENOENT, EACCES) may emit no "exit": unregister here so
      // the next call does not write into a dead process.
      const crashed = this.procs.get(udid) === entry;
      if (crashed) this.procs.delete(udid);
      this.rejectAll(entry, err);
      if (crashed) this.recordCrash(udid);
    });

    return entry;
  }

  private handleAckLine(entry: ProcEntry, line: string): void {
    const hostAckAt = performance.now();
    let obj: { id?: number; ok?: boolean; error?: string; timing?: unknown } & Record<
      string,
      unknown
    >;
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
      if (pending.timer) clearTimeout(pending.timer);
      if (ok) {
        pending.resolve({
          id: pending.id,
          hostWriteAt: pending.hostWriteAt,
          hostAckAt,
          timing,
          ...parsePacing(obj),
        });
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
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
  }

  /**
   * A call timed out: kill the process (SIGKILL) and reject every pending call
   * with `err`, so no queued command lands after the caller fell back. Counts
   * as a crash; the next call starts a new process.
   */
  private abortOnTimeout(udid: string, entry: ProcEntry, err: Error): void {
    if (this.procs.get(udid) === entry) this.procs.delete(udid);
    this.rejectAll(entry, err);
    try {
      entry.proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
    this.recordCrash(udid);
  }

  /** Count an unexpected exit; past the budget, give up on `udid`. */
  private recordCrash(udid: string): void {
    if (this.maxRestarts === undefined) return;
    const now = this.now();
    this.crashLog.set(udid, [...(this.crashLog.get(udid) ?? []), now]);
    const err = simInputCrashBudgetError(
      this.crashLog,
      udid,
      now,
      this.maxRestarts,
      this.restartWindowMs
    );
    if (!err || this.givenUp.has(udid)) return;
    this.givenUp.set(udid, err);
    console.error("[sim-input %s] %s", udid, err.message);
    this.onGiveUp?.(udid, err);
  }
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The finite numeric pacing fields of a tap / swipe ack. */
function parsePacing(
  raw: Record<string, unknown>
): Pick<SimInputAck, (typeof PACING_FIELDS)[number]> {
  const out: Pick<SimInputAck, (typeof PACING_FIELDS)[number]> = {};
  for (const key of PACING_FIELDS) {
    const v = raw[key];
    if (isNum(v)) out[key] = v;
  }
  return out;
}

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
