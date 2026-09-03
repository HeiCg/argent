import { describe, expect, it } from "vitest";
import { formatDescribeTree } from "../src/tools/describe/format-tree";
import {
  openServerNestedToDescribeNode,
  type OpenServerNestedElement,
} from "../src/tools/describe/platforms/android/open-server-tree";

// Fixture-based window-filter goldens (phase 3g). Each fixture is the set of
// per-window nested roots the on-device NestedWindowSerializer EMITS after its
// selection rule runs (the selection itself is golden-tested in Kotlin's
// NestedWindowSerializerTest). Here we drive the emitted roots through the exact
// host render pipeline — openServerNestedToDescribeNode (the v2 interactables-only
// trim) + formatDescribeTree — and assert the rendered describe text, so a change
// to either the emitted shape or the render is caught.

const W = 1080;
const H = 2400;

function render(roots: OpenServerNestedElement[]): string {
  return formatDescribeTree(
    openServerNestedToDescribeNode(roots, W, H),
    { source: "open-device-server" }
  );
}

/** A window root (FrameLayout) wrapping children, full-screen bounds by default. */
function windowRoot(
  pkg: string,
  children: OpenServerNestedElement[],
  bounds = { x1: 0, y1: 0, x2: W, y2: H }
): OpenServerNestedElement {
  return { className: "android.widget.FrameLayout", packageName: pkg, bounds, children };
}

function row(text: string, resourceId?: string, bounds?: OpenServerNestedElement["bounds"]): OpenServerNestedElement {
  return {
    className: "android.widget.TextView",
    text,
    clickable: true,
    ...(resourceId ? { resourceId } : {}),
    bounds: bounds ?? { x1: 40, y1: 200, x2: W - 40, y2: 320 },
    children: [],
  };
}

describe("open-server window-filter render goldens (phase 3g)", () => {
  // 1. Settings root — a single active application window.
  it("Settings root: renders the list rows", () => {
    const roots = [
      windowRoot("com.android.settings", [
        row("Network & internet", "com.android.settings:id/title", { x1: 40, y1: 200, x2: 1040, y2: 320 }),
        row("Connected devices", "com.android.settings:id/title", { x1: 40, y1: 340, x2: 1040, y2: 460 }),
        row("Apps", "com.android.settings:id/title", { x1: 40, y1: 480, x2: 1040, y2: 600 }),
      ]),
    ];
    const out = render(roots);
    expect(out).toContain("Network & internet");
    expect(out).toContain("Connected devices");
    expect(out).toContain("Apps");
  });

  // 1b. Byte-identical vs the pre-3e path for Settings: pre-3e serialized ALL
  // windows including system chrome (status bar, TYPE_SYSTEM — which the 3g filter
  // still keeps); the v2 trim drops that chrome either way, so the rendered output
  // is unchanged whether or not the status bar window is emitted.
  it("Settings root: rendered output is byte-identical with or without system chrome (pre-3e parity)", () => {
    const app = windowRoot("com.android.settings", [
      row("Network & internet", "com.android.settings:id/title"),
    ]);
    const statusBar = windowRoot("com.android.systemui", [], { x1: 0, y1: 0, x2: W, y2: 80 });
    expect(render([app])).toBe(render([statusBar, app]));
  });

  // 2. search + IME — active app window plus the non-active IME keyboard window.
  it("search + IME: renders the field and the keyboard keys", () => {
    const roots = [
      windowRoot("com.android.settings", [
        {
          className: "android.widget.EditText",
          contentDesc: "Search settings",
          resourceId: "com.android.settings:id/search_src_text",
          clickable: true,
          focused: true,
          bounds: { x1: 40, y1: 100, x2: 1040, y2: 220 },
          children: [],
        },
      ]),
      windowRoot("com.google.android.inputmethod.latin", [
        { className: "android.inputmethodservice.KeyboardView", contentDesc: "space", clickable: true, bounds: { x1: 200, y1: 2100, x2: 880, y2: 2200 }, children: [] },
      ]),
    ];
    const out = render(roots);
    expect(out).toContain("Search settings");
    expect(out).toContain("space");
  });

  // 3. dialog (after) — the dialog window is active; the app behind is DROPPED by
  // the filter, so its rows must not appear, only the dialog.
  it("dialog: shows the dialog buttons and drops the app behind it", () => {
    const dialogOnly = [
      windowRoot("com.android.settings", [
        { className: "android.widget.TextView", text: "Erase all data?", bounds: { x1: 100, y1: 900, x2: 980, y2: 1000 }, children: [] },
        { className: "android.widget.Button", text: "Cancel", clickable: true, resourceId: "android:id/button2", bounds: { x1: 500, y1: 1100, x2: 700, y2: 1200 }, children: [] },
        { className: "android.widget.Button", text: "Erase", clickable: true, resourceId: "android:id/button1", bounds: { x1: 720, y1: 1100, x2: 980, y2: 1200 }, children: [] },
      ]),
    ];
    const out = render(dialogOnly);
    expect(out).toContain("Erase all data?");
    expect(out).toContain("Cancel");
    expect(out).toContain("Erase");
    // The app-behind row is not in the emitted set → absent from the render.
    expect(out).not.toContain("Network & internet");
  });

  // 3b. dialog (before) — no dialog yet; only the app window is active.
  it("dialog before: the plain app screen renders its rows", () => {
    const out = render([
      windowRoot("com.android.settings", [row("Network & internet", "com.android.settings:id/title")]),
    ]);
    expect(out).toContain("Network & internet");
    expect(out).not.toContain("Erase all data?");
  });

  // 4. two application windows — only the active (incoming) one is emitted; the
  // outgoing activity is dropped.
  it("two app windows: only the active window's content renders", () => {
    const out = render([
      windowRoot("com.android.chrome", [row("New tab", "com.android.chrome:id/title")]),
    ]);
    expect(out).toContain("New tab");
    expect(out).not.toContain("Old page");
  });

  // 5. popup / dropdown — the AutoCompleteTextView dropdown is a NON-active,
  // non-focusable window drawn over the active field. The 3g filter keeps it, so
  // its suggestion items are in the emitted set and must render. This is the
  // regression the fix addresses: under 3e's active+IME/system rule the popup was
  // dropped and its items (the next tap target) vanished from describe.
  it("popup: the dropdown suggestions are present when the popup window is emitted", () => {
    const field = windowRoot("com.android.settings", [
      {
        className: "android.widget.EditText",
        contentDesc: "Search settings",
        clickable: true,
        focused: true,
        bounds: { x1: 40, y1: 100, x2: 1040, y2: 220 },
        children: [],
      },
    ]);
    const popup = windowRoot(
      "com.android.settings",
      [
        row("Wi-Fi", "android:id/text1", { x1: 40, y1: 240, x2: 1040, y2: 340 }),
        row("Wireless debugging", "android:id/text1", { x1: 40, y1: 360, x2: 1040, y2: 460 }),
      ],
      { x1: 40, y1: 230, x2: 1040, y2: 480 }
    );

    const withPopup = render([field, popup]);
    expect(withPopup).toContain("Wi-Fi");
    expect(withPopup).toContain("Wireless debugging");

    // Contrast (3e behavior): had the popup been dropped, the suggestions would be
    // absent — the exact regression the 3g filter fix prevents.
    const withoutPopup = render([field]);
    expect(withoutPopup).not.toContain("Wi-Fi");
    expect(withoutPopup).not.toContain("Wireless debugging");
    expect(withPopup).not.toBe(withoutPopup);
  });
});
