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
  const probeGate = async (): Promise<{ inner: string }> => {
    try {
      await registry.invokeTool("gated_tool", {});
      return { inner: "ran" };
    } catch (err) {
      if (err instanceof ToolNotFoundError) return { inner: "blocked" };
      throw err;
    }
  };
  registry.registerTool({
    id: "runner_tool",
    zodSchema: z.object({}),
    services: () => ({}),
    execute: probeGate,
  });
  // Same probe, but held until a second caller is inside it — so the two
  // requests' flag scopes are provably alive simultaneously.
  registry.registerTool({
    id: "park_tool",
    zodSchema: z.object({}),
    services: () => ({}),
    async execute() {
      await arriveAtBarrier();
      return probeGate();
    },
  });
  return createHttpApp(registry);
}

// Releases once PARKED_CALLERS callers have arrived; rejects rather than
// hanging the suite if a caller never shows up.
const PARKED_CALLERS = 2;
let arrived = 0;
let releaseBarrier: (() => void) | null = null;
let barrier: Promise<void> | null = null;

function arriveAtBarrier(): Promise<void> {
  barrier ??= new Promise<void>((resolve, reject) => {
    releaseBarrier = resolve;
    setTimeout(() => reject(new Error("barrier timed out waiting for a second caller")), 5_000);
  });
  if (++arrived >= PARKED_CALLERS) releaseBarrier?.();
  return barrier;
}

function resetBarrier(): void {
  arrived = 0;
  releaseBarrier = null;
  barrier = null;
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

  resetBarrier();
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

  it("rejects a value with trailing junk rather than decoding its valid prefix", async () => {
    // Buffer.from(…, "base64") stops at the padding, so `<valid>GARBAGE` would
    // otherwise decode to `<valid>` and be applied as if it were clean.
    writeServerFlags({ [GATED_FLAG]: true });
    const res = await request(handle.app)
      .get("/tools")
      .set({ [FLAG_FORWARD_HEADER]: `${encodeForwardedFlags({})}GARBAGE!!!` });
    expect(res.status).toBe(400);
  });

  it("rejects the comma-joined value a duplicated header produces", async () => {
    // Node folds duplicate non-set-cookie headers into one comma-joined string.
    // Silently honouring the first half would pick a flag set at random from
    // whatever two clients (or a client and a proxy) each asserted.
    const duplicated = `${encodeForwardedFlags({ [GATED_FLAG]: true })}, ${encodeForwardedFlags({})}`;
    const res = await request(handle.app)
      .get("/tools")
      .set({ [FLAG_FORWARD_HEADER]: duplicated });
    expect(res.status).toBe(400);
  });

  it("does not acknowledge a set it rejected", async () => {
    const res = await request(handle.app)
      .get("/tools")
      .set({ [FLAG_FORWARD_HEADER]: "not-base64-json" });
    expect(res.status).toBe(400);
    // A client that saw the ack would conclude its flags applied to a request
    // that never ran.
    expect(res.headers[FLAG_FORWARD_ACK_HEADER.toLowerCase()]).toBeUndefined();
  });

  it("keeps two overlapping requests' forwarded sets apart", async () => {
    // The property async-context storage buys over a module-level variable.
    // park_tool blocks until BOTH requests have entered it, so the two scopes
    // are provably live at the same moment; only then does each consult the
    // flag. A single shared override would hand both the same answer.
    writeServerFlags({ [GATED_FLAG]: true });
    const [a, b] = await Promise.all([
      request(handle.app).post("/tools/park_tool").set(forwarded({})).send({}),
      request(handle.app)
        .post("/tools/park_tool")
        .set(forwarded({ [GATED_FLAG]: true }))
        .send({}),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.data).toEqual({ inner: "blocked" });
    expect(b.body.data).toEqual({ inner: "ran" });
  });

  // /preview needs no bearer token, so any process that can reach the port could
  // otherwise flip `requireLensFlag` on by asserting it. Silently ignored rather
  // than 400: the browser UI never sends the header, so a rejection could only
  // ever come from something forging it.
  //
  // Both spellings, because Express matches mount paths case-insensitively:
  // /PREVIEW/boot reaches the very same handler, so a case-sensitive exclusion
  // would be a one-keystroke bypass. A 404 here means `requireLensFlag` saw this
  // machine's flag (off) rather than the forwarded one; past that guard the
  // route answers 400 for the missing `udid`.
  for (const path of ["/preview/boot", "/PREVIEW/boot"]) {
    it(`ignores a forwarded set on the preview subtree (${path})`, async () => {
      writeServerFlags({ [GATED_FLAG]: false });
      const res = await request(handle.app)
        .post(path)
        .set(forwarded({ [GATED_FLAG]: true }))
        .send({});
      expect(res.status).toBe(404);
      expect(res.headers[FLAG_FORWARD_ACK_HEADER.toLowerCase()]).toBeUndefined();
    });
  }

  it("refuses to read a forwarded set from an unauthenticated caller", async () => {
    // The middleware sits BEHIND the auth gate. Moving it in front would let an
    // unauthenticated request steer flag resolution before being rejected — and
    // would still 401, so only the ack header reveals the ordering.
    const originalToken = process.env.ARGENT_AUTH_TOKEN;
    process.env.ARGENT_AUTH_TOKEN = "secret-token";
    let authed: HttpAppHandle | undefined;
    try {
      authed = buildApp(); // snapshots the token at construction
      const rejected = await request(authed.app).get("/tools").set(forwarded({}));
      expect(rejected.status).toBe(401);
      expect(rejected.headers[FLAG_FORWARD_ACK_HEADER.toLowerCase()]).toBeUndefined();

      const accepted = await request(authed.app)
        .get("/tools")
        .set("Authorization", "Bearer secret-token")
        .set(forwarded({}));
      expect(accepted.status).toBe(200);
      expect(accepted.headers[FLAG_FORWARD_ACK_HEADER.toLowerCase()]).toBe("true");
    } finally {
      authed?.dispose();
      if (originalToken === undefined) delete process.env.ARGENT_AUTH_TOKEN;
      else process.env.ARGENT_AUTH_TOKEN = originalToken;
    }
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
