export interface KeyboardParams {
  udid: string;
  text?: string;
  /**
   * Rejected alongside `text` in ./index.ts, so a backend sees at most one of
   * the two. Not valid on TV targets.
   */
  key?: string;
  delayMs?: number;
}

export interface KeyboardResult {
  typed: string;
  keys: number;
  /**
   * Physical iOS only: the target app was backgrounded and the runner
   * re-fronted it to deliver this input, so the foreground screen changed as
   * a side effect. Set only when true.
   */
  reactivated?: true;
  /**
   * iOS simulator, `open-ios-device-server` flag: the open runner failed (or
   * does not support the key) and the proprietary path typed it. Set only then.
   */
  backend?: "proprietary-fallback";
  fallbackReason?: string;
}
