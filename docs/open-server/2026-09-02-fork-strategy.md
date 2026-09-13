# Fork strategy: HeiCg/argent as a maintained open-driver distribution

Decision (owner, 2026-09-02): everything moves to the argent fork. Upstream
PRs remain welcome, but the fork is maintained as a standalone distribution
whose device drivers are fully open source, independent of upstream
acceptance. device-farm keeps its own concerns (pool, jobs, reporting); its
DSL/driver innovations land in the fork first.

## Branch model (fork: github.com/HeiCg/argent)
- `main` — tracks upstream `software-mansion/argent` main (fast-forward only).
- `open/main` — the distribution branch: upstream main + all open-driver
  work merged. Rebased/merged from upstream on a cadence; releases cut here.
- Feature branches (also the upstream PR sources, kept small and clean):
  `feat/run-script` (PR #995), `feat/rich-selectors`, `feat/android-system-verbs`,
  `feat/android-open-server` (phase 1–3), `feat/screen-graph` (Phase A+),
  later `feat/ios-open-server`.
- Rule: a feature branch is always mergeable into both upstream main and
  `open/main`; distribution-only glue (defaults, packaging, docs) lives in
  `open/main` commits, not in feature branches.

## Distribution defaults on `open/main`
- `open-device-server` flag default ON for Android; proprietary binaries
  optional (absent = open path only, no fallback attempts, clear message).
- Package: publish under a distinct scope/name (e.g. `@heicg/argent-open` or
  `argent-open`) so `npx` installs don't collide; the APK is built in CI and
  bundled (release workflow builds `android-device-server` with the
  vendored gradle wrapper).
- CI: fork workflows run tool-server tests, Kotlin build, and the opt-in
  device test on a macOS runner with an AVD (nightly).

## Immediate work mapping
- Phase 3 (perf parity) → `feat/android-open-server` (in flight).
- Screen-graph Phase A → `feat/screen-graph` worktree off
  `feat/android-open-server` (in flight; rebase after phase 3 lands).
- Phase B (host screen graph, describe tiers, navigateTo) → `feat/screen-graph`.
- Phase C (eval harness) → fork `packages/tool-server/scripts/bench-*` +
  device-farm token-bench adapter pointing at the fork.
- iOS: `feat/ios-open-server` — WDA/go-ios backend behind an `open-ios-server`
  flag, same blueprint seam; parked until Android open path is at parity.
- device-farm: stop adding driver features to `device-stream/packages/dsl`;
  plan a later migration where device-farm consumes the fork's tool-server
  (or its DSL package) instead of its own drivers.

## Open items
- Name/scope for the published package; LICENSE notice (Apache-2.0
  compatible; keep upstream NOTICE).
- Which upstream PRs to keep opening (run-script, rich-selectors,
  system-verbs are low-risk; open-server is the political one).
