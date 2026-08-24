/**
 * Runs one trusted local JavaScript file in a fresh Node.js child process.
 *
 * The child is a *reliability* boundary, not a security one: a script is as
 * trusted as a local npm script, and all the process buys is that an infinite
 * loop, a heap exhaustion or a `process.exit` cannot take the server down.
 */

import { fork, spawn, type ChildProcess, type ForkOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import {
  getConfigDefinition,
  getConfigValue,
  MIN_SCRIPT_HEAP_LIMIT_MB,
  type ConfigDefinition,
} from "@argent/configuration-core";
import { isElectronHostedEnv } from "../../../utils/electron-env";
import { formatErrorForAgent } from "../../../utils/format-error";
import { scrubSecretChunk, scrubSecretValues } from "../../../utils/secrets";
import { sleep } from "../../../utils/timing";
import {
  isTerminalResponse,
  parseScriptResponse,
  SCRIPT_MAX_FAILURE_MESSAGE_CHARS,
  SCRIPT_MAX_FAILURE_STACK_CHARS,
  SCRIPT_MAX_OUTPUT_BYTES,
  type ScriptExecuteRequest,
  type ScriptTerminalResponse,
} from "./flow-script-protocol";

const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;
/**
 * Counted on the bytes the report carries, not the bytes the script wrote:
 * redaction and frame collapsing both run first, so a long value shrinks to
 * its marker and a short one grows into it.
 */
export const SCRIPT_STEP_LOG_LIMIT_BYTES = 64 * 1024;
const SCRIPT_RUN_LOG_LIMIT_BYTES = 256 * 1024;
/** How long the outcome waits for the log streams once it is otherwise known. */
const SETTLE_TIMEOUT_MS = 500;
/** Grace between asking a process tree to stop and forcing it. */
const STOP_GRACE_MS = 1_500;
/**
 * How far behind the parent's timer the child's own deadline watchdog sits.
 *
 * The watchdog is the second line, for a parent that is gone or whose event
 * loop is blocked, so the margin has to be an ordinary stall wide — the tool
 * server makes synchronous calls of its own (`stop-metro` shells out to `lsof`
 * and `netstat`). Too narrow and the child SIGKILLs its own group first, so a
 * timed-out step is reported as an unexplained signal.
 */
const CHILD_DEADLINE_MARGIN_MS = 2_000;
/** How often the stop path re-checks whether a process group has emptied. */
const GROUP_POLL_MS = 50;
/** How long a forced stop waits for the kernel to finish tearing the tree down. */
const FORCE_GRACE_MS = 500;
/** Steps allowed to queue for a slot before a step is refused outright. */
const QUEUE_DEPTH_LIMIT = 32;
/** A queue wait longer than this is worth telling the caller about. */
const QUEUE_WAIT_REPORT_MS = 5_000;
/** A partial stderr line longer than this is passed through unclassified. */
const MAX_BUFFERED_LINE_CHARS = 8 * 1024;
/**
 * V8's heap-exhaustion banner. Coarse on purpose: the wording is not a
 * stability contract, and an unrecognized abort degrades to the signal report
 * rather than to a wrong verdict.
 */
const V8_HEAP_FATAL_RE = /FATAL ERROR:[^\n]*(?:heap limit|heap out of memory|Allocation failed)/i;
/** Enough of the stream to hold a banner split across two pipe chunks. */
const HEAP_FATAL_WINDOW_CHARS = 256;

const RUNNER_FILE = "flow-script-runner.mjs";

/** Marks the one process the runner preload may activate in. See `buildChildEnv`. */
const RUNNER_ACTIVATION_ENV = "ARGENT_FLOW_SCRIPT_RUNNER";

/**
 * An allowlist rather than a denylist because what it must keep out — the
 * bearer token, the port, every `ARGENT_SECRET_*` value — is exactly the set
 * that grows without this file being touched. Leak hygiene, not containment: a
 * script can read `~/.argent/tool-server.json` itself.
 */
const ALLOWED_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USER",
  "LOGNAME",
  "USERNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  // `SystemRoot` is required for DNS and crypto on Windows — a script that
  // makes any network call fails without it.
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "PUBLIC",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Without these, a host using fnm, asdf, mise or volta runs against a
  // different Node than the developer's shell, or against none at all.
  "NODE_PATH",
  "NVM_DIR",
  "NVM_BIN",
  "FNM_DIR",
  "FNM_MULTISHELL_PATH",
  "ASDF_DIR",
  "ASDF_DATA_DIR",
  "MISE_DATA_DIR",
  "VOLTA_HOME",
  "PNPM_HOME",
  "COREPACK_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "ANDROID_AVD_HOME",
  "ANDROID_USER_HOME",
  "JAVA_HOME",
  "GRADLE_USER_HOME",
  "DEVELOPER_DIR",
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "CI",
];

/** Copied so a project's npm settings survive. */
const ALLOWED_ENV_PREFIXES: readonly string[] = ["npm_config_"];

/**
 * npm's own spelling of `NODE_OPTIONS`: it translates its `node-options` config
 * key back into the variable for what it starts, so the `npm_config_` prefix
 * would carry through what the exact name is reserved to keep out. Matched
 * case-insensitively on every platform, as npm reads its config names.
 */
const NPM_NODE_OPTIONS_ENV = "npm_config_node_options";

/**
 * Refused in a caller-supplied environment map, because each steers the
 * runner's own process: `NODE_CHANNEL_FD` and `NODE_UNIQUE_ID` name the IPC
 * channel this protocol runs on, `ELECTRON_RUN_AS_NODE` decides whether the
 * child boots as Node at all, and the activation flag decides which process
 * the runner preload takes over.
 */
const RESERVED_ENV_NAMES: readonly string[] = [
  "NODE_CHANNEL_FD",
  "NODE_UNIQUE_ID",
  "NODE_OPTIONS",
  NPM_NODE_OPTIONS_ENV,
  "ELECTRON_RUN_AS_NODE",
  RUNNER_ACTIVATION_ENV,
];

/** A resolved secret whose value must never reach a report. */
export interface FlowScriptSecret {
  name: string;
  value: string;
}

/** The log allowance shared by every script step in one flow run. */
export interface FlowScriptLogBudget {
  remainingBytes: number;
}

export function createScriptLogBudget(): FlowScriptLogBudget {
  return { remainingBytes: SCRIPT_RUN_LOG_LIMIT_BYTES };
}

export interface FlowScriptRequest {
  /** Resolved against the working directory when relative. */
  scriptPath: string;
  /** Handed to the script as its `output` global. */
  output?: Record<string, unknown>;
  /** Layered on top of the allowlist. */
  env?: Record<string, string>;
  /** Defaults to 30s, clamped to the configured maximum. */
  timeoutMs?: number;
  /** The caller's `project_root` — first choice for the working directory. */
  projectRoot?: string;
  /** The working-directory fallback. */
  flowDir?: string;
  /** Re-read on every chunk, so a set that grows mid-step is respected. */
  secrets?: readonly FlowScriptSecret[];
  /** Omitted ⇒ only the per-step limit applies. */
  logBudget?: FlowScriptLogBudget;
  /** A queued step gives up its position at once. */
  signal?: AbortSignal;
  /** Test seam: the directory holding the runner and watchdog `.mjs` files. */
  runnerDir?: string;
}

export type FlowScriptFailureKind =
  /** The module never evaluated — missing file, bad syntax, a refused import. */
  | "load"
  /** The script's own code threw. */
  | "runtime"
  /** The value in `output` cannot cross into flow state. */
  | "output"
  /** The runner misbehaved, or never reached the script. */
  | "protocol"
  | "timeout"
  | "cancelled"
  /** The script stopped its own process, or reported failure through its exit code. */
  | "exit"
  /** Killed by a signal it did not choose. */
  | "signal"
  | "heap"
  /** The child could not be started at all. */
  | "spawn"
  /** The step never got a concurrency slot. */
  | "queue"
  | "invalid";

export interface FlowScriptFailure {
  kind: FlowScriptFailureKind;
  message: string;
  stack?: string;
}

export interface FlowScriptResult {
  /** True only when the script returned a valid output document. */
  ok: boolean;
  /** Present exactly when `ok`. */
  output?: Record<string, unknown>;
  /** Present exactly when not `ok`. */
  failure?: FlowScriptFailure;
  /** stdout and stderr in written order, redacted and possibly truncated. */
  log: string;
  logTruncated: boolean;
  /** Excludes the queue wait. */
  durationMs: number;
  queuedMs: number;
  /** Things worth telling the caller that are not failures. */
  notes: string[];
}

export interface FlowScriptExecutorOptions {
  /** Defaults to a CPU-derived limit. */
  concurrency?: number;
  /** Overrides `scripts.maxTimeoutMs`. */
  maxTimeoutMs?: number;
  /** Overrides `scripts.heapLimitMb`. */
  heapLimitMb?: number;
  /** Defaults to twice the maximum script time limit. */
  queueWaitMs?: number;
}

interface ResolvedBounds {
  concurrency: number;
  maxTimeoutMs: number;
  heapLimitMb: number;
}

interface QueueWaiter {
  grant: () => void;
  refuse: (err: Error) => void;
  settled: boolean;
}

/**
 * Separate from a queue refusal so the caller can tell "you stopped it" from
 * "the host was full".
 */
class ScriptCancelledError extends Error {}

/** A request that cannot be turned into a spawn. Carries its own verdict kind. */
class ScriptSetupError extends Error {
  constructor(
    readonly kind: FlowScriptFailureKind,
    message: string
  ) {
    super(message);
    this.name = "ScriptSetupError";
  }
}

export class FlowScriptExecutor {
  private running = 0;
  private readonly waiting: QueueWaiter[] = [];
  private bounds: ResolvedBounds | undefined;

  constructor(private readonly options: FlowScriptExecutorOptions = {}) {}

  /**
   * Read once per executor rather than per step: the configured bounds only
   * change with a server restart, so a step should not go to the filesystem.
   */
  private resolveBounds(): ResolvedBounds {
    if (!this.bounds) {
      this.bounds = {
        // `positive` rather than `??`: `concurrency: 0` is not nullish, and
        // would queue every step until the wait bound refused it.
        concurrency: positive(this.options.concurrency) ?? defaultConcurrency(),
        // Capped at the largest delay `setTimeout` can hold: past that Node
        // clamps the timer to 1ms, so every script would "time out" at once.
        maxTimeoutMs: Math.min(
          MAX_TIMER_MS,
          positive(this.options.maxTimeoutMs) ??
            configuredNumber("scripts.maxTimeoutMs") ??
            5 * 60_000
        ),
        // Floored, not just defaulted: a heap too small to start V8 fails
        // during the child's own startup, naming neither this bound nor the
        // value that caused it.
        heapLimitMb: Math.max(
          MIN_SCRIPT_HEAP_LIMIT_MB,
          positive(this.options.heapLimitMb) ?? configuredNumber("scripts.heapLimitMb") ?? 512
        ),
      };
    }
    return this.bounds;
  }

  get activeCount(): number {
    return this.running;
  }

  async execute(request: FlowScriptRequest): Promise<FlowScriptResult> {
    const bounds = this.resolveBounds();
    const queueStarted = Date.now();
    let release: (() => void) | undefined;
    try {
      release = await this.acquireSlot(
        request.signal,
        Math.min(MAX_TIMER_MS, positive(this.options.queueWaitMs) ?? bounds.maxTimeoutMs * 2)
      );
    } catch (err) {
      const queuedMs = Date.now() - queueStarted;
      return err instanceof ScriptCancelledError
        ? emptyResult({ kind: "cancelled", message: err.message }, { queuedMs })
        : emptyResult({ kind: "queue", message: errorMessage(err) }, { queuedMs });
    }
    const queuedMs = Date.now() - queueStarted;
    try {
      const result = await this.runOne(request, bounds);
      result.queuedMs = queuedMs;
      if (queuedMs > QUEUE_WAIT_REPORT_MS) {
        result.notes.push(
          `Waited ${(queuedMs / 1000).toFixed(1)}s for a free script slot ` +
            `(${bounds.concurrency} scripts run at once on this host).`
        );
      }
      return result;
    } finally {
      release();
    }
  }

  // One tool server serves every local agent and project, so the limit protects
  // the host rather than one script's throughput. The queue bounds stop an
  // unbounded queue; they are not tuned to shape normal use.
  private acquireSlot(signal: AbortSignal | undefined, waitBoundMs: number): Promise<() => void> {
    // Idempotent: a double release would leave `running` below the live
    // process count, permanently raising the effective limit.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.running -= 1;
      this.drain();
    };
    if (signal?.aborted) {
      return Promise.reject(
        new ScriptCancelledError("The run was cancelled before the script started.")
      );
    }
    if (this.running < this.resolveBounds().concurrency) {
      this.running += 1;
      return Promise.resolve(release);
    }
    if (this.waiting.length >= QUEUE_DEPTH_LIMIT) {
      return Promise.reject(
        new Error(
          `${QUEUE_DEPTH_LIMIT} script steps are already waiting for a free slot on this ` +
            `tool server; the queue is full. This host is saturated — nothing was run.`
        )
      );
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: QueueWaiter = {
        settled: false,
        grant: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          cleanup();
          resolve(release);
        },
        refuse: (err) => {
          if (waiter.settled) return;
          waiter.settled = true;
          cleanup();
          remove();
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        waiter.refuse(
          new Error(
            `Timed out after ${describeDuration(waitBoundMs)} waiting for a free script ` +
              `slot on this tool server. This host is saturated — nothing was run.`
          )
        );
      }, waitBoundMs);
      const onAbort = () => {
        waiter.refuse(
          new ScriptCancelledError("The run was cancelled while the script waited for a slot.")
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const remove = () => {
        const at = this.waiting.indexOf(waiter);
        if (at >= 0) this.waiting.splice(at, 1);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private drain(): void {
    const limit = this.resolveBounds().concurrency;
    while (this.running < limit) {
      const waiter = this.waiting.shift();
      if (!waiter) return;
      if (waiter.settled) continue;
      this.running += 1;
      waiter.grant();
    }
  }

  private async runOne(
    request: FlowScriptRequest,
    bounds: ResolvedBounds
  ): Promise<FlowScriptResult> {
    const notes: string[] = [];
    const startedAt = Date.now();
    // An abort raised between the queue's check and this one — `const p =
    // execute(…); if (bad) controller.abort();` — lands in the gap the queue's
    // promise opens up. Nothing spawns for it.
    if (request.signal?.aborted) {
      return emptyResult(
        { kind: "cancelled", message: "The run was cancelled before the script started." },
        { notes }
      );
    }
    let cwd: string;
    let env: NodeJS.ProcessEnv;
    let runnerPath: string;
    let outputJson: string;
    try {
      cwd = resolveWorkingDirectory(request, notes);
      env = buildChildEnv(request.env);
      runnerPath = resolveRunnerPath(request.runnerDir);
      // Before the fork, and inside this guard: a cyclic or BigInt document
      // makes `JSON.stringify` throw, and throwing after the fork would reject
      // `execute` instead of returning a verdict, leaving a child running until
      // the time limit reaped it.
      outputJson = encodeRequestOutput(request.output);
    } catch (err) {
      const kind = err instanceof ScriptSetupError ? err.kind : "spawn";
      return emptyResult(
        { kind, message: errorMessage(err) },
        { notes, durationMs: Date.now() - startedAt }
      );
    }

    const timeoutMs = clampTimeout(request.timeoutMs, bounds.maxTimeoutMs, notes);
    const capture = new ScriptLogCapture(
      () => request.secrets ?? [],
      SCRIPT_STEP_LOG_LIMIT_BYTES,
      request.logBudget
    );

    // The real path, not just the absolute one: Node resolves an entry module
    // through `realpath` and the runner re-imports that URL, so a different
    // spelling of the same file would be a second module and the script would
    // run twice.
    const scriptPath = realPathOrSelf(path.resolve(cwd, request.scriptPath));

    let child: ChildProcess;
    try {
      // `windowsHide` is a documented `fork` option that this @types/node
      // release does not carry on ForkOptions; widen rather than drop it.
      const forkOptions: ForkOptions & { windowsHide?: boolean } = {
        cwd,
        env,
        // Set, never appended to: `fork` defaults `execArgv` to the parent's,
        // which would carry a dev-mode parent's ts-node/vitest loaders and any
        // inspector flag into every script process.
        //
        // The runner rides in as a preload, not as the entry module, so the
        // *script* is what `process.argv[1]`/`require.main` name and an "am I
        // the main module?" guard runs its body. Node awaits an `--import`
        // module before the entry, which leaves room for the handshake.
        execArgv: [
          `--max-old-space-size=${bounds.heapLimitMb}`,
          "--import",
          pathToFileURL(runnerPath).href,
        ],
        // Index 4 is the lifeline: a pipe the parent holds open and never uses.
        // Its closing is how a runner learns its parent is gone.
        stdio: ["ignore", "pipe", "pipe", "ipc", "pipe"],
        // On POSIX the runner leads its own process group so a group stop
        // aimed at the tool server does not also stop it, and so a group stop
        // aimed at the runner reaches its descendants. Windows has no such
        // group; `taskkill /T` covers the tree there instead.
        detached: process.platform !== "win32",
        windowsHide: process.platform === "win32",
      };
      child = fork(scriptPath, [], forkOptions);
    } catch (err) {
      return emptyResult(
        { kind: "spawn", message: `Could not start the script process: ${errorMessage(err)}` },
        { notes, durationMs: Date.now() - startedAt }
      );
    }

    // Unref'd because the lifeline end holds a reference on the tool server's
    // event loop, which would keep the server alive past its idle shutdown.
    // Never read from or write to it — the runner only watches for its close.
    const lifeline = child.stdio[4] as
      | { unref?: () => void; destroy?: () => void }
      | null
      | undefined;
    lifeline?.unref?.();

    let startedSeen = false;
    let terminal: ScriptTerminalResponse | null = null;
    let protocolProblem: string | null = null;
    let spawnProblem: string | null = null;
    let interrupted: "timeout" | "cancelled" | null = null;
    /** See {@link interrupt}. Closes the window in which a verdict still counts. */
    let interruptionSealed = false;

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", (err) => {
          spawnProblem ??= `Could not start the script process: ${errorMessage(err)}`;
          resolve({ code: null, signal: null });
        });
      }
    );
    // `close` fires once every stdio stream AND the IPC channel have closed, so
    // it is the point at which no further message or log byte can arrive.
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

    // The one cleanup path, whatever ended the step: a script's descendants are
    // reparented rather than stopped, so a step that returned normally has to
    // reap them too.
    let stopped: Promise<void> | undefined;
    const stop = () => (stopped ??= stopProcessTree(child, STOP_GRACE_MS));

    /**
     * `??=` because the first interruption is the true one: a script that
     * survives SIGTERM until its deadline passes was cancelled, not timed out.
     *
     * The seal keeps a stop from being reported as a pass: a script with the
     * ordinary SIGTERM handler empties its event loop and lets the runner
     * report a half-written document as a result. Sealing and the kill share
     * one check-phase callback, in that order, so a message answering the
     * SIGTERM cannot precede the seal, while one already readable is delivered
     * in the same iteration's poll phase.
     */
    const interrupt = (why: "timeout" | "cancelled") => {
      interrupted ??= why;
      setImmediate(() => {
        interruptionSealed = true;
        void stop();
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => capture.push("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture.push("stderr", chunk));

    child.on("message", (raw) => {
      // A second terminal response is ignored rather than obeyed: the run
      // already has its verdict, and a runner still talking after it finished
      // is no longer following the protocol.
      if (terminal) return;
      const message = parseScriptResponse(raw);
      if (!message) {
        protocolProblem ??= `The script runner sent a message the executor does not recognise: ${describeUnknown(raw)}`;
        void stop();
        return;
      }
      if (!isTerminalResponse(message)) {
        startedSeen = true;
        return;
      }
      // A verdict the stop had time to produce is the stop's, not the script's.
      // See `interrupt`.
      if (interruptionSealed) return;
      terminal = message;
    });

    // Kept beside the timer, because the timer is not proof the limit passed: a
    // stall in the tool server's own event loop holds its callback behind
    // whatever the poll phase already has ready. See `classifyOutcome`.
    const deadlineAt = Date.now() + timeoutMs;
    const timer = setTimeout(() => interrupt("timeout"), timeoutMs);
    const onAbort = () => interrupt("cancelled");
    request.signal?.addEventListener("abort", onAbort, { once: true });
    // `addEventListener` never fires for a signal that aborted before it was
    // attached, and nothing else re-reads the flag.
    if (request.signal?.aborted) onAbort();

    const message: ScriptExecuteRequest = {
      type: "execute",
      scriptUrl: pathToFileURL(scriptPath).href,
      outputJson,
      deadlineMs: timeoutMs + CHILD_DEADLINE_MARGIN_MS,
      maxOutputBytes: SCRIPT_MAX_OUTPUT_BYTES,
    };
    try {
      child.send(message, (err) => {
        if (!err) return;
        // The channel died before the script could be named. The child can do
        // nothing useful without the request, so stop it rather than wait out
        // its time limit.
        protocolProblem ??= `The script runner closed its channel before the request arrived: ${errorMessage(err)}`;
        void stop();
      });
    } catch (err) {
      protocolProblem ??= `The script runner could not be given its request: ${errorMessage(err)}`;
      void stop();
    }

    const exit = await exited;
    const deadlinePassed = Date.now() >= deadlineAt;
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);

    // The protocol runs on IPC and the logs on the standard streams, with no
    // shared order between them: a terminal message routinely arrives *before*
    // the log text of the same script. The bound covers a descendant that
    // inherited the streams and is holding them open.
    await Promise.race([closed, sleep(SETTLE_TIMEOUT_MS)]);
    // On a passing step this is the only cleanup there is: on POSIX the process
    // group outlives the runner, so a descendant still holding a port is reaped
    // here. One that deliberately left the group is out of reach on purpose.
    // Windows has nothing for `taskkill` to walk from once the child is gone,
    // so a descendant of a normally-returning step survives there.
    await stop();
    capture.end();
    child.stdout?.destroy();
    child.stderr?.destroy();
    lifeline?.destroy?.();
    if (child.connected) child.disconnect();

    const log = capture.text;
    const verdict = redactSecrets(
      classifyOutcome({
        exit,
        spawnProblem,
        protocolProblem,
        terminal,
        startedSeen,
        interrupted,
        timeoutMs,
        deadlinePassed,
        heapFatalSeen: capture.heapFatalSeen,
        heapLimitMb: bounds.heapLimitMb,
      }),
      request.secrets ?? []
    );

    return {
      ...verdict,
      log,
      logTruncated: capture.truncated,
      durationMs: Date.now() - startedAt,
      queuedMs: 0,
      notes,
    };
  }
}

let shared: FlowScriptExecutor | undefined;

/** The tool server's one executor — the concurrency limit is per server. */
export function flowScriptExecutor(): FlowScriptExecutor {
  shared ??= new FlowScriptExecutor();
  return shared;
}

interface ClassifyInput {
  exit: { code: number | null; signal: NodeJS.Signals | null };
  spawnProblem: string | null;
  protocolProblem: string | null;
  terminal: ScriptTerminalResponse | null;
  startedSeen: boolean;
  interrupted: "timeout" | "cancelled" | null;
  timeoutMs: number;
  /** Whether the time limit had already passed when the exit was observed. */
  deadlinePassed: boolean;
  heapFatalSeen: boolean;
  heapLimitMb: number;
}

/**
 * The exit is read *together with* the messages received, never alone: a
 * process killed by a signal did not choose to stop, and reporting that as
 * self-termination sends the author to the wrong line of code.
 */
function classifyOutcome(
  input: ClassifyInput
): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  const { exit } = input;
  if (input.spawnProblem) return failed("spawn", input.spawnProblem);
  if (input.protocolProblem) return failed("protocol", input.protocolProblem);

  // A verdict the script produced before the stop had a turn to take effect
  // outranks the interruption, for a cancel exactly as for a timeout;
  // `interrupt` in `runOne` is where that line is drawn.
  if (input.terminal) {
    if (input.terminal.type === "failure") {
      // Re-clamped: the child bounds both fields before sending, but must not
      // be trusted to stay compliant once script code has run inside it.
      return failed(
        input.terminal.failureType,
        clampText(input.terminal.message, SCRIPT_MAX_FAILURE_MESSAGE_CHARS),
        clampText(input.terminal.stack, SCRIPT_MAX_FAILURE_STACK_CHARS)
      );
    }
    return commitOutput(input.terminal.outputJson);
  }

  if (input.interrupted === "cancelled") {
    return failed("cancelled", "The run was cancelled and the script process was stopped.");
  }

  if (input.interrupted === "timeout") return timedOut(input.timeoutMs);

  // V8 does not throw when it hits the heap limit: it prints a fatal error and
  // aborts. Ahead of the `startedSeen` row because a script can exhaust the
  // heap while it is still loading its imports.
  if (isHeapAbort(exit, input.heapFatalSeen)) {
    return failed("heap", `The script exceeded its ${input.heapLimitMb} MiB heap limit.`);
  }

  if (!input.startedSeen) {
    return failed(
      "protocol",
      `The script runner exited before it started the script (${describeExit(exit)}).`
    );
  }

  if (exit.signal) {
    // The clock rather than the timer, which a stall in the tool server's own
    // event loop can hold behind the exit it is racing. Past that stall the
    // child's deadline watchdog has already killed the group, and reporting its
    // SIGKILL as unexplained sends the author looking for a killer that is the
    // step's own time limit.
    if (input.deadlinePassed) return timedOut(input.timeoutMs);
    return failed(
      "signal",
      `The script process was killed by ${exit.signal} before it returned output. ` +
        `It did not stop itself.`
    );
  }

  return failed(
    "exit",
    `The script stopped its own process with exit code ${exit.code ?? 0} instead of returning; ` +
      `no output was captured.`
  );
}

/**
 * Every field of a verdict is redacted like the log, because none of the text
 * is the executor's: a `runtime` failure is the script's own message and stack,
 * and an output document that echoes back a credential outlives the report,
 * because later steps read it.
 */
function redactSecrets(
  verdict: Pick<FlowScriptResult, "ok" | "output" | "failure">,
  secrets: readonly FlowScriptSecret[]
): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  if (secrets.length === 0) return verdict;
  if (verdict.output) scrubDocument(verdict.output, secrets);
  const failure = verdict.failure;
  if (!failure) return verdict;
  return {
    ...verdict,
    failure: {
      ...failure,
      message: redactTruncated(failure.message, secrets),
      ...(failure.stack ? { stack: redactTruncated(failure.stack, secrets) } : {}),
    },
  };
}

/**
 * Iterative rather than recursive: the document came from a child that ran
 * arbitrary code, and a megabyte of `[[[[…` is legal JSON that would overflow
 * the stack inside `execute`, which owes its caller a verdict, not a throw.
 */
function scrubDocument(root: Record<string, unknown>, secrets: readonly FlowScriptSecret[]): void {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const value = node[i];
        if (typeof value === "string") node[i] = scrubSecretValues(value, secrets);
        else if (value !== null && typeof value === "object") pending.push(value);
      }
      continue;
    }
    if (node === null || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (typeof value === "string") record[key] = scrubSecretValues(value, secrets);
      else if (value !== null && typeof value === "object") pending.push(value);
      // A secret can be the key as easily as the value — `output[apiKey] = …`
      // is how a script indexes a per-credential result.
      const scrubbedKey = scrubSecretValues(key, secrets);
      if (scrubbedKey !== key) {
        record[scrubbedKey] = record[key];
        delete record[key];
      }
    }
  }
}

function commitOutput(outputJson: string): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  // A second line only: the child already enforced this, but must not be
  // trusted to stay compliant once script code has run inside it.
  const bytes = Buffer.byteLength(outputJson, "utf8");
  if (bytes > SCRIPT_MAX_OUTPUT_BYTES) {
    return failed(
      "output",
      `The script returned ${describeBytes(bytes)} of encoded output; the limit is ` +
        `${describeBytes(SCRIPT_MAX_OUTPUT_BYTES)}.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputJson);
  } catch (err) {
    return failed("output", `The script's output did not parse: ${errorMessage(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return failed("output", "The script's output was not an object.");
  }
  return { ok: true, output: parsed as Record<string, unknown> };
}

/**
 * A failure message is clamped by the child, the only side that can bound what
 * crosses the channel, and the child has no secret list — so a value straddling
 * the cut leaves a prefix that a whole-value replacement never matches. That
 * tail is dropped and counted, and only on text whose marker says it was cut.
 */
function redactTruncated(text: string, secrets: readonly FlowScriptSecret[]): string {
  const scrubbed = scrubSecretValues(text, secrets);
  const omission = OMISSION_RE.exec(scrubbed);
  if (!omission) return scrubbed;
  const head = scrubbed.slice(0, omission.index);
  const partial = partialSecretTail(head, secrets);
  if (partial === 0) return scrubbed;
  const omitted = Number(omission[1]) + partial;
  return `${head.slice(0, head.length - partial)}${omissionMarker(omitted)}`;
}

/** The tail {@link clampText} leaves behind, read back by {@link redactTruncated}. */
const OMISSION_RE = /… \[(\d+) more characters omitted]$/;

/** The same tail, written. The runner carries its own copy of both. */
function omissionMarker(omitted: number): string {
  return `… [${omitted} more characters omitted]`;
}

/**
 * The marker counts against the ceiling, as it does in the runner's copy of
 * this function, so re-applying the same ceiling downstream cannot cut again
 * and report only how much of the *marker* it dropped.
 */
function clampText(text: string, max: number): string;
function clampText(text: string | undefined, max: number): string | undefined;
function clampText(text: string | undefined, max: number): string | undefined {
  if (text === undefined || text.length <= max) return text;
  let cut = max;
  let marked = `${text.slice(0, cut)}${omissionMarker(text.length - cut)}`;
  while (marked.length > max && cut > 0) {
    cut = Math.max(0, cut - (marked.length - max));
    marked = `${text.slice(0, cut)}${omissionMarker(text.length - cut)}`;
  }
  return marked;
}

function timedOut(timeoutMs: number): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  return failed(
    "timeout",
    `The script did not finish within its ${describeDuration(timeoutMs)} time limit ` +
      `and its process tree was stopped.`
  );
}

function failed(
  kind: FlowScriptFailureKind,
  message: string,
  stack?: string
): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  return { ok: false, failure: { kind, message, ...(stack ? { stack } : {}) } };
}

function isHeapAbort(
  exit: { code: number | null; signal: NodeJS.Signals | null },
  heapFatalSeen: boolean
): boolean {
  // A signal, never an exit code. 128+SIGABRT is a *shell's* way of reporting
  // an aborted child, and there is no shell between the executor and the
  // runner — but there often is one inside the script: a wrapper forwarding a
  // build's status returns 134 while allocating nothing itself, and the build's
  // own banner lands in the inherited stream.
  return exit.signal === "SIGABRT" && heapFatalSeen;
}

function describeExit(exit: { code: number | null; signal: NodeJS.Signals | null }): string {
  if (exit.signal) return `signal ${exit.signal}`;
  return `exit code ${exit.code ?? 0}`;
}

/**
 * Always set explicitly, never inherited: the tool server's own cwd is whatever
 * the editor that spawned it chose.
 *
 * The existence check is load-bearing: `project_root` names the *calling
 * agent's* working directory and can be mistyped or since moved, and without it
 * the child fails with a bare `ENOENT` naming a path the author never wrote.
 */
function resolveWorkingDirectory(request: FlowScriptRequest, notes: string[]): string {
  const candidates: Array<{ label: string; value: string | undefined }> = [
    { label: "project_root", value: request.projectRoot },
    { label: "the flow file's directory", value: request.flowDir },
  ];
  const named = candidates.filter((c) => c.value);
  const problems: string[] = [];
  for (const candidate of named) {
    const problem = describeDirectoryProblem(candidate.value!);
    if (!problem) {
      // Name every rejected candidate: a silent fallback is how a wrong input
      // keeps working until it does not.
      if (problems.length > 0) {
        notes.push(`${problems.join("; ")}; the script ran in ${candidate.value} instead.`);
      }
      return candidate.value!;
    }
    problems.push(`${candidate.label} ${candidate.value} ${problem}`);
  }
  throw new ScriptSetupError(
    "invalid",
    named.length === 0
      ? "No working directory was given for the script (neither project_root nor a flow directory)."
      : `No working directory exists on the machine running the tool server: ${problems.join("; ")}.`
  );
}

/**
 * The absolute-path rule is the load-bearing one — the same rule
 * `assertValidProjectRoot` in `flow-utils.ts` applies to every other flow path.
 * A relative candidate is resolved by the OS against the tool server's own
 * working directory, the one value this function exists to keep out, and one
 * that happens to exist would beat a perfectly good absolute fallback.
 */
function describeDirectoryProblem(candidate: string): string | null {
  if (!path.isAbsolute(candidate)) {
    return "is not an absolute path (a relative path would resolve against the tool server's own working directory)";
  }
  if (candidate.split(/[\\/]+/).includes("..")) return 'contains a ".." segment';
  try {
    return fs.statSync(candidate).isDirectory() ? null : "is not a directory";
  } catch {
    return "does not exist";
  }
}

function encodeRequestOutput(output: Record<string, unknown> | undefined): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(output ?? {});
  } catch (err) {
    throw new ScriptSetupError(
      "invalid",
      `The flow output could not be encoded for the script: ${errorMessage(err)}`
    );
  }
  if (typeof encoded !== "string") {
    throw new ScriptSetupError("invalid", "The flow output could not be encoded for the script.");
  }
  return encoded;
}

/**
 * Falls back to the path itself: a missing script is Node's error to report,
 * with the name the author wrote.
 */
function realPathOrSelf(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

/**
 * The three layouts the runner can be in — the published bundle (beside
 * `tool-server.cjs` in `dist`), the compiled package and the workspace source
 * — are all `path.join(__dirname, name)`. The tool-server package is CommonJS,
 * so `__dirname` is available here and under vitest.
 */
function resolveRunnerPath(runnerDir: string | undefined): string {
  const dir = runnerDir ?? __dirname;
  const runner = path.join(dir, RUNNER_FILE);
  if (!fs.existsSync(runner)) {
    throw new ScriptSetupError(
      "spawn",
      `The script runner is missing from this installation (looked for ${runner}).`
    );
  }
  return runner;
}

function buildChildEnv(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  // Windows environment names are case-insensitive, so a host may surface any
  // of these under non-canonical casing; POSIX names are exact.
  const caseInsensitive = process.platform === "win32";
  const allowed = new Set(
    ALLOWED_ENV_NAMES.map((name) => (caseInsensitive ? name.toLowerCase() : name))
  );
  const reservedName = (name: string) =>
    RESERVED_ENV_NAMES.find((candidate) =>
      caseInsensitive || candidate === NPM_NODE_OPTIONS_ENV
        ? candidate.toLowerCase() === name.toLowerCase()
        : candidate === name
    );
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // Ahead of the allowlist, because a prefix admits names nobody listed.
    if (reservedName(name)) continue;
    const key = caseInsensitive ? name.toLowerCase() : name;
    if (allowed.has(key) || ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      env[name] = value;
    }
  }

  // Under an Electron-based MCP host `process.execPath` is the Electron binary,
  // and ELECTRON_RUN_AS_NODE in our own environment is the only reason a plain
  // `fork` from it boots as Node. The allowlist does not carry the name, so it
  // has to be put back deliberately.
  if (isElectronHostedEnv()) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }

  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (reservedName(name)) {
      throw new ScriptSetupError(
        "invalid",
        `${name} cannot be set for a script: it steers the runner's own process ` +
          `(reserved names: ${RESERVED_ENV_NAMES.join(", ")}).`
      );
    }
    env[name] = value;
  }

  // Set last, so a caller cannot shadow it. The runner preload activates only
  // when it sees this and clears it before the script runs: `--import` is
  // inherited by a worker thread or a `fork` the script starts, and an
  // activated preload in either would wait for a request that is never sent.
  env[RUNNER_ACTIVATION_ENV] = "1";
  return env;
}

function clampTimeout(
  requested: number | undefined,
  maxTimeoutMs: number,
  notes: string[]
): number {
  // A step that asked for nothing gets the default, silently bounded by the
  // host maximum; only an explicit over-ask is worth a note.
  const wanted = positive(requested);
  if (wanted === undefined) return Math.min(DEFAULT_SCRIPT_TIMEOUT_MS, maxTimeoutMs);
  if (wanted <= maxTimeoutMs) return wanted;
  notes.push(
    `The requested ${describeDuration(wanted)} time limit is above this host's maximum of ` +
      `${describeDuration(maxTimeoutMs)}; the step ran with the maximum.`
  );
  return maxTimeoutMs;
}

/**
 * Derived from the CPU count because the failure it prevents is a CPU one. The
 * floor of 2 keeps a two-core CI box from serializing every script step.
 */
function defaultConcurrency(): number {
  const cpus = os.cpus()?.length || 1;
  return Math.max(2, Math.min(8, cpus - 2));
}

/** The largest delay `setTimeout` holds; past it Node clamps the timer to 1ms. */
const MAX_TIMER_MS = 2_147_483_647;

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

function configuredNumber(key: string): number | undefined {
  const def = getConfigDefinition(key) as ConfigDefinition<number> | undefined;
  if (!def) return undefined;
  const value = getConfigValue(def);
  return typeof value === "number" && value > 0 ? value : undefined;
}

/**
 * POSIX names the runner's process group, which outlives the runner and holds
 * every descendant that did not deliberately leave it; an empty group is the
 * proof that the tree is gone. Windows has no such group, so `taskkill /T`
 * walks the live parent-child tree instead: a re-parented grandchild escapes
 * it, and once the child is gone there is nothing left to walk from. A
 * deliberately detached descendant is out of reach on either, which is how a
 * script outlives its step.
 */
async function stopProcessTree(child: ChildProcess, graceMs: number): Promise<void> {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === "win32") {
    // Windows has no graceful stop for a console-less child, and `child.kill()`
    // is already `TerminateProcess` — it just does not reach the tree. Aim
    // `taskkill /t` at the child while its pid is still valid, and keep
    // `child.kill()` as the fallback for a `taskkill` that could not run.
    if (hasExited(child)) return;
    tryKill(() => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      // A `spawn` that cannot launch reports it through an asynchronous
      // `error` event, not a throw the `tryKill` above could catch, and an
      // unhandled `error` would end the tool server.
      killer.on("error", () => {});
      killer.unref();
    });
    await waitForGroupToEmpty(child, pid, graceMs);
    if (!hasExited(child)) tryKill(() => child.kill());
    return;
  }

  if (!groupHasMembers(pid)) return;
  killGroup(child, pid, "SIGTERM");
  // What has to be gone is the *group*, not the runner: the runner installs no
  // SIGTERM handler and dies at once, so waiting on it alone would skip the
  // escalation below while a slower descendant was still running.
  await waitForGroupToEmpty(child, pid, graceMs);
  if (!groupHasMembers(pid)) return;
  killGroup(child, pid, "SIGKILL");
  // A SIGKILL is delivered at once but the kernel still has to tear the process
  // down, so the step would otherwise return a moment before the tree is
  // actually gone — and "stopped" is what the verdict claims.
  await waitForGroupToEmpty(child, pid, FORCE_GRACE_MS);
}

async function waitForGroupToEmpty(
  child: ChildProcess,
  pid: number,
  graceMs: number
): Promise<void> {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (process.platform === "win32" ? hasExited(child) : !groupHasMembers(pid)) return;
    await sleep(GROUP_POLL_MS);
  }
}

/**
 * Signal 0 checks reachability without delivering anything, and `ESRCH` is the
 * only answer that means "nothing there": `EPERM` means the group exists and
 * this process may not signal it, which still counts as alive.
 */
function groupHasMembers(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function killGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    // The negative pid names the process group the runner leads because it was
    // forked `detached`.
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      // No group — the fork fell back to the parent's, or the tree is already
      // gone. Aim at the process itself, not at the tool server's group.
      tryKill(() => child.kill(signal));
    }
  }
}

function tryKill(action: () => void): void {
  try {
    action();
  } catch {
    // Already gone is the outcome we wanted.
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

interface StreamState {
  decoder: StringDecoder;
  holdback: string;
  /** The place in the shared buffer the hold-back belongs in. See `release`. */
  holdbackAt?: number;
  collapser?: V8FrameCollapser;
  /** Only stderr carries V8's fatal banner. */
  watchForHeapFatal?: boolean;
}

/**
 * stdout and stderr, captured into one buffer in arrival order.
 *
 * Console text deliberately does *not* also travel over IPC: any subprocess the
 * script starts writes to the same two descriptors, and an IPC message is
 * serialized whole — one large `console.log` could not be limited while
 * draining, as pipe data can. Arrival order is faithful to written order except
 * for a burst written to *both* streams inside one turn, and nothing else here
 * may add reordering on top of that.
 *
 * Redaction runs on the live stream, ahead of both limits: a value can straddle
 * two pipe chunks and a per-chunk replacement sees neither half, and one
 * straddling the truncation cut would leave a prefix that a whole-value
 * replacement never matches.
 */
class ScriptLogCapture {
  private readonly parts: string[] = [];
  private readonly streams = new Map<string, StreamState>();
  private stepRemaining: number;
  private truncatedFlag = false;
  private heapFatalFlag = false;
  private heapFatalTail = "";

  constructor(
    private readonly secrets: () => readonly FlowScriptSecret[],
    stepLimitBytes: number,
    private readonly runBudget?: FlowScriptLogBudget
  ) {
    this.stepRemaining = stepLimitBytes;
  }

  /**
   * Never pauses the stream: a paused one fills the pipe buffer and blocks the
   * child from ever reaching its own time limit, so past the log limit the data
   * is still drained and discarded.
   */
  push(stream: "stdout" | "stderr", chunk: Buffer): void {
    const state = this.stateFor(stream);
    this.consume(state, state.decoder.write(chunk), false);
  }

  end(): void {
    for (const state of this.streams.values()) {
      this.consume(state, state.decoder.end(), true);
      if (state.collapser) {
        this.append(state.collapser.end());
        if (state.collapser.collapsed) this.truncatedFlag = true;
      }
    }
    this.streams.clear();
  }

  /**
   * A last pass with the secret set as it stands at the end of the step: a
   * value whose head was released before the run resolved it has its two halves
   * rejoined here in plaintext. Streaming stays first, because it is what
   * protects the truncation boundary.
   */
  get text(): string {
    return scrubSecretValues(this.parts.join(""), this.secrets());
  }

  get truncated(): boolean {
    return this.truncatedFlag;
  }

  /**
   * Read off the live stream rather than the finished log: V8 prints its banner
   * last, so a script that logged past its budget before dying would lose the
   * one line that names the cause to the truncation.
   */
  get heapFatalSeen(): boolean {
    return this.heapFatalFlag;
  }

  private watchForHeapFatal(text: string): void {
    if (this.heapFatalFlag) return;
    const window = this.heapFatalTail + text;
    if (V8_HEAP_FATAL_RE.test(window)) {
      this.heapFatalFlag = true;
      this.heapFatalTail = "";
      return;
    }
    this.heapFatalTail = window.slice(-HEAP_FATAL_WINDOW_CHARS);
  }

  private stateFor(stream: "stdout" | "stderr"): StreamState {
    let state = this.streams.get(stream);
    if (!state) {
      state = {
        decoder: new StringDecoder("utf8"),
        holdback: "",
        // A V8 fatal error prints its banner and frame dump on stderr, so only
        // that stream pays the cost of line buffering or of being watched.
        ...(stream === "stderr"
          ? { collapser: new V8FrameCollapser(), watchForHeapFatal: true }
          : {}),
      };
      this.streams.set(stream, state);
    }
    return state;
  }

  private consume(state: StreamState, text: string, final: boolean): void {
    if (!text && !final) return;
    if (state.watchForHeapFatal) this.watchForHeapFatal(text);
    const secrets = this.secrets();
    const held = state.holdback;
    const pending = held + text;
    // Only a tail that could still grow into a secret is held back: a fixed
    // `longest value - 1` hold-back delays whole lines that could never match,
    // and adding a secret to a flow must not reorder its log. The scrub decides
    // where that tail begins, because only it knows which of the values it
    // replaced are settled — a value that starts with its own tail would
    // otherwise have the hold-back reach back inside a replacement already made
    // and release the rest of a whole occurrence.
    const { emit, held: keep } = scrubSecretChunk(pending, secrets, final);
    const split = pending.length - keep;
    state.holdback = pending.slice(split);
    // The released text, which is only *part* of what was held when a value
    // overlaps itself: `abca` held for `abcab` keeps `ab` once `b` arrives, so
    // the split lands inside the hold-back rather than past it.
    this.release(state, held.slice(0, split), emit);
    // A collapsed frame dump is output the report does not carry, which is what
    // `logTruncated` means.
    if (state.collapser?.collapsed) this.truncatedFlag = true;
    // Reserve where the tail now held back belongs in the shared buffer, before
    // the other stream can append past it. Text still held from an earlier
    // chunk keeps the place it already had.
    if (!state.holdback) state.holdbackAt = undefined;
    else if (split >= held.length) state.holdbackAt = this.parts.push("") - 1;
  }

  /**
   * The hold-back is per stream and the buffer is shared, so released text held
   * from an earlier chunk belongs *before* whatever the other stream wrote in
   * between — appending it now would move it past that text.
   *
   * `released` is the part of the hold-back this chunk let go of, never the
   * whole of it: a value that overlaps itself can hold text back across the
   * chunk that arrived after it.
   */
  private release(state: StreamState, released: string, emit: string): void {
    const at = state.holdbackAt;
    if (at === undefined || !emit) {
      this.append(state.collapser ? state.collapser.write(emit) : emit);
      return;
    }
    // Scrubbing the released text on its own says how much of `emit` is that
    // text, whenever no value spans the join. A value that does span it has no
    // side to belong to, so its replacement goes with the chunk that completed it.
    const head = scrubSecretValues(released, this.secrets());
    const headText = emit.startsWith(head) ? head : "";
    // The collapser is a stream transform, so it has to see the two in order.
    this.append(state.collapser ? state.collapser.write(headText) : headText, at);
    const tailText = emit.slice(headText.length);
    this.append(state.collapser ? state.collapser.write(tailText) : tailText);
  }

  /** Append to the end of the buffer, or into the place reserved at `at`. */
  private append(text: string, at?: number): void {
    if (!text) return;
    const runRemaining = this.runBudget
      ? Math.max(0, this.runBudget.remainingBytes)
      : Number.POSITIVE_INFINITY;
    const allowed = Math.min(this.stepRemaining, runRemaining);
    if (allowed <= 0) {
      this.truncatedFlag = true;
      return;
    }
    const buffer = Buffer.from(text, "utf8");
    const taken = buffer.length <= allowed ? buffer.length : utf8SafeCut(buffer, allowed);
    if (taken > 0) {
      const kept = taken === buffer.length ? text : buffer.subarray(0, taken).toString("utf8");
      if (at === undefined) this.parts.push(kept);
      else this.parts[at] += kept;
      this.stepRemaining -= taken;
      if (this.runBudget) this.runBudget.remainingBytes -= taken;
    }
    if (taken < buffer.length) this.truncatedFlag = true;
  }
}

/**
 * How many characters at the end of `text` are a proper prefix of some secret
 * value — the only tail a later chunk could complete into a whole value.
 */
function partialSecretTail(text: string, secrets: readonly FlowScriptSecret[]): number {
  let keep = 0;
  for (const { value } of secrets) {
    const longest = Math.min(value.length - 1, text.length);
    for (let n = longest; n > keep; n--) {
      if (text.endsWith(value.slice(0, n))) {
        keep = n;
        break;
      }
    }
  }
  return keep;
}

/** Back off to the start of a UTF-8 sequence so a cut never splits a character. */
function utf8SafeCut(buffer: Buffer, max: number): number {
  let cut = Math.min(max, buffer.length);
  while (cut > 0 && (buffer[cut] & 0xc0) === 0x80) cut -= 1;
  return cut;
}

const V8_FRAME_RE = /^\s*\d+:\s+0x[0-9a-f]+/i;
/**
 * What a V8 frame dump follows; until one of these prints, nothing is
 * collapsed. Coarse on purpose: a false arm costs a marker line in place of
 * frame-shaped output, while a missed dump costs sixty lines of log budget.
 */
const ARM_FRAME_COLLAPSE_RE = /FATAL ERROR|Fatal error in|Fatal JavaScript|# Fatal/i;
/** Below this many consecutive frame lines, the run is passed through as written. */
const COLLAPSE_THRESHOLD = 3;

/**
 * Collapses a V8 fatal-error frame dump — roughly sixty lines of internal frame
 * addresses — to one marker line, so an abort does not push the script's own
 * output out of the step's log budget. A run shorter than
 * {@link COLLAPSE_THRESHOLD} is emitted verbatim, so an ordinary log line that
 * happens to look like a frame survives.
 */
class V8FrameCollapser {
  private partial = "";
  private held: string[] = [];
  private heldCount = 0;
  private armed = false;
  private armWindow = "";
  private collapsedAny = false;

  get collapsed(): boolean {
    return this.collapsedAny;
  }

  write(text: string): string {
    if (!text) return "";
    if (!this.armed) {
      // Until V8 has printed a fatal error there is no frame dump to collapse,
      // and line buffering would only hold text back — an unterminated progress
      // line would wait for its newline while later stdout was appended first.
      // The window is wide enough to catch a banner split across two chunks.
      const armed = ARM_FRAME_COLLAPSE_RE.test(this.armWindow + text);
      this.armWindow = armed ? "" : (this.armWindow + text).slice(-HEAP_FATAL_WINDOW_CHARS);
      if (!armed) return text;
      this.armed = true;
    }
    this.partial += text;
    let out = "";
    const lines = this.partial.split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) out += this.classify(`${line}\n`);
    // A line that never ends would otherwise buffer without bound; past this
    // length it cannot usefully be classified anyway.
    if (this.partial.length > MAX_BUFFERED_LINE_CHARS) {
      out += this.flush() + this.partial;
      this.partial = "";
    }
    return out;
  }

  end(): string {
    if (!this.armed) return "";
    let out = "";
    if (this.partial) {
      out += this.classify(this.partial);
      this.partial = "";
    }
    return out + this.flush();
  }

  private classify(line: string): string {
    if (V8_FRAME_RE.test(line)) {
      this.heldCount += 1;
      if (this.held.length < COLLAPSE_THRESHOLD - 1) this.held.push(line);
      return "";
    }
    return this.flush() + line;
  }

  private flush(): string {
    if (this.heldCount === 0) return "";
    const collapsing = this.heldCount >= COLLAPSE_THRESHOLD;
    if (collapsing) this.collapsedAny = true;
    const out = collapsing ? `[${this.heldCount} V8 stack frames omitted]\n` : this.held.join("");
    this.held = [];
    this.heldCount = 0;
    return out;
  }
}

function emptyResult(
  failure: FlowScriptFailure,
  extras: { notes?: string[]; queuedMs?: number; durationMs?: number } = {}
): FlowScriptResult {
  return {
    ok: false,
    failure,
    log: "",
    logTruncated: false,
    durationMs: extras.durationMs ?? 0,
    queuedMs: extras.queuedMs ?? 0,
    notes: extras.notes ?? [],
  };
}

/**
 * `formatErrorForAgent` walks the `.cause` chain — a `fetch failed` wrapping
 * `connect ECONNREFUSED` is exactly the shape a script produces. Anything that
 * is not an `Error` keeps the capped rendering, since it can be arbitrarily
 * large.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return formatErrorForAgent(err) || String(err);
  return typeof err === "string" ? err : describeUnknown(err);
}

/** A short rendering of an unexpected value, for a message that quotes it. */
function describeUnknown(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  // A misbehaving runner controls this string, so it must not be able to make
  // the failure message arbitrarily long.
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function describeBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}

function describeDuration(ms: number): string {
  if (ms >= 60_000) {
    const minutes = ms / 60_000;
    return `${minutes.toFixed(minutes % 1 === 0 ? 0 : 1)}m`;
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s` : `${ms}ms`;
}
