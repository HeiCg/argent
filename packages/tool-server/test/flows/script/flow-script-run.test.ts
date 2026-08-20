import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  FlowScriptExecutor,
  flowScriptExecutor,
  type FlowScriptResult,
} from "../../../src/tools/flows/script/flow-script-executor";
import { createScriptWorkspace, type ScriptWorkspace } from "../../helpers/flow-script-workspace";

const workspaces: ScriptWorkspace[] = [];

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("run");
  workspaces.push(ws);
  return ws;
}

afterEach(() => {
  while (workspaces.length) workspaces.pop()!.cleanup();
});

function executor(): FlowScriptExecutor {
  return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000 });
}

async function run(ws: ScriptWorkspace, source: string): Promise<FlowScriptResult> {
  return executor().execute({ scriptPath: ws.write("script.mjs", source), projectRoot: ws.dir });
}

describe("flow script executor — a passing run", () => {
  it("returns the script's output and its captured logs", async () => {
    const ws = workspace();
    const script = ws.write(
      "seed.mjs",
      `console.log("seeding order");
       console.error("a warning");
       output.order = { id: "ord_1", total: 42 };`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ order: { id: "ord_1", total: 42 } });
    expect(result.log).toContain("seeding order");
    expect(result.log).toContain("a warning");
    expect(result.logTruncated).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("carries the flow's existing output into the script", async () => {
    const ws = workspace();
    const script = ws.write("read.mjs", `output.seen = output.given + 1;`);
    const result = await executor().execute({
      scriptPath: script,
      output: { given: 41 },
      projectRoot: ws.dir,
    });
    expect(result.output).toEqual({ given: 41, seen: 42 });
  });
});

describe("flow script executor — work the module evaluation outlives", () => {
  it("waits for a floating main() to finish before reading output", async () => {
    const ws = workspace();
    const script = ws.write(
      "seed.mjs",
      `async function main() {
         console.log("seeding");
         await new Promise((r) => setTimeout(r, 100));
         output.order = { id: "ord_1" };
         console.log("seeded");
       }
       main();`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ order: { id: "ord_1" } });
    expect(result.log).toContain("seeded");
  });

  it("waits for callback-style I/O the script never awaited", async () => {
    const ws = workspace();
    const script = ws.write(
      "read.mjs",
      `import fs from "node:fs";
       fs.readFile(new URL(import.meta.url), "utf8", (err, text) => {
         output.bytes = text.length;
       });`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output?.bytes).toBeGreaterThan(0);
  });
});

describe("flow script executor — the script is the main module", () => {
  it("runs a body behind an ESM main-module guard", async () => {
    const ws = workspace();
    // The standard shape for a script that is also importable by a test. Under
    // a runner that imported the script, every one of these answered "no" and
    // the step passed having run nothing.
    const script = ws.write(
      "guard.mjs",
      `import { fileURLToPath } from "node:url";
       output.isMain = import.meta.main;
       output.argvGuard = process.argv[1] === fileURLToPath(import.meta.url);
       if (output.argvGuard) output.ran = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ isMain: true, argvGuard: true, ran: true });
  });

  it("runs a body behind a CommonJS require.main guard", async () => {
    const ws = workspace();
    const script = ws.write("guard.cjs", `if (require.main === module) output.ran = true;`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ ran: true });
  });

  it("leaves a script's own child process and worker thread alone", async () => {
    const ws = workspace();
    // The runner rides in on `execArgv`, which a `fork` and a `new Worker` both
    // inherit. An inherited copy that thought it was the runner would wait for
    // a request nobody is sending, and the script would hang on its own child.
    ws.write("grandchild.mjs", `console.log("grandchild ran");`);
    ws.write(
      "worker.mjs",
      `import { parentPort } from "node:worker_threads";
       parentPort.postMessage("from the worker");`
    );
    const script = ws.write(
      "spawner.mjs",
      `import { fork } from "node:child_process";
       import { Worker } from "node:worker_threads";
       const child = fork(new URL("grandchild.mjs", import.meta.url).pathname);
       output.childExit = await new Promise((r) => child.on("exit", r));
       const worker = new Worker(new URL("worker.mjs", import.meta.url));
       output.fromWorker = await new Promise((r) => worker.on("message", r));`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 15_000,
    });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ childExit: 0, fromWorker: "from the worker" });
  }, 30_000);
});

describe("flow script executor — module loading", () => {
  it("loads built-ins, relative modules, ESM and CommonJS packages, JSON and top-level await", async () => {
    const ws = workspace();
    ws.write("helper.mjs", `export const helper = "relative";`);
    ws.write("data.json", `{ "fromJson": true }`);
    const script = ws.write(
      "imports.mjs",
      `import { platform } from "node:os";
       import { helper } from "./helper.mjs";
       import YAML from "yaml";
       import bytes from "bytes";
       import data from "./data.json" with { type: "json" };
       const awaited = await Promise.resolve("top-level await");
       output.builtin = typeof platform === "function";
       output.relative = helper;
       output.esmPackage = YAML.parse("a: 1").a;
       output.cjsPackage = bytes(1024);
       output.json = data.fromJson;
       output.awaited = awaited;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({
      builtin: true,
      relative: "relative",
      esmPackage: 1,
      cjsPackage: "1KB",
      json: true,
      awaited: "top-level await",
    });
  });

  it("reports a module that never loads as a load failure, not a runtime one", async () => {
    const ws = workspace();
    const script = ws.write("missing.mjs", `import "./nope.mjs";`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("load");
    expect(result.failure?.message).toContain("nope.mjs");
  });

  it("reports a syntax error as a load failure", async () => {
    const ws = workspace();
    const script = ws.write("broken.mjs", `const = ;`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure?.kind).toBe("load");
  });

  it("reports a throwing script as a runtime failure, with its stack", async () => {
    const ws = workspace();
    const script = ws.write("throws.mjs", `throw new Error("backend refused the seed");`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure?.kind).toBe("runtime");
    expect(result.failure?.message).toBe("backend refused the seed");
    // Node opened the file itself, so the trace keeps a real line number.
    expect(result.failure?.stack).toContain("throws.mjs:1");
  });

  it("reports a rejection nobody awaited as a runtime failure, with its stack", async () => {
    const ws = workspace();
    const script = ws.write(
      "async-crash.mjs",
      `Promise.reject(new Error("upstream 503 from the metrics API"));
       await new Promise((r) => setTimeout(r, 200));
       output.done = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    // Not "the script stopped its own process with exit code 1": it did not,
    // and that message points the author at a `process.exit` that is not there.
    expect(result.failure?.kind).toBe("runtime");
    expect(result.failure?.message).toBe("upstream 503 from the metrics API");
    expect(result.failure?.stack).toContain("async-crash.mjs:1");
  });

  it("reports a throw from a timer callback as a runtime failure", async () => {
    const ws = workspace();
    const script = ws.write(
      "late-throw.mjs",
      `setTimeout(() => { throw new Error("late boom"); }, 50);`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure?.kind).toBe("runtime");
    expect(result.failure?.message).toBe("late boom");
    expect(result.failure?.stack).toContain("late-throw.mjs:1");
  });

  it("calls a SyntaxError from running code a runtime failure, not a load one", async () => {
    const ws = workspace();
    // The canonical script failure: the endpoint returned an HTML error page.
    // Telling this author their file never evaluated sends them somewhere else
    // entirely.
    const script = ws.write("html.mjs", `JSON.parse("<html>not json</html>");`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure?.kind).toBe("runtime");
  });

  it("calls a script file it cannot open a load failure, not a runtime one", async () => {
    const ws = workspace();
    const script = ws.write("locked.mjs", `output.ok = true;`);
    fs.chmodSync(script, 0o000);
    try {
      const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

      expect(result.failure?.kind).toBe("load");
      expect(result.failure?.message).toContain("EACCES");
    } finally {
      fs.chmodSync(script, 0o600);
    }
  });

  it("does not put a stream crash into the log of a passing step", async () => {
    const ws = workspace();
    // A script that ended its own stdout: writing to an ended stream raises an
    // unhandled error event, and the trace landed in the report of a step that
    // otherwise passed.
    const script = ws.write("ends-stdout.mjs", `console.log("done"); process.stdout.end();`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.ok).toBe(true);
    expect(result.log).not.toContain("ERR_STREAM_WRITE_AFTER_END");
  });

  it("loads a script whose path holds a space and a #", async () => {
    const ws = workspace();
    const script = ws.write("a dir #1/odd name.mjs", `output.loaded = true;`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ loaded: true });
  });
});

describe("flow script executor — the tool server's one executor", () => {
  it("is shared, because the concurrency limit is per tool server", () => {
    expect(flowScriptExecutor()).toBe(flowScriptExecutor());
  });

  it("runs a script through the shared instance", async () => {
    const result = await run(workspace(), `output.viaShared = true;`);
    expect(result.output).toEqual({ viaShared: true });
  });
});
