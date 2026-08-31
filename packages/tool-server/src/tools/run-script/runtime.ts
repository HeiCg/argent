import * as vm from "node:vm";
import {
  FAILURE_CODES,
  FailureError,
  type DeviceInfo,
  type FailureKind,
  type Registry,
  type ToolContext,
} from "@argent/registry";
import { buildUiFacade, type FacadeEnv } from "./api";
import { ScriptAbortError, StepFailedError, type RunScriptResult } from "./types";

// The vm filename the script's syntax errors and stack frames are reported
// under, so the agent never sees the internal wrapper or a host path.
const SCRIPT_FILENAME = "<script>";

// Combined console output cap; older lines are dropped so the newest survive.
const LOG_CAP = 4000;

// Stack frames kept when rendering a thrown error.
const STACK_FRAMES = 3;

// A vm-thrown error is cross-realm, so `instanceof Error` is false for it in the
// host — read its Error-shaped fields by duck typing instead.
interface ErrorLike {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
}

function isErrorLike(value: unknown): value is ErrorLike {
  return typeof value === "object" && value !== null && ("message" in value || "stack" in value);
}

function messageOf(err: unknown): string {
  if (isErrorLike(err) && typeof err.message === "string") return err.message;
  return String(err);
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

function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// A console that collects log/warn/error/info/debug into one tail-capped buffer.
function createConsoleCollector(): { console: Console; collect: () => string } {
  const lines: string[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      lines.push(`[${level}] ${args.map(formatArg).join(" ")}`);
    };
  // Only the methods a sandboxed script realistically calls; the rest are no-ops
  // so `console.table(...)` etc. don't throw.
  const collector = {
    log: record("log"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
  } as unknown as Console;
  const collect = (): string => {
    const text = lines.join("\n");
    return text.length > LOG_CAP ? `…${text.slice(text.length - LOG_CAP)}` : text;
  };
  return { console: collector, collect };
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

function classifyThrow(
  err: unknown,
  timedOut: boolean,
  logs: string,
  steps: number,
  timeoutMs: number
): Error {
  if (timedOut) {
    return fail(
      FAILURE_CODES.RUN_SCRIPT_TIMEOUT,
      "run_script_deadline",
      "timeout",
      `run-script exceeded its ${timeoutMs}ms deadline after ${steps} step(s). Raise timeout_ms (max 600000) or shorten the script.${logsTail(logs)}`
    );
  }
  // An external cancel (client disconnect) is not a script fault; surface it as
  // the abort it is rather than a classified failure.
  if (err instanceof ScriptAbortError) return err;
  if (err instanceof StepFailedError) {
    return fail(
      FAILURE_CODES.RUN_SCRIPT_STEP_FAILED,
      "run_script_step",
      "unknown",
      `run-script step failed after ${steps} step(s): ${err.message}. Fix the failing step or the screen state it expects, then re-run.${logsTail(logs)}`
    );
  }
  return fail(
    FAILURE_CODES.RUN_SCRIPT_THREW,
    "run_script_execution",
    "crash",
    `run-script threw after ${steps} step(s):\n${renderThrow(err)}\nThe error is in your script's own logic (not the device).${logsTail(logs)}`
  );
}

function compile(script: string): vm.Script {
  // The body runs as an async IIFE so `await` and early `return` work; the
  // leading wrapper line is offset out so reported line numbers match the body.
  const wrapped = `(async (ui, console) => {\n${script}\n})(ui, console)`;
  try {
    return new vm.Script(wrapped, { filename: SCRIPT_FILENAME, lineOffset: -1 });
  } catch (err) {
    throw fail(
      FAILURE_CODES.RUN_SCRIPT_SYNTAX_ERROR,
      "run_script_compile",
      "validation",
      `run-script failed to compile: ${messageOf(err)}. The script must be plain JavaScript — no TypeScript type annotations, import, or require.`
    );
  }
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

/**
 * Compile and run the agent-authored script in a `node:vm` context that exposes
 * only the injected `ui` facade and a capped `console`. Resolves the success
 * shape, or throws a classified {@link FailureError} (syntax / threw / timeout /
 * step-failed).
 */
export async function runScript(args: RunScriptRuntimeArgs): Promise<RunScriptResult> {
  const { registry, device, script, timeoutMs, ctx } = args;

  const compiled = compile(script);
  const { console: sandboxConsole, collect } = createConsoleCollector();

  // One deadline drives both the wait and the cancellation of in-flight sub-tool
  // calls: it aborts on our timeout or on the caller's own signal.
  const deadline = new AbortController();
  let timedOut = false;
  const externalSignal = ctx?.signal;
  const onExternalAbort = (): void => deadline.abort();
  if (externalSignal?.aborted) deadline.abort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, timeoutMs);

  let steps = 0;
  const env: FacadeEnv = {
    registry,
    device,
    signal: deadline.signal,
    subCtx: buildSubCtx(ctx, deadline.signal),
    onStep: () => {
      steps += 1;
    },
  };

  const context = vm.createContext({ ui: buildUiFacade(env), console: sandboxConsole });

  const cleanup = (): void => {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  };

  let scriptPromise: Promise<unknown>;
  try {
    scriptPromise = Promise.resolve(compiled.runInContext(context));
  } catch (err) {
    cleanup();
    throw classifyThrow(err, timedOut, collect(), steps, timeoutMs);
  }

  const settled = scriptPromise.then(
    (value) => ({ kind: "value" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error })
  );
  // The deadline can fire while the script sits inside a non-abortable read; the
  // race lets execute return then, leaving the orphaned work to unwind on its own.
  const interrupted = new Promise<{ kind: "interrupted" }>((resolve) => {
    if (deadline.signal.aborted) resolve({ kind: "interrupted" });
    else deadline.signal.addEventListener("abort", () => resolve({ kind: "interrupted" }), { once: true });
  });

  const outcome = await Promise.race([settled, interrupted]);
  cleanup();

  if (outcome.kind === "value") {
    return { completed: true, logs: collect(), steps };
  }
  const error = outcome.kind === "error" ? outcome.error : new ScriptAbortError();
  throw classifyThrow(error, timedOut, collect(), steps, timeoutMs);
}
