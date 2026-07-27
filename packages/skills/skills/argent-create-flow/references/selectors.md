# Selectors

A selector is `{ text?, id?, role? }` plus optional scopes. All present fields must match.

- `text` and `role` are case-insensitive substrings.
- `id` matches the element's testID / accessibilityIdentifier / resource-id exactly, case-insensitively, and also accepts the unqualified Android resource-id name: `submit` matches `com.example.app:id/submit`. (`identifier` is accepted as an alias, but `id` is canonical and what the recorder writes.)

A **bare string is a loose selector**: it resolves identifier-first, then falls back to text (label/value). `tap: Login` matches `testID="Login"` or, failing that, visible text "Login" — no need to know which. Loose fallback applies in every selector slot (`tap`, `type.into`, `await`, `assert`, `scroll-to`). Use the map form to be strict: `{ id: submit-btn }` or `{ text: Login }`.

**Quote strings YAML would mangle.** An unquoted `#` starts a comment, so `tap: Order #1234` silently parses as `tap: Order`; bare `yes`/`no`/`on`/`off`/numbers coerce to non-strings. Wrap anything containing `#`, `:`, quotes, or that reads as a boolean or number: `tap: "Order #1234"`.

## Regex matchers

`text` also takes `{ matches: '…' }`, in any selector slot, for dynamic text no literal can pin:

```yaml
- assert: { visible: { text: { matches: '^Taps: \d+$' } } }
- tap: { text: { matches: '^Order #\d+$' } }
```

The pattern is unanchored, **case-sensitive**, and must be single-quoted so YAML keeps the backslashes; an invalid pattern fails at parse. It tests each node's own label/value, not the adapter-hoisted `subtreeText` — though on iOS a container's own label may itself aggregate descendant text, so a wrapper and its leaf can both match. A stable `id` is still the more robust action target.

## Resolution and ranking

Selectors resolve against the **full native hierarchy** (iOS: the UIView tree; Android: the complete accessibility hierarchy including not-important views) — strictly more than `describe` or the raw `await-ui-element` tool see, both of which use the trimmed tree. An `id` selector therefore works even when `describe` collapses or omits the element; don't fall back to a coordinate tap just because a testID is missing from `describe` output.

When several elements match, the action directives (`tap`, `type`, `scroll-to`) pick the **most specific**: an exact text/identifier match beats a substring hit — a regex consuming the element's whole text counts as exact — and then the smallest frame wins. An `any: true` selector has no field to be exact about, so its matches rank by reading order instead: the first element in the scope, which is the one a condition reads too. Where two matches share a top-left corner, an action breaks the tie toward the smaller element and a condition does not, so the two can name different elements.

## Scopes

A map selector may carry a **scope**: a nested selector naming another element the match must sit in a given spatial relation to. These are the geometric readings of the CSS combinators that survive a flattened tree; the child combinator `>` has no analog, since parent/child structure does not reach replay.

| Scope           | CSS     | Reads as                                                         | Example                                                               |
| --------------- | ------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `within: <sel>` | `A B`   | the match's frame sits **inside** the scope element's frame      | `tap: { text: Delete, within: { id: profile-card } }`                 |
| `after: <sel>`  | `A ~ B` | the match **follows** the scope element in reading order         | `assert: { visible: { role: Button, after: { text: Danger zone } } }` |
| `next: <sel>`   | `A + B` | as `after`, narrowed to the **nearest** follower of each anchor  | `tap: { role: Switch, next: { text: Wi-Fi } }`                        |
| `any: true`     | `*`     | universal — matches anything in the scope, no locator of its own | `assert: { hidden: { any: true, within: { id: empty-state } } }`      |

Rules that hold for all of them:

- Scopes are **visual (frame-based), not tree ancestry** — "inside the card" and "the switch after this label" mean what the screen shows.
- A scope only narrows _where_ to look; the selector still needs its own `text`/`id`/`role` naming _what_ to find, or `any: true`.
- Every scope needs a **distinct element** — nothing scopes itself, and the synthetic screen root never counts.
- Scopes combine and nest, up to six per selector. The nested slot takes every selector form: a bare string stays loose, the map form stays strict, regex matchers work.
- `any: true` needs at least one scope (bare, it would match the whole screen), may not sit beside `text`/`id`/`role`, and accepts only the literal `true`.
- Scopes are flow-YAML only — the raw `await-ui-element` tool's selector accepts none of them.

Prefer a unique `id` on the target itself when one exists. Reach for a scope when the target has no unique locator: repeated row actions, per-card buttons, list cells.

### `within`

`tap: { text: Delete, within: { id: profile-card } }` taps the Delete button in the profile card even when other cards show identical ones. Scope to a container with a **tight frame** — a row, card, dialog, toast; a full-screen wrapper contains everything and scopes nothing. It chains outward, each container's frame inside the next: `{ text: Save, within: { id: cards, within: Settings } }`.

### `after` and `next`

Reading order is row-band aware: an element **follows** the anchor when it starts below the anchor's bottom edge, _or_ shares its row band and sits entirely to its right. That is what makes `{ role: Switch, next: { text: Wi-Fi } }` resolve the Wi-Fi row's own switch even though the taller switch's frame starts a few pixels higher than the label's.

`next` keeps only the nearest follower — a match in the anchor's own row beats anything below, leftmost first — while `after` keeps them all, so `assert: { hidden: { role: Button, after: { text: Danger zone } } }` holds when nothing button-like appears past that heading. Both union over anchors exactly as CSS does: with three rows on screen, `{ role: Switch, next: { role: AXStaticText } }` yields all three switches, one per label.

An element sitting _inside_ the anchor does not follow it — containment is not reading order — so use `within` for that.

### Pitfalls

- **Spell an anchor as a map.** A bare-string anchor (`next: wifi-row`) keeps the identifier-first fallback, and the runner takes the first pass that finds a visible match. A decoy `testID="Wi-Fi"` elsewhere on screen makes `tap: { role: Switch, next: Wi-Fi }` tap the decoy's neighbour and report a pass. A decoy _container_ only wins if it actually holds a match; a decoy _anchor_ wins if anything at all sits after it. Write `next: { text: Wi-Fi }`.
- **`next` is looser than CSS `+`.** Where `A + B` matches nothing unless the very next sibling is a `B`, `next` keeps looking and returns the nearest match further on — which is what lets it survive wrapper and spacer nodes, but also means a row missing the control resolves to the next row's. On a Wi-Fi row rendered without a switch, `{ role: Switch, next: { text: Wi-Fi } }` returns the Bluetooth row's switch instead of failing. When a row may legitimately lack the control, assert it first or scope by `within`.
- **"Follows" is not transitive**, so nesting `after` is not the same as chaining CSS `~`: against a tall anchor, an element can follow something that itself follows the anchor without following the anchor directly. `{ after: { …, after: … } }` can match elements a single `after` excludes. Nest only when each link is a container-sized step.
- **It matters which side carries the scope.** `{ role: Button, next: { text: Name, within: { id: card-b } } }` scopes the _anchor_ — one label, so one pick, but that pick may land outside card-b. `{ role: Button, next: { text: Name }, within: { id: card-b } }` scopes the _target_ — every label is still an anchor, but only card-b's buttons can be picked. They agree on a well-formed screen and diverge when card-b has no button: the first reaches on to the next card's, the second returns nothing. Scope the target when the container is the thing you trust.

### Scopes in conditions

Conditions honor scopes like any other selector. `assert: { hidden: { text: Saved, within: { id: toast-area } } }` holds when nothing matching "Saved" is inside the toast area — matches elsewhere on screen don't count. A missing scope element satisfies `hidden` and fails `visible`/`exists`.

`any: true` works for actions too — `tap: { any: true, next: { text: Airplane Mode } }` taps whatever sits right after that label — but on a real tree "whatever" includes spacers and wrappers. Name the target (`role`, `id`) whenever you can, and keep `any` for conditions and for `next`, which reduces to one element per anchor.
