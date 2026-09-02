import { describe, expect, it } from "vitest";
import {
  assertionObservation,
  observeAfterAction,
  usesGraph,
  usesOutcomes,
  usesOpenServer,
} from "../src/screen-graph/bench/policy";
import type { BenchConfigId } from "../src/screen-graph/bench/types";

describe("screen-graph bench policy — per-config observations", () => {
  it("B1/B2 re-read the whole screen (describe) after every action", () => {
    expect(observeAfterAction("B1").observations).toEqual(["describe"]);
    expect(observeAfterAction("B2").observations).toEqual(["describe"]);
  });

  it("H1: O1 asks a query instead of a describe on an action step", () => {
    const d = observeAfterAction("O1");
    expect(d.observations).toEqual(["query"]);
    expect(d.observations).not.toContain("describe");
  });

  it("H2: O2 removes the read when the outcome reports no change", () => {
    const unchanged = observeAfterAction("O2", { outcome: { changed: false, newScreen: false } });
    expect(unchanged.observations).toEqual(["none"]);
    const changed = observeAfterAction("O2", { outcome: { changed: true, newScreen: true } });
    expect(changed.observations).toEqual(["query"]);
  });

  it("H3: O3 pays a describe on a cold (new) screen; O4 hits a cheap graph-lookup on a known screen", () => {
    // Cold store: the screen is new → full describe to render + insert.
    const cold = observeAfterAction("O3", {
      outcome: { changed: true, newScreen: true },
      knownScreen: false,
    });
    expect(cold.observations).toEqual(["describe"]);
    // Warm: the same screen is known → graph lookup (order-of-magnitude cheaper).
    const warm = observeAfterAction("O4", {
      outcome: { changed: true, newScreen: true },
      knownScreen: true,
    });
    expect(warm.observations).toEqual(["graph-lookup"]);
  });

  it("O3/O4 still skip the read entirely when the outcome says unchanged", () => {
    expect(
      observeAfterAction("O3", { outcome: { changed: false, newScreen: false } }).observations
    ).toEqual(["none"]);
    expect(
      observeAfterAction("O4", { outcome: { changed: false, newScreen: false } }).observations
    ).toEqual(["none"]);
  });

  it("O5 uses navigate-to for a step with a known target, verified by a graph-lookup", () => {
    const nav = observeAfterAction("O5", { knownTarget: true });
    expect(nav.useNavigate).toBe(true);
    expect(nav.observations).toEqual(["graph-lookup"]);
    // Without a known target, O5 behaves like O4.
    const noNav = observeAfterAction("O5", {
      outcome: { changed: true, newScreen: true },
      knownScreen: true,
    });
    expect(noNav.useNavigate).toBe(false);
    expect(noNav.observations).toEqual(["graph-lookup"]);
  });

  it("assertion is read via query for every open config and via describe for B1", () => {
    expect(assertionObservation("B1")).toBe("describe");
    for (const c of ["B2", "O1", "O2", "O3", "O4", "O5"] as BenchConfigId[]) {
      expect(assertionObservation(c)).toBe("query");
    }
  });

  it("capability predicates match the config semantics", () => {
    expect(usesOpenServer("B1")).toBe(false);
    expect(usesOpenServer("B2")).toBe(true);
    expect(usesOutcomes("O1")).toBe(false);
    expect(usesOutcomes("O2")).toBe(true);
    expect(usesGraph("O2")).toBe(false);
    expect(usesGraph("O3")).toBe(true);
    expect(usesGraph("O5")).toBe(true);
  });
});
