import { expect } from "vitest";

/**
 * Assert `needle` appears exactly once. The recovery prose names the same actor
 * and the same tools in more than one clause, so a plain toContain stays green
 * after the clause it was written for is deleted.
 */
export function pinsOnce(haystack: string | undefined, needle: string, label?: string) {
  const where = label ? `${label}: ` : "";
  expect((haystack ?? "").split(needle).length - 1, `${where}exactly one "${needle}"`).toBe(1);
}

/** The words English carves an exception with. */
const QUALIFIER =
  /^[\s,—-]*(except|unless|until|other than|apart from|save for|provided|as long as|only when|only if)\b/i;

/**
 * Assert `needle` appears exactly once and is not carved out where it ends. A
 * needle that stops at a clause boundary is a prefix of its own weakened form,
 * so pinsOnce alone stays green when the escape hatch is appended to the very
 * claim it pins — "not supported on chromium" reads the same in "not supported
 * on chromium except for an app you booted yourself".
 */
export function pinsUnqualified(haystack: string | undefined, needle: string, label?: string) {
  pinsOnce(haystack, needle, label);
  const text = haystack ?? "";
  const rest = text.slice(text.indexOf(needle) + needle.length);
  const carveOut = QUALIFIER.exec(rest)?.[1];
  expect(
    carveOut,
    `${label ? `${label}: ` : ""}"${needle}" is carved out by "${carveOut}"`
  ).toBeUndefined();
}
