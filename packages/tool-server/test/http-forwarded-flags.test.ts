/**
 * Feature flags follow the linked CALLER, not the machine hosting the server.
 *
 * A client that reached this tool-server through `argent link` runs somewhere
 * else, so this machine's ~/.argent/flags.json holds the operator's `argent
 * enable` choices and this machine's cwd resolves the operator's project —
 * neither belongs to the person driving the tools. When the caller forwards its
 * flags, they win outright.
 *
 * These tests drive the REAL flag stack — actual flags.json files on disk, the
 * real isFlagEnabled, the real async-context override — so they pin the whole
 * path rather than a mock of it: header → request scope → the HTTP exposure
 * gate AND the registry's own dispatch gate (the one flow-execute and
 * run-sequence go through).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";
import { Registry, ToolNotFoundError } from "@argent/registry";
import {
  FLAG_FORWARD_HEADER,
  FLAG_FORWARD_ACK_HEADER,
  encodeForwardedFlags,
  isFlagEnabled,
} from "@argent/configuration-core";
import { createHttpApp, type HttpAppHandle } from "../src/http";

const GATED_FLAG = "argent-lens";

let serverHome: string;
let serverProject: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let handle: HttpAppHandle;

/** Write the flags.json this MACHINE (i.e. the server operator) has stored. */
function writeServerFlags(flags: Record<string, boolean>): void {
  fs.mkdirSync(path.join(serverHome, ".argent"), { recursive: true });
  fs.writeFileSync(
    path.join(serverHome, ".argent", "flags.json"),
    JSON.stringify({ flags }, null, 2)
  );
}

/**
 * An app whose registry is wired exactly as setup-registry.ts wires the real
 * one, so the registry's dispatch gate is exercised and not just the HTTP edge.
 *
 * `runner_tool` invokes the gated tool through the registry the way a flow step
 * does, and reports which side of that gate it landed on.
 */
function buildApp(): HttpAppHandle {
  const registry = new Registry({ isFlagEnabled: (flag) => isFlagEnabled(flag) });
  registry.registerTool({
    id: "gated_tool",
    featureFlag: GATED_FLAG,
    zodSchema: z.object({}),
    services: () => ({}),
    async execute() {
      return { ran: true };
    },
  });
  registry.registerTool({
    id: "ungated_tool",
    zodSchema: z.object({}),
    services: () => ({}),
    async execute() {
      return { ran: true };
    },
  });
  registry.registerTool({
    id: "runner_tool",
    zodSchema: z.object({}),
    services: () => ({}),
    async execute() {
      try {
        await registry.invokeTool("gated_tool", {});
        return { inner: "ran" };
      } catch (err) {
        if (err instanceof ToolNotFoundError) return { inner: "blocked" };
        throw err;
      }
    },
  });
  return createHttpApp(registry);
}

async function listedTools(headers: Record<string, string> = {}): Promise<string[]> {
  const res = await request(handle.app).get("/tools").set(headers);
  expect(res.status).toBe(200);
  return res.body.tools.map((t: { name: string }) => t.name);
}

function forwarded(flags: Record<string, boolean>): Record<string, string> {
  return { [FLAG_FORWARD_HEADER]: encodeForwardedFlags(flags) };
}

beforeEach(() => {
  serverHome = fs.mkdtempSync(path.join(os.tmpdir(), "argent-server-home-"));
  serverProject = fs.mkdtempSync(path.join(os.tmpdir(), "argent-server-project-"));
  // A `.argent` marker stops resolveProjectRoot here, so the project scope is
  // this empty dir rather than whatever ancestor of the tmpdir has a marker.
  fs.mkdirSync(path.join(serverProject, ".argent"), { recursive: true });

  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = serverHome;
  process.env.USERPROFILE = serverHome;
  // spyOn rather than process.chdir(): chdir throws inside a worker thread.
  vi.spyOn(process, "cwd").mockReturnValue(serverProject);

  handle = buildApp();
});

afterEach(() => {
  handle?.dispose();
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(serverHome, { recursive: true, force: true });
  fs.rmSync(serverProject, { recursive: true, force: true });
});

describe("forwarded feature flags", () => {
  it("falls back to this machine's flags.json when the caller forwards none", async () => {
    writeServerFlags({ [GATED_FLAG]: true });
    expect(await listedTools()).toContain("gated_tool");
  });

  it("hides a tool THIS machine enabled when the caller forwards an empty set", async () => {
    writeServerFlags({ [GATED_FLAG]: true });
    const names = await listedTools(forwarded({}));
    expect(names).not.toContain("gated_tool");
    expect(names).toContain("ungated_tool");
  });

  it("exposes a tool THIS machine disabled when the caller forwards it on", async () => {
    writeServerFlags({ [GATED_FLAG]: false });
    expect(await listedTools(forwarded({ [GATED_FLAG]: true }))).toContain("gated_tool");
  });

  it("honours a forwarded `false` over this machine's `true`", async () => {
    writeServerFlags({ [GATED_FLAG]: true });
    expect(await listedTools(forwarded({ [GATED_FLAG]: false }))).not.toContain("gated_tool");
  });

  it("gates invocation, not only the listing", async () => {
    writeServerFlags({ [GATED_FLAG]: true });
    const res = await request(handle.app).post("/tools/gated_tool").set(forwarded({})).send({});
    expect(res.status).toBe(404);
  });

  it("still invokes a gated tool the caller forwarded on", async () => {
    writeServerFlags({});
    const res = await request(handle.app)
      .post("/tools/gated_tool")
      .set(forwarded({ [GATED_FLAG]: true }))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ran: true });
  });

  it("reaches the registry's dispatch gate, not just the HTTP edge", async () => {
    writeServerFlags({ [GATED_FLAG]: true });
    // runner_tool itself is ungated, so it runs; the nested registry invoke it
    // makes must still see the caller's empty set — this is the path a flow
    // step takes, which the HTTP exposure gate never touches.
    const blocked = await request(handle.app)
      .post("/tools/runner_tool")
      .set(forwarded({}))
      .send({});
    expect(blocked.status).toBe(200);
    expect(blocked.body.data).toEqual({ inner: "blocked" });

    const allowed = await request(handle.app)
      .post("/tools/runner_tool")
      .set(forwarded({ [GATED_FLAG]: true }))
      .send({});
    expect(allowed.status).toBe(200);
    expect(allowed.body.data).toEqual({ inner: "ran" });
  });

  it("does not leak one request's forwarded set into the next", async () => {
    writeServerFlags({ [GATED_FLAG]: true });
    expect(await listedTools(forwarded({}))).not.toContain("gated_tool");
    // No header this time: back to this machine's flags, not the previous
    // caller's. A module-level override instead of an async-context one would
    // fail here.
    expect(await listedTools()).toContain("gated_tool");
  });

  it("acknowledges a forwarded set so a client can detect an older server", async () => {
    writeServerFlags({});
    const applied = await request(handle.app).get("/tools").set(forwarded({}));
    expect(applied.headers[FLAG_FORWARD_ACK_HEADER.toLowerCase()]).toBe("true");

    const none = await request(handle.app).get("/tools");
    expect(none.headers[FLAG_FORWARD_ACK_HEADER.toLowerCase()]).toBeUndefined();
  });

  it("rejects a malformed forwarded set instead of silently using its own flags", async () => {
    writeServerFlags({ [GATED_FLAG]: true });
    const res = await request(handle.app)
      .get("/tools")
      .set({ [FLAG_FORWARD_HEADER]: "not-base64-json" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(FLAG_FORWARD_HEADER);
  });

  it("rejects a forwarded payload that is not an object", async () => {
    const res = await request(handle.app)
      .get("/tools")
      .set({ [FLAG_FORWARD_HEADER]: Buffer.from('["argent-lens"]').toString("base64") });
    expect(res.status).toBe(400);
  });

  it("ignores a forwarded set on the auth-exempt preview subtree", async () => {
    // /preview needs no bearer token, so any local process could otherwise flip
    // `requireLensFlag` off by asserting it. Silently ignored, not 400: the
    // browser UI never sends the header, so a rejection could only ever come
    // from something forging it.
    writeServerFlags({ [GATED_FLAG]: false });
    const res = await request(handle.app)
      .post("/preview/boot")
      .set(forwarded({ [GATED_FLAG]: true }))
      .send({});
    expect(res.status).toBe(404);
    expect(res.headers[FLAG_FORWARD_ACK_HEADER.toLowerCase()]).toBeUndefined();
  });

  it("gates GET /artifacts on the caller's flags, not this machine's", async () => {
    writeServerFlags({ "artifacts-list-endpoint": true });

    const suppressed = await request(handle.app).get("/artifacts").set(forwarded({}));
    expect(suppressed.status).toBe(404);

    const enabled = await request(handle.app)
      .get("/artifacts")
      .set(forwarded({ "artifacts-list-endpoint": true }));
    expect(enabled.status).toBe(200);
    expect(enabled.body).toEqual({ artifacts: [] });
  });
});
