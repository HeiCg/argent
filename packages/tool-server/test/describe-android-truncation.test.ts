// The android-devtools helper walks a screen under a node-count limit and a
// tree-depth limit, and reports one `truncated` flag for either — measured on
// an API 35 emulator, where `maxDepth: 3` with `maxNodes: 5000` came back
// truncated at 11 nodes. A truncated capture is indistinguishable from a
// complete one once it has been rendered as text, so `describe` has to say when
// the tree is partial — a WebView's web DOM can spend the whole node budget on
// a single page.
import { describe, it, expect, vi } from "vitest";
import { describeAndroid } from "../src/tools/describe/platforms/android";
import type { AndroidDevtoolsApi } from "../src/blueprints/android-devtools";
import type { Registry } from "@argent/registry";

const SERIAL = "emulator-5554";
const XML =
  `<hierarchy rotation="0">` +
  `<node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">` +
  `<node text="Sign in" class="android.widget.Button" clickable="true" bounds="[100,200][980,320]" />` +
  `</node></hierarchy>`;

function registryWith(truncated: boolean): Registry {
  const android: AndroidDevtoolsApi = {
    getHierarchy: async () => ({
      xml: XML,
      captureMode: "helper",
      windowCount: 1,
      nodeCount: 5000,
      truncated,
      elapsedMs: 1,
    }),
    getScreenSize: async () => ({ width: 1080, height: 2400, rotation: 0 }),
  } as unknown as AndroidDevtoolsApi;
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("AndroidDevtools:")) return android;
      throw new Error(`unexpected service: ${urn}`);
    }),
  } as unknown as Registry;
}

describe("describeAndroid — partial capture", () => {
  it("tells the agent when the helper stopped at a walk limit", async () => {
    const data = await describeAndroid(registryWith(true), SERIAL, undefined, false);
    expect(data.source).toBe("android-devtools");
    expect(data.hint).toContain("PARTIAL");
    // The helper reports one flag for both of its limits, so the hint must not
    // promise that a smaller region recovers the missing content.
    expect(data.hint).toContain("too deep returns the same partial tree");
    // The tree it did capture is still returned — a partial read beats none.
    expect(data.tree.children.length).toBeGreaterThan(0);
  });

  it("stays silent when the whole screen fit in the capture", async () => {
    const data = await describeAndroid(registryWith(false), SERIAL, undefined, false);
    expect(data.hint).toBeUndefined();
  });
});
