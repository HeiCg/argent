import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { decodeForwardedFlags, readEffectiveFlags, setFlag } from "@argent/configuration-core";

// Header names are spelled out here rather than imported from
// @argent/configuration-core: they are the wire contract with a tool-server
// built from a different checkout, so a rename has to surface as a failure
// instead of being followed silently on both sides.
const FLAGS_HEADER = "x-argent-flags"; // node lower-cases inbound header names
const ACK_HEADER = "X-Argent-Flags-Applied";

// `link.ts` pulls in link-config.ts, which captures ~/.argent from homedir() at
// module load. HOME is therefore redirected before the first import (the same
// pattern as argent-tools-client/test/link-config.test.ts) so `argent link`
// persists its link.json into a temp home and never touches the developer's
// real one. process.cwd() moves to a marker-bearing temp dir for the same
// reason: readEffectiveFlags() resolves the project scope from it.
let link: (argv: string[]) => Promise<void>;
let TEST_HOME: string;
let TEST_PROJECT: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalToolsUrl: string | undefined;
let originalCwd: string;

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

// Stand-in tool-server for the pre-flight `GET <url>/tools` probe. `ackFlags`
// switches between a server that applies forwarded flags (sets the ack header)
// and one that predates the feature (never sets it).
const state: { ackFlags: boolean; requests: RecordedRequest[] } = {
  ackFlags: true,
  requests: [],
};

let server: http.Server;
let probePort: number;

function startProbeServer(): Promise<void> {
  server = http.createServer((req, res) => {
    state.requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
    });
    if (req.method === "GET" && req.url === "/tools") {
      if (state.ackFlags) res.setHeader(ACK_HEADER, "true");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ tools: [] }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      probePort = (server.address() as AddressInfo).port;
      resolve();
    });
  });
}

beforeAll(async () => {
  // realpath unwraps macOS's /var → /private/var tmpdir symlink so the path the
  // flag reader derives matches what process.cwd() reports after chdir().
  TEST_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-link-flags-home-")));
  TEST_PROJECT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-link-flags-proj-")));
  // Marker so resolveProjectRoot stops here instead of walking up into the
  // actual repo and reading (or reporting) its .argent/flags.json.
  fs.writeFileSync(path.join(TEST_PROJECT, "package.json"), "{}");

  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalToolsUrl = process.env.ARGENT_TOOLS_URL;
  originalCwd = process.cwd();
  process.env.HOME = TEST_HOME;
  process.env.USERPROFILE = TEST_HOME;
  // link() prints an extra precedence note when this is set; keep stdout/stderr
  // attributable to flag forwarding alone.
  delete process.env.ARGENT_TOOLS_URL;
  process.chdir(TEST_PROJECT);

  vi.resetModules();
  const { LINK_PATHS } = await import("@argent/tools-client");
  // Gate: if the redirection ever stops working, fail here rather than
  // overwriting the developer's real ~/.argent/link.json from a test.
  expect(LINK_PATHS.LINK_FILE.startsWith(TEST_HOME)).toBe(true);
  ({ link } = await import("../src/link.js"));

  await startProbeServer();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalToolsUrl === undefined) delete process.env.ARGENT_TOOLS_URL;
  else process.env.ARGENT_TOOLS_URL = originalToolsUrl;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.rmSync(TEST_PROJECT, { recursive: true, force: true });
});

beforeEach(() => {
  state.ackFlags = true;
  state.requests = [];
  // Clears both flags.json scopes and the persisted link.json, so no test
  // inherits another's flags or its stored token.
  fs.rmSync(path.join(TEST_HOME, ".argent"), { recursive: true, force: true });
  fs.rmSync(path.join(TEST_PROJECT, ".argent"), { recursive: true, force: true });
});

interface LinkOutput {
  stdout: string;
  stderr: string;
}

/**
 * Run `argent link --yes` against the probe server, capturing both streams.
 * `--yes` keeps it non-interactive: no prompts, no spinner.
 */
async function runLink(extraArgs: string[] = []): Promise<LinkOutput> {
  let stdout = "";
  let stderr = "";
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout += args.join(" ") + "\n";
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr += args.join(" ") + "\n";
  });
  const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array
  ): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0}) called; stderr was: ${stderr}`);
  }) as never);
  try {
    await link(["--host", "127.0.0.1", "--port", String(probePort), "--yes", ...extraArgs]);
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { stdout, stderr };
}

/** Decode the flag set the probe actually put on the wire. */
function forwardedFlags(req: RecordedRequest): Record<string, boolean> {
  const raw = req.headers[FLAGS_HEADER];
  if (typeof raw !== "string") {
    throw new Error(`expected a string ${FLAGS_HEADER} header, got ${JSON.stringify(raw)}`);
  }
  // Spread off decodeForwardedFlags' null-prototype object so toEqual compares
  // against an ordinary object literal.
  return { ...decodeForwardedFlags(raw) };
}

describe("argent link — pre-flight probe carries the caller's flags", () => {
  it("sends X-Argent-Flags decoding to this machine's effective flag set", async () => {
    setFlag("alpha-flag", true, "global");
    setFlag("beta-flag", false, "project");

    await runLink();

    expect(state.requests).toHaveLength(1);
    const probe = state.requests[0]!;
    expect(probe.method).toBe("GET");
    expect(probe.url).toBe("/tools");
    expect(forwardedFlags(probe)).toEqual({ "alpha-flag": true, "beta-flag": false });
    // Same set the tool calls will forward — the probe validates the tool list
    // the link actually produces, not the server's unfiltered one.
    expect(forwardedFlags(probe)).toEqual(readEffectiveFlags());
  });

  it("sends Authorization alongside the flags header when a token is given", async () => {
    setFlag("alpha-flag", true, "global");

    await runLink(["--token", "tok_abc"]);

    const probe = state.requests[0]!;
    expect(probe.headers.authorization).toBe("Bearer tok_abc");
    expect(forwardedFlags(probe)).toEqual({ "alpha-flag": true });
  });
});

describe("argent link — X-Argent-Flags-Applied acknowledgement", () => {
  it("warns on STDERR when local flags exist and the server does not acknowledge them", async () => {
    state.ackFlags = false; // server predates flag forwarding
    setFlag("alpha-flag", true, "global");
    setFlag("beta-flag", false, "project");

    const { stdout, stderr } = await runLink();

    expect(stderr).toMatch(/WARNING/);
    expect(stderr).toMatch(/flags/i);
    // Diagnostic goes to stderr only; stdout stays the machine-readable success report.
    expect(stdout).not.toMatch(/WARNING/);
    // The summary is still printed — the warning augments it, it does not replace it.
    expect(stdout).toMatch(/alpha-flag=on/);
  });

  it("stays silent and names each flag with its state when the server acknowledges them", async () => {
    state.ackFlags = true; // identical to the case above but for this header
    setFlag("alpha-flag", true, "global");
    setFlag("beta-flag", false, "project");

    const { stdout, stderr } = await runLink();

    expect(stderr).toBe("");
    expect(stdout).toMatch(/alpha-flag=on/);
    expect(stdout).toMatch(/beta-flag=off/);
    // One summary line, names sorted.
    expect(stdout).toMatch(/alpha-flag=on.*beta-flag=off/);
  });

  it("reports 'none set on this machine' and still warns an unacknowledging server", async () => {
    state.ackFlags = false; // same old server as the warning case

    const { stdout, stderr } = await runLink();

    expect(stdout).toContain("flags: none set on this machine");
    // An empty set is the STRONGEST assertion in this protocol — it turns every
    // flag-gated tool off. A server that ignores it falls back to its own
    // flags.json and may serve tools the line above just said would be hidden,
    // so the unacknowledged probe matters here as much as with flags set.
    expect(stderr).toMatch(/WARNING/);
    // The header still goes out — an empty set is a set, not an absence.
    expect(forwardedFlags(state.requests[0]!)).toEqual({});
  });

  it("does not warn about an empty set when the server acknowledges it", async () => {
    state.ackFlags = true;

    const { stdout, stderr } = await runLink();

    expect(stdout).toContain("flags: none set on this machine");
    expect(stderr).toBe("");
  });

  it("--no-verify reports the flags without a probe, so nothing is unacknowledged", async () => {
    state.ackFlags = false;
    setFlag("alpha-flag", true, "global");

    const { stdout, stderr } = await runLink(["--no-verify"]);

    expect(state.requests).toHaveLength(0);
    expect(stdout).toMatch(/alpha-flag=on/);
    expect(stderr).not.toMatch(/WARNING/);
  });
});
