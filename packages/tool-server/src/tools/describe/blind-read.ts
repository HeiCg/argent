import type { DescribeTreeData } from "./contract";

/**
 * Whether a tree read that ARRIVED is still blind: a childless tree that the
 * adapter flagged (`hint` / `should_restart` instead of a throw), or one that
 * went blank after the caller's selector had already matched on an earlier
 * poll. Such a read is not trustworthy evidence about the screen, so `hidden`
 * (the only wait condition an empty tree satisfies) must not resolve off it.
 *
 * The contract this predicate leans on: the physical-device describe path
 * (`platforms/ios-device.ts`) stamps a hint on EVERY childless tree precisely
 * so this check can detect unreadable screens. Any drift in the predicate
 * silently breaks hidden-waits on hardware, which is why `await-ui-element`
 * and the flow `await`/`assert` directives (`flow-actions.ts`) share this one
 * copy. The deliberate variants stay local to their owners and document how
 * they differ: `flow-actions.ts`'s `isBlindTreeRead` (no `everMatched` term)
 * and `flow-ios-tree.ts`'s throw-variant.
 */
export function isBlindRead(data: DescribeTreeData, everMatched: boolean): boolean {
  if (data.tree.children.length > 0) return false;
  return Boolean(data.hint || data.should_restart || everMatched);
}
