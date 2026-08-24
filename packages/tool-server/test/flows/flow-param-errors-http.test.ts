import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Registry, FILE_INPUT_MARKER } from "@argent/registry";
import { createHttpApp } from "../../src/http";
import { createRunFlowTool } from "../../src/tools/flows/flow-run";

describe("flow param errors over HTTP", () => {
  // A wrapper whose path is missing on this host gets a 422 before the schema
  // runs, so the two wrapper cases below need a real flow on disk.
  let tmpDir: string;
  let flowFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-http-params-"));
    flowFile = path.join(tmpDir, ".argent", "flows", "demo.yaml");
    await fs.mkdir(path.dirname(flowFile), { recursive: true });
    await fs.writeFile(flowFile, "steps:\n  - echo: hi\n", "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 400 for a source-less flow-execute, with the guidance in the body", async () => {
    // The schema's exactly-one rule answers this and `execute` is never
    // entered, so it cannot stand in for the mapping the next test covers.
    const registry = new Registry();
    registry.registerTool(createRunFlowTool(registry) as never);
    const { app } = createHttpApp(registry);

    const res = await request(app)
      .post("/tools/flow-execute")
      .send({ project_root: "/tmp/does-not-matter", prerequisiteAcknowledged: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("needs the flow's name in `name`");
    expect(res.body.error).toContain("`flow_name` is accepted as an alias");
  });

  it("returns 400 (not 500) when resolveFlowName itself rejects the call", async () => {
    // An empty `name` counts as a named source to the schema, so zod passes and
    // `execute` runs. Its InvalidToolInputError is what maps to 400; a plain
    // Error would be 500.
    const registry = new Registry();
    registry.registerTool(createRunFlowTool(registry) as never);
    const { app } = createHttpApp(registry);

    for (const body of [{ name: "" }, { flow_name: "" }]) {
      const res = await request(app)
        .post("/tools/flow-execute")
        .send({ ...body, project_root: "/tmp/does-not-matter", prerequisiteAcknowledged: true });

      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toContain("needs the flow's name in `name`");
      expect(res.body.error_kind).toBe("validation");
    }
  });

  it("renders the 400 body as prose that names the caller's own keys, not raw Zod JSON", async () => {
    // Zod strips the unknown `countt` and reports `count` missing, so only the
    // echoed key list can show the misspelling.
    const registry = new Registry();
    registry.registerTool({
      id: "validated-thing",
      zodSchema: z.object({ count: z.number() }),
      services: () => ({}),
      async execute() {
        throw new Error("execute should have been skipped");
      },
    } as never);
    const { app } = createHttpApp(registry);

    const res = await request(app).post("/tools/validated-thing").send({ countt: 5 });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("`count` is required");
    expect(res.body.message).toContain("You sent: `countt`");
    expect(res.body.message).not.toContain('"code"');
  });

  it("keeps `error` parseable for a CLI released before `issues`", async () => {
    // Those CLIs read `error` and `JSON.parse` it. Prose there makes the parse
    // throw, and the run then loses its flag attribution, help block and exit 2.
    const registry = new Registry();
    registry.registerTool({
      id: "validated-thing",
      zodSchema: z.object({ count: z.number() }),
      services: () => ({}),
      async execute() {
        throw new Error("execute should have been skipped");
      },
    } as never);
    const { app } = createHttpApp(registry);

    const res = await request(app).post("/tools/validated-thing").send({ countt: 5 });

    expect(res.status).toBe(400);
    expect(() => JSON.parse(res.body.error)).not.toThrow();
    expect(JSON.parse(res.body.error)).toMatchObject([{ code: "invalid_type", path: ["count"] }]);
  });

  it("carries the machine-readable issue list beside the prose", async () => {
    // `argent run` reads the paths to name the flag its user typed (`--count`),
    // print the tool's help block and exit 2.
    const registry = new Registry();
    registry.registerTool({
      id: "validated-thing",
      zodSchema: z.object({ count: z.number() }),
      services: () => ({}),
      async execute() {
        throw new Error("execute should have been skipped");
      },
    } as never);
    const { app } = createHttpApp(registry);

    const res = await request(app).post("/tools/validated-thing").send({ count: "x" });

    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues[0]).toMatchObject({ code: "invalid_type", path: ["count"] });
    expect(typeof res.body.issues[0].message).toBe("string");
  });

  it("leaves the client-DERIVED flow_file out of the keys it reads back", async () => {
    // The client derives `flow_file` from `project_root` + `name`, and
    // `resolveFileInputs` has already run by here, so it must not be echoed as
    // a key the caller sent.
    const registry = new Registry();
    registry.registerTool(createRunFlowTool(registry) as never);
    const { app } = createHttpApp(registry);

    // The wire shape `prepareFileInputs` produces for the derived target.
    const res = await request(app)
      .post("/tools/flow-execute")
      .send({
        name: "demo",
        project_root: tmpDir,
        platform: "iOS",
        flow_file: { [FILE_INPUT_MARKER]: true, path: flowFile },
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("`platform`");
    expect(res.body.message).toContain("You sent: `name`, `project_root`, `platform`.");
    expect(res.body.message).not.toContain("`flow_file`");
  });

  it("still names a file-input the CALLER authored", async () => {
    // `flow_path`'s spec interpolates its own target, so the wrapper carries a
    // value the caller wrote and must still be echoed.
    const registry = new Registry();
    registry.registerTool(createRunFlowTool(registry) as never);
    const { app } = createHttpApp(registry);

    const res = await request(app)
      .post("/tools/flow-execute")
      .send({
        project_root: tmpDir,
        device: 5,
        flow_path: { [FILE_INPUT_MARKER]: true, path: flowFile },
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("`device`");
    expect(res.body.message).toContain("`flow_path`");
  });

  it("answers a NESTED tool's schema miss with 400, matching the direct call", async () => {
    // The outer call's params parse fine, so this rejection comes from the
    // registry's check inside `execute`, not the HTTP layer's own.
    const registry = new Registry();
    registry.registerTool({
      id: "inner",
      zodSchema: z.object({ count: z.number() }),
      services: () => ({}),
      async execute() {
        return { ok: true };
      },
    } as never);
    registry.registerTool({
      id: "outer",
      zodSchema: z.object({ pass: z.unknown() }),
      services: () => ({}),
      async execute(_s: unknown, params: { pass: unknown }) {
        return registry.invokeTool("inner", params.pass);
      },
    } as never);
    const { app } = createHttpApp(registry);

    const res = await request(app)
      .post("/tools/outer")
      .send({ pass: { countt: 5 } });

    expect(res.status).toBe(400);
    expect(res.body.error_kind).toBe("validation");
    expect(res.body.error).toContain("`count` is required");
    expect(res.body.error).toContain("You sent: `countt`");
  });
});
