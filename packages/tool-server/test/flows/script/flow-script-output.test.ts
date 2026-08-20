import { afterEach, describe, expect, it } from "vitest";
import {
  FlowScriptExecutor,
  type FlowScriptResult,
} from "../../../src/tools/flows/script/flow-script-executor";
import { createScriptWorkspace, type ScriptWorkspace } from "../../helpers/flow-script-workspace";

const workspaces: ScriptWorkspace[] = [];

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("out");
  workspaces.push(ws);
  return ws;
}

afterEach(() => {
  while (workspaces.length) workspaces.pop()!.cleanup();
});

/** Run `source` as a script and return the executor's result. */
async function run(source: string): Promise<FlowScriptResult> {
  const ws = workspace();
  const script = ws.write("script.mjs", source);
  return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000 }).execute({
    scriptPath: script,
    projectRoot: ws.dir,
  });
}

describe("flow script executor — output validation", () => {
  it("accepts objects, arrays, strings, finite numbers, booleans and null", async () => {
    const result = await run(
      `output.doc = { list: [1, "two", true, null, { nested: 1.5 }], empty: {} };`
    );
    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({
      doc: { list: [1, "two", true, null, { nested: 1.5 }], empty: {} },
    });
  });

  it("takes a replaced binding, not only a mutated one", async () => {
    // Both spellings are legal, and `output = …` resolves to the global
    // property. Reading a reference captured before the import would silently
    // keep the pre-replacement value.
    const result = await run(`output.seeded = 1; output = { replaced: true };`);
    expect(result.output).toEqual({ replaced: true });
  });

  it.each([
    ["NaN", `output.user = { age: NaN };`, "output.user.age is NaN; output numbers must be finite"],
    [
      "Infinity",
      `output.ratio = Infinity;`,
      "output.ratio is Infinity; output numbers must be finite",
    ],
    [
      "a function",
      `output.items = [1, 2, { handler: () => {} }];`,
      "output.items[2].handler is a function; output must be JSON-compatible data",
    ],
    [
      "undefined",
      `output.missing = undefined;`,
      "output.missing is undefined; output must be JSON-compatible data",
    ],
    ["a BigInt", `output.big = 1n;`, "output.big is a BigInt; output must be JSON-compatible data"],
    [
      "a symbol",
      `output.tag = Symbol("x");`,
      "output.tag is a symbol; output must be JSON-compatible data",
    ],
    [
      "a Date",
      `output.createdAt = new Date();`,
      "output.createdAt is a Date; output must be JSON-compatible data (use an ISO string)",
    ],
    [
      "a Map",
      `output.index = new Map();`,
      "output.index is a Map; output must be JSON-compatible data",
    ],
    [
      "a Set",
      `output.seen = new Set();`,
      "output.seen is a Set; output must be JSON-compatible data",
    ],
    [
      "a class instance",
      `class Order {}; output.order = new Order();`,
      "output.order is a Order; output must be JSON-compatible data",
    ],
  ])("rejects %s, naming its exact path", async (_label, source, expected) => {
    const result = await run(source);
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toBe(expected);
  });

  it("rejects a cycle rather than crashing on it", async () => {
    const result = await run(`const node = { name: "a" }; node.parent = node; output.node = node;`);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toBe(
      "output.node.parent is a cyclic reference; output must be a tree"
    );
  });

  it("accepts the same object twice in different branches", async () => {
    const result = await run(`const shared = { id: 1 }; output.a = shared; output.b = shared;`);
    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ a: { id: 1 }, b: { id: 1 } });
  });

  it("quotes a key that is not an identifier", async () => {
    const result = await run(`output["a key"] = { "b.c": NaN };`);
    expect(result.failure?.message).toBe(
      'output["a key"]["b.c"] is NaN; output numbers must be finite'
    );
  });

  it("rejects an output replaced with something that is not a document", async () => {
    const result = await run(`output = "done";`);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toBe("output is a string; output must be a plain object");
  });

  it("rejects output above the 1 MiB encoded limit", async () => {
    const result = await run(`output.blob = "x".repeat(1024 * 1024 + 10);`);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toMatch(/^output is 1\.0 MiB encoded; the limit is 1\.0 MiB$/);
  });

  it("accepts output just under the limit", async () => {
    const result = await run(`output.blob = "x".repeat(1024 * 1000);`);
    expect(result.failure).toBeUndefined();
    expect((result.output?.blob as string).length).toBe(1024 * 1000);
  });

  it("bounds a failure message and stack, the last unbounded fields on the channel", async () => {
    // `throw new Error(\`Unexpected response: \${await res.text()}\`)` is how a
    // whole response body ends up in an error. An IPC message is deserialized
    // whole into the tool server's heap before anything can inspect it, so the
    // ceiling has to hold in the child.
    const result = await run(
      `throw new Error("Unexpected response: " + "y".repeat(8 * 1024 * 1024));`
    );

    expect(result.failure?.kind).toBe("runtime");
    expect(result.failure?.message.length).toBeLessThan(9 * 1024);
    expect(result.failure?.message).toContain("more characters omitted");
    expect(result.failure?.stack?.length).toBeLessThan(17 * 1024);
  }, 30_000);
});
