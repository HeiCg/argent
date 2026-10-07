import { z } from "zod";

import type { Registry, ToolContext, ToolDefinition } from "@argent/registry";
import { InvalidToolInputError } from "../../utils/capability";
import { DeviceMutexManager } from "../../utils/device-mutex";
import { SECRET_PLACEHOLDER_MARKER } from "../../utils/secrets";
import { invokeSubTool } from "../../utils/sub-invoke";
import {
  ALLOWED_TOOLS,
  runSequenceOnDevice,
  sequenceStepSchema,
  type StepResult,
} from "../run-sequence";

export const MIN_DEVICES = 2;
export const MAX_DEVICES = 8;

const zodSchema = z.object({
  udids: z
    .array(z.string())
    .min(MIN_DEVICES)
    .max(MAX_DEVICES)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "udids must be distinct: a device id appears more than once",
    })
    .describe(
      `Target device ids from \`list-devices\`, ${MIN_DEVICES} to ${MAX_DEVICES}, all distinct. Every device runs the same steps.`
    ),
  steps: z
    .array(sequenceStepSchema)
    .min(1)
    .describe(
      "Ordered list of interaction steps, the same shape and the same allowed tools as in run-sequence. Do NOT include udid in args: each device gets its own id."
    ),
  screenshots: z
    .enum(["none", "final"])
    .optional()
    .default("none")
    .describe(
      'Default "none": no image is attached. "final" takes one screenshot per device after its last step and attaches one image per device.'
    ),
  stopOnFirstFailure: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Default false: a failure stops only the sequence on that device. true also stops every other device before its next step."
    ),
});

type Params = z.input<typeof zodSchema>;

export type DeviceRunResult = {
  udid: string;
  ok: boolean;
  steps: StepResult[];
  error?: string;
  durationMs: number;
  screenshot?: unknown;
  screenshotError?: string;
};

export type RunOnDevicesResult = {
  results: DeviceRunResult[];
  okCount: number;
  failedCount: number;
};

/**
 * Serializes whole sequences per device, so two `run-on-devices` calls that
 * share a device take turns on it instead of interleaving their steps.
 *
 * A separate manager from `openDeviceServerMutex` on purpose: that lock is not
 * re-entrant, and the gesture tools take it inside each step, so holding it for
 * the whole sequence would deadlock the first step on an open-server device.
 */
const sequenceMutex = new DeviceMutexManager();

function validate(params: Params): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const udid of params.udids) {
    if (seen.has(udid)) duplicates.add(udid);
    seen.add(udid);
  }
  if (duplicates.size > 0) {
    throw new InvalidToolInputError(
      `run-on-devices: duplicate device id ${[...duplicates].map((d) => `"${d}"`).join(", ")}. Give each device once.`
    );
  }
  const refused = params.steps.map((s) => s.tool).filter((tool) => !ALLOWED_TOOLS.has(tool));
  if (refused.length > 0) {
    throw new InvalidToolInputError(
      `run-on-devices: tool "${refused[0]}" is not allowed in a step. Allowed: ${[...ALLOWED_TOOLS].join(", ")}. No device ran any step.`
    );
  }
}

function settledError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function createRunOnDevicesTool(
  registry: Registry
): ToolDefinition<Params, RunOnDevicesResult> {
  return {
    id: "run-on-devices",
    interaction: {
      startedMsg: ({ params }) => `Running a sequence on ${params.udids.length} devices`,
      completedMsg: ({ result }) =>
        `Ran a sequence on ${result.okCount + result.failedCount} devices (${result.okCount} ok, ${result.failedCount} failed)`,
      failedMsg: ({ failureSignal }) =>
        `Failed to run a sequence on several devices: ${failureSignal.error_code}`,
    },
    description: `Run the SAME interaction steps on several devices (simulators, emulators, physical devices) in parallel, in one call.
Use when one action must happen on more than one device: for example the same login on an iPhone simulator and an Android emulator, or a check that a screen behaves the same on 3 emulators. For one device, use run-sequence.

Each device runs the steps with exactly the run-sequence semantics: same allowed tools, same args, udid injected per device, a failure or an unmet await-ui-element condition stops the rest of the steps ON THAT DEVICE. The devices run in parallel; a failure on one device does not stop the others unless stopOnFirstFailure is true.
Coordinates are normalized (0-1) PER DEVICE: { x: 0.5, y: 0.9 } is the bottom center on every device, but the element under it can differ between screen sizes and platforms. Prefer steps whose targets sit at the same relative position, or use await-ui-element to confirm a screen.

Args: { udids: [${MIN_DEVICES}..${MAX_DEVICES} distinct ids], steps: [same as run-sequence], screenshots?: "none" | "final" (default "none"), stopOnFirstFailure?: boolean (default false) }.
Refused before any device runs a step: a duplicate udid, or a step tool that run-sequence does not allow.

Returns { results: [{ udid, ok, steps, error?, durationMs, screenshot? }], okCount, failedCount }, one entry per udid in the order given. steps holds the per-step results of that device, as in run-sequence.
The result can be large: it carries every step result of every device. With screenshots "none" no image is attached. With "final" one image per device is attached; match an image to its device by the saved path in that device's screenshot field. A step that types a {{secret:...}} placeholder skips the final screenshots.`,
    longRunning: true,
    searchHint: "parallel several multiple devices emulators simulators same steps fan-out",
    zodSchema,
    // Each step resolves its own services through the registry, as in run-sequence.
    services: () => ({}),
    async execute(_services, params, ctx?: ToolContext) {
      validate(params);
      const { udids, steps } = params;
      const screenshots = params.screenshots ?? "none";
      const stopOnFirstFailure = params.stopOnFirstFailure ?? false;
      // The capture would show the typed plaintext in a field that is not a
      // secure-entry field, the same reason the MCP layer skips run-sequence's.
      const captureFinal =
        screenshots === "final" && !JSON.stringify(steps).includes(SECRET_PLACEHOLDER_MARKER);

      let failed = false;
      const shouldStop = () => stopOnFirstFailure && failed;

      const runDevice = (udid: string): Promise<DeviceRunResult> =>
        sequenceMutex.withDeviceLock(udid, async () => {
          const startedAt = performance.now();
          let entry: DeviceRunResult;
          try {
            const run = await runSequenceOnDevice(registry, ctx, udid, steps, shouldStop);
            const ok = run.completed === run.total;
            entry = { udid, ok, steps: run.steps, durationMs: 0 };
            if (!ok) {
              const last = run.steps[run.steps.length - 1];
              if (last && "error" in last) {
                entry.error = `step ${run.steps.length} (${last.tool}): ${last.error}`;
              } else if (ctx?.signal?.aborted) {
                entry.error = `aborted after ${run.completed} of ${run.total} steps`;
              } else {
                entry.error = `stopped after ${run.completed} of ${run.total} steps: another device failed (stopOnFirstFailure)`;
              }
            }
          } catch (err) {
            entry = { udid, ok: false, steps: [], error: settledError(err), durationMs: 0 };
          }
          entry.durationMs = Math.round(performance.now() - startedAt);
          if (!entry.ok) failed = true;

          if (captureFinal && !ctx?.signal?.aborted) {
            try {
              entry.screenshot = await invokeSubTool(registry, ctx, "screenshot", { udid });
            } catch (err) {
              entry.screenshotError = settledError(err);
            }
          }
          return entry;
        });

      const settled = await Promise.allSettled(udids.map(runDevice));
      const results = settled.map(
        (s, i): DeviceRunResult =>
          s.status === "fulfilled"
            ? s.value
            : {
                udid: udids[i]!,
                ok: false,
                steps: [],
                error: settledError(s.reason),
                durationMs: 0,
              }
      );
      const okCount = results.filter((r) => r.ok).length;
      return { results, okCount, failedCount: results.length - okCount };
    },
  };
}
