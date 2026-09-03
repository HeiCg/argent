/**
 * Screen-graph Phase B observation recorder (ticket B2, design §2.2): fold an
 * action outcome into the store. Records the edge, then either bumps the visit
 * count of a known target screen or — when the target is unknown — inserts a new
 * node from a freshly fetched compact tree. Pure and injectable: the live open
 * path supplies `fetchScreen`; tests supply a stub.
 */
import type { ScreenGraphStore } from "./store";
import type { CanonicalAction, ScreenNode } from "./types";

/** The screen payload used to insert an unknown target node. */
export interface FetchedScreen {
  compact: string;
  stateHash: string;
  /** Device AX version clock the screen was captured at (Phase B leftover B1). */
  version?: number;
  index: ScreenNode["index"];
  /** Resource-id multiset for stable re-localization (C.4 work item C). */
  resourceIds?: string[];
  label?: string;
  /** A secret was on screen — the store will redact the compact text. */
  secret?: boolean;
}

export interface ObserveContext {
  store: ScreenGraphStore;
  action: CanonicalAction;
  before: { hash: string };
  after: { hash: string; stateHash: string };
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
  store.observe(before.hash, action, after.hash, { success: ctx.success ?? true });

  if (ctx.secret) {
    // A secret was on screen — mark the target redacted whether or not it's new.
    store.upsertNode({ hash: after.hash, secret: true });
    return;
  }

  if (store.hasNode(after.hash)) {
    store.recordVisit(after.hash);
    return;
  }

  if (ctx.fetchScreen) {
    const screen = await ctx.fetchScreen();
    store.upsertNode({
      hash: after.hash,
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
