import { expect } from "vitest";

/**
 * Assert `needle` appears exactly once. The recovery prose states the same steps
 * twice - once per branch, or once per platform - so a plain toContain survives
 * deleting the clause it was written for.
 */
export function pinsOnce(haystack: string | undefined, needle: string, label?: string) {
  const where = label ? `${label}: ` : "";
  expect((haystack ?? "").split(needle).length - 1, `${where}exactly one "${needle}"`).toBe(1);
}
