import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BYTE_CHECK_EVERY_FLUSHES, ScreenGraphStore } from "../src/screen-graph/store";
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

describe("a store built with enforceBounds off (the constructor default; the wiring passes true) stays unbounded", () => {
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

describe("byte-bound check runs only near a cap or every N flushes (review E-1 finding 8)", () => {
  it("does not serialise the store for the byte check on a flush far below the caps", async () => {
    const store = boundedStore({ maxNodes: 300, maxEdges: 600 });
    const spy = vi.spyOn(store, "byteSize");
    store.upsertNode({ hash: "A", compact: "a", stateHash: "sa", index: {} });
    await store.flush();
    expect(spy).not.toHaveBeenCalled();
  });

  it("checks the byte bound when the node count is within 10 % of the cap", async () => {
    const store = boundedStore({ maxNodes: 10, maxBytes: 1 });
    const spy = vi.spyOn(store, "byteSize");
    for (let i = 0; i < 9; i++) {
      clock += 1;
      store.upsertNode({ hash: `n${i}`, compact: "x", stateHash: `s${i}`, index: {} });
    }
    await store.flush();
    expect(spy).toHaveBeenCalled();
    // Over the (tiny) byte cap: unpinned LRU nodes were evicted.
    expect(store.pruneStats().evictedNodes).toBeGreaterThan(0);
  });

  it("checks the byte bound every BYTE_CHECK_EVERY_FLUSHES flushes even far below the caps", async () => {
    const store = boundedStore({ maxNodes: 300, maxEdges: 600 });
    const spy = vi.spyOn(store, "byteSize");
    for (let i = 0; i < BYTE_CHECK_EVERY_FLUSHES; i++) {
      clock += 1;
      store.upsertNode({ hash: `n${i}`, compact: "x", stateHash: `s${i}`, index: {} });
      await store.flush();
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a direct enforceBounds() still checks bytes (the harness call)", () => {
    const store = boundedStore({ maxNodes: 300 });
    const spy = vi.spyOn(store, "byteSize");
    store.enforceBounds();
    expect(spy).toHaveBeenCalled();
  });
});

describe("pins expire after 10 sessions without a visit (review E-1 finding 8c)", () => {
  // Each `load` opens a session; the counter persists with the next write.
  const loadSession = () =>
    ScreenGraphStore.load({
      packageName: "com.churn",
      versionCode: "1",
      baseDir: tmpDir,
      now,
      enforceBounds: true,
      bounds: { maxNodes: 4 },
      debounceMs: 10_000_000,
    });

  it("a saturated store of expired pins respects the node cap", async () => {
    // Session 1: four pinned nodes fill the cap — three by visits, one template.
    let s = await loadSession();
    for (const h of ["P1", "P2", "P3"]) {
      for (let i = 0; i < 5; i++) {
        clock += 1;
        s.upsertNode({ hash: h, compact: h, stateHash: `${h}${i}`, index: {} });
      }
    }
    clock += 1;
    s.upsertNode({ hash: "T", template: true, compact: "t", index: {} });
    await s.flush();
    expect(Object.keys(s.nodes)).toHaveLength(4);

    // Sessions 2..10: each records a fresh node "A". Every pin is younger than 10
    // sessions without a visit, so the only evictable node is A itself.
    for (let session = 2; session <= 10; session++) {
      s = await loadSession();
      clock += 1;
      s.upsertNode({ hash: "A", compact: "a", stateHash: `a${session}`, index: {} });
      await s.flush();
      expect(s.hasNode("A")).toBe(false);
      expect(s.hasNode("P1")).toBe(true);
    }

    // Session 11: ten sessions without a visit — the pins expired, so the LRU
    // evicts the oldest former pin and the new node fits under the cap.
    s = await loadSession();
    clock += 1;
    s.upsertNode({ hash: "A", compact: "a", stateHash: "a11", index: {} });
    await s.flush();
    expect(Object.keys(s.nodes).length).toBeLessThanOrEqual(4);
    expect(s.hasNode("A")).toBe(true);
    expect(s.hasNode("P1")).toBe(false);
    expect(s.pruneStats().pinnedNodes).toBe(0);
  });

  it("a visit refreshes a pin; template pins expire like any other", async () => {
    let s = await loadSession();
    for (const h of ["P1", "P2"]) {
      for (let i = 0; i < 5; i++) {
        clock += 1;
        s.upsertNode({ hash: h, compact: h, stateHash: `${h}${i}`, index: {} });
      }
    }
    clock += 1;
    s.upsertNode({ hash: "T", template: true, compact: "t", index: {} });
    await s.flush();

    for (let session = 2; session <= 11; session++) {
      s = await loadSession();
      // P1 is visited in session 6 — its pin restarts there.
      if (session === 6) s.recordVisit("P1");
      clock += 1;
      s.upsertNode({ hash: `X${session}`, compact: "x", stateHash: "x", index: {} });
      await s.flush();
    }
    // Session 11: P2 and T are 10 sessions stale (unpinned); P1 only 5 (pinned).
    s.enforceBounds();
    expect(s.pruneStats().pinnedNodes).toBe(1);
    expect(s.hasNode("P1")).toBe(true);
  });
});
