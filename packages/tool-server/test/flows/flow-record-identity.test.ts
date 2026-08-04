import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";

import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import {
  __resetRecordingsForTesting,
  appendStepToFlow,
  parseFlow,
  requireRecordingSession,
} from "../../src/tools/flows/flow-utils";

/**
 * The flow as PERSISTED. The recorder deliberately no longer returns the whole
 * growing YAML per step (it was the single largest consumer of a session's
 * context), so the file on disk is the assertion surface.
 */
async function onDisk(name: string, root = tmpDir): Promise<string> {
  return fs.readFile(path.join(root, ".argent", "flows", `${name}.yaml`), "utf8");
}

const PREREQ = "App on home screen";
let tmpDir: string;

function registryReturning(result: unknown): Registry {
  return {
    invokeTool: vi.fn(async () => result),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

/** A screen-fingerprint read that reports `routes` in order, one per call. */
function registryReadingRoutes(routes: string[]): Registry {
  let call = 0;
  return {
    invokeTool: vi.fn(async () => ({
      available: true,
      route: routes[Math.min(call++, routes.length - 1)],
      params: null,
    })),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

async function startRecording(name: string): Promise<void> {
  await flowStartRecordingTool.execute(
    {},
    { name, project_root: tmpDir, executionPrerequisite: PREREQ }
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-record-identity-"));
  __resetRecordingsForTesting();
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// A `hidden` check whose selector never matched is true before the wait, true
// after it, and true on the wrong screen or against a typo. The live tool
// reports that honestly in its note; the recorder must not bake it into a
// flow, where it becomes a gate that can never fail.
describe("vacuously-met hidden waits are not recorded", () => {
  const VACUOUS = {
    success: true,
    elapsed: 128,
    note:
      "condition met immediately — the selector never matched any element, so it may have " +
      "already been hidden before the wait, or the selector is wrong",
  };

  it("refuses the step and says how to establish the check properly", async () => {
    const tool = createFlowAddStepTool(registryReturning(VACUOUS));
    await startRecording("vacuous-hidden");

    const result = await tool.execute(
      {},
      {
        name: "vacuous-hidden",
        project_root: tmpDir,
        command: "await-ui-element",
        args: '{"udid":"ABC","condition":"hidden","selector":{"text":"Dark theme"}}',
      }
    );

    expect(result.message).toContain("step NOT recorded");
    expect(result.message).toContain("cannot fail");
    expect(result.message).toContain("Record a `visible` check for the same selector");
    expect(parseFlow(await onDisk("vacuous-hidden")).steps).toEqual([]);
  });

  it("records a hidden wait that genuinely observed the element leave", async () => {
    // No note: the element matched at least once, so its disappearance is real
    // evidence and the gate can fail on replay.
    const tool = createFlowAddStepTool(registryReturning({ success: true, elapsed: 900 }));
    await startRecording("real-hidden");

    const result = await tool.execute(
      {},
      {
        name: "real-hidden",
        project_root: tmpDir,
        command: "await-ui-element",
        args: '{"udid":"ABC","condition":"hidden","selector":{"text":"Saving…"}}',
      }
    );

    expect(result.message).toContain("Step added");
    expect(parseFlow(await onDisk("real-hidden")).steps).toHaveLength(1);
  });
});

// A fingerprint READ becomes a fingerprint CHECK: recording it as a raw tool
// step would persist a call whose output nothing compares.
describe("screen-fingerprint records the identity gate", () => {
  it("rewrites a successful read into `await: { screen }`", async () => {
    const tool = createFlowAddStepTool(
      registryReturning({
        available: true,
        route: "HomeTab>Profile",
        path: ["HomeTab", "Profile"],
        params: null,
      })
    );
    await startRecording("identity");

    const result = await tool.execute(
      {},
      {
        name: "identity",
        project_root: tmpDir,
        command: "screen-fingerprint",
        args: '{"app_id":"com.acme.notes"}',
      }
    );

    expect(result.message).toContain("Step added");
    // This recording has no `launch` step, so at replay the gate would
    // have no app to read the route from — and would fail as an environment
    // error, discovered only then. The app id the fingerprint call had to
    // name is carried onto the step, and the platform pinning is disclosed.
    expect(parseFlow(await onDisk("identity")).steps).toEqual([
      { kind: "screen", mode: "await", route: "HomeTab>Profile", app: "com.acme.notes" },
    ]);
    expect(result.message).toContain("this flow has no launch step");
  });

  it("leaves the app implicit when the flow launches it itself", async () => {
    const tool = createFlowAddStepTool(
      registryReturning({
        available: true,
        route: "HomeTab>Profile",
        path: ["HomeTab", "Profile"],
        params: null,
      })
    );
    // An e2e flow launches its own app, so it declares no prerequisite.
    await flowStartRecordingTool.execute(
      {},
      { name: "identity-e2e", project_root: tmpDir, executionPrerequisite: "" }
    );
    // A leading `launch` makes this a self-contained e2e flow: the runner
    // already knows which app to read from, and baking one id in would only
    // pin an otherwise cross-platform flow to one platform.
    await appendStepToFlow(requireRecordingSession(tmpDir, "identity-e2e"), {
      kind: "launch",
      app: "com.acme.notes",
    });

    await tool.execute(
      {},
      {
        name: "identity-e2e",
        project_root: tmpDir,
        command: "screen-fingerprint",
        args: '{"app_id":"com.acme.notes"}',
      }
    );

    expect(parseFlow(await onDisk("identity-e2e")).steps).toEqual([
      { kind: "launch", app: "com.acme.notes" },
      { kind: "screen", mode: "await", route: "HomeTab>Profile" },
    ]);
    expect(await onDisk("identity-e2e")).not.toContain("app:");
  });

  it("keeps a non-default metro port so replay reads the same runtime", async () => {
    const tool = createFlowAddStepTool(
      registryReturning({ available: true, route: "Settings", params: null })
    );
    await startRecording("identity-port");

    const result = await tool.execute(
      {},
      {
        name: "identity-port",
        project_root: tmpDir,
        command: "screen-fingerprint",
        args: '{"app_id":"com.acme.notes","metro_port":8082}',
      }
    );

    expect(parseFlow(await onDisk("identity-port")).steps).toEqual([
      { kind: "screen", mode: "await", route: "Settings", app: "com.acme.notes", metroPort: 8082 },
    ]);
    // `recorded` is the author's only per-step view of what was appended — the
    // recorder stopped returning the growing YAML — so a gate pinned to one app
    // and one port must say so there.
    expect(result.recorded).toBe(
      "1. await: screen Settings (app: com.acme.notes, metroPort: 8082)"
    );
  });

  it("records nothing when the app has no route reader at all", async () => {
    const tool = createFlowAddStepTool(
      registryReturning({
        available: false,
        route: null,
        reason: "No route reader for com.acme.notes on Metro port 8081 — Metro is down.",
      })
    );
    await startRecording("identity-unavailable");

    const result = await tool.execute(
      {},
      {
        name: "identity-unavailable",
        project_root: tmpDir,
        command: "screen-fingerprint",
        args: '{"app_id":"com.acme.notes"}',
      }
    );

    expect(result.message).toContain("step NOT recorded");
    expect(result.message).toContain("Gate this navigation on a destination-only element");
    expect(parseFlow(await onDisk("identity-unavailable")).steps).toEqual([]);
  });

  it("records nothing mid-transition, and says to probe again", async () => {
    const tool = createFlowAddStepTool(
      registryReturning({
        available: true,
        route: null,
        reason: "The app exposes no focused React Navigation route right now.",
      })
    );
    await startRecording("identity-transient");

    const result = await tool.execute(
      {},
      {
        name: "identity-transient",
        project_root: tmpDir,
        command: "screen-fingerprint",
        args: '{"app_id":"com.acme.notes"}',
      }
    );

    expect(result.message).toContain("step NOT recorded");
    expect(result.message).toContain("Let the screen finish settling");
    expect(parseFlow(await onDisk("identity-transient")).steps).toEqual([]);
  });
});

// Device-proven on Bluesky: its sign-in form is presented inside the landing
// route, so both screens report `HomeTab`. A gate recorded after "tap Sign in"
// then passes whether or not the tap landed — route identity is only identity
// when the routes actually differ.
describe("a screen gate repeating the flow's last route is not recorded", () => {
  async function readScreen(
    name: string,
    registry: Registry
  ): Promise<{
    message: string;
    stepCount: number;
  }> {
    return createFlowAddStepTool(registry).execute(
      {},
      {
        name,
        project_root: tmpDir,
        command: "screen-fingerprint",
        args: '{"app_id":"com.acme.notes"}',
      }
    );
  }

  // Warns rather than refuses. The recorder cannot tell "the app never left"
  // from "it left and came back" — that needs the route as it was immediately
  // before the last action, and the only route it has is the last one this flow
  // GATED on. A device run proved the difference matters: Home → Search → Home,
  // with the intermediate screen gated on an element (what the skills prescribe
  // for a route-less screen), was refused with a reason that was simply false.
  it("records it, but warns that the gate may prove nothing", async () => {
    const registry = registryReadingRoutes(["HomeTab", "HomeTab"]);
    await startRecording("same-route");

    const first = await readScreen("same-route", registry);
    const second = await readScreen("same-route", registry);

    expect(first.message).toContain("Step added");
    expect(second.message).toContain("Step added");
    expect(second.message).toContain('same route ("HomeTab")');
    expect(second.message).toContain("destination-only element");
    // The claim is conditional — it must never assert the navigation failed.
    expect(second.message).toContain("If the app did not actually leave");
    expect(second.stepCount).toBe(first.stepCount + 1);
    expect(parseFlow(await onDisk("same-route")).steps).toHaveLength(2);
  });

  it("records a gate whose route actually changed", async () => {
    const registry = registryReadingRoutes(["HomeTab", "Settings"]);
    await startRecording("moved");

    await readScreen("moved", registry);
    const second = await readScreen("moved", registry);

    expect(second.message).toContain("Step added");
    expect(parseFlow(await onDisk("moved")).steps).toMatchObject([
      { kind: "screen", route: "HomeTab" },
      { kind: "screen", route: "Settings" },
    ]);
  });

  it("says nothing when the route the flow last gated on was a different one", async () => {
    // A→B→A: the previous gate is B, so the A gate is unambiguous and silent.
    const registry = registryReadingRoutes(["HomeTab", "Settings", "HomeTab"]);
    await startRecording("round-trip");

    await readScreen("round-trip", registry);
    await readScreen("round-trip", registry);
    const third = await readScreen("round-trip", registry);

    expect(third.message).toContain("Step added");
    expect(third.message).not.toContain("same route");
    expect(parseFlow(await onDisk("round-trip")).steps).toHaveLength(3);
  });
});

// The recorder's own poll window is too narrow to judge a `hidden` check: the
// action that removes an element runs BEFORE the check, so the correct
// authoring order always reaches the gate with "never matched". The flow is
// the wider evidence.
describe("a hidden check the flow already established IS recorded", () => {
  const VACUOUS = {
    success: true,
    elapsed: 40,
    note:
      "condition met immediately — the selector never matched any element, so it may have " +
      "already been hidden before the wait, or the selector is wrong",
  };

  async function recordPair(
    establish: () => Promise<unknown>,
    hiddenSelector: string
  ): Promise<string> {
    const tool = createFlowAddStepTool(registryReturning(VACUOUS));
    await startRecording("established");
    await establish();
    const result = await tool.execute(
      {},
      {
        name: "established",
        project_root: tmpDir,
        command: "await-ui-element",
        args: `{"udid":"ABC","condition":"hidden","selector":${hiddenSelector}}`,
      }
    );
    return result.message;
  }

  it("accepts it after an earlier visible check on the same id", async () => {
    const tool = createFlowAddStepTool(registryReturning({ success: true, elapsed: 10 }));
    const message = await recordPair(
      () =>
        tool.execute(
          {},
          {
            name: "established",
            project_root: tmpDir,
            command: "await-ui-element",
            args: '{"udid":"ABC","condition":"visible","selector":{"identifier":"toast-saved"}}',
          }
        ),
      '{"identifier":"toast-saved"}'
    );
    expect(message).toContain("Step added");
  });

  it("accepts it after the element was tapped", async () => {
    const tool = createFlowAddStepTool(registryReturning({ tapped: true }));
    const message = await recordPair(
      () =>
        tool
          .execute(
            {},
            {
              name: "established",
              project_root: tmpDir,
              command: "gesture-tap",
              args: '{"udid":"ABC","x":0.5,"y":0.5}',
            }
          )
          .catch(() => undefined),
      '{"identifier":"remove-row"}'
    );
    // The tap captured no selector here, so nothing was established.
    expect(message).toContain("step NOT recorded");
  });

  it("still refuses when only a DIFFERENT selector was established", async () => {
    const tool = createFlowAddStepTool(registryReturning({ success: true, elapsed: 10 }));
    const message = await recordPair(
      () =>
        tool.execute(
          {},
          {
            name: "established",
            project_root: tmpDir,
            command: "await-ui-element",
            args: '{"udid":"ABC","condition":"visible","selector":{"identifier":"other-thing"}}',
          }
        ),
      '{"identifier":"toast-saved"}'
    );
    expect(message).toContain("no earlier step in this flow established it");
  });

  it("does not treat an earlier hidden check as positive evidence", async () => {
    const tool = createFlowAddStepTool(registryReturning(VACUOUS));
    await startRecording("hidden-chain");
    // First one is refused, so it never enters the flow to vouch for the second.
    const first = await tool.execute(
      {},
      {
        name: "hidden-chain",
        project_root: tmpDir,
        command: "await-ui-element",
        args: '{"udid":"ABC","condition":"hidden","selector":{"text":"Saving…"}}',
      }
    );
    const second = await tool.execute(
      {},
      {
        name: "hidden-chain",
        project_root: tmpDir,
        command: "await-ui-element",
        args: '{"udid":"ABC","condition":"hidden","selector":{"text":"Saving…"}}',
      }
    );
    expect(first.message).toContain("step NOT recorded");
    expect(second.message).toContain("step NOT recorded");
  });
});
