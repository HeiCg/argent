# iOS simslim: opt-in slim simulators (2026-10-04)

Branch `feat/ios-simslim`, stacked on #10 (re-baseline 0.27) and #9.

## What

[simslim](https://github.com/MobAI-App/simslim) (MIT, Go CLI, v0.11.0) writes persistent
`launchctl disable` entries for ~170 launchd labels an iOS simulator does not need and
reboots it. Its README reports 4.0 GB → 0.9 GB phys_footprint for one simulator (M1 Pro,
16 GB). We have not measured that; G4 below does.

Integrated as an external binary, opt-in, never vendored or ported.

## Design

- Config: `ios.simslim.profile` (project/global, project wins; relative paths resolve per
  scope like `ios.additionalDeviceSets`; unset = off). `ios.simslim.binary` (global only,
  default `simslim` on PATH): a checked-in project config must not pick the executable
  `boot-device` runs.
- `boot-device` (`bootIos`), `packages/tool-server/src/utils/ios-simslim.ts`:
  - Gate: profile set, listed local iOS simulator (not tvOS, not remote, not physical),
    state Shutdown or shut down by `force`, runtime ≥ 18.5.
  - After the pre-boot AX plist write, before `simctl boot`: `simslim --version`, then
    `simslim on <udid> --profile <abs> [--set <deviceSet>]`, `SIMSLIM_BOOT_TIMEOUT`
    defaulted to 15m, killed at that deadline + 60 s. `on` reboots, so it must precede the
    post-boot `DYLD_INSERT_LIBRARIES` setup; the AX plist is on disk and survives.
  - Then the stock sequence unchanged (`simctl boot` tolerating Booted, `bootstatus -b`,
    `ensureAutomationEnabled`, `reverifyEnv`), then `simslim verify --json` and
    `simslim status --json`.
  - Result: `slim: {applied, verdict, managedDisabled, managedTotal, profile, version}` and
    at most one `warning` sentence. simslim never fails a boot; no retries. Unset = zero
    spawns, result byte-identical.
- CI: `.github/simslim/ci.json` keeps `com.apple.swcd` (universal links, category `web`;
  `open-url` exercises it). `.github/bench-ci/install-simslim.sh` pins v0.11.0 arm64 by
  sha256. `.github/bench-ci/simslim-ci.sh boot|snapshot`. Workflows
  `bench-ios-open-vs-proprietary`, `bench-ios-siminput-discriminating`,
  `ios-open-server-device-test` take `slim` (boolean, default false): `simslim on` +
  `bootstatus -b` + `verify` (drift fails the job) + `measure`; false = unchanged.
- iOS bench: one simulator boot serves every block (no block boots, shuts down or
  recreates it), so the blocks share the slim state by construction. simslim is installed
  in both modes; stock runs only call `status`/`measure`. `simulator.json` (after boot) and
  `block.simulator` (after each block) record
  `{slim, simslimVersion, profileSha256, managedDisabled, managedTotal, measure}`. The
  merge refuses blocks whose slim state differs; the scoreboard renders the record.

## Pre-registered gates (later CI runs; not run here)

- **G1** `ios-open-server-device-test` with `slim=true`: device suite green.
- **G2** `bench-ios-open-vs-proprietary` with `slim=true`: landing rate unchanged (100 %)
  in every block.
- **G3** Per-verb p50/p95 slim vs stock, both arms (OFF and ON). Descriptive.
- **G4** `measure.bytes` slim vs stock on the same runner image. Descriptive.

Stock and slim runs are separate dispatches; G3/G4 compare a pair on the same image.

## Result

TODO(run-id)
