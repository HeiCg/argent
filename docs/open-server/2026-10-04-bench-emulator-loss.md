# Android bench: emulator lost mid-run (2026-10-04)

Branch `ci/bench-emulator-diagnostics`, stacked on #11 (simslim), #10 (re-baseline 0.27)
and #9. Root cause: not established.

## Incident

Workflow `bench-open-vs-proprietary.yml` (ubuntu-latest + KVM, API 34 `google_apis`
x86_64, `-read-only -no-snapshot -gpu swiftshader_indirect`, 4096 MB / 2 vCPU AVD).

| Run         | Branch                      | Runner image   | Emulator             | Latency job | Screen-graph job |
| ----------- | --------------------------- | -------------- | -------------------- | ----------- | ---------------- |
| 34954772917 | feat/open-server-a3-consol. | 20260907.300.1 | not logged           | success     | not run          |
| 34970043301 | feat/screen-graph-e1-templ. | 20260907.300.1 | not logged           | not run     | success          |
| 37213141861 | merge/upstream-2026-10-04   | 20260927.320.1 | no artifact          | failure     | failure          |
| 37215518035 | feat/bench-rebaseline-0.27  | 20260927.320.1 | 37.2.12.0 (16428233) | failure     | **success**      |

The emulator line of the last good runs is unknown: the workflow installs
`sdkmanager "emulator"` unpinned, and their artifacts are no longer available.

**37215518035, latency job.** `ON-uiautomation` started 16:32:12. `logcat-bench.txt` ends
16:36:47. `logs/emulator.log`:

```
ERROR | detected a hanging thread 'QEMU2 main loop'. No response for 15949 ms
ERROR | detected a hanging thread 'QEMU2 CPU0 thread'. No response for 17797 ms
ERROR | detected a hanging thread 'QEMU2 CPU1 thread'. No response for 19755 ms
ERROR | detected a hanging thread 'QEMU2 main loop'. No response for 15211 ms
[4127:4127:20261004,163809.847670:ERROR ptracer.cc:454] ptrace: No such process (3)
```

then crashpad `scoped_ptrace_attach` errors until 16:42:09. The bench failed at 16:42:18
(`adb -s emulator-5554 shell am force-stop com.android.settings` failed). Guest logcat
before the freeze: 0 ANR lines, 0 `lmkd` lines, 0 native `Fatal signal`. 16
`AndroidRuntime: FATAL EXCEPTION` lines between 16:17 and 16:34:15, all in the argent
instrumentation / helper processes (`UiAutomationService ... IllegalStateException`,
`argent-androiddevtools-shutdown`), recurring through the whole run.

**37215518035, screen-graph job.** B1 100/100 (16:28:11). Same four hang-detector lines,
crashpad from 16:41:43. B2 "aborted after 3 consecutive task errors" at 16:49:57 (87
runs, 3 excluded, `adb: device 'emulator-5554' not found`). O1..O5 each aborted after 3
task errors, 17-18 s apart, with 0 or 1 of 3 scored. Store invariants OK, job
**SUCCESS**. That is a false green: `main().then(() => process.exit(0))` also discarded
`process.exitCode`, so not even a store-invariant failure could fail the job.

**37213141861.** No artifact uploaded. Latency: last bench output 15:52:53, silent for
4 min 20 s, then `exit code 143` and "The runner has received a shutdown signal" at
15:57:13. Screen-graph: B1 100/100 at 15:50:53, silent for 11 min 20 s, then the same
at 16:02:13. Whether the emulator died first is not observable from the step logs.

What we could not tell apart: an emulator-version regression (37.2.12 is the current
stable; the good runs' version was never recorded), a runner-image change
(20260907.300.1 → 20260927.320.1) and host starvation (nothing sampled memory, CPU, swap
or dmesg; the emulator crash db was not uploaded).

## What this change adds

All in `.github/bench-ci/emulator-diagnostics.sh` (+ `emulator-diagnostics.js`), used by
both jobs of `bench-open-vs-proprietary.yml` and both jobs of `bench-androidworld.yml`.

- `ci-emulator-env.json` after the SDK install: emulator version + build id + package
  revision, system-image revision, `adb version`, `$ImageOS`/`$ImageVersion`, kernel,
  `nproc`, `free -m`, `-gpu`, RAM. Uploaded; embedded as `emulator` in the latency merged
  JSON (+ scoreboard rows) and in `bench-sg-*.json` (+ env row in `results-ci.md`).
  Absent in old JSONs: merges and regen still work.
- Host sampler during the bench step: one line per 30 s to `logs/host-sampler.log` (UTC,
  mem available, swap used, load, RSS and %CPU of `qemu-system-*`, `simulator-server`
  count, top-3 RSS); a heartbeat line in the step log every 2 min. Never fails the job;
  killed in an `if: always()` step.
- Post-mortem (`if: always()`, `logs/postmortem/`): `dmesg -T | tail -300` with
  oom / `Out of memory` / `Killed process` / `kvm` highlights, `adb devices -l`, emulator
  pid liveness, `emulator.log` tail, `/tmp/android-*/emu-crash-*.db` and dumps (50 MB
  cap), last 400 logcat lines if adb still answers.
- Dispatch inputs: `emulator_build` (empty = `sdkmanager "emulator"`, as before; a build
  id installs `emulator-linux_x64-<build>.zip` from dl.google.com, 404 fails the job
  early, `emulator -version` must report the build), `emulator_gpu` (default
  `swiftshader_indirect`), `emulator_memory_mb` (default 4096). Defaults change nothing.
- Liveness watchdog during the bench step: every 10 s, qemu process + `adb -s <serial>
get-state`. qemu gone (once seen) or 3 consecutive non-`device` reads →
  `::error::emulator lost at <UTC> (block|config <name>)`, `emulator-lost.json`, SIGTERM
  to the bench process tree, SIGKILL after 30 s. No emulator restart.
- Fail-closed:
  - Latency: remaining blocks are skipped, `merge-blocks.js` writes a merged JSON for
    the completed blocks with `partial: true`, `emulatorLost`, `missingBlocks`; the
    scoreboard prints a PARTIAL banner; the step and job fail.
  - Screen-graph (`src/screen-graph/bench/validity.ts`): a config aborted after
    consecutive task errors, with any pre-action infra exclusion, with fewer task-runs
    than planned, or interrupted / not run because of the watchdog is
    `INVALID (emulator lost)` in `results-ci.md` (no success rate, a `## Validity`
    section) and the harness exits 1 after writing the JSON + report. On the watchdog's
    SIGTERM the harness writes the partial JSON + report first. Locate/action/oracle
    failures keep their meaning (failures, not invalidations). The exit code now
    honours `process.exitCode`. Regenerating 37215518035's JSON: B1 valid, B2 and O1..O5
    INVALID, exit 1.
  - A final `if: always()` step fails the job on the emulator-lost marker.

Measured verbs, N, settle times and statistics are unchanged.

## Control runs

Pinned emulator builds checked on dl.google.com (HEAD 200, `Pkg.Revision` read from the
zip): 15004761 = 36.4.10, 14788078 = 36.4.9, 14214601 = 36.2.12, 13610412 = 35.6.11.
16428233 = 37.2.12 (current stable).

```
gh workflow run bench-open-vs-proprietary.yml --repo HeiCg/argent --ref ci/bench-emulator-diagnostics -f suite=both
gh workflow run bench-open-vs-proprietary.yml --repo HeiCg/argent --ref ci/bench-emulator-diagnostics -f suite=both -f emulator_build=15004761
```

## Result

- Default emulator (37.2.12 expected): TODO(run-id)
- Pinned 36.4.10 (15004761): TODO(run-id)
