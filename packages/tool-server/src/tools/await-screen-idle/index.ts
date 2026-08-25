import { z } from "zod";
import type {
  DeviceInfo,
  Registry,
  ServiceRef,
  ToolCapability,
  ToolContext,
  ToolDefinition,
} from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import { isTvOsSimulator } from "../../utils/ios-devices";
import { isAndroidTv } from "../../utils/adb";
import { assertSupported } from "../../utils/capability";
import { ensureDeps } from "../../utils/check-deps";
import { pollDescribeTree } from "../../utils/poll-describe-tree";
import type { DescribeNode, DescribeTreeData } from "../describe/contract";
import { describeIos, iosRequires } from "../describe/platforms/ios";
import { describeAndroid, androidRequires } from "../describe/platforms/android";
import { describeChromium } from "../describe/platforms/chromium";

export const AWAIT_SCREEN_IDLE_TOOL_ID = "await-screen-idle";

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_MIN_STABLE_MS = 250;
// Shared with await-ui-element's timeout note so both wait tools name a failing
// fetch the same way.
const TREE_FETCH_FAILED_NOTE_PREFIX = "last tree fetch failed: ";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID, Android serial, or Chromium id)."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .describe(
      `Max time to wait for the screen to settle before giving up (default ${DEFAULT_TIMEOUT_MS}).`
    ),
  pollIntervalMs: z
    .number()
    .int()
    .min(50)
    .max(5000)
    .optional()
    .describe(`How often to re-read the tree (default ${DEFAULT_POLL_INTERVAL_MS}).`),
  minStableMs: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe(
      `The screen must hold the same content for at least this long to count as settled (default ${DEFAULT_MIN_STABLE_MS}).`
    ),
});

type Params = z.infer<typeof zodSchema>;

interface IdleResult {
  /** Screen rendered content and went still before the timeout. */
  settled: boolean;
  waitedMs: number;
  polls: number;
  /**
   * Present only when `settled: false` does not stand for "the screen kept
   * changing": either the last tree fetch failed outright (the note carries
   * that error), or the budget ran out mid-read, which leaves it standing for
   * "never sampled twice" rather than "kept changing".
   */
  note?: string;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
};

// Frames are normalized 0..1, so rounding to 0.01 tolerates sub-pixel jitter
// while still catching real motion (a slide/fade animation).
function treeSignature(root: DescribeNode): string {
  const round = (n: number) => Math.round(n * 100) / 100;
  const parts: string[] = [];
  const walk = (node: DescribeNode): void => {
    const f = node.frame;
    parts.push(
      `${node.role}|${node.label ?? ""}|${node.value ?? ""}|${round(f.x)},${round(f.y)},${round(f.width)},${round(f.height)}`
    );
    for (const child of node.children) walk(child);
  };
  for (const child of root.children) walk(child);
  return parts.join("\n");
}

// The MCP layer times its auto-screenshot with this: capture once the screen is
// stable instead of after a fixed delay.
export function createAwaitScreenIdleTool(registry: Registry): ToolDefinition<Params, IdleResult> {
  function fetchTree(
    device: DeviceInfo,
    services: Record<string, unknown>,
    isTvOs: boolean,
    androidIsTv: boolean
  ): Promise<DescribeTreeData> {
    if (device.platform === "ios") {
      return describeIos(registry, device, {}, { isTvOs });
    }
    if (device.platform === "android") {
      return describeAndroid(registry, device.id, undefined, androidIsTv);
    }
    return describeChromium(services.chromium as ChromiumCdpApi);
  }

  return {
    id: AWAIT_SCREEN_IDLE_TOOL_ID,
    interaction: {
      startedMsg: () => "Waiting for screen to settle",
      completedMsg: ({ result }) =>
        result.settled
          ? "Screen settled"
          : result.note?.startsWith(TREE_FETCH_FAILED_NOTE_PREFIX)
            ? "Screen read failed before timeout"
            : result.note
              ? "Could not read the screen twice before timeout"
              : "Screen did not settle before timeout",
      failedMsg: ({ failureSignal }) =>
        `Failed while waiting for screen to settle: ${failureSignal.error_code}`,
    },
    description: `Block until the screen has rendered content and stopped changing, or a timeout elapses.

Polls the same accessibility / DOM tree as \`describe\` every pollIntervalMs (default ${DEFAULT_POLL_INTERVAL_MS}ms) until it
has content and that content holds identical for minStableMs (default ${DEFAULT_MIN_STABLE_MS}ms), or timeoutMs (default
${DEFAULT_TIMEOUT_MS}ms) is reached. Returns { settled, waitedMs, polls, note? } — settled=false means the screen never
went still before the timeout, except when a note is present: one kind reports the last tree fetch failing outright
(fix its cause — e.g. unlock the device); the other says the tree could not be read twice inside the budget, so
whether the screen was still went untested and raising timeoutMs is what resolves it. Use after a launch/navigation
to wait for the UI to render before screenshotting or tapping.`,
    searchHint:
      "wait until screen settles idle stable stops changing animation transition rendered ready before screenshot",
    longRunning: true,
    zodSchema,
    capability,
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      if (device.platform === "chromium") {
        return { chromium: chromiumCdpRef(device) };
      }
      return {};
    },
    async execute(services, params, ctx?: ToolContext) {
      const device = resolveDevice(params.udid);
      assertSupported(AWAIT_SCREEN_IDLE_TOOL_ID, capability, device);
      if (device.platform === "ios") await ensureDeps(iosRequires);
      else if (device.platform === "android") await ensureDeps(androidRequires);

      // Hoisted out of the poll loop: `isAndroidTv` runs `adb devices` (plus an
      // avdName getprop) on every call, even on a cache hit, so letting
      // `describeAndroid` probe would pay that per poll.
      const isTvOs = device.platform === "ios" && (await isTvOsSimulator(device.id));
      const androidIsTv = device.platform === "android" && (await isAndroidTv(device.id));
      const minStableMs = params.minStableMs ?? DEFAULT_MIN_STABLE_MS;

      let stableSignature: string | undefined;
      let stableSince = 0;

      const poll = await pollDescribeTree<true>({
        fetchTree: () => fetchTree(device, services, isTvOs, androidIsTv),
        timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        pollIntervalMs: params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        signal: ctx?.signal,
        onSample: (data, nowMs) => {
          // An empty tree (blank/loading, or a degraded AX read) is not settled.
          if (data.tree.children.length === 0) {
            stableSignature = undefined;
            stableSince = 0;
            return { done: false };
          }
          const signature = treeSignature(data.tree);
          if (signature === stableSignature) {
            if (nowMs - stableSince >= minStableMs) return { done: true, result: true };
          } else {
            stableSignature = signature;
            stableSince = nowMs;
            if (minStableMs === 0) return { done: true, result: true };
          }
          return { done: false };
        },
      });

      const settled = poll.result === true;
      // A fetch that failed outright — a locked screen, a dead helper — must
      // reach the agent as itself rather than be folded into the latency
      // diagnosis below: every fetch failing also leaves `samples` at 0, and
      // telling the agent to raise timeoutMs there is advice that cannot help.
      // `lastAttemptSettled` keeps this from misfiring on the other arm of the
      // caveat: the loop leaves `lastError` set (to its own budget-expiry
      // message) for a read it abandoned at the deadline, and THAT case is a
      // read too slow to finish, not a failing one. See `lastAttemptSettled` in
      // poll-describe-tree.
      if (!settled && poll.lastAttemptSettled && poll.lastError !== undefined) {
        return {
          settled,
          waitedMs: poll.elapsedMs,
          polls: poll.polls,
          note: `${TREE_FETCH_FAILED_NOTE_PREFIX}${poll.lastError}`,
        };
      }
      return {
        settled,
        waitedMs: poll.elapsedMs,
        polls: poll.polls,
        // Settling takes two samples that agree across minStableMs. A tree too
        // slow to read twice inside the budget never yields the second one, so
        // `settled: false` here would otherwise stand for "the screen kept
        // changing" on a screen that may have been perfectly still — the reader
        // simply never got to compare it with itself. Say which of the two
        // happened, and name the knob that fixes this one. The test is how many
        // samples came back, not whether the final read straddled the deadline:
        // the loop reads until the budget is gone, so the last one is cut off on
        // almost every timeout however fast the reads are.
        ...(!settled && poll.samples < 2
          ? {
              note:
                `reading the tree did not finish within the ${params.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms budget, ` +
                `so the screen was never sampled twice — this is a read that outran the budget, not an observed change. ` +
                `Raise timeoutMs for a tree this large.`,
            }
          : {}),
      };
    },
  };
}
