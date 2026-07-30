import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FLAG_FORWARD_HEADER,
  decodeForwardedFlags,
  getFlagsPath,
} from "@argent/configuration-core";

// Flag forwarding is a per-request header, so what matters is what the client
// actually put on the wire: these tests capture the header record handed to
// `fetch` and decode it, rather than trusting `flagForwardHeaders()` in
// isolation. Both remote-routing sources (ARGENT_TOOLS_URL and
// ~/.argent/link.json) and the no-override local path are exercised through
// `createToolsClient`.
//
// Same HOME-redirection pattern as link-config.test.ts: link-config.ts captures
// LINK_FILE from `homedir()` at module load, so HOME must be repointed at a
// temp dir BEFORE the client is imported — otherwise a developer's real
// ~/.argent/link.json would silently make the "no remote target" case routed.
// The flags reader resolves its path per call (that is what makes the re-read
// case below possible), and it reads the same redirected HOME.

const REMOTE_URL = "http://remote.example:9000";
const REMOTE_TOKEN = "remote_tok_abc";
/** Stands in for an auto-spawned local server — see the launcher mock. */
const LOCAL_URL = "http://127.0.0.1:65535";
const LOCAL_TOKEN = "local_tok_xyz";
const TOOL = "describe";

// The no-override path ends in `ensureToolsServer` spawning a real tool-server
// process. Only that spawn is faked: `baseUrl()` and `requestHeaders()` still
// run for real, and they are where the forwarding decision is made.
vi.mock("../src/launcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/launcher.js")>();
  return {
    ...actual,
    ensureToolsServer: async () => ({ url: LOCAL_URL, token: LOCAL_TOKEN }),
  };
});

const FAKE_PATHS: import("../src/launcher.js").ToolsServerPaths = {
  bundlePath: "/unused/tool-server.cjs",
  simulatorServerDir: "/unused/sim",
  nativeDevtoolsDir: "/unused/dylibs",
};

let toolsClient: typeof import("../src/tools-client.js");
let flagForwarding: typeof import("../src/flag-forwarding.js");
let linkConfig: typeof import("../src/link-config.js");
let TEST_HOME: string;
let GLOBAL_FLAGS_FILE: string;
let originalHome: string | undefined;

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-flag-forwarding-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = TEST_HOME;
  vi.resetModules();
  toolsClient = await import("../src/tools-client.js");
  flagForwarding = await import("../src/flag-forwarding.js");
  linkConfig = await import("../src/link-config.js");

  GLOBAL_FLAGS_FILE = getFlagsPath("global");
  expect(GLOBAL_FLAGS_FILE.startsWith(TEST_HOME)).toBe(true);
  expect(linkConfig.LINK_PATHS.LINK_FILE.startsWith(TEST_HOME)).toBe(true);
  // The forwarded set is the EFFECTIVE one (project entries shadow global), and
  // project scope is resolved from the cwd — this package dir, which carries no
  // .argent/flags.json. Assert that instead of assuming it, so a stray project
  // file shows up as one clear failure rather than a mystery diff in every
  // expectation below.
  expect(existsSync(getFlagsPath("project"))).toBe(false);
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

let requests: CapturedRequest[] = [];

/** Canned server: GET /tools advertises one tool (no fileInputs, so the file
 * boundary stays out of the way); anything else is a tool invocation. */
function cannedBody(url: string): unknown {
  if (url.endsWith("/tools")) {
    return { tools: [{ name: TOOL, description: "", inputSchema: {} }] };
  }
  return { data: { ok: true } };
}

interface StubFetchInit {
  method?: string;
  headers?: Record<string, string>;
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown, init?: StubFetchInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET", headers: { ...init?.headers } });
      return Promise.resolve(
        new Response(JSON.stringify(cannedBody(url)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    })
  );
}

function writeGlobalFlags(flags: Record<string, boolean>): void {
  mkdirSync(dirname(GLOBAL_FLAGS_FILE), { recursive: true });
  writeFileSync(GLOBAL_FLAGS_FILE, JSON.stringify({ flags }, null, 2) + "\n", "utf8");
}

/** Decoded header of a captured request, spread onto a plain object so
 * `toEqual` compares against an ordinary literal (the decoder returns a
 * null-prototype object). */
function forwardedFlagsOf(req: CapturedRequest): Record<string, boolean> {
  const raw = req.headers[FLAG_FORWARD_HEADER];
  expect(raw, `${FLAG_FORWARD_HEADER} missing from ${req.method} ${req.url}`).toBeTypeOf("string");
  return { ...decodeForwardedFlags(raw!) };
}

// A registry flag on, a registry flag off, and a key the registry does not
// know: forwarding mirrors STORAGE, which is what the receiving server resolves
// its own lookups against.
const FLAGS_A = {
  "argent-lens": true,
  "disable-auto-screenshot": false,
  "unregistered-experiment": true,
};
const FLAGS_B = { "argent-lens": false, "tool-server-event-log": true };

beforeEach(async () => {
  requests = [];
  // A developer's shell may export either of these; the no-override case
  // depends on both being absent.
  vi.stubEnv("ARGENT_TOOLS_URL", undefined);
  vi.stubEnv("ARGENT_AUTH_TOKEN", undefined);
  await linkConfig.clearLinkConfig();
  rmSync(GLOBAL_FLAGS_FILE, { force: true });
  stubFetch();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("flagForwardHeaders — encode contract", () => {
  it("carries the effective flag set as base64 JSON, and nothing else", () => {
    writeGlobalFlags(FLAGS_A);
    const headers = flagForwarding.flagForwardHeaders();

    expect(Object.keys(headers)).toEqual([FLAG_FORWARD_HEADER]);
    const value = headers[FLAG_FORWARD_HEADER]!;
    // base64 keeps the value inside the ISO-8859-1 range HTTP headers allow,
    // whatever a hand-edited flags.json spells its keys with.
    expect(value).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect({ ...decodeForwardedFlags(value) }).toEqual(FLAGS_A);
  });

  it("encodes an empty set when no flags are stored (not an absent header)", () => {
    expect(existsSync(GLOBAL_FLAGS_FILE)).toBe(false);
    const headers = flagForwarding.flagForwardHeaders();

    expect(headers[FLAG_FORWARD_HEADER]).toBeTypeOf("string");
    expect({ ...decodeForwardedFlags(headers[FLAG_FORWARD_HEADER]!) }).toEqual({});
  });
});

describe("GET /tools — remote-routed", () => {
  it("forwards the caller's effective flags when ARGENT_TOOLS_URL is set", async () => {
    writeGlobalFlags(FLAGS_A);
    vi.stubEnv("ARGENT_TOOLS_URL", REMOTE_URL);
    vi.stubEnv("ARGENT_AUTH_TOKEN", REMOTE_TOKEN);

    await toolsClient.createToolsClient().fetchTools();

    expect(requests).toHaveLength(1);
    const get = requests[0]!;
    expect(get.method).toBe("GET");
    expect(get.url).toBe(`${REMOTE_URL}/tools`);
    expect(forwardedFlagsOf(get)).toEqual(FLAGS_A);
    expect(get.headers.Authorization).toBe(`Bearer ${REMOTE_TOKEN}`);
  });

  it("forwards them for a ~/.argent/link.json target too, not only the env var", async () => {
    writeGlobalFlags(FLAGS_A);
    await linkConfig.writeLinkConfig({
      url: REMOTE_URL,
      host: "remote.example",
      port: 9000,
      createdAt: "2026-05-12T10:00:00.000Z",
      token: REMOTE_TOKEN,
    });

    await toolsClient.createToolsClient().fetchTools();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`${REMOTE_URL}/tools`);
    expect(forwardedFlagsOf(requests[0]!)).toEqual(FLAGS_A);
  });
});

describe("POST /tools/:name — remote-routed", () => {
  it("sends the flags alongside Content-Type and Authorization", async () => {
    writeGlobalFlags(FLAGS_A);
    vi.stubEnv("ARGENT_TOOLS_URL", REMOTE_URL);
    vi.stubEnv("ARGENT_AUTH_TOKEN", REMOTE_TOKEN);

    const result = await toolsClient.createToolsClient().callTool(TOOL, { platform: "ios" });
    expect(result.data).toEqual({ ok: true });

    const post = requests.at(-1)!;
    expect(post.method).toBe("POST");
    expect(post.url).toBe(`${REMOTE_URL}/tools/${TOOL}`);
    // All three must survive the merge — a spread that drops auth or the body
    // content type would break every authenticated call.
    expect(post.headers["Content-Type"]).toBe("application/json");
    expect(post.headers.Authorization).toBe(`Bearer ${REMOTE_TOKEN}`);
    expect(forwardedFlagsOf(post)).toEqual(FLAGS_A);
  });
});

describe("no remote target — local auto-spawn", () => {
  it("omits the header, on both the GET and the POST", async () => {
    writeGlobalFlags(FLAGS_A);
    expect(await linkConfig.getResolvedToolsUrl()).toEqual({ url: null, source: "none" });
    // Not a vacuous absence: there IS a flag set to forward, and the
    // remote-routed cases above forward exactly this one.
    expect({
      ...decodeForwardedFlags(flagForwarding.flagForwardHeaders()[FLAG_FORWARD_HEADER]!),
    }).toEqual(FLAGS_A);

    await toolsClient.createToolsClient({ paths: FAKE_PATHS }).callTool(TOOL, {});

    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${LOCAL_URL}/tools`,
      `POST ${LOCAL_URL}/tools/${TOOL}`,
    ]);
    for (const req of requests) {
      // The local server reads the very files this would forward.
      expect(req.headers).not.toHaveProperty(FLAG_FORWARD_HEADER);
      // Absence is scoped to the flag header — auth still rides along.
      expect(req.headers.Authorization).toBe(`Bearer ${LOCAL_TOKEN}`);
    }
  });
});

describe("per-request re-read", () => {
  it("reflects a flags.json edit on the next call, with no new client", async () => {
    writeGlobalFlags(FLAGS_A);
    vi.stubEnv("ARGENT_TOOLS_URL", REMOTE_URL);

    const client = toolsClient.createToolsClient();
    await client.fetchTools();
    // `argent enable` / `argent disable` between two calls of a long-lived
    // MCP session — it must reach the linked server without a re-link.
    writeGlobalFlags(FLAGS_B);
    await client.fetchTools();

    expect(requests).toHaveLength(2);
    expect(forwardedFlagsOf(requests[0]!)).toEqual(FLAGS_A);
    expect(forwardedFlagsOf(requests[1]!)).toEqual(FLAGS_B);
    expect(requests[1]!.headers[FLAG_FORWARD_HEADER]).not.toBe(
      requests[0]!.headers[FLAG_FORWARD_HEADER]
    );
  });
});
