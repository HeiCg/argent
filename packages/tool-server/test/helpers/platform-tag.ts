import { expect } from "vitest";
import type { ToolCapability } from "@argent/registry";

/**
 * The platform words a doc surface may name, paired with the capability key
 * that decides whether it may. `appleRemote` is deliberately absent: it is
 * remote-iOS over sim-remote (registry types.ts), which these surfaces fold
 * into "iOS" rather than naming, so there is no word for a tag to track.
 */
export const PLATFORM_WORDS = [
  ["apple", "iOS"],
  ["android", "Android"],
  ["vega", "Vega"],
] as const satisfies readonly (readonly [keyof ToolCapability, string])[];

/**
 * The platform tag a surface should carry — read off the support flags, not key
 * presence: `apple: {}` is a declared key supporting no Apple device, and a tag
 * built from it would document support the capability gate rejects.
 */
export function platformTag(capability: ToolCapability | undefined): string {
  return PLATFORM_WORDS.filter(([key]) => {
    const matrix = capability?.[key];
    return matrix !== undefined && Object.values(matrix).some(Boolean);
  })
    .map(([, word]) => word)
    .join(" / ");
}

/**
 * Assert the parenthesised `tag` is the whole platform claim `cell` makes. A
 * containment check reads the paren and nothing after it, so a platform
 * appended outside — "(iOS / Android / Vega) and Chromium" — documents support
 * the capability gate rejects while every tag assertion stays green.
 */
export function expectTagEndsTheClaim(cell: string, tag: string, label: string) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  expect(cell, `${label}: (${tag}) must end the platform claim`).toMatch(
    new RegExp(`\\(${escaped}\\)(?=\\s*(?:[.,;:|)]|$))`)
  );
}
