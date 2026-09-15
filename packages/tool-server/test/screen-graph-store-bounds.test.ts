import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ScreenGraphStore } from "../src/screen-graph/store";
import { isNodeVolatile, type CanonicalAction } from "../src/screen-graph/types";

let tmpDir: string;
let clock = 1_000_000;
const now = () => clock;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sg-bounds-"));
  clock = 1_000_000;
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const MS_PER_DAY = 86_400_000;
const TAP: CanonicalAction = { kind: "tap", target: { text: "x" } };

function boundedStore(bounds: { maxNodes?: number; maxEdges?: number; maxBytes?: number }) {
  return new ScreenGraphStore({
    packageName: "com.churn",
    versionCode: "1",
    baseDir: tmpDir,
    now,
    enforceBounds: true,
    bounds,
    debounceMs: 10_000_000,
  });
}

describe("bounded store — LRU / pins / referential integrity (design D2 R1/R2)", () => {
  it("evicts the least-recently-seen unpinned node and keeps pinned ones", () => {
    const store = boundedStore({ maxNodes: 2 });
    // A: pinned by visits (>=5). B: oldest unpinned. C: newest unpinned.
    for (let i = 0; i < 5; i++) {
      clock = 1000 + i;
      store.upsertNode({ hash: "A", compact: "a", stateHash: `sa${i}`, index: {} });
    }
    clock = 2000;
    store.upsertNode({ hash: "B", compact: "b", stateHash: "sb", index: {} });
    clock = 3000;
    store.upsertNode({ hash: "C", compact: "c", stateHash: "sc", index: {} });

    store.enforceBounds();

    expect(store.hasNode("A")).toBe(true); // pinned (visits >= 5)
    expect(store.hasNode("C")).toBe(true); // newest
    expect(store.hasNode("B")).toBe(false); // oldest unpinned — evicted
    expect(Object.keys(store.nodes).length).toBe(2);
  });

  it("evicting a node removes its incident edges (G-I4 referential integrity)", () => {
    const store = boundedStore({ maxNodes: 2 });
    clock = 1000;
    store.upsertNode({ hash: "A", compact: "a", stateHash: "sa", index: {} });
    clock = 2000;
    store.upsertNode({ hash: "B", compact: "b", stateHash: "sb", index: {} });
    clock = 3000;
    store.upsertNode({ hash: "C", compact: "c", stateHash: "sc", index: {} });
    store.observe("A", TAP, "B");
    store.observe("B", TAP, "C");

    store.enforceBounds();

    expect(store.danglingEdges()).toEqual([]);
    expect(store.pruneStats().evictedNodes).toBeGreaterThanOrEqual(1);
    for (const e of store.edges) {
      expect(store.hasNode(e.from)).toBe(true);
      expect(store.hasNode(e.to)).toBe(true);
    }
  });

  it("pins a node that is an endpoint of a successful edge (successes >= 3)", () => {
    const store = boundedStore({ maxNodes: 2 });
    clock = 1000;
    store.upsertNode({ hash: "A", compact: "a", stateHash: "sa", index: {} });
    clock = 1500;
    store.upsertNode({ hash: "B", compact: "b", stateHash: "sb", index: {} }); // old but pinned by edge
    for (let i = 0; i < 3; i++) store.observe("A", TAP, "B");
    clock = 3000;
    store.upsertNode({ hash: "C", compact: "c", stateHash: "sc", index: {} });
    clock = 3500;
    store.upsertNode({ hash: "D", compact: "d", stateHash: "sd", index: {} });

    store.enforceBounds();

    expect(store.hasNode("A")).toBe(true);
    expect(store.hasNode("B")).toBe(true); // pinned by the 3-success edge
  });
});

describe("bounded store — edge decay (design D2 R3)", () => {
  it("drops a chronically-failing edge (ratio < 0.2, count >= 5)", () => {
    const store = boundedStore({ maxNodes: 100 });
    store.upsertNode({ hash: "A", compact: "a", stateHash: "sa", index: {} });
    store.upsertNode({ hash: "B", compact: "b", stateHash: "sb", index: {} });
    // 6 observations, 1 success → ratio 1/6 < 0.2.
    store.observe("A", TAP, "B", { success: true });
    for (let i = 0; i < 5; i++) store.observe("A", TAP, "B", { success: false });
    expect(store.edges).toHaveLength(1);
    store.enforceBounds();
    expect(store.edges).toHaveLength(0);
    expect(store.pruneStats().decayedEdges).toBe(1);
  });

  it("drops a 30-day-stale edge and keeps a healthy fresh one", () => {
    const store = boundedStore({ maxNodes: 100 });
    store.upsertNode({ hash: "A", compact: "a", stateHash: "sa", index: {} });
    store.upsertNode({ hash: "B", compact: "b", stateHash: "sb", index: {} });
    store.observe("A", TAP, "B", { success: true }); // lastSeen = clock
    clock += 31 * MS_PER_DAY;
    store.upsertNode({ hash: "C", compact: "c", stateHash: "sc", index: {} });
    store.observe("A", { kind: "tap", target: { text: "y" } }, "C", { success: true });
    store.enforceBounds();
    // A->B is stale (31 days), A->C is fresh.
    const tos = store.edges.map((e) => e.to);
    expect(tos).toContain("C");
    expect(tos).not.toContain("B");
  });
});

describe("bounded store — volatility (design D2 R4)", () => {
  it("flips volatile at the threshold and drops compact on persist", async () => {
    const store = boundedStore({ maxNodes: 100 });
    // 5 upserts with 5 distinct stateHashes → distinctStates/samples = 4/5 = 0.8.
    for (let i = 0; i < 5; i++) {
      clock += 10;
      store.upsertNode({
        hash: "FEED",
        compact: "big feed compact body",
        stateHash: `s${i}`,
        index: {},
      });
    }
    const node = store.getNode("FEED")!;
    expect(isNodeVolatile(node)).toBe(true);
    await store.flush();
    const persisted = JSON.parse(fs.readFileSync(store.filePath(), "utf8"));
    expect(persisted.nodes.FEED.compact).toBe("");
    expect(store.volatileNodeCount()).toBe(1);
  });

  it("a stable node stays non-volatile and keeps its compact", async () => {
    const store = boundedStore({ maxNodes: 100 });
    for (let i = 0; i < 6; i++) {
      clock += 10;
      store.upsertNode({ hash: "STABLE", compact: "settings root", stateHash: "same", index: {} });
    }
    expect(isNodeVolatile(store.getNode("STABLE")!)).toBe(false);
    await store.flush();
    const persisted = JSON.parse(fs.readFileSync(store.filePath(), "utf8"));
    expect(persisted.nodes.STABLE.compact).toBe("settings root");
  });
});

describe("bounds OFF is byte-for-byte the pre-E behaviour (E1-G5 non-regression)", () => {
  it("does not evict, decay, track volatility or drop compact when disabled", async () => {
    const store = new ScreenGraphStore({
      packageName: "com.android.settings",
      versionCode: "35",
      baseDir: tmpDir,
      now,
      debounceMs: 10_000_000,
      // enforceBounds omitted → default false
    });
    for (let i = 0; i < 400; i++) {
      clock += 1;
      store.upsertNode({ hash: `n${i}`, compact: "body", stateHash: `st${i}`, index: {} });
    }
    // A churny node id under bounds-off keeps its compact and gains no volatility.
    for (let i = 0; i < 6; i++) {
      clock += 1;
      store.upsertNode({ hash: "churny", compact: "keepme", stateHash: `k${i}`, index: {} });
    }
    await store.flush();
    const persisted = JSON.parse(fs.readFileSync(store.filePath(), "utf8"));
    expect(Object.keys(persisted.nodes).length).toBe(401); // nothing evicted
    expect(persisted.nodes.churny.compact).toBe("keepme"); // compact kept
    expect(persisted.nodes.churny.volatility).toBeUndefined(); // not tracked
  });
});
