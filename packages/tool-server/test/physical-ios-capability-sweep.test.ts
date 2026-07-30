/**
 * Registry-wide sweep of the physical-iPhone capability gate.
 *
 * `physical-ios-followups.test.ts` names the simulator-only tools one by one,
 * which pins each tool's own capability object but can only ever cover the
 * tools someone remembered to add. The gap that costs something is the tool
 * nobody lists: a simulator-only backend that a physical iPhone walks straight
 * into, failing deep inside `simctl` with a 500 instead of at the gate with a
 * 400. So this file derives the set from the registry instead of restating it,
 * and the "every simulator-only tool" claim holds by construction — including
 * for tools added after this was written.
 */
import { describe, expect, it } from "vitest";
import type { ToolCapability } from "@argent/registry";
import { createRegistry } from "../src/utils/setup-registry";
import { pasteTool } from "../src/tools/paste";
import { resolveDevice } from "../src/utils/device-info";
import { assertSupported, UnsupportedOperationError } from "../src/utils/capability";

const PHYSICAL_UDID = "00008120-000E6D0C0ABBA01E";
const SIM_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

/**
 * Every tool the server can dispatch, keyed by id. `paste` is defined outside
 * `createRegistry` (macOS-only registration), so it is added explicitly — the
 * same reason `interaction-messages.test.ts` adds it to its catalog.
 */
function allCapabilities(): Map<string, ToolCapability | undefined> {
  const registry = createRegistry();
  const caps = new Map<string, ToolCapability | undefined>();
  for (const id of registry.getSnapshot().tools) {
    caps.set(id, registry.getTool(id)!.capability);
  }
  caps.set("paste", pasteTool.capability);
  return caps;
}

/** Declares iOS-simulator support and withholds physical-iPhone support. */
function isSimulatorOnly(cap: ToolCapability | undefined): boolean {
  return cap?.apple?.simulator === true && cap.apple.device !== true;
}

describe("physical-iPhone capability gate, swept across the registry", () => {
  const physical = resolveDevice(PHYSICAL_UDID);
  const sim = resolveDevice(SIM_UDID);

  it("rejects a physical iPhone from every simulator-only tool, keeping simulators working", () => {
    const simulatorOnly = [...allCapabilities()].filter(([, cap]) => isSimulatorOnly(cap));

    // Anti-vacuity: a derivation bug that yields an empty or tiny set would
    // otherwise pass this test while checking nothing. These four span the
    // distinct simulator-only backends — `simctl privacy`, `simctl spawn` +
    // DYLD injection, xctrace, and the single-contact digitizer limit — so
    // losing any whole family trips the membership check, not just the count.
    const ids = simulatorOnly.map(([id]) => id);
    for (const id of [
      "settings-permissions",
      "native-describe-screen",
      "native-profiler-start",
      "gesture-pinch",
    ]) {
      expect(ids, `${id} must be reached by the sweep`).toContain(id);
    }
    expect(simulatorOnly.length).toBeGreaterThanOrEqual(16);

    for (const [id, cap] of simulatorOnly) {
      expect(
        () => assertSupported(id, cap, physical),
        `${id} must reject a physical iPhone`
      ).toThrow(UnsupportedOperationError);
      expect(
        () => assertSupported(id, cap, sim),
        `${id} must still accept a simulator`
      ).not.toThrow();
    }
  });

  it("lets every tool that claims physical-iPhone support through the gate", () => {
    const physicalCapable = [...allCapabilities()].filter(([, cap]) => cap?.apple?.device === true);

    // The other direction of the same gate: a capability edited to `device:
    // true` must actually be reachable on hardware. Without this, narrowing
    // `assertSupported` (or `resolveDevice`'s kind classification) could shut
    // physical iOS off wholesale and only the sweep above would stay green.
    // `describe` and `screenshot` are the two tools everything else is built
    // on — an agent that can neither read the screen nor see it has no use for
    // the rest. Flipping either to `device: false` is the single most damaging
    // edit here, and nothing else in the suite names them on the physical side.
    const ids = physicalCapable.map(([id]) => id);
    expect(ids).toContain("describe");
    expect(ids).toContain("screenshot");
    expect(ids).toContain("gesture-tap");
    expect(physicalCapable.length).toBeGreaterThanOrEqual(10);

    for (const [id, cap] of physicalCapable) {
      expect(
        () => assertSupported(id, cap, physical),
        `${id} must accept a physical iPhone`
      ).not.toThrow();
    }
  });
});
