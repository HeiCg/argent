# Standalone runner

```
argent flow run <name> [--device <id>] [--platform ios|android|chromium|vega]
                       [--update-baselines] [--output <dir>] [--json]
```

Runs a flow with no LLM in the loop and exits non-zero on any failure, which is what makes it usable in CI. Both flow types run: an e2e flow starts from its own `launch`, a fragment runs against the current device state (its prerequisite is printed as a reminder) — useful while authoring, but only e2e flows give a deterministic verdict from a clean start.

`--device` / `--platform` narrow device auto-detection; omitted, the runner binds the single booted device.

## Snapshot baselines

Baselines live in `.argent/flows/__baselines__/<flow>/`, keyed by platform and resolution. A `snapshot` step **fails when no baseline exists** for the run's device class, so:

1. Seed with `--update-baselines`.
2. Have the user review and commit `__baselines__/`.
3. Pin the device class in CI (`--device`/`--platform`, same simulator model) so runs compare against the committed key.

The status bar is pinned for the run (iOS `simctl status_bar`, Android demo mode) so a clock or battery change never drives a visual diff.

`--output <dir>` writes each failed snapshot's baseline/current/diff images to `<dir>/<flow>/` — a stable path for CI artifact upload. `--json` prints the raw report.
