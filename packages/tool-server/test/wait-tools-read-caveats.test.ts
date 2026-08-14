import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DescribeTreeData } from "../src/tools/describe/contract";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

// Both wait tools answer off one `describe` read, so a read that came with a
// diagnosis of its own has to reach the timeout note either way — it is what
// decides the caller's next move. Stubbing the adapter puts both flags on one
// fixture, which makes this a test of the shared clause builder rather than of
// the iOS path that happens to feed it.
const read = vi.hoisted(() => ({ data: null as DescribeTreeData | null }));
vi.mock("../src/tools/describe/platforms/ios", () => ({
  describeIos: async () => read.data,
  iosRequires: [],
}));

const { createAwaitUiElementTool } = await import("../src/tools/await-ui-element");
const { createAwaitScreenIdleTool } = await import("../src/tools/await-screen-idle");

const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

/** No service is resolved on this path — the adapter above is the whole read. */
const registry = {
  resolveService: vi.fn(async (urn: string) => {
    throw new Error(`unexpected service: ${urn}`);
  }),
} as never;

beforeEach(() => {
  __resetDepCacheForTests();
  __primeDepCacheForTests(["xcrun", "adb"]);
  read.data = {
    tree: { role: "AXApplication", frame: { x: 0, y: 0, width: 1, height: 1 }, children: [] },
    source: "ax-service",
    should_restart: true,
    hint: "the simulator was not booted through argent",
  };
});

describe("a wait that times out on a read with a diagnosis of its own", () => {
  it("tells await-ui-element's caller to restart the app, and why the tree was empty", async () => {
    const tool = createAwaitUiElementTool(registry);

    const result = await tool.execute(
      {},
      {
        udid: IOS_UDID,
        condition: "visible",
        selector: { text: "Submit" },
        timeoutMs: 40,
        pollIntervalMs: 10,
      }
    );

    expect(result.success).toBe(false);
    expect(result.note).toMatch(/restart-app/);
    expect(result.note).toMatch(/not booted through argent/);
  });

  it("tells await-screen-idle's caller the same, rather than only that it did not settle", async () => {
    const tool = createAwaitScreenIdleTool(registry);

    const result = await tool.execute(
      {},
      { udid: IOS_UDID, timeoutMs: 40, pollIntervalMs: 10, minStableMs: 10 }
    );

    expect(result.settled).toBe(false);
    expect(result.note).toMatch(/restart-app/);
    expect(result.note).toMatch(/not booted through argent/);
  });
});
