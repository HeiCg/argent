import { describe, expect, it } from "vitest";
import { CLEAR_FOCUSED_EDITABLE_SCRIPT } from "../src/tools/keyboard/platforms/chromium";

/**
 * `CLEAR_FOCUSED_EDITABLE_SCRIPT` is an IIFE injected via Runtime.evaluate. It
 * decides *inside the renderer* whether anything editable holds keyboard focus,
 * and deletes only then. Every other test can mock the CDP answer, so that
 * decision — the part that keeps a clear aimed at nothing from wiping whatever
 * the page focuses by default, and keeps a readonly field untouched — is
 * observable only by evaluating the real source. Mirrors
 * describe-chromium-script.test.ts, which evals `DESCRIBE_DOM_SCRIPT` the same
 * way.
 *
 * The mock implements the whole DOM surface the script reads: `activeElement`,
 * `execCommand`, and per element `tagName` / `type` / `disabled` / `readOnly` /
 * `isContentEditable` / `shadowRoot`.
 */

interface Outcome {
  cleared?: boolean;
  focus?: string | null;
  reason?: string;
}

// Chrome's own answers, measured on 151.0.7922.174 by evaluating `selectAll`
// then `delete` against one live element per input type. `delete` is true for
// every element that ends up empty — including one that was ALREADY empty,
// where `selectAll` is false — and false for exactly the five date/time types,
// which keep their value. A mock whose `execCommand` always returns true cannot
// express the case the script exists to catch, so this table is what the
// refusal tests drive.
const DATE_TIME_TYPES = ["date", "datetime-local", "month", "week", "time"];

/** One element as the script sees it. `tagName` is uppercase, as in a real DOM. */
function el(tagName: string, props: Record<string, unknown> = {}): Record<string, unknown> {
  return { tagName, ...props };
}

const textInput = () => el("INPUT", { type: "text" });

/**
 * Eval the script with `document.activeElement` pointing at `active`, and report
 * both its return value and the execCommand calls it made. Indirect eval so the
 * IIFE runs in global scope and reads the injected global, as it does in a page.
 */
function run(
  active: unknown,
  /** What the renderer's `execCommand` answers, per command name. */
  answers: Record<string, boolean> = {}
): { outcome: Outcome; commands: string[] } {
  const commands: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const had = Object.hasOwn(g, "document");
  const saved = g.document;
  g.document = {
    activeElement: active,
    execCommand(name: string) {
      commands.push(name);
      return answers[name] ?? true;
    },
  };
  try {
    const outcome = (0, eval)(CLEAR_FOCUSED_EDITABLE_SCRIPT) as Outcome;
    return { outcome, commands };
  } finally {
    if (had) g.document = saved;
    else delete g.document;
  }
}

describe("CLEAR_FOCUSED_EDITABLE_SCRIPT — what it agrees to clear", () => {
  // `selectAll` then `delete`, in that order: `delete` on its own removes one
  // character (or nothing, with a collapsed caret at the end), which is exactly
  // the silent near-no-op the whole design is built to avoid. Pinning the pair
  // and the order also records that neither is a keyboard event — the script
  // delivers no keydown, so a page shortcut bound to "a" cannot cancel it.
  it.each([
    ["a text input", () => el("INPUT", { type: "text" })],
    ["an input with no explicit type", () => el("INPUT", {})],
    ["a password input", () => el("INPUT", { type: "password" })],
    ["a number input", () => el("INPUT", { type: "number" })],
    ["a search input", () => el("INPUT", { type: "search" })],
    ["an email input", () => el("INPUT", { type: "email" })],
    ["a textarea", () => el("TEXTAREA", {})],
    ["a contenteditable element", () => el("DIV", { isContentEditable: true })],
  ])("clears %s with selectAll + delete", (_label, make) => {
    const { outcome, commands } = run(make());
    expect(outcome).toEqual({ cleared: true });
    expect(commands).toEqual(["selectAll", "delete"]);
  });

  // The refusals. Each one must ALSO leave the page untouched: the script
  // returns before it selects anything, so a refused clear cannot leave a
  // page-wide selection behind for the user to find.
  it.each([
    ["a readonly input", () => el("INPUT", { type: "text", readOnly: true }), "input type=text"],
    ["a disabled input", () => el("INPUT", { type: "text", disabled: true }), "input type=text"],
    ["a disabled textarea", () => el("TEXTAREA", { disabled: true }), "textarea"],
    ["a readonly textarea", () => el("TEXTAREA", { readOnly: true }), "textarea"],
    ["a checkbox", () => el("INPUT", { type: "checkbox" }), "input type=checkbox"],
    ["a radio", () => el("INPUT", { type: "radio" }), "input type=radio"],
    ["a file input", () => el("INPUT", { type: "file" }), "input type=file"],
    ["a submit button", () => el("INPUT", { type: "submit" }), "input type=submit"],
    ["a range slider", () => el("INPUT", { type: "range" }), "input type=range"],
    ["a colour picker", () => el("INPUT", { type: "color" }), "input type=color"],
    ["a plain button", () => el("BUTTON", {}), "button"],
    ["a plain div", () => el("DIV", { isContentEditable: false }), "div"],
    ["the body (nothing focused)", () => el("BODY", {}), "body"],
    ["an iframe", () => el("IFRAME", {}), "iframe"],
  ])("refuses %s, naming what holds focus, and deletes nothing", (_label, make, focus) => {
    const { outcome, commands } = run(make());
    expect(outcome).toEqual({ cleared: false, focus, reason: "not-editable" });
    expect(commands).toEqual([]);
  });

  it("reports a null activeElement as no focus at all, not as an element", () => {
    // A detached / not-yet-loaded document answers `null` here. `focus: null`
    // is what makes the backend say "no element has keyboard focus" rather than
    // "<null>" — a distinction the caller acts on: one means tap the field, the
    // other means the page is not ready.
    const { outcome, commands } = run(null);
    expect(outcome).toEqual({ cleared: false, focus: null, reason: "not-editable" });
    expect(commands).toEqual([]);
  });

  it("matches the input type case-insensitively", () => {
    // `type` reflects the attribute, and HTML attributes are not case-sensitive:
    // `<input TYPE="CHECKBOX">` reads back as "CHECKBOX" in some framework
    // renderings. Dropping the fold would treat that checkbox as a text field
    // and "clear" it — a click target silently receiving a delete.
    expect(run(el("INPUT", { type: "CHECKBOX" })).outcome).toEqual({
      cleared: false,
      focus: "input type=checkbox",
      reason: "not-editable",
    });
  });

  it("only refuses the non-text input types, not every unusual one", () => {
    // Positive control for the refusal list: it is a denylist, so a type nobody
    // enumerated (`tel`, `url`, a future one) must still clear. An allowlist
    // would silently refuse those and is the tempting rewrite.
    for (const type of ["tel", "url", "search", "email"]) {
      expect(run(el("INPUT", { type })).outcome, `refused type="${type}"`).toEqual({
        cleared: true,
      });
    }
  });

  it("names the focused input's type, so a refusal says which field it hit", () => {
    // `<input>` alone is not a diagnosis: "it is on <input>" leaves the caller
    // unable to tell a checkbox it mis-tapped from a date field that cannot be
    // cleared this way. Both refusals carry the type.
    expect(run(el("INPUT", { type: "checkbox" })).outcome.focus).toBe("input type=checkbox");
    // A textarea has no `type` worth reporting — its `.type` is the constant
    // "textarea" — so the label stays the bare tag rather than "textarea
    // type=textarea".
    expect(run(el("TEXTAREA", { disabled: true })).outcome.focus).toBe("textarea");
    // An omitted `type` reflects as "text" in the DOM; the script normalises to
    // the same, so a bare <input> is never reported as `type=undefined`.
    expect(run(el("INPUT", {}), { delete: false }).outcome.focus).toBe("input type=text");
  });
});

// The bug this half exists for: Chromium's five date/time input types pass
// every editability signal the script can read — they are not in the denylist,
// they are not readonly or disabled, they are `<input>` — and `execCommand`
// still leaves their value in place, because it is structured rather than text.
// Discarding `delete`'s return value therefore answered `cleared: true` for a
// field that still held its date, and the caller's next step typed the
// replacement INTO the retained value. That is the exact data bug clearing
// exists to prevent, so it is a refusal, with its own code and its own repair.
describe("CLEAR_FOCUSED_EDITABLE_SCRIPT — a delete the element refuses", () => {
  it.each(DATE_TIME_TYPES)("refuses <input type=%s> when delete answers false", (type) => {
    const { outcome, commands } = run(el("INPUT", { type }), { delete: false });
    expect(outcome).toEqual({
      cleared: false,
      focus: `input type=${type}`,
      reason: "delete-refused",
    });
    // It still TRIED — the refusal is read from the attempt, not predicted from
    // the type. An allowlist of known-bad types would pass this assertion on
    // `outcome` alone while going stale the next time Chromium adds one.
    expect(commands).toEqual(["selectAll", "delete"]);
  });

  it("separates the two refusals by `reason`, not only by wording", () => {
    // The backend branches on `reason` to pick the code and the repair — tap
    // the field, versus press backspace on the field you already focused.
    expect(run(el("BUTTON", {})).outcome.reason).toBe("not-editable");
    expect(run(el("INPUT", { type: "date" }), { delete: false }).outcome.reason).toBe(
      "delete-refused"
    );
  });

  it("still clears when only `selectAll` answers false", () => {
    // An ALREADY-empty text field: Chrome answers `selectAll: false` (there was
    // nothing to select) and `delete: true`. Reading the wrong one of the two
    // would turn every clear of an empty field into a spurious failure — and an
    // empty field is the ordinary state of a field a flow just cleared.
    const { outcome, commands } = run(textInput(), { selectAll: false });
    expect(outcome).toEqual({ cleared: true });
    expect(commands).toEqual(["selectAll", "delete"]);
  });
});

describe("CLEAR_FOCUSED_EDITABLE_SCRIPT — focus inside a shadow root", () => {
  it("descends into the shadow root to find the real input", () => {
    // A custom element that wraps an <input> is the ordinary design-system
    // field. `document.activeElement` only ever names the HOST, so without the
    // descent every such field reports as a non-editable custom tag and the
    // clear is refused on a page where a clear is exactly what is wanted.
    const inner = textInput();
    const host = el("MY-FIELD", { shadowRoot: { activeElement: inner } });
    const { outcome, commands } = run(host);
    expect(outcome).toEqual({ cleared: true });
    expect(commands).toEqual(["selectAll", "delete"]);
  });

  it("descends through nested shadow roots", () => {
    // Two levels: a design-system field inside a design-system form row. The
    // walk is a loop rather than one step, and a single-step version passes the
    // test above.
    const inner = el("TEXTAREA", {});
    const mid = el("MY-FIELD", { shadowRoot: { activeElement: inner } });
    const host = el("MY-ROW", { shadowRoot: { activeElement: mid } });
    expect(run(host).outcome).toEqual({ cleared: true });
  });

  it("stops at a host whose shadow root focuses nothing, and refuses it by its own tag", () => {
    // The loop's exit condition. A host with a shadow root but no focus inside
    // it is not an editable, and the refusal has to name the host — descending
    // into `null` would throw inside the renderer and surface as an evaluate
    // failure instead of the actionable "tap the field first".
    const host = el("MY-FIELD", { shadowRoot: { activeElement: null } });
    expect(run(host).outcome).toEqual({
      cleared: false,
      focus: "my-field",
      reason: "not-editable",
    });
  });

  it("refuses a readonly input that lives inside a shadow root", () => {
    // The editability check has to run on the element the descent landed on,
    // not on the host: a walk that decided before descending would clear this.
    const inner = el("INPUT", { type: "text", readOnly: true });
    const host = el("MY-FIELD", { shadowRoot: { activeElement: inner } });
    const { outcome, commands } = run(host);
    expect(outcome).toEqual({ cleared: false, focus: "input type=text", reason: "not-editable" });
    expect(commands).toEqual([]);
  });
});
