# Ticket: Screen-graph Phase A.1 — outcome settle heuristic + rebase onto phase 3

Repo: the ARGENT FORK (github.com/HeiCg/argent), NOT device-farm. Worktree
absolute path:
`/private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-sg`
(branch `feat/screen-graph` @ 4f2bb38d, pushed to origin = HeiCg/argent;
`origin/feat/android-open-server` @ dd378ddf is fetchable there). Phase B
has committed. Run `git -C <path> fetch origin` first, then:

## 1. Rebase
`git rebase origin/feat/android-open-server` (phase 3 @ dd378ddf: nested
compact describe, TapHandler raw inject, MotionInjector syncFinal,
SwipeHandler momentum, GestureHandler downsample, cached screen size,
versionCode 13). Resolve conflicts keeping BOTH behaviours: phase-3 latency
fixes and Phase A outcome/version wrappers in `JsonRpcHandler.runAction`.
Bump versionCode above 13. Rebuild APK; full tool-server vitest green.

## 2. Outcome settle heuristic (Kotlin `TreeStore.waitForQuiet` / `runAction`)
Smoke finding: on a cold emulator the navigation's first AX event arrives
~1.3 s after the tap; the 80 ms no-event window trips first and the outcome
reports `newScreen:false` with `after == before`. Fix:
- After the action, phase 1: wait for the FIRST AX event with a bound
  `firstEventTimeoutMs` (default 600; param under `outcome`). If none
  arrives, return `changed:false` with `settled:'no-event'`.
- Phase 2: then wait for quiet (no event for `quietMs`, default 80) bounded
  by `idleTimeoutMs` (default 1500 now, since phase 1 is bounded
  separately). Report `settled:'quiet'|'timeout'`, `firstEventMs`, `idleMs`.
- If the tree at settle is the empty/transient frame (0 nodes or hash of
  empty tree `cbf29ce484222325`), keep waiting up to `idleTimeoutMs` for a
  non-empty tree before hashing `after`.
- `awaitChange`: add optional `settle: true` — when set, after the first
  event also wait for quiet as above before returning (so callers that want
  "next stable state" get it in one call). Default unchanged (first event).

## 3. await-ui-element on awaitChange
Deferred from Phase A: switch the open-path poll loop in
`await-ui-element` to `awaitChange({until: selector, settle:true})` with the
existing poll loop as fallback; keep trust/cause semantics. Unit tests with
mocked client.

## 4. Phase B leftovers (same branch, after rebase)
- Store the device `version` (and `stateHash`) on the live `ScreenNode` at
  observation time so the compact tier's "only text changed" path can call
  `diff(sinceVersion)` and patch instead of refreshing; also populate
  `changedSince` in the live summary.
- Thread `secretsUsed` from paste/keyboard callers into
  `recordObservation` so redaction fires live; expose `isPassword` as a
  flag bit from the Kotlin serializer (bit 6 = 64, matching `FLAG_PASSWORD`
  in TS) and honour it in the store.
- `navigate-to`: before a coordinate-bucket tap (no id/text stored), run
  `query` for the stored index entry and skip/diverge if not present.

## Tests
Vitest: outcome shapes with `settled`/`firstEventMs`; awaitChange settle
option; await-ui-element uses awaitChange when flag on. Kotlin builds.
On-device (AVD free unless told otherwise; never ZF524RZBHD): repeat the
Phase A smoke M3 (Settings root → Network tap must report `newScreen:true`
on a cold boot) and M4; record numbers; tear down.

## Acceptance
Rebased branch pushed? NO — local commits only; report conflicts resolved,
numbers, test counts.
