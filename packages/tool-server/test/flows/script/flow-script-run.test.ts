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
