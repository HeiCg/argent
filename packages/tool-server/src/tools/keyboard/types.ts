export interface KeyboardParams {
  udid: string;
  /** Text to type character by character. */
  text?: string;
  /** Named key to press (enter, escape, arrow-*, f1–f12). Not valid on TV targets. */
  key?: string;
  /** Delay in ms between key presses (default 50). */
  delayMs?: number;
}

/**
 * The read-back outcome a backend that can inspect the field contributes to its
 * result. Only the Android phone / tablet path produces one — see
 * `platforms/android-verify.ts` for why that transport needs it and the others
 * do not.
 */
export interface KeyboardVerification {
  verified?: boolean;
  note?: string;
}

export interface KeyboardResult extends KeyboardVerification {
  typed: string;
  keys: number;
  /**
   * Whether the typed text was read back off the screen and found in the
   * focused field. `true` means the field really holds it; `false` means it does
   * not, and `note` says so. Absent means no read-back happened — on Android
   * because it could not (`note` explains why), and on every other platform
   * because those transports are not exposed to the silent character loss that
   * makes the check necessary.
   */
  verified?: boolean;
  /**
   * Advisory prose for a result that needs a caveat: what the read-back found,
   * or why it could not run. Absent when there is nothing to say — a plain
   * verified type, a named-key press, or a platform that does not verify.
   * Carries structural facts and character counts only, never the field's
   * contents, so a typed `{{secret:…}}` cannot leak back through it.
   */
  note?: string;
}
