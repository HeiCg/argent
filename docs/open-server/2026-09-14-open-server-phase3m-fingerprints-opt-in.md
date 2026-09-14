# Ticket: phase 3m — describe-after-tap regression: fingerprints opt-in, no rebuild on the capture path

Status: dispatched 2026-09-14. Root cause and evidence:
`2026-09-14-tap-describe-loss-root-cause.md` (read it first, in full). Summary: since
the screen-graph-d merge, `StateHandler.getState` calls `TreeStore.ensure()` inside the
timed capture (`StateHandler.kt:138`, between `captureStart` and `rootStart`). Idle it is a
cache hit; after a tap the AX version clock moved, so it rebuilds the whole forest via
`uiAutomation.rootInActiveWindow` (`TreeStore.kt:116`), a second `ScreenTree.build`
traversal and three hash passes, none of it in a reported stage. Result on the
consolidated base (run 34813849446, N = 19–20, p50): `tap+describe(settle:false)` ON
505/529 ms vs OFF 354/297; run 7 had ON-scrcpy 298 vs 305 (parity). Secondary: a flat
~35 % server slowdown in APK 0.1.21 (ping 0.42 → 0.86 ms, idle encode 26 → 36), plausibly
the always-on AX event listener from `TreeStore.init` (inference, not proven).

## Contract
1. Fingerprints are opt-in on read RPCs. `getState`/`describe` always return `version`;
   `hash` / `stateHash` / `idHash` / `unchanged` only when the request carries
   `fingerprints: true` or `sinceVersion`. Absent means not computed, never "empty".
   The screen-graph host wiring (`screen-graph-open-wiring.ts`, `bench-screen-graph.ts`,
   `navigate-to`, `awaitScreenIdleViaOpenServer`) passes the flag where it needs
   fingerprints; the plain describe tool and the latency bench do not.
2. Nothing on the capture path calls `rootInActiveWindow`. If a fingerprint rebuild
   runs during a capture, it reuses the capture's `activeRoot` / forest (one traversal,
   hashes computed from the already-serialised tree), never a second AX round trip.
3. New stage `fingerprintMs` in the 3g stage timings; the device test asserts
   `|captureMs − Σ(stages)| <= 10 ms` for idle and after-tap describes.
4. `TreeStore.init` registers the AX event listener lazily: on the first RPC that
   needs versions/fingerprints (or on `screen-graph` recording), not at
   instrumentation start. `getInfo().traversals` stays exposed; the device test reads
   it around an after-tap describe and asserts 1 traversal (not 2).
5. Version bump: APK versionCode 26 / versionName 0.1.22, manifest in sync.
6. Screen-graph configs must be unaffected: the harness sets the flag / recording, so
   per-config success and tokens stay within their run-spread (compare to 34813849446).

## Verification — one CI run, six pre-registered gates (from the root-cause doc)
- Within-run headline: `ON tap+describe(settle:false) p50 ÷ same-run OFF tap+describe
  p50 <= 1.15` on both ON arms.
- `ON describe idle p50 <= OFF describe idle p50 + 10` (the pre-merge F1 direction).
- ping p50 back within 0.1 ms of run 7's 0.42 (or explain the residual with evidence).
- `Σ(stages) ≈ captureMs` (device test), traversals = 1 after tap.
- Every other verb within its OFF-1↔OFF-2 drift floor vs run 34813849446.
- Screen-graph job green; per-config success and tokens within run-spread of 34813849446.

## Process
Branch `fix/open-server-fingerprints-opt-in` off `open/main` @ f1157f58, worktree
`../argent-fork-wt-3m` (never /tmp; root `node_modules` symlinked; no npm install /
gradle / emulator; vitest `--maxWorkers=2`). Kotlin is compiled by CI only, so read the
Kotlin changes twice. One run `suite=both`, `sg_mode=matrix`; polling one `gh run view`
per 10 min as a single `run_in_background` Bash call `sleep 540; gh run view <id> --json
status,conclusion,jobs`; one `gh run download` per artifact at the end. Do not touch the
scoreboard or `open/main`; append `## Result` here with the stage table before/after,
the six gate outcomes, and the verb table vs 34813849446 and run 7.
