# Ticket: AW-0 — research: AndroidWorld with a fixed agent, swapping only the driver / observation tier

README "Execution order" step 5. Goal: an end-to-end benchmark where the agent (model +
prompt) is FIXED and only the device driver and the observation tier vary: proprietary
`simulator-server` describe vs open driver `full` / `summary` / `compact` / `index` tiers,
measuring task success, tokens per step and seconds per step on AndroidWorld tasks. Read-
only research; no code, no builds, no CI. Output: `## Findings` appended to this file
(prettier-clean).

## Questions (file:line or URL evidence for every claim)

1. AndroidWorld (google-research/android_world) today: task suite size and categories,
   the agent interface (observation = screenshot + UI tree? action space?), how it drives
   the emulator (its own `adb`-based env), required AVD image (which API / Play?), how it
   scores tasks (checkers on device state), licence, and what a "fixed agent" looks like
   there (M3A / T3A baselines: prompts, models). Which of its actions map 1:1 to our
   tools (tap / swipe / type / key / open app / wait) and which do not.
2. Integration shape: (a) AndroidWorld's env drives the emulator while our tool-server
   is used only for OBSERVATION (describe tiers), or (b) our driver executes the actions
   too (one `adb` per emulator; conflicts with AndroidWorld's own adb use?). What the
   task checkers need (device state via adb — compatible with our server running as
   instrumentation on the same emulator?). Cost of an adapter in Python vs TS.
3. Runner: our CI job runs an x86_64 KVM emulator (API 34, `google_apis`) — does
   AndroidWorld require a specific system image / Play services / apps preinstalled
   (it installs its own APKs?), how long is one task, how many tasks fit in a 6 h job,
   what a 20-task × 4-tier × 1-model run costs in minutes. Any self-hosted alternative.
4. Model: the fixed agent's model must be the same for all tiers; which Claude model and
   how the harness is called (API keys in CI secrets), expected cost per run at
   ~50 steps × 20 tasks × 4 tiers with 200–700 tokens/step observations.
5. What Artemis (google/artemis, Apache-2.0) reports on AndroidWorld and how its
   observation differs (element-index), so our `index` tier comparison is apples to
   apples; what the closed argent driver cannot do here (no describe tiers).
6. Recommendation: the minimal AW-1 ticket (adapter + 5 tasks + 2 tiers + 1 model, one CI
   run) and its risks (flakiness of AndroidWorld tasks, emulator time, model cost).

## Process

Researcher, read-only: clone nothing under the repo; use `WebFetch`/`WebSearch` on the
public AndroidWorld and Artemis repos/papers; look at `packages/tool-server/src/screen-
graph/bench/` for our harness shape and `.github/workflows/bench-open-vs-proprietary.yml`
for the emulator recipe. Append `## Findings` here with a python heredoc; every claim
with a URL or path. No agents beyond yourself.
