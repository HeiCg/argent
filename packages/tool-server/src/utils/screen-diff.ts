/**
 * Host-side keyed tree diff (Screen-graph Phase A, design §3), the TypeScript
 * twin of the on-device Kotlin `ScreenDiff`. Nodes are keyed by their
 * child-index path (the `(class, id, indexInParent)` position chain). The
 * flattened compact-record space satisfies `patch(flatten(a), diff(a, b))`
 * deep-equals `flatten(b)`.
 *
 * Used by any host path that must diff two trees itself (e.g. a WDA `/source`
 * pair, or to reconcile a cached rendering against a fresh read). The Android
 * open server computes its own `diff` device-side; this is the host equivalent.
 */
import { flagsOf, type HashNode } from "./screen-hash";

export interface CompactNode {
  class: string;
  id: string;
  text: string;
  cd: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  flags: number;
  /** Child-index path from the root forest. */
  path: number[];
}

export type ChangedFields = Partial<Omit<CompactNode, "path">>;

export interface TreeDiff {
  added: CompactNode[];
  /** Paths present in `a` but not `b`. */
  removed: number[][];
  changed: Array<{ path: number[]; changedFields: ChangedFields }>;
}

const keyOf = (path: number[]): string => path.join(".");

function toCompact(n: HashNode, path: number[]): CompactNode {
  return {
    class: n.class ?? "",
    id: n.id ?? "",
    text: n.text ?? "",
    cd: n.cd ?? "",
    bounds: { x1: n.bounds.x1, y1: n.bounds.y1, x2: n.bounds.x2, y2: n.bounds.y2 },
    flags: flagsOf(n),
    path,
  };
}

/** DFS pre-order flatten to compact records, each carrying its child-index path. */
export function flatten(roots: HashNode[]): CompactNode[] {
  const out: CompactNode[] = [];
  const visit = (n: HashNode, path: number[]): void => {
    out.push(toCompact(n, path));
    const children = n.children ?? [];
    for (let i = 0; i < children.length; i++) visit(children[i]!, [...path, i]);
  };
  for (let i = 0; i < roots.length; i++) visit(roots[i]!, [i]);
  return out;
}

function fieldsDiffer(a: CompactNode, b: CompactNode): ChangedFields {
  const cf: ChangedFields = {};
  if (a.class !== b.class) cf.class = b.class;
  if (a.id !== b.id) cf.id = b.id;
  if (a.text !== b.text) cf.text = b.text;
  if (a.cd !== b.cd) cf.cd = b.cd;
  if (
    a.bounds.x1 !== b.bounds.x1 ||
    a.bounds.y1 !== b.bounds.y1 ||
    a.bounds.x2 !== b.bounds.x2 ||
    a.bounds.y2 !== b.bounds.y2
  ) {
    cf.bounds = { ...b.bounds };
  }
  if (a.flags !== b.flags) cf.flags = b.flags;
  return cf;
}

/** Keyed diff of two trees. */
export function diffTrees(a: HashNode[], b: HashNode[]): TreeDiff {
  const fa = flatten(a);
  const fb = flatten(b);
  const mapA = new Map(fa.map((n) => [keyOf(n.path), n]));
  const mapB = new Map(fb.map((n) => [keyOf(n.path), n]));

  const added: CompactNode[] = [];
  const removed: number[][] = [];
  const changed: TreeDiff["changed"] = [];

  for (const node of fb) {
    const old = mapA.get(keyOf(node.path));
    if (!old) {
      added.push(node);
    } else {
      const cf = fieldsDiffer(old, node);
      if (Object.keys(cf).length > 0) changed.push({ path: node.path, changedFields: cf });
    }
  }
  for (const node of fa) {
    if (!mapB.has(keyOf(node.path))) removed.push(node.path);
  }

  return { added, removed, changed };
}

function cmpPath(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/**
 * Apply a diff to a flattened `a` and return the reconstructed, DFS-ordered
 * flattened `b`. `patch(flatten(a), diffTrees(a, b))` deep-equals `flatten(b)`.
 */
export function patch(a: CompactNode[], d: TreeDiff): CompactNode[] {
  const map = new Map<string, CompactNode>();
  for (const n of a) {
    map.set(keyOf(n.path), {
      ...n,
      bounds: { ...n.bounds },
      path: [...n.path],
    });
  }
  for (const path of d.removed) map.delete(keyOf(path));
  for (const { path, changedFields } of d.changed) {
    const node = map.get(keyOf(path));
    if (!node) continue;
    if (changedFields.class !== undefined) node.class = changedFields.class;
    if (changedFields.id !== undefined) node.id = changedFields.id;
    if (changedFields.text !== undefined) node.text = changedFields.text;
    if (changedFields.cd !== undefined) node.cd = changedFields.cd;
    if (changedFields.bounds !== undefined) node.bounds = { ...changedFields.bounds };
    if (changedFields.flags !== undefined) node.flags = changedFields.flags;
  }
  for (const node of d.added) {
    map.set(keyOf(node.path), { ...node, bounds: { ...node.bounds }, path: [...node.path] });
  }

  return [...map.values()].sort((x, y) => cmpPath(x.path, y.path));
}
