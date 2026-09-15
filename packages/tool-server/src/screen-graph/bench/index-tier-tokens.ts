/**
 * Artemis A2 §B — the token-table generator that decides whether the `index`
 * describe tier ships as default. For each captured task screen it renders the
 * tiers, counts o200k tokens, and records the "locate exact-match" proxy the
 * harness already uses, so the ship/opt-in rule ("index ≥ 20 % below the best
 * tier at equal locate success, else opt-in") is decided on real numbers.
 *
 * Pure and device-free: it operates on the committed describe fixtures (the
 * on-device `describe` renderings) so `npm test` reproduces the table. The
 * `index` rendering here is reconstructed from a describe payload's framed lines;
 * it is the SAME `[i] label (role)` line format the on-device
 * `renderIndexTier(buildIndexElements(tree))` emits, so the token delta is
 * representative.
 */
import { tiktokenCount } from "./tokens";
import { describeLinesToNodes } from "./describe-locate";
import { pickUniqueNode } from "./locate";

/** The last parenthesised 4-tuple on a describe line is its normalized frame. */
const FRAME_RE = /\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)\s*$/;

export interface IndexLine {
  role: string;
  label: string;
}

/**
 * Parse a describe payload into the `index` tier's per-element rows: one row per
 * framed line (a rendered node), `role` = the line's leading class token, `label`
 * = its first quoted string (empty for a bare, unlabelled node — kept, so this is
 * a conservative, never-smaller-than-real index list).
 */
export function indexLinesFromDescribe(describeText: string): IndexLine[] {
  const rows: IndexLine[] = [];
  for (const raw of describeText.split("\n")) {
    const line = raw.trimEnd();
    if (!FRAME_RE.test(line)) continue;
    const trimmed = line.trim();
    const roleMatch = /^([A-Za-z][\w.]*)/.exec(trimmed);
    const role = roleMatch ? roleMatch[1]! : "node";
    const quoted = /"([^"]*)"/.exec(line);
    rows.push({ role, label: quoted ? quoted[1]!.trim() : "" });
  }
  return rows;
}

/** Render the reconstructed index list to the `[i] label (role)` tier text. */
export function renderIndexFromDescribe(describeText: string, version: number): string {
  const rows = indexLinesFromDescribe(describeText);
  const lines = [
    `index tier (version ${version}) — tap with target: { index, version: ${version} }`,
  ];
  rows.forEach((r, i) => {
    lines.push(r.label.length > 0 ? `[${i}] ${r.label} (${r.role})` : `[${i}] (${r.role})`);
  });
  if (rows.length === 0) lines.push("(no interactive elements)");
  return lines.join("\n");
}

export type Tier = "full" | "summary" | "compact" | "index";

export interface TierMeasure {
  screen: string;
  tokens: Record<Tier, number>;
  locate: {
    /** Distinct label targets probed on this screen. */
    targets: number;
    /** Targets uniquely resolvable by label over the full/compact node set. */
    uniqueByLabel: number;
    /**
     * Targets uniquely resolvable by label among the index ROWS — counted the SAME
     * way as `uniqueByLabel` (review A2-H2), so the two are like-for-like. The index
     * rendering carries the same labels as compact and no extra tie-breaker in the
     * text, so this is parity with `uniqueByLabel`, not a win. (In practice the
     * agent disambiguates by the index NUMBER, which this label-only proxy ignores.)
     */
    indexAddressable: number;
  };
  /** (compact − index) / compact, as a percentage (positive = index is smaller). */
  indexVsCompactPct: number;
}

export interface ScreenInput {
  screen: string;
  /** The on-device describe (open path serves the pruned tree; full ≈ compact). */
  compactText: string;
  /** The `summary` tier rendering for this screen (label + top affordances). */
  summaryText: string;
  /** Optional distinct label targets; defaults to every distinct label on-screen. */
  targets?: string[];
  /** AX version to stamp on the reconstructed index header. */
  version?: number;
}

/**
 * Measure one screen across the four tiers. On the open path the describe already
 * serves the pruned interactables tree, so `full` and `compact` coincide (there is
 * no larger un-pruned rendering in the capture) — both are the stored describe;
 * the decision that matters is `index` vs the smaller of `compact`/`summary` at
 * equal locate success, and `summary` loses per-element locate by design.
 */
export function measureScreenTiers(input: ScreenInput): TierMeasure {
  const compactTokens = tiktokenCount(input.compactText);
  const summaryTokens = tiktokenCount(input.summaryText);
  const indexText = renderIndexFromDescribe(input.compactText, input.version ?? 0);
  const indexTokens = tiktokenCount(indexText);

  const nodes = describeLinesToNodes(input.compactText);
  const targets = input.targets ?? [
    ...new Set(nodes.map((n) => (n.text ?? "").trim()).filter((t) => t.length > 0)),
  ];
  // Index-row nodes, in the SAME QueryNodeLite shape compact is scored over, so
  // `pickUniqueNode` counts the index side identically (review A2-H2).
  const indexNodes = indexLinesFromDescribe(input.compactText).map((r) => ({
    text: r.label,
    bounds: { x1: 0, y1: 0, x2: 0, y2: 0 },
  }));

  let uniqueByLabel = 0;
  let indexAddressable = 0;
  for (const label of targets) {
    if (pickUniqueNode(nodes, { text: label }).node) uniqueByLabel++;
    if (pickUniqueNode(indexNodes, { text: label }).node) indexAddressable++;
  }

  return {
    screen: input.screen,
    tokens: {
      full: compactTokens,
      summary: summaryTokens,
      compact: compactTokens,
      index: indexTokens,
    },
    locate: { targets: targets.length, uniqueByLabel, indexAddressable },
    indexVsCompactPct:
      compactTokens > 0
        ? Number((((compactTokens - indexTokens) / compactTokens) * 100).toFixed(1))
        : 0,
  };
}

export interface TierTableSummary {
  rows: TierMeasure[];
  totals: Record<Tier, number>;
  medians: Record<Tier, number>;
  /** Median index-vs-compact savings across screens (percentage). */
  medianIndexVsCompactPct: number;
  /** Aggregate locate parity: Σ uniqueByLabel vs Σ indexAddressable. */
  locate: { uniqueByLabel: number; indexAddressable: number; targets: number };
  /** The ship rule: default only if median savings ≥ 20 % at ≥ compact locate. */
  shipAsDefault: boolean;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Number(((s[mid - 1]! + s[mid]!) / 2).toFixed(1));
}

/** Aggregate the per-screen measures and apply the ship/opt-in rule. */
export function summarizeTierTable(rows: TierMeasure[]): TierTableSummary {
  const tiers: Tier[] = ["full", "summary", "compact", "index"];
  const totals = {} as Record<Tier, number>;
  const medians = {} as Record<Tier, number>;
  for (const tier of tiers) {
    totals[tier] = rows.reduce((a, r) => a + r.tokens[tier], 0);
    medians[tier] = median(rows.map((r) => r.tokens[tier]));
  }
  const locate = rows.reduce(
    (a, r) => ({
      uniqueByLabel: a.uniqueByLabel + r.locate.uniqueByLabel,
      indexAddressable: a.indexAddressable + r.locate.indexAddressable,
      targets: a.targets + r.locate.targets,
    }),
    { uniqueByLabel: 0, indexAddressable: 0, targets: 0 }
  );
  const medianSavings = median(rows.map((r) => r.indexVsCompactPct));
  // The SAVINGS half of the rule: index ≥ 20 % below compact. Locate is scored
  // like-for-like (A2-H2), so `indexAddressable == uniqueByLabel` — PARITY, not a
  // win; the token savings is what clears the bar. This flag only reports rule
  // eligibility; the phase decision keeps `index` opt-in regardless (see the Result:
  // active-window-only cap, no settle/incident/graph, unmeasured on-device delta).
  const shipAsDefault = medianSavings >= 20 && locate.indexAddressable >= locate.uniqueByLabel;
  return {
    rows,
    totals,
    medians,
    medianIndexVsCompactPct: medianSavings,
    locate,
    shipAsDefault,
  };
}
