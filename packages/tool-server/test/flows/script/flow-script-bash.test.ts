import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  exchangeDirPrefix,
  FlowScriptExecutor,
  type FlowScriptExecutorOptions,
  type FlowScriptRequest,
  type FlowScriptResult,
} from "../../../src/tools/flows/script/flow-script-executor";
import { resolveBashInterpreter } from "../../../src/tools/flows/script/flow-script-interpreter";
import {
  createScriptWorkspace,
  SOURCE_RUNNER_DIR,
  type ScriptWorkspace,
} from "../../helpers/flow-script-workspace";

/**
 * Every case below runs a real bash. The resolver itself is unit-tested on
 * every host in `flow-script-interpreter.test.ts`, so a host with no bash skips
 * these with the reason rather than failing on it. Resolved in `beforeAll` and
 * applied per test, because the resolver is async and `describe.skipIf` is
 * decided while the file is collected.
 */
let noBash: string | undefined;

beforeAll(async () => {
  const found = await resolveBashInterpreter(undefined);
  if (!("path" in found)) noBash = found.problem;
});

beforeEach((ctx) => {
  if (noBash) ctx.skip(`this host has no bash to run a .sh step with: ${noBash}`);
});

const workspaces: ScriptWorkspace[] = [];

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("bash");
  workspaces.push(ws);
  return ws;
}

const strays: number[] = [];

afterEach(() => {
  while (strays.length) {
    try {
      process.kill(strays.pop()!, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  while (workspaces.length) workspaces.pop()!.cleanup();
});

function executor(options: FlowScriptExecutorOptions = {}): FlowScriptExecutor {
  return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000, ...options });
}

/**
 * The extension never reaches the executor — `flow-script-step.ts` reads it and
 * passes `interpreter` — so these fixtures carry `.sh` because an author would,
 * not because anything here looks at it.
 */
function runBash(
  ws: ScriptWorkspace,
  name: string,
  source: string,
  extras: Partial<FlowScriptRequest> = {},
  options: FlowScriptExecutorOptions = {}
): Promise<FlowScriptResult> {
  const script = ws.write(`${name}.sh`, source);
  return executor(options).execute({
    scriptPath: script,
    interpreter: "bash",
    projectRoot: ws.dir,
    ...extras,
  });
}

/**
 * Windows has no signals and no process group: `kill -TERM` inside Git Bash
 * does not reach the runner as a signal, a `TERM` trap has nothing to catch,
 * and the lifeline reads a descriptor the parent cannot hand it. The cases
 * whose SEMANTICS are POSIX skip there; everything else — the document, the
 * exchange files, the exit codes, the null devices, the tree stop and the
 * deadline watchdog — is what the Windows job runs.
 */
const onPosix = it.skipIf(process.platform === "win32");

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(50);
  }
  return false;
}

async function readPidFile(file: string, timeoutMs = 20_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(file, "utf8").trim();
      if (raw) return Number(raw);
    } catch {
      // Not written yet.
    }
    await delay(50);
  }
  throw new Error(`No pid appeared in ${file}`);
}

function exchangeDirCount(): number {
  return fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(exchangeDirPrefix()))
    .length;
}

/** `${BASH_SOURCE[0]}` written so the TypeScript template does not eat it. */
const BASH_SOURCE = "${BASH_SOURCE[0]}";

describe("a bash step that passes", () => {
  it("returns the document the script wrote, and nothing it printed", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "seed",
      `set -euo pipefail
       echo "seeding order"
       echo "a warning" >&2
       printf '{"order":{"id":"ord_1","total":42}}' > "$ARGENT_OUTPUT"`
    );

    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ order: { id: "ord_1", total: 42 } });
    expect(result.durationMs).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("seeding order");
    expect(JSON.stringify(result)).not.toContain("a warning");
  }, 30_000);

  it("returns the document it was given when the script never touches the file", async () => {
    const ws = workspace();
    const result = await runBash(ws, "quiet", `echo hello`, { output: { given: 41 } });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ given: 41 });
  }, 30_000);

  // The whole reason the parent pre-populates `$ARGENT_OUTPUT` rather than
  // handing bash an empty file: a script that wants to ADD a key reads what it
  // was given first, out of the same file it writes back.
  it("hands the script the flow's own document to read", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "read-given",
      `set -euo pipefail
       cp "$ARGENT_OUTPUT" "$ARGENT_OUTPUT.new"
       mv "$ARGENT_OUTPUT.new" "$ARGENT_OUTPUT"`,
      { output: { given: 41 } }
    );
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ given: 41 });
  }, 30_000);

  it("takes one queue slot per step, whichever language runs", async () => {
    const ws = workspace();
    const shared = executor({ concurrency: 1 });
    const sh = ws.write("slot.sh", `printf '{"sh":true}' > "$ARGENT_OUTPUT"`);
    const mjs = ws.write("slot.mjs", `output.mjs = true;`);
    const [first, second] = await Promise.all([
      shared.execute({ scriptPath: sh, interpreter: "bash", projectRoot: ws.dir }),
      shared.execute({ scriptPath: mjs, projectRoot: ws.dir }),
    ]);
    expect(first.output).toEqual({ sh: true });
    expect(second.output).toEqual({ mjs: true });
    expect(shared.activeCount).toBe(0);
  }, 30_000);
});

describe("the document a bash step returns", () => {
  it("refuses a document the script removed", async () => {
    const ws = workspace();
    const result = await runBash(ws, "removed", `rm "$ARGENT_OUTPUT"`);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("$ARGENT_OUTPUT is gone");
  }, 30_000);

  // `jq … "$ARGENT_OUTPUT" > "$ARGENT_OUTPUT"` truncates the file before jq
  // reads it, and this refusal is what the author then sees.
  it("refuses an empty document, naming the idiom that avoids one", async () => {
    const ws = workspace();
    const result = await runBash(ws, "emptied", `> "$ARGENT_OUTPUT"`);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("empty");
    expect(result.failure?.message).toContain("mv");
  }, 30_000);

  it("refuses a document that is not a JSON object", async () => {
    const ws = workspace();
    for (const [name, written] of [
      ["array", "[1,2]"],
      ["string", '"done"'],
      ["garbage", "not json"],
    ] as const) {
      const result = await runBash(
        ws,
        name,
        `printf '%s' ${JSON.stringify(written)} > "$ARGENT_OUTPUT"`
      );
      expect(result.failure?.kind, written).toBe("output");
    }
  }, 60_000);

  it("refuses an own __proto__ key, as it does from a .mjs", async () => {
    const ws = workspace();
    const result = await runBash(ws, "proto", `printf '{"__proto__":{"x":1}}' > "$ARGENT_OUTPUT"`);
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("__proto__");
  }, 30_000);

  // The read is bounded rather than `stat`-ed first: a `stat` would describe a
  // file a descendant is still growing, and leave the read itself unbounded.
  it("refuses a document one byte over the limit", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "huge",
      `set -euo pipefail
       printf '{"big":"' > "$ARGENT_OUTPUT"
       head -c 1200000 /dev/zero | tr '\\0' 'z' >> "$ARGENT_OUTPUT"
       printf '"}' >> "$ARGENT_OUTPUT"`
    );
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("limit");
  }, 60_000);

  it("does not read the document of a non-zero exit", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "wrote-then-failed",
      `printf '{"order":{"id":"ord_1"}}' > "$ARGENT_OUTPUT"
       exit 1`
    );
    expect(result.ok).toBe(false);
    expect(result.output).toBeUndefined();
    expect(result.failure?.kind).toBe("exit");
  }, 30_000);
});

describe("what a failing bash step says", () => {
  it("names the exit code and the interpreter that ran it", async () => {
    const ws = workspace();
    const result = await runBash(ws, "code3", `exit 3`);
    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toMatch(/exited with code 3/);
    expect(result.failure?.message).toMatch(/bash: \S+/);
  }, 30_000);

  it("appends what the script wrote to $ARGENT_REASON", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "with-reason",
      `echo "the orders API answered 503" > "$ARGENT_REASON"
       exit 1`
    );
    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toContain("the orders API answered 503");
  }, 30_000);

  it("says only the code when the script wrote no reason", async () => {
    const ws = workspace();
    const result = await runBash(ws, "silent", `exit 7`);
    expect(result.failure?.message).toMatch(/^The script exited with code 7 \(bash: .+\)\.$/);
  }, 30_000);

  it("ignores the reason file on exit 0", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "reason-on-pass",
      `echo "not a failure" > "$ARGENT_REASON"
       printf '{"ok":true}' > "$ARGENT_OUTPUT"`
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("not a failure");
  }, 30_000);

  it("clamps a reason at the ceiling and marks what it cut", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "loud-reason",
      `head -c 40000 /dev/zero | tr '\\0' 'x' > "$ARGENT_REASON"
       exit 1`
    );
    expect(result.failure?.kind).toBe("exit");
    expect(result.failure!.message.length).toBeLessThanOrEqual(8 * 1024);
    expect(result.failure?.message).toMatch(/more characters omitted]$/);
  }, 30_000);

  it("hints at the two exit codes that are bash's own, not the script's", async () => {
    const ws = workspace();
    const missing = await runBash(ws, "missing-tool", `argent-no-such-command-here`);
    expect(missing.failure?.kind).toBe("exit");
    expect(missing.failure?.message).toContain("code 127");
    expect(missing.failure?.message).toContain("command not found");

    // Running a directory is the portable way to reach 126.
    const notExecutable = await runBash(
      ws,
      "not-exec",
      `set +e
       "$(dirname "${BASH_SOURCE}")"
       exit $?`
    );
    expect(notExecutable.failure?.message).toContain("code 126");
    expect(notExecutable.failure?.message).toContain("not executable");
  }, 60_000);

  // 128+N is bash reporting a FOREGROUND command killed by signal N. The script
  // chose to run that command and could have handled its status, so the step
  // reads it as an exit code — a `fail`, not the `signal` error that a death of
  // bash itself is.
  onPosix(
    "reads a 128+N exit as the script's own status, not as a signal",
    async () => {
      const ws = workspace();
      const result = await runBash(
        ws,
        "forwarded-signal",
        `set +e
       "$(command -v sh)" -c 'kill -9 $$'
       exit $?`
      );
      expect(result.failure?.kind).toBe("exit");
      expect(result.failure?.message).toContain("code 137");
      expect(result.failure?.message).not.toContain("killed by");
    },
    30_000
  );

  onPosix(
    "reports bash killed by a signal as an error naming it",
    async () => {
      const ws = workspace();
      const result = await runBash(ws, "self-signalled", `kill -TERM $$; sleep 30`);
      expect(result.failure?.kind).toBe("signal");
      expect(result.failure?.message).toContain("SIGTERM");
    },
    30_000
  );

  // The resolver only proves a candidate is an absolute, existing, executable
  // file — never that it is bash, and never that the kernel will exec it. What
  // is left lands on the runner's own `error` handler, and `spawn` is the one
  // kind that tells the author nothing ran.
  onPosix(
    "reports an interpreter the kernel refuses as a spawn error",
    async () => {
      const ws = workspace();
      const project = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bad-bash-"));
      fs.mkdirSync(path.join(project, ".argent"), { recursive: true });
      const notAnExecutable = path.join(project, "bash");
      // Executable, but not a program: no shebang and not a binary, so `execvp`
      // answers ENOEXEC and Node reports it as a spawn `error`.
      fs.writeFileSync(notAnExecutable, "this is not a program\n");
      fs.chmodSync(notAnExecutable, 0o755);
      fs.writeFileSync(
        path.join(project, ".argent", "config.json"),
        JSON.stringify({ scripts: { bash: notAnExecutable } })
      );
      const script = ws.write("never-runs.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);

      try {
        const result = await executor().execute({
          scriptPath: script,
          interpreter: "bash",
          projectRoot: project,
        });

        expect(result.failure?.kind).toBe("spawn");
        expect(result.failure?.message).toContain(notAnExecutable);
        expect(result.failure?.message).toContain("could not be started");
      } finally {
        fs.rmSync(project, { recursive: true, force: true });
      }
    },
    30_000
  );
});

describe("the runner's own channels in bash mode", () => {
  // Descriptor 5 is the protocol channel. A `result` line reaching it would be
  // parsed by Node inside its own read callback in the parent, and a forged
  // verdict is exactly what the three null devices exist to prevent. 3 is the
  // parent's sink and 4 is the lifeline.
  it("gives bash null devices where its own channels are, so no write can forge a verdict", async () => {
    const ws = workspace();
    const forged = '{"type":"result","outputJson":"{\\"forged\\":true}"}';
    const result = await runBash(
      ws,
      "forger",
      `set +e
       echo '${forged}' >&3
       echo '${forged}' >&4
       echo '${forged}' >&5
       printf '{"real":true}' > "$ARGENT_OUTPUT"
       exit 0`
    );

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ real: true });
  }, 30_000);

  it("gives the script an empty stdin, so a read gets end of file", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "stdin",
      `set +e
       if read -r line; then status=read; else status=eof; fi
       printf '{"stdin":"%s"}' "$status" > "$ARGENT_OUTPUT"
       exit 0`
    );
    expect(result.output).toEqual({ stdin: "eof" });
  }, 30_000);

  it("survives a flood on stdout, which nothing reports and nothing may block on", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "flood",
      `set -euo pipefail
       head -c 4000000 /dev/zero | tr '\\0' 'z'
       printf '{"ok":true}' > "$ARGENT_OUTPUT"`
    );
    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain("zzz");
  }, 60_000);

  // The terminal message a runner in bash mode always sends is classified ahead
  // of the stderr scan, which is what keeps a banner printed by something the
  // script ran from becoming the step's verdict.
  it("reads a child's V8 heap banner as the script's exit code, not as a heap limit", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "banner",
      `set +e
       echo "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory" >&2
       exit 9`
    );
    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toContain("code 9");
  }, 30_000);
});

describe("environment and working directory", () => {
  it("gives the script the same allowlist a .mjs gets, plus the two exchange names", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "printenv",
      `set -euo pipefail
       printf '{"names":"%s"}' "$(printenv | sed 's/=.*//' | sort | tr '\\n' ' ')" > "$ARGENT_OUTPUT"`
    );
    const names = String((result.output as { names: string }).names).split(" ");
    expect(names).toContain("PATH");
    expect(names).toContain("ARGENT_OUTPUT");
    expect(names).toContain("ARGENT_REASON");
    expect(names).not.toContain("ARGENT_FLOW_SCRIPT_RUNNER");
    expect(names).not.toContain("NODE_CHANNEL_FD");
    // Nothing bash-specific is admitted: each of these steers bash rather than
    // the runner, and none is in the allowlist.
    for (const name of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "CDPATH", "GLOBIGNORE"]) {
      expect(names, name).not.toContain(name);
    }
  }, 30_000);

  it("refuses either exchange name in a caller's override map", async () => {
    const ws = workspace();
    for (const name of ["ARGENT_OUTPUT", "ARGENT_REASON"]) {
      const result = await runBash(ws, `env-${name}`, `exit 0`, { env: { [name]: "/tmp/x" } });
      expect(result.failure?.kind, name).toBe("invalid");
      expect(result.failure?.message, name).toContain(name);
    }
  }, 30_000);

  // Written as two files rather than as two path strings: under Git Bash `$PWD`
  // is a `/c/…` path no Node call can stat, while `$0` and `$ARGENT_OUTPUT`
  // arrive as `C:/…`. Where each marker lands answers both questions on every
  // platform — and the second one only lands at all because `$0` carries a
  // separator for `dirname` to split on.
  it("runs in project_root, and gives $0 a separator dirname can split on", async () => {
    const ws = workspace();
    const nested = path.join(ws.dir, "nested");
    fs.mkdirSync(nested, { recursive: true });
    const script = ws.write(
      "nested/where.sh",
      `set -euo pipefail
       printf 'cwd' > ./cwd-marker
       printf 'dir' > "$(dirname "${BASH_SOURCE}")/dir-marker"
       printf '{"ok":true}' > "$ARGENT_OUTPUT"`
    );
    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
    });

    expect(result.failure).toBeUndefined();
    expect(fs.existsSync(path.join(ws.dir, "cwd-marker"))).toBe(true);
    expect(fs.existsSync(path.join(nested, "dir-marker"))).toBe(true);
  }, 30_000);
});

describe("limits and stopping", () => {
  it("stops a looping script at its time limit and leaves no process behind", async () => {
    const ws = workspace();
    const pidFile = ws.resolve("child.pid");
    const script = ws.write(
      "loop.sh",
      `sleep 120 &
       echo $! > ${JSON.stringify(pidFile)}
       while true; do sleep 1; done`
    );
    const pending = executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      timeoutMs: 2_000,
    });
    const grandchild = await readPidFile(pidFile);
    strays.push(grandchild);
    const result = await pending;

    expect(result.failure?.kind).toBe("timeout");
    // The runner leads the group, bash joined it and the `sleep` joined bash:
    // the parent's group stop reaches all three with no bash-specific code.
    expect(await waitForExit(grandchild, 10_000)).toBe(true);
  }, 60_000);

  // The group SIGTERM reaches bash and the runner at once, and Node's default
  // handling exits the runner without running its `exit` listener — so a script
  // that traps TERM is left the last member of a leaderless group. The
  // escalation to SIGKILL is what still empties it.
  onPosix(
    "still empties the group when the script traps SIGTERM and keeps running",
    async () => {
      const ws = workspace();
      const pidFile = ws.resolve("trapped.pid");
      const script = ws.write(
        "trap.sh",
        `trap 'true' TERM
       sleep 120 &
       echo $! > ${JSON.stringify(pidFile)}
       while true; do sleep 1; done`
      );
      const pending = executor().execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
        timeoutMs: 2_000,
      });
      const grandchild = await readPidFile(pidFile);
      strays.push(grandchild);
      const result = await pending;

      expect(result.failure?.kind).toBe("timeout");
      expect(await waitForExit(grandchild, 10_000)).toBe(true);
    },
    60_000
  );

  it("cancels a running script after it started, and empties the group", async () => {
    const ws = workspace();
    const pidFile = ws.resolve("cancelled.pid");
    const script = ws.write(
      "wait.sh",
      `sleep 120 &
       echo $! > ${JSON.stringify(pidFile)}
       while true; do sleep 1; done`
    );
    const controller = new AbortController();
    const pending = executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    const grandchild = await readPidFile(pidFile);
    strays.push(grandchild);
    controller.abort();
    const result = await pending;

    expect(result.failure?.kind).toBe("cancelled");
    // It reached the system it talks to, so there IS state to clean up.
    expect(result.failure?.beforeFork).toBeUndefined();
    expect(await waitForExit(grandchild, 10_000)).toBe(true);
  }, 60_000);

  // The parent's own timer and stop cannot run while its loop is blocked, so
  // what reaches this descendant reaches it from inside the child — through the
  // group the deadline watchdog kills. Bash mode installs the same watchdog.
  it("has the deadline watchdog take the whole group when the tool server stalls", async () => {
    const ws = workspace();
    const pidFile = ws.resolve("stalled.pid");
    const script = ws.write(
      "stalled.sh",
      `sleep 300 &
       echo $! > ${JSON.stringify(pidFile)}
       while true; do sleep 1; done`
    );
    const timeoutMs = 2_000;
    const startedAt = Date.now();
    const pending = executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      timeoutMs,
    });
    const descendant = await readPidFile(pidFile);
    strays.push(descendant);

    const probe = (afterDeadlineMs: number) => {
      while (Date.now() - startedAt < timeoutMs + afterDeadlineMs) {
        /* block */
      }
      return isAlive(descendant);
    };
    const withinMargin = probe(1_200);
    const pastMargin = probe(3_500);
    const result = await pending;

    expect(withinMargin).toBe(true);
    expect(pastMargin).toBe(false);
    expect(result.failure?.kind).toBe("timeout");
  }, 60_000);

  it("clamps a time limit above the host maximum and says so, as it does for a .mjs", async () => {
    const ws = workspace();
    const result = await runBash(
      ws,
      "clamped",
      `printf '{"ok":true}' > "$ARGENT_OUTPUT"`,
      { timeoutMs: 90_000 },
      { maxTimeoutMs: 5_000 }
    );
    expect(result.ok).toBe(true);
    expect(result.notes.join(" ")).toContain("above this host's maximum");
  }, 30_000);
});

describe("the private exchange directory", () => {
  it("is gone after a pass, a fail, a timeout and a cancellation", async () => {
    const ws = workspace();
    const before = exchangeDirCount();

    await runBash(ws, "pass", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);
    await runBash(ws, "fail", `exit 1`);
    await runBash(ws, "slow", `while true; do sleep 1; done`, { timeoutMs: 1_000 });

    const controller = new AbortController();
    const script = ws.write("abort.sh", `while true; do sleep 1; done`);
    const pending = executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    await delay(400);
    controller.abort();
    await pending;

    expect(exchangeDirCount()).toBe(before);
  }, 60_000);
});

describe("the published layout", () => {
  // The runner gains a mode, not a file: bash mode has to work from a directory
  // holding only the three `.mjs` the bundle copies, forked as the entry module
  // rather than pulled in as a preload.
  it("runs bash mode from a dist holding only the three runner files", async () => {
    const ws = workspace();
    const dist = ws.resolve("fake-dist");
    fs.mkdirSync(dist, { recursive: true });
    for (const name of [
      "flow-script-runner.mjs",
      "flow-script-watchdog-lifeline.mjs",
      "flow-script-watchdog-deadline.mjs",
    ]) {
      fs.copyFileSync(path.join(SOURCE_RUNNER_DIR, name), path.join(dist, name));
    }
    const script = ws.write("published.sh", `printf '{"ok":true}' > "$ARGENT_OUTPUT"`);

    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      runnerDir: dist,
    });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ ok: true });
  }, 30_000);
});

describe("a tool server that dies mid-step", () => {
  onPosix(
    "takes bash and its descendants with the runner",
    async () => {
      const ws = workspace();
      const bashFile = ws.resolve("bash.pid");
      const childFile = ws.resolve("bash-child.pid");
      const script = ws.write(
        "orphan.sh",
        `sleep 300 &
       echo $! > ${JSON.stringify(childFile)}
       echo $$ > ${JSON.stringify(bashFile)}
       while true; do sleep 1; done`
      );
      const driver = path.resolve(__dirname, "../../fixtures/flow-script-orphan-driver.ts");
      const parent = spawn(
        process.execPath,
        [
          require.resolve("ts-node/dist/bin.js"),
          "-T",
          "-P",
          path.resolve(__dirname, "../../../tsconfig.json"),
          driver,
          script,
          ws.dir,
          "bash",
        ],
        { cwd: path.resolve(__dirname, "../../.."), stdio: ["ignore", "ignore", "pipe"] }
      );
      try {
        const bashPid = await readPidFile(bashFile, 40_000);
        const grandchild = await readPidFile(childFile, 40_000);
        strays.push(bashPid, grandchild);
        expect(isAlive(bashPid)).toBe(true);
        expect(isAlive(grandchild)).toBe(true);

        parent.kill("SIGKILL");
        expect(await waitForExit(bashPid, 20_000)).toBe(true);
        expect(await waitForExit(grandchild, 20_000)).toBe(true);
      } finally {
        parent.kill("SIGKILL");
        for (const file of [bashFile, childFile]) {
          try {
            const written = Number(fs.readFileSync(file, "utf8").trim());
            if (Number.isInteger(written)) strays.push(written);
          } catch {
            // Never written, so there is nothing to reap.
          }
        }
      }
    },
    90_000
  );
});
