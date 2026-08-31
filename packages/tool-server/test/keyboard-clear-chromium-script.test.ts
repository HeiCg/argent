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
  detail?: string;
  verifiable?: boolean;
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
  answers: Record<string, boolean> = {},
  /**
   * Extra `document` members. `body` / `documentElement` let a test point
   * `activeElement` AT the document's own editing host (designMode /
   * <body contenteditable>), which is the one refusal decided by identity.
   * `execCommand` may also be replaced with a thrower.
   */
  documentExtras: Record<string, unknown> = {}
): { outcome: Outcome; commands: string[]; selectionsDropped: number } {
  const commands: string[] = [];
  const dropped = { count: 0 };
  const g = globalThis as Record<string, unknown>;
  const had = Object.hasOwn(g, "document");
  const saved = g.document;
  g.document = {
    activeElement: active,
    execCommand(name: string) {
      commands.push(name);
      return answers[name] ?? true;
    },
    // A refusal reached AFTER `selectAll` has to undo it: on a field Chrome then
    // refuses, `selectAll` selects the whole document, and that highlight would
    // otherwise reach the next screenshot.
    getSelection: () => ({
      removeAllRanges() {
        dropped.count++;
      },
    }),
    ...documentExtras,
  };
  try {
    const outcome = (0, eval)(CLEAR_FOCUSED_EDITABLE_SCRIPT) as Outcome;
    return { outcome, commands, selectionsDropped: dropped.count };
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
    ["a text input", () => el("INPUT", { type: "text" }), "input type=text"],
    ["an input with no explicit type", () => el("INPUT", {}), "input type=text"],
    ["a password input", () => el("INPUT", { type: "password" }), "input type=password"],
    ["a number input", () => el("INPUT", { type: "number" }), "input type=number"],
    ["a search input", () => el("INPUT", { type: "search" }), "input type=search"],
    ["an email input", () => el("INPUT", { type: "email" }), "input type=email"],
    ["a textarea", () => el("TEXTAREA", {}), "textarea"],
    ["a contenteditable element", () => el("DIV", { isContentEditable: true }), "div"],
  ])("clears %s with selectAll + delete", (_label, make, focus) => {
    const { outcome, commands } = run(make());
    // `focus` rides along on the success too: the backend compares it with the
    // read-back's own focus, and only a read of the SAME element can contradict
    // the delete.
    expect(outcome).toEqual({ cleared: true, focus, verifiable: true });
    expect(commands).toEqual(["selectAll", "delete"]);
  });

  // The refusals. Each one must ALSO leave the page untouched: the script
  // returns before it selects anything, so a refused clear cannot leave a
  // page-wide selection behind for the user to find.
  //
  // `reason` is per-case rather than one constant, because the backend picks the
  // ERROR CODE and the repair from it, and the two repairs are opposites.
  // "not-editable" means focus is on the wrong element, so tapping the field is
  // the fix; every other reason here means the focused element is the right one
  // and cannot be cleared, where tapping it again loops an agent forever.
  it.each([
    [
      "a readonly input",
      () => el("INPUT", { type: "text", readOnly: true }),
      "input type=text",
      "readonly",
    ],
    [
      "a disabled input",
      () => el("INPUT", { type: "text", disabled: true }),
      "input type=text",
      "disabled",
    ],
    ["a disabled textarea", () => el("TEXTAREA", { disabled: true }), "textarea", "disabled"],
    ["a readonly textarea", () => el("TEXTAREA", { readOnly: true }), "textarea", "readonly"],
    [
      "a checkbox",
      () => el("INPUT", { type: "checkbox" }),
      "input type=checkbox",
      "not-a-text-field",
    ],
    ["a radio", () => el("INPUT", { type: "radio" }), "input type=radio", "not-a-text-field"],
    ["a file input", () => el("INPUT", { type: "file" }), "input type=file", "not-a-text-field"],
    [
      "a submit button",
      () => el("INPUT", { type: "submit" }),
      "input type=submit",
      "not-a-text-field",
    ],
    [
      "a range slider",
      () => el("INPUT", { type: "range" }),
      "input type=range",
      "not-a-text-field",
    ],
    [
      "a colour picker",
      () => el("INPUT", { type: "color" }),
      "input type=color",
      "not-a-text-field",
    ],
    ["a select", () => el("SELECT", {}), "select", "not-a-text-field"],
    ["a plain button", () => el("BUTTON", {}), "button", "not-editable"],
    ["a plain div", () => el("DIV", { isContentEditable: false }), "div", "not-editable"],
    ["the body (nothing focused)", () => el("BODY", {}), "body", "not-editable"],
    ["an iframe", () => el("IFRAME", {}), "iframe", "not-editable"],
  ])("refuses %s, naming what holds focus, and deletes nothing", (_label, make, focus, reason) => {
    const { outcome, commands } = run(make());
    expect(outcome).toEqual({ cleared: false, focus, reason });
    expect(commands).toEqual([]);
  });

  it("blames the field kind before readonly, so a readonly checkbox is not a readonly field", () => {
    // `readonly` has no effect on a checkbox at all; reporting it would send the
    // caller after a state the app cannot change into a clearable one.
    expect(run(el("INPUT", { type: "checkbox", readOnly: true })).outcome.reason).toBe(
      "not-a-text-field"
    );
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
    // Not a shape the real DOM produces: `HTMLInputElement.type` reflects
    // "limited to only known values", so a live `<input TYPE="CHECKBOX">` reads
    // back as the lowercase "checkbox". The fold is for the OTHER readers of
    // this script — a framework-rendered tree, a shadow-DOM shim, a test double
    // — where `.type` is whatever the author wrote. Dropping it would treat
    // that checkbox as a text field and "clear" it.
    expect(run(el("INPUT", { type: "CHECKBOX" })).outcome).toEqual({
      cleared: false,
      focus: "input type=checkbox",
      reason: "not-a-text-field",
    });
  });

  it("only refuses the non-text input types, not every unusual one", () => {
    // Positive control for the refusal list: it is a denylist, so a type nobody
    // enumerated (`tel`, `url`, a future one) must still clear. An allowlist
    // would silently refuse those and is the tempting rewrite. In a real DOM an
    // unrecognised type reflects as "text" and would clear for that reason
    // instead; the denylist is what makes both readings agree.
    for (const type of ["tel", "url", "search", "email"]) {
      expect(run(el("INPUT", { type })).outcome, `refused type="${type}"`).toEqual({
        cleared: true,
        focus: `input type=${type}`,
        verifiable: true,
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
    expect(outcome).toEqual({ cleared: true, focus: "input type=text", verifiable: true });
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
    expect(outcome).toEqual({ cleared: true, focus: "input type=text", verifiable: true });
    expect(commands).toEqual(["selectAll", "delete"]);
  });

  it("descends through nested shadow roots", () => {
    // Two levels: a design-system field inside a design-system form row. The
    // walk is a loop rather than one step, and a single-step version passes the
    // test above.
    const inner = el("TEXTAREA", {});
    const mid = el("MY-FIELD", { shadowRoot: { activeElement: inner } });
    const host = el("MY-ROW", { shadowRoot: { activeElement: mid } });
    expect(run(host).outcome).toEqual({ cleared: true, focus: "textarea", verifiable: true });
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
    expect(outcome).toEqual({ cleared: false, focus: "input type=text", reason: "readonly" });
    expect(commands).toEqual([]);
  });
});

// The refusals that only exist because a real browser does something a
// classification-by-tag cannot predict. Each was measured on Chrome 151 first;
// the mock is what keeps the branch from being deleted as dead code.
describe("CLEAR_FOCUSED_EDITABLE_SCRIPT — the document as its own editing host", () => {
  /** `document.body` / `document.documentElement`, as the script compares them. */
  function withDocumentRoots(active: unknown, extras: Record<string, unknown> = {}) {
    return { body: active, documentElement: {}, ...extras };
  }

  it("refuses a designMode / <body contenteditable> page without selecting anything", () => {
    // Measured on Chrome 151: with `designMode = "on"`, `document.activeElement`
    // is <body>, `isContentEditable` is true, and `selectAll` + `delete` empties
    // the ENTIRE page — a body of 288 characters and 7 ids down to 85 and 1.
    // Nothing bounds an editing host, and this needs no prior interaction at
    // all, so the refusal is by identity rather than by editability.
    const body = el("BODY", { isContentEditable: true });
    const { outcome, commands } = run(body, {}, withDocumentRoots(body));
    expect(outcome).toEqual({ cleared: false, focus: "body", reason: "document-editable" });
    expect(commands).toEqual([]);
  });

  it("still refuses <html> as the editing host, not only <body>", () => {
    const root = el("HTML", { isContentEditable: true });
    const { outcome } = run(root, {}, { body: {}, documentElement: root });
    expect(outcome.reason).toBe("document-editable");
  });

  it("clears a real field on the SAME designMode page", () => {
    // The positive control. A refusal written as "designMode is on" rather than
    // "the EDITING HOST is the document" would make every field on such a page
    // unclearable — which is the ordinary case once the caller has tapped one.
    const body = el("BODY", { isContentEditable: true });
    // A focused <input> inherits `isContentEditable` (measured on Chrome 151),
    // and it is still an input: its own value is what select-and-delete empties,
    // so the walk up to the host must not capture it.
    const field = el("INPUT", { type: "text", isContentEditable: true, parentElement: body });
    const { outcome, commands } = run(field, {}, withDocumentRoots(body));
    expect(outcome).toEqual({ cleared: true, focus: "input type=text", verifiable: true });
    expect(commands).toEqual(["selectAll", "delete"]);
  });

  it("refuses a focused DESCENDANT of a document-wide editing host", () => {
    // The reachable route, and it needs no interaction at all: `autofocus` on a
    // <button> inside <body contenteditable>. Every element inside such a host
    // reports `isContentEditable === true`, so a test on the FOCUSED node lets
    // the button past and `selectAll` + `delete` then empties the page —
    // measured on Chrome 151 at 160 characters of <body> down to "<br>",
    // reported as `{ cleared: true }`.
    const body = el("BODY", { isContentEditable: true });
    const button = el("BUTTON", { isContentEditable: true, parentElement: body });
    const { outcome, commands } = run(button, {}, withDocumentRoots(body));
    expect(outcome).toEqual({ cleared: false, focus: "button", reason: "document-editable" });
    expect(commands).toEqual([]);
  });

  it("walks PAST an intermediate editable ancestor to reach the host", () => {
    // Under `designMode` the host is <html>, so the walk has to keep going past
    // <body>; stopping at the first editable ancestor would let this through.
    const html = el("HTML", { isContentEditable: true });
    const body = el("BODY", { isContentEditable: true, parentElement: html });
    const div = el("DIV", { isContentEditable: true, parentElement: body });
    const { outcome, commands } = run(div, {}, { body, documentElement: html });
    expect(outcome.reason).toBe("document-editable");
    expect(commands).toEqual([]);
  });

  it("still clears a contenteditable whose editing host is NOT the document", () => {
    // The regression guard for the walk: an ordinary rich-text editor is a
    // <div contenteditable> under a non-editable <body>, so the walk stops on
    // the div and the clear proceeds as it always did.
    const body = el("BODY", { isContentEditable: false });
    const editor = el("DIV", { isContentEditable: true, parentElement: body });
    const { outcome, commands } = run(editor, {}, withDocumentRoots(body));
    expect(outcome).toEqual({ cleared: true, focus: "div", verifiable: true });
    expect(commands).toEqual(["selectAll", "delete"]);
  });
});

describe("CLEAR_FOCUSED_EDITABLE_SCRIPT — a host script cannot see into", () => {
  it("tries a custom element with no reachable shadow root, and reports it unverifiable", () => {
    // `attachShadow({mode:"closed"})` leaves `el.shadowRoot` null, so the
    // descent stops on the host and the tag test cannot see the <input> that
    // actually holds focus — while the browser's own editing commands DO reach
    // it. Measured on Chrome 151: `delete` answers true and the inner field
    // empties to "". The same opacity means it cannot be read back, so the
    // success is marked unverifiable rather than sent through the read-back.
    const { outcome, commands } = run(el("MY-FIELD", {}));
    expect(outcome).toEqual({ cleared: true, focus: "my-field", verifiable: false });
    expect(commands).toEqual(["selectAll", "delete"]);
  });

  it("takes the delete's refusal as the verdict for such a host", () => {
    // Measured on Chrome 151 for a custom element with nothing editable inside:
    // `delete` answers false and the rest of the page is untouched. Its own
    // reason, because the date-input wording would send the caller to press
    // backspace on a field that has none.
    const { outcome } = run(el("MY-FIELD", {}), { delete: false });
    expect(outcome).toEqual({ cleared: false, focus: "my-field", reason: "host-opaque" });
  });

  it("does not treat an ordinary unknown tag as an opaque host", () => {
    // The heuristic is the custom-element name rule (a hyphen), not "any tag I
    // do not recognise" — widening it would run selectAll + delete on a focused
    // <video> or a future built-in.
    expect(run(el("VIDEO", {})).outcome.reason).toBe("not-editable");
    expect(run(el("SUMMARY", {})).outcome.reason).toBe("not-editable");
  });

  it("does not try a host whose OPEN shadow root simply focuses nothing", () => {
    // `shadowRoot` is readable there, so the descent already had its chance and
    // the host genuinely holds focus. Trying it anyway would select and delete
    // against a page the script CAN inspect and has judged non-editable.
    const host = el("MY-FIELD", { shadowRoot: { activeElement: null } });
    const { outcome, commands } = run(host);
    expect(outcome).toEqual({ cleared: false, focus: "my-field", reason: "not-editable" });
    expect(commands).toEqual([]);
  });
});

describe("CLEAR_FOCUSED_EDITABLE_SCRIPT — it leaves nothing behind", () => {
  it("drops the selection when the delete is refused", () => {
    // `selectAll` has already run by then, and on a field Chrome then refuses it
    // selects the WHOLE DOCUMENT — measured on Chrome 151 for a focused date
    // input, where `document.getSelection()` came back holding the page text.
    // Left in place, that highlight reaches the next screenshot and every
    // screenshot-diff taken after it.
    const { outcome, selectionsDropped } = run(el("INPUT", { type: "date" }), { delete: false });
    expect(outcome.reason).toBe("delete-refused");
    expect(selectionsDropped).toBe(1);
  });

  it("drops nothing on a refusal that never selected", () => {
    // The other refusals return before `selectAll`, so there is no selection to
    // undo — and calling `removeAllRanges` there would clear a selection the
    // USER or a previous `gesture-drag` made.
    expect(run(el("BUTTON", {})).selectionsDropped).toBe(0);
    expect(run(el("INPUT", { type: "text", readOnly: true })).selectionsDropped).toBe(0);
  });

  it("leaves the selection alone on a successful clear", () => {
    // The delete consumed it; removing the ranges again would be a no-op at
    // best and a caret move at worst.
    expect(run(textInput()).selectionsDropped).toBe(0);
  });
});

describe("CLEAR_FOCUSED_EDITABLE_SCRIPT — a page that breaks the script", () => {
  it("reports the page's own error instead of an imagined focus problem", () => {
    // Editors and polyfills replace or delete `document.execCommand`. The throw
    // used to leave `Runtime.evaluate`'s `result.value` undefined, which the
    // backend read as "no element has keyboard focus" — the wrong cause, and a
    // repair (tap the field) that cannot work.
    const { outcome } = run(
      textInput(),
      {},
      {
        execCommand() {
          throw new TypeError("execCommand was replaced by the editor");
        },
      }
    );
    expect(outcome.cleared).toBe(false);
    expect(outcome.reason).toBe("script-error");
    expect(outcome.detail).toMatch(/execCommand was replaced/);
    // No `focus`: nothing was classified, so claiming one would be a guess.
    expect(outcome.focus).toBeUndefined();
  });
});
