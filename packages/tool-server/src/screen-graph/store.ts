/**
 * Screen-graph Phase B store (ticket B1 `store.ts`, design §2.2): an in-memory
 * graph with JSON persistence per `(packageName, versionCode)` under argent's
 * config dir (`<argentHomeDir>/screen-graph/<pkg>/<versionCode>.json`). Writes
 * are debounced (500 ms) and land atomically via tmp-write + rename. Nodes that
 * held a secret are never persisted with their `compact` text.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { argentHomeDir } from "@argent/configuration-core";
import type { CanonicalAction, Edge, EdgeSelector, ScreenGraphData, ScreenNode } from "./types";
import { FLAG_PASSWORD, actionSignature, isNodeVolatile } from "./types";
import { edgeWeight } from "./plan";

const SCHEMA_VERSION = 1 as const;
const DEFAULT_DEBOUNCE_MS = 500;

const MS_PER_DAY = 86_400_000;

/** Phase E (design D2 R1): default per-`(packageName, versionCode)` size caps. */
const DEFAULT_MAX_NODES = 300;
const DEFAULT_MAX_EDGES = 600;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** Phase E (design D2 R3): edge success-ratio decay + staleness thresholds. */
const EDGE_DECAY_MIN_COUNT = 5;
const EDGE_DECAY_MIN_RATIO = 0.2;
const EDGE_STALE_MS = 30 * MS_PER_DAY;

/** Phase E (design D2 R2): never-evict pin thresholds. */
const PIN_VISITS = 5;
const PIN_EDGE_SUCCESSES = 3;

/** Phase E (design D1): caps on the additive template edge accounting. */
const MAX_TEMPLATE_TARGETS = 256;
const MAX_TEMPLATE_ITEM_TEXTS = 8;

interface ScreenGraphBounds {
  maxNodes?: number;
  maxEdges?: number;
  maxBytes?: number;
}

interface ScreenGraphStoreOptions {
  packageName: string;
  versionCode: string;
  /** Root for persistence; defaults to `<argentHomeDir>/screen-graph`. */
  baseDir?: string;
  /** Debounce budget for writes, ms. */
  debounceMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Phase E: override the store size caps (tests force small caps). */
  bounds?: ScreenGraphBounds;
  /**
   * Phase E: enable the new bounded-store behaviour — caps + LRU + edge decay +
   * volatility tracking / compact drop + referential integrity. OFF by default so
   * the `screen-graph`-only path (and the D.4.1 arms) persist byte-for-byte as
   * before; the wiring turns it on only under `ARGENT_SG_TEMPLATES=1`.
   */
  enforceBounds?: boolean;
}

/**
 * Phase E (design D1): the template accounting a template-edge observation folds
 * in. `concreteTo` is the real destination `H_id` (counted for `instances`);
 * `itemText` is the tapped item's label (kept in a small ring for the summary).
 */
interface TemplateObservation {
  containerKey: string;
  itemTemplate: string;
  concreteTo: string;
  itemText?: string;
  /** The container's stripped resource id (`list`), for the summary line. */
  containerId?: string;
}

/** Phase E: counts of what the last `flush()` pruned, for the harness record. */
interface PruneStats {
  evictedNodes: number;
  evictedEdges: number;
  decayedEdges: number;
  danglingEdges: number;
  pinnedNodes: number;
  volatileNodes: number;
}

/** Fields a caller supplies when recording a screen it just observed. */
interface UpsertNodeInput {
  /** Node identity — the device `H_id` (phase D §1). */
  hash: string;
  /** Structural hash `H` most recently observed for this identity (diagnostic). */
  structuralHash?: string;
  /** Rendered compact describe at observation time. */
  compact?: string;
  /** State hash `H_text` the compact was rendered against. */
  stateHash?: string;
  /** Device AX version clock the compact / stateHash were captured at. */
  version?: number;
  /** resource-id / text index → bounds + flags. */
  index?: ScreenNode["index"];
  /** Resource-id multiset for stable re-localization (C.4 work item C). */
  resourceIds?: string[];
  label?: string;
  thumbnailPath?: string;
  /** Force redaction (a `secretsUsed` outcome preceded this observation). */
  secret?: boolean;
  /** Phase E (design D1): this is a synthetic template node (no `stateHash`). */
  template?: boolean;
  /** Phase E: distinct concrete destinations folded onto a template node. */
  instances?: number;
}

function sanitizeSegment(segment: string): string {
  // Package names and version codes are filesystem-safe already, but guard
  // against a stray separator smuggling the path out of the graph dir.
  const cleaned = segment.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned === "" ? "unknown" : cleaned;
}

/** Whether a node must be persisted without its `compact` text. */
function nodeHoldsSecret(node: ScreenNode): boolean {
  if (node.redacted) return true;
  for (const entry of Object.values(node.index)) {
    if ((entry.flags & FLAG_PASSWORD) !== 0) return true;
  }
  return false;
}

export class ScreenGraphStore {
  readonly packageName: string;
  readonly versionCode: string;
  private readonly baseDir: string;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly maxNodes: number;
  private readonly maxEdges: number;
  private readonly maxBytes: number;
  private readonly boundsEnabled: boolean;

  private nodesMap: Map<string, ScreenNode> = new Map();
  private edgesMap: Map<string, Edge> = new Map();

  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWrite = false;

  /** Phase E: what the most recent `flush()` pruned (harness record). */
  private lastPrune: PruneStats = {
    evictedNodes: 0,
    evictedEdges: 0,
    decayedEdges: 0,
    danglingEdges: 0,
    pinnedNodes: 0,
    volatileNodes: 0,
  };

  constructor(options: ScreenGraphStoreOptions) {
    this.packageName = options.packageName;
    this.versionCode = options.versionCode;
    this.baseDir = options.baseDir ?? path.join(argentHomeDir(), "screen-graph");
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.now = options.now ?? Date.now;
    this.maxNodes = options.bounds?.maxNodes ?? DEFAULT_MAX_NODES;
    this.maxEdges = options.bounds?.maxEdges ?? DEFAULT_MAX_EDGES;
    this.maxBytes = options.bounds?.maxBytes ?? DEFAULT_MAX_BYTES;
    this.boundsEnabled = options.enforceBounds ?? false;
  }

  /** Absolute path of the persisted document for this store. */
  filePath(): string {
    return path.join(
      this.baseDir,
      sanitizeSegment(this.packageName),
      `${sanitizeSegment(this.versionCode)}.json`
    );
  }

  // ---- reads --------------------------------------------------------------

  hasNode(hash: string): boolean {
    return this.nodesMap.has(hash);
  }

  getNode(hash: string): ScreenNode | undefined {
    return this.nodesMap.get(hash);
  }

  get nodes(): Record<string, ScreenNode> {
    return Object.fromEntries(this.nodesMap);
  }

  get edges(): Edge[] {
    return [...this.edgesMap.values()];
  }

  /** Outgoing edges from a screen, most-observed first. */
  outgoingEdges(hash: string): Edge[] {
    return this.edges.filter((e) => e.from === hash).sort((a, b) => b.count - a.count);
  }

  /**
   * Phase D.2 HIGH-1 invariant: groups of ≥2 distinct node hashes whose
   * `compact` + `resourceIds` + `stateHash` are byte-identical. Two such nodes are
   * one screen recorded under two H_id — the transient-node bug a premature
   * after-fingerprint minted (run 33958064084 held two "Network & internet:
   * Internet" nodes). A healthy store returns `[]`. Nodes with no rendered
   * content (empty compact AND no stateHash) are ignored — they carry no evidence
   * of being the same screen.
   */
  duplicateScreens(): string[][] {
    const groups = new Map<string, string[]>();
    for (const [hash, n] of this.nodesMap) {
      // Phase E: template nodes are synthetic and keyed by construction
      // (`templateNodeHash`), not by drift — two distinct containers may legibly
      // share an exemplar rendering, so they are never a "duplicate screen".
      if (n.template) continue;
      const compact = n.compact ?? "";
      const stateHash = n.stateHash ?? "";
      if (compact === "" && stateHash === "") continue;
      const key = `${compact} ${(n.resourceIds ?? []).join(",")} ${stateHash}`;
      const arr = groups.get(key);
      if (arr) arr.push(hash);
      else groups.set(key, [hash]);
    }
    return [...groups.values()].filter((g) => g.length > 1);
  }

  /**
   * Phase D.3 (review D2-M2) edge invariant: one `(from H_id, action signature)`
   * must have exactly one destination. A second `to` for the same origin+action
   * is a recording error — a navigating tap that failed and minted a competing
   * root→root self-edge. Returns groups `{ key, tos }` with >1 distinct `to`; a
   * healthy store returns `[]`.
   */
  duplicateEdgeTargets(): Array<{ key: string; tos: string[] }> {
    const groups = new Map<string, Set<string>>();
    for (const e of this.edgesMap.values()) {
      const key = `${e.from} ${actionSignature(e.action)}`;
      const set = groups.get(key) ?? new Set<string>();
      set.add(e.to);
      groups.set(key, set);
    }
    const out: Array<{ key: string; tos: string[] }> = [];
    for (const [key, tos] of groups) if (tos.size > 1) out.push({ key, tos: [...tos] });
    return out;
  }

  /**
   * Phase E invariant G-I4: every `edge.from` / `edge.to` must exist in `nodes`.
   * Eviction (R2) creates this failure mode by removing a node; returns the
   * dangling edge keys (empty when clean).
   */
  danglingEdges(): string[] {
    const out: string[] = [];
    for (const [key, e] of this.edgesMap) {
      if (!this.nodesMap.has(e.from) || !this.nodesMap.has(e.to)) out.push(key);
    }
    return out;
  }

  /**
   * Phase E invariant G-I5: every `template: true` node must have no `stateHash`,
   * and every template edge must point at exactly one destination (the latter is
   * a specialization of `duplicateEdgeTargets`). Returns the violations.
   */
  templateHygiene(): string[] {
    const out: string[] = [];
    for (const [hash, n] of this.nodesMap) {
      if (n.template && n.stateHash !== undefined) {
        out.push(`template node ${hash} carries a stateHash`);
      }
    }
    for (const e of this.edgesMap.values()) {
      if (e.template && !this.nodesMap.get(e.to)?.template) {
        out.push(`template edge ${e.from}->${e.to} does not point at a template node`);
      }
    }
    return out;
  }

  /** Phase E invariant G-I3 inputs: persisted size of the store, in bytes. */
  byteSize(): number {
    return Buffer.byteLength(JSON.stringify(this.serialize(), null, 2) + "\n", "utf8");
  }

  /** Phase E: what the most recent `flush()` (or `enforceBounds`) pruned. */
  pruneStats(): PruneStats {
    return { ...this.lastPrune };
  }

  /** Count of nodes currently flagged volatile (design D2 R4). */
  volatileNodeCount(): number {
    let n = 0;
    for (const node of this.nodesMap.values()) if (isNodeVolatile(node)) n += 1;
    return n;
  }

  // ---- writes -------------------------------------------------------------

  /**
   * Insert or merge a screen. A new node gets `firstSeen = lastSeen = now`,
   * `visits = 1`; an existing one bumps `lastSeen` / `visits` and, when the
   * caller passes a fresh rendering, refreshes `compact` / `stateHash` /
   * `index`. A secret (`input.secret` or a `FLAG_PASSWORD` index entry) drops
   * `compact` and marks `redacted`.
   */
  upsertNode(input: UpsertNodeInput): ScreenNode {
    const t = this.now();
    const existing = this.nodesMap.get(input.hash);
    const node: ScreenNode = existing
      ? { ...existing, lastSeen: t, visits: existing.visits + 1 }
      : {
          hash: input.hash,
          firstSeen: t,
          lastSeen: t,
          visits: 1,
          compact: "",
          index: {},
        };

    // Phase E (design D2 R4): maintain the volatility tracker BEFORE the incoming
    // stateHash overwrites the stored one. A fresh sample bumps `samples`; a
    // stateHash that differs from the last one bumps `distinctStates`. Template
    // nodes never carry a stateHash, so they never accrue volatility.
    if (this.boundsEnabled && !input.template && input.stateHash !== undefined) {
      const prev = existing?.stateHash;
      const v = node.volatility ?? { samples: 0, distinctStates: 0 };
      node.volatility = {
        samples: v.samples + 1,
        distinctStates: v.distinctStates + (prev !== undefined && prev !== input.stateHash ? 1 : 0),
      };
    }

    if (input.structuralHash !== undefined) node.structuralHash = input.structuralHash;
    if (input.compact !== undefined) node.compact = input.compact;
    if (input.stateHash !== undefined) node.stateHash = input.stateHash;
    if (input.version !== undefined) node.version = input.version;
    if (input.index !== undefined) node.index = input.index;
    if (input.resourceIds !== undefined) node.resourceIds = input.resourceIds;
    if (input.label !== undefined) node.label = input.label;
    if (input.thumbnailPath !== undefined) node.thumbnailPath = input.thumbnailPath;
    if (input.secret) node.redacted = true;
    if (input.instances !== undefined) node.instances = input.instances;

    // Phase E (design D1): a template node is synthetic — it must NEVER hold a
    // stateHash, or `resolveCompactTier` could serve one item's cached text for
    // another (G-I5). `compact` holds the exemplar rendering.
    if (input.template) {
      node.template = true;
      delete node.stateHash;
      delete node.volatility;
    }

    if (nodeHoldsSecret(node)) {
      node.redacted = true;
      node.compact = "";
      delete node.stateHash;
    }

    this.nodesMap.set(node.hash, node);
    this.markDirty();
    return node;
  }

  /** Bump a known node's visit count / recency without re-rendering it. */
  recordVisit(hash: string): void {
    const node = this.nodesMap.get(hash);
    if (!node) return;
    node.lastSeen = this.now();
    node.visits += 1;
    this.markDirty();
  }

  /**
   * Record a transition `from --action--> to` (design §2.2). `success` (default
   * true) means the action landed on `to`; the plan weight reads the ratio.
   */
  observe(
    from: string,
    action: CanonicalAction,
    to: string,
    opts: { success?: boolean; selector?: EdgeSelector; template?: TemplateObservation } = {}
  ): Edge {
    const success = opts.success ?? true;
    const key = `${from} ${actionSignature(action)} ${to}`;
    const t = this.now();
    const existing = this.edgesMap.get(key);
    // Keep the freshest non-empty selector (phase D §2) — a later observation of
    // the same transition refreshes the acted element's identity.
    const selector = opts.selector ?? existing?.selector;
    const edge: Edge = existing
      ? {
          ...existing,
          count: existing.count + 1,
          successes: existing.successes + (success ? 1 : 0),
          lastSeen: t,
          ...(selector ? { selector } : {}),
        }
      : {
          from,
          action,
          to,
          count: 1,
          successes: success ? 1 : 0,
          lastSeen: t,
          ...(selector ? { selector } : {}),
        };
    // Phase E (design D1): fold the template accounting — distinct concrete
    // destinations (`instances`) and a small ring of recent item labels — onto the
    // ONE template edge. The edge's `to` is the template node, so it stays
    // single-destination (`duplicateEdgeTargets` green).
    if (opts.template) {
      const t0 = existing?.template;
      const targets = [...(t0?.targets ?? [])];
      if (!targets.includes(opts.template.concreteTo)) {
        targets.push(opts.template.concreteTo);
        if (targets.length > MAX_TEMPLATE_TARGETS) targets.shift();
      }
      const lastItemTexts = [...(t0?.lastItemTexts ?? [])];
      if (opts.template.itemText) {
        lastItemTexts.push(opts.template.itemText);
        while (lastItemTexts.length > MAX_TEMPLATE_ITEM_TEXTS) lastItemTexts.shift();
      }
      edge.template = {
        containerKey: opts.template.containerKey,
        itemTemplate: opts.template.itemTemplate,
        instances: targets.length,
        ...(opts.template.containerId ? { containerId: opts.template.containerId } : {}),
        targets,
        ...(lastItemTexts.length > 0 ? { lastItemTexts } : {}),
      };
    }
    this.edgesMap.set(key, edge);
    this.markDirty();
    return edge;
  }

  // ---- persistence --------------------------------------------------------

  private markDirty(): void {
    this.pendingWrite = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, this.debounceMs);
    // Don't keep the process alive purely for a pending graph write.
    this.writeTimer.unref?.();
  }

  /** Write now if anything is pending, cancelling the debounce timer. */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (!this.pendingWrite) return;
    this.pendingWrite = false;
    if (this.boundsEnabled) this.enforceBounds();
    await this.persistNow();
  }

  /** Whether a node is pinned against LRU eviction (design D2 R2). */
  private isPinned(hash: string, pinnedByEdge: Set<string>): boolean {
    const node = this.nodesMap.get(hash);
    if (!node) return false;
    if (node.template) return true;
    if (node.visits >= PIN_VISITS) return true;
    return pinnedByEdge.has(hash);
  }

  /** Remove a node and every edge incident to it (keeps referential integrity). */
  private evictNode(hash: string): number {
    this.nodesMap.delete(hash);
    let removed = 0;
    for (const [key, e] of this.edgesMap) {
      if (e.from === hash || e.to === hash) {
        this.edgesMap.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Phase E (design D2 R1/R2/R3): bound the store on flush — edge success-ratio /
   * staleness decay (R3), then LRU node eviction with pins under the node/byte
   * caps (R1/R2, evicting incident edges), then the edge cap, then a
   * referential-integrity sweep (G-I4). Amortized: it does the O(n) scans only
   * when actually over a cap, so a healthy store pays a couple of cheap checks.
   * Public so the harness can force it between sessions and read `pruneStats`.
   */
  enforceBounds(): void {
    const now = this.now();
    let decayedEdges = 0;
    let evictedNodes = 0;
    let evictedEdges = 0;

    // R3 — edge decay: a chronically-failing edge (ratio < 0.2 with enough
    // samples) or a 30-day-stale one is dropped. Aligns with `edgeWeight`.
    for (const [key, e] of this.edgesMap) {
      const ratio = e.count > 0 ? e.successes / e.count : 1;
      const failing = e.count >= EDGE_DECAY_MIN_COUNT && ratio < EDGE_DECAY_MIN_RATIO;
      const stale = now - e.lastSeen > EDGE_STALE_MS;
      if (failing || stale) {
        this.edgesMap.delete(key);
        decayedEdges += 1;
      }
    }

    // Recompute the by-edge pin set (endpoint of a successes ≥ 3 edge) once.
    const pinnedByEdge = new Set<string>();
    for (const e of this.edgesMap.values()) {
      if (e.successes >= PIN_EDGE_SUCCESSES) {
        pinnedByEdge.add(e.from);
        pinnedByEdge.add(e.to);
      }
    }

    // R1/R2 — node cap + LRU: evict the least-recently-seen UNPINNED node until
    // under `maxNodes` (or nothing left to evict); each eviction takes its
    // incident edges.
    const evictLruUnpinned = (): boolean => {
      let victim: string | null = null;
      let oldest = Infinity;
      for (const [hash, node] of this.nodesMap) {
        if (this.isPinned(hash, pinnedByEdge)) continue;
        if (node.lastSeen < oldest) {
          oldest = node.lastSeen;
          victim = hash;
        }
      }
      if (victim === null) return false;
      evictedEdges += this.evictNode(victim);
      evictedNodes += 1;
      return true;
    };

    while (this.nodesMap.size > this.maxNodes) {
      if (!evictLruUnpinned()) break;
    }

    // R1 — edge cap: drop the weakest (highest-weight) edges until under
    // `maxEdges`; referential integrity is unaffected (endpoints stay).
    if (this.edgesMap.size > this.maxEdges) {
      const ranked = [...this.edgesMap.entries()].sort(
        (a, b) => edgeWeight(b[1], now) - edgeWeight(a[1], now)
      );
      for (const [key] of ranked) {
        if (this.edgesMap.size <= this.maxEdges) break;
        this.edgesMap.delete(key);
        evictedEdges += 1;
      }
    }

    // R1 — byte cap: while over `maxBytes` and an unpinned node remains, evict LRU.
    let guard = 0;
    while (this.byteSize() > this.maxBytes && guard < this.nodesMap.size + 1) {
      if (!evictLruUnpinned()) break;
      guard += 1;
    }

    // G-I4 — referential integrity: drop any edge orphaned by eviction.
    for (const key of this.danglingEdges()) {
      this.edgesMap.delete(key);
      evictedEdges += 1;
    }

    let pinnedNodes = 0;
    for (const hash of this.nodesMap.keys()) {
      if (this.isPinned(hash, pinnedByEdge)) pinnedNodes += 1;
    }
    this.lastPrune = {
      evictedNodes,
      evictedEdges,
      decayedEdges,
      danglingEdges: 0,
      pinnedNodes,
      volatileNodes: this.volatileNodeCount(),
    };
  }

  private serialize(): ScreenGraphData {
    const nodes: Record<string, ScreenNode> = {};
    for (const [hash, node] of this.nodesMap) {
      if (nodeHoldsSecret(node)) {
        nodes[hash] = { ...node, compact: "", redacted: true };
        delete nodes[hash]!.stateHash;
      } else if (this.boundsEnabled && isNodeVolatile(node)) {
        // Phase E (design D2 R4a): a volatile node's `compact` is the bulk of its
        // bytes and is stale by the next visit — drop it on persist (the summary
        // still flags `volatile`, and the compact tier cannot serve a moved
        // stateHash anyway). Keeps a churny node to ~2-3 KB.
        nodes[hash] = { ...node, compact: "" };
      } else {
        nodes[hash] = node;
      }
    }
    return {
      version: SCHEMA_VERSION,
      packageName: this.packageName,
      versionCode: this.versionCode,
      nodes,
      edges: this.edges,
    };
  }

  private async persistNow(): Promise<void> {
    const file = this.filePath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    const payload = JSON.stringify(this.serialize(), null, 2) + "\n";
    await fsp.writeFile(tmp, payload, "utf8");
    await fsp.rename(tmp, file);
  }

  /** Drop the debounce timer without flushing (test / shutdown teardown). */
  dispose(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
  }

  // ---- loading ------------------------------------------------------------

  /** Hydrate this store from disk, if a document exists. */
  private hydrate(data: ScreenGraphData): void {
    this.nodesMap = new Map(Object.entries(data.nodes ?? {}));
    this.edgesMap = new Map();
    for (const edge of data.edges ?? []) {
      const key = `${edge.from} ${actionSignature(edge.action)} ${edge.to}`;
      this.edgesMap.set(key, edge);
    }
  }

  /**
   * Load the persisted graph for `(packageName, versionCode)`, or an empty
   * store when none exists / the file is unreadable. Never throws on a missing
   * or corrupt document — a warm run degrades to a cold one.
   */
  static async load(options: ScreenGraphStoreOptions): Promise<ScreenGraphStore> {
    const store = new ScreenGraphStore(options);
    try {
      const raw = await fsp.readFile(store.filePath(), "utf8");
      const parsed = JSON.parse(raw) as ScreenGraphData;
      if (parsed && parsed.version === SCHEMA_VERSION) store.hydrate(parsed);
    } catch {
      /* missing or corrupt — start empty */
    }
    return store;
  }

  /** Synchronous load — for call sites that cannot await. */
  static loadSync(options: ScreenGraphStoreOptions): ScreenGraphStore {
    const store = new ScreenGraphStore(options);
    try {
      const raw = fs.readFileSync(store.filePath(), "utf8");
      const parsed = JSON.parse(raw) as ScreenGraphData;
      if (parsed && parsed.version === SCHEMA_VERSION) store.hydrate(parsed);
    } catch {
      /* missing or corrupt — start empty */
    }
    return store;
  }
}
