import type { z } from "zod";
import type { pasteZodSchema } from "./schema";
import type { OpenServerActionOutcome } from "../../blueprints/android-open-server";

export type PasteParams = z.infer<typeof pasteZodSchema>;

export interface PasteResult {
  pasted: true;
  /**
   * Screen-graph Phase A: present only on the Android open-device-server path.
   * The before/after fingerprint delta of the paste (typed text).
   */
  outcome?: OpenServerActionOutcome;
}

/**
 * No declared services: each branch resolves simulator-server lazily, after
 * rejecting a TV target.
 */
export type PasteServices = Record<string, never>;
