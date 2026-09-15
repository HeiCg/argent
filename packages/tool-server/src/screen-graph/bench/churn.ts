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
 * instances, describe summary tokens, container misattribution, and a
 * `navigate-to`-through-a-template-edge success rate, then grades E1-G1..E1-G6.
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
import { planToTemplate, multisetJaccard, nodeResourceIds } from "../plan";
import { executeTemplateStep } from "../../tools/navigate-to";
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

type Condition = "churn100" | "churn0";

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

interface ChurnDeps {
  server: OpenDeviceServerApi;
  /** Launch the feed with a seed (adb `am start ... --ei seed <n>`). */
  launchFeed: (seed: number) => void;
  /** Graph dir for the ON store (gated + artifact-copied). */
  graphBaseDir: string;
  /** A dir OUTSIDE the gated graph dir for the OFF store. */
  offBaseDir: string;
  log: (m: string) => void;
}

interface ChurnResult {
  metrics: SessionMetric[];
  gates: Record<string, { pass: boolean | null; detail: string }>;
  navSuccess: number;
  navTotal: number;
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
  let navSuccess = 0;
  let navTotal = 0;
  let misRows = 0;
  let misRowTotal = 0;
  let carouselAttr = 0;
  let carouselTotal = 0;

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

      // --- 8 item taps (top rows, no scroll needed) ---
      for (let i = 0; i < TAPS_PER_SESSION; i++) {
        const story = `Story ${i}`;
        const before = await snapshot(server);
        if (!before) continue;
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
        await sleep(600);
        const after = await snapshot(server);
        if (after && after.idHash && after.idHash !== before.idHash) {
          recordTap(on, off, before, after, pt.x, pt.y, story);
        }
        await back(server);
        await sleep(500);
      }

      // --- one carousel tap (containment audit: expect the carousel, not the list) ---
      {
        const before = await snapshot(server);
        const pt = before ? await findExact(server, "Card 0") : null;
        if (before && pt) {
          carouselTotal += 1;
          const cont = resolveContainer(before.tree as unknown as TemplateElement[], pt.x, pt.y);
          if (stripId(cont?.resourceId) === "carousel") carouselAttr += 1;
          try {
            await server.tapWithOutcome(pt.x, pt.y);
            await sleep(600);
            const after = await snapshot(server);
            if (after && after.idHash && after.idHash !== before.idHash) {
              recordTap(on, off, before, after, pt.x, pt.y, "Card 0");
            }
            await back(server);
            await sleep(400);
          } catch {
            /* best-effort */
          }
        }
      }

      // --- 10 scrolls: churn the feed content, upsert the feed node each time
      //     (drives volatility), and sample the summary tokens per arm ---
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

      // --- navigate-to through a template edge, churn100 only (n = 8 x 5 = 40) ---
      if (condition === "churn100") {
        for (const target of NAV_TARGETS) {
          navTotal += 1;
          launchFeed(seed);
          await sleep(1200);
          const cur = await snapshot(server);
          if (!cur) continue;
          const plan = planToTemplate({ nodes: on.nodes, edges: on.edges }, cur.idHash);
          if (!plan) {
            log(`[churn] no template route from feed for target ${target}`);
            continue;
          }
          const out = await executeTemplateStep(
            server,
            { width: cur.w, height: cur.h },
            `Story ${target}`
          );
          const tplNode = on.getNode(plan.templateNode);
          const arrived =
            out.tapped &&
            !!tplNode &&
            multisetJaccard(out.afterResourceIds, nodeResourceIds(tplNode)) >= 0.9;
          if (arrived) navSuccess += 1;
          else
            log(
              `[churn] nav to Story ${target} failed (tapped=${out.tapped}, reason=${out.reason ?? "arrival"})`
            );
          await back(server);
          await sleep(400);
        }
      }
    }
  }

  return grade(metrics, {
    navSuccess,
    navTotal,
    misRows,
    misRowTotal,
    carouselAttr,
    carouselTotal,
    on,
    off,
  });
}

function grade(
  metrics: SessionMetric[],
  ctx: {
    navSuccess: number;
    navTotal: number;
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
    pass: g1,
    detail: `ON [${deltas.join(", ")}] (<= ${MAX_NODE_DELTA}n/${MAX_EDGE_DELTA}e); OFF [${offDeltas.join(", ")}]`,
  };

  // E1-G2: ON bytes at K=5 <= 64 KB; OFF recorded.
  const lastOn = churn100[churn100.length - 1];
  const g2 = !!lastOn && lastOn.onBytes <= MAX_ON_BYTES;
  gates["E1-G2"] = {
    pass: g2,
    detail: lastOn
      ? `ON ${lastOn.onBytes} B (<= ${MAX_ON_BYTES}); OFF ${lastOn.offBytes} B`
      : "no churn100 metric",
  };

  // E1-G3: navigate-to success >= 38/40.
  const g3 = ctx.navTotal > 0 && ctx.navSuccess >= NAV_PASS_MIN;
  gates["E1-G3"] = {
    pass: g3,
    detail: `${ctx.navSuccess}/${ctx.navTotal} (bar ${NAV_PASS_MIN}/40; D.4.1 O5 baseline 59/60)`,
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
    pass: g4,
    detail: `ON dupScreens=${dupScreens} dupEdges=${dupEdges} dangling=${dangling} hygiene=${hygiene} nodes=${Object.keys(ctx.on.nodes).length} edges=${ctx.on.edges.length}; OFF dupEdgeTargets=${ctx.off.duplicateEdgeTargets().length} (recorded, not gated)`,
  };

  // E1-G5: reported by the Settings/Chrome matrix (templates OFF) — see the run's
  // invariants line + settingsGraph. Marked descriptive here (graded in the report).
  gates["E1-G5"] = {
    pass: null,
    detail: "D.4.1 matrix (templates OFF) non-regression — see the run's settingsGraph + tokens",
  };

  // E1-G6: summary tokens ON vs OFF — DESCRIPTIVE ONLY.
  const onTok = churn100.map((m) => m.summaryTokensOn);
  const offTok = churn100.map((m) => m.summaryTokensOff);
  const mean = (xs: number[]) =>
    xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
  gates["E1-G6"] = {
    pass: null,
    detail: `feed summary tokens/step p50: ON ~${mean(onTok)} vs OFF ~${mean(offTok)} (descriptive; topN=6 caps both)`,
  };

  const markdown = renderMarkdown(metrics, gates, ctx);
  return {
    metrics,
    gates,
    navSuccess: ctx.navSuccess,
    navTotal: ctx.navTotal,
    misattributionRows: ctx.misRows,
    misattributionRowTotal: ctx.misRowTotal,
    carouselAttributed: ctx.carouselAttr,
    carouselTotal: ctx.carouselTotal,
    markdown,
  };
}

function renderMarkdown(
  metrics: SessionMetric[],
  gates: ChurnResult["gates"],
  ctx: {
    navSuccess: number;
    navTotal: number;
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
  L.push("| gate | verdict | detail |");
  L.push("| --- | --- | --- |");
  for (const [id, g] of Object.entries(gates)) {
    const v = g.pass === null ? "DESCRIPTIVE" : g.pass ? "PASS" : "FAIL";
    L.push(`| ${id} | ${v} | ${g.detail} |`);
  }
  L.push("\n## Containment audit\n");
  L.push(
    `- Row taps attributed to \`#list\`: ${ctx.misRowTotal - ctx.misRows}/${ctx.misRowTotal} (misattributed ${ctx.misRows}).`
  );
  L.push(`- Carousel taps attributed to \`#carousel\`: ${ctx.carouselAttr}/${ctx.carouselTotal}.`);
  L.push(`- navigate-to (template step): ${ctx.navSuccess}/${ctx.navTotal}.`);
  L.push("");
  return L.join("\n");
}
