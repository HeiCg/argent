import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ScreenGraphStore } from "../src/screen-graph/store";
import { recordObservation } from "../src/screen-graph/recorder";
import type { CanonicalAction } from "../src/screen-graph/types";
import { EMPTY_TREE_HASH } from "../src/utils/screen-hash";

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sg-rec-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ACTION: CanonicalAction = { kind: "tap", target: { text: "Wi-Fi" } };
const store = () => new ScreenGraphStore({ packageName: "p", versionCode: "1", baseDir: tmpDir });

describe("recordObservation", () => {
  it("records the edge and inserts an unknown target from fetchScreen", async () => {
    const s = store();
    const fetchScreen = vi.fn(async () => ({
      compact: "wifi screen",
      stateHash: "st",
      index: {},
      label: "Wi-Fi",
    }));
    await recordObservation({
      store: s,
      action: ACTION,
      before: { hash: "root" },
      after: { hash: "wifi", stateHash: "st" },
      fetchScreen,
    });
    expect(fetchScreen).toHaveBeenCalledTimes(1);
    expect(s.hasNode("wifi")).toBe(true);
    expect(s.getNode("wifi")?.label).toBe("Wi-Fi");
    expect(s.edges).toHaveLength(1);
    expect(s.edges[0]).toMatchObject({ from: "root", to: "wifi" });
  });

  it("does not fetch when the target is already known — just bumps the visit", async () => {
    const s = store();
    s.upsertNode({ hash: "wifi", compact: "wifi screen", stateHash: "st" });
    const before = s.getNode("wifi")!.visits;
    const fetchScreen = vi.fn(async () => ({ compact: "x", stateHash: "y", index: {} }));
    await recordObservation({
      store: s,
      action: ACTION,
      before: { hash: "root" },
      after: { hash: "wifi", stateHash: "st" },
      fetchScreen,
    });
    expect(fetchScreen).not.toHaveBeenCalled();
    expect(s.getNode("wifi")!.visits).toBe(before + 1);
  });

  it("marks the target redacted when a secret preceded the observation", async () => {
    const s = store();
    const fetchScreen = vi.fn(async () => ({ compact: "should-not-persist", stateHash: "st", index: {} }));
    await recordObservation({
      store: s,
      action: { kind: "typeText" },
      before: { hash: "login" },
      after: { hash: "loggedin", stateHash: "st" },
      secret: true,
      fetchScreen,
    });
    // Secret path never fetches (it must not cache the rendered screen).
    expect(fetchScreen).not.toHaveBeenCalled();
    expect(s.getNode("loggedin")?.redacted).toBe(true);
    expect(s.getNode("loggedin")?.compact).toBe("");
  });
});

// Phase 3m.1 (3M-H1): the store must REFUSE to mint a node — or an edge into one —
// from an empty tree. This mirrors the device-side rule (an empty forest yields no
// fingerprint) on the host, exercised with the exact shape from the failed store of
// run 34827025184: `.bench-results/screen-graph/graph-store/com.android.settings/34.json`
// held a node `b2fbe9151b60b485` with `structuralHash == stateHash == EMPTY_TREE_HASH`
// as the SECOND destination of the multi-destination edge
// `"284ef0302b28c5de taptext=Internet"` — a transient empty frame minted as a screen
// because its `H_id` looked real (the device folds the package name into `H_id`).
describe("recordObservation — empty-tree guard (3M-H1)", () => {
  const INTERNET_TAP: CanonicalAction = { kind: "tap", target: { text: "Internet" } };

  it("refuses to mint a node whose structuralHash is EMPTY_TREE_HASH (run 34827025184 shape)", async () => {
    const s = store();
    const fetchScreen = vi.fn(async () => ({
      compact: "",
      stateHash: EMPTY_TREE_HASH,
      structuralHash: EMPTY_TREE_HASH,
      index: {},
    }));
    await recordObservation({
      store: s,
      action: INTERNET_TAP,
      // `284ef0302b28c5de` is the real origin; `b2fbe9151b60b485` the empty-frame id.
      before: { hash: "284ef0302b28c5de" },
      after: { hash: "b2fbe9151b60b485", stateHash: EMPTY_TREE_HASH, structuralHash: EMPTY_TREE_HASH },
      fetchScreen,
    });
    // No node minted, no edge recorded, no fetch — the empty frame is not a screen.
    expect(fetchScreen).not.toHaveBeenCalled();
    expect(s.hasNode("b2fbe9151b60b485")).toBe(false);
    expect(s.edges).toHaveLength(0);
    // And no store-invariant violation could arise from it.
    expect(s.duplicateEdgeTargets()).toHaveLength(0);
    expect(s.duplicateScreens()).toHaveLength(0);
  });

  it("refuses when only the stateHash is EMPTY_TREE_HASH", async () => {
    const s = store();
    await recordObservation({
      store: s,
      action: INTERNET_TAP,
      before: { hash: "284ef0302b28c5de" },
      after: { hash: "b2fbe9151b60b485", stateHash: EMPTY_TREE_HASH },
    });
    expect(s.hasNode("b2fbe9151b60b485")).toBe(false);
    expect(s.edges).toHaveLength(0);
  });

  it("keeps the FIRST (real) destination as the sole edge target — no second empty destination", async () => {
    const s = store();
    // The real transition records normally...
    await recordObservation({
      store: s,
      action: INTERNET_TAP,
      before: { hash: "284ef0302b28c5de" },
      after: { hash: "af75c426f98239d2", stateHash: "realstate", structuralHash: "realstruct" },
      fetchScreen: async () => ({ compact: "Internet screen", stateHash: "realstate", structuralHash: "realstruct", index: {} }),
    });
    // ...and the empty-frame re-observation of the SAME (from, action) is refused,
    // so the edge keeps exactly one destination (the D.3 invariant stays green).
    await recordObservation({
      store: s,
      action: INTERNET_TAP,
      before: { hash: "284ef0302b28c5de" },
      after: { hash: "b2fbe9151b60b485", stateHash: EMPTY_TREE_HASH, structuralHash: EMPTY_TREE_HASH },
      fetchScreen: async () => ({ compact: "", stateHash: EMPTY_TREE_HASH, structuralHash: EMPTY_TREE_HASH, index: {} }),
    });
    expect(s.hasNode("af75c426f98239d2")).toBe(true);
    expect(s.hasNode("b2fbe9151b60b485")).toBe(false);
    expect(s.duplicateEdgeTargets()).toHaveLength(0);
    const outgoing = s.outgoingEdges("284ef0302b28c5de");
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]!.to).toBe("af75c426f98239d2");
  });
});
