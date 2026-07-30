import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FLAG_FORWARD_HEADER,
  decodeForwardedFlags,
  getFlagsPath,
} from "@argent/configuration-core";

// The MCP server decides per request what to put on the wire, and the flag
// header is gated on the startup routing decision — so these tests drive the
// real `startMcpServer` through a real MCP client and inspect the header
// records handed to `fetch`, rather than trusting `flagForwardHeaders()` in
// isolation (that unit has its own coverage in
// argent-tools-client/test/flag-forwarding.test.ts).
//
// Stdio is the only transport the server knows how to build, so it is swapped
// for an in-memory pair: everything else — the ListTools/CallTool handlers, the
// header merge, the routing decision — runs for real. Going through a real
// client is also what makes `X-Argent-AI-Client` observable, since its value
// comes from the `initialize` handshake's clientInfo.name.
//
// HOME is redirected the same way the tools-client test does it, and for the
// same reason: link-config.ts captures LINK_FILE from `homedir()` at load, so HOME
// must point at a temp dir BEFORE the module under test is imported —
// otherwise a developer's real ~/.argent/link.json would silently make the
// "no remote target" case routed.

const REMOTE_URL = "http://remote.example:9100";
const REMOTE_TOKEN = "remote_tok_mcp";
/** Stands in for an auto-spawned local server — see the tools-client mock. */
const LOCAL_URL = "http://127.0.0.1:65534";
const LOCAL_TOKEN = "local_tok_mcp";
/** Not in AUTO_SCREENSHOT_TOOLS, so a call makes exactly one GET and one POST. */
const TOOL = "list-devices";
/** canonicalizeAiClient maps this handshake name to the `claude_code` bucket. */
const CLIENT_NAME = "claude-code";

const transportHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  // `new`-ed by startMcpServer, so this has to be constructible: a function
  // that returns an object hands that object back from `new`.
  StdioServerTransport: function StdioServerTransport() {
    const staged = transportHolder.current;
    if (!staged) throw new Error("no in-memory transport staged for this server");
    transportHolder.current = null;
    return staged;
  },
}));

// The no-remote-target path ends in `ensureToolsServer` spawning a real
// tool-server process. Only that spawn is faked: `getResolvedToolsUrl()` and
// `flagForwardHeaders()` still run for real, and they are where the forwarding
// decision is made.
vi.mock("@argent/tools-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/tools-client")>();
  return {
    ...actual,
    ensureToolsServer: async () => ({ url: LOCAL_URL, token: LOCAL_TOKEN }),
  };
});

const FAKE_PATHS: import("@argent/tools-client").ToolsServerPaths = {
  bundlePath: "/unused/tool-server.cjs",
  simulatorServerDir: "/unused/sim",
  nativeDevtoolsDir: "/unused/dylibs",
};

let mcpServer: typeof import("../src/mcp-server.js");
let TEST_HOME: string;
let GLOBAL_FLAGS_FILE: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-mcp-flag-headers-test-"));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = TEST_HOME;
  process.env.USERPROFILE = TEST_HOME;
  vi.resetModules();
  mcpServer = await import("../src/mcp-server.js");

  const { LINK_PATHS } = await import("@argent/tools-client");
  GLOBAL_FLAGS_FILE = getFlagsPath("global");
  // Gates: if the redirection ever stops working, fail here rather than
  // reading — or overwriting — the developer's real ~/.argent.
  expect(GLOBAL_FLAGS_FILE.startsWith(TEST_HOME)).toBe(true);
  expect(LINK_PATHS.LINK_FILE.startsWith(TEST_HOME)).toBe(true);
  // The forwarded set is the EFFECTIVE one (project entries shadow global), and
  // project scope is resolved from the cwd — this package dir, which carries no
  // .argent/flags.json. Assert that instead of assuming it, so a stray project
  // file shows up as one clear failure rather than a mystery diff below.
  expect(existsSync(getFlagsPath("project"))).toBe(false);
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
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
    return { tools: [{ name: TOOL, description: "lists devices", inputSchema: {} }] };
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
// its own lookups against. `disable-auto-screenshot` stays false so the
// auto-screenshot path is live and its absence here is the tool's own doing.
const FLAGS = {
  "argent-lens": true,
  "disable-auto-screenshot": false,
  "unregistered-experiment": true,
};

let openTransports: InMemoryTransport[] = [];

/** Start the real MCP server on an in-memory transport pair and hand back a
 * connected client, so requests flow through the actual request handlers. */
async function connectMcpClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  transportHolder.current = serverTransport;
  await mcpServer.startMcpServer({ paths: FAKE_PATHS });
  const client = new Client({ name: CLIENT_NAME, version: "1.0.0" });
  await client.connect(clientTransport);
  openTransports.push(clientTransport, serverTransport);
  return client;
}

beforeEach(() => {
  requests = [];
  openTransports = [];
  // A developer's shell may export either of these; the no-override case
  // depends on both being absent.
  vi.stubEnv("ARGENT_TOOLS_URL", undefined);
  vi.stubEnv("ARGENT_AUTH_TOKEN", undefined);
  // Keeps the first-run telemetry notice off stderr and out of the temp home;
  // it is unrelated to what is on the wire.
  vi.stubEnv("ARGENT_TELEMETRY", "0");
  rmSync(GLOBAL_FLAGS_FILE, { force: true });
  writeGlobalFlags(FLAGS);
  stubFetch();
});

afterEach(async () => {
  for (const transport of openTransports) await transport.close();
  transportHolder.current = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("MCP server — remote-routed", () => {
  it("forwards the caller's effective flags on GET /tools", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", REMOTE_URL);
    vi.stubEnv("ARGENT_AUTH_TOKEN", REMOTE_TOKEN);

    const client = await connectMcpClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([TOOL]);

    expect(requests).toHaveLength(1);
    const get = requests[0]!;
    expect(get.method).toBe("GET");
    expect(get.url).toBe(`${REMOTE_URL}/tools`);
    expect(forwardedFlagsOf(get)).toEqual(FLAGS);
    // Absence of a regression, not of the header: auth must survive the merge
    // that added the flags.
    expect(get.headers.Authorization).toBe(`Bearer ${REMOTE_TOKEN}`);
  });

  it("forwards them on POST /tools/:name, alongside Content-Type, auth and the AI client", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", REMOTE_URL);
    vi.stubEnv("ARGENT_AUTH_TOKEN", REMOTE_TOKEN);

    const client = await connectMcpClient();
    const result = await client.callTool({ name: TOOL, arguments: { platform: "ios" } });
    expect(result.isError).toBeFalsy();

    // The call re-lists tools first to pick up the tool's metadata; both
    // requests carry the flags.
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${REMOTE_URL}/tools`,
      `POST ${REMOTE_URL}/tools/${TOOL}`,
    ]);
    for (const req of requests) expect(forwardedFlagsOf(req)).toEqual(FLAGS);

    const post = requests.at(-1)!;
    // All four must survive the merge — a spread that drops auth, the body
    // content type or the client identity would break authenticated calls or
    // silently blind tool telemetry.
    expect(post.headers["Content-Type"]).toBe("application/json");
    expect(post.headers.Authorization).toBe(`Bearer ${REMOTE_TOKEN}`);
    expect(post.headers["X-Argent-AI-Client"]).toBe("claude_code");
    expect(forwardedFlagsOf(post)).toEqual(FLAGS);
  });
});

describe("MCP server — no remote target, local auto-spawn", () => {
  it("omits the flags header on both the GET and the POST", async () => {
    const { getResolvedToolsUrl, flagForwardHeaders } = await import("@argent/tools-client");
    expect(await getResolvedToolsUrl()).toEqual({ url: null, source: "none" });
    // Not a vacuous absence: there IS a flag set to forward, and the
    // remote-routed cases above forward exactly this one.
    expect({ ...decodeForwardedFlags(flagForwardHeaders()[FLAG_FORWARD_HEADER]!) }).toEqual(FLAGS);

    const client = await connectMcpClient();
    const result = await client.callTool({ name: TOOL, arguments: { platform: "ios" } });
    expect(result.isError).toBeFalsy();

    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${LOCAL_URL}/tools`,
      `POST ${LOCAL_URL}/tools/${TOOL}`,
    ]);
    for (const req of requests) {
      // The auto-spawned server reads the very files this would forward.
      expect(req.headers).not.toHaveProperty(FLAG_FORWARD_HEADER);
      // Absence is scoped to the flag header — everything else still rides along.
      expect(req.headers.Authorization).toBe(`Bearer ${LOCAL_TOKEN}`);
    }
    const post = requests.at(-1)!;
    expect(post.headers["Content-Type"]).toBe("application/json");
    expect(post.headers["X-Argent-AI-Client"]).toBe("claude_code");
  });
});
