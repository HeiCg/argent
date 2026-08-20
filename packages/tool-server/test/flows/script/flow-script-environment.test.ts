import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIN_SCRIPT_HEAP_LIMIT_MB } from "@argent/configuration-core";
import {
  FlowScriptExecutor,
  type FlowScriptExecutorOptions,
} from "../../../src/tools/flows/script/flow-script-executor";
import { createScriptWorkspace, type ScriptWorkspace } from "../../helpers/flow-script-workspace";

const workspaces: ScriptWorkspace[] = [];
const restoreEnv: Array<() => void> = [];

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("env");
  workspaces.push(ws);
  return ws;
}

/** Set a tool-server environment variable for one test only. */
function withEnv(name: string, value: string): void {
  const before = process.env[name];
  restoreEnv.push(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
  process.env[name] = value;
}

afterEach(() => {
  while (restoreEnv.length) restoreEnv.pop()!();
  while (workspaces.length) workspaces.pop()!.cleanup();
});

function executor(options: FlowScriptExecutorOptions = {}) {
  return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000, ...options });
}

/** A script that copies the values it is asked about into `output`. */
function reporter(names: string[]): string {
  return `output.env = {}; for (const name of ${JSON.stringify(names)}) {
    output.env[name] = process.env[name] ?? null;
  }`;
}

describe("flow script executor — the environment allowlist", () => {
  it("keeps the tool server's token, port and secrets out while keeping the shell basics in", async () => {
    withEnv("ARGENT_AUTH_TOKEN", "tool-server-bearer-token");
    withEnv("ARGENT_PORT", "43111");
    withEnv("ARGENT_SECRET_APP_PASSWORD", "hunter2");
    const ws = workspace();
    const script = ws.write(
      "env.mjs",
      reporter(["ARGENT_AUTH_TOKEN", "ARGENT_PORT", "ARGENT_SECRET_APP_PASSWORD", "PATH", "HOME"])
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    const env = result.output?.env as Record<string, string | null>;
    expect(env.ARGENT_AUTH_TOKEN).toBeNull();
    expect(env.ARGENT_PORT).toBeNull();
    expect(env.ARGENT_SECRET_APP_PASSWORD).toBeNull();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
  });

  it("copies every npm_config_ value, so a project's npm settings survive", async () => {
    withEnv("npm_config_registry", "https://registry.example.com/");
    const ws = workspace();
    const script = ws.write("env.mjs", reporter(["npm_config_registry"]));
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect((result.output?.env as Record<string, string>).npm_config_registry).toBe(
      "https://registry.example.com/"
    );
  });

  it("copies the caller's own environment values on top", async () => {
    const ws = workspace();
    const script = ws.write("env.mjs", reporter(["API_URL", "API_KEY"]));
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_URL: "https://api.example.com", API_KEY: "abc" },
    });

    expect(result.output?.env).toEqual({ API_URL: "https://api.example.com", API_KEY: "abc" });
  });

  it.each(["NODE_OPTIONS", "NODE_CHANNEL_FD", "NODE_UNIQUE_ID", "ELECTRON_RUN_AS_NODE"])(
    "refuses %s in a caller-supplied environment",
    async (name) => {
      const ws = workspace();
      const script = ws.write("env.mjs", `output.ok = true;`);
      const result = await executor().execute({
        scriptPath: script,
        projectRoot: ws.dir,
        env: { [name]: "1" },
      });

      expect(result.failure?.kind).toBe("invalid");
      expect(result.failure?.message).toContain(name);
    }
  );

  it.each(["ELECTRON_RUN_AS_NODE", "Electron_Run_As_Node"])(
    "boots the child as Node when the server's environment carries %s",
    async (name) => {
      // An Electron-hosted tool server makes `process.execPath` the Electron
      // binary, and only this flag keeps a forked child in Node mode. The read
      // has to be case-insensitive: a Windows host may surface non-canonical
      // casing, and missing it would boot a GUI Electron process per script step.
      withEnv(name, "1");
      const ws = workspace();
      const script = ws.write("env.mjs", reporter(["ELECTRON_RUN_AS_NODE"]));
      const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

      expect((result.output?.env as Record<string, string>).ELECTRON_RUN_AS_NODE).toBe("1");
    }
  );

  it("does not set the Electron flag when the server's environment lacks it", async () => {
    const ws = workspace();
    const script = ws.write("env.mjs", reporter(["ELECTRON_RUN_AS_NODE"]));
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect((result.output?.env as Record<string, string | null>).ELECTRON_RUN_AS_NODE).toBeNull();
  });
});

describe("flow script executor — execArgv", () => {
  it("sets the heap limit and inherits nothing from the parent's own execArgv", async () => {
    const before = process.execArgv;
    process.execArgv = ["--stack-size=2000"];
    try {
      const ws = workspace();
      const script = ws.write("argv.mjs", `output.execArgv = process.execArgv;`);
      // Explicit, because `resolveBounds` falls back to the real
      // `~/.argent/config.json`: `test/setup/clear-argent-env.ts` strips
      // ARGENT_* environment variables but cannot strip a config file, so a
      // developer who has set `scripts.heapLimitMb` — the key this ships —
      // would read this assertion as a source regression.
      const result = await executor({ heapLimitMb: 512 }).execute({
        scriptPath: script,
        projectRoot: ws.dir,
      });

      // The heap limit and the runner preload, and nothing the parent was
      // started with.
      const execArgv = result.output?.execArgv as string[];
      expect(execArgv[0]).toBe("--max-old-space-size=512");
      expect(execArgv[1]).toBe("--import");
      expect(execArgv[2]).toMatch(/^file:\/\/.*flow-script-runner\.mjs$/);
      expect(execArgv).toHaveLength(3);
    } finally {
      process.execArgv = before;
    }
  });
});

describe("flow script executor — the heap limit", () => {
  it("floors a heap limit too small for a Node process to start", async () => {
    const ws = workspace();
    const script = ws.write("argv.mjs", `output.execArgv = process.execArgv;`);
    // Below about 5 MiB the child dies inside V8's own startup, before the
    // runner can send anything, and every step failed with a protocol error
    // that named neither the bound nor the value behind it.
    const result = await executor({ heapLimitMb: 2 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
    });

    expect(result.ok).toBe(true);
    expect(result.output?.execArgv).toContain(`--max-old-space-size=${MIN_SCRIPT_HEAP_LIMIT_MB}`);
  });
});

describe("flow script executor — the working directory", () => {
  it("runs in project_root when it exists", async () => {
    const ws = workspace();
    const script = ws.write("cwd.mjs", `output.cwd = process.cwd();`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(fs.realpathSync(result.output?.cwd as string)).toBe(fs.realpathSync(ws.dir));
  });

  it("falls back to the flow file's directory when project_root does not exist, and says so", async () => {
    // `project_root` names the calling agent's working directory, which can be
    // mistyped or since moved. Without the existence check the child spawns into
    // a directory that is not there and fails with a bare ENOENT.
    const ws = workspace();
    const script = ws.write("cwd.mjs", `output.cwd = process.cwd();`);
    const missing = path.join(os.tmpdir(), "argent-not-a-real-project-root");
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: missing,
      flowDir: ws.dir,
    });

    expect(fs.realpathSync(result.output?.cwd as string)).toBe(fs.realpathSync(ws.dir));
    expect(result.notes.join(" ")).toContain(missing);
  });

  it("refuses a relative project_root rather than resolving it against its own cwd", async () => {
    const ws = workspace();
    const script = ws.write("cwd.mjs", `output.cwd = process.cwd();`);
    // A relative path is resolved by the OS against the *tool server's* working
    // directory — the one value this must never inherit, since an editor sets it
    // and it can be `/` or `$HOME`. A relative root that happens to exist also
    // beat a perfectly good absolute fallback.
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ".",
      flowDir: ws.dir,
    });

    expect(fs.realpathSync(result.output?.cwd as string)).toBe(fs.realpathSync(ws.dir));
    expect(result.output?.cwd).not.toBe(process.cwd());
    expect(result.notes.join(" ")).toContain("is not an absolute path");
  });

  it("says a project_root that is a file is not a directory", async () => {
    const ws = workspace();
    const script = ws.write("cwd.mjs", `output.cwd = process.cwd();`);
    // Naming the flow file instead of its directory: "does not exist" would
    // send the author looking for the wrong problem.
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: script,
      flowDir: ws.dir,
    });

    expect(result.notes.join(" ")).toContain("is not a directory");
  });

  it("refuses the step when no candidate directory exists", async () => {
    const ws = workspace();
    const script = ws.write("cwd.mjs", `output.cwd = process.cwd();`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: path.join(os.tmpdir(), "argent-missing-a"),
      flowDir: path.join(os.tmpdir(), "argent-missing-b"),
    });

    expect(result.failure?.kind).toBe("invalid");
    expect(result.failure?.message).toContain("No working directory exists");
  });

  it("refuses a step given no working directory at all", async () => {
    const ws = workspace();
    const script = ws.write("cwd.mjs", `output.cwd = process.cwd();`);
    const result = await executor().execute({ scriptPath: script });

    expect(result.failure?.kind).toBe("invalid");
    expect(result.failure?.message).toContain("No working directory was given");
  });

  it("never inherits the tool server's own working directory", async () => {
    const ws = workspace();
    const script = ws.write("cwd.mjs", `output.cwd = process.cwd();`);
    const result = await executor().execute({ scriptPath: script, flowDir: ws.dir });

    expect(fs.realpathSync(result.output?.cwd as string)).toBe(fs.realpathSync(ws.dir));
    expect(result.output?.cwd).not.toBe(process.cwd());
  });
});
