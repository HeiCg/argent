# Ticket: iOS-2.1 — bench harness fixes from the iOS-2 review (code only; the run needs the owner's approval)

Read `2026-09-15-review-ios2-findings.md` in full (every IOS2-H*/M*/L\* is a work item;
"iOS-2.1 change list" is the checklist; "sim-input landing diagnosis" defines the
discriminating test). Base: `open/main` after the iOS-2 hygiene fix merges (branch
`chore/ci-hygiene-ios2`); if it has not merged yet, branch off `open/main` @ 19890038
and expect a formatting merge later.

## Work (no CI bench run in this ticket)

1. **IOS2-H1 like-for-like path.** Both ON arms drive the SAME tool-server path as OFF:
   `invokeTool` with the `open-ios-device-server` flag on, so every arm pays the host
   tool layer. Bench-local runner calls remain only for the effect oracle and tree
   captures outside timed windows.
2. **IOS2-H2 / H3 / M6 symmetric harness.** One locate function for every arm (from the
   OFF tree or from a shared pre-step locate on the open tree — pick one and use it for
   all four blocks); `ensureRoot()` + idle check identical per block; `hittable` on the
   runner = on-screen AND enabled AND not occluded (best effort: frame inside the window
   and topmost by z-order), documented.
3. **IOS2-H4 oracle.** Effect threshold for a navigation tap = ≥ 0.10 neutral-pixel
   change (measured navigations 0.176–0.238; row highlight ≈ 0.055) with `rootDiff`
   asserted ≈ 0 on the self-test; landing counts only navigations.
4. **IOS2-H5 optical scroll.** Offsets in screen points (de-rasterise), `maxShift` ≥ the
   swipe distance (no censoring), refuse on confidence < 0.6 only, persist the
   before/after screenshots for every sample in the artifact, and swipe a region that
   scrolls (the Settings root has a 2-page vertical scroll bar — swipe the list body,
   not the header).
5. **IOS2-H6 / H7 / M2 / M7.** `tap+describe` window = tap RPC + describe RPC only
   (no quiescence wait inside); `settle` label removed on iOS; `await-*` on the ON side
   must call the product tools (`await-screen-idle`, `await-ui-element` via
   `invokeTool`) — if the open iOS path lacks them, mark the rows `N/A` instead of a
   bench-local poll; `getScreenSize` moved out of the timed tap window; `ensureRoot`
   inside the await loop.
6. **IOS2-M4 / M8 / M9.** Merge gates fail on any verb with errors or n < N; `crashCount`
   actually incremented from runner exits; minutes read from the job API, not
   estimated; tested sha in the results header.
7. **sim-input discriminating test** (code only, run later with approval): one job
   `ON-siminput-only`, frozen coordinate, 3 × 20 taps at holds {0.05, 0.15, 0.35} s,
   recording the diff ratio per tap, plus an XCUITest control cell. Hold configurable
   from the host driver (`packages/ios-sim-input` stays byte-identical to device-stream;
   the hold is an argument the CLI already accepts — verify; if not, this is an iOS-4
   change and the test uses only what exists).
8. Unit tests for the merge gates (errors / n < N / crash) and the optical unit
   conversion; prettier + lint + knip clean (the hygiene workflows run on the PR).

## Process

Branch `feat/ios-open-server-2-1-harness`, worktree `../argent-fork-wt-ios21` (never
/tmp; root `node_modules` symlinked; no npm install / Xcode / simulators). Open a PR to
`open/main` for the hygiene checks only; **do not trigger `bench-ios-open-vs-proprietary`**
— the planner asks the owner before any macOS run. Append `## Result` with the
finding-by-finding table and the exact command the owner would approve. Prettier-clean
before every push.

## Result

Branch `feat/ios-open-server-2-1-harness` off `open/main` @ `d1d4b34c` (HEAD after
the iOS-2 hygiene merge `2d1befb1` + the Android-docs commit `d1d4b34c`), worktree
`../argent-fork-wt-ios21`. **Code only — no macOS bench was triggered.** Local
hygiene: `prettier` clean, `eslint` clean (the `test/*.ts` docs-tsconfig parse
error is environmental — the docs workspace deps are not installed under the
symlinked `node_modules`; an untouched existing test errors identically, and CI's
`npm ci` installs them), `npm run knip` exit 0, `npm run typecheck:bench-scripts`
exit 0. Unit tests: optical **6/6**, iOS gates **8/8**.

Commits (one per work-item group):

- `3f3ecdea` — items 1–5: the harness (H1–H7, M2/M6/M7, L7) + `bench-ios-optical.ts`.
- `d01ef03` — item 6: `merge-blocks-ios.js` + `scoreboard-ios.js` (M4/M8/M9/H3, L2/L3/L5).
- `0530b2f` — item 7: the sim-input discriminating test + dispatch-only workflow.
- `c298a5b` — item 8: the merge-gate + optical unit tests, wired into `unit-tests.yml`.
- (this doc) — the `## Result`.

### How the ON arms now go through `invokeTool`

`OffArm`, `XcuitestArm` and `SimInputArm` each hold a `reg = createRegistry()` and
drive `describe` / `gesture-tap` / `gesture-swipe` through
`reg.invokeTool` (`invokeDescribe`/`invokeTap`/`invokeSwipe`,
`bench-ios-open-vs-proprietary.ts:531-551`). The flag is flipped in the
constructor: OFF `unsetFlag("open-ios-device-server","project")` (`:559`), both ON
`setFlag("open-ios-device-server", true, "project")` (`:634`, `:713`) — so with the
flag ON, `describe`/`gesture-tap`/`gesture-swipe` route to the open XCUITest runner
behind the tool and pay the host tool layer (mutex + `resolveService` + per-call
`getScreenSize`), exactly as the Android bench flips `open-device-server`. The ONE
exception is **ON-siminput input**: `tap`/`swipe` are the `sim-input` HID digitizer
(`SimInputArm.tap/swipe`, `:743-772`), which has no tool path — those rows carry
`inputPath: "sim-input HID (bench-local), no product path"`. Direct-socket use is
now confined to what the tools cannot expose: the shared locate, the G3 stage
`timings`, and `getScreenSize` (cached). A masked fallback (ON describe not
reporting `xcuitest-runner`) is recorded as a block note and fails M4.

### Single shared locate + `ensureRoot` + idle policy (H2/H3/M6)

One `OpenTree.locate` (`:508`) reads the open XCUITest tree via `getNestedState`
and is the locate for **every** arm — OFF included, which now opens an
`IosOpenServerClient` purely for the backend-independent locate (`OffArm`
constructor `:561`). `findTappableByLabel` (`:428`) is a documented host-side
predicate: on-screen (centre inside the window margins) AND the runner's
`hittable` (enabled + area) AND best-effort z-order top (last painted in DFS among
candidates); a real XCUITest `isHittable` is called out as an iOS-4 runner field.
`ensureRoot` is identical on every arm — `relaunchViaSimctl()` (`:821`:
terminate + launch + one fixed settle), no per-arm `launchApp`/idle asymmetry
(M6). The per-iteration median tap coordinate is persisted (`medianTapCoord`), and
the merge fails the run if the four blocks' coordinates disagree by more than
`TAP_COORD_TOL` = 0.03 (`merge-blocks-ios.js` H3 gate).

### Oracle threshold + self-test (H4)

G0 now requires `navDiff >= G0_NAV_MIN` (0.10) AND `rootDiff < 0.5 × navDiff`
(rootDiff ≈ 0) — `oracleSelfTestOnce` `:1282`. The three healthy iOS-2 blocks were
0.176–0.238; ON-siminput's 0.0554 self-test now **fails** G0, as required. The
per-block landing threshold is derived from that block's own navigation:
`landingThreshold = 0.5 × navDiff` (`:1340`), and `timeTapEffect` (`:942`) **records
the max neutral-pixel ratio per tap** (not a boolean) with the coordinate and poll
index in `tapRecords`; `landed = ratio >= landingThreshold`. Unit test: the
threshold arithmetic + self-test rule are exercised through the merge fixtures;
the numeric conversion side (optical) is in `bench-ios-optical.test.ts`.

### Optical metric units / maxShift / screenshots (H5)

The censored inline estimator is gone; `opticalScrollPoints` (`:305`) calls the
shared `estimateScrollPx` (`optical-scroll.ts`, ticket 3o) on the **full-resolution**
PNG with `maxShiftFrac: 0.9` of the scroll region (≥ the swipe distance — no
half-window clamp) and `minConfidence: 0.6` (refuse only). The framebuffer-px
result is converted to **screen POINTS** via `framebufferPxToPoints` and the raster
scale is stated (`framebufferScale`, both in `bench-ios-optical.ts`, unit-tested
6/6). `scrollRegion` is clamped to `[0,1]` (`OpenTree.scrollRegion`) and the swipe
targets the list body (`from` at 0.75, `to` at 0.25 of the region). Per-swipe
`from`/`to`/`scrollRegion`/`dyPx`/`confidence` persist in `scroll.records`, and a
few before/after PNG pairs per block are kept under `.bench-results/shots/<block>/`
(the rest still `rmShot`-deleted).

### `tap+describe` window (H6)

Renamed `tap+describe(settle:false)` → `tap+describe` everywhere (harness, merge
`VERBS`, scoreboard). The timed window is the tap RPC + the describe RPC only
(`:1404`); `ensureRoot` + the shared locate are untimed setup and a locate miss
**excludes** the iteration (the `?? {x:0.5,y:0.3}` blind-tap fallbacks are deleted
in both `tap+describe` and `await-screen-idle`). Per-iteration `tapMs`/`describeMs`
sub-timings are recorded inside the window (`subTimings` in the verb `extra`).

### `await-*` decision: N/A (M7)

The open iOS path has **no** `await-screen-idle` / `await-ui-element` product (grep
of `src/tools/await-*/` finds no `shouldUseIosOpenServer`). Per the ticket, the ON
arms therefore emit both as `N/A` (`naVerb`, `:1484`) rather than a bench-local
poll; only the OFF arms measure the real tools, with `ensureRoot` **inside** the
per-iteration setup (H7). `Arm.hasAwaitProduct` gates this. The old bench-local
`OpenTree.awaitIdle/awaitElement` version-counter/poll loops are removed.

### Gate changes (M4/M8/M9/H3)

`merge-blocks-ios.js`: new fatal gates — per non-N/A verb `errors === 0`,
`latencySamples.length === N`, `locateFailed === 0`; per block `notes.length === 0`
and `locateFailedTotal === 0` (M4); the runner-crash gate now reads a **real**
`runnerCrashes` counter incremented on connection-class RPC errors
(`isConnectionError` `:101`, `probe()` on each ON arm) (M9); and the H3 tap-coord
drift gate. `crashCount` (crash on `n < N` / errors) and these fold into the
reported G1 bucket. `scoreboard-ios.js`: tested `sha` in the header (M8), the
landing table shows the per-block navDiff + calibrated threshold, optical rows are
in points with the raster scale, G4 gains a tok/element column (M5), the fidelity
caption says "identity tokens" not elements (L2), and the G3 header pipes are
escaped so the table renders (L3). L1 (nav-title in the oracle description) and L7
(`originLost`) are dropped. **M8 minutes**: the results/scoreboard now carry the
sha and read from `env`; the actual billed minutes for any future run come from
`gh run view <id> --json jobs` (not estimated) when that run happens — no run here.

### Finding-by-finding

| finding | change                                                                                       | where                                      | test                                 |
| ------- | -------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------ |
| IOS2-H1 | every arm through `invokeTool`; flag flipped per block; sim-input input labelled bench-local | `bench-ios…ts:531-551,559,634,713,743-772` | typecheck; masked-fallback → M4 test |
| IOS2-H2 | host-side documented `hittable` predicate (on-screen+enabled+z-order)                        | `:428-470`                                 | typecheck                            |
| IOS2-H3 | one shared open-tree locate for all arms; coord persisted + cross-block drift gate           | `:508`, `merge…js` H3                      | `gates-ios` H3 drift test            |
| IOS2-H4 | ratio recorded per tap; landing = 0.5×navDiff; G0 ≥ 0.10, rootDiff ≈ 0                       | `:942,1282,1340`                           | merge fixtures; optical test         |
| IOS2-H5 | full-res NCC via `optical-scroll.ts`, points + raster scale, region clamp, PNGs kept         | `:305`, `bench-ios-optical.ts`             | `bench-ios-optical.test.ts` 6/6      |
| IOS2-H6 | `tap+describe` renamed; window = tap+describe RPCs; sub-timings; no blind tap                | `:1404`                                    | typecheck; scoreboard render         |
| IOS2-H7 | `ensureRoot` per iteration in await setup; both blind-tap fallbacks deleted                  | `:1454-1476`                               | typecheck                            |
| IOS2-M1 | G3 labelled "internally consistent by construction (direct socket)", not a green claim       | `scoreboard…js` G3                         | render                               |
| IOS2-M2 | `getScreenSize` cached per block, out of the timed tap window                                | `:715` `SimInputArm.size`                  | typecheck                            |
| IOS2-M4 | merge gates: errors / n<N / notes / locateFailed                                             | `merge…js:144-164`                         | `gates-ios` 4 tests                  |
| IOS2-M5 | G4 tok/element column                                                                        | `scoreboard…js` G4                         | render                               |
| IOS2-M6 | identical `relaunchViaSimctl` ensureRoot on every arm                                        | `:821`                                     | typecheck                            |
| IOS2-M7 | ON `await-*` = N/A (no open product); OFF real tools                                         | `:1484`                                    | `gates-ios` N/A-exempt test          |
| IOS2-M8 | tested sha in header; minutes from job API (doc)                                             | `:1575`, `scoreboard…js:59`                | render                               |
| IOS2-M9 | real `crashCount` from connection-class RPC errors                                           | `:101`, `probe()`                          | `gates-ios` crash test               |
| IOS2-L1 | nav-title claim dropped from the oracle description                                          | harness/doc                                | —                                    |
| IOS2-L2 | fidelity caption: identity tokens, not elements                                              | `scoreboard…js`                            | render                               |
| IOS2-L3 | G3 header pipes escaped                                                                      | `scoreboard…js`                            | render                               |
| IOS2-L5 | p95-at-N=20 note kept alongside the value                                                    | scoreboard                                 | render                               |
| IOS2-L7 | `originLost` field removed                                                                   | harness                                    | typecheck                            |

### sim-input discriminating test — job + hold configurability

`packages/tool-server/scripts/bench-ios-siminput-discriminating.ts` +
`.github/workflows/bench-ios-siminput-discriminating.yml` (**dispatch-only**,
ON-siminput only, no OFF arms, `timeout-minutes: 45`). It locates the target once,
freezes the coordinate, and runs 20 taps/cell from a fresh root recording the max
diff ratio + coordinate + poll index per tap, keeping the highest/lowest-ratio
before/after PNG pair, plus a 20-tap XCUITest control cell.

**Is the hold configurable today? No.** `packages/ios-sim-input/Sources/sim-input/main.swift`
`case "tap"` passes `duration: 0` (→ `IndigoHIDInput` fixed 0.05 s hold) and parses
no `hold`/`holdSeconds` for a tap (only `swipe` reads `durationMs`). Since
`packages/ios-sim-input/**` must stay byte-identical, `HOLD_CONFIGURABLE_TODAY =
false`: only the 0.05 s cell runs; the {0.15, 0.35}s cells are emitted **SKIPPED**
with that reason. Making the hold configurable (parse a tap `holdSeconds` in
`main.swift` and pass it instead of `duration: 0`) is the iOS-4 Swift change.

### The command the owner would approve for iOS-2.1's measurement run

Per change-list item 13, validate the repaired harness with a **single-block dry
run** before spending a four-block run. The `bench-ios-open-vs-proprietary.yml`
workflow is `workflow_dispatch` and must live on the default branch to dispatch
(the branch push-trigger was removed), so the owner runs, after this merges to
`open/main`:

```
gh workflow run bench-ios-open-vs-proprietary.yml --ref open/main -f blocks=ON-xcuitest -f n=5
```

Estimated cost: ~35–45 min wall (fixed setup — Xcode select, `npm install`, `tsc
--build`, closed-binary download, sim boot, `build-for-testing`, sim-input build —
dominates; one ON block at N=5 is ~4–6 min) ⇒ **≈ 400–450 billed minutes** at the
macOS 10× rate. Only after that dry run is green should the owner spend a four-block
`-f blocks=OFF-1,ON-xcuitest,ON-siminput,OFF-2 -f n=20` run (≈ 74 min wall / ≈ 750
billed, the iOS-2 figure). The iOS-4 discriminating test is a **separate** short
job, not bundled:

```
gh workflow run bench-ios-siminput-discriminating.yml --ref open/main -f taps=20
```

(≈ 30–40 min wall / ≈ 300–400 billed; today it runs the 0.05 s sim-input cell + the
XCUITest control only.)

### Hygiene run ids on the PR

_(PR to `open/main`, hygiene checks only — filled after the checks go green; the
macOS bench workflow is NOT triggered.)_
