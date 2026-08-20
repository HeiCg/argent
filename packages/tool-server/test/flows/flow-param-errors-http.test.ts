import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Registry, FILE_INPUT_MARKER } from "@argent/registry";
import { createHttpApp } from "../../src/http";
import { createRunFlowTool } from "../../src/tools/flows/flow-run";

// The MCP-facing surface for a bad tool call is the HTTP 400 body, so the
// friendly prose (and the status code the fix restores) are pinned here rather
// than only through `registry.invokeTool`.

describe("flow param errors over HTTP", () => {
  // A file-input wrapper is only resolved when the path exists on this host —
  // otherwise the boundary answers 422 and the schema is never reached — so
  // the two wrapper cases below need a real flow on disk.
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
    // Answered by the SCHEMA: with neither `name` nor `flow_path`, the
    // exactly-one-source rule fires and `execute` is never entered. Its message
    // was deliberately given the same wording as resolveFlowName's, so the
    // caller reads one answer whichever check catches them — which is also why
    // this case cannot stand in for the resolveFlowName mapping below.
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
    // The input that actually REACHES the throw: an empty `name` is a named
    // source as far as the schema's exactly-one rule is concerned, so zod
    // passes and `execute` runs. `name` is optional (to accept the alias), so
    // this check no longer lives in zod and has to carry its own
    // classification: InvalidToolInputError maps to 400, the status the
    // pre-alias zod rejection returned, where a plain Error would be 500.
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
    // A misspelled required key: zod strips the unknown `countt` and reports
    // `count` missing. The body must say `count` is required AND echo the key the
    // caller actually sent, so the misspelling is self-evident: the whole point
    // of describeParamIssues, and the surface (bodyArgs, not the raw issues) that
    // a regression here would silently break.
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
    expect(res.body.error).toContain("`count` is required");
    expect(res.body.error).toContain("You sent: `countt`");
    expect(res.body.error).not.toContain('"code"');
  });

  it("carries the machine-readable issue list beside the prose", async () => {
    // Prose is for the agent reading the message; `argent run` needs the PATHS,
    // to name the flag its own user typed (`--count`, not `count`), print the
    // tool's help block and exit 2. It used to read the issue list out of the
    // message; moving the message to prose without this field takes that away
    // and every server-side rejection falls through to a bare error dump.
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
    // `bodyArgs` is post-resolveFileInputs, and `flow_file` is not a key any
    // caller writes: the client derives it from `project_root` + `name`, and
    // the parameter's own `.describe()` says to leave it unset. Every
    // flow-execute call built through `prepareFileInputs` carries it, so
    // listing it beside the misspelling the clause exists to expose names a
    // key the caller cannot have typed — the same defect
    // `describeNestedParamError` keeps the injected `udid` out of on the other
    // two dispatchers.
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
    expect(res.body.error).toContain("`platform`");
    expect(res.body.error).toContain("You sent: `name`, `project_root`, `platform`.");
    expect(res.body.error).not.toContain("`flow_file`");
  });

  it("still names a file-input the CALLER authored", async () => {
    // The counterpart. `flow_path` is a declared file input too, but its spec
    // interpolates its own target, so the wrapper carries the value the caller
    // wrote — dropping it would hide a key they typed.
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
    expect(res.body.error).toContain("`device`");
    expect(res.body.error).toContain("`flow_path`");
  });

  it("answers a NESTED tool's schema miss with 400, matching the direct call", async () => {
    // The registry validates every dispatch path, so a mistyped argument to a
    // sub-tool (a flow-add-step command, a run-sequence step) is caught there
    // rather than by the HTTP layer's own copy — where the outer call's params
    // parsed fine. It carries `error_kind: "validation"`, so answering 500 had
    // the body contradicting its own status, and the same mistake reading as a
    // client error directly and an internal fault one level in.
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
