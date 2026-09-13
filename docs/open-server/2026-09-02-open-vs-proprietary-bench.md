# Spec: benchmark — argent proprietary Android backend vs open-device-server

Date: 2026-09-02. Question to answer with numbers: on the same AVD and the
same tool calls, is the open Kotlin server (flag `open-device-server` ON)
faster/smaller/more reliable than argent's proprietary path (flag OFF:
simulator-server Rust binary + argent-android-devtools APK)?

## Inputs
- Fork checkout (open server): argent-p3 at
  /private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-p3
  branch feat/android-open-server @ 93fd5b17 (pushed). Kept device test
  `packages/tool-server/test/blueprints/android-open-server.device.test.ts`
  shows how to boot the AVD, install the server, and call the blueprint API.
- Proprietary binaries: vendored published package v0.22.1 extracted at
  /private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-pkg/extracted/package
  (`bin/argent-android-devtools-0.1.0.apk`, `bin/simulator-server*`,
  `dylibs/*`). The fork's `packages/argent/src/bundled-paths.ts` (or
  equivalent path resolvers in blueprints `simulator-server.ts` /
  `android-devtools.ts` / `utils/android-helper-install.ts`) decides where
  binaries are looked up — point them at this directory (env var, symlink
  into the expected `packages/argent/bin|dylibs`, or copy). Do not commit
  binaries. If the fork's expected binary version/name differs from 0.22.1's
  and the proprietary path refuses to start, report exactly why and fall back
  to measuring only what runs (Android describe via `uiautomator dump`
  legacy fallback still counts as "proprietary/legacy path").
- AVD `bench-api35` (headless boot as in the device test). Stop
  `com.devicestream.server` first. UiAutomation channel is exclusive — ALSO
  exclusive between the ADT apk and our server: run one configuration at a
  time, fully stop the other's instrumentation between configs.
- Physical device `ZF524RZBHD` is attached — never target it.

## Method
Prefer driving the real tools (`describe`, `screenshot`, `gesture-tap`,
`gesture-swipe`, `await-ui-element`, `await-screen-idle`, `paste`,
`gesture-pinch`) through the tool-server registry with the device object,
flag toggled per config — same call sites an agent would hit. Reuse the
invocation style of the device test / `device-stream/benchmarks/token-bench/adapters.ts`
in device-farm.

Per config (OFF = proprietary, ON = open), per verb, N=20 iterations after 3
warm-ups, on the same screens (Settings root; Settings search with typed
text; Chrome example.com for pinch), interleaving configs is NOT possible
(exclusive channel) so run OFF block then ON block then OFF again (to detect
drift), report the two OFF blocks separately and merged.

Measure:
- wall latency per call (ms): p50, p95, max.
- `describe`: output bytes and token estimate (use the same tokenizer/
  estimator the token-bench harness uses; if none, chars/4), element count,
  and a fidelity check: the set of (resource-id|text) pairs visible — Jaccard
  overlap between OFF and ON on the same screen, and which ids each side
  misses.
- `screenshot`: bytes, dimensions, format, latency.
- `await-screen-idle`: time-to-resolve after a tap.
- cold start: time from "start backend service" to first successful
  describe, per config (includes APK install/instrument spawn vs
  simulator-server spawn); measure 3× each.
- failures/timeouts/fallbacks per config (count + messages).
- host process cost: RSS of the backend process(es) after the run
  (`ps -o rss` for simulator-server; for the open path there is no host
  process beyond adb — say so).

## Output
- Raw JSON per run under a throwaway dir in the argent-p3 checkout (do not
  commit), plus a Markdown report written to
  `/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-02-open-vs-proprietary-results.md`
  with: environment, exact commits/versions, tables per verb (OFF-1 / ON /
  OFF-2), fidelity table, cold start, failures, and a 5-line plain-English
  verdict (where open wins, where proprietary wins, where equal, caveats).
  English, terse, measured data only — no adjectives without a number.
- Keep the bench script if reasonably clean as
  `packages/tool-server/scripts/bench-open-vs-proprietary.ts` (opt-in, no
  test), commit locally `chore(android-open-server): backend benchmark
  script`; do not push.
- Tear the emulator down.

## Acceptance
- Report file exists with real numbers from ≥20 iterations per verb per
  config (or an explicit reason a config/verb could not run).
- No changes to server/tool code (measurement only). If a defect is found,
  report it — do not fix in this ticket.
