// The child process a `script` flow step runs in. One script, one process, one
// terminal message back to the executor.
//
// Node can run a script file without any of this, but it cannot give the script
// an `output` object and it cannot tell the parent when that output is final. A
// direct fork of the script itself leaves no reliable send point: `beforeExit`
// does not run after an explicit `process.exit`, and it can fire more than once.
//
// This file imports nothing from the tool-server, so it needs no build step —
// it is copied next to the compiled executor and resolves its two watchdogs
// against its own module URL.

import { Worker } from "node:worker_threads";

const LIFELINE_WATCHDOG = "flow-script-watchdog-lifeline.mjs";
const DEADLINE_WATCHDOG = "flow-script-watchdog-deadline.mjs";

/** One request per process; a second `message` is ignored rather than obeyed. */
let handled = false;

process.on("message", (raw) => {
  if (handled) return;
  handled = true;
  void run(raw);
});

// A convenience for a runner whose event loop is still turning: if the parent
// goes away, stop. This is NOT the orphan control — a synchronous infinite loop
// never yields to the event loop, so this handler would never run. The lifeline
// watchdog thread is what covers that case.
process.on("disconnect", () => {
  process.exit(0);
});

async function run(raw) {
  const request = parseRequest(raw);
  if (!request) {
    finish({
      type: "failure",
      failureType: "protocol",
      message: `The script runner received a malformed request: ${safeStringify(raw)}`,
    });
    return;
  }

  startWatchdogs(request.deadlineMs);

  try {
    globalThis.output = JSON.parse(request.outputJson);
  } catch (err) {
    finish({
      type: "failure",
      failureType: "protocol",
      message: `The script runner could not decode the flow output it was given: ${errorMessage(err)}`,
    });
    return;
  }

  // Load-bearing. This is the only thing that lets the parent tell "the runner
  // never began the script" apart from "the script stopped its own process".
  process.send({ type: "started" });

  try {
    // A dynamic import of a file URL, never a source read, never an eval, never
    // a wrapper function. Node opens the file itself, so stack traces keep real
    // line numbers, a top-level `await` works with no wrapper, and a path
    // holding a space or a `#` still loads.
    await import(request.scriptUrl);
  } catch (err) {
    finish({
      type: "failure",
      failureType: classifyImportError(err),
      message: errorMessage(err),
      stack: errorStack(err),
    });
    return;
  }

  // Read the global back rather than a reference captured before the import: a
  // script may mutate the object (`output.user = user`) or replace the binding
  // (`output = { user }`, which resolves to this global property), and both are
  // legal. A captured reference silently loses the replacement.
  const encoded = encodeOutput(globalThis.output, request.maxOutputBytes);
  finish(
    encoded.error
      ? { type: "failure", failureType: "output", message: encoded.error }
      : { type: "result", outputJson: encoded.json }
  );
}

function parseRequest(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  if (raw.type !== "execute") return null;
  if (typeof raw.scriptUrl !== "string") return null;
  if (typeof raw.outputJson !== "string") return null;
  if (!Number.isFinite(raw.deadlineMs) || raw.deadlineMs <= 0) return null;
  if (!Number.isFinite(raw.maxOutputBytes) || raw.maxOutputBytes <= 0) return null;
  return raw;
}

/**
 * Two worker threads, started before the script loads.
 *
 * A worker thread is a real OS thread, so a blocked main thread cannot starve
 * it, and `process.kill` on the runner's own pid stops the whole process —
 * which is the point, because a synchronous infinite loop is the whole reason
 * this runs in a child process at all. Both are unref'd so they never hold the
 * process open; an empty script still exits in tens of milliseconds.
 *
 * One thread cannot do both duties: the lifeline's read never returns while the
 * parent lives, so a timer sharing that thread would never fire.
 */
function startWatchdogs(deadlineMs) {
  const here = import.meta.url;
  start(new URL(LIFELINE_WATCHDOG, here));
  start(new URL(DEADLINE_WATCHDOG, here), { deadlineMs });

  function start(url, workerData) {
    try {
      const worker = new Worker(url, workerData ? { workerData } : undefined);
      // A watchdog that cannot start must not take the run with it: the parent
      // keeps its own copy of the time limit, so the step is still bounded.
      worker.on("error", () => {});
      worker.unref();
    } catch {
      // Same reasoning as the error handler above.
    }
  }
}

/**
 * Which side of the import boundary failed.
 *
 * The distinction is coarse on purpose. An ESM import both resolves and
 * evaluates, so there is no exact line between the two; what a report needs is
 * "the file never ran" versus "your code threw", and a resolution/parse error
 * is a reliable stand-in for the first.
 */
function classifyImportError(err) {
  const code = err && typeof err === "object" ? err.code : undefined;
  if (
    typeof code === "string" &&
    (code.startsWith("ERR_MODULE") ||
      code.startsWith("ERR_UNSUPPORTED") ||
      code === "MODULE_NOT_FOUND" ||
      code === "ERR_UNKNOWN_FILE_EXTENSION" ||
      code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
      code === "ERR_IMPORT_ATTRIBUTE_MISSING" ||
      code === "ERR_IMPORT_ATTRIBUTE_UNSUPPORTED" ||
      code === "ERR_INVALID_MODULE_SPECIFIER")
  ) {
    return "load";
  }
  return err instanceof SyntaxError ? "load" : "runtime";
}

/**
 * Validate the output document, then encode it once.
 *
 * Validation cannot happen in the parent. The IPC channel serializes as JSON,
 * so it changes the value before the parent ever sees it: a function and an
 * `undefined` vanish with no error, `NaN` and `Infinity` arrive as `null`, and a
 * BigInt or a cyclic value throws inside `send` — so the parent sees a crash
 * rather than a verdict. A silent `null` is worse than a rejection, because the
 * flow keeps running on a value the script never wrote.
 */
function encodeOutput(value, maxOutputBytes) {
  let problem;
  try {
    problem = validate(value);
  } catch (err) {
    // A throwing getter, a Proxy trap — anything the walk itself provoked.
    return { error: `output could not be read: ${errorMessage(err)}` };
  }
  if (problem) return { error: problem };

  let json;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    return { error: `output could not be encoded: ${errorMessage(err)}` };
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > maxOutputBytes) {
    return {
      error: `output is ${describeBytes(bytes)} encoded; the limit is ${describeBytes(maxOutputBytes)}`,
    };
  }
  return { json };
}

function validate(root) {
  // The root is what later steps read paths out of, so it has to be a document.
  // A replaced `output = "done"` has nothing to merge and no path to address.
  if (root === null || typeof root !== "object" || Array.isArray(root) || !isPlainObject(root)) {
    return `output is ${describeValue(root)}; output must be a plain object`;
  }
  return walk(root, "output", new Set());
}

function walk(value, path, ancestors) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return null;
  if (type === "number") {
    return Number.isFinite(value)
      ? null
      : `${path} is ${describeValue(value)}; output numbers must be finite`;
  }
  if (type !== "object") {
    return `${path} is ${describeValue(value)}; output must be JSON-compatible data`;
  }
  // Ancestors only, not every value seen: a value referenced twice in different
  // branches encodes fine, it is a reference back *up* the tree that cannot.
  if (ancestors.has(value)) return `${path} is a cyclic reference; output must be a tree`;

  if (Array.isArray(value)) {
    ancestors.add(value);
    for (let i = 0; i < value.length; i++) {
      const problem = walk(value[i], `${path}[${i}]`, ancestors);
      if (problem) return problem;
    }
    ancestors.delete(value);
    return null;
  }
  if (!isPlainObject(value)) {
    // A Date, a Map, a Set, a class instance: each encodes to something a later
    // step cannot read back — `{}` for a Map, an opaque string for a Date.
    return `${path} is ${describeValue(value)}; output must be JSON-compatible data${
      value instanceof Date ? " (use an ISO string)" : ""
    }`;
  }
  ancestors.add(value);
  for (const key of Object.keys(value)) {
    const problem = walk(value[key], `${path}${memberPath(key)}`, ancestors);
    if (problem) return problem;
  }
  ancestors.delete(value);
  return null;
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function memberPath(key) {
  return IDENTIFIER_RE.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/** Name the offending value the way its author would recognise it. */
function describeValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const type = typeof value;
  if (type === "number") {
    if (Number.isNaN(value)) return "NaN";
    return value > 0 ? "Infinity" : "-Infinity";
  }
  if (type === "function") return "a function";
  if (type === "symbol") return "a symbol";
  if (type === "bigint") return "a BigInt";
  if (type === "string") return "a string";
  if (type === "boolean") return "a boolean";
  if (Array.isArray(value)) return "an array";
  const name = value.constructor && value.constructor.name;
  return name ? `a ${name}` : "an object with an unusual prototype";
}

function describeBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}

function errorMessage(err) {
  if (err instanceof Error) return err.message || String(err);
  return typeof err === "string" ? err : safeStringify(err);
}

function errorStack(err) {
  return err instanceof Error && typeof err.stack === "string" ? err.stack : undefined;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Send the verdict, flush both standard streams, then leave.
 *
 * `process.stdout` is asynchronous when it is a pipe, so a bare `process.exit`
 * discards buffered log output — a measured run lost the entire log line of a
 * passing script. Queuing an empty write on each stream and exiting inside its
 * callback runs after every earlier write has flushed.
 *
 * The exit code is always 0: the terminal message decides the verdict, and the
 * parent's classification depends on the message, not the code.
 */
function finish(response) {
  const exit = () => process.exit(0);
  let pending = 2;
  const flushed = () => {
    if (--pending === 0) exit();
  };
  const flush = () => {
    // A stream whose peer is gone never calls back; the fallback keeps this
    // from becoming the hang that the deadline watchdog has to clean up.
    setTimeout(exit, 1000).unref();
    process.stdout.write("", flushed);
    process.stderr.write("", flushed);
  };
  try {
    process.send(response, flush);
  } catch {
    flush();
  }
}
