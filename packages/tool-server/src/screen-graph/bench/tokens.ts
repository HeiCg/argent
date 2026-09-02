/**
 * Screen-graph Phase C — token counting + summary statistics (design §4).
 *
 * Tokens are counted two ways, as the ticket requires: `js-tiktoken` o200k_base
 * (primary) and chars/4 (secondary). The tiktoken encoder is loaded lazily and
 * degrades to chars/4 if it cannot be constructed, so the harness never crashes
 * on a token count.
 */
import { getEncoding, type Tiktoken } from "js-tiktoken";

let encoder: Tiktoken | null = null;
let triedLoad = false;
function enc(): Tiktoken | null {
  if (!triedLoad) {
    triedLoad = true;
    try {
      encoder = getEncoding("o200k_base");
    } catch {
      encoder = null;
    }
  }
  return encoder;
}

/** Primary token count: js-tiktoken o200k_base; falls back to chars/4. */
export function tiktokenCount(s: string): number {
  const e = enc();
  return e ? e.encode(s).length : charsOver4(s);
}

/** Secondary token estimate: ceil(chars / 4). */
export function charsOver4(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Both counts for one payload. */
export function countBoth(s: string): { tiktoken: number; charsDiv4: number } {
  return { tiktoken: tiktokenCount(s), charsDiv4: charsOver4(s) };
}

export function tokenizerName(): string {
  return enc()
    ? "js-tiktoken o200k_base (primary), chars/4 (secondary)"
    : "chars/4 (js-tiktoken o200k_base failed to load)";
}

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
}

export function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export function summarize(xs: number[]): Summary {
  if (xs.length === 0) return { n: 0, p50: NaN, p95: NaN, min: NaN, max: NaN, mean: NaN };
  const s = xs.slice().sort((a, b) => a - b);
  const sum = s.reduce((acc, x) => acc + x, 0);
  return {
    n: s.length,
    p50: pct(s, 50),
    p95: pct(s, 95),
    min: s[0]!,
    max: s[s.length - 1]!,
    mean: Number((sum / s.length).toFixed(2)),
  };
}

/** Range string "min–max" for reporting per-verb ranges across repetitions. */
export function range(xs: number[]): string {
  if (xs.length === 0) return "—";
  const s = xs.slice().sort((a, b) => a - b);
  return `${s[0]}–${s[s.length - 1]}`;
}

/** a / b, guarded (NaN when b is 0 or either side is NaN). */
export function ratio(a: number, b: number): number {
  if (!isFinite(a) || !isFinite(b) || b === 0) return NaN;
  return Number((a / b).toFixed(3));
}
