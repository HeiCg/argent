# Ticket: bench-in-CI — run the open-vs-proprietary benches on a GitHub-hosted Linux/KVM runner

Why: the local host is memory-exhausted (24 GB RAM, 15 GB swap, <100 MB
free) and blocks every device bench. Upstream argent already boots an
Android emulator on `ubuntu-latest` with KVM (`.github/workflows/wayland-e2e.yml`
+ `.github/actions/*`). Reuse that to run our benches off-host.

Repo: ARGENT FORK. Worktree: create
`/private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-ci`
on branch `feat/bench-ci` from `feat/android-open-server-p3g` (b8d2e242 =
3e+3f+3g code, APK contract vc21). Never edit argent-p3/p3f/p3g/sg. NO local
emulator, NO adb against local devices. Commit locally, then PUSH this branch
(it must reach GitHub to run) and trigger with `gh workflow run`.

## Workflow `.github/workflows/bench-open-vs-proprietary.yml`
- `workflow_dispatch` only, inputs: `blocks` (default
  `OFF-1,ON-uiautomation,ON-scrcpy,OFF-2`), `n` (default 20), `suite`
  (`latency` | `screen-graph` | `both`, default `latency`).
- `runs-on: ubuntu-latest`, `timeout-minutes: 120`. Copy the KVM + SDK +
  AVD boot steps from `wayland-e2e.yml` / its composite actions verbatim
  (udev kvm rule, sdkmanager, avdmanager, boot with the same image family;
  x86_64 API 35 google_apis if that is what upstream uses — read it). Add
  `-grpc 8554 -grpc-use-token` to the emulator args (the proprietary
  simulator-server requires it). Disable animations.
- Build the device server APK in the job (`npm run build:android-device-server`
  with Java 17 — upstream CI already has a Kotlin build step somewhere; reuse).
- Proprietary binaries for the OFF blocks: `npm pack @swmansion/argent@0.22.1`
  from the public npm registry into a temp dir and point the bench at it the
  way `bench-open-vs-proprietary.ts` locates `simulatorServerDir` (see the
  script + `2026-09-02-open-vs-proprietary-bench.md`). Their LICENSE forbids
  redistribution, not use — do not commit the tarball; download at run time.
  If the binary refuses to start on Linux (it ships `bin/linux/`), report and
  run ON blocks only.
- Run, in order, each as its own step with `continue-on-error: false` and
  logs uploaded regardless: (1) device test `OPEN_SERVER_DEVICE_TESTS=1`;
  (2) latency bench 4 blocks via the existing per-block runner
  (`BENCH_ONLY`), then merge; (3) fling A/B (Kotlin vs scrcpy) if
  `ON-scrcpy` in blocks; (4) 3g stage-timing table (the bench already emits
  it); (5) if `suite` includes `screen-graph`: check out `feat/screen-graph`
  @ 5b1e6e98 into a second dir, run `scripts/bench-preflight.ts` then the
  20×7×3 matrix — this is long; make it a separate job with its own
  emulator so it can run in parallel.
- Record `nproc`, RAM, `vm.swapusage`-equivalent (`free -m`), emulator
  image/arch, and KVM presence into the JSON `env` block.
- Upload `.bench-results/**`, logs, and the generated Markdown as artifacts;
  print the scoreboard table into the job summary (`$GITHUB_STEP_SUMMARY`).

## Report
Write `/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-03-open-vs-proprietary-results-ci.md`
from the downloaded artifacts (`gh run download`): same tables as v4–v6,
plus a clear banner that this is x86_64/KVM on a hosted runner and is NOT
comparable to the local arm64/HVF numbers — only OFF vs ON within the same
run is like-for-like. Include OFF-1/OFF-2 drift and fallbacks per block.

## Acceptance
- Workflow green (or ON-only with the proprietary refusal documented).
- Artifacts downloaded; report written; branch pushed; run URL in the
  report.
