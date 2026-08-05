import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import {
  createRunFlowTool,
  flowLaunchGateReason,
  LAUNCH_TO_VERDICT_MS,
  NATIVE_READY_TIMEOUT_MS,
  type FlowRunResult,
} from "../../src/tools/flows/flow-run";
import { serializeFlow, parseFlow } from "../../src/tools/flows/flow-utils";
import { bindDeviceArgs, stripDeviceKeys } from "../../src/tools/flows/flow-device";

// Four tests here drive the launch gate's real 1.5 s settle + 8 s connect wait
// in fake time, pumping a real event-loop turn between advances so the run's
// disk I/O can settle. Each pump is a real macrotask, so the cost is the pump
// count, not the fake duration — under full-suite load ~40 per test outran
// vitest's 5 s default. Widening the advance is NOT the fix: coarser steps
// starve that I/O and take longer in real time (measured: 1 s steps took the
// file from 46 s to 52 s). Budget the pumping, and prefer unit-testing the pure
// message mapping over driving the whole runner once per case.
vi.setConfig({ testTimeout: 30_000 });

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

/**
 * `props`, when given, makes `getTool` report that schema for EVERY tool id —
 * so a fixture using it must be a single step and must pass an explicit device,
 * otherwise unrelated dispatches (list-devices) would be handed a bogus schema.
 */
function mockRegistry(props?: Record<string, unknown>): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => (props ? { inputSchema: { properties: props } } : undefined)),
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

  it("runs a nested flow-execute against the run device, not the recorded one (issue #607)", async () => {
    // The raw `tool: flow-execute` form is what the recorder falls back to when
    // the target is not a resolvable sibling — and what a remote recording always
    // produces. Its device parameter is named `device`, which was not a bind key,
    // so the sub-run drove the id baked in at record time. Here the flow carries
    // a device that does not exist while the run is given a real one.
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "tool",
          name: "flow-execute",
          args: { name: "b-only", project_root: "/elsewhere", device: "STALE-ID" },
        },
      ],
    });

    // Single step + explicit device, per mockRegistry's contract.
    const registry = mockRegistry({ name: {}, project_root: {}, device: {} });
    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(registry.invokeTool).toHaveBeenCalledWith(
      "flow-execute",
      expect.objectContaining({ device: DEVICE })
    );
    expect(registry.invokeTool).not.toHaveBeenCalledWith(
      "flow-execute",
      expect.objectContaining({ device: "STALE-ID" })
    );
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
    // Every reason names the bundle id, so the prefix must not — doubled, it
    // reads as two separate failures. Asserted here and on the measured and
    // system-app shapes below, since the rule is worth nothing partially held.
    expect(result.steps[0].reason?.match(/com\.acme\.app/g)).toHaveLength(1);
    // Resolution fails for reasons the flow author can act on and cannot
    // otherwise see — a socket already bound, a device of the wrong platform —
    // and the step's reason is the only place any of them surfaces.
    expect(result.steps[0].reason).toContain("native-devtools unavailable");
    expect(result.ok).toBe(false);
  });

  // An Apple system app may never load the dylib (a platform binary with
  // library validation), so its hierarchy may never become readable — which is
  // not a reason to fail the LAUNCH. The step started the app, and a flow that
  // taps by coordinate needs nothing else; the impossibility belongs where a
  // selector actually needs the hierarchy.
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

  // The case above resolves connected, so the gate never reaches its verdict.
  // This is the one that matters: a system app that never connects at all. The
  // launch must STILL pass, where every measured state would have failed it —
  // and failed it with a remedy that cannot apply to such an app.
  it("passes a system-app launch that never connects at all", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.apple.Preferences" },
        { kind: "tool", name: "gesture-tap", args: { x: 0.5, y: 0.35 } },
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
        // The launchd env carrying the bootstrap dylib is simulator-wide, so a
        // system app's process inherits the injection tokens and scores as a
        // live app the service merely never registered.
        appConnectionState: async () => "unregistered" as const,
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
        "launch:pass",
        "tool:pass",
      ]);
      expect(result.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // The verdict is withheld BEFORE the state is measured: that measurement is
  // several uninterruptible simctl round-trips, and no arm consults it for such
  // an app — pure latency on every system-app launch step.
  it("does not measure a state it will not report", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: "com.apple.Preferences" }],
    });
    const appConnectionState = vi.fn(async () => "unregistered" as const);
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => ({
        isConnected: () => false,
        listConnectedBundleIds: () => [],
        appConnectionState,
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
      expect(appConnectionState).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // The gate consults the service before withholding its verdict, so an
  // unresolvable service was the one remaining way a system-app launch could
  // fail — on a failure irrelevant to an app it was never going to serve.
  it("passes a system-app launch even when native-devtools cannot resolve", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.apple.Preferences" },
        { kind: "tool", name: "gesture-tap", args: { x: 0.5, y: 0.35 } },
      ],
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => {
        throw new Error("listen EADDRINUSE: address already in use /tmp/argent-nd-00000000.sock");
      }),
    } as unknown as Registry;

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:pass", "tool:pass"]);
    expect(result.ok).toBe(true);
  });

  // The control for the test above: an injectable app in the identical state
  // must still fail, or the pass-through would be excusing every service
  // failure rather than the one it reasons about.
  it("still fails an injectable launch when native-devtools cannot resolve", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "tool", name: "gesture-tap", args: { x: 0.5, y: 0.35 } },
      ],
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => {
        throw new Error("listen EADDRINUSE: address already in use /tmp/argent-nd-00000000.sock");
      }),
    } as unknown as Registry;

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toMatch(/native-devtools service is unavailable/);
  });

  // The other half of letting the launch through: a SELECTOR step against the
  // same app has to say why it cannot resolve, terminally. Also the only
  // end-to-end proof that the launched bundle id reaches the tree source —
  // without it the author gets the stock "Launch or restart the app first"
  // auto-target text, the restart loop this measurement exists to break.
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
    // The auto-target text is what auto-resolution alone can produce here, and
    // its remedy is the loop.
    expect(reason).not.toMatch(/auto-targeting/);
    expect(reason).not.toMatch(/Launch or restart the app first/);
  });

  // `assert`/`await` read the tree through `waitForCondition`; `tap`, `type`,
  // `scroll-to` and `long-press` reach it through `settleTree`, a separate call
  // site. Pinning only the first left the id droppable at the second — the one
  // every action directive uses — with the suite green.
  it("threads the launched id to the settleTree read an action directive uses", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.apple.Preferences" },
        { kind: "tap", selector: { text: "General" } },
      ],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    const reason = result.steps[1].reason ?? "";
    expect(reason).toMatch(/Apple system app/);
    expect(reason).not.toMatch(/Launch or restart the app first/);
  });

  // The measured half says what is wrong with the app; without this half a flow
  // author is told to restart a tool-server with no mention that a selector
  // needed a hierarchy.
  it("says why the tree was being read, not just what is wrong with the app", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "assert", selector: { text: "General" }, condition: "visible" },
      ],
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => ({
        isConnected: () => true,
        listConnectedBundleIds: () => [],
        appConnectionState: async () => "unregistered" as const,
      })),
    } as unknown as Registry;

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    const reason = result.steps[1].reason ?? "";
    expect(reason).toMatch(/argent server stop && argent server start --detach/);
    expect(reason).toMatch(/Flows resolve selectors against the full view hierarchy/);
  });

  // Replacing the whole diagnosis with a literal left every flow test green.
  // `unregistered` is the case that matters — the remedy inverts, and this gate
  // runs right after a launch, so "re-run to relaunch" is the loop one level up.
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
    // and that I/O needs actual event-loop turns. Pumping one between advances
    // elapses the 1.5 s settle and 8 s connect wait in fake time.
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
      // This gate is the one caller whose wait was bounded: a cold start slower
      // than LAUNCH_TO_VERDICT_MS reads identically to a genuinely unregistered
      // app, so "restarting cannot help" must not be the last word here.
      expect(result.steps[0].reason).toMatch(/cold start/i);
      expect(result.steps[0].reason).toMatch(/re-run the flow/i);
      // The figure sizing that judgement is the whole wait the step performed:
      // the poll reads the live map once before its first sleep, so the
      // post-launch settle counts and quoting the poll alone understates it.
      expect(result.steps[0].reason).toContain(`${LAUNCH_TO_VERDICT_MS} ms`);
      expect(result.steps[0].reason).not.toContain(`${NATIVE_READY_TIMEOUT_MS} ms`);
    } finally {
      vi.useRealTimers();
    }
  });

  // `buildAppStateMessage` is written for a reader who has not launched
  // anything, so "call launch-app (or restart-app)" is the missing step there
  // and the step's own action here — emitted verbatim it hands the flow author
  // back the relaunch that just ran, which re-runs into the identical state.
  //
  // Exercised directly rather than through the runner: it is a pure function of
  // (bundleId, state), and each runner pass costs ~9 s of pumped fake time. The
  // end-to-end test above proves the gate reaches it at all.
  describe("flowLaunchGateReason", () => {
    it.each([
      // `not_running` is the sharpest: a relaunch is what produced the state
      // being reported, so the remedy must not be one.
      ["not_running", /exited after launch/i],
      ["stale_process", /re-run the flow to launch again/i],
      ["indeterminate", /at most once more/i],
      ["connecting", /started after the step's own launch/i],
      ["unregistered", /cold start/i],
    ] as const)("tells %s something the step has not already done or tried", (state, expected) => {
      expect(flowLaunchGateReason("com.acme.app", state)).toMatch(expected);
    });

    // The one state whose tool-surface remedy IS the launch step's own action.
    // `launch-app` may still appear — the arm suggests starting it by hand to
    // watch it die — but never as the prescribed retry.
    it("does not tell a crash-on-launch app to simply launch itself again", () => {
      const reason = flowLaunchGateReason("com.acme.app", "not_running");

      expect(reason).not.toMatch(/Call launch-app/);
      expect(reason).not.toMatch(/restart-app/);
      // What it must say instead: the process is gone because it exited, and
      // re-running reproduces exactly that.
      expect(reason).toMatch(/exited after launch/);
      expect(reason).toMatch(/Re-running the flow repeats the same launch/);
    });

    // The `not.toContain` guards below compare rendered substrings, so they only
    // mean anything while neither figure is a suffix of the other: 500/1500 would
    // make `"1500 ms".includes("500 ms")` true and fail them for the wrong
    // reason. Pin what those guards need, not merely the ordering.
    it("renders a launch-to-verdict spend the connect wait cannot be read into", () => {
      expect(LAUNCH_TO_VERDICT_MS).toBeGreaterThan(NATIVE_READY_TIMEOUT_MS);
      expect(`${LAUNCH_TO_VERDICT_MS} ms`).not.toContain(`${NATIVE_READY_TIMEOUT_MS} ms`);
    });

    // `stale_process` has two producers, and one carries THIS endpoint — it
    // predates the listener, not the launchd environment. Blaming the
    // environment would contradict the measured text this wraps.
    it("does not blame the launchd environment for a stale process", () => {
      const reason = flowLaunchGateReason("com.acme.app", "stale_process");

      expect(reason).toMatch(/predates whatever the relaunch would have given it/);
      // One producer carries THIS endpoint and is merely older than the
      // listener, so the environment is not at fault on a first landing. The
      // message may name it only for a REPEAT, which rules that producer out —
      // so the blame must be conditional AND follow the re-run, both asserted.
      const blame = reason.indexOf("launchd environment");
      const rerun = reason.indexOf("re-run the flow");
      expect(rerun).toBeGreaterThanOrEqual(0);
      expect(blame === -1 || blame > rerun).toBe(true);
      // Unconditional on purpose: `if (blame !== -1)` let the whole
      // repeat-landing clause be deleted with the suite green, leaving a reader
      // who lands here twice with "re-run the flow" and no escape. The wording is
      // pinned too — "It lands here twice, so …" states on a FIRST landing what
      // only a second one supports.
      expect(reason).toMatch(/If it lands here twice, the simulator's launchd environment/);
    });

    it.each(["not_running", "connecting", "unregistered"] as const)(
      "quotes the whole launch-to-verdict spend in the %s remedy",
      (state) => {
        const reason = flowLaunchGateReason("com.acme.app", state);

        expect(reason).toContain(`${LAUNCH_TO_VERDICT_MS} ms`);
        expect(reason).not.toContain(`${NATIVE_READY_TIMEOUT_MS} ms`);
      }
    );
  });

  // The connection can land between the final poll and the measurement. Without
  // the `connected` short-circuit, buildAppStateMessage falls off its switch and
  // a healthy run dies with a literal "undefined" as its reason.
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

  // A rejected measurement must not propagate: `runLaunch` has no try/catch, so
  // it would escape `execute()` and the run would return no step reports at all
  // instead of a structured failure.
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

  it("stripDeviceKeys removes udid / device_id / device", () => {
    expect(stripDeviceKeys({ udid: "A", device_id: "B", device: "C", x: 1 })).toEqual({ x: 1 });
  });

  it("rebinds a nested flow-execute onto the run device (issue #607)", () => {
    // `flow-execute`'s own device parameter is named `device`, so before it was
    // a bind key a recorded nested step kept the id it was recorded on and the
    // sub-run drove that device instead of the one the replay was given.
    const out = bindDeviceArgs(
      reg({ name: {}, project_root: {}, device: {} }),
      "flow-execute",
      "RESOLVED",
      { name: "b", project_root: "/p", device: "STALE" }
    );
    expect(out).toEqual({ name: "b", project_root: "/p", device: "RESOLVED" });
  });

  it("leaves `platform` alone", () => {
    // Deliberate, and pinned here so a later "symmetry" edit fails loudly. The
    // strip is schema-blind, and `platform` is not device-specific on every tool
    // — react-profiler-analyze declares its own — so stripping it would silently
    // retarget an unrelated recorded step. It is also inert once `device` is
    // bound, because device resolution returns before it is ever read.
    expect(stripDeviceKeys({ platform: "android", x: 1 })).toEqual({ platform: "android", x: 1 });
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
