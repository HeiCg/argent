# Asserting a field's value after a `type`

`type` does not read the field back, so proving a `clear` (or a replacement) landed means asserting
it yourself. Which assert works depends on the platform, because a text field's contents reach the
flow tree unevenly. Check this table before writing one: a directive that fails hard-stops the flow,
so a mis-targeted assert costs every later step.

- **Android** exposes them, except for a **password** field, which reports the `[password]` placeholder and never its value — assert the consequence there, as on iOS. A field with a `contentDescription` reports the hint and the value together, so assert `contains` (or `equals` the whole `"<hint> <value>"` string); a field without one — most React Native `TextInput`s — reports the contents alone, and `equals` on the bare value is right.
- **iOS** never exposes them. The assert reads the field's label instead, so it hard-fails on a perfectly good clear.
- **Chromium** treats an `<input>` and a `<textarea>` alike. Each exposes its contents only as the accessible _name_, and only when nothing else supplies one — a non-empty `aria-label`, an `aria-labelledby` that resolves, or a `placeholder` (never for a password field). An `aria-label=""` or an `aria-labelledby` pointing at a missing id both still fall through to the contents. Where a label does win — which is most fields, and every `placeholder`ed composer — the assert reads that label and hard-fails, exactly like iOS. An assert written against the label instead passes whether or not the clear happened, which proves nothing.

  A field's contents are kept out of the page's text by its **id** (or `data-testid`), which shields them from hoisting: `text: { in: <container> }` then reads what the container displays and not the draft in the identified box inside it. Give every field you assert around an id. Without one there is nothing to shield, and the contents become the node's accessible name: they hoist into every enclosing container, a `text:` selector matches them, and the resolver ranks that exact field match above a substring hit elsewhere. Measured on Chrome 151, both against unidentified `<textarea>`s: `text: { in: <chat>, contains: "unsent draft" }` passed with the message list empty, and `tap: { on: { text: "Save" } }` landed in a note holding the word "Save" instead of on the Save button. Assert against the field's own selector, or assert the consequence.

  An unlabelled field exposing its contents also means a `{{secret:…}}` typed into one is readable from any later `describe`. Only an `<input type=password>` is redacted. Type secrets into a password input, give the field a label, or navigate away before you read the screen.

Where the contents are invisible, assert the _consequence_ instead — the filtered list, the enabled
submit button, the cleared error message. That works on every platform and does not depend on how
the field exposes itself.

## A clear-only step

There is no way to assert "this field is now empty". `equals: ""` and `contains: ""` are rejected at
parse time, and the regex form parses but never matches: absent or empty text is not a haystack, so
`matches: '^$'` is false for exactly the state it describes — the assert fails while reporting
`its text was ""`.

Assert the OLD value's absence instead — `- assert: { hidden: "the old value" }` — but only where the
table above says the contents reach the tree at all. `hidden` passes when nothing visible matches, so
on iOS, on a password field, and on any labelled Chromium field, it passes whether or not the clear
happened — the same false pass the label-assert trap warns about one bullet earlier. Where the
contents are invisible, assert the consequence as above.
