import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FlowScriptExecutor,
  type FlowScriptExecutorOptions,
  type FlowScriptFailureKind,
} from "../../../src/tools/flows/script/flow-script-executor";
import { createScriptWorkspace, type ScriptWorkspace } from "../../helpers/flow-script-workspace";

const workspaces: ScriptWorkspace[] = [];

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("life");
  workspaces.push(ws);
  return ws;
}

afterEach(() => {
  while (workspaces.length) workspaces.pop()!.cleanup();
});

function executor(options: FlowScriptExecutorOptions = {}): FlowScriptExecutor {
  return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000, ...options });
}

const TIMEOUT: FlowScriptFailureKind = "timeout";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `file` exists and holds a pid, or give up. */
async function readPidFile(file: string, timeoutMs = 10_000): Promise<number> {
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

describe("flow script executor — time limits and cancellation", () => {
  it("stops a synchronous infinite loop at the time limit", async () => {
    const ws = workspace();
    const script = ws.write("spin.mjs", `for (;;) {}`);
    const started = Date.now();
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 800,
    });

    expect(result.failure?.kind).toBe(TIMEOUT);
    expect(result.failure?.message).toContain("800ms time limit");
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("stops a script waiting on a promise that never resolves", async () => {
    const ws = workspace();
    const script = ws.write("hang.mjs", `await new Promise(() => {});`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 700,
    });

    expect(result.failure?.kind).toBe("timeout");
  });

  it("keeps the logs a timed-out script already wrote", async () => {
    const ws = workspace();
    const script = ws.write(
      "noisy-hang.mjs",
      `console.log("started the seed"); await new Promise(() => {});`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 700,
    });

    expect(result.failure?.kind).toBe("timeout");
    expect(result.log).toContain("started the seed");
  });

  it("cancels a running script when the signal aborts", async () => {
    const ws = workspace();
    const script = ws.write("slow.mjs", `await new Promise((r) => setTimeout(r, 30000));`);
    const controller = new AbortController();
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    await delay(300);
    controller.abort();
    const result = await pending;

    expect(result.failure?.kind).toBe("cancelled");
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it("refuses a step whose signal is already aborted, without spawning", async () => {
    const ws = workspace();
    const script = ws.write("never.mjs", `output.ran = true;`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      signal: AbortSignal.abort(),
    });

    expect(result.failure?.kind).toBe("cancelled");
    expect(result.output).toBeUndefined();
  });

  it("clamps a time limit above the host maximum and says so", async () => {
    const ws = workspace();
    const script = ws.write("quick.mjs", `output.ok = true;`);
    const result = await executor({ maxTimeoutMs: 5_000 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 600_000,
    });

    expect(result.ok).toBe(true);
    expect(result.notes.join(" ")).toContain("above this host's maximum of 5s");
  });
});

describe("flow script executor — exit classification", () => {
  it("names the exit code when the script stops its own process", async () => {
    const ws = workspace();
    const script = ws.write("bye.mjs", `console.log("leaving"); process.exit(3);`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toContain("exit code 3");
    expect(result.log).toContain("leaving");
  });

  it("reports a signal death as a runner error naming the signal", async () => {
    const ws = workspace();
    // A process killed by a signal did not choose to stop; calling that
    // self-termination would send the author to the wrong line of code.
    const script = ws.write(
      "signal.mjs",
      `process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 5000));`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure?.kind).toBe("signal");
    expect(result.failure?.message).toContain("SIGTERM");
    expect(result.failure?.message).toContain("did not stop itself");
  });

  it("reports heap exhaustion as a heap limit, collapses the frame dump and keeps the script's own logs", async () => {
    const ws = workspace();
    const script = ws.write(
      "hungry.mjs",
      `console.log("allocating");
       const held = [];
       for (;;) held.push("x".repeat(1024 * 1024));`
    );
    const result = await executor({ heapLimitMb: 64 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 30_000,
    });

    expect(result.failure?.kind).toBe("heap");
    expect(result.failure?.message).toBe("The script exceeded its 64 MiB heap limit.");
    expect(result.log).toContain("allocating");
    expect(result.log).toMatch(/\[\d+ V8 stack frames omitted]/);
    // The numbered frame list is gone; the summary that names the cause is not.
    expect(result.log).not.toMatch(/^\s*\d+: 0x[0-9a-f]{6}/m);
  }, 60_000);
});

describe("flow script executor — process cleanup", () => {
  it("stops a descendant the script started when the step times out", async () => {
    const ws = workspace();
    const pidFile = ws.resolve("descendant.pid");
    const script = ws.write(
      "spawner.mjs",
      `import { spawn } from "node:child_process";
       import fs from "node:fs";
       const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
       await new Promise(() => {});`
    );
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 1_500,
    });
    const descendant = await readPidFile(pidFile);
    expect(isAlive(descendant)).toBe(true);

    const result = await pending;
    expect(result.failure?.kind).toBe("timeout");
    expect(await waitForExit(descendant, 8_000)).toBe(true);
  }, 30_000);

  it("reaps a spinning orphan when its parent is SIGKILLed", async () => {
    const ws = workspace();
    const pidFile = ws.resolve("runner.pid");
    const script = ws.write(
      "orphan.mjs",
      `import fs from "node:fs";
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       for (;;) {}`
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
      ],
      { cwd: path.resolve(__dirname, "../../.."), stdio: "ignore" }
    );
    try {
      const runnerPid = await readPidFile(pidFile, 30_000);
      expect(isAlive(runnerPid)).toBe(true);

      // The tool server dies without a chance to clean up. A group stop would
      // not reach the detached runner and its `disconnect` handler can never run
      // while the main thread spins, so only the lifeline thread can stop it.
      parent.kill("SIGKILL");
      expect(await waitForExit(runnerPid, 15_000)).toBe(true);
    } finally {
      parent.kill("SIGKILL");
    }
  }, 60_000);
});

describe("flow script watchdogs", () => {
  it("costs a fast script very little", async () => {
    const ws = workspace();
    const script = ws.write("empty.mjs", `output.ok = true;`);
    // Warm the module cache so the number reflects process start, not the
    // first-import cost of this test file.
    const shared = executor();
    await shared.execute({ scriptPath: script, projectRoot: ws.dir });
    const result = await shared.execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.ok).toBe(true);
    // Both watchdog threads run for this whole window; it is still well under a
    // second on a loaded CI box.
    expect(result.durationMs).toBeLessThan(3_000);
  });
});

describe("flow script executor — the configured maximum", () => {
  it("names a multi-minute maximum in minutes", async () => {
    const ws = workspace();
    const script = ws.write("quick.mjs", `output.ok = true;`);
    const result = await executor({ maxTimeoutMs: 5 * 60_000 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 10 * 60_000,
    });

    expect(result.ok).toBe(true);
    expect(result.notes.join(" ")).toContain("above this host's maximum of 5m");
  });
});
