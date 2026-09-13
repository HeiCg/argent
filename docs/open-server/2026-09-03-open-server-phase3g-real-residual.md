# Ticket: open-server phase 3g — find the real transitional-describe residual; fix R1/R2 correctness gaps

Repo: ARGENT FORK. Base: `feat/android-open-server` after phase 3e's v6
lands (check `git log`; if 3e is still uncommitted in argent-p3, wait for
its commit). Work in a NEW worktree
`/private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-p3g`
on branch `feat/android-open-server-p3g`. Never edit argent-p3 / argent-p3f
/ argent-sg. AVD `bench-api35` (`-grpc 8554 -grpc-use-token`), never
`ZF524RZBHD`; the AVD queue is: 3e (now) → C.1 → 3f → YOU. Do all code and
unit tests first; boot only after you observe an emulator appear-and-
disappear twice (C.1 and 3f), or 240 min with none.

## Facts from the 3e review (2f37b132 + bench logs)
- `NestedWindowSerializer` prune never fired (0 `captureWindow skip` in
  ~4,800 captures); `serializeMs` p50 1 ms / p95 22 ms; `captureMs` p50
  103 ms after a tap. The cost is OUTSIDE serialize: candidates are
  `uiAutomation.rootInActiveWindow`, `uiAutomation.windows`, `w.root`
  binder calls (`HierarchyHandler.kt:29`, `NestedWindowSerializer.kt:57,68`)
  during a transition.
- `drainAsyncUp` clears `asyncUpOutstanding` BEFORE injecting the sync
  CANCEL (`MotionInjector.kt:274`); `HierarchyHandler` (getNestedAccessibilityTree
  / getAccessibilityTree) does not drain at all; `injectInputEvent`'s boolean
  is discarded at all four sites.
- `ClipboardHandler.kt:37-39` swallows exceptions into `ok=false` → a
  transient error permanently marks the device "clipboard unsupported".
- Golden tests promised for the window filter were never fixture-based
  (`NestedWindowSerializerTest.kt` tests only the predicate).
- App-behind-dialog and non-focusable popups (AutoCompleteTextView
  dropdown, overflow menus) may be dropped by the active+IME/system rule —
  the popup being exactly what the next tap targets (unverified).

## Work
1. **Instrument the residual in the RPC response, not logcat.** In
   `StateHandler`/`HierarchyHandler` time separately: `waitForIdle`,
   `rootInActiveWindow`, `windows` enumeration, each `w.root`, serialize,
   JSON encode; return them as `timings: {idleMs, rootMs, windowsMs,
   rootsMs[], serializeMs, encodeMs}`. Extend the bench script to persist
   them per describe call and print p50/p95 per stage for idle vs after-tap.
2. **Fix R1 ordering:** clear the flag AFTER the sync inject; make
   `HierarchyHandler` drain too (shared helper); check `injectInputEvent`'s
   return at all sites and surface a `dropped:true` in the action result
   (fail the tap RPC on drop).
3. **Fix R3:** `ClipboardHandler` returns `{ok, error?}`; host marks
   unsupported only on `ok:false && !error`, or after 2 consecutive
   definitive falses.
4. **Window filter safety:** keep non-active `TYPE_APPLICATION` windows that
   OVERLAP the active window's bounds and have `isFocused || layer >
   activeLayer` (popups/dropdowns), drop only fully-behind windows. Build
   fixture-based goldens: Settings root, search+IME, dialog (before/after),
   two-app-windows, popup — byte-identical `formatDescribeTree` output for
   the first two vs the pre-3e path, explicit expected output for the rest.
5. **Device check** (when the AVD is yours): open an overflow menu and an
   AutoCompleteTextView dropdown (Settings search suggestions or Chrome
   omnibox) and verify the popup items are present in describe; open a
   dialog and confirm; then re-run tap+describe (settle:false/true) N=20
   with the stage timings and report where the 100 ms goes. If
   `rootInActiveWindow` dominates during transition, try
   `uiAutomation.windows.first { isActive }.root` and/or the
   `FLAG_RETRIEVE_INTERACTIVE_WINDOWS` service-info flag, measure again.
6. Tests: unit for flag ordering, drop surfacing, clipboard error path,
   goldens; suite green; APK builds (bump versionCode above whatever 3f
   used — coordinate by reading argent-p3f's build.gradle.kts).

## Output
Append "v8 / phase 3g" to
`/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-02-open-vs-proprietary-results-v4.md`
with the stage-timing table (idle vs after-tap), the popup/dialog describe
evidence, and tap+describe numbers with OFF-1/OFF-2 spread. Commit locally
on your branch; do not push. Tear the emulator down.
