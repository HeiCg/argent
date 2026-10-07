/**
 * Markdown helpers for the screen-graph bench report (`results-ci.md`).
 */

/**
 * One `| key | value |` cell of the report's Environment table. Objects (the
 * `churn` gates, `settingsGraph`) are printed as compact JSON, not `String(v)`'s
 * `[object Object]` (review E-1 2026-10-07 finding 8); table pipes are escaped.
 */
export function formatEnvValue(v: unknown): string {
  const s = v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/\|/g, "\\|");
}
