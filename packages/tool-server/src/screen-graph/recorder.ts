/**
 * Screen-graph Phase B observation recorder (ticket B2, design §2.2): fold an
 * action outcome into the store. Mints the source screen when it is not a node
 * yet (the launch screen, see `ensureSourceNode`), records the edge, then either bumps the visit
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

/**
 * What is known of the SOURCE screen of an action whose origin is not a node yet
 * (the launch screen an agent acts on without a `describe` first). Every field is
 * optional: a source with no tree is minted from its identity alone.
 */
export type SourceScreen = Partial<Omit<FetchedScreen, "secret">>;

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
  /**
   * Build the source screen; called only when `before.hash` is not a node yet.
   * Without it (or when it fails) the source is minted from its identity alone.
   */
  fetchBeforeScreen?: () => Promise<SourceScreen>;
}

/**
 * Make `hash` a node before an edge leaves it. Only `describe` used to mint the
 * current screen, so the first action from a screen never described (the launch
 * screen) left an edge whose origin was no node, and the store's
 * referential-integrity sweep dropped it on the next flush: the first hop was
 * lost and navigate-to from that screen found no path. A node that already
 * exists is left untouched (no duplicate, no extra visit).
 */
export function ensureSourceNode(
  store: ScreenGraphStore,
  hash: string,
  screen: SourceScreen = {}
): void {
  if (store.hasNode(hash)) return;
  store.upsertNode({
    hash,
    ...(screen.structuralHash !== undefined ? { structuralHash: screen.structuralHash } : {}),
    ...(screen.compact !== undefined ? { compact: screen.compact } : {}),
    ...(screen.stateHash !== undefined ? { stateHash: screen.stateHash } : {}),
    ...(screen.version !== undefined ? { version: screen.version } : {}),
    ...(screen.index !== undefined ? { index: screen.index } : {}),
    ...(screen.resourceIds !== undefined ? { resourceIds: screen.resourceIds } : {}),
    ...(screen.label !== undefined ? { label: screen.label } : {}),
  });
}

/**
 * Record one observed transition. Order: source node when unknown, edge (so the
 * graph gains the transition even if the target fetch fails), then the target.
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
  // The source must be a node or the edge is dropped as dangling on flush. A
  // self-edge whose target branch below mints the node (fetch or redaction)
  // skips this, so the screen is inserted once with one visit. A secret
  // observation never reads the before screen: the source is minted bare.
  const targetMintsSource =
    before.hash === after.hash && (ctx.secret || ctx.fetchScreen !== undefined);
  if (!store.hasNode(before.hash) && !targetMintsSource) {
    let screen: SourceScreen | undefined;
    if (!ctx.secret && ctx.fetchBeforeScreen) {
      try {
        screen = await ctx.fetchBeforeScreen();
      } catch {
        /* no usable before screen — mint the source from its identity */
      }
    }
    ensureSourceNode(store, before.hash, screen);
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
