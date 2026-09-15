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
