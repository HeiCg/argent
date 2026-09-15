import { z } from "zod";

import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { UnsupportedOperationError } from "../../utils/capability";
import {
  shouldUseOpenServer,
  openServerSequence,
  type SequenceStep,
  type SequenceResult,
} from "../../utils/open-server-input";

/**
 * Artemis A2 §A — `gesture-sequence`: a burst of tap/swipe/key/wait steps run
 * back-to-back ON THE DEVICE in one `batch` RPC (no host round trip per step), so
 * a transient sheet can be dismissed and the revealed control tapped before it
 * disappears. Android open-device-server only.
 */

const targetSchema = z
  .object({
    index: z.number().int().min(0).describe('0-based index from a `describe` `tier:"index"` line'),
    version: z
      .number()
      .int()
      .describe("The AX version the index tier was rendered at (its header names it)"),
  })
  .describe(
    'Tap the element at this index from the last `describe` `tier:"index"` read, resolved on the ' +
      "device against the SAME snapshot version — refused as stale_index if the screen moved."
  );

const stepSchema = z
  .object({
    kind: z.enum(["tap", "swipe", "key", "wait"]).describe("Step type"),
    // tap
    x: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("tap: normalized x (0–1). Ignored with `target`."),
    y: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("tap: normalized y (0–1). Ignored with `target`."),
    clickCount: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("tap: multi-tap count (default 1)"),
    target: targetSchema.optional(),
    // swipe
    fromX: z.number().min(0).max(1).optional().describe("swipe: start x (0–1)"),
    fromY: z.number().min(0).max(1).optional().describe("swipe: start y (0–1)"),
    toX: z.number().min(0).max(1).optional().describe("swipe: end x (0–1)"),
    toY: z.number().min(0).max(1).optional().describe("swipe: end y (0–1)"),
    durationMs: z.number().min(0).optional().describe("swipe: wall-clock duration (default 300)"),
    momentum: z
      .boolean()
      .optional()
      .describe("swipe: default true (flinging); false lands where the finger lifts"),
    // key
    key: z.string().optional().describe('key: key name (e.g. "enter", "back", "home")'),
    // wait
    waitMs: z.number().min(0).optional().describe("wait: on-device pause in ms"),
    // common
    delayMs: z
      .number()
      .min(0)
      .optional()
      .describe("On-device pause AFTER this step, before the next (default 0)"),
  })
  .describe("One interaction step");

const zodSchema = z.object({
  udid: z.string().min(1).describe("Target Android device serial from `list-devices`."),
  steps: z
    .array(stepSchema)
    .min(1)
    .describe("Ordered burst of steps, run back-to-back on the device in one RPC."),
});

type Params = z.infer<typeof zodSchema>;

// Android-only: a burst needs the on-device batch RPC. Other platforms have no
// equivalent single-RPC path, so this tool is not offered there.
const capability: ToolCapability = {
  android: { emulator: true, device: true, unknown: true },
};

/** Lower a validated schema step to the {@link SequenceStep} the open path runs. */
function toSequenceStep(step: Params["steps"][number]): SequenceStep {
  switch (step.kind) {
    case "tap":
      return {
        kind: "tap",
        ...(step.x !== undefined ? { x: step.x } : {}),
        ...(step.y !== undefined ? { y: step.y } : {}),
        ...(step.clickCount !== undefined ? { clickCount: step.clickCount } : {}),
        ...(step.target !== undefined ? { target: step.target } : {}),
        ...(step.delayMs !== undefined ? { delayMs: step.delayMs } : {}),
      };
    case "swipe":
      return {
        kind: "swipe",
        fromX: step.fromX ?? 0.5,
        fromY: step.fromY ?? 0.5,
        toX: step.toX ?? 0.5,
        toY: step.toY ?? 0.5,
        ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
        ...(step.momentum !== undefined ? { momentum: step.momentum } : {}),
        ...(step.delayMs !== undefined ? { delayMs: step.delayMs } : {}),
      };
    case "key":
      return {
        kind: "key",
        key: step.key ?? "",
        ...(step.delayMs !== undefined ? { delayMs: step.delayMs } : {}),
      };
    default:
      return {
        kind: "wait",
        waitMs: step.waitMs ?? step.delayMs ?? 0,
        ...(step.delayMs !== undefined ? { delayMs: step.delayMs } : {}),
      };
  }
}

export function createGestureSequenceTool(
  registry: Registry
): ToolDefinition<Params, SequenceResult> {
  return {
    id: "gesture-sequence",
    interaction: {
      startedMsg: ({ params }) => `Running ${params.steps.length}-step gesture burst`,
      completedMsg: ({ params }) => `Ran ${params.steps.length}-step gesture burst`,
      failedMsg: ({ failureSignal }) => `Failed to run gesture burst: ${failureSignal.error_code}`,
    },
    description: `Android open-device-server: run a BURST of tap/swipe/key/wait steps back-to-back on the device in ONE round-trip (no host call per step).
Use when the steps must land fast enough that a transient element survives — e.g. dismiss a bottom sheet, then tap the control it revealed, before it animates away.
Each step: { kind: "tap"|"swipe"|"key"|"wait", ...params, delayMs? }. delayMs pauses ON THE DEVICE after the step.
  tap:   { x, y } normalized 0–1, or { target: { index, version } } from a describe tier:"index" line; clickCount? (multi-tap)
  swipe: { fromX, fromY, toX, toY } normalized 0–1; durationMs?; momentum? (false = lands where the finger lifts)
  key:   { key: "enter"|"back"|"home"|... }
  wait:  { waitMs } — a pure on-device pause (the beat between a dismiss and the revealed tap)
Returns { completed, total, totalMs, steps: [{ kind, success, dropped?, ms, skipped? }] }.
Skip semantics: on the FIRST failing step the remaining steps do NOT run and are reported as skipped — the burst stops the moment a dismiss/tap misses.
A stale index target (the screen moved since the describe) is refused BEFORE anything is injected.
At most ONE index target per burst: every index resolves against the ONE snapshot read before the burst, so a second index target — which would land on a screen an earlier step navigated away from — is refused (stale_index_in_burst). Use an index target as the first acting step; tap later transient controls by coordinate.
When you need to OBSERVE the screen between steps, use single tool calls instead; this tool is for known-in-advance bursts.`,
    // Not alwaysLoad (A2-M8): this is an Android-open-device-server-only tool (918
    // tokens of schema+description); the searchHint surfaces it when a burst is
    // needed rather than carrying it in every session on every platform.
    alwaysLoad: false,
    longRunning: true,
    searchHint: "sequence burst batch transient sheet dismiss tap swipe key index target one rpc",
    zodSchema,
    capability,
    services: () => ({}),
    async execute(_services, params) {
      const device = resolveDevice(params.udid);
      if (!shouldUseOpenServer(device)) {
        throw new UnsupportedOperationError(
          "gesture-sequence",
          device,
          "requires the Android open-device-server (`open-device-server` flag); use run-sequence for the proprietary path"
        );
      }
      // A stale/out-of-range index target (IndexTargetError) is thrown BEFORE any
      // injection; it carries the `stale_index` / `index_out_of_range` message
      // straight through, so the caller sees the refusal.
      return openServerSequence(registry, device, params.steps.map(toSequenceStep));
    },
  };
}
