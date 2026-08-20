/**
 * Runs one trusted local JavaScript file in one fresh Node.js child process and
 * returns a structured outcome.
 *
 * **Trust.** A script has the same trust level as a local npm script: it can
 * read and write host files, make network requests, start processes, load
 * installed and native packages, and stop its own process. The child process is
 * a *reliability* boundary, not a security one. What it buys is that a
 * synchronous infinite loop, a heap exhaustion, or a `process.exit` cannot take
 * down the tool server — which matters, because a wedged tool server makes the
 * MCP client respawn it and rotate its auth token.
 *
 * Nothing in this file is reachable from a tool yet. It takes the output
 * document, the environment map, the working directory and the time limit as
 * parameters and does not know where any of them came from.
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
  type ConfigDefinition,
} from "@argent/configuration-core";
import { scrubSecretValues } from "../../../utils/secrets";
import {
  isTerminalResponse,
  parseScriptResponse,
  SCRIPT_MAX_OUTPUT_BYTES,
  type ScriptExecuteRequest,
  type ScriptTerminalResponse,
} from "./flow-script-protocol";

// ── Bounds ────────────────────────────────────────────────────────────────

/** Time limit for a step that does not ask for one. */
const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;
/** Captured log kept for one step. */
export const SCRIPT_STEP_LOG_LIMIT_BYTES = 64 * 1024;
/** Captured log kept for one flow run, across every script step in it. */
const SCRIPT_RUN_LOG_LIMIT_BYTES = 256 * 1024;
/** How long the outcome waits for the log streams once it is otherwise known. */
const SETTLE_TIMEOUT_MS = 500;
/** Grace between asking a process tree to stop and forcing it. */
const STOP_GRACE_MS = 1_500;
/** Steps allowed to queue for a slot before a step is refused outright. */
const QUEUE_DEPTH_LIMIT = 32;
/** A queue wait longer than this is worth telling the caller about. */
const QUEUE_WAIT_REPORT_MS = 5_000;
/** A partial stderr line longer than this is passed through unclassified. */
const MAX_BUFFERED_LINE_CHARS = 8 * 1024;

const RUNNER_FILE = "flow-script-runner.mjs";

/** Marks the one process the runner preload may activate in. See `buildChildEnv`. */
const RUNNER_ACTIVATION_ENV = "ARGENT_FLOW_SCRIPT_RUNNER";

/**
 * Environment names copied from the tool server into a script process.
 *
 * The list is an allowlist rather than a denylist because the thing it must
 * keep out — the tool-server bearer token, the tool-server port, every
 * `ARGENT_SECRET_*` value — is exactly the set that grows without this file
 * being touched. It is leak hygiene, not containment: a script has file system
 * access, so one that *wants* the token can read `~/.argent/tool-server.json`.
 * What it stops is the accident — a script that prints `process.env` while
 * debugging, forwards its environment to a subprocess, or posts a crash report
 * with the environment attached.
 */
const ALLOWED_ENV_NAMES: readonly string[] = [
  // Shell basics.
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
  // Temp.
  "TMPDIR",
  "TEMP",
  "TMP",
  // Windows. `SystemRoot` is required for DNS and crypto there — a script that
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
  // Network and TLS. `NODE_EXTRA_CA_CERTS` covers the script's own process; the
  // two `SSL_CERT_*` names cover a subprocess such as `curl` or `git`.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Node toolchain. The version-manager names matter because a host using fnm,
  // asdf, mise or volta would otherwise run against a different Node than the
  // developer's shell, or against none at all.
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
  // Mobile toolchain.
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "ANDROID_AVD_HOME",
  "ANDROID_USER_HOME",
  "JAVA_HOME",
  "GRADLE_USER_HOME",
  "DEVELOPER_DIR",
  // Other.
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "CI",
];

/** Every `npm_config_*` name is copied, so a project's npm settings survive. */
const ALLOWED_ENV_PREFIXES: readonly string[] = ["npm_config_"];

/**
 * Names refused in a caller-supplied environment map. Each one breaks the
 * runner rather than the host: `NODE_CHANNEL_FD` and `NODE_UNIQUE_ID` steer the
 * IPC channel this protocol runs on, `NODE_OPTIONS` would silently override the
 * heap limit set through `execArgv`, `ELECTRON_RUN_AS_NODE` decides whether the
 * child boots as Node at all, and the runner activation flag decides which
 * process the runner preload takes over. This is a reliability rule, not a
 * security one.
 */
const RESERVED_ENV_NAMES: readonly string[] = [
  "NODE_CHANNEL_FD",
  "NODE_UNIQUE_ID",
  "NODE_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  RUNNER_ACTIVATION_ENV,
];

// ── Public shapes ─────────────────────────────────────────────────────────

/** A resolved secret whose value must never reach a report. */
export interface FlowScriptSecret {
  name: string;
  value: string;
}

/**
 * The log allowance shared by every script step in one flow run. Callers create
 * one per run with {@link createScriptLogBudget} and pass the same object to
 * each step, so a chatty first step cannot be paid for twice.
 */
export interface FlowScriptLogBudget {
  remainingBytes: number;
}

/** A fresh run-scoped log allowance. */
export function createScriptLogBudget(): FlowScriptLogBudget {
  return { remainingBytes: SCRIPT_RUN_LOG_LIMIT_BYTES };
}

export interface FlowScriptRequest {
  /** The script file. Resolved against the working directory when relative. */
  scriptPath: string;
  /** The flow output handed to the script as its `output` global. */
  output?: Record<string, unknown>;
  /** Environment values layered on top of the allowlist. */
  env?: Record<string, string>;
  /** Per-step time limit. Defaults to 30s, clamped to the configured maximum. */
  timeoutMs?: number;
  /** The caller's `project_root` — first choice for the working directory. */
  projectRoot?: string;
  /** Directory of the flow file naming the step — the working-directory fallback. */
  flowDir?: string;
  /**
   * Values to redact from captured logs. Run-scoped and read live on every
   * chunk, so a set that grows as the run resolves more secrets is respected
   * mid-step.
   */
  secrets?: readonly FlowScriptSecret[];
  /** The run's shared log allowance. Omitted ⇒ only the per-step limit applies. */
  logBudget?: FlowScriptLogBudget;
  /** Cancels the step; a queued step gives up its position at once. */
  signal?: AbortSignal;
  /** Test seam: the directory holding the runner and watchdog `.mjs` files. */
  runnerDir?: string;
}

/** Why a script step did not produce output. */
export type FlowScriptFailureKind =
  /** The module never evaluated — missing file, bad syntax, a refused import. */
  | "load"
  /** The script's own code threw. */
  | "runtime"
  /** The value in `output` cannot cross into flow state. */
  | "output"
  /** The runner misbehaved, or never reached the script. */
  | "protocol"
  /** The step ran past its time limit and was stopped. */
  | "timeout"
  /** The run was cancelled. */
  | "cancelled"
  /** The script stopped its own process instead of returning. */
  | "exit"
  /** The process was killed by a signal it did not choose. */
  | "signal"
  /** The process exhausted its heap limit. */
  | "heap"
  /** The child could not be started at all. */
  | "spawn"
  /** The step never got a concurrency slot. */
  | "queue"
  /** The request itself was not usable. */
  | "invalid";

export interface FlowScriptFailure {
  kind: FlowScriptFailureKind;
  message: string;
  stack?: string;
}

export interface FlowScriptResult {
  /** True only when the script returned a valid output document. */
  ok: boolean;
  /** The validated output document. Present exactly when `ok`. */
  output?: Record<string, unknown>;
  /** Why the step failed. Present exactly when not `ok`. */
  failure?: FlowScriptFailure;
  /** stdout and stderr in written order, redacted and possibly truncated. */
  log: string;
  /** True when a log limit dropped some of the script's output. */
  logTruncated: boolean;
  /** Wall clock from spawn to outcome. Excludes the queue wait. */
  durationMs: number;
  /** Wall clock spent waiting for a free concurrency slot. */
  queuedMs: number;
  /** Things worth telling the caller that are not failures. */
  notes: string[];
}

export interface FlowScriptExecutorOptions {
  /** Overrides `scripts.concurrency`. */
  concurrency?: number;
  /** Overrides `scripts.maxTimeoutMs`. */
  maxTimeoutMs?: number;
  /** Overrides `scripts.heapLimitMb`. */
  heapLimitMb?: number;
  /**
   * How long a step may wait for a concurrency slot before it is refused.
   * Defaults to twice the maximum script time limit — generous enough that only
   * a host already in trouble reaches it.
   */
  queueWaitMs?: number;
  /** Overrides where the runner and watchdog `.mjs` files are looked up. */
  runnerDir?: string;
}

// ── Executor ──────────────────────────────────────────────────────────────

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
 * A cancellation raised out of the queue, before any process exists. Separate
 * from a queue refusal so the caller can tell "you stopped it" from "the host
 * was full".
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
   * The three host bounds, read once per executor.
   *
   * All three are global-scope configuration: a project scope would let a
   * checked-in `.argent/config.json` — a file an agent writes — raise the
   * ceiling on how much of the developer's machine any flow in that repository
   * may occupy. Reading once rather than per step keeps a script step off the
   * filesystem for a value that only changes with a server restart.
   */
  private resolveBounds(): ResolvedBounds {
    if (!this.bounds) {
      this.bounds = {
        concurrency:
          this.options.concurrency ??
          configuredNumber("scripts.concurrency") ??
          defaultConcurrency(),
        maxTimeoutMs:
          this.options.maxTimeoutMs ?? configuredNumber("scripts.maxTimeoutMs") ?? 5 * 60_000,
        heapLimitMb: this.options.heapLimitMb ?? configuredNumber("scripts.heapLimitMb") ?? 512,
      };
    }
    return this.bounds;
  }

  /** Steps currently holding a slot. Exposed for tests and diagnostics. */
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
        this.options.queueWaitMs ?? bounds.maxTimeoutMs * 2
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

  // ── Concurrency ─────────────────────────────────────────────────────────
  //
  // One tool server serves every local agent and every project, so two runs can
  // each reach a script step. The limit protects the HOST, not the throughput
  // of one script: a typical script waits on a network call, but a script *can*
  // spin a core, and eight spinning runners on a four-core laptop is what stops
  // the tool server, the device servers, and every other agent on the machine.
  //
  // Both bounds below exist because `flow-execute` is long-running and nothing
  // else aborts the call. They are deliberately generous — they stop an
  // unbounded queue rather than shape normal use.

  private acquireSlot(signal: AbortSignal | undefined, waitBoundMs: number): Promise<() => void> {
    // Idempotent: a slot released twice would leave `running` below the number
    // of live processes and quietly raise the effective limit for the rest of
    // the tool server's life.
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

  // ── One run ─────────────────────────────────────────────────────────────

  private async runOne(
    request: FlowScriptRequest,
    bounds: ResolvedBounds
  ): Promise<FlowScriptResult> {
    const notes: string[] = [];
    const startedAt = Date.now();
    let cwd: string;
    let env: NodeJS.ProcessEnv;
    let runnerPath: string;
    try {
      cwd = resolveWorkingDirectory(request, notes);
      env = buildChildEnv(request.env);
      runnerPath = resolveRunnerPath(request.runnerDir ?? this.options.runnerDir);
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
    // through `realpath`, and the runner re-imports that URL to tell a finished
    // script from one parked inside a top-level `await`. A different spelling of
    // the same file would be a second module, and the script would run twice.
    const scriptPath = realPathOrSelf(path.resolve(cwd, request.scriptPath));

    let child: ChildProcess;
    try {
      // `windowsHide` is a documented `fork` option that this @types/node
      // release does not carry on ForkOptions; widen rather than drop it.
      const forkOptions: ForkOptions & { windowsHide?: boolean } = {
        cwd,
        env,
        // Set, never appended to. `fork` defaults `execArgv` to the parent's, so
        // appending would carry a dev-mode parent's ts-node/vitest loaders — and
        // any stack-size or inspector flag it was started with — into every
        // script process.
        //
        // The runner rides in as a preload rather than as the entry module, so
        // the *script* is what Node runs: `import.meta.main`, `process.argv[1]`
        // and `require.main` then all name the script, and the ordinary
        // "am I the main module?" guard runs its body instead of being skipped.
        // Node awaits an `--import` module before it loads the entry, which is
        // what leaves room for the runner's handshake.
        execArgv: [
          `--max-old-space-size=${bounds.heapLimitMb}`,
          "--import",
          pathToFileURL(runnerPath).href,
        ],
        // Index 4 is the lifeline: a pipe the parent holds open and never uses.
        // Its closing is how a runner learns its parent is gone.
        stdio: ["ignore", "pipe", "pipe", "ipc", "pipe"],
        // On POSIX the runner leads its own process group so a group stop aimed
        // at the tool server does not also stop it — and so a group stop aimed
        // at the runner reaches its descendants. Windows has no process group
        // for this purpose; `taskkill /T` covers the tree there instead.
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

    // The lifeline end holds a reference on the tool server's event loop, so one
    // script step would otherwise keep the server alive past its idle shutdown.
    // Never read from or write to it: on POSIX it is one end of a socketpair,
    // and Node exposes it as a readable *and* writable Socket.
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
    let stopping = false;

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

    const stop = () => {
      if (stopping) return;
      stopping = true;
      void stopProcessTree(child, exited, STOP_GRACE_MS);
    };

    child.stdout?.on("data", (chunk: Buffer) => capture.push("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture.push("stderr", chunk));

    child.on("message", (raw) => {
      // A second terminal response is ignored rather than obeyed: the run
      // already has its verdict, and a runner that keeps talking after it has
      // finished is running arbitrary code that is no longer following the
      // protocol.
      if (terminal) return;
      const message = parseScriptResponse(raw);
      if (!message) {
        protocolProblem ??= `The script runner sent a message the executor does not recognise: ${describeUnknown(raw)}`;
        stop();
        return;
      }
      if (!isTerminalResponse(message)) {
        startedSeen = true;
        return;
      }
      terminal = message;
    });

    const timer = setTimeout(() => {
      interrupted = "timeout";
      stop();
    }, timeoutMs);
    const onAbort = () => {
      interrupted ??= "cancelled";
      stop();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const message: ScriptExecuteRequest = {
      type: "execute",
      scriptUrl: pathToFileURL(scriptPath).href,
      outputJson: JSON.stringify(request.output ?? {}),
      deadlineMs: timeoutMs,
      maxOutputBytes: SCRIPT_MAX_OUTPUT_BYTES,
    };
    try {
      child.send(message, (err) => {
        if (!err) return;
        // A send that fails means the channel died before the script could be
        // named. The child cannot do anything useful without the request, so
        // stop it rather than wait out its time limit.
        protocolProblem ??= `The script runner closed its channel before the request arrived: ${errorMessage(err)}`;
        stop();
      });
    } catch (err) {
      protocolProblem ??= `The script runner could not be given its request: ${errorMessage(err)}`;
      stop();
    }

    const exit = await exited;
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);

    // End the step only when the outcome is known AND both log streams have
    // closed. The protocol runs on IPC and the logs run on the standard
    // streams, and the two have no shared order: a terminal message routinely
    // arrives *before* the log text of the same script. The bound covers a
    // descendant that inherited the streams and is holding them open — stopping
    // the process group first closes them in the normal case.
    await Promise.race([closed, delay(SETTLE_TIMEOUT_MS)]);
    capture.end();
    child.stdout?.destroy();
    child.stderr?.destroy();
    lifeline?.destroy?.();
    if (child.connected) child.disconnect();

    const log = capture.text;
    const verdict = classifyOutcome({
      exit,
      spawnProblem,
      protocolProblem,
      terminal,
      startedSeen,
      interrupted,
      timeoutMs,
      log,
      heapLimitMb: bounds.heapLimitMb,
    });

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

// ── Verdict ───────────────────────────────────────────────────────────────

interface ClassifyInput {
  exit: { code: number | null; signal: NodeJS.Signals | null };
  spawnProblem: string | null;
  protocolProblem: string | null;
  terminal: ScriptTerminalResponse | null;
  startedSeen: boolean;
  interrupted: "timeout" | "cancelled" | null;
  timeoutMs: number;
  log: string;
  heapLimitMb: number;
}

/**
 * The exit is read *together with* the messages received, never alone.
 *
 * The signal row is the one that matters: a process killed by a signal did not
 * choose to stop, and reporting it as self-termination sends the author to the
 * wrong line of code. Nothing here asks anything of a process that is already
 * leaving — an exit handler in the runner would not be a reliable send point,
 * because `process.send` is not guaranteed to complete during process exit.
 */
function classifyOutcome(
  input: ClassifyInput
): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  const { exit } = input;
  if (input.spawnProblem) return failed("spawn", input.spawnProblem);
  if (input.interrupted === "cancelled") {
    return failed("cancelled", "The run was cancelled and the script process was stopped.");
  }
  if (input.protocolProblem) return failed("protocol", input.protocolProblem);

  if (input.terminal) {
    if (input.terminal.type === "failure") {
      return failed(input.terminal.failureType, input.terminal.message, input.terminal.stack);
    }
    return commitOutput(input.terminal.outputJson);
  }

  if (input.interrupted === "timeout") {
    return failed(
      "timeout",
      `The script did not finish within its ${describeDuration(input.timeoutMs)} time limit ` +
        `and its process tree was stopped.`
    );
  }

  if (!input.startedSeen) {
    return failed(
      "protocol",
      `The script runner exited before it started the script (${describeExit(exit)}).`
    );
  }

  // V8 does not throw when it hits the heap limit: it prints a fatal error and
  // aborts. Without this row the plain classification below says "the script
  // stopped its own process", which it did not. The match is deliberately
  // coarse — it must not depend on the frame layout, the address format, or the
  // surrounding wording, none of which is a stability contract, and it must
  // hold on both Node 20.12 and current. An unrecognized abort simply degrades
  // to the signal report rather than to a wrong verdict.
  if (isHeapAbort(exit, input.log)) {
    return failed("heap", `The script exceeded its ${input.heapLimitMb} MiB heap limit.`);
  }

  if (exit.signal) {
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

function commitOutput(outputJson: string): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  // A second line only — a compliant child already enforced this. It exists
  // because the parent must not depend on a child staying compliant after
  // arbitrary script code has run inside it.
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

function failed(
  kind: FlowScriptFailureKind,
  message: string,
  stack?: string
): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  return { ok: false, failure: { kind, message, ...(stack ? { stack } : {}) } };
}

const V8_HEAP_FATAL_RE = /FATAL ERROR:[^\n]*(?:heap limit|heap out of memory|Allocation failed)/i;

function isHeapAbort(
  exit: { code: number | null; signal: NodeJS.Signals | null },
  log: string
): boolean {
  // Some hosts surface the abort as a signal, others as the shell's 128+SIGABRT
  // exit code; both mean the same thing.
  const aborted = exit.signal === "SIGABRT" || exit.code === 134;
  return aborted && V8_HEAP_FATAL_RE.test(log);
}

function describeExit(exit: { code: number | null; signal: NodeJS.Signals | null }): string {
  if (exit.signal) return `signal ${exit.signal}`;
  return `exit code ${exit.code ?? 0}`;
}

// ── Setup ─────────────────────────────────────────────────────────────────

/**
 * The working directory is always set explicitly, to the first candidate that
 * exists on the server.
 *
 * The existence check is load-bearing: `project_root` names the *calling
 * agent's* working directory and can be a path that is mistyped or has since
 * moved. Without it the child spawns into a directory that does not exist and
 * fails with a bare `ENOENT` naming a path the script author never wrote.
 *
 * The tool server's own working directory is never inherited. That value is not
 * a project path — an editor sets it when it spawns the server, and it can be
 * `/` or `$HOME`, which would make a relative `fs` path in a script resolve
 * against the filesystem root.
 */
function resolveWorkingDirectory(request: FlowScriptRequest, notes: string[]): string {
  const candidates: Array<{ label: string; value: string | undefined }> = [
    { label: "project_root", value: request.projectRoot },
    { label: "the flow file's directory", value: request.flowDir },
  ];
  const named = candidates.filter((c) => c.value);
  for (const candidate of named) {
    if (isDirectory(candidate.value!)) {
      if (candidate.label !== "project_root" && request.projectRoot) {
        notes.push(
          `project_root ${request.projectRoot} does not exist on the machine running the ` +
            `tool server; the script ran in ${candidate.value} instead.`
        );
      }
      return candidate.value!;
    }
  }
  throw new ScriptSetupError(
    "invalid",
    named.length === 0
      ? "No working directory was given for the script (neither project_root nor a flow directory)."
      : `No working directory exists on the machine running the tool server: ` +
          `${named.map((c) => `${c.label} ${c.value}`).join(", ")}.`
  );
}

/**
 * The real path of a file, or the path itself when it cannot be resolved —
 * a missing script is Node's error to report, with the name the author wrote.
 */
function realPathOrSelf(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The three layouts the runner can be in — the published bundle (beside
 * `tool-server.cjs` in `dist`), the compiled package (beside the compiled
 * executor) and the workspace source (beside this file) — are all
 * `path.join(__dirname, name)`. The tool-server package is CommonJS, so
 * `__dirname` is available here and under vitest; this mirrors how
 * `preview-window.ts` finds its bundled main script.
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

/**
 * The child environment, built from the allowlist rather than from the tool
 * server's own environment.
 */
function buildChildEnv(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  // Windows environment names are case-insensitive, so a host may surface any
  // of these under non-canonical casing; POSIX names are exact.
  const caseInsensitive = process.platform === "win32";
  const allowed = new Set(
    ALLOWED_ENV_NAMES.map((name) => (caseInsensitive ? name.toLowerCase() : name))
  );
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const key = caseInsensitive ? name.toLowerCase() : name;
    if (allowed.has(key) || ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      env[name] = value;
    }
  }

  // `process.execPath` is normally the Node binary, but an Electron-based MCP
  // host makes it the Electron binary — and such a host puts
  // ELECTRON_RUN_AS_NODE in our own environment, which is the only reason a
  // plain `fork` from it boots as Node today. The allowlist does not carry the
  // name, so it has to be put back deliberately.
  //
  // The read must be case-insensitive for the same reason the strip in
  // `electron-env.ts` is: a Windows host may surface `Electron_Run_As_Node`,
  // and a case-sensitive read here would say the server is not Electron-hosted
  // when it is — booting a GUI Electron process for every script step.
  if (Object.keys(process.env).some((name) => name.toLowerCase() === "electron_run_as_node")) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }

  for (const [name, value] of Object.entries(overrides ?? {})) {
    const reserved = RESERVED_ENV_NAMES.find((candidate) =>
      caseInsensitive ? candidate.toLowerCase() === name.toLowerCase() : candidate === name
    );
    if (reserved) {
      throw new ScriptSetupError(
        "invalid",
        `${name} cannot be set for a script: it steers the runner's own process ` +
          `(reserved names: ${RESERVED_ENV_NAMES.join(", ")}).`
      );
    }
    env[name] = value;
  }

  // Set last, so a caller cannot shadow it. The runner preload activates only
  // when it sees this, and clears it before the script runs: `--import` is
  // inherited by a worker thread the script starts and by a `child_process`
  // `fork` from the script, and an activated preload in either would wait for a
  // request that is never sent. A child's environment is copied at spawn time,
  // so clearing it in this process is what keeps it out of theirs.
  env[RUNNER_ACTIVATION_ENV] = "1";
  return env;
}

function clampTimeout(
  requested: number | undefined,
  maxTimeoutMs: number,
  notes: string[]
): number {
  const wanted = requested && requested > 0 ? requested : DEFAULT_SCRIPT_TIMEOUT_MS;
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

function configuredNumber(key: string): number | undefined {
  const def = getConfigDefinition(key) as ConfigDefinition<number> | undefined;
  if (!def) return undefined;
  const value = getConfigValue(def);
  return typeof value === "number" && value > 0 ? value : undefined;
}

// ── Stopping a process tree ───────────────────────────────────────────────

/**
 * Request normal termination, wait a short grace, then force.
 *
 * A trusted script may start descendants, and a cancelled or timed-out step
 * must not leave them running. The two platform mechanisms differ in reach: a
 * POSIX group stop names the group, so it reaches every descendant that stayed
 * in it, while `taskkill /T` walks the live parent-child tree — a grandchild
 * whose own parent already exited has been re-parented and escapes it. A
 * deliberately detached descendant cannot be promised on either.
 */
async function stopProcessTree(
  child: ChildProcess,
  exited: Promise<unknown>,
  graceMs: number
): Promise<void> {
  const pid = child.pid;
  if (!pid || hasExited(child)) return;

  if (process.platform === "win32") {
    // Windows has no graceful stop for a console-less child: `kill` is already
    // TerminateProcess. The grace is still taken so a child that is exiting on
    // its own is not turned into a tree kill.
    tryKill(() => child.kill());
    await Promise.race([exited, delay(graceMs)]);
    if (hasExited(child)) return;
    tryKill(() => {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      }).unref();
    });
    return;
  }

  killGroup(child, pid, "SIGTERM");
  await Promise.race([exited, delay(graceMs)]);
  if (hasExited(child)) return;
  killGroup(child, pid, "SIGKILL");
}

function killGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    // The negative pid names the process group the runner leads because it was
    // forked `detached`.
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      // No group — the fork fell back to the parent's, or the tree is already
      // gone. Aim at the process itself rather than at the tool server's group.
      tryKill(() => child.kill(signal));
    }
  }
}

function tryKill(action: () => void): void {
  try {
    action();
  } catch {
    // A process that is already gone is the outcome we wanted.
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

// ── Log capture ───────────────────────────────────────────────────────────

interface StreamState {
  decoder: StringDecoder;
  holdback: string;
  collapser?: V8FrameCollapser;
}

/**
 * stdout and stderr, captured into one buffer in arrival order.
 *
 * Only the two standard streams are captured, and console text deliberately
 * does *not* also travel over IPC. `console.log`/`console.info` already write
 * to stdout and `console.warn`/`console.error` to stderr, and any subprocess
 * the script starts writes to the same two descriptors, so one channel captures
 * everything in written order. Two channels would interleave unpredictably, and
 * an IPC message is serialized whole before sending — so one large
 * `console.log` would be built in full before any limit could apply, where pipe
 * data arrives in chunks and can be limited while draining.
 *
 * The cost is that a report shows the stream rather than the four console
 * levels. That matches what a developer sees running the script by hand.
 *
 * Redaction runs on the live stream, ahead of both limits, because each
 * boundary leaks a secret into a report if it runs last:
 *
 * - **Chunk boundary.** A secret value can straddle two pipe chunks and a
 *   per-chunk replacement sees neither half. The tail of each chunk is held
 *   back and prepended to the next.
 * - **Truncation boundary.** The cap keeps the earliest bytes, so a value
 *   straddling the cut would leave its prefix in the kept text — and a
 *   whole-value replacement matches no prefix, so it would reach the report
 *   intact.
 */
class ScriptLogCapture {
  private readonly parts: string[] = [];
  private readonly streams = new Map<string, StreamState>();
  private stepRemaining: number;
  private truncatedFlag = false;

  constructor(
    private readonly secrets: () => readonly FlowScriptSecret[],
    stepLimitBytes: number,
    private readonly runBudget?: FlowScriptLogBudget
  ) {
    this.stepRemaining = stepLimitBytes;
  }

  /**
   * Never pauses the stream. A paused stream fills the pipe buffer, blocks the
   * child, and stops the child from ever reaching its own time limit — so past
   * the limit the data is still drained and simply discarded.
   */
  push(stream: "stdout" | "stderr", chunk: Buffer): void {
    const state = this.stateFor(stream);
    this.consume(state, state.decoder.write(chunk), false);
  }

  end(): void {
    for (const state of this.streams.values()) {
      this.consume(state, state.decoder.end(), true);
      if (state.collapser) this.append(state.collapser.end());
    }
    this.streams.clear();
  }

  get text(): string {
    return this.parts.join("");
  }

  get truncated(): boolean {
    return this.truncatedFlag;
  }

  private stateFor(stream: "stdout" | "stderr"): StreamState {
    let state = this.streams.get(stream);
    if (!state) {
      state = {
        decoder: new StringDecoder("utf8"),
        holdback: "",
        // A V8 fatal error prints its frame dump on stderr, so only that stream
        // pays the cost of line buffering.
        ...(stream === "stderr" ? { collapser: new V8FrameCollapser() } : {}),
      };
      this.streams.set(stream, state);
    }
    return state;
  }

  private consume(state: StreamState, text: string, final: boolean): void {
    if (!text && !final) return;
    const secrets = this.secrets();
    const scrubbed = scrubSecretValues(state.holdback + text, secrets);
    let emit: string;
    if (final) {
      emit = scrubbed;
      state.holdback = "";
    } else {
      // One byte short of the longest value: any shorter hold-back could let a
      // value straddle the boundary with neither half matching.
      const keep = Math.max(0, longestSecret(secrets) - 1);
      const split = Math.max(0, scrubbed.length - keep);
      emit = scrubbed.slice(0, split);
      state.holdback = scrubbed.slice(split);
    }
    this.append(state.collapser ? state.collapser.write(emit) : emit);
  }

  private append(text: string): void {
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
      this.parts.push(taken === buffer.length ? text : buffer.subarray(0, taken).toString("utf8"));
      this.stepRemaining -= taken;
      if (this.runBudget) this.runBudget.remainingBytes -= taken;
    }
    if (taken < buffer.length) this.truncatedFlag = true;
  }
}

function longestSecret(secrets: readonly FlowScriptSecret[]): number {
  let longest = 0;
  for (const secret of secrets) {
    if (secret.value.length > longest) longest = secret.value.length;
  }
  return longest;
}

/** Back off to the start of a UTF-8 sequence so a cut never splits a character. */
function utf8SafeCut(buffer: Buffer, max: number): number {
  let cut = Math.min(max, buffer.length);
  while (cut > 0 && (buffer[cut] & 0xc0) === 0x80) cut -= 1;
  return cut;
}

const V8_FRAME_RE = /^\s*\d+:\s+0x[0-9a-f]+/i;
/** Below this many consecutive frame lines, the run is passed through as written. */
const COLLAPSE_THRESHOLD = 3;

/**
 * Collapses a V8 fatal-error frame dump — roughly sixty lines of internal frame
 * addresses — to one marker line, so an abort does not flood the step's log
 * budget and push the script's own output out of the report.
 *
 * ```
 *  1: 0x104941aec node::OOMErrorHandler(char const*, v8::OOMDe...
 *  2: 0x104b94314 v8::internal::V8::FatalProcessOutOfMemory(v8...
 * ```
 *
 * Best-effort by design: the `Last few GCs` summary that names the cause and
 * every line the script itself wrote pass through untouched, a run shorter than
 * {@link COLLAPSE_THRESHOLD} is emitted verbatim so an ordinary log line that
 * happens to look like a frame survives, and an unrecognized dump costs log
 * budget without ever changing the verdict.
 */
class V8FrameCollapser {
  private partial = "";
  private held: string[] = [];
  private heldCount = 0;

  write(text: string): string {
    if (!text) return "";
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
    const out =
      this.heldCount < COLLAPSE_THRESHOLD
        ? this.held.join("")
        : `[${this.heldCount} V8 stack frames omitted]\n`;
    this.held = [];
    this.heldCount = 0;
    return out;
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
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
