/**
 * Screen-graph Phase E churn experiment (E-1, design D3).
 *
 * Drives the synthetic `com.argent.churnapp` feed on the CI emulator and records
 * every item tap into TWO stores from the SAME device interaction:
 *  - ON  arm: `ARGENT_SG_TEMPLATES`-style bounded store with template edges;
 *  - OFF arm: today's unbounded store (the control), kept OUTSIDE the gated graph
 *    dir so its (expected) `duplicateEdgeTargets` break can never kill the job
 *    (per-arm scoping BEFORE the run — the hard constraint).
 *
 * It measures store growth per session (nodes/edges/bytes), volatility, template
 * instances, describe summary tokens, container misattribution, and the
 * reliability of the template step's scroll-and-exact-text search, then grades
 * E1-G1..E1-G6.
 *
 * Review E-1 2026-10-07 (E-1.1): the search runs in TWO arms on the same targets
 * and sessions — ON (routed through the store's template edge, scoped to the
 * template's container) and OFF-nograph (the same search with no store and no
 * template) — so G3 says what the template adds over a graph-free search
 * (finding 2). Arrival is the requested item's detail headline, not any page of
 * the detail layout (finding 3). Each attempt records wall time and per-swipe
 * timing (finding 4). Presence is OBSERVED by a full sweep per session, and 4
 * deliberately absent targets measure the give-up cost (finding 5). E1-G5 is
 * graded against its pre-registered bar (finding 1).
 * The heavy lifting is host-side and shared with production (`resolveTemplate`,
 * `store.observe`, `executeTemplateStep`), so the ON arm is what the wiring would
 * persist. Best-effort: every device call is guarded so a flake degrades a
 * datum, never crashes the matrix that ran before it.
 */
import { ScreenGraphStore } from "../store";
import { resolveTemplate, stripId, resolveContainer } from "../template";
import type { TemplateElement } from "../template";
import { buildScreenPayload } from "../../utils/screen-graph-open-wiring";
import { buildSummary, renderSummary } from "../describe-tiers";
import { multisetJaccard } from "../plan";
import { nonScrollRids } from "../template";
import {
  executeTemplateStep,
  planTemplateRoute,
  sweepContainer,
  type LiveElement,
  type TemplateStepOptions,
} from "../../tools/navigate-to";
import { countBoth, pct } from "./tokens";
import type { OpenDeviceServerApi } from "../../blueprints/android-open-server";
import type { OpenServerElement } from "../../tools/describe/platforms/android/open-server-tree";

const PKG = "com.argent.churnapp";
const VERSION_CODE = "1";
const ITEMS = 50;
const SESSIONS = 5;
const TAPS_PER_SESSION = 8;
const SCROLLS_PER_SESSION = 10;
const NAV_TARGETS = [32, 33, 34, 35, 36, 37, 38, 39];
const BASE_SEED = 1000;
/** Sublinear-growth gate: ON arm may add at most this many nodes/edges per session. */
const MAX_NODE_DELTA = 2;
const MAX_EDGE_DELTA = 4;
const MAX_ON_BYTES = 64 * 1024;
const NAV_PASS_MIN = 38;
const NAV_PASS_OF = 40;
/**
 * Review E-1 finding 5: rows the feed never has (it renders Story 0..49). One per
 * churn100 session 1..4, run in both arms, to measure the give-up cost (`swept`,
 * `wallMs`); excluded from the G3 denominator and reported separately.
 */
const ABSENT_TARGETS = [60, 61, 62, 63];
/** The list container's stripped resource id (the presence sweep's container). */
const LIST_ID = "list";
/** Arrival layout match: multiset Jaccard of non-scroll rids vs the detail reference. */
const ARRIVAL_JACCARD = 0.9;
/**
 * E1-G5's pre-registered bar (`2026-09-15-screen-graph-phase-e1.md`, gate table):
 * the Settings store shape within the published variance (11/10 D.4.1, 11/11 D.4,
 * 10/9 runs 34870686468 and 34888577404) and the o200k tokens/step p50 inside the
 * published run-to-run floor (O1 138-179, O4 20-22,
 * `2026-09-13-screen-graph-phase-d4-results-ci.md:294-299`).
 */
const G5_NODES: [number, number] = [10, 11];
const G5_EDGES: [number, number] = [9, 11];
const G5_O1: [number, number] = [138, 179];
const G5_O4: [number, number] = [20, 22];
/**
 * Feed readiness before a nav attempt. Run 37572199458's logcat shows
 * `Displayed .../.FeedActivity: +1s464ms` after a force-stop relaunch, longer
 * than the fixed 1.2 s sleep, so an attempt could start on the splash window.
 */
const FEED_READY_TIMEOUT_MS = 6000;
const FEED_READY_POLL_MS = 250;

type Condition = "churn100" | "churn0";

/** Search arm: through the template edge (ON) or graph-free (OFF-nograph). */
type Arm = "on" | "nograph";

interface StateSnapshot {
  tree: OpenServerElement[];
  idHash: string;
  stateHash: string;
  hash: string;
  version?: number;
  w: number;
  h: number;
}

interface SessionMetric {
  condition: Condition;
  session: number;
  onNodes: number;
  onEdges: number;
  onBytes: number;
  onVolatile: number;
  onTemplateEdges: number;
  onTemplateInstances: number;
  offNodes: number;
  offEdges: number;
  offBytes: number;
  offDupEdgeTargets: number;
  summaryTokensOn: number;
  summaryTokensOff: number;
}

/** One template-step search attempt (the E1-G3 denominator, per arm). */
interface NavAttempt {
  arm: Arm;
  session: number;
  target: number;
  /** A row the feed never has (ABSENT_TARGETS): a give-up probe, outside G3. */
  deliberatelyAbsent: boolean;
  /**
   * `Story <target>` was OBSERVED in this session's presence sweep (review E-1
   * finding 5), not inferred from the app model. False for the absent probes.
   */
  targetPresent: boolean;
  /** Container scrolls `executeTemplateStep` spent; -1 when it never ran. */
  scrolls: number;
  tapped: boolean;
  /** The landed screen shows exactly `Headline <seed>-<target>` (the requested item's detail). */
  headlineOk: boolean;
  /** The landed screen's non-scroll rid multiset matches the detail layout (Jaccard >= 0.9). */
  layoutOk: boolean;
  /** tapped && headlineOk && layoutOk. */
  arrived: boolean;
  /** ms the feed took to show `Story 0` after the relaunch; -1 when it never did. */
  feedReadyMs: number;
  /** Wall time of the search step (search + tap + landed read), ms; -1 when it never ran. */
  wallMs: number;
  /** Wall time of the whole attempt incl. the relaunch and the arrival read, ms. */
  attemptMs: number;
  /** Host wall time of each swipe RPC, ms. */
  swipeMs: number[];
  /** Device-reported DOWN-to-UP span of each swipe (APK >= 0.1.24), ms. */
  deliveredMs: number[];
  /** `executeTemplateStep` telemetry: end-of-list turnarounds, gapped scrolls, clean sweep. */
  reversals?: number;
  gaps?: number;
  swept?: boolean;
  reason?: string;
}

/** One session's presence sweep of the list (review E-1 finding 5). */
interface PresenceSweep {
  session: number;
  seed: number;
  /** Story indices observed in the list during the sweep, ascending. */
  observed: number[];
  scrolls: number;
  gaps: number;
  complete: boolean;
  wallMs: number;
  reason?: string;
}

/** The matrix numbers E1-G5 is graded on (read by the bench script after the matrix). */
interface G5Input {
  settingsNodes?: number;
  settingsEdges?: number;
  o1TokP50?: number;
  o4TokP50?: number;
}

interface Gate {
  /** What the gate measures (the output name). */
  name: string;
  pass: boolean | null;
  detail: string;
  /** Graded with the same bar for comparison, but never fails the job. */
  comparator?: boolean;
}

interface ChurnDeps {
  server: OpenDeviceServerApi;
  /** Launch the feed with a seed (adb `am start ... --ei seed <n>`). */
  launchFeed: (seed: number) => void;
  /** Graph dir for the ON store (gated + artifact-copied). */
  graphBaseDir: string;
  /** A dir OUTSIDE the gated graph dir for the OFF store. */
  offBaseDir: string;
  /** E1-G5 inputs from the D.4.1 matrix that ran before the churn experiment. */
  g5?: G5Input;
  log: (m: string) => void;
}

interface ChurnResult {
  metrics: SessionMetric[];
  gates: Record<string, Gate>;
  /** ON arm, every non-probe attempt (raw). */
  navSuccess: number;
  navTotal: number;
  /** E1-G3 (ON) over attempts whose target was observed present (the gated number). */
  navSuccessPresent: number;
  navTotalPresent: number;
  /** The OFF-nograph arm, same counts. */
  nograph: { ok: number; total: number; presentOk: number; presentTotal: number };
  navAttempts: NavAttempt[];
  presenceSweeps: PresenceSweep[];
  misattributionRows: number;
  misattributionRowTotal: number;
  carouselAttributed: number;
  carouselTotal: number;
  markdown: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();

async function snapshot(server: OpenDeviceServerApi): Promise<StateSnapshot | null> {
  try {
    const s = await server.getState({
      includeScreenshot: false,
      fingerprints: true,
      waitTimeoutMs: 2000,
    });
    return {
      tree: s.tree,
      idHash: s.idHash ?? s.hash ?? "",
      stateHash: s.stateHash ?? "",
      hash: s.hash ?? "",
      version: s.version,
      w: s.info.screenWidth || 1080,
      h: s.info.screenHeight || 2400,
    };
  } catch {
    return null;
  }
}

/** Upsert the feed node into a store from a snapshot (ON tracks volatility). */
function upsertFeed(store: ScreenGraphStore, snap: StateSnapshot): void {
  const p = buildScreenPayload(snap.tree, snap.w, snap.h, undefined, snap.stateHash, snap.version);
  store.upsertNode({
    hash: snap.idHash,
    structuralHash: snap.hash,
    compact: p.compact,
    stateHash: p.stateHash,
    ...(p.version !== undefined ? { version: p.version } : {}),
    index: p.index,
    ...(p.resourceIds !== undefined ? { resourceIds: p.resourceIds } : {}),
    ...(p.label !== undefined ? { label: p.label } : {}),
  });
}

/** Record one item tap into the ON (template) and OFF (per-item) stores. */
function recordTap(
  on: ScreenGraphStore,
  off: ScreenGraphStore,
  before: StateSnapshot,
  after: StateSnapshot,
  x: number,
  y: number,
  itemText: string
): void {
  // OFF (control): a per-item edge keyed on the STABLE story text; the churning
  // detail gives it a new destination each session — the duplicateEdgeTargets
  // break. A per-item destination node → linear node growth.
  off.observe(before.idHash, { kind: "tap", target: { text: itemText } }, after.idHash);
  const ap = buildScreenPayload(
    after.tree,
    after.w,
    after.h,
    undefined,
    after.stateHash,
    after.version
  );
  off.upsertNode({
    hash: after.idHash,
    structuralHash: after.hash,
    compact: ap.compact,
    stateHash: ap.stateHash,
    index: ap.index,
    ...(ap.resourceIds !== undefined ? { resourceIds: ap.resourceIds } : {}),
  });

  // ON (template): fold onto one template edge + one synthetic template node.
  const tpl = resolveTemplate(
    before.tree as unknown as TemplateElement[],
    x,
    y,
    before.idHash,
    after.tree as unknown as TemplateElement[],
    PKG
  );
  if (tpl) {
    const container = resolveContainer(before.tree as unknown as TemplateElement[], x, y);
    const containerId = container ? stripId(container.resourceId) || undefined : undefined;
    const edge = on.observe(
      before.idHash,
      { kind: "tap", template: { containerKey: tpl.containerKey, itemTemplate: tpl.itemTemplate } },
      tpl.templateNodeHash,
      {
        template: {
          containerKey: tpl.containerKey,
          itemTemplate: tpl.itemTemplate,
          concreteTo: after.idHash,
          itemText,
          ...(containerId ? { containerId } : {}),
        },
      }
    );
    on.upsertNode({
      hash: tpl.templateNodeHash,
      template: true,
      compact: ap.compact,
      index: ap.index,
      resourceIds: tpl.destinationResourceIds,
      instances: edge.template?.instances ?? 1,
      ...(ap.label !== undefined ? { label: `${ap.label}:*` } : {}),
    });
  } else {
    // The tap was not inside a container — record it plainly on the ON arm too.
    on.observe(before.idHash, { kind: "tap", target: { text: itemText } }, after.idHash);
    on.upsertNode({
      hash: after.idHash,
      structuralHash: after.hash,
      compact: ap.compact,
      stateHash: ap.stateHash,
      index: ap.index,
      ...(ap.resourceIds !== undefined ? { resourceIds: ap.resourceIds } : {}),
    });
  }
}

/** Query one node by exact text (contains + exact filter, like resolveTapPoint). */
async function findExact(
  server: OpenDeviceServerApi,
  text: string
): Promise<{ x: number; y: number } | null> {
  try {
    const q = await server.query(
      { text: { contains: text, caseInsensitive: true }, visible: true },
      { limit: 20 }
    );
    const want = norm(text);
    const exact = q.nodes.filter((n) => norm(n.text) === want || norm(n.cd) === want);
    if (exact.length !== 1) return null;
    const b = exact[0]!.bounds;
    return { x: Math.round((b.x1 + b.x2) / 2), y: Math.round((b.y1 + b.y2) / 2) };
  } catch {
    return null;
  }
}

/** The detail headline the churn app shows for row `i` at `seed` (`Items.rowSummary`). */
function headlineFor(seed: number, i: number): string {
  return `Headline ${seed}-${i}`;
}

/**
 * Arrival at the REQUESTED item (review E-1 finding 3): the landed tree shows the
 * item's exact detail headline AND its non-scroll rid multiset matches the detail
 * layout. The headline alone is not enough (the feed's row summary carries the
 * same text); the layout alone is not either (any item's detail matches it).
 */
export function arrivalCheck(
  tree: ReadonlyArray<{ text?: string }>,
  afterRids: readonly string[],
  headline: string,
  detailRids: readonly string[]
): { headlineOk: boolean; layoutOk: boolean; arrived: boolean } {
  const headlineOk = tree.some((el) => (el.text ?? "").trim() === headline);
  const layoutOk =
    detailRids.length > 0 && multisetJaccard(afterRids, detailRids) >= ARRIVAL_JACCARD;
  return { headlineOk, layoutOk, arrived: headlineOk && layoutOk };
}

/** p50 / max of a millisecond series (null when empty). */
export function summarizeMs(xs: readonly number[]): {
  n: number;
  p50: number | null;
  max: number | null;
} {
  if (xs.length === 0) return { n: 0, p50: null, max: null };
  const s = xs.slice().sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 50), max: s[s.length - 1]! };
}

/** Story indices among a sweep's labels. */
function storyIndices(labels: Iterable<string>): number[] {
  const out = new Set<number>();
  for (const l of labels) {
    const m = /^Story (\d+)$/.exec(l.trim());
    if (m) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/** Poll until the feed shows `Story 0` (the list is drawn); ms waited, or -1. */
async function waitForFeed(server: OpenDeviceServerApi): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < FEED_READY_TIMEOUT_MS) {
    if (await findExact(server, "Story 0")) return Date.now() - start;
    await sleep(FEED_READY_POLL_MS);
  }
  return -1;
}

async function swipeUp(server: OpenDeviceServerApi, snap: StateSnapshot): Promise<void> {
  const sx = Math.round(snap.w / 2);
  const sy = Math.round(snap.h * 0.72);
  const ey = Math.round(snap.h * 0.28);
  try {
    await server.swipeWithOutcome(sx, sy, sx, ey, 10);
  } catch {
    /* best-effort */
  }
}

async function back(server: OpenDeviceServerApi): Promise<void> {
  try {
    await server.keyWithOutcome("KEYCODE_BACK");
  } catch {
    /* best-effort */
  }
}

export async function runChurnExperiment(deps: ChurnDeps): Promise<ChurnResult> {
  const { server, launchFeed, log } = deps;
  const on = new ScreenGraphStore({
    packageName: PKG,
    versionCode: VERSION_CODE,
    baseDir: deps.graphBaseDir,
    enforceBounds: true,
    debounceMs: 10_000_000,
  });
  const off = new ScreenGraphStore({
    packageName: PKG,
    versionCode: VERSION_CODE,
    baseDir: deps.offBaseDir,
    enforceBounds: false,
    debounceMs: 10_000_000,
  });

  const metrics: SessionMetric[] = [];
  const navAttempts: NavAttempt[] = [];
  let misRows = 0;
  let misRowTotal = 0;
  let carouselAttr = 0;
  let carouselTotal = 0;
  const presenceSweeps: PresenceSweep[] = [];
  /**
   * The detail screen's non-scroll rid multiset, captured from the first recorded
   * row tap (graph-independent, so both arms share one arrival predicate).
   */
  let detailRids: string[] | null = null;

  /**
   * One search attempt on a fresh feed. ON plans the template route on the ON
   * store (as `navigate-to` does with `ARGENT_SG_TEMPLATES=1`) and searches inside
   * the template's container; OFF-nograph runs the same search with no store and
   * no template (the largest scrollable).
   */
  const searchAttempt = async (
    arm: Arm,
    session: number,
    seed: number,
    target: number,
    deliberatelyAbsent: boolean,
    seen: Set<number>
  ): Promise<NavAttempt> => {
    const tA = Date.now();
    launchFeed(seed);
    await sleep(1200);
    const feedReadyMs = await waitForFeed(server);
    const base = {
      arm,
      session,
      target,
      deliberatelyAbsent,
      targetPresent: !deliberatelyAbsent && seen.has(target),
      feedReadyMs,
    };
    const never = (reason: string): NavAttempt => ({
      ...base,
      scrolls: -1,
      tapped: false,
      headlineOk: false,
      layoutOk: false,
      arrived: false,
      wallMs: -1,
      attemptMs: Date.now() - tA,
      swipeMs: [],
      deliveredMs: [],
      reason,
    });
    const cur = await snapshot(server);
    if (!cur) return never("no snapshot");
    const text = `Story ${target}`;
    let opts: TemplateStepOptions = {};
    if (arm === "on") {
      const route = planTemplateRoute(
        { nodes: on.nodes, edges: on.edges },
        cur.idHash,
        text,
        cur.tree as unknown as LiveElement[],
        true
      );
      if (!route) return never("no template route");
      const containerId = route.steps[route.steps.length - 1]?.template?.containerId;
      if (containerId !== undefined) opts = { containerId };
    }
    let out: Awaited<ReturnType<typeof executeTemplateStep>>;
    try {
      out = await executeTemplateStep(server, { width: cur.w, height: cur.h }, text, opts);
    } catch (e) {
      return never(`search error: ${String(e)}`);
    }
    let check = { headlineOk: false, layoutOk: false, arrived: false };
    if (out.tapped) {
      const after = await snapshot(server);
      check = arrivalCheck(
        after?.tree ?? [],
        after
          ? nonScrollRids(after.tree as unknown as TemplateElement[], PKG)
          : out.afterResourceIds,
        headlineFor(seed, target),
        detailRids ?? []
      );
      await back(server);
      await sleep(400);
    }
    return {
      ...base,
      scrolls: out.scrolls,
      tapped: out.tapped,
      ...check,
      wallMs: out.wallMs,
      attemptMs: Date.now() - tA,
      swipeMs: out.swipeMs,
      deliveredMs: out.deliveredMs,
      reversals: out.reversals,
      gaps: out.gaps,
      swept: out.swept,
      ...(check.arrived
        ? {}
        : {
            reason:
              out.reason ??
              (!check.headlineOk
                ? "arrival: headline"
                : !check.layoutOk
                  ? "arrival: layout"
                  : "arrival"),
          }),
    };
  };

  for (const condition of ["churn100", "churn0"] as Condition[]) {
    for (let session = 1; session <= SESSIONS; session++) {
      const seed = condition === "churn100" ? BASE_SEED + session : BASE_SEED;
      log(`[churn] ${condition} session ${session} (seed ${seed})`);
      launchFeed(seed);
      await sleep(1500);

      const launch = await snapshot(server);
      if (!launch) {
        log(`[churn] no launch snapshot for ${condition} s${session}; skipping session`);
        continue;
      }
      upsertFeed(on, launch);
      upsertFeed(off, launch);

      // --- 8 item taps: RELAUNCH the feed before EACH tap. A detail `back` does
      //     not reliably return to a queryable feed on this app/emulator (run
      //     34957934222 got stuck on the first detail and only ever tapped item 0),
      //     so every tap sees a fresh top-of-feed — the same relaunch pattern the
      //     nav phase already uses successfully. ---
      for (let i = 0; i < TAPS_PER_SESSION; i++) {
        launchFeed(seed);
        await sleep(1200);
        const before = await snapshot(server);
        if (!before) continue;
        const story = `Story ${i}`;
        const pt = await findExact(server, story);
        if (!pt) {
          log(`[churn] ${story} not found on ${condition} s${session}`);
          continue;
        }
        // Container attribution audit for this row tap.
        misRowTotal += 1;
        const cont = resolveContainer(before.tree as unknown as TemplateElement[], pt.x, pt.y);
        if (stripId(cont?.resourceId) !== "list") misRows += 1;
        try {
          await server.tapWithOutcome(pt.x, pt.y);
        } catch {
          continue;
        }
        await sleep(700);
        const after = await snapshot(server);
        if (after && after.idHash && after.idHash !== before.idHash) {
          recordTap(on, off, before, after, pt.x, pt.y, story);
          detailRids ??= nonScrollRids(after.tree as unknown as TemplateElement[], PKG);
        }
      }

      // --- one carousel tap (containment audit: expect the carousel, not the list) ---
      {
        launchFeed(seed);
        await sleep(1200);
        const before = await snapshot(server);
        const pt = before ? await findExact(server, "Card 0") : null;
        if (before && pt) {
          carouselTotal += 1;
          const cont = resolveContainer(before.tree as unknown as TemplateElement[], pt.x, pt.y);
          if (stripId(cont?.resourceId) === "carousel") carouselAttr += 1;
          try {
            await server.tapWithOutcome(pt.x, pt.y);
            await sleep(700);
            const after = await snapshot(server);
            if (after && after.idHash && after.idHash !== before.idHash) {
              recordTap(on, off, before, after, pt.x, pt.y, "Card 0");
            }
          } catch {
            /* best-effort */
          }
        }
      }

      // --- 10 scrolls on a FRESH feed (relaunch so the scroll phase runs on the
      //     feed, not a stuck detail): churn content + upsert the feed each time
      //     (drives volatility) + sample the summary tokens per arm ---
      launchFeed(seed);
      await sleep(1200);
      const summaryTokOn: number[] = [];
      const summaryTokOff: number[] = [];
      for (let s = 0; s < SCROLLS_PER_SESSION; s++) {
        const snap = await snapshot(server);
        if (!snap) continue;
        upsertFeed(on, snap);
        upsertFeed(off, snap);
        const onNode = on.getNode(snap.idHash);
        const offNode = off.getNode(snap.idHash);
        if (onNode) {
          summaryTokOn.push(
            countBoth(renderSummary(buildSummary(onNode, on.outgoingEdges(snap.idHash), on.nodes)))
              .tiktoken
          );
        }
        if (offNode) {
          summaryTokOff.push(
            countBoth(
              renderSummary(buildSummary(offNode, off.outgoingEdges(snap.idHash), off.nodes))
            ).tiktoken
          );
        }
        await swipeUp(server, snap);
        await sleep(350);
      }

      on.enforceBounds();
      await on.flush();
      await off.flush();

      const templateEdges = on.edges.filter((e) => e.template);
      metrics.push({
        condition,
        session,
        onNodes: Object.keys(on.nodes).length,
        onEdges: on.edges.length,
        onBytes: on.byteSize(),
        onVolatile: on.volatileNodeCount(),
        onTemplateEdges: templateEdges.length,
        onTemplateInstances: templateEdges.reduce((a, e) => a + (e.template?.instances ?? 0), 0),
        offNodes: Object.keys(off.nodes).length,
        offEdges: off.edges.length,
        offBytes: off.byteSize(),
        offDupEdgeTargets: off.duplicateEdgeTargets().length,
        summaryTokensOn: summaryTokOn.length
          ? pct(
              summaryTokOn.slice().sort((a, b) => a - b),
              50
            )
          : 0,
        summaryTokensOff: summaryTokOff.length
          ? pct(
              summaryTokOff.slice().sort((a, b) => a - b),
              50
            )
          : 0,
      });

      // --- template-step search, churn100 only: presence sweep, then each target
      //     (NAV_TARGETS + one deliberately absent probe) in BOTH arms, the arm
      //     order alternating by session (review E-1 findings 2, 3, 4, 5) ---
      if (condition === "churn100") {
        launchFeed(seed);
        await sleep(1200);
        await waitForFeed(server);
        const sweepSnap = await snapshot(server);
        const sw = await sweepContainer(
          server,
          { width: sweepSnap?.w ?? 1080, height: sweepSnap?.h ?? 2400 },
          { containerId: LIST_ID }
        );
        const observed = storyIndices(sw.labels);
        presenceSweeps.push({
          session,
          seed,
          observed,
          scrolls: sw.scrolls,
          gaps: sw.gaps,
          complete: sw.complete,
          wallMs: sw.wallMs,
          ...(sw.reason ? { reason: sw.reason } : {}),
        });
        log(
          `[churn] presence sweep s${session}: ${observed.length} rows observed (scrolls=${sw.scrolls}, gaps=${sw.gaps}, complete=${sw.complete}, wallMs=${sw.wallMs})`
        );
        const seen = new Set(observed);
        const absent = ABSENT_TARGETS[session - 1];
        const targets = absent === undefined ? NAV_TARGETS : [...NAV_TARGETS, absent];
        const arms: Arm[] = session % 2 === 1 ? ["on", "nograph"] : ["nograph", "on"];
        for (const target of targets) {
          for (const arm of arms) {
            const a = await searchAttempt(arm, session, seed, target, absent === target, seen);
            navAttempts.push(a);
            const tele = `scrolls=${a.scrolls}, reversals=${a.reversals ?? "-"}, gaps=${a.gaps ?? "-"}, swept=${a.swept ?? "-"}, wallMs=${a.wallMs}, feedReadyMs=${a.feedReadyMs}, present=${a.targetPresent}${a.deliberatelyAbsent ? ", probe" : ""}`;
            log(
              a.arrived
                ? `[churn] ${arm} Story ${target} ok (${tele})`
                : `[churn] ${arm} Story ${target} not reached (tapped=${a.tapped}, headline=${a.headlineOk}, layout=${a.layoutOk}, ${tele}, reason=${a.reason ?? "arrival"})`
            );
          }
        }
      }
    }
  }

  return grade(metrics, {
    navAttempts,
    presenceSweeps,
    g5: deps.g5 ?? {},
    misRows,
    misRowTotal,
    carouselAttr,
    carouselTotal,
    on,
    off,
  });
}

/**
 * E1-G3 (template-step search reliability): success >= 38/40 over attempts whose
 * target was OBSERVED present in that session's sweep; the deliberately absent
 * probes never count (review E-1 finding 5). The bar scales with the present-only
 * denominator; the raw number (every non-probe attempt) is reported too.
 */
export function gradeNavG3(
  attempts: Array<
    Pick<NavAttempt, "arrived" | "targetPresent"> & Partial<Pick<NavAttempt, "deliberatelyAbsent">>
  >
): {
  pass: boolean;
  presentOk: number;
  presentTotal: number;
  rawOk: number;
  rawTotal: number;
  detail: string;
} {
  const scored = attempts.filter((a) => !a.deliberatelyAbsent);
  const present = scored.filter((a) => a.targetPresent);
  const presentOk = present.filter((a) => a.arrived).length;
  const rawOk = scored.filter((a) => a.arrived).length;
  const bar = Math.ceil((NAV_PASS_MIN / NAV_PASS_OF) * present.length);
  return {
    pass: present.length > 0 && presentOk >= bar,
    presentOk,
    presentTotal: present.length,
    rawOk,
    rawTotal: scored.length,
    detail: `present-only ${presentOk}/${present.length} (bar ${bar}/${present.length} = ${NAV_PASS_MIN}/${NAV_PASS_OF}); raw ${rawOk}/${scored.length}`,
  };
}

/**
 * E1-G5 against its pre-registered bar (review E-1 finding 1): the Settings store
 * shape inside the published range AND the O1/O4 o200k tokens/step p50 inside the
 * published floors. A missing number is a FAIL ("not measured"), never a pass.
 */
export function gradeG5(input: G5Input): { pass: boolean; detail: string } {
  const fields: Array<[keyof G5Input, string]> = [
    ["settingsNodes", "settings store nodes"],
    ["settingsEdges", "settings store edges"],
    ["o1TokP50", "O1 tokens p50"],
    ["o4TokP50", "O4 tokens p50"],
  ];
  const missing = fields
    .filter(([k]) => typeof input[k] !== "number" || !Number.isFinite(input[k]))
    .map(([, label]) => label);
  if (missing.length) return { pass: false, detail: `not measured: ${missing.join(", ")}` };
  const n = input.settingsNodes!;
  const e = input.settingsEdges!;
  const o1 = input.o1TokP50!;
  const o4 = input.o4TokP50!;
  const within = (v: number, [lo, hi]: [number, number]) => v >= lo && v <= hi;
  const shapeOk = within(n, G5_NODES) && within(e, G5_EDGES);
  const o1Ok = within(o1, G5_O1);
  const o4Ok = within(o4, G5_O4);
  const inOut = (ok: boolean) => (ok ? "in" : "not in");
  return {
    pass: shapeOk && o1Ok && o4Ok,
    detail:
      `store ${n}n/${e}e ${inOut(shapeOk)} ${G5_NODES[0]}-${G5_NODES[1]}n/${G5_EDGES[0]}-${G5_EDGES[1]}e; ` +
      `O1 ${o1} ${inOut(o1Ok)} ${G5_O1[0]}-${G5_O1[1]}; O4 ${o4} ${inOut(o4Ok)} ${G5_O4[0]}-${G5_O4[1]} ` +
      `(pre-registered, 2026-09-15-screen-graph-phase-e1.md)`,
  };
}

function grade(
  metrics: SessionMetric[],
  ctx: {
    navAttempts: NavAttempt[];
    presenceSweeps: PresenceSweep[];
    g5: G5Input;
    misRows: number;
    misRowTotal: number;
    carouselAttr: number;
    carouselTotal: number;
    on: ScreenGraphStore;
    off: ScreenGraphStore;
  }
): ChurnResult {
  const churn100 = metrics
    .filter((m) => m.condition === "churn100")
    .sort((a, b) => a.session - b.session);
  const gates: ChurnResult["gates"] = {};

  // E1-G1: ON churn100 node/edge deltas for k=2..5 within bounds.
  let g1 = true;
  const deltas: string[] = [];
  for (let k = 1; k < churn100.length; k++) {
    const dN = churn100[k]!.onNodes - churn100[k - 1]!.onNodes;
    const dE = churn100[k]!.onEdges - churn100[k - 1]!.onEdges;
    deltas.push(`k${k + 1}: +${dN}n/+${dE}e`);
    if (dN > MAX_NODE_DELTA || dE > MAX_EDGE_DELTA) g1 = false;
  }
  const offDeltas: string[] = [];
  for (let k = 1; k < churn100.length; k++) {
    offDeltas.push(
      `k${k + 1}: +${churn100[k]!.offNodes - churn100[k - 1]!.offNodes}n/+${churn100[k]!.offEdges - churn100[k - 1]!.offEdges}e`
    );
  }
  gates["E1-G1"] = {
    name: "store growth per session (ON, churn100)",
    pass: g1,
    detail: `ON [${deltas.join(", ")}] (<= ${MAX_NODE_DELTA}n/${MAX_EDGE_DELTA}e); OFF [${offDeltas.join(", ")}]`,
  };

  // E1-G2: ON bytes at K=5 <= 64 KB; OFF recorded.
  const lastOn = churn100[churn100.length - 1];
  const g2 = !!lastOn && lastOn.onBytes <= MAX_ON_BYTES;
  gates["E1-G2"] = {
    name: "store bytes at K=5 (ON)",
    pass: g2,
    detail: lastOn
      ? `ON ${lastOn.onBytes} B (<= ${MAX_ON_BYTES}); OFF ${lastOn.offBytes} B`
      : "no churn100 metric",
  };

  // E1-G3: template-step search reliability, ON graded; OFF-nograph graded alongside.
  const onG3 = gradeNavG3(ctx.navAttempts.filter((a) => a.arm === "on"));
  const ngG3 = gradeNavG3(ctx.navAttempts.filter((a) => a.arm === "nograph"));
  gates["E1-G3"] = {
    name: "template-step search reliability (ON)",
    pass: onG3.pass,
    detail: `ON ${onG3.detail}; vs OFF-nograph ${ngG3.presentOk}/${ngG3.presentTotal}`,
  };
  gates["E1-G3-nograph"] = {
    name: "same search without store or template (OFF-nograph, comparator)",
    pass: ngG3.pass,
    detail: `OFF-nograph ${ngG3.detail}`,
    comparator: true,
  };

  // E1-G4: invariants on the ON arm; OFF duplicateEdgeTargets RECORDED.
  const dupScreens = ctx.on.duplicateScreens().length;
  const dupEdges = ctx.on.duplicateEdgeTargets().length;
  const dangling = ctx.on.danglingEdges().length;
  const hygiene = ctx.on.templateHygiene().length;
  const onBytes = ctx.on.byteSize();
  const g4 =
    dupScreens === 0 &&
    dupEdges === 0 &&
    dangling === 0 &&
    hygiene === 0 &&
    Object.keys(ctx.on.nodes).length <= 300 &&
    ctx.on.edges.length <= 600 &&
    onBytes <= 2 * 1024 * 1024;
  gates["E1-G4"] = {
    name: "invariants G-I1..G-I6 (ON)",
    pass: g4,
    detail: `ON dupScreens=${dupScreens} dupEdges=${dupEdges} dangling=${dangling} hygiene=${hygiene} nodes=${Object.keys(ctx.on.nodes).length} edges=${ctx.on.edges.length}; OFF dupEdgeTargets=${ctx.off.duplicateEdgeTargets().length} (recorded, not gated)`,
  };

  // E1-G5: the D.4.1 matrix (templates OFF) against the pre-registered bar.
  const g5 = gradeG5(ctx.g5);
  gates["E1-G5"] = {
    name: "D.4.1 matrix non-regression (templates OFF)",
    pass: g5.pass,
    detail: g5.detail,
  };

  // E1-G6: summary tokens ON vs OFF — DESCRIPTIVE ONLY (review E-1 finding 7:
  // the number is a mean of per-session p50s and the topN=6 cap bounds both).
  const onTok = churn100.map((m) => m.summaryTokensOn);
  const offTok = churn100.map((m) => m.summaryTokensOff);
  const mean = (xs: number[]) =>
    xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
  gates["E1-G6"] = {
    name: "feed summary tokens/step, ON vs OFF",
    pass: null,
    detail: `mean of per-session p50s: ON ~${mean(onTok)} vs OFF ~${mean(offTok)} (descriptive; cap-bound, topN=6 caps both)`,
  };

  const markdown = renderMarkdown(metrics, gates, ctx);
  return {
    metrics,
    gates,
    navSuccess: onG3.rawOk,
    navTotal: onG3.rawTotal,
    navSuccessPresent: onG3.presentOk,
    navTotalPresent: onG3.presentTotal,
    nograph: {
      ok: ngG3.rawOk,
      total: ngG3.rawTotal,
      presentOk: ngG3.presentOk,
      presentTotal: ngG3.presentTotal,
    },
    navAttempts: ctx.navAttempts,
    presenceSweeps: ctx.presenceSweeps,
    misattributionRows: ctx.misRows,
    misattributionRowTotal: ctx.misRowTotal,
    carouselAttributed: ctx.carouselAttr,
    carouselTotal: ctx.carouselTotal,
    markdown,
  };
}

function fmtMs(s: { n: number; p50: number | null; max: number | null }): string {
  return s.n === 0 ? "n/a (n=0)" : `${s.p50} / ${s.max} (n=${s.n})`;
}

function renderMarkdown(
  metrics: SessionMetric[],
  gates: ChurnResult["gates"],
  ctx: {
    navAttempts: NavAttempt[];
    presenceSweeps: PresenceSweep[];
    misRows: number;
    misRowTotal: number;
    carouselAttr: number;
    carouselTotal: number;
  }
): string {
  const L: string[] = [];
  L.push("# Churn experiment (E-1, design D3)\n");
  L.push(
    `App: \`${PKG}\`, items=${ITEMS}, sessions=${SESSIONS}, taps/session=${TAPS_PER_SESSION}, scrolls/session=${SCROLLS_PER_SESSION}.\n`
  );
  L.push("## Per-session store metrics\n");
  L.push(
    "| cond | k | ON nodes | ON edges | ON bytes | ON volatile | ON tplInst | OFF nodes | OFF edges | OFF bytes | OFF dupEdge |"
  );
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const m of metrics) {
    L.push(
      `| ${m.condition} | ${m.session} | ${m.onNodes} | ${m.onEdges} | ${m.onBytes} | ${m.onVolatile} | ${m.onTemplateInstances} | ${m.offNodes} | ${m.offEdges} | ${m.offBytes} | ${m.offDupEdgeTargets} |`
    );
  }
  L.push("\n## Gates\n");
  L.push("| gate | statistic | verdict | detail |");
  L.push("| --- | --- | --- | --- |");
  for (const [id, g] of Object.entries(gates)) {
    const v = g.pass === null ? "DESCRIPTIVE" : g.pass ? "PASS" : "FAIL";
    L.push(`| ${id} | ${g.name} | ${g.comparator ? `${v} (comparator)` : v} | ${g.detail} |`);
  }

  L.push("\n## Template-step search reliability: ON vs OFF-nograph\n");
  L.push(
    "Same targets, same sessions, same relaunch. ON plans the template route on the ON store and searches inside the template's container; OFF-nograph runs the same scroll-and-exact-text search with no store and no template (largest scrollable). Arrival = the landed tree shows exactly `Headline <seed>-<target>` AND its non-scroll rid multiset matches the detail layout (Jaccard >= 0.9). Present = observed in the session's presence sweep. The deliberately absent probes are excluded here (see give-up cost).\n"
  );
  L.push(
    "| arm | present ok / present | raw ok / attempts | wallMs p50 / max | swipeMs p50 / max | deliveredMs p50 / max | attempts with gaps | scrolls p50 / max |"
  );
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const arm of ["on", "nograph"] as Arm[]) {
    const as = ctx.navAttempts.filter((a) => a.arm === arm && !a.deliberatelyAbsent);
    const g = gradeNavG3(as);
    const ran = as.filter((a) => a.wallMs >= 0);
    L.push(
      `| ${arm === "on" ? "ON" : "OFF-nograph"} | ${g.presentOk}/${g.presentTotal} | ${g.rawOk}/${g.rawTotal} | ${fmtMs(summarizeMs(ran.map((a) => a.wallMs)))} | ${fmtMs(summarizeMs(as.flatMap((a) => a.swipeMs)))} | ${fmtMs(summarizeMs(as.flatMap((a) => a.deliveredMs)))} | ${ran.filter((a) => (a.gaps ?? 0) > 0).length}/${ran.length} | ${fmtMs(summarizeMs(ran.map((a) => a.scrolls)))} |`
    );
  }

  L.push("\n## Give-up cost (deliberately absent targets)\n");
  L.push("| arm | session | target | scrolls | reversals | gaps | swept | wallMs | reason |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const opt = (v: number | boolean | undefined) => (v === undefined ? "-" : String(v));
  const probes = ctx.navAttempts.filter((a) => a.deliberatelyAbsent);
  for (const a of probes) {
    L.push(
      `| ${a.arm} | ${a.session} | Story ${a.target} | ${a.scrolls < 0 ? "-" : a.scrolls} | ${opt(a.reversals)} | ${opt(a.gaps)} | ${opt(a.swept)} | ${a.wallMs} | ${a.reason ?? ""} |`
    );
  }
  for (const arm of ["on", "nograph"] as Arm[]) {
    const ps = probes.filter((a) => a.arm === arm && a.wallMs >= 0);
    L.push(
      `\n- ${arm === "on" ? "ON" : "OFF-nograph"}: swept ${ps.filter((a) => a.swept).length}/${ps.length}; give-up wallMs p50 / max ${fmtMs(summarizeMs(ps.map((a) => a.wallMs)))}.`
    );
  }

  L.push("\n## Presence sweeps (observed rows per churn100 session)\n");
  L.push(
    "| session | seed | rows observed | NAV targets missing | scrolls | gaps | complete | wallMs |"
  );
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const p of ctx.presenceSweeps) {
    const seen = new Set(p.observed);
    const missing = NAV_TARGETS.filter((t) => !seen.has(t));
    L.push(
      `| ${p.session} | ${p.seed} | ${p.observed.length} | ${missing.length ? missing.join(", ") : "none"} | ${p.scrolls} | ${p.gaps} | ${p.complete} | ${p.wallMs} |`
    );
  }

  L.push("\n## Containment audit\n");
  L.push(
    `- Row taps attributed to \`#list\`: ${ctx.misRowTotal - ctx.misRows}/${ctx.misRowTotal} (misattributed ${ctx.misRows}).`
  );
  L.push(`- Carousel taps attributed to \`#carousel\`: ${ctx.carouselAttr}/${ctx.carouselTotal}.`);

  L.push("\n## Search attempts (churn100)\n");
  L.push(
    "| arm | session | target | probe | present | feed ready ms | scrolls | reversals | gaps | swept | wallMs | swipeMs p50 | deliveredMs p50 | tapped | headline | layout | arrived | reason |"
  );
  L.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  );
  for (const a of ctx.navAttempts) {
    const sw = summarizeMs(a.swipeMs);
    const dl = summarizeMs(a.deliveredMs);
    L.push(
      `| ${a.arm} | ${a.session} | Story ${a.target} | ${a.deliberatelyAbsent} | ${a.targetPresent} | ${a.feedReadyMs} | ${a.scrolls < 0 ? "-" : a.scrolls} | ${opt(a.reversals)} | ${opt(a.gaps)} | ${opt(a.swept)} | ${a.wallMs} | ${sw.p50 ?? "-"} | ${dl.p50 ?? "-"} | ${a.tapped} | ${a.headlineOk} | ${a.layoutOk} | ${a.arrived} | ${a.reason ?? ""} |`
    );
  }
  L.push("");
  return L.join("\n");
}
