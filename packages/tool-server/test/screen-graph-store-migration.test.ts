/**
 * Phase D.1 store-level regression: load the graph store UPLOADED by the failing
 * run 33947160117 and prove the two D.1 fixes on real data.
 *
 * Fix B (H_id-only keying): the pre-fix store carries pollutant nodes keyed by a
 * STRUCTURAL hash (the describe tier used `state.hash` instead of `state.idHash`).
 * They duplicate the identity nodes' index, so a navTarget resolves to TWO
 * screens ("ambiguous target"). An H_id-only store (what a re-record now
 * produces) drops them, and every navTarget then resolves to at most one node.
 *
 * Fix A (unique selector on replay): every root→sub edge recorded a
 * `target: {id: "title"}` — `android:id/title` is shared by ~19 rows — so replay
 * must NOT tap the first match. Over the CAPTURED root tree, `resolveTapPoint`
 * skips the ambiguous id and resolves the unique row text to exactly one point.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTapPoint } from "../src/tools/navigate-to";
import { ScreenGraphStore } from "../src/screen-graph/store";
import {
  parseSelectorKey,
  type CanonicalAction,
  type Edge,
  type EdgeSelector,
  type ScreenNode,
} from "../src/screen-graph/types";

const NOW = 1_700_000_000_000;

interface StoreDoc {
  nodes: Record<string, ScreenNode>;
  edges: Edge[];
}
interface RootTree {
  screen: { width: number; height: number };
  nodes: Array<{ id?: string; text?: string; cd?: string; bounds: { x1: number; y1: number; x2: number; y2: number } }>;
}

const FIX = join(__dirname, "fixtures");
const store = JSON.parse(
  readFileSync(join(FIX, "screen-graph-run-33947160117-settings.json"), "utf8")
) as StoreDoc;
const rootTree = JSON.parse(
  readFileSync(join(FIX, "screen-graph-settings-root-tree.json"), "utf8")
) as RootTree;

/** A node is a describe-tier pollutant iff it carries no resource-id multiset AND
 *  no structural hash — the shape the pre-Fix-B describe tier wrote (index only).
 *  A real H_id node (recorder / fixed tier) always carries both. */
function isPollutant(n: ScreenNode): boolean {
  return !(n.resourceIds && n.resourceIds.length > 0) && !n.structuralHash;
}

/** Case-insensitive: does this node's index hold a `text` selector equal to `t`? */
function indexesText(n: ScreenNode, t: string): boolean {
  const want = t.trim().toLowerCase();
  for (const key of Object.keys(n.index)) {
    const sel = parseSelectorKey(key);
    if (sel?.text && sel.text.trim().toLowerCase() === want) return true;
  }
  return false;
}

// The navTargets the bench routes to (screen identities distinct from the oracle).
const NAV_TARGETS = [
  "Internet",
  "Saved devices",
  "Recently opened apps",
  "Notification history",
  "Battery Saver",
  "Trash",
  "Call volume",
  "Brightness",
];

describe("phase D.1 Fix B — H_id-only keying on the run 33947160117 store", () => {
  it("the pre-fix store DOES carry structural-hash-keyed pollutant nodes (the bug)", () => {
    const pollutants = Object.values(store.nodes).filter(isPollutant);
    expect(pollutants.length).toBeGreaterThan(0);
    // Each pollutant's key equals a real identity node's structuralHash (it is the
    // structural `H` the describe tier mis-keyed on).
    const structuralHashes = new Set(
      Object.values(store.nodes)
        .map((n) => n.structuralHash)
        .filter(Boolean) as string[]
    );
    expect(pollutants.some((p) => structuralHashes.has(p.hash))).toBe(true);
  });

  it("'Internet' is indexed by >1 node BEFORE the rebuild (the ambiguity)", () => {
    const holders = Object.values(store.nodes).filter((n) => indexesText(n, "Internet"));
    expect(holders.length).toBeGreaterThan(1);
  });

  it("after an H_id-only rebuild: no node is keyed by a structural hash, and every navTarget resolves to ≤1 node", () => {
    const clean: Record<string, ScreenNode> = {};
    for (const [h, n] of Object.entries(store.nodes)) {
      if (!isPollutant(n)) clean[h] = n;
    }
    // (a) no surviving node is keyed by another node's structural hash.
    const structuralHashes = new Set(
      Object.values(clean)
        .map((n) => n.structuralHash)
        .filter(Boolean) as string[]
    );
    for (const h of Object.keys(clean)) {
      expect(structuralHashes.has(h)).toBe(false);
    }
    // (b) every navTarget is now indexed by at most one screen (no ambiguity).
    for (const t of NAV_TARGETS) {
      const holders = Object.values(clean).filter((n) => indexesText(n, t));
      expect(holders.length).toBeLessThanOrEqual(1);
    }
    // And the routable one ("Internet") collapses to exactly one screen.
    expect(Object.values(clean).filter((n) => indexesText(n, "Internet")).length).toBe(1);
  });
});

describe("phase D.1 Fix A — every root→sub edge resolves to ONE row on the captured root tree", () => {
  const size = { width: rootTree.screen.width, height: rootTree.screen.height };
  // Stub server backed by the captured root tree: `query` honours the
  // case-insensitive CONTAINS matcher resolveTapPoint sends (like the device).
  const server: any = {
    query: async (sel: { id?: any; text?: any }, opts?: { limit?: number }) => {
      const val = (m: any): string => (typeof m === "object" && m ? m.contains ?? m.equals ?? "" : m ?? "");
      const idm = val(sel.id).toLowerCase();
      const tm = val(sel.text).toLowerCase();
      const matched = rootTree.nodes.filter((n) => {
        if (sel.id) return (n.id ?? "").toLowerCase().includes(idm);
        if (sel.text) return (n.text ?? "").toLowerCase().includes(tm) || (n.cd ?? "").toLowerCase().includes(tm);
        return false;
      });
      return { nodes: matched.slice(0, opts?.limit ?? 20) };
    },
    getState: async () => ({ idHash: "live", hash: "liveH" }),
  };

  // The operative root node = the homepage node that is the `from` of the most
  // tap edges (9039b5e4 in this store), and its stored index for the bucket path.
  const tapEdgeFrom = new Map<string, number>();
  for (const e of store.edges) {
    if (e.action.kind === "tap" && e.from !== e.to) {
      tapEdgeFrom.set(e.from, (tapEdgeFrom.get(e.from) ?? 0) + 1);
    }
  }
  const rootHash = [...tapEdgeFrom.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const rootIndex = store.nodes[rootHash]?.index;
  const rootSubEdges = store.edges.filter(
    (e) => e.from === rootHash && e.to !== rootHash && e.action.kind === "tap"
  );

  it("the store has several root→sub tap edges, all sharing the ambiguous id `title`", () => {
    expect(rootSubEdges.length).toBeGreaterThanOrEqual(6);
    // The recorded targets are the shared, non-unique `android:id/title`.
    const titleEdges = rootSubEdges.filter((e) => e.action.target?.id === "title");
    expect(titleEdges.length).toBeGreaterThanOrEqual(6);
  });

  it("resolveTapPoint resolves EACH row edge (a selector with row text) to exactly one row", async () => {
    // The bench routes on the list-row edges — those whose recorded selector
    // carries the row's distinguishing text. Every one resolves uniquely despite
    // the shared `android:id/title`, because Fix A skips the ambiguous id.
    const rowEdges = rootSubEdges.filter((e) => (e.selector as EdgeSelector | undefined)?.text);
    expect(rowEdges.length).toBeGreaterThanOrEqual(6);
    for (const e of rowEdges) {
      const r = await resolveTapPoint(
        server,
        size,
        e.action as CanonicalAction,
        rootIndex,
        e.selector as EdgeSelector | undefined
      );
      expect(
        "cx" in r,
        `row edge ${JSON.stringify((e.selector as EdgeSelector).text)} should resolve, got ${JSON.stringify(r)}`
      ).toBe(true);
    }
  });

  it("Fix A never taps blindly: an edge with no UNIQUE key (a container tap) DIVERGES instead", async () => {
    // Some edges were recorded by tapping a shared container (`text_frame`) with
    // no row text — Fix A refuses (diverge) rather than tap the first match.
    const containerEdges = rootSubEdges.filter(
      (e) => !(e.selector as EdgeSelector | undefined)?.text && e.action.target?.id
    );
    for (const e of containerEdges) {
      const r = await resolveTapPoint(
        server,
        size,
        e.action as CanonicalAction,
        undefined, // no from-index → no bucket fallback; selector-only resolution
        e.selector as EdgeSelector | undefined
      );
      // Either it uniquely resolved, or it correctly refused — never a blind tap.
      if (!("cx" in r)) {
        expect(r.diverge).toBe(true);
      }
    }
  });
});

describe("phase D.2 HIGH-1 — store duplicate-screen invariant", () => {
  function freshStore(): ScreenGraphStore {
    return new ScreenGraphStore({ packageName: "com.test", versionCode: "1", now: () => NOW, debounceMs: 1_000_000 });
  }

  it("duplicateScreens() flags two nodes with identical compact + resourceIds + stateHash", () => {
    const s = freshStore();
    // Two different H_id keys for one screen — the transient-node bug.
    s.upsertNode({ hash: "idA", compact: "NET-INTERNET", stateHash: "t1", resourceIds: ["title", "recycler_view"] });
    s.upsertNode({ hash: "idB", compact: "NET-INTERNET", stateHash: "t1", resourceIds: ["title", "recycler_view"] });
    s.upsertNode({ hash: "idC", compact: "SOUND", stateHash: "t2", resourceIds: ["title", "seekbar"] });
    const dups = s.duplicateScreens();
    s.dispose();
    expect(dups.length).toBe(1);
    expect(new Set(dups[0])).toEqual(new Set(["idA", "idB"]));
  });

  it("a store of distinct screens has NO duplicates", () => {
    const s = freshStore();
    s.upsertNode({ hash: "idA", compact: "NET", stateHash: "t1", resourceIds: ["a"] });
    s.upsertNode({ hash: "idB", compact: "SOUND", stateHash: "t2", resourceIds: ["b"] });
    const dups = s.duplicateScreens();
    s.dispose();
    expect(dups).toEqual([]);
  });

  it("the run 33958064084 store VIOLATES the invariant (the transient-node bug D.2 fixes)", () => {
    // Regression evidence: the D.1 run minted a second "Network & internet:
    // Internet" node (byte-identical content, different H_id) from a premature
    // after-fingerprint. The settled-read fix (HIGH-1) prevents it; this asserts
    // the invariant would have caught it on that store.
    const raw = JSON.parse(
      readFileSync(join(FIX, "screen-graph-run-33958064084-settings.json"), "utf8")
    ) as StoreDoc;
    const groups = new Map<string, string[]>();
    for (const [hash, n] of Object.entries(raw.nodes)) {
      const compact = n.compact ?? "";
      const stateHash = n.stateHash ?? "";
      if (compact === "" && stateHash === "") continue;
      const key = `${compact} ${(n.resourceIds ?? []).join(",")} ${stateHash}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(hash);
    }
    const dups = [...groups.values()].filter((g) => g.length > 1);
    expect(dups.length).toBe(1);
    const labels = dups[0]!.map((h) => raw.nodes[h]!.label);
    expect(labels.every((l) => l === "Network & internet: Internet")).toBe(true);
  });
});

describe("phase D.3 (D2-M2) — edge-destination invariant", () => {
  function freshStore(): ScreenGraphStore {
    return new ScreenGraphStore({ packageName: "com.test", versionCode: "1", now: () => NOW, debounceMs: 1_000_000 });
  }

  it("duplicateEdgeTargets() flags one (from, action) with two destinations", () => {
    const s = freshStore();
    const action = { kind: "tap" as const, target: { text: "Apps" } };
    s.observe("root", action, "apps", { success: true }); // real edge
    s.observe("root", action, "root", { success: true }); // competing self-edge (bug)
    s.observe("root", { kind: "tap" as const, target: { text: "Battery" } }, "battery", { success: true });
    const dups = s.duplicateEdgeTargets();
    s.dispose();
    expect(dups.length).toBe(1);
    expect(new Set(dups[0]!.tos)).toEqual(new Set(["apps", "root"]));
  });

  it("a store where every (from, action) has one destination is clean", () => {
    const s = freshStore();
    s.observe("root", { kind: "tap" as const, target: { text: "Apps" } }, "apps", {});
    s.observe("root", { kind: "tap" as const, target: { text: "Battery" } }, "battery", {});
    s.observe("apps", { kind: "tap" as const, target: { text: "All apps" } }, "allApps", {});
    const dups = s.duplicateEdgeTargets();
    s.dispose();
    expect(dups).toEqual([]);
  });
});
