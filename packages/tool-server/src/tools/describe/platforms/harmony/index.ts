import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { ToolDependency } from "@argent/registry";
import type { DescribeTreeData } from "../../contract";
import { harmonyDisplay, harmonyDumpLayout } from "../../../../utils/harmony-uitest";
import { parseHarmonyLayout } from "./layout-parser";

/** `uitest` runs on the device; reaching it needs only the connector. */
export const harmonyRequires: ToolDependency[] = ["hdc"];

/**
 * Said when the dump has no window at all. `uitest` returns a tree with a bare
 * root while the display is asleep, and an agent that reads that as "the app
 * rendered nothing" will start debugging the app instead of waking the screen.
 */
const ASLEEP_HINT =
  "The display is off, so there is nothing to describe and injected taps would land nowhere. " +
  "Wake it with `button` (power) and describe again.";

const EMPTY_HINT =
  "The layout dump contains no windows. The foreground app may still be starting — " +
  "call describe again, or screenshot to see what is on screen.";

/**
 * Describe the current HarmonyOS screen from `uitest dumpLayout`.
 *
 * The dump is written on the device and copied back, so it needs somewhere to
 * land on the host; the file is temporary and removed once parsed, since
 * describe's contract is the rendered text and nothing downstream reads it.
 */
export async function describeHarmony(connectKey: string): Promise<DescribeTreeData> {
  const localPath = join(tmpdir(), `argent-harmony-dump-${process.hrtime.bigint()}.json`);
  const display = await harmonyDisplay(connectKey);
  try {
    const raw = await harmonyDumpLayout(connectKey, localPath);
    const { tree, screen } = parseHarmonyLayout(raw, {
      width: display.width,
      height: display.height,
    });
    if (tree.children.length === 0) {
      return {
        tree,
        source: "harmony-uitest",
        screen,
        hint: display.screenOn ? EMPTY_HINT : ASLEEP_HINT,
      };
    }
    return { tree, source: "harmony-uitest", screen };
  } finally {
    await rm(localPath, { force: true }).catch(() => {});
  }
}
