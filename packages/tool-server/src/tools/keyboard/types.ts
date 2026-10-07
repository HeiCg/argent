import type { IosInputBackend, SimInputResultFields } from "../../blueprints/ios-sim-input";

export interface KeyboardParams {
  udid: string;
  text?: string;
  /**
   * Rejected alongside `text` in ./index.ts, so a backend sees at most one of
   * the two. Not valid on TV targets.
   */
  key?: string;
  delayMs?: number;
  /**
   * Set by the keyboard tool when `text` was resolved from a `{{secret:...}}`
   * placeholder. Not a tool parameter. The iOS-simulator backend then keeps the
   * text off sim-input.
   */
  containsSecret?: true;
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
  /**
   * iOS simulator, `open-ios-device-server` flag: why the first backend did not
   * serve the input (sim-input, then the runner). Set only on a fallback.
   */
  fallbackReason?: string;
  /** iOS simulator, `open-ios-device-server` flag: the backend that typed. */
  inputBackend?: IosInputBackend;
  /** `inputBackend: "sim-input"` only: the ack's timing. */
  simInput?: SimInputResultFields;
  /**
   * The text reached sim-input and then failed: some characters may have landed
   * before the next backend typed the whole text again.
   */
  partialTextPossible?: true;
}
