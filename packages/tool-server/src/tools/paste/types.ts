import type { z } from "zod";
import type { pasteZodSchema } from "./schema";
import type { OpenServerActionOutcome } from "../../blueprints/android-open-server";

export type PasteParams = z.infer<typeof pasteZodSchema>;

/**
 * What a platform handler gets: `text` resolved, and `hasSecrets` set when it
 * held a `{{secret:…}}` placeholder. The schema has no such key and zod drops
 * unknown ones, so only `execute` can set it.
 */
export type PasteDispatchParams = PasteParams & { hasSecrets?: boolean };

export interface PasteResult {
  pasted: true;
  /**
   * Screen-graph Phase A: present only on the Android open-device-server path.
   * The before/after fingerprint delta of the paste (typed text).
   */
  outcome?: OpenServerActionOutcome;
  /**
   * Set when the text was typed instead of pasted: a secret, on a simulator
   * Device Hub has opened.
   */
  via?: "keyboard";
}

/**
 * No declared services: each branch resolves simulator-server lazily, after
 * rejecting a TV target.
 */
export type PasteServices = Record<string, never>;
