import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import {
  createRunFlowTool,
  NATIVE_READY_TIMEOUT_MS,
  type FlowRunResult,
} from "../../src/tools/flows/flow-run";
import { serializeFlow, parseFlow } from "../../src/tools/flows/flow-utils";
import { bindDeviceArgs, stripDeviceKeys } from "../../src/tools/flows/flow-device";

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => undefined),
    // iOS launch steps gate on a native-devtools connection: report connected
    // so the run proceeds. No selector directives run in these tests, so the
    // flow tree is never fetched.
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [],
    })),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(yaml), "utf8");
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-compose-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("flow composition (run:)", () => {
  it("expands a referenced fragment's steps inline", async () => {
    await writeFlow("login", {
      executionPrerequisite: "On login screen",
      steps: [
        { kind: "echo", message: "logging in" },
        { kind: "tool", name: "tap", args: { x: 0.5 } },
      ],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "login" },
        { kind: "echo", message: "done" },
      ],
    });

    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute({}, { name: "main", project_root: tmpDir, device: DEVICE })
    );

    // run marker, login's echo + tap, then main's echo.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "echo:pass",
      "tool:pass",
      "echo:pass",
    ]);
    // The expanded steps are attributed to the fragment.
    expect(result.steps[1].flow).toBe("login");
    expect(result.steps[3].flow).toBe("main");
    expect(result.ok).toBe(true);
  });

  it("stamps nesting depth on expanded fragment steps (omitted at top level)", async () => {
    await writeFlow("inner", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "deepest" }],
    });
    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "tap", args: { x: 0.5 } },
        { kind: "run", flow: "inner" },
      ],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "login" },
        { kind: "echo", message: "done" },
      ],
    });

    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute({}, { name: "main", project_root: tmpDir, device: DEVICE })
    );

    // Each run marker sits at its enclosing depth; the fragment it expands runs
    // one deeper. Top-level steps omit the field entirely, so a flow with no
    // block directives reports byte-identically to the pre-depth shape.
    expect(result.steps.map((s) => `${s.kind}:${s.depth ?? 0}`)).toEqual([
      "run:0",
      "tool:1",
      "run:1",
      "echo:2",
      "echo:0",
    ]);
    expect(result.steps[0].depth).toBeUndefined();
    expect(result.steps[4].depth).toBeUndefined();
  });

  it("expands a referenced e2e flow inline, launch step and all", async () => {
    await writeFlow("other-e2e", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "echo", message: "in nested e2e" },
      ],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "other-e2e" }],
    });
    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute({}, { name: "main", project_root: tmpDir, device: DEVICE })
    );
    // run marker, then the nested e2e's launch + echo expanded inline.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "launch:pass",
      "echo:pass",
    ]);
    expect(result.steps[1].flow).toBe("other-e2e");
    expect(result.ok).toBe(true);
  });

  it("detects a cyclic run reference", async () => {
    await writeFlow("a", { executionPrerequisite: "", steps: [{ kind: "run", flow: "b" }] });
    await writeFlow("b", { executionPrerequisite: "", steps: [{ kind: "run", flow: "a" }] });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "a" }],
    });
    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute({}, { name: "main", project_root: tmpDir, device: DEVICE })
    );
    const errored = result.steps.find((s) => s.status === "error");
    expect(errored?.reason).toMatch(/cyclic/i);
    // The cycle is detected two fragments down; its error marker keeps that
    // depth (the fail() path stamps depthOf(scope) like the success marker),
    // so the error line renders inside the block that caused it.
    expect(result.steps.map((s) => `${s.kind}:${s.status}:${s.depth ?? 0}`)).toEqual([
      "run:pass:0",
      "run:pass:1",
      "run:error:2",
    ]);
  });

  it("executes a leading launch step from scratch (restart-app) and reports it", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "echo", message: "running" },
      ],
    });
    const registry = mockRegistry();
    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:pass", "echo:pass"]);
    // e2e contract: terminate + relaunch, so a running copy can't leak state.
    expect(registry.invokeTool).toHaveBeenCalledWith("restart-app", { bundleId: "com.acme.app" });
    expect(result.ok).toBe(true);
  });

  it("errors the launch step when no app id is declared for the platform", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: { android: "com.acme.app" } }, // DEVICE is iOS
        { kind: "echo", message: "should never run" },
      ],
    });
    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:error", "echo:skip"]);
    expect(result.steps[0].reason).toMatch(/no app id declared for platform/i);
    expect(result.ok).toBe(false);
  });

  it("errors the launch step when native devtools never connects on iOS", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "echo", message: "should never run" },
      ],
    });
    // Registry whose native-devtools service is unavailable: the launch step
    // must fail rather than let selectors silently fall back to the AX tree.
    // (An unresolvable service fails fast; a resolvable-but-never-connected
    // one hits the same guard after the connect timeout.)
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => {
        throw new Error("native-devtools unavailable");
      }),
    } as unknown as Registry;

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:error", "echo:skip"]);
    expect(result.steps[0].reason).toMatch(/could not connect to native devtools/i);
    // Every reason names the bundle id itself, so the prefix must not — doubled,
    // it reads as two separate failures reported back to back. Asserted on this
    // shape and, below, on the measured and system-app ones, because the rule
    // is only worth anything if it holds for all of them.
    expect(result.steps[0].reason?.match(/com\.acme\.app/g)).toHaveLength(1);
    // The cause travels with the reason. Resolution fails for reasons the flow
    // author can act on and cannot otherwise see — a socket already bound, a
    // device of the wrong platform — and the step's reason is the only place
    // any of them surfaces; without it they all read as one opaque failure.
    expect(result.steps[0].reason).toContain("native-devtools unavailable");
    expect(result.ok).toBe(false);
  });

  // An Apple system app may not be able to load the dylib at all (a platform
  // binary with library validation), so its hierarchy may never become
  // readable. That is not a reason to fail the LAUNCH: the step's job is to
  // start the app, it succeeded, and a flow that only ever taps by coordinate
  // needs nothing else — which is exactly the shape `argent-create-flow` teaches
  // its readers to record. Failing here stopped that flow at step one, while
  // telling its author to "drive it by coordinate instead". The impossibility
  // belongs where a selector actually needs the hierarchy.
  it("lets a system-app launch through so a coordinate-driven flow still runs", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.apple.Preferences" },
        { kind: "tool", name: "gesture-tap", args: { x: 0.5, y: 0.35 } },
      ],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:pass", "tool:pass"]);
    expect(result.ok).toBe(true);
  });

  // The other half of letting the launch through: a SELECTOR step against the
  // same app has to say why it cannot resolve, and say it terminally. This is
  // also the only end-to-end proof that the launched bundle id reaches the tree
  // source — auto-targeting resolves out of the connected list, so with nothing
  // connected it cannot name the app, and the flow author would get the stock
  // "Launch or restart the app first" auto-target text, which is the restart
  // loop this measurement exists to break.
  it("gives a selector step against a system app the terminal reason, not the auto-target text", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.apple.Preferences" },
        { kind: "assert", selector: { text: "General" }, condition: "visible" },
      ],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps[0].status).toBe("pass");
    const reason = result.steps[1].reason ?? "";
    expect(reason).toMatch(/Apple system app/);
    expect(reason).toMatch(/com\.apple\.Preferences/);
    // The auto-target text is what reached the author before the id was
    // threaded, and its remedy is the loop.
    expect(reason).not.toMatch(/auto-targeting/);
    expect(reason).not.toMatch(/Launch or restart the app first/);
  });

  // The gate's own measurement had no coverage at all: replacing the whole
  // diagnosis with a literal left every flow test green. `unregistered` is the
  // case that matters — the remedy inverts, and this gate is reached right
  // after a launch, so a guessed "re-run to relaunch" is the loop one level up.
  it("reports the measured reason when the connection times out", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: "com.acme.app" }],
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => ({
        isConnected: () => false,
        listConnectedBundleIds: () => [],
        appConnectionState: async () => "unregistered" as const,
      })),
    } as unknown as Registry;

    // Leave setImmediate real: the run reads the flow off disk between sleeps,
    // and that I/O needs actual event-loop turns to settle. Pumping a real turn
    // between advances lets the 1.5 s settle and the 8 s connect timeout elapse
    // in fake time without the test spending ten real seconds on them.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pending = createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      );
      let settled = false;
      void pending.then(() => (settled = true));
      for (let i = 0; i < 200 && !settled; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(250);
      }
      const result = asRun(await pending);

      expect(result.steps[0].status).toBe("error");
      expect(result.steps[0].reason).toContain(
        "argent server stop && argent server start --detach"
      );
      expect(result.steps[0].reason).not.toMatch(/restart-app/);
      expect(result.steps[0].reason?.match(/com\.acme\.app/g)).toHaveLength(1);
      // This gate is the one caller whose wait was bounded — it launched the app
      // itself and waited only NATIVE_READY_TIMEOUT_MS. A cold start slower than
      // that reads identically to a genuinely unregistered app, so the measured
      // "restarting cannot help" must not be the last word here.
      expect(result.steps[0].reason).toMatch(/cold start/i);
      expect(result.steps[0].reason).toMatch(/re-run the flow/i);
      // The figure the author sizes that judgement against has to be the wait
      // this gate actually performed — a literal that drifts from the constant
      // tells them the step gave up seconds earlier or later than it did.
      expect(result.steps[0].reason).toContain(`${NATIVE_READY_TIMEOUT_MS} ms`);
    } finally {
      vi.useRealTimers();
    }
  });

  // `buildAppStateMessage` is written for the native-* tool surface, whose
  // reader has not launched anything — so "call launch-app (or restart-app)" is
  // the missing step there and the step's own action here. Emitted verbatim,
  // every state but `unregistered` handed the flow author back the relaunch the
  // launch step had just performed, which re-runs into the identical state.
  // `not_running` is the sharpest: a relaunch is not merely redundant, it is
  // what produced the state being reported.
  it.each([
    ["not_running", /exited after launch/i, /^(?!.*Call launch-app).*$/s],
    ["stale_process", /re-run the flow/i, null],
    ["indeterminate", /at most once more/i, null],
    ["connecting", /same handshake/i, null],
  ] as const)(
    "rewrites the %s remedy for a caller that has just launched the app",
    async (state, expected, absent) => {
      await writeFlow("main", {
        executionPrerequisite: "",
        steps: [{ kind: "launch", app: "com.acme.app" }],
      });
      const registry = {
        invokeTool: vi.fn(async (id: string) =>
          id === "list-devices" ? { devices: [] } : { ok: true }
        ),
        getTool: vi.fn(() => undefined),
        resolveService: vi.fn(async () => ({
          isConnected: () => false,
          listConnectedBundleIds: () => [],
          appConnectionState: async () => state,
        })),
      } as unknown as Registry;

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const pending = createRunFlowTool(registry).execute(
          {},
          { name: "main", project_root: tmpDir, device: DEVICE }
        );
        let settled = false;
        void pending.then(() => (settled = true));
        for (let i = 0; i < 200 && !settled; i++) {
          await new Promise((resolve) => setImmediate(resolve));
          await vi.advanceTimersByTimeAsync(250);
        }
        const result = asRun(await pending);

        expect(result.steps[0].status).toBe("error");
        expect(result.steps[0].reason).toMatch(expected);
        if (absent) expect(result.steps[0].reason).toMatch(absent);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  // The connection can land between the final poll and the measurement. Without
  // the `connected` short-circuit, buildAppStateMessage falls off its switch and
  // the healthy run dies with a literal "undefined" as its reason.
  it("passes when the connection lands between the last poll and the measurement", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: "com.acme.app" }],
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => ({
        isConnected: () => false, // never connects during the poll…
        listConnectedBundleIds: () => [],
        appConnectionState: async () => "connected" as const, // …but has by the measurement
      })),
    } as unknown as Registry;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pending = createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      );
      let settled = false;
      void pending.then(() => (settled = true));
      for (let i = 0; i < 200 && !settled; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(250);
      }
      const result = asRun(await pending);

      expect(result.steps[0].status).toBe("pass");
      expect(result.ok).toBe(true);
      // Without the short-circuit the step errors with a literal "undefined" —
      // buildAppStateMessage has no `connected` arm to fall to.
      expect(result.steps[0].reason ?? "").not.toMatch(/undefined/);
    } finally {
      vi.useRealTimers();
    }
  });

  // A rejected measurement must not propagate: `runLaunch` has no try/catch of
  // its own, so it would escape `execute()` and the run would return no step
  // reports at all instead of a structured failure.
  it("keeps a rejected measurement inside the step report", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "echo", message: "after" },
      ],
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => ({
        isConnected: () => false,
        listConnectedBundleIds: () => [],
        appConnectionState: async () => {
          throw new Error("Invalid device: UDID");
        },
      })),
    } as unknown as Registry;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pending = createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      );
      let settled = false;
      void pending.then(() => (settled = true));
      for (let i = 0; i < 200 && !settled; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(250);
      }
      const result = asRun(await pending);

      expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
        "launch:error",
        "echo:skip",
      ]);
      expect(result.steps[0].reason).toContain("could not be inspected");
      expect(result.steps[0].reason).not.toMatch(/Invalid device/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("device binding (portability)", () => {
  const reg = (props: Record<string, unknown>) =>
    ({ getTool: () => ({ inputSchema: { properties: props } }) }) as unknown as Registry;

  it("the resolved device wins over a stale stored udid", () => {
    const out = bindDeviceArgs(reg({ udid: {}, x: {}, y: {} }), "gesture-tap", "RESOLVED", {
      udid: "STALE",
      x: 0.5,
      y: 0.5,
    });
    expect(out).toEqual({ udid: "RESOLVED", x: 0.5, y: 0.5 });
  });

  it("drops a device id entirely for a tool that doesn't declare one", () => {
    const out = bindDeviceArgs(reg({ foo: {} }), "x", "R", { device_id: "STALE", foo: 1 });
    expect(out).toEqual({ foo: 1 });
  });

  it("stripDeviceKeys removes udid / device_id", () => {
    expect(stripDeviceKeys({ udid: "A", device_id: "B", x: 1 })).toEqual({ x: 1 });
  });
});

describe("flow validation", () => {
  it("rejects an e2e flow that declares executionPrerequisite", () => {
    expect(() =>
      parseFlow("executionPrerequisite: nope\nsteps:\n  - launch: com.acme.app\n")
    ).toThrow(/must not declare executionPrerequisite/i);
  });

  it("a leading echo does not hide the launch step from the e2e check", () => {
    expect(() =>
      parseFlow(
        "executionPrerequisite: nope\nsteps:\n  - echo: starting\n  - launch: com.acme.app\n"
      )
    ).toThrow(/must not declare executionPrerequisite/i);
  });

  it("rejects a path-unsafe snapshot name (no traversal into baseline path)", () => {
    expect(() => parseFlow("steps:\n  - snapshot:\n      name: ../../etc/evil\n")).toThrow(
      /snapshot name/i
    );
  });

  it("round-trips the new step kinds through YAML", () => {
    const flow = {
      executionPrerequisite: "",
      steps: [
        { kind: "launch" as const, app: "com.acme.app" },
        // Text-only selectors serialize to bare strings, which parse back loose.
        { kind: "tap" as const, selector: { text: "Login", loose: true } },
        { kind: "tap" as const, x: 0.5, y: 0.57 },
        { kind: "type" as const, into: { identifier: "email" }, text: "a@b.com" },
        {
          kind: "assert" as const,
          condition: "visible" as const,
          selector: { text: "Welcome", loose: true },
        },
        { kind: "snapshot" as const, name: "home", maxMismatch: 0.5 },
        { kind: "run" as const, flow: "login" },
        // Mid-flow relaunch with a per-platform map.
        { kind: "launch" as const, app: { ios: "com.acme.app", android: "com.acme.android" } },
      ],
    };
    const parsed = parseFlow(serializeFlow(flow));
    expect(parsed.steps).toEqual(flow.steps);
  });

  it("rejects a launch step with an invalid body", () => {
    // An unrecognized platform key is named (strict unknown-key rejection)…
    expect(() => parseFlow("steps:\n  - launch: { web: foo }\n")).toThrow(
      /launch has unknown key `web`/
    );
    // …while a non-map, non-string body still gets the shape error.
    expect(() => parseFlow("steps:\n  - launch: 42\n")).toThrow(/launch needs an app id/i);
  });
});
