import { afterEach, describe, expect, it } from "vitest";
import {
  createScriptLogBudget,
  FlowScriptExecutor,
  SCRIPT_STEP_LOG_LIMIT_BYTES,
  type FlowScriptExecutorOptions,
  type FlowScriptLogBudget,
  type FlowScriptSecret,
} from "../../../src/tools/flows/script/flow-script-executor";
import { createScriptWorkspace, type ScriptWorkspace } from "../../helpers/flow-script-workspace";

const workspaces: ScriptWorkspace[] = [];

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("log");
  workspaces.push(ws);
  return ws;
}

afterEach(() => {
  while (workspaces.length) workspaces.pop()!.cleanup();
});

function executor(options: FlowScriptExecutorOptions = {}) {
  return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000, ...options });
}

describe("flow script executor — log capture", () => {
  it("captures stdout and stderr, and a subprocess writing to the same streams", async () => {
    const ws = workspace();
    const script = ws.write(
      "logs.mjs",
      `import { execFileSync } from "node:child_process";
       console.log("from console.log");
       console.info("from console.info");
       console.warn("from console.warn");
       console.error("from console.error");
       execFileSync(process.execPath, ["-e", "console.log('from a subprocess')"], { stdio: "inherit" });
       output.done = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.ok).toBe(true);
    for (const line of [
      "from console.log",
      "from console.info",
      "from console.warn",
      "from console.error",
      "from a subprocess",
    ]) {
      expect(result.log).toContain(line);
    }
  });

  it("keeps the logs of a script that throws", async () => {
    const ws = workspace();
    const script = ws.write(
      "throws.mjs",
      `console.log("before the throw"); throw new Error("nope");`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure?.kind).toBe("runtime");
    expect(result.log).toContain("before the throw");
  });

  it("truncates at the per-step limit without blocking the script", async () => {
    const ws = workspace();
    // Five megabytes, far past the 64 KiB step limit. A capture that paused the
    // stream would fill the pipe buffer and wedge the child, so the proof that
    // it never pauses is that the script still finishes and returns output.
    const script = ws.write(
      "loud.mjs",
      `const line = "y".repeat(1023) + "\\n";
       for (let i = 0; i < 5 * 1024; i++) process.stdout.write(line);
       output.finished = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.output).toEqual({ finished: true });
    expect(result.logTruncated).toBe(true);
    expect(Buffer.byteLength(result.log)).toBeLessThanOrEqual(SCRIPT_STEP_LOG_LIMIT_BYTES);
    expect(Buffer.byteLength(result.log)).toBeGreaterThan(SCRIPT_STEP_LOG_LIMIT_BYTES - 2048);
  });

  it("spends one run budget across every step in the run", async () => {
    const ws = workspace();
    const script = ws.write(
      "chatty.mjs",
      `process.stdout.write("z".repeat(64 * 1024)); output.ok = true;`
    );
    const budget: FlowScriptLogBudget = createScriptLogBudget();
    const shared = executor();
    const sizes: number[] = [];
    // The run budget is 256 KiB and each step fills its own 64 KiB step limit,
    // so the fifth step has nothing left to spend.
    for (let step = 0; step < 5; step++) {
      const result = await shared.execute({
        scriptPath: script,
        projectRoot: ws.dir,
        logBudget: budget,
      });
      expect(result.ok).toBe(true);
      sizes.push(Buffer.byteLength(result.log));
    }
    expect(sizes.slice(0, 4).every((size) => size > 0)).toBe(true);
    expect(sizes[4]).toBe(0);
    expect(budget.remainingBytes).toBeLessThanOrEqual(0);
  });
});

describe("flow script executor — the V8 frame collapser", () => {
  it("marks the log truncated when it drops frames", async () => {
    const ws = workspace();
    const script = ws.write(
      "hungry.mjs",
      `console.log("allocating"); const held = []; for (;;) held.push("x".repeat(1024 * 1024));`
    );
    const result = await executor({ heapLimitMb: 64 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 30_000,
    });

    expect(result.log).toMatch(/\[\d+ V8 stack frames omitted]/);
    // Collapsed frames are output the report does not carry, which is what
    // this flag means; it stayed false and nothing told the caller.
    expect(result.logTruncated).toBe(true);
  }, 60_000);

  it("leaves frame-shaped lines from the script alone", async () => {
    const ws = workspace();
    // No fatal error printed, so nothing is a frame dump — a memory map, a
    // disassembly, any `${i}: 0x…` loop is the script's own output.
    const script = ws.write(
      "hexdump.mjs",
      `for (let i = 1; i <= 6; i++) console.error(\` \${i}: 0x1049\${i}1aec some symbol\`);
       output.ok = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.log).toContain("1: 0x104911aec some symbol");
    expect(result.log).toContain("6: 0x104961aec some symbol");
    expect(result.logTruncated).toBe(false);
  });
});

describe("flow script executor — order", () => {
  const WRITES = `const wait = (ms) => new Promise((r) => setTimeout(r, ms));
     process.stderr.write("Downloading... ");
     await wait(60);
     process.stdout.write("[stdout line 1]\\n");
     await wait(60);
     process.stderr.write("done\\n");
     output.ok = true;`;

  it("keeps what the script wrote in the order it wrote it", async () => {
    const ws = workspace();
    // An unterminated stderr write — a progress indicator — must not park
    // until its newline arrives while stdout written afterwards goes first.
    const result = await executor().execute({
      scriptPath: ws.write("order.mjs", WRITES),
      projectRoot: ws.dir,
    });

    expect(result.ok).toBe(true);
    expect(result.log).toBe("Downloading... [stdout line 1]\ndone\n");
  });

  it("keeps that order when a secret is configured", async () => {
    const ws = workspace();
    // The hold-back that protects a value split across two chunks must not
    // delay text that could never be part of one: adding a secret to a flow
    // cannot reorder its log.
    const result = await executor().execute({
      scriptPath: ws.write("order.mjs", WRITES),
      projectRoot: ws.dir,
      secrets: [{ name: "TOK", value: "0123456789abcdef0123456789abcdef" }],
    });

    expect(result.log).toBe("Downloading... [stdout line 1]\ndone\n");
  });
});

describe("flow script executor — redaction", () => {
  const SECRET: FlowScriptSecret = { name: "API_KEY", value: "s3cr3t-token-value" };

  it("replaces a secret written in one piece", async () => {
    const ws = workspace();
    const script = ws.write("plain.mjs", `console.log("auth: " + process.env.API_KEY);`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.log).not.toContain(SECRET.value);
    expect(result.log).toContain("auth: {{secret:API_KEY}}");
  });

  it("replaces a secret in the failure message and stack, not only in the log", async () => {
    const ws = workspace();
    // The author never writes the value into a string: `assert` quotes both
    // sides for them, and the error is what carries it out of the process.
    const script = ws.write(
      "assert.mjs",
      `import assert from "node:assert/strict";
       assert.equal("sk-live-WRONG", process.env.API_KEY);`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.failure?.kind).toBe("runtime");
    expect(result.failure?.message).not.toContain(SECRET.value);
    expect(result.failure?.message).toContain("{{secret:API_KEY}}");
    expect(result.failure?.stack).not.toContain(SECRET.value);
  });

  it("replaces a secret split across two pipe chunks", async () => {
    const ws = workspace();
    // Two writes with a gap between them arrive as two chunks, so a per-chunk
    // replacement would see neither half of the value.
    const script = ws.write(
      "split.mjs",
      `const value = process.env.API_KEY;
       process.stdout.write("auth: " + value.slice(0, 6));
       await new Promise((r) => setTimeout(r, 120));
       process.stdout.write(value.slice(6) + "\\n");
       output.ok = true;`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.ok).toBe(true);
    expect(result.log).not.toContain(SECRET.value);
    expect(result.log).toContain("auth: {{secret:API_KEY}}");
  });

  it("keeps a secret that straddles the truncation cut out of the report", async () => {
    const ws = workspace();
    // The cap keeps the earliest bytes, so a value straddling the cut would
    // leave its prefix behind — and a whole-value replacement matches no prefix.
    // Redaction therefore has to run before the cap, not after it.
    const script = ws.write(
      "straddle.mjs",
      `process.stdout.write("f".repeat(${SCRIPT_STEP_LOG_LIMIT_BYTES} - 6));
       process.stdout.write(process.env.API_KEY + "\\n");
       output.ok = true;`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.ok).toBe(true);
    expect(result.logTruncated).toBe(true);
    expect(result.log).not.toContain(SECRET.value);
    expect(result.log).not.toContain(SECRET.value.slice(0, 8));
  });

  it("redacts a value that straddled a chunk boundary before its secret was known", async () => {
    const ws = workspace();
    const value = "sk-live-9d3f0a1b2c3d4e5f6071";
    // The hold-back can only cover values it knows about at that chunk. Here
    // the head is released while the set is still empty and the tail arrives
    // after the run resolved the secret, so neither half matches on its own.
    const script = ws.write(
      "straddles.mjs",
      `const value = ${JSON.stringify(value)};
       process.stdout.write("Authorization: Bearer " + value.slice(0, 10));
       await new Promise((r) => setTimeout(r, 400));
       process.stdout.write(value.slice(10) + "\\n");
       output.ok = true;`
    );
    const secrets: FlowScriptSecret[] = [];
    const pending = executor().execute({ scriptPath: script, projectRoot: ws.dir, secrets });
    setTimeout(() => secrets.push({ name: "TOKEN", value }), 200);
    const result = await pending;

    expect(result.log).not.toContain(value);
    expect(result.log).toContain("Bearer {{secret:TOKEN}}");
  });

  it("reads the secret set live, so a value added mid-run still redacts", async () => {
    const ws = workspace();
    const script = ws.write(
      "later.mjs",
      `console.log("first: " + process.env.EARLY);
       await new Promise((r) => setTimeout(r, 150));
       console.log("second: " + process.env.LATE);
       output.ok = true;`
    );
    const secrets: FlowScriptSecret[] = [{ name: "EARLY", value: "early-value-aaaa" }];
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { EARLY: "early-value-aaaa", LATE: "late-value-bbbb" },
      secrets,
    });
    // The set is run-scoped and grows as the run resolves more placeholders.
    secrets.push({ name: "LATE", value: "late-value-bbbb" });
    const result = await pending;

    expect(result.log).toContain("first: {{secret:EARLY}}");
    expect(result.log).toContain("second: {{secret:LATE}}");
  });
});
