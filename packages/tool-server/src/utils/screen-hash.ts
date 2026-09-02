/**
 * Host-side structural (H) and state (H_text) fingerprints of an accessibility
 * tree (Screen-graph Phase A, design §2.1 / §3).
 *
 * This is the TypeScript twin of the on-device Kotlin `ScreenHash`
 * (`packages/android-device-server/.../accessibility/ScreenHash.kt`): identical
 * flag bits, quantization, field order, US/RS separators and
 * 64-bit FNV-1a constants, so the two produce the same hex for the same tree.
 *
 * On the Android open path the DEVICE is the authority for H/H_text (it hashes
 * the real hierarchical tree and returns the hex in `getState`/`query`/`diff`/
 * `awaitChange`); this module is used for host-side hashing where a hierarchical
 * tree is available, and is the unit-tested reference for determinism and the
 * recycler rule. The open server serves a FLATTENED tree to the host, so the two
 * are not machine-cross-verified on that path — they agree by shared construction.
 */

/** A node shaped for hashing. All string fields default to "" when absent. */
export interface HashNode {
  class?: string;
  /** Stripped resource id (the part after "id/"). */
  id?: string;
  text?: string;
  cd?: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  clickable?: boolean;
  scrollable?: boolean;
  editable?: boolean;
  checkable?: boolean;
  enabled?: boolean;
  focused?: boolean;
  children?: HashNode[];
}

// Flag bit positions — MUST match ScreenHash.kt.
export const FLAG_CLICKABLE = 1 << 0;
export const FLAG_SCROLLABLE = 1 << 1;
export const FLAG_EDITABLE = 1 << 2;
export const FLAG_CHECKABLE = 1 << 3;
export const FLAG_ENABLED = 1 << 4;
export const FLAG_FOCUSED = 1 << 5;

const US = String.fromCharCode(0x1f); // unit separator between fields
const RS = String.fromCharCode(0x1e); // record separator between nodes

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

const SCROLLING_CONTAINERS = new Set(["RecyclerView", "ListView", "ScrollView", "HorizontalScrollView"]);

export function flagsOf(n: HashNode): number {
  let f = 0;
  if (n.clickable) f |= FLAG_CLICKABLE;
  if (n.scrollable) f |= FLAG_SCROLLABLE;
  if (n.editable) f |= FLAG_EDITABLE;
  if (n.checkable) f |= FLAG_CHECKABLE;
  if (n.enabled) f |= FLAG_ENABLED;
  if (n.focused) f |= FLAG_FOCUSED;
  return f;
}

export function isScrollingContainer(n: HashNode): boolean {
  if (n.scrollable) return true;
  const c = n.class ?? "";
  return SCROLLING_CONTAINERS.has(c) || c.startsWith("ViewPager");
}

function quant(v: number, dim: number): number {
  if (dim <= 0) return 0;
  return Math.floor((v * 32) / dim);
}

function fnv1a(s: string): string {
  let h = FNV_OFFSET;
  const bytes = Buffer.from(s, "utf8");
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}

/** H — structural, text-excluded, recycler rule applied. */
export function structuralHash(roots: HashNode[], screenW: number, screenH: number): string {
  let out = "";
  const append = (n: HashNode): void => {
    out +=
      (n.class ?? "") + US +
      (n.id ?? "") + US +
      quant(n.bounds.x1, screenW) + "," + quant(n.bounds.y1, screenH) + "," +
      quant(n.bounds.x2, screenW) + "," + quant(n.bounds.y2, screenH) + US +
      flagsOf(n) + RS;
    const children = n.children ?? [];
    if (isScrollingContainer(n)) {
      // Recycler rule (design §6): container + the class sequence of its FIRST
      // child subtree only, so item count / content does not change H.
      if (children.length > 0) appendClassSeq(children[0]!);
    } else {
      for (const c of children) append(c);
    }
  };
  const appendClassSeq = (n: HashNode): void => {
    out += (n.class ?? "") + RS;
    for (const c of n.children ?? []) appendClassSeq(c);
  };
  for (const r of roots) append(r);
  return fnv1a(out);
}

/** H_text — structural + (text, contentDesc), ALL children, no recycler rule. */
export function stateHash(roots: HashNode[], screenW: number, screenH: number): string {
  let out = "";
  const append = (n: HashNode): void => {
    out +=
      (n.class ?? "") + US +
      (n.id ?? "") + US +
      quant(n.bounds.x1, screenW) + "," + quant(n.bounds.y1, screenH) + "," +
      quant(n.bounds.x2, screenW) + "," + quant(n.bounds.y2, screenH) + US +
      flagsOf(n) + US +
      (n.text ?? "") + US +
      (n.cd ?? "") + RS;
    for (const c of n.children ?? []) append(c);
  };
  for (const r of roots) append(r);
  return fnv1a(out);
}
