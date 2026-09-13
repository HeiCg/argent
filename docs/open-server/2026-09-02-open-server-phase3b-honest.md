# Ticket: open-server phase 3b — fix the phase-3 regressions and re-bench like-for-like

Source: adversarial review of `2026-09-02-open-vs-proprietary-results-v2.md`
(findings F1–F23; blockers F1/F2, majors F3/F4/F8/F9/F11–F18/F20/F21).
Repo: ARGENT FORK checkout
`/private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-p3`,
branch `feat/android-open-server` @ dd378ddf (pushed). Commit locally in
conventional style; do not push. AVD `bench-api35` (boot with
`-grpc 8554 -grpc-use-token`), never `ZF524RZBHD`; the `argent-sg` worktree
is owned by another agent — do not touch it.

Goal of this ticket: an honest, like-for-like comparison and no correctness
regressions. Winning is not required; lying is prohibited. If after fixes the
open path is slower on a verb, the report says so with the number.

## Correctness fixes (all must land, with unit tests)
1. **Tap hold parity (F1/F8).** `TapHandler` timeline: DOWN at 0, UP at
   `holdMs` (param, default 50 = `TAP_HOLD_MS`); `openServerTap` passes it.
   `clickCount>1`: pass `clickCount` + `gapMs` (default `MULTI_TAP_GAP_MS`=100)
   down so the server builds the full multi-tap timeline (F9). Test: mock
   asserts points `tMs` 0/50 and, for clickCount 2, four events with the gap.
2. **Pinch duration cap removed (F2).** Delete `OPEN_PINCH_MAX_DURATION_MS`;
   honour `durationMs` as authored. Downsampling (F18): make it
   time-uniform (resample each pointer path at `MOMENTUM_STEP_MS` cadence,
   preserving original keyframes' times, cap frames by *time*, not index)
   and document it in `gesture-custom`'s schema; keep dwell segments
   (consecutive same-position keyframes) intact.
3. **MotionInjector real-clock pacing (F17).** `waitMs = eventTime -
   (SystemClock.uptimeMillis() - t0)` clamped ≥ 0; `eventTime` of each
   injected event = actual `uptimeMillis()` so VelocityTracker sees the
   truth. Re-measure fling after this (below).
4. **Final-event sync parity (F3).** Return from swipe/gesture RPCs only
   after the UP has been dispatched (`sync=true` for the final UP, or an
   explicit `injectInputEvent(...,true)` of the last event). Intermediate
   MOVEs may stay async.
5. **Screen-size cache invalidation (F21).** Key the cache by
   `(deviceId, displayRotation)`; `getScreenSize` already returns rotation —
   compare on every gesture (cheap RPC ~1ms) OR invalidate in `rotate` tool
   and on registry dispose. Test both rotation change and dispose.
6. **describe vs await-* tree unification (F12).** Make the open-path
   `await-ui-element` / `await-screen-idle` render through the same nested
   tree + v2 trim as `describe` (use `getState`'s tree if it can be nested —
   add `nested:true` to `getState`, or call the nested tree RPC), so labels/
   ids match across tools. Fix the stale doc comments. Test: same fixture
   through both paths yields identical label sets and id forms.
7. **Truncation flag (F13).** `serializeNested` emits `truncated:true` when
   `maxElements` hit; TS surfaces it in describe output as a hint line.
8. **Window order (F11).** Order windows the same way the proprietary
   render does if inferable from the two search outputs (IME toolbar first
   vs last) — otherwise choose a deterministic rule (active window first,
   then by layer) and document the difference in the report.
9. **Paste (F20).** Open path: set clipboard via a new `setClipboard` RPC
   (`ClipboardManager` on the instrumentation context — verify it works from
   an instrumentation process on API 35; if not, fall back to
   `sendStringSync` but ALSO handle non-KeyCharacterMap chars by
   `commitText` through the IME if available, else report unsupported) and
   trigger paste via `KEYCODE_PASTE`. Bench paste with a 40-char URL and a
   string containing an emoji.
10. **Golden tests for the trim (F14).** Fixture `<hierarchy>` XML + the
    equivalent nested JSON → identical `formatDescribeTree` output. A second
    fixture with a dialog + IME window.

## Bench fixes (script `packages/tool-server/scripts/bench-open-vs-proprietary.ts`)
- Add verb `tap+describe` (single timed pair, back to root between
  iterations) (F4). Reset to a known screen before every tap/swipe
  iteration (F5).
- Remove the screenshot row or scale-match (request the same output size on
  both) (F6).
- Fling fidelity: N ≥ 10 per condition, median + IQR, sweep
  `durationMs ∈ {150,250,400}` × distance `∈ {0.3,0.5}`; commit the script
  (`bench-fling-fidelity.ts`) (F15/F16). Report the grid.
- Token count: use `js-tiktoken` o200k_base (add devDependency) for both;
  keep chars/4 as secondary (F22).
- Report ranges across runs, not single p50s, for any claim of stability (F7).

## Output
`/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-02-open-vs-proprietary-results-v3.md`
— same layout as v2 plus: per-finding status table (F1–F23: fixed / not
applicable / open), like-for-like caveats resolved, fling grid, and a
verdict paragraph usable verbatim in a PR (reviewer's allowed wording as the
floor; upgrade claims only where the new numbers support them).

## Acceptance
- All 10 correctness fixes with tests; tool-server suite green; device test
  green; APK builds.
- v3 report with N=20 per verb (OFF-1/ON/OFF-2) at equal hold/duration.
- Emulator torn down.
