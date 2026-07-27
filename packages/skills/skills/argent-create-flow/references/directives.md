# Flow file format and directives

A flow file is an object with `steps:` and — fragments only — `executionPrerequisite:`, a sentence describing the entry state the flow assumes.

```yaml
executionPrerequisite: App on the login screen, user logged out
steps:
  - echo: Signing in
  - type: { into: email, text: "a@b.com", submit: false }
  - type: { into: password, text: "{{secret:APP_PASSWORD}}", submit: false }
  - tap: "Log in"
  - await: { visible: Home }
```

Three kinds of step:

- `- echo: <message>` — a label printed during replay.
- `- tool: <name>` — a raw tool call. It takes only the sibling keys `args:` and `delayMs:` (milliseconds to sleep before it runs). Raw steps report the tool's full result; directive steps report only `status` + `reason`.
- **Directives** — declarative steps interpreted by the runner. They are not agent-callable tools. **Every directive hard-stops the flow on failure**; later steps report `skip`.

## Directives

| Directive    | YAML                                                                                                | Meaning                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `launch`     | `- launch: com.acme.app` or `- launch: { ios: …, android: … }`                                      | start the app from scratch (terminate + relaunch) and wait until ready                                                  |
| `tap`        | `- tap: Login`, `- tap: { x: 0.5, y: 0.57 }`, `- tap: { on: Login, times: 2 }`                      | tap by selector (auto-waits) or raw point                                                                               |
| `long-press` | `- long-press: Row 3`, `- long-press: { on: <sel>, duration: 1200 }`                                | press and hold an element or point (default 800 ms; Chromium: mouse press-hold)                                         |
| `type`       | `- type: { into: email, text: "a@b.com" }`                                                          | focus a field, type, then press Enter to submit and dismiss the keyboard                                                |
| `scroll-to`  | `- scroll-to: "Order #1234"` or `- scroll-to: { target: …, direction: right, within: … }`           | momentum-free scroll until the target is visible                                                                        |
| `pinch`      | `- pinch: { on: "Map", scale: 3 }` or `- pinch: { scale: 0.5 }`                                     | two-finger zoom in (`scale` > 1) or out (< 1); large scales chain gestures; open-loop — assert the visible result       |
| `rotate`     | `- rotate: { on: "Map", by: 90 }` or `- rotate: { by: -45 }`                                        | two-finger rotation in degrees (+ CW, − CCW, within ±3000°; options map only). Not `tool: rotate`, which is orientation |
| `await`      | `- await: { visible: Home }`                                                                        | wait for a UI condition                                                                                                 |
| `wait`       | `- wait: 500`                                                                                       | pause a fixed number of milliseconds — last resort, prefer `await`                                                      |
| `assert`     | `- assert: { visible: Welcome }`                                                                    | check a condition, hard-fail if it never holds                                                                          |
| `snapshot`   | `- snapshot: home` or `- snapshot: { name: home, maxMismatch: 0.5, cropOn: { id: order-summary } }` | diff a screenshot — or one element's region — against a stored baseline                                                 |
| `run`        | `- run: login`                                                                                      | execute another flow's steps inline (fragment or e2e)                                                                   |
| `when`       | `- when: { visible: "What's new" }` + sibling `steps: [...]`                                        | run a guarded block only when the condition holds (no else)                                                             |

`tap`'s `times` (2 = double-tap) and `long-press`'s `duration` require the target nested under `on:` — a selector or a point. `{ x, y, times }` is rejected.

`pinch`/`rotate` take `on:` as a selector only; omitted, they act on the screen center.

## `type`

Enter is pressed after typing, so the keyboard can't cover later targets. In a chained form whose fields feed one explicit submit, set `submit: false` on the intermediate fields so a premature Enter doesn't fire the form early.

**Never record a real credential** — the YAML is committed. Use `text: "{{secret:APP_PASSWORD}}"`: the placeholder is stored verbatim and resolved at run time from the `ARGENT_SECRET_APP_PASSWORD` environment variable, including agent-less `argent flow run` in CI. The `ARGENT_SECRET_` prefix is mandatory. Placeholders resolve only in text-entry steps, never in `when`/`await`/`assert` conditions.

## `scroll-to`

`direction` is `up` | `down` | `left` | `right`, default `down`, so the common case is just `- scroll-to: <selector>`. It scrolls in bounded momentum-free increments, re-checks after each, and stops when a scroll reveals nothing new.

A step-level `within: <selector>` (sibling of `target`) anchors the _gesture_ inside a container — required to drive a nested scroller, e.g. a horizontal carousel inside a vertical list. It is the only scope key the step body accepts; `after:`/`next:`/`any:` beside `target` are rejected. It is distinct from the scopes `target` may itself carry (see `selectors.md`):

```yaml
- scroll-to: { target: { text: Delete, within: { id: cards } }, within: { id: settings-list } }
```

`tap` and `type` never scroll — put a `scroll-to` before any target that may be off-screen. It is a no-op when the target is already visible, so a defensive one costs nothing and keeps the flow working on smaller screens.

## `await` and `assert`

The **condition is the key** and its value is the selector. This is the only spelling.

- `{ visible: Home }`, `{ exists: { id: row } }`, `{ hidden: spinner }`
- `{ text: { in: <selector>, contains: "Taps:" } }` — locate an element with `in`, then check its rendered text against exactly one comparator:
  - `contains` — case-insensitive substring.
  - `equals` — case-insensitive exact match; use it when boundaries matter, since `contains: "Taps: 3"` is also satisfied by "Taps: 30".
  - `matches` — a JS regex for dynamic content (counters, prices, dates). Unanchored like `contains`, but **case-sensitive**; an invalid pattern fails at parse. **Single-quote the pattern** so YAML keeps the backslashes: `{ text: { in: total, matches: 'Total: \$\d+\.\d{2}' } }`.

Reach for `text` only when the locator is an identifier or role. To assert a string is simply on screen, prefer `{ visible: "Taps: 0" }`, or a regex selector for dynamic text — `{ visible: { text: { matches: '^Taps: \d+$' } } }`.

A container's text aggregates its descendants' text, space-joined, so `text` can assert what a testID wrapper visibly shows even when the string lives in a child node. `equals` against a wrapper must then match everything it shows; targeting the leaf, or using `contains`, is clearer.

`await` accepts an optional `timeout` sibling key in milliseconds. **Omit it by default** — the default budget covers normal transitions, and a habitual override just delays failure reporting. Add one only after a step demonstrably needs it (cold start, network round-trip, long animation). `assert` has no timeout: a check that needs seconds to become true is a wait, so spell it `await`.

For a custom poll interval or bundleId, drop to a raw `- tool: await-ui-element` step. That tool polls the trimmed `describe` tree, so a testID it reports as missing can still resolve as an `await:` directive — prefer the directive.

## `when` blocks

`when:` handles one-sided divergences (interstitials, coach marks): the sibling `steps:` list runs only if the guard holds, checked once with the short assert grace (~1 s), so a skipped block barely costs a clean run.

```yaml
- when: { visible: "Got it" }
  steps:
    - tap: "Got it"
```

Guards are one condition key (`exists`/`visible`/`hidden`/`text`, the await/assert shapes) or `platform: ios|android|chromium|vega`. **There is no else** — it is parse-rejected. A block exists to dismiss a divergence and reconverge; two real paths are two flows. Failures inside an entered block are real failures; a skipped block reports `skip` lines. There is also no per-step `optional:` key — it is rejected at parse with a pointer to `when:`.

## `snapshot`

`cropOn: <selector>` narrows the comparison to one element's region. The selector resolves like any directive target (settled tree, auto-wait, selector only — no point form), and the cropped image is what gets compared, stored as the baseline, and reported as the `current` artifact. The baseline filename still keys on the full capture's resolution plus a `-crop-<hash>` suffix, so device-class drift is still caught.

A cropped comparison masks nothing — every pixel of the crop is compared — so prefer elements clear of the status-bar band. Crop **fixed-size containers addressed by `id`**: a text selector resolves to the smallest matching node, whose frame tracks text metrics, and a frame that grew by a pixel fails on dimensions ("nothing was compared") rather than on content.

Baseline storage and seeding are covered in `runner.md`.

## TV targets (Vega)

A Vega (Fire TV) device is remote-driven, so the touch directives (`tap`, `long-press`, `type`, `scroll-to`, `pinch`, `rotate`) fail on it with guidance. Drive focus with `tool: tv-remote` and type with `tool: keyboard`; everything else (`launch`, `await`, `assert`, `wait`, `snapshot`, `echo`, `run`, selectors) works unchanged. The element tree comes from the on-device automation toolkit, which attaches at app launch — so a leading `launch`, which waits for it, also guarantees selectors resolve.

```yaml
steps:
  - launch: com.example.app.main # the interactive component id from manifest.toml
  - await: { visible: Home }
  - tool: tv-remote
    args: { button: [down, select] } # move focus, then confirm — one step per navigation
  - await: { visible: Explore Screen }
  - snapshot: explore
```

A `tv-remote` path is positional, like a coordinate tap, so gate each navigation with an `await` on the destination and echo where focus should be. That is what makes the flow diagnosable when the focus order changes.
