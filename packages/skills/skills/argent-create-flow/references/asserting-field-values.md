# Asserting a field's value after a `type`

`type` does not read the field back, so proving a `clear` (or a replacement) landed means asserting
it yourself. Which assert works depends on the platform, because a text field's contents reach the
flow tree unevenly. Check this table before writing one: a directive that fails hard-stops the flow,
so a mis-targeted assert costs every later step.

- **Android** exposes them, except for a **password** field, which reports the `[password]` placeholder and never its value — assert the consequence there, as on iOS. A field with a `contentDescription` reports the hint and the value together, so assert `contains` (or `equals` the whole `"<hint> <value>"` string); a field without one — most React Native `TextInput`s — reports the contents alone, and `equals` on the bare value is right.
- **iOS** never exposes them. The assert reads the field's label instead, so it hard-fails on a perfectly good clear.
- **Chromium** splits by element. A `<textarea>` always exposes its live contents, whitespace-normalized: as the node's value when it also has a label, and as the accessible name when it has none. An `<input>` exposes them only as the accessible _name_, and only when nothing else supplies one — a non-empty `aria-label`, an `aria-labelledby` that resolves, or a `placeholder` (never for a password field). An `aria-label=""` or an `aria-labelledby` pointing at a missing id both still fall through to the value. Where a label does win, the assert reads that label and hard-fails, exactly like iOS — and an assert written against the label instead passes whether or not the clear happened, which proves nothing.

  A `<textarea>` exposing its contents also means a `{{secret:…}}` typed into one is readable from any later `describe`. Only an `<input type=password>` is redacted; there is no textarea equivalent. Type secrets into a password input, or navigate away before you read the screen.

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
on iOS, on a password field, and on any Chromium `<input>` that carries a label, it passes whether or
not the clear happened — the same false pass the label-assert trap warns about one bullet earlier.
Where the contents are invisible, assert the consequence as above.
