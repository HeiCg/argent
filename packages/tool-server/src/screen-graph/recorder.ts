/**
 * Screen-graph Phase B observation recorder (ticket B2, design §2.2): fold an
 * action outcome into the store. Records the edge, then either bumps the visit
 * count of a known target screen or — when the target is unknown — inserts a new
 * node from a freshly fetched compact tree. Pure and injectable: the live open
 * path supplies `fetchScreen`; tests supply a stub.
 */
import type { ScreenGraphStore } from "./store";
import type { CanonicalAction, EdgeSelector, ScreenNode } from "./types";
import { EMPTY_TREE_HASH } from "../utils/screen-hash";

/** The screen payload used to insert an unknown target node. */
export interface FetchedScreen {
  compact: string;
  stateHash: string;
  /** Structural hash `H` observed for this identity (phase D §1, diagnostic). */
  structuralHash?: string;
  /** Device AX version clock the screen was captured at (Phase B leftover B1). */
  version?: number;
  index: ScreenNode["index"];
  /** Resource-id multiset for stable re-localization (C.4 work item C). */
  resourceIds?: string[];
  label?: string;
  /** A secret was on screen — the store will redact the compact text. */
  secret?: boolean;
}

interface ObserveContext {
  store: ScreenGraphStore;
  action: CanonicalAction;
  /** `hash` is the node IDENTITY (`H_id`, phase D §1). */
  before: { hash: string };
  after: { hash: string; stateHash: string; structuralHash?: string };
  /** The acted element's selector, recorded on the edge (phase D §2). */
  selector?: EdgeSelector;
  /** The action landed on `after` (default true). */
  success?: boolean;
  /** A `secretsUsed` outcome preceded this observation (redact the node). */
  secret?: boolean;
  /** Fetch the target screen; called only when `after.hash` is unknown. */
  fetchScreen?: () => Promise<FetchedScreen>;
}

/**
 * Record one observed transition. Order: edge first (so the graph gains the
 * transition even if the node fetch fails), then the target node.
 */
export async function recordObservation(ctx: ObserveContext): Promise<void> {
  const { store, action, before, after } = ctx;
  // Phase 3m.1 (3M-H1): the store REFUSES to mint a node — or an edge into one —
  // from an empty tree. An `after` whose structural or state hash is the
  // EMPTY_TREE_HASH sentinel is a transient mid-transition frame (0 kept nodes),
  // never a real destination; recording it is what produced the run-34827025184
  // multi-destination-edge / empty-node store-invariant failure. The device now
  // omits the hash for an empty forest (versionCode 26+), and the open wiring
  // skips + counts these before they reach here; this is the last-line guard for
  // any other caller and for replayed pre-26 artifacts.
  if (after.structuralHash === EMPTY_TREE_HASH || after.stateHash === EMPTY_TREE_HASH) {
    return;
  }
  store.observe(before.hash, action, after.hash, {
    success: ctx.success ?? true,
    ...(ctx.selector ? { selector: ctx.selector } : {}),
  });

  if (ctx.secret) {
    // A secret was on screen — mark the target redacted whether or not it's new.
    store.upsertNode({ hash: after.hash, secret: true });
    return;
  }

  if (store.hasNode(after.hash)) {
    // Bump the visit once; when a fresh structural hash is known, refresh it in
    // the same upsert (upsertNode on an existing node bumps visits like recordVisit).
    if (after.structuralHash !== undefined) {
      store.upsertNode({ hash: after.hash, structuralHash: after.structuralHash });
    } else {
      store.recordVisit(after.hash);
    }
    return;
  }

  if (ctx.fetchScreen) {
    const screen = await ctx.fetchScreen();
    store.upsertNode({
      hash: after.hash,
      ...(after.structuralHash !== undefined
        ? { structuralHash: after.structuralHash }
        : screen.structuralHash !== undefined
          ? { structuralHash: screen.structuralHash }
          : {}),
      compact: screen.compact,
      stateHash: screen.stateHash,
      ...(screen.version !== undefined ? { version: screen.version } : {}),
      index: screen.index,
      ...(screen.resourceIds !== undefined ? { resourceIds: screen.resourceIds } : {}),
      ...(screen.label !== undefined ? { label: screen.label } : {}),
      ...(screen.secret ? { secret: true } : {}),
    });
  }
}
