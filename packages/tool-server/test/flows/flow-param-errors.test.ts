import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Registry, getFailureSignal, FAILURE_CODES, zodObjectToJsonSchema } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import { InvalidToolInputError } from "../../src/utils/capability";

let tmpDir: string;

function registry(): Registry {
  const r = new Registry();
  r.registerTool(createRunFlowTool(r) as never);
  return r;
}

async function writeFlow(name: string): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    `executionPrerequisite: "anywhere"\nsteps:\n  - echo: hello\n`,
    "utf8"
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-params-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("flow-execute parameter handling", () => {
  it("accepts `flow_name` as an alias for `name`", async () => {
    await writeFlow("aliased");

    const result = await registry().invokeTool<FlowRunResult>("flow-execute", {
      flow_name: "aliased",
      project_root: tmpDir,
      device: "00000000-0000-0000-0000-0000000000ab",
      prerequisiteAcknowledged: true,
    });

    expect(result.flow).toBe("aliased");
    expect(result.ok).toBe(true);
  });

  it("prefers `name` over `flow_name` when both are sent (matches the file-input merge)", async () => {
    // The client's file-input merge puts the `name` spec last, so the file that
    // runs is always the one `name || flow_name` reports.
    await writeFlow("by-name");
    await writeFlow("by-alias");

    const result = await registry().invokeTool<FlowRunResult>("flow-execute", {
      name: "by-name",
      flow_name: "by-alias",
      project_root: tmpDir,
      device: "00000000-0000-0000-0000-0000000000ab",
      prerequisiteAcknowledged: true,
    });

    expect(result.flow).toBe("by-name");
    expect(result.ok).toBe(true);
  });

  it("does not let an EMPTY name mask a valid alias", async () => {
    // resolveFlowName uses `||`: with `??` an empty `name` would mask the alias.
    await writeFlow("aliased");

    const result = await registry().invokeTool<FlowRunResult>("flow-execute", {
      name: "",
      flow_name: "aliased",
      project_root: tmpDir,
      device: "00000000-0000-0000-0000-0000000000ab",
      prerequisiteAcknowledged: true,
    });

    expect(result.flow).toBe("aliased");
    expect(result.ok).toBe(true);
  });

  it("names an invalid enum value by its parameter, not as raw Zod JSON", async () => {
    // flow-execute's schema is flat, so the missing and nested branches are
    // covered in registry's describe-param-issues.test.ts instead.
    let message = "";
    try {
      await registry().invokeTool("flow-execute", {
        project_root: tmpDir,
        name: "x",
        platform: "not-a-platform",
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("`platform`");
    expect(message).not.toContain('"code"');
  });

  it("says which parameter it needs when neither spelling is present", async () => {
    // The schema's exactly-one-source rule answers this, worded like
    // resolveFlowName's so both checks read alike.
    await expect(
      registry().invokeTool("flow-execute", {
        project_root: tmpDir,
        prerequisiteAcknowledged: true,
      })
    ).rejects.toThrow(/needs the flow's name in `name`.*`flow_name` is accepted as an alias/s);
  });

  it("classifies a source-less call as a client-input VALIDATION error, not an internal fault", async () => {
    // The validation signal is what maps this to a 400 at the HTTP boundary.
    let caught: unknown;
    try {
      await registry().invokeTool("flow-execute", {
        project_root: tmpDir,
        prerequisiteAcknowledged: true,
      });
    } catch (err) {
      caught = err;
    }
    const signal = getFailureSignal(caught);
    expect(signal?.error_kind).toBe("validation");
    expect(signal?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
  });

  it("reaches resolveFlowName's own rejection for an EMPTY name, and classifies it too", async () => {
    // An empty `name` counts as a named source to the schema's exactly-one
    // rule, so it is the only input that reaches resolveFlowName's throw. The
    // spy on `execute` keeps this from drifting back into proving the schema.
    const r = new Registry();
    const tool = createRunFlowTool(r);
    const execute = vi.spyOn(tool, "execute");
    r.registerTool(tool as never);

    for (const params of [{ name: "" }, { flow_name: "" }, { name: "", flow_name: "" }]) {
      const caught = await r
        .invokeTool("flow-execute", { ...params, project_root: tmpDir })
        .then(() => undefined)
        .catch((err: unknown) => err);

      // The registry wraps whatever `execute` throws, so the class the HTTP
      // boundary maps to 400 sits on the cause.
      expect((caught as Error).cause, JSON.stringify(params)).toBeInstanceOf(InvalidToolInputError);
      expect((caught as Error).message).toContain("needs the flow's name in `name`");
      const signal = getFailureSignal(caught);
      expect(signal?.error_kind).toBe("validation");
      expect(signal?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
    }
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("renders a schema failure as a sentence naming what was sent", async () => {
    let message = "";
    try {
      await registry().invokeTool("flow-execute", { name: "x" }); // project_root missing
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("`project_root` is required");
    expect(message).toContain("You sent: `name`");
    expect(message).not.toContain('"code":"invalid_type"');
  });

  it("never renders 'undefined' in the interaction line for a name-less call", () => {
    // `startedMsg` fires inside `invokeTool` before `execute`, so it is emitted
    // even for a call `resolveFlowName` goes on to reject.
    const tool = createRunFlowTool(new Registry());
    const nameless = tool.interaction!.startedMsg!({ params: { project_root: "/x" } as never });
    expect(nameless).not.toContain("undefined");
    const aliased = tool.interaction!.startedMsg!({ params: { flow_name: "feeds" } as never });
    expect(aliased).toContain("feeds");
  });

  it("names only the keys the flow AUTHOR wrote, not the bound device key", async () => {
    // `bindDeviceArgs` re-injects the resolved device key, so `udid` is in the
    // dispatched args though the recorder strips it from the YAML. It must not
    // be listed beside the misspelling.
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "typo.yaml"),
      `steps:\n  - tool: gesture-tap\n    args:\n      xx: 0.5\n      y: 0.5\n`,
      "utf8"
    );

    // A real Registry: a stub `invokeTool` runs no schema check at all.
    const r = new Registry();
    r.registerTool(createRunFlowTool(r) as never);
    r.registerTool({
      id: "gesture-tap",
      description: "test double for gesture-tap",
      zodSchema: z.object({ udid: z.string(), x: z.number(), y: z.number() }),
      services: () => ({}),
      execute: async () => ({ tapped: true }),
    } as never);

    const result = await r.invokeTool<FlowRunResult>("flow-execute", {
      name: "typo",
      project_root: tmpDir,
      device: "00000000-0000-0000-0000-0000000000ab",
      prerequisiteAcknowledged: true,
    });

    const step = result.steps.find((s) => s.tool === "gesture-tap")!;
    expect(step.status).toBe("error");
    expect(step.reason).toContain("`x` is required");
    expect(step.reason).toContain("You sent: `xx`, `y`.");
    expect(step.reason).not.toContain("`udid`");
  });

  it("leaves a tool's OWN input rejection alone when the dispatched args parsed fine", async () => {
    // `describeNestedParamError` gates on `TOOL_INPUT_INVALID`, which
    // `InvalidToolInputError` defaults to, so `resolveFlowName`'s throw reaches
    // it with args that parsed fine and there is no zod error to re-render.
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "nested-empty.yaml"),
      `steps:\n  - tool: flow-execute\n    args:\n      name: ""\n      project_root: ${tmpDir}\n      prerequisiteAcknowledged: true\n`,
      "utf8"
    );

    const r = new Registry();
    r.registerTool(createRunFlowTool(r) as never);

    const result = await r.invokeTool<FlowRunResult>("flow-execute", {
      name: "nested-empty",
      project_root: tmpDir,
      device: "00000000-0000-0000-0000-0000000000ab",
      prerequisiteAcknowledged: true,
    });

    const step = result.steps.find((s) => s.tool === "flow-execute")!;
    expect(step.status).toBe("error");
    expect(step.reason).toContain("needs the flow's name in `name`");
    expect(step.reason).not.toContain("Cannot read properties of undefined");
  });
});

describe("flow-read-prerequisite parameter handling", () => {
  function prereqRegistry(): Registry {
    const r = new Registry();
    r.registerTool(flowReadPrerequisiteTool as never);
    return r;
  }

  it("accepts the alias THROUGH the schema, not only via a direct execute()", async () => {
    // The alias tests in flow-tools.test.ts call `.execute()` directly and
    // bypass zod, so the schema could stop accepting `flow_name` unnoticed.
    await writeFlow("prereq-aliased");

    const result = await prereqRegistry().invokeTool<{
      flow: string;
      executionPrerequisite: string;
    }>("flow-read-prerequisite", { flow_name: "prereq-aliased", project_root: tmpDir });

    expect(result.flow).toBe("prereq-aliased");
    expect(result.executionPrerequisite).toBe("anywhere");
  });

  it("advertises both spellings in the schema it publishes to MCP and HTTP clients", () => {
    // A top-level `oneOf` over both spellings is not an option: the Anthropic
    // Messages API rejects a top-level combinator (#773). The alias has to be
    // legible from the published `properties` instead.
    for (const tool of [createRunFlowTool(new Registry()), flowReadPrerequisiteTool]) {
      const schema = zodObjectToJsonSchema(tool.zodSchema!) as {
        properties: Record<string, { description?: string }>;
        required?: string[];
      };

      expect(Object.keys(schema.properties), tool.id).toEqual(
        expect.arrayContaining(["name", "flow_name", "flow_path"])
      );
      expect(schema.properties.flow_name.description, tool.id).toMatch(/alias for `name`/i);

      // `required` on either spelling would reject the alias-only calls above.
      expect(schema.required ?? [], tool.id).not.toContain("name");
      expect(schema.required ?? [], tool.id).not.toContain("flow_name");
      expect(schema.required ?? [], tool.id).not.toContain("flow_path");
    }
  });

  it("spells out the alias when neither flow source is present", async () => {
    // Callers read the prerequisite before flow-execute, so one who named the
    // flow under a key zod stripped meets this tool first.
    await expect(
      prereqRegistry().invokeTool("flow-read-prerequisite", { project_root: tmpDir })
    ).rejects.toThrow(/needs the flow's name in `name`.*`flow_name` is accepted as an alias/s);
  });

  it("anchors the exactly-one-source rule at the ROOT, not on flow_path", async () => {
    // The rule spans the source fields. Anchored on `flow_path` it renders as
    // "`flow_path`: …" to an agent and as `--flow_path` to `argent run`, both
    // naming a field the caller may have got right.
    for (const tool of [createRunFlowTool(new Registry()), flowReadPrerequisiteTool]) {
      const parsed = tool.zodSchema!.safeParse({ project_root: tmpDir });
      expect(parsed.success, tool.id).toBe(false);
      const sourceIssues = parsed.error!.issues.filter((i) =>
        i.message.includes("Pass exactly one flow source")
      );
      expect(sourceIssues, tool.id).toHaveLength(1);
      expect(sourceIssues[0].path, tool.id).toEqual([]);
    }
  });

  it("stays terse when the caller named BOTH sources", async () => {
    // Two sources named is not a spelling problem, so the alias hint is noise.
    let message = "";
    try {
      await prereqRegistry().invokeTool("flow-read-prerequisite", {
        name: "a",
        flow_path: path.join(tmpDir, "b.yaml"),
        project_root: tmpDir,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("Pass exactly one flow source: name or flow_path.");
    expect(message).not.toContain("is accepted as an alias");
  });
});

describe("flow-file file-input spec order", () => {
  it("puts the `${flow_name}` spec before the `${name}` spec so `name` wins the client merge", () => {
    // The client merges specs last-write-wins on `target`, so the `name` spec
    // must come last to match `name || flow_name`. Reversed, a remote call with
    // both keys uploads the `flow_name` file while the run reports `name`.
    for (const tool of [createRunFlowTool(new Registry()), flowReadPrerequisiteTool]) {
      const flowFilePaths = (tool.fileInputs ?? [])
        .filter((spec) => spec.target === "flow_file")
        .map((spec) => spec.path);
      expect(flowFilePaths, tool.id).toEqual([
        "${project_root}/.argent/flows/${flow_name}.yaml",
        "${project_root}/.argent/flows/${name}.yaml",
      ]);
    }
  });
});
