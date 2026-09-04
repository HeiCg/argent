import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseUiAutomatorDump } from "../src/tools/describe/platforms/android/uiautomator-parser";
import {
  compactNestedRoots,
  openServerNestedToDescribeNode,
  type OpenServerNestedElement,
} from "../src/tools/describe/platforms/android/open-server-tree";
import { formatDescribeTree } from "../src/tools/describe/format-tree";

function countNested(roots: OpenServerNestedElement[]): number {
  let n = 0;
  const walk = (a: OpenServerNestedElement[]): void => {
    for (const e of a) {
      n++;
      if (e.children) walk(e.children);
    }
  };
  walk(roots);
  return n;
}

const W = 1080;
const H = 2400;

/**
 * F14 golden: the proprietary `uiautomator dump` XML path and the open server's
 * nested-JSON path must run the IDENTICAL v2 interactables-only trim, so equivalent
 * input yields byte-identical describe output. Each fixture is authored twice — as
 * `<hierarchy>` XML and as the equivalent nested JSON — and both must produce the
 * same DescribeNode tree and the same rendered text.
 */

// ---- Fixture 1: a plain app screen (clickable row + a static label). ----

const SCREEN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" package="com.x" bounds="[0,0][1080,2400]">
    <node class="android.widget.Button" resource-id="com.x:id/login" text="Login" clickable="true" bounds="[0,0][400,200]" />
    <node class="android.widget.TextView" resource-id="com.x:id/title" text="Battery" bounds="[0,300][500,400]" />
  </node>
</hierarchy>`;

const SCREEN_NESTED: OpenServerNestedElement[] = [
  {
    className: "android.widget.FrameLayout",
    packageName: "com.x",
    bounds: { x1: 0, y1: 0, x2: 1080, y2: 2400 },
    children: [
      {
        className: "android.widget.Button",
        resourceId: "com.x:id/login",
        text: "Login",
        clickable: true,
        bounds: { x1: 0, y1: 0, x2: 400, y2: 200 },
      },
      {
        className: "android.widget.TextView",
        resourceId: "com.x:id/title",
        text: "Battery",
        bounds: { x1: 0, y1: 300, x2: 500, y2: 400 },
      },
    ],
  },
];

// ---- Fixture 2: app window + dialog window + IME window (multi-window, F11). ----

const DIALOG_IME_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" package="com.x" bounds="[0,0][1080,2400]">
    <node class="android.widget.Button" resource-id="com.x:id/ok" text="OK" clickable="true" bounds="[0,0][300,150]" />
  </node>
  <node class="android.widget.FrameLayout" package="com.x" bounds="[100,900][980,1500]">
    <node class="android.widget.TextView" text="Delete item?" bounds="[140,940][940,1040]" />
    <node class="android.widget.Button" resource-id="com.x:id/cancel" text="Cancel" clickable="true" bounds="[600,1360][900,1470]" />
  </node>
  <node class="android.inputmethodservice.SoftInputWindow" package="com.google.android.inputmethod.latin" bounds="[0,1600][1080,2400]">
    <node class="android.widget.Button" content-desc="a" clickable="true" bounds="[0,1700][120,1820]" />
  </node>
</hierarchy>`;

const DIALOG_IME_NESTED: OpenServerNestedElement[] = [
  {
    className: "android.widget.FrameLayout",
    packageName: "com.x",
    bounds: { x1: 0, y1: 0, x2: 1080, y2: 2400 },
    children: [
      {
        className: "android.widget.Button",
        resourceId: "com.x:id/ok",
        text: "OK",
        clickable: true,
        bounds: { x1: 0, y1: 0, x2: 300, y2: 150 },
      },
    ],
  },
  {
    className: "android.widget.FrameLayout",
    packageName: "com.x",
    bounds: { x1: 100, y1: 900, x2: 980, y2: 1500 },
    children: [
      {
        className: "android.widget.TextView",
        text: "Delete item?",
        bounds: { x1: 140, y1: 940, x2: 940, y2: 1040 },
      },
      {
        className: "android.widget.Button",
        resourceId: "com.x:id/cancel",
        text: "Cancel",
        clickable: true,
        bounds: { x1: 600, y1: 1360, x2: 900, y2: 1470 },
      },
    ],
  },
  {
    className: "android.inputmethodservice.SoftInputWindow",
    packageName: "com.google.android.inputmethod.latin",
    bounds: { x1: 0, y1: 1600, x2: 1080, y2: 2400 },
    children: [
      {
        className: "android.widget.Button",
        contentDesc: "a",
        clickable: true,
        bounds: { x1: 0, y1: 1700, x2: 120, y2: 1820 },
      },
    ],
  },
];

describe("F14: XML dump vs open-server nested tree — identical v2 trim", () => {
  it("plain screen: identical DescribeNode tree and rendered text", () => {
    const fromXml = parseUiAutomatorDump(SCREEN_XML, W, H);
    const fromNested = openServerNestedToDescribeNode(SCREEN_NESTED, W, H);
    expect(fromNested).toEqual(fromXml);

    const xmlText = formatDescribeTree(fromXml, { source: "android-devtools" });
    const nestedText = formatDescribeTree(fromNested, { source: "open-device-server" });
    // Same body (headers differ only by the `Source:` line naming the backend).
    expect(bodyOf(nestedText)).toEqual(bodyOf(xmlText));
    // Sanity: the trim actually kept the row and label.
    expect(xmlText).toContain('"Login"');
    expect(xmlText).toContain('id="com.x:id/login"');
    expect(xmlText).toContain('"Battery"');
  });

  it("dialog + IME multi-window: identical tree, windows in the same order", () => {
    const fromXml = parseUiAutomatorDump(DIALOG_IME_XML, W, H);
    const fromNested = openServerNestedToDescribeNode(DIALOG_IME_NESTED, W, H);
    expect(fromNested).toEqual(fromXml);

    const text = formatDescribeTree(fromNested, { source: "open-device-server" });
    // All three windows survive the trim (IME is not systemui chrome).
    expect(text).toContain('"OK"');
    expect(text).toContain('"Delete item?"');
    expect(text).toContain('"Cancel"');
    expect(text).toContain('"a"');
    // Deterministic order: app window's OK before the dialog's Cancel before the
    // IME key (F11 — the array/window order is preserved through the trim).
    expect(text.indexOf('"OK"')).toBeLessThan(text.indexOf('"Cancel"'));
    expect(text.indexOf('"Cancel"')).toBeLessThan(text.indexOf('"a"'));
  });
});

describe("phase 3j: compact payload lowers to the byte-identical DescribeNode", () => {
  // The contract for the on-device `compact:true` capture: the server drops the
  // nodes/fields the host v2 trim discards anyway, and the SAME host lowering must
  // produce the identical DescribeNode from the compacted payload as from the full
  // one. `compactNestedRoots` is the host mirror of that server-side drop; the
  // on-device serializer applies the identical rules.
  const REAL_FIXTURE = (() => {
    const path = join(
      __dirname,
      "..",
      "scripts",
      "fixtures",
      "describe-host-idle-settings.nested.json"
    );
    return JSON.parse(readFileSync(path, "utf8")) as {
      screen: { width: number; height: number };
      tree: OpenServerNestedElement[];
    };
  })();

  const cases: Array<{ name: string; roots: OpenServerNestedElement[]; w: number; h: number }> = [
    { name: "plain screen", roots: SCREEN_NESTED, w: W, h: H },
    { name: "dialog + IME multi-window", roots: DIALOG_IME_NESTED, w: W, h: H },
    {
      name: "committed idle-Settings capture",
      roots: REAL_FIXTURE.tree,
      w: REAL_FIXTURE.screen.width,
      h: REAL_FIXTURE.screen.height,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: compact vs non-compact produce identical DescribeNode trees`, () => {
      const full = openServerNestedToDescribeNode(c.roots, c.w, c.h);
      const compacted = openServerNestedToDescribeNode(compactNestedRoots(c.roots), c.w, c.h);
      expect(compacted).toEqual(full);
      // And the rendered text is byte-identical too (the token/label contract).
      expect(formatDescribeTree(compacted, { source: "open-device-server" })).toEqual(
        formatDescribeTree(full, { source: "open-device-server" })
      );
    });
  }

  it("actually drops nodes on scaffold-heavy trees (the compaction is not a no-op)", () => {
    const before = countNested(REAL_FIXTURE.tree);
    const after = countNested(compactNestedRoots(REAL_FIXTURE.tree));
    expect(after).toBeLessThan(before);
  });

  it("is idempotent (compacting a compacted tree changes nothing)", () => {
    const once = compactNestedRoots(REAL_FIXTURE.tree);
    const twice = compactNestedRoots(once);
    expect(twice).toEqual(once);
  });
});

/** Drop the header block (everything up to and including the ROOT line). */
function bodyOf(rendered: string): string {
  const lines = rendered.split("\n");
  const rootIdx = lines.findIndex((l) => l.startsWith("ROOT "));
  return lines.slice(rootIdx + 1).join("\n");
}
