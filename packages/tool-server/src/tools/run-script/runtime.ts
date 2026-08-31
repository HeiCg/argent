import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import {
  FAILURE_CODES,
  FailureError,
  type DeviceInfo,
  type FailureKind,
  type Registry,
  type ToolContext,
} from "@argent/registry";
import { buildUiFacade, type FacadeEnv } from "./api";
import { RUNNER_SOURCE, SCRIPT_FILENAME } from "./child-runner";
import { ScriptAbortError, StepFailedError, type RunScriptResult } from "./types";

// Stack frames kept when rendering a thrown error.
const STACK_FRAMES = 3;

// Grace between the SIGTERM that ends the child and the SIGKILL backstop.
const KILL_GRACE_MS = 250;

// A child-thrown error arrives serialised, so `instanceof Error` is false for
// it in the host — read its Error-shaped fields by duck typing instead.
interface ErrorLike {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
}

/** How the parent facade classified a ui-call failure, carried to the child and back. */
type ErrKind = "step" | "abort" | "other";

interface SerializedError {
  name: string;
  message: string;
  stack: string;
}

function isErrorLike(value: unknown): value is ErrorLike {
  return typeof value === "object" && value !== null && ("message" in value || "stack" in value);
}

function messageOf(err: unknown): string {
  if (isErrorLike(err) && typeof err.message === "string") return err.message;
  return String(err);
}

function serializeError(err: unknown): SerializedError {
  return {
    name: isErrorLike(err) && typeof err.name === "string" ? err.name : "Error",
    message: messageOf(err),
    stack: isErrorLike(err) && typeof err.stack === "string" ? err.stack : "",
  };
}

function errKindOf(err: unknown): ErrKind {
  if (err instanceof StepFailedError) return "step";
  if (err instanceof ScriptAbortError) return "abort";
  return "other";
}

function fail(
  code: (typeof FAILURE_CODES)[keyof typeof FAILURE_CODES],
  stage: string,
  kind: FailureKind,
  message: string
): FailureError {
  return new FailureError(message, {
    error_code: code,
    failure_stage: stage,
    failure_area: "tool_server",
    error_kind: kind,
  });
}

function renderThrow(err: unknown): string {
  const name = isErrorLike(err) && typeof err.name === "string" ? err.name : "Error";
  const header = `${name}: ${messageOf(err)}`;
  const stack = isErrorLike(err) && typeof err.stack === "string" ? err.stack : "";
  const stackLines = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "));
  // Prefer frames inside the script; fall back to the top frames otherwise.
  const scriptFrames = stackLines.filter((line) => line.includes(SCRIPT_FILENAME));
  const frames = (scriptFrames.length > 0 ? scriptFrames : stackLines).slice(0, STACK_FRAMES);
  return [header, ...frames].join("\n");
}

function logsTail(logs: string): string {
  return logs ? `\nConsole output:\n${logs}` : "";
}

function timeoutFail(steps: number, timeoutMs: number, logs: string): FailureError {
  return fail(
    FAILURE_CODES.RUN_SCRIPT_TIMEOUT,
    "run_script_deadline",
    "timeout",
    `run-script exceeded its ${timeoutMs}ms deadline after ${steps} step(s); its execution process was terminated. Raise timeout_ms (max 600000) or shorten the script.${logsTail(logs)}`
  );
}

function buildSubCtx(ctx: ToolContext | undefined, signal: AbortSignal): ToolContext {
  // invokeSubTool only reads `signal` and `recordChildInvocation`; a minimal
  // object suffices when execute was called directly (e.g. in a unit test).
  return { ...(ctx ?? {}), signal } as ToolContext;
}

interface RunScriptRuntimeArgs {
  registry: Registry;
  device: DeviceInfo;
  script: string;
  timeoutMs: number;
  ctx: ToolContext | undefined;
}

// The parent settles on exactly one of these once the child run ends.
type Outcome =
  | { kind: "value"; logs: string }
  | { kind: "error"; error: SerializedError; errKind: ErrKind; logs: string }
  | { kind: "compile"; message: string }
  | { kind: "interrupted" } // our deadline fired
  | { kind: "abort" } // the caller's signal aborted
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "spawn-error"; error: unknown };

interface UiRequest {
  t: "ui";
  id: number;
  method: string;
  args: unknown[];
}

/**
 * Run the agent-authored script in a separate, disposable Node.js child process.
 *
 * The child is the isolation boundary: it is `fork()`ed with an empty env, a
 * temp cwd and no argv, and the script body runs there with only `ui` and a
 * captured `console` in scope. Each `ui.*` call is forwarded over the fork IPC
 * channel to this parent, where the real facade (unchanged {@link buildUiFacade})
 * runs against the device; the result crosses back. Step counting, the run
 * deadline, and secret-use detection all live here in the parent.
 *
 * Resolves the success shape, or throws a classified {@link FailureError}
 * (syntax / threw / timeout / step-failed). On the deadline or an external
 * cancel the child is killed (SIGTERM, then SIGKILL after a short grace), which
 * also covers a synchronous `while (true)` loop that never yields.
 */
export async function runScript(args: RunScriptRuntimeArgs): Promise<RunScriptResult> {
  const { registry, device, script, timeoutMs, ctx } = args;

  // One deadline drives both the child's lifetime and the cancellation of any
  // in-flight sub-tool call: it aborts on our timeout or on the caller's signal.
  const deadline = new AbortController();
  let timedOut = false;
  let aborted = false;
  const externalSignal = ctx?.signal;

  let steps = 0;
  let secretsUsed = false;
  const env: FacadeEnv = {
    registry,
    device,
    signal: deadline.signal,
    subCtx: buildSubCtx(ctx, deadline.signal),
    onStep: () => {
      steps += 1;
    },
    onSecretUsed: () => {
      secretsUsed = true;
    },
  };
  const facade = buildUiFacade(env);

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "argent-run-script-"));
  const runnerPath = path.join(dir, "runner.cjs");
  await fs.promises.writeFile(runnerPath, RUNNER_SOURCE, "utf8");

  const child: ChildProcess = fork(runnerPath, [], {
    cwd: dir,
    // Minimal env: process isolation, not a jail — but a constructor escape in
    // the child sees no tool-server secrets or auth token this way.
    env: {},
    // Don't inherit the parent's loaders/flags (e.g. a TS loader under tests);
    // the runner is plain CJS.
    execArgv: [],
    // Keep only the IPC channel; discard the child's stdio so a stray
    // process.stdout write in the script can't corrupt the protocol.
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "json",
  });

  let settled = false;
  let resolveOutcome!: (o: Outcome) => void;
  const outcomePromise = new Promise<Outcome>((resolve) => {
    resolveOutcome = (o: Outcome): void => {
      if (!settled) {
        settled = true;
        resolve(o);
      }
    };
  });

  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const killChild = (): void => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      graceTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
      graceTimer.unref?.();
    }
  };

  const send = (msg: unknown): void => {
    try {
      child.send(msg as never);
    } catch {
      /* channel closed — the child is being torn down */
    }
  };

  const handleUi = async (msg: UiRequest): Promise<void> => {
    if (settled) return;
    const method = (facade as unknown as Record<string, unknown>)[msg.method];
    if (typeof method !== "function") {
      send({
        t: "ui-res",
        id: msg.id,
        ok: false,
        error: { name: "TypeError", message: `ui.${msg.method} is not a function`, stack: "" },
        kind: "other",
      });
      return;
    }
    try {
      const value = await (method as (...a: unknown[]) => unknown).apply(
        facade,
        Array.isArray(msg.args) ? msg.args : []
      );
      // JSON IPC drops `undefined`; normalise to null so the child still resolves.
      send({ t: "ui-res", id: msg.id, ok: true, value: value ?? null });
    } catch (err) {
      send({ t: "ui-res", id: msg.id, ok: false, error: serializeError(err), kind: errKindOf(err) });
    }
  };

  child.on("message", (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const msg = raw as { t?: string } & Record<string, unknown>;
    switch (msg.t) {
      case "ui":
        void handleUi(msg as unknown as UiRequest);
        return;
      case "done":
        resolveOutcome({ kind: "value", logs: String(msg.logs ?? "") });
        return;
      case "err":
        resolveOutcome({
          kind: "error",
          error: serializeError(msg.error),
          errKind: (msg.kind as ErrKind) ?? "other",
          logs: String(msg.logs ?? ""),
        });
        return;
      case "compile-err":
        resolveOutcome({ kind: "compile", message: String(msg.message ?? "") });
        return;
    }
  });
  child.on("error", (err) => resolveOutcome({ kind: "spawn-error", error: err }));
  child.on("exit", (code, signal) => resolveOutcome({ kind: "exit", code, signal }));

  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
    killChild();
    resolveOutcome({ kind: "interrupted" });
  }, timeoutMs);
  timer.unref?.();

  const onExternalAbort = (): void => {
    aborted = true;
    deadline.abort();
    killChild();
    resolveOutcome({ kind: "abort" });
  };
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  send({ t: "init", script });

  const outcome = await outcomePromise;

  clearTimeout(timer);
  if (graceTimer) clearTimeout(graceTimer);
  externalSignal?.removeEventListener("abort", onExternalAbort);
  killChild();
  void fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});

  switch (outcome.kind) {
    case "value":
      return { completed: true, logs: outcome.logs, steps, ...(secretsUsed ? { secretsUsed: true } : {}) };

    case "compile":
      throw fail(
        FAILURE_CODES.RUN_SCRIPT_SYNTAX_ERROR,
        "run_script_compile",
        "validation",
        `run-script failed to compile: ${outcome.message}. The script must be plain JavaScript — no TypeScript type annotations, import, or require.`
      );

    case "error":
      // An external cancel is not a script fault; surface it as the abort it is.
      if (outcome.errKind === "abort") throw new ScriptAbortError();
      if (outcome.errKind === "step") {
        throw fail(
          FAILURE_CODES.RUN_SCRIPT_STEP_FAILED,
          "run_script_step",
          "unknown",
          `run-script step failed after ${steps} step(s): ${outcome.error.message}. Fix the failing step or the screen state it expects, then re-run.${logsTail(outcome.logs)}`
        );
      }
      throw fail(
        FAILURE_CODES.RUN_SCRIPT_THREW,
        "run_script_execution",
        "crash",
        `run-script threw after ${steps} step(s):\n${renderThrow(outcome.error)}\nThe error is in your script's own logic (not the device).${logsTail(outcome.logs)}`
      );

    case "interrupted":
      throw timeoutFail(steps, timeoutMs, "");

    case "abort":
      throw new ScriptAbortError();

    case "exit":
      if (timedOut) throw timeoutFail(steps, timeoutMs, "");
      if (aborted) throw new ScriptAbortError();
      throw fail(
        FAILURE_CODES.RUN_SCRIPT_THREW,
        "run_script_execution",
        "crash",
        `run-script's execution process exited unexpectedly (code ${outcome.code ?? "null"}, signal ${outcome.signal ?? "null"}) after ${steps} step(s).`
      );

    case "spawn-error":
      throw fail(
        FAILURE_CODES.RUN_SCRIPT_THREW,
        "run_script_execution",
        "crash",
        `run-script could not start its execution process: ${messageOf(outcome.error)}.`
      );
  }
}
