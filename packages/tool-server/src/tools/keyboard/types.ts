export interface KeyboardParams {
  udid: string;
  text?: string;
  /**
   * Rejected alongside `text` and `clear` in ./index.ts, so a backend sees at
   * most one of the three. Not valid on TV targets.
   */
  key?: string;
  /**
   * Empty the focused text field. Only `true` acts — `false` reads as absent,
   * like an omitted parameter — and it is rejected alongside `text` / `key` in
   * ./index.ts. Not valid on TV or Vega targets.
   */
  clear?: boolean;
  delayMs?: number;
}

export interface KeyboardResult {
  typed: string;
  keys: number;
  /**
   * Present only on a `clear` call. It reports that the clear was SENT, not
   * what the field now holds: no backend reads the value back (a cleared field
   * may have held a secret), and a field longer than the burst keeps its
   * remainder.
   */
  cleared?: true;
}
