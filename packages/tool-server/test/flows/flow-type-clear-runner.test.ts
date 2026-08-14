import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const ANDROID_DEVICE = "emulator-5554";
/** Mirrors `flow-actions`'s own constant — the budget the early exit dodges. */
const TYPE_FOCUS_TIMEOUT_MS = 3000;
let tmpDir: string;

interface Call {
  id: string;
  args: Record<string, unknown>;
}

/**
 * Android hierarchy with one EditText holding `text` and reporting focus,
 * shaped like a real device: the hint arrives as `content-desc` (the node's
 * LABEL) and the entered contents as `text` (its VALUE).
 *
 * The focus matters, and so does WHERE it sits: `runType` dispatches a
 * destructive clear only when a focus-flagged node is INSIDE the target's frame
 * — here they are the same node — or when the tree flags focus nowhere at all
 * (`noFocusXml`). Focus reported elsewhere (`unfocusedXml`) or on a node that
 * merely covers the target (`enclosingFocusXml`) refuses.
 */
const fieldXml = (text: string) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="${text}" focused="true" package="com.acme.app" bounds="[40,200][1040,280]" />
  </node>
</hierarchy>`;

/**
 * The mis-target: the tap never moves focus, so the `email` field the step aims
 * at is NOT focused and a second field elsewhere on screen holds focus instead.
 * Keys injected here reach `other`, not `email` — the shape behind a selector
 * that resolves to a label or a wrapper, and behind any app whose control
 * refuses focus on tap.
 */
const unfocusedXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="" package="com.acme.app" bounds="[40,200][1040,280]" />
    <node index="1" class="android.widget.EditText" resource-id="other" content-desc="Display name" text="do not erase me" focused="true" package="com.acme.app" bounds="[40,600][1040,680]" />
  </node>
</hierarchy>`;

/**
 * A tree that reports focus on NO node at all — the shape an iOS build whose
 * injected framework predates the `firstResponder` field produces, where
 * `getFullHierarchy` simply omits it. Distinct from `unfocusedXml`: there the
 * tree can see focus and says it is elsewhere; here it cannot see focus at all,
 * which is no evidence against the clear. Verified on an iPhone 16 Pro, where
 * conflating the two refused every clear on the platform.
 */
const noFocusXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" package="com.acme.app" bounds="[40,200][1040,280]" />
  </node>
</hierarchy>`;

/**
 * The shape an overlap test cannot tell from a real confirmation: the only
 * focus-flagged node CONTAINS the target rather than sitting inside it.
 *
 * Measured on a live Chromium page as a screen-spanning shadow host (whose
 * `document.activeElement` is the host, never the inner element) with an input
 * of its own holding the keys, and again as a `focusin` focus trap on an
 * ordinary `<textarea>`. In both, a clear aimed at `email` emptied the ENCLOSING
 * element and left `email` untouched while the step reported a pass.
 */
const enclosingFocusXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.webkit.WebView" resource-id="host" content-desc="Editor" text="do not erase me" focused="true" package="com.acme.app" bounds="[0,100][1080,1900]" />
    <node index="1" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" package="com.acme.app" bounds="[40,200][1040,280]" />
  </node>
</hierarchy>`;

/**
 * The overlay: a focused input sitting INSIDE the named field's box without
 * being it — a mention/autocomplete popover over a composer. What separates it
 * from `wrapperFocusXml` below is where the TAP lands: the overlay sits clear
 * of the named element's centre, so the gesture went to the named element and
 * the focus is somebody else's.
 */
const overlayFocusXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" package="com.acme.app" bounds="[40,200][1040,600]" />
    <node index="1" class="android.widget.EditText" resource-id="suggestions" content-desc="Suggestions" text="do not erase me" focused="true" package="com.acme.app" bounds="[80,300][900,380]" />
  </node>
</hierarchy>`;

/**
 * The legitimate non-identity case the containment test has to keep working:
 * the selector names a testID wrapper and focus is reported by the input INSIDE
 * it. A second focused node sits elsewhere on screen, so the verdict cannot
 * come from "something, somewhere, is focused".
 */
const wrapperFocusXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="email-wrapper" package="com.acme.app" bounds="[40,180][1040,300]">
      <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" focused="true" package="com.acme.app" bounds="[40,200][1040,280]" />
    </node>
    <node index="1" class="android.widget.EditText" resource-id="other" content-desc="Display name" text="do not erase me" focused="true" package="com.acme.app" bounds="[40,600][1040,680]" />
  </node>
</hierarchy>`;

/**
 * The everyday label-above-input shape: a `{ text: Email }` selector matches the
 * LABEL as a substring and the field exactly, so the two halves of a `type` step
 * must resolve it the same way. The ranked resolver picks the field for both;
 * an unranked reading-order pick took the label for the focus check while the
 * tap went to the field, and the identity test could then never match — a
 * `clear` hard-failed pointing at a selector that already resolves correctly.
 */
const labelAboveFieldXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.TextView" text="Email address" package="com.acme.app" bounds="[40,100][540,140]" />
    <node index="1" class="android.widget.EditText" resource-id="email" content-desc="Email" text="old.remembered.login" focused="true" package="com.acme.app" bounds="[40,300][1040,380]" />
  </node>
</hierarchy>`;

/**
 * The same enclosing shape as `enclosingFocusXml`, but only just: the focused
 * WebView clears the target by `pad` px on every side. The containment
 * epsilon's slack is per-EDGE, so a symmetric pad well under it made an
 * ENCLOSING node satisfy "sits inside the target" and take the clear — a pass
 * on a field the step never touched. Comparing extents instead is what pins the
 * value: at FRAME_CONTAINMENT_EPSILON = 0.005 on a 1080x1920 screen, a pad of
 * 4px already widens the frame past the tolerance.
 */
const enclosingByPadXml = (pad: number) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.webkit.WebView" resource-id="host" content-desc="Editor" text="do not erase me" focused="true" package="com.acme.app" bounds="[${40 - pad},${200 - pad}][${1040 + pad},${280 + pad}]" />
    <node index="1" class="android.view.ViewGroup" resource-id="email-wrapper" package="com.acme.app" bounds="[40,200][1040,280]" />
  </node>
</hierarchy>`;

/**
 * A row wrapper over TWO inputs, with focus on the one the tap does NOT land
 * on. Containment alone accepts it — `currency` is inside `amount-row` — and
 * the step then clears and rewrites a field the report never names. The tap
 * goes to the row's centre (540px), which is inside `amount`.
 */
const twoInputRowXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="amount-row" package="com.acme.app" bounds="[40,200][1040,280]">
      <node index="0" class="android.widget.EditText" resource-id="currency" content-desc="Currency" text="USD" focused="true" package="com.acme.app" bounds="[40,200][240,280]" />
      <node index="1" class="android.widget.EditText" resource-id="amount" content-desc="Amount" text="0.00" package="com.acme.app" bounds="[280,200][1040,280]" />
    </node>
  </node>
</hierarchy>`;

/**
 * `twoInputRowXml`'s other half — the row split EVENLY, so its centre is the
 * seam between the two children.
 *
 * The uneven fixture only ever exercises the discriminating side of the
 * tap-point test. An inclusive containment test admits BOTH halves at a seam
 * and so discriminates nothing: the clear then empties whichever half holds
 * focus and reports a pass on the row. The OS routes a tap at the seam to the
 * RIGHT child (left/top inclusive, right/bottom exclusive, in `Rect.contains`,
 * `CGRectContainsPoint` and `elementFromPoint` alike), so `focusOn: "left"` is
 * the destructive case and `focusOn: "right"` is the honest one. Even splits
 * are the common case: six OTP boxes on a 1080px screen land on exact 180px
 * boundaries. Reproduced on Chrome 42 and on Android API 36.
 */
const evenSplitRowXml = (focusOn: "left" | "right") =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="name-row" package="com.acme.app" bounds="[40,200][1040,280]">
      <node index="0" class="android.widget.EditText" resource-id="first" content-desc="First name" text="do not erase me" ${focusOn === "left" ? 'focused="true" ' : ""}package="com.acme.app" bounds="[40,200][540,280]" />
      <node index="1" class="android.widget.EditText" resource-id="last" content-desc="Last name" text="Smith" ${focusOn === "right" ? 'focused="true" ' : ""}package="com.acme.app" bounds="[540,200][1040,280]" />
    </node>
  </node>
</hierarchy>`;

/**
 * The admitting side of the containment epsilon, which `enclosingByPadXml`
 * never reaches: the focused input inside the wrapper OVERHANGS it by `pad` px
 * on every side, the way a focus ring or a border rounds out of an integer
 * bounds pair. The slack exists for exactly this, so a 1-3px overhang must
 * still confirm — with the epsilon at 0 the everyday wrapper clear starts
 * refusing.
 */
const overhangingChildXml = (pad: number) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="email-wrapper" package="com.acme.app" bounds="[40,200][1040,280]">
      <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Email" text="old.remembered.login" focused="true" package="com.acme.app" bounds="[${40 - pad},${200 - pad}][${1040 + pad},${280 + pad}]" />
    </node>
  </node>
</hierarchy>`;

/**
 * An overlay that covers the tap point ITSELF, rather than sitting clear of it
 * like `overlayFocusXml`. Geometry cannot tell "the tap hit the overlay" from
 * "the overlay appeared BECAUSE of the tap" — only whether it was there when
 * the gesture was dispatched can, which is what `present` varies.
 */
const centreOverlayXml = (present: boolean) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" package="com.acme.app" bounds="[40,200][1040,600]" />
    ${present ? '<node index="1" class="android.widget.EditText" resource-id="mention" content-desc="Mention" text="do not erase me" focused="true" package="com.acme.app" bounds="[240,350][840,450]" />' : ""}
  </node>
</hierarchy>`;

/**
 * `wrapperFocusXml` with the wrapper GROWN downwards, as an autocomplete does
 * when it renders its listbox inside itself on focus. Only the box changes; the
 * input stays where the tap hit it.
 */
const grownWrapperXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="email-wrapper" package="com.acme.app" bounds="[40,180][1040,900]">
      <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" focused="true" package="com.acme.app" bounds="[40,200][1040,280]" />
      <node index="1" class="android.widget.TextView" text="Suggestion one" package="com.acme.app" bounds="[40,300][1040,400]" />
    </node>
  </node>
</hierarchy>`;

/**
 * A typeahead list that opens on focus, one of whose suggestions repeats the
 * field's own value. `{ text: "Paris" }` matches the field exactly before the
 * tap and matches BOTH afterwards — and the chip is smaller, so a re-run of the
 * selector hands it the match.
 */
const typeaheadXml = (withSuggestion: boolean) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="q" content-desc="City" text="Paris" focused="true" package="com.acme.app" bounds="[40,200][1040,280]" />
    ${withSuggestion ? '<node index="1" class="android.widget.TextView" text="Paris" package="com.acme.app" bounds="[40,320][300,380]" />' : ""}
  </node>
</hierarchy>`;

/**
 * A rich-text composer: the editable node carries the focus and no name of its
 * own, and the only text belongs to the block child inside it — what Quill,
 * ProseMirror and Lexical all render. Every selector that can name the content
 * therefore resolves to a DESCENDANT of the focused node. With `extraLine` the
 * editor shows more than the selector named, which is the negative control.
 */
const richTextEditorXml = (extraLine: boolean) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" focused="true" package="com.acme.app" bounds="[40,200][1040,400]">
      <node index="0" class="android.widget.TextView" text="Draft body here" package="com.acme.app" bounds="[45,210][1035,250]" />
      ${extraLine ? '<node index="1" class="android.widget.TextView" text="and a second paragraph" package="com.acme.app" bounds="[45,260][1035,300]" />' : ""}
    </node>
  </node>
</hierarchy>`;

/**
 * The role test's over-match: Material's `TextInputLayout` is the non-editable
 * WRAPPER that carries the app's `resource-id`, and `deriveUiAutomatorRole`
 * matches `textinput` on the short class name, so it derives `TextField`.
 * Identical to `wrapperFocusXml` apart from that class.
 */
const textInputLayoutWrapperXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="com.google.android.material.textfield.TextInputLayout" resource-id="email-wrapper" package="com.acme.app" bounds="[40,180][1040,300]">
      <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" focused="true" package="com.acme.app" bounds="[40,200][1040,280]" />
    </node>
    <node index="1" class="android.widget.EditText" resource-id="other" content-desc="Display name" text="do not erase me" focused="true" package="com.acme.app" bounds="[40,600][1040,680]" />
  </node>
</hierarchy>`;

function mockRegistry(calls: Call[], getHierarchy: () => { xml: string }): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      calls.push({ id, args });
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    resolveService: vi.fn(async () => ({
      getHierarchy: vi.fn(async () => getHierarchy()),
      getScreenSize: vi.fn(async () => ({ width: 1080, height: 1920 })),
    })),
  } as unknown as Registry;
}

async function writeFlow(name: string, flow: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(flow), "utf8");
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

/** Keyboard call args with the auto-injected `udid` stripped, in call order. */
const keyboardArgs = (calls: Call[]) =>
  calls
    .filter((c) => c.id === "keyboard")
    .map(({ args }) => {
      const { udid: _udid, ...rest } = args;
      return rest;
    });

const run = (registry: Registry) =>
  createRunFlowTool(registry).execute(
    {},
    { name: "f", project_root: tmpDir, device: ANDROID_DEVICE }
  );

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-type-clear-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("type directive — clear dispatch", () => {
  it("clears and types in ONE keyboard call, then submits (tap → clear+text → enter)", async () => {
    const calls: Call[] = [];
    // The field a `clear` exists for: one that already holds a value.
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("old.remembered.login") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);

    // Clear and text MUST ride one call. Every backend validates the whole
    // request before touching the device, so a rejected `text` leaves the field
    // untouched; split across two calls the clear commits first and a rejection
    // then leaves the field empty — worse off than before a call that failed.
    // Enter stays separate: `typeTv` rejects `key` outright before typing, so
    // folding it in would leave a TV target's field empty on submit.
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ clear: true, text: "new@example.com" }, { key: "enter" }]);

    // …and the focusing tap comes before all of them.
    const order = calls
      .filter((c) => c.id === "gesture-tap" || c.id === "keyboard")
      .map((c) => c.id);
    expect(order[0]).toBe("gesture-tap");
  });

  it("refuses to clear when the focus wait never sees focus reach the target", async () => {
    // The destructive case: the tap did not move focus, so a clear would empty
    // whichever field still holds it — silently, and reported as a pass on a
    // field it never touched. Reproduced on a Pixel 3a before this guard.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: unfocusedXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    // Nothing may reach the device — not the clear, not the text, not Enter.
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("refuses to clear when the only focus flag merely COVERS the target", async () => {
    // An overlap test confirms this by construction, and every shape that
    // produces it — an open shadow root, a focused WebView, a focus trap — can
    // hide a different element holding the keys. Driven on a live Chromium
    // page, the clear emptied the enclosing element and reported a pass.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: enclosingFocusXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(result.steps[0]!.reason).toContain("CONTAINS");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("refuses to clear when a focused OVERLAY sits over the named field", async () => {
    // The mirror of the enclosing case, and the one geometry alone cannot tell
    // from the legitimate wrapper below: a suggestion popover's input sits
    // INSIDE the composer's box without being it. Driven on a live Chromium
    // page, the clear emptied the popover, left the composer untouched, and
    // reported a pass on the composer.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: overlayFocusXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(result.steps[0]!.reason).toContain("OVERLAPS");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("still clears when focus lands on the input inside the wrapper the selector named", async () => {
    // Containment, not identity: the legitimate case the strict test must keep
    // working. The decoy focused node elsewhere on screen is what stops this
    // passing on "something, somewhere, reports focus".
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: wrapperFocusXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "type",
          into: { identifier: "email-wrapper" },
          text: "new@example.com",
          clear: true,
        },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it.each([4, 5, 12, 100])(
    "refuses to clear when the only focused node encloses the target by %ipx",
    async (pad) => {
      // The containment epsilon must not admit an ENCLOSING node. Its slack is
      // per-edge, so a symmetric pad of half the tolerance satisfied it on every
      // side at once: at 4px the WebView took the clear and the step passed.
      const calls: Call[] = [];
      const registry = mockRegistry(calls, () => ({ xml: enclosingByPadXml(pad) }));

      await writeFlow("f", {
        executionPrerequisite: "",
        steps: [
          {
            kind: "type",
            into: { identifier: "email-wrapper" },
            text: "new@example.com",
            clear: true,
          },
        ],
      });

      const result = asRun(await run(registry));
      expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
      expect(result.steps[0]!.reason).toContain("refusing to clear");
      expect(keyboardArgs(calls)).toEqual([]);
    }
  );

  it("refuses to clear a container whose focused input is not the one the tap hit", async () => {
    // Containment on its own has no discriminator: `currency` is inside
    // `amount-row` just as much as the input inside a testID wrapper is. The
    // tap lands at the row's centre, which is inside `amount`, so the focus
    // belongs to a sibling and the keys would empty a field the report names
    // nowhere. Reproduced on Chrome 151 before this test existed: the step
    // passed and `#currency` came back holding the replacement.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: twoInputRowXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "amount-row" }, text: "12.50", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("still clears through a wrapper whose role reads as a text input", async () => {
    // The role test this replaced called Material's `TextInputLayout` a text
    // field (its short class name contains "textinput"), skipped the
    // containment arm, and failed a legitimate wrapper clear while blaming an
    // overlay that was not on screen. ARIA 1.1's `combobox`-on-the-wrapper does
    // the same on Chromium. Geometry answers both without a role vocabulary.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: textInputLayoutWrapperXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "type",
          into: { identifier: "email-wrapper" },
          text: "new@example.com",
          clear: true,
        },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("resolves the focus check against the same node the tap targeted", async () => {
    // One ranked resolver behind both halves of the step. `{ text: Email }`
    // matches the label above the field as a substring and the field itself
    // exactly, so an unranked pick takes the label — the tap still lands on the
    // field (it goes through the ranked resolver), and the identity check then
    // compares the focused field against the label and can never match.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: labelAboveFieldXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { text: "Email" }, text: "new@example.com", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    // The tap centre is the FIELD's, not the label's: 340/1920 down the screen.
    const tap = calls.find((c) => c.id === "gesture-tap");
    expect(tap!.args.y).toBeCloseTo(340 / 1920, 5);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("refuses to clear when every read in the focus window failed", async () => {
    // A tree-source outage is not the same as a tree that reported nothing:
    // nothing was observed, so nothing is known about what holds focus.
    // `settleTree` draws the same line for the same condition.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      // The pre-tap settle succeeds (so `waitForFrame` resolves), then every
      // read inside the focus window throws.
      if (reads > 2) throw new Error("device disconnected");
      return { xml: fieldXml("old.remembered.login") };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(result.steps[0]!.reason).toContain("could not be read");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("judges focus by the latest read, not by any read that ever saw it", async () => {
    // The blur race. An app that drops focus when the tap lands reports the
    // PREVIOUS field as focused for however many poll rounds precede the blur.
    // With a sticky "saw focus at any point" flag the verdict then depended on
    // whether round 1 beat the blur — the same flow against the same app failing
    // or passing between runs. The question the clear is about to act on is
    // whether something else holds focus NOW.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      // The pre-tap settle reads plus the first focus poll still see the old
      // field focused; everything after the blur sees nothing focused.
      return { xml: reads <= 3 ? unfocusedXml() : noFocusXml() };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("still clears when the tree reports focus on no node at all", async () => {
    // The refusal keys off focus being reported SOMEWHERE ELSE, not off the poll
    // failing. A tree that never flags focus is not evidence the tap missed —
    // treating it as such disabled `clear` on every iOS build whose injected
    // framework omits `firstResponder`.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: noFocusXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("compares focus against where the target is NOW, not where it was tapped", async () => {
    // Keyboard avoidance scrolls the field away from the point the tap landed
    // on. The identity arm does not care, but the geometric one — the selector
    // named a wrapper and the input inside it reports focus — compares boxes,
    // and against the stale tap frame the input is no longer inside it. Every
    // other fixture here is static, so this is otherwise never exercised.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      // From the focus poll onwards the whole group sits 500px higher.
      const y = reads <= 2 ? 900 : 400;
      return {
        xml:
          `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">` +
          `<node index="0" class="android.widget.FrameLayout" bounds="[0,0][1080,1920]">` +
          `<node index="0" class="android.view.ViewGroup" resource-id="email-wrapper" ` +
          `bounds="[40,${y - 20}][1040,${y + 100}]">` +
          `<node index="0" class="android.widget.EditText" resource-id="email" ` +
          `content-desc="Username or email address" text="old.remembered.login" ` +
          `focused="true" bounds="[40,${y}][1040,${y + 80}]" />` +
          `</node></node></hierarchy>`,
      };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "type",
          into: { identifier: "email-wrapper" },
          text: "new@example.com",
          clear: true,
        },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("still types on an unconfirmed focus when there is no clear", async () => {
    // The refusal is scoped to the destructive half. Misplaced text is additive
    // and visible, and "no focus seen" can also mean the focused view never made
    // it into the tree — so a plain type stays best-effort, as it always was.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: unfocusedXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "new@example.com" }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([{ text: "new@example.com" }, { key: "enter" }]);
  });

  it("does not poll to the timeout for a verdict a plain type never reads", async () => {
    // Only a `clear` acts on the outcome, so only a `clear` keeps polling once
    // something focused has been seen covering the target. The shape is the
    // ordinary hybrid one: uiautomator flags the enclosing WebView, not the
    // EditText inside it, and an enclosing node cannot confirm — so without the
    // early exit a WebView-hosted form of n fields pays n × TYPE_FOCUS_TIMEOUT_MS
    // on the path with no clear at all.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: enclosingFocusXml() };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "new@example.com" }],
    });

    const started = Date.now();
    const result = asRun(await run(registry));
    const elapsed = Date.now() - started;

    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    // Reads 1-2 are the pre-tap settle; read 3 is the focus wait's first and
    // only look. A poll to the deadline would take ~10 more.
    expect(reads).toBe(3);
    // The 500ms settle still applies; the 3000ms focus timeout must not.
    expect(elapsed).toBeLessThan(TYPE_FOCUS_TIMEOUT_MS);
    expect(keyboardArgs(calls)).toEqual([{ text: "new@example.com" }, { key: "enter" }]);
  });

  it("does not submit a clear-only step", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("stale draft") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    // Enter into a field the step just emptied is never the intent — and on a
    // search box it would run an empty query.
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ clear: true }]);
  });

  it("submits a clear-only step when the author asks for it explicitly", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("stale query") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, clear: true, submit: true }],
    });

    asRun(await run(registry));
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ clear: true }, { key: "enter" }]);
  });

  it("issues no clear call for a plain type step", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "x" }],
    });

    asRun(await run(registry));
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ text: "x" }, { key: "enter" }]);
  });

  it("reads the tree no more than a plain type step does", async () => {
    // The clear must not add a read-back pass. An earlier cut verified the
    // field was empty afterwards; that check was blind on iOS and on Chromium
    // `<input>` (neither carries a `value`) and actively failed correct
    // behaviour on Android fields whose hint becomes the value once emptied.
    // Pin the absence so it is not reintroduced by reflex.
    let reads = 0;
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: fieldXml("") };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "x" }],
    });
    asRun(await run(registry));
    const withoutClear = reads;

    reads = 0;
    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "x", clear: true }],
    });
    asRun(await run(registry));

    expect(reads).toBe(withoutClear);
  });
});

describe("type directive — clear at a container's seam", () => {
  it("refuses when an EVENLY split row's focused half is not the one the tap hit", async () => {
    // The uneven `twoInputRowXml` only exercises the discriminating side of the
    // tap-point test. At a seam an inclusive containment test admits both
    // halves and decides nothing, so the clear went to whichever half held
    // focus and the step reported a pass on the row. Reproduced on Chrome 42
    // and Android API 36 before the half-open test.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: evenSplitRowXml("left") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "name-row" }, text: "Jones", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("still clears the EVENLY split row's half the tap did hit", async () => {
    // The control that keeps the fix from being a blanket refusal: the same
    // fixture with focus on the right of the seam, which is where the OS routes
    // a tap landing exactly on it.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: evenSplitRowXml("right") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "name-row" }, text: "Jones", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([{ clear: true, text: "Jones" }, { key: "enter" }]);
  });

  it.each([1, 2])(
    "still clears when the focused input overhangs its wrapper by %ipx",
    async (pad) => {
      // The admitting side of the containment epsilon, which the enclosing-pad
      // cases never reach. A border or focus ring rounding out of an integer
      // bounds pair is what the slack exists for; at 0 the everyday wrapper
      // clear starts refusing.
      const calls: Call[] = [];
      const registry = mockRegistry(calls, () => ({ xml: overhangingChildXml(pad) }));

      await writeFlow("f", {
        executionPrerequisite: "",
        steps: [
          {
            kind: "type",
            into: { identifier: "email-wrapper" },
            text: "new@example.com",
            clear: true,
          },
        ],
      });

      const result = asRun(await run(registry));
      expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
      expect(keyboardArgs(calls)).toEqual([
        { clear: true, text: "new@example.com" },
        { key: "enter" },
      ]);
    }
  );

  it("refuses once the overhang widens the focused input past the tolerance", async () => {
    // The other side of the same boundary, one pixel along: a 3px overhang is
    // 6px of extra WIDTH, and 6/1080 clears FRAME_CONTAINMENT_EPSILON. Pinning
    // both sides is what fixes the value — the enclosing-pad cases above only
    // ever start at 4px, which is already past it.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: overhangingChildXml(3) }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "type",
          into: { identifier: "email-wrapper" },
          text: "new@example.com",
          clear: true,
        },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(keyboardArgs(calls)).toEqual([]);
  });
});

describe("type directive — the tree moving between the tap and the focus poll", () => {
  it("still clears when the named container GROWS after the tap", async () => {
    // Every other fixture holds the tree constant across polls, which is the
    // blind spot that let this through: recomputing the tap point from the
    // target's current frame follows a container that grows, and an
    // autocomplete wrapper rendering its listbox inside itself on focus drops
    // the recomputed centre out of the input and into the option list. The
    // clear was then refused blaming an overlay that is not on the page.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      // Settling needs two identical reads, so the growth lands only once the
      // tap has been dispatched against the small wrapper.
      return { xml: reads <= 2 ? wrapperFocusXml() : grownWrapperXml() };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "type",
          into: { identifier: "email-wrapper" },
          text: "new@example.com",
          clear: true,
        },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("refuses when an overlay appears over the tap point AFTER the tap", async () => {
    // An overlay covering the tap point used to confirm on the argument that
    // the tap must have hit it. That holds only for one already on screen when
    // the gesture went out. An @-mention list, an inline picker or a formatting
    // bar rendered in RESPONSE to the tap was hit by nothing, and taking focus
    // was enough to make it swallow the clear while the composer kept its draft
    // and the step passed on the composer. Reproduced on Chrome 42.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: centreOverlayXml(reads > 2) };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("still clears through an overlay that was ALREADY over the tap point", async () => {
    // The control, and the case the old rationale was right about: the tap
    // really did land on the overlay, so focus reaching its field is the honest
    // consequence of the gesture. Only the timing separates it from the run
    // above.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: centreOverlayXml(true) }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("still clears when the selector re-resolves to a BETTER-ranked node after the tap", async () => {
    // `tappedFrame` only covered a round where the selector fails to resolve at
    // all. A typeahead suggestion repeating the field's own value resolves
    // instead of it — an exact text match on a smaller frame — so the focus
    // check tested an element the step never touched and refused, reporting
    // that focus never reached the target while focus was exactly where the
    // flow had put it.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: typeaheadXml(reads > 2) };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { text: "Paris" }, text: "Berlin", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([{ clear: true, text: "Berlin" }, { key: "enter" }]);
  });

  it("keeps polling past an intermediate overlap read instead of refusing on it", async () => {
    // `requireEvidence` has a well-covered perf half — a plain `type` exits on
    // the first overlapping read — and an unpinned safety half. A `clear` must
    // NOT take that exit: the overlay here is gone by the third read and the
    // real focus is inside the wrapper, so refusing on the intermediate verdict
    // would fail a step that is about to be confirmable.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: reads <= 3 ? overlayFocusXml() : wrapperFocusXml() };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "type",
          into: { identifier: "email-wrapper" },
          text: "new@example.com",
          clear: true,
        },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });
});

describe("type directive — what a refusal is allowed to say", () => {
  it.each([
    ["focus reported elsewhere", unfocusedXml, "email"],
    ["a focused node enclosing the target", enclosingFocusXml, "email"],
    ["a focused overlay over the target", overlayFocusXml, "email"],
  ])("keeps the focused element's own text out of the reason (%s)", async (_name, xml, into) => {
    // The reason is written to the run report on disk and echoed to the agent,
    // and a focused node's label can BE the field's value — a password
    // manager's suggestion, a recovery phrase, the draft the step refused to
    // destroy. Every fixture here carries that text on the focused node, so a
    // reason that quoted it would fail this.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: xml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: into }, text: "x", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(result.steps[0]!.reason).not.toContain("do not erase me");
  });
});

describe("type directive — a rich-text composer", () => {
  it("clears an editor whose only text sits in a child node", async () => {
    // Quill / ProseMirror / Lexical render the content in a block child, and
    // the editable node itself carries no id, no name and no own text — so
    // every selector that can name the content resolves to a descendant of the
    // focused node. That read as "encloses" and was refused with advice (point
    // the selector at the input itself) that nothing on the page can satisfy.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: richTextEditorXml(false) }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { text: "Draft body here" }, text: "REPLACED", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([{ clear: true, text: "REPLACED" }, { key: "enter" }]);
  });

  it("refuses when the enclosing focused node shows more than the selector named", async () => {
    // The control that keeps the editor arm off the shapes "encloses" exists
    // for: a focused WebView wrapping a form, or a focus trap on a textarea,
    // both show text of their own beyond the target's, exactly like this second
    // paragraph the step never named.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: richTextEditorXml(true) }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { text: "Draft body here" }, text: "REPLACED", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });
});

describe("type directive — report rendering", () => {
  it("names the clear in the run report's step target", async () => {
    // `into X` alone reads as a plain append, so a replace-a-field step would
    // be indistinguishable in the report from the bug it fixes.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "x", clear: true },
        { kind: "type", into: { identifier: "email" }, text: "y" },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps[0]!.target).toContain("clear first");
    expect(result.steps[1]!.target).not.toContain("clear first");
  });
});
