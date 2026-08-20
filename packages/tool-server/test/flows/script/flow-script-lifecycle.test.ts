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

/** Pids a test started outside the executor's reach; killed however it ends. */
const strays: number[] = [];

afterEach(() => {
  // A descendant is only stopped by the behaviour under test, so a failing
  // assertion would otherwise leave a spinning process behind — observed for
  // real: a `node -e setInterval(...)` still alive 32s after vitest exited.
  while (strays.length) {
    try {
      process.kill(strays.pop()!, "SIGKILL");
    } catch {
      // Already gone, which is the outcome the test wanted.
    }
  }
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
async function readPidFile(
  file: string,
  timeoutMs = 10_000,
  diagnostics?: () => string
): Promise<number> {
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
  const detail = diagnostics?.().trim();
  throw new Error(`No pid appeared in ${file}${detail ? `\n${detail}` : ""}`);
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

  it("stops a script holding the event loop open at the time limit", async () => {
    const ws = workspace();
    const script = ws.write("hang.mjs", `setInterval(() => {}, 1000);`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 700,
    });

    expect(result.failure?.kind).toBe("timeout");
  });

  it("names a top-level await that never settles instead of waiting out the limit", async () => {
    const ws = workspace();
    // Nothing is left to run, so the step does not have to occupy its slot
    // until the time limit to know the script will never produce output.
    const script = ws.write("unsettled.mjs", `await new Promise(() => {});`);
    const started = Date.now();
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 20_000,
    });

    expect(result.failure?.kind).toBe("runtime");
    expect(result.failure?.message).toContain("never settled");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("keeps the logs a timed-out script already wrote", async () => {
    const ws = workspace();
    const script = ws.write(
      "noisy-hang.mjs",
      `console.log("started the seed"); setInterval(() => {}, 1000);`
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

  it("honours an abort raised in the same tick as the call", async () => {
    const ws = workspace();
    const script = ws.write(
      "slow.mjs",
      `await new Promise((r) => setTimeout(r, 2000));
       console.log("finished work");
       output.done = true;`
    );
    const controller = new AbortController();
    // The queue reads the signal, then hands back a promise; the run's own
    // listener is attached a microtask later. An abort landing in between fires
    // no listener, and nothing else re-read the flag — so the cancellation was
    // lost for the whole life of the step.
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;

    expect(result.failure?.kind).toBe("cancelled");
    expect(result.log).not.toContain("finished work");
    expect(result.durationMs).toBeLessThan(1_000);
  });

  it("does not relabel a cancellation as a timeout when the deadline passes mid-stop", async () => {
    const ws = workspace();
    // A script that ignores SIGTERM outlives the polite stop, so its deadline
    // can pass during the stop grace. The first interruption is the true one.
    const script = ws.write(
      "stubborn.mjs",
      `process.on("SIGTERM", () => {});
       setInterval(() => {}, 1000);`
    );
    const controller = new AbortController();
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 800,
      signal: controller.signal,
    });
    await delay(300);
    controller.abort();
    const result = await pending;

    expect(result.failure?.kind).toBe("cancelled");
  }, 30_000);

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
    // The claim is "without spawning", and this is what proves it: nothing was
    // started, so no wall clock was spent.
    expect(result.durationMs).toBe(0);
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

  it("fails a step whose script set a non-zero process.exitCode", async () => {
    const ws = workspace();
    // `try { await main() } catch (e) { console.error(e); process.exitCode = 1 }`
    // is the recommended way to fail a script, preferred over `process.exit(1)`
    // because it does not truncate stdout. Both have to reach the same verdict.
    const script = ws.write(
      "soft-fail.mjs",
      `console.log("validation failed: 3 of 10 checks");
       output.failures = 3;
       process.exitCode = 1;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toContain("1");
    expect(result.log).toContain("validation failed");
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

  it("still reports a heap limit when the script logged past its log budget first", async () => {
    const ws = workspace();
    // V8 prints its banner last, so a script chatty enough to fill the step's
    // log budget loses the one line that names the cause — and "a progress line
    // per item, then out of heap" is the ordinary shape of a script that hits
    // this limit. The verdict cannot be read off the truncated log.
    const script = ws.write(
      "chatty-hungry.mjs",
      `for (let i = 0; i < 2000; i++) console.log("progress line " + i + " ".repeat(120));
       const held = [];
       for (;;) held.push("x".repeat(1024 * 1024));`
    );
    const result = await executor({ heapLimitMb: 64 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 30_000,
    });

    expect(result.logTruncated).toBe(true);
    expect(result.failure?.kind).toBe("heap");
    expect(result.failure?.message).toBe("The script exceeded its 64 MiB heap limit.");
  }, 60_000);

  it("does not call a forwarded 134 exit status a heap limit", async () => {
    const ws = workspace();
    // A wrapper that runs a build through a shell and forwards its status: the
    // shell reports the aborted build as 128+SIGABRT, and the build's own
    // banner lands in the stream this script inherited. Neither is this
    // process running out of heap.
    ws.write("build.mjs", `const held = []; for (;;) held.push("x".repeat(1024 * 1024));`);
    const script = ws.write(
      "wrapper.mjs",
      `import { spawnSync } from "node:child_process";
       const r = spawnSync(
         "/bin/sh",
         ["-c", process.execPath + " --max-old-space-size=40 build.mjs 2>&1"],
         { encoding: "utf8" }
       );
       console.log(r.stdout);
       process.exit(r.status ?? 0);`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 30_000,
    });

    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toContain("exit code 134");
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
    strays.push(descendant);
    expect(isAlive(descendant)).toBe(true);

    const result = await pending;
    expect(result.failure?.kind).toBe("timeout");
    expect(await waitForExit(descendant, 8_000)).toBe(true);
  }, 30_000);

  it("stops a descendant that ignores SIGTERM when the step is cancelled", async () => {
    const ws = workspace();
    const pidFile = ws.resolve("stubborn.pid");
    // A descendant with its own SIGTERM handler outlives the polite stop. The
    // runner does not — it has no handler and dies in milliseconds — so a
    // forced stop conditioned on the runner alone never happened.
    const script = ws.write(
      "stubborn.mjs",
      `import { spawn } from "node:child_process";
       import fs from "node:fs";
       const child = spawn(
         process.execPath,
         ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
         { stdio: "ignore" }
       );
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
       setInterval(() => {}, 1000);`
    );
    const controller = new AbortController();
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 20_000,
      signal: controller.signal,
    });
    const descendant = await readPidFile(pidFile);
    strays.push(descendant);
    controller.abort();
    const result = await pending;

    expect(result.failure?.kind).toBe("cancelled");
    // The step says the process tree was stopped, so it has to be stopped by
    // the time the step returns — not merely asked to stop.
    expect(isAlive(descendant)).toBe(false);
  }, 30_000);

  it("stops a descendant of a step that returned normally", async () => {
    const ws = workspace();
    const pidFile = ws.resolve("left-behind.pid");
    // Nothing interrupted this step: the script started a subprocess, returned
    // its output and exited, and the subprocess was reparented to init.
    const script = ws.write(
      "leaver.mjs",
      `import { spawn } from "node:child_process";
       import fs from "node:fs";
       const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
         stdio: "ignore",
       });
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
       child.unref();
       output.started = child.pid;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });
    strays.push(result.output?.started as number);

    expect(result.ok).toBe(true);
    expect(isAlive(result.output?.started as number)).toBe(false);
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
      { cwd: path.resolve(__dirname, "../../.."), stdio: ["ignore", "ignore", "pipe"] }
    );
    // Captured, because everything this test can go wrong about happens inside
    // that process: without it a driver that failed to start showed up as an
    // opaque "No pid appeared in …" thirty seconds later.
    let driverStderr = "";
    parent.stderr?.on("data", (chunk: Buffer) => {
      driverStderr += chunk.toString();
    });
    try {
      const runnerPid = await readPidFile(pidFile, 30_000, () => driverStderr);
      strays.push(runnerPid);
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
  it("never hold a finished script open, and cost it very little", async () => {
    const ws = workspace();
    const script = ws.write("empty.mjs", `output.ok = true;`);
    // Warm the module cache so the number reflects process start, not the
    // first-import cost of this test file.
    const shared = executor();
    await shared.execute({ scriptPath: script, projectRoot: ws.dir, timeoutMs: 40_000 });
    const result = await shared.execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 40_000,
    });

    expect(result.ok).toBe(true);
    // The deadline watchdog is parked in `Atomics.wait` for that whole 40s and
    // the lifeline is waiting on a socket that will not close: an un-unref'd
    // worker would hold the process to the deadline, and the step would return
    // a timeout 40 seconds from now instead of an output in tens of
    // milliseconds. Both threads run for this whole window, and it is still
    // well under a second on a loaded CI box.
    expect(result.durationMs).toBeLessThan(3_000);
  }, 60_000);
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
