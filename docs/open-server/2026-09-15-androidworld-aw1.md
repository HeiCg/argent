# Ticket: AW-1 — AndroidWorld harness end to end (fixed agent, open driver, two tiers, five tasks, one run)

From `2026-09-15-androidworld-research.md` § 6 (read it in full; §1–§5 carry the file:line
and URL evidence). Base: `open/main` @ HEAD (≥ 5295c077). Everything in this ticket is
CI-only on the Linux KVM runner (no macOS minutes).

## Step 0 — blocking pre-flight probe (own CI run, short)

On the CI emulator (API **33**, `google_apis`, x86_64; boot WITHOUT `-grpc-use-token`):
start our instrumentation (`am instrument … DeviceControlInstrumentation`), then install
AndroidWorld's a11y forwarder and read its forest, and run `uiautomator dump`. Record both
outcomes. If the forest is empty / dump fails while our server is alive: add
`FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES` to the `getUiAutomation` call
(`DeviceControlInstrumentation.kt:49-69`, minimal Kotlin diff, read twice), re-probe, and
note that the describe latencies must be re-measured against run 34870686468 at the drift
floor before any latency row is trusted on that build (schedule it as AW-1.1, do not fold
into this run). Pre-register the choice in the Result before running the harness.

## Step 1 — adapter (Python, `bench/androidworld/`, outside `packages/`)

Exactly the four files of the research §6: `claude_wrapper.py` (`LlmWrapper` over the
`anthropic` SDK, model `claude-opus-5`, one explicit `effort` recorded in the manifest,
never forward `temperature`, record `usage.input_tokens`/`output_tokens` per call),
`tiered_agent.py` (T3A with the observation slot replaced by our tool-server `describe`
`tier=<arm>`; prefix, guidance, history format and action grammar byte-identical across
arms), `driver_env.py` (`get_state()` from our server with an index↔node table so
`click{index}` resolves; `execute_action()` mapping the 14 `JSONAction` types per the §1
table — `double_tap` via two taps, `clear_text` via select-all+delete, `wait` via
`await-screen-idle`; AndroidWorld's own env kept for `initialize_task` / `is_successful`
/ `tear_down` / adb; a11y forwarder disabled), `run_aw.py` (thin wrapper over
`suite_utils`; `--tasks`, `--n_task_combinations=1`, pinned `--task_random_seed`,
checkpoint dir; JSON per episode: task id, tier, steps, per-step observation tokens (ours

- API usage), per-step wall ms, `is_successful`, AW commit SHA, AVD fingerprint).
  Vendor nothing from `android_world`; pin its commit in `requirements.txt`.

## Step 2 — five tasks, two tiers, one model

Tasks: pick five from `android_world/task_registry.py` at ticket time — apps AW installs
itself, deterministic checkers, complexity 1–2, no network, no clock drift (candidates
`ContactsAddContact`, `ClockStopWatchRunning`, three from Markor / Tasks /
SimpleCalendarPro); pin name + seed in the Result. Tiers: `compact` and `full` (`summary`
needs the graph, `index` does not exist yet — AW-2). Model: `claude-opus-5`, one effort,
temperature unset. Pre-registered gates (write before the run): G0 harness completes all
10 episodes with a terminal `is_successful` per episode; G1 per-task pass/fail table per
tier (never a mean over 5); G2 tokens/step per tier (API usage) with the observation
share; G3 s/step per tier; G4 manifest: AW commit, tier, model, effort, seed, task list,
AVD fingerprint; G5 cost from API usage. No capability claim.

## Step 3 — one CI run

New `bench-androidworld.yml` (`workflow_dispatch`), reusing the KVM/SDK steps of
`bench-open-vs-proprietary.yml` with: image `system-images;android-33;google_apis;x86_64`,
boot without `-grpc-use-token`, `--perform_emulator_setup` step (cache the app-data
download if the workflow can), `ANTHROPIC_API_KEY` from repo secrets (the owner adds it;
if absent, STOP after step 0/1 with the exact secret name needed), `timeout-minutes: 180`.
Budget: step 0 probe run + one harness run (+1 retry if a harness defect, not a task
flake). Polling: one `gh run view` per 10 min as a single background `sleep 540; gh run
view` call; never loop; one `gh run download`. Estimated ≈ 60 min and ≈ $3 of model spend.

## Process

Branch `feat/androidworld-aw1`, worktree `../argent-fork-wt-aw1` (never /tmp; root
`node_modules` symlinked; no npm install / gradle / emulator locally; Python deps only in
CI — no `pip install` in the worktree). Open a PR to `open/main` for the hygiene checks
(prettier-clean; knip may need the new dir ignored — register it, do not disable). Do not
touch iOS files or the A2 branch's files. Append `## Result` with the probe outcome, the
task table, G0–G5, run ids, and the exact things left for AW-2 (index tier, summary tier,
20×4 matrix one job per tier). Adversarial review before merge; do not fast-forward
`open/main`.
