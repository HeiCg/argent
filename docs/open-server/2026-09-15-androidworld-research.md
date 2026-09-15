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

## Findings

Read-only research, 2026-09-15. Every claim carries a URL or a `path:line`. Where a number is
an estimate rather than a measurement, it says "estimate".

### 1. AndroidWorld today

- **Suite.** "116 diverse tasks across 20 real-world apps", dynamically parameterized
  ("millions of unique variations") — https://github.com/google-research/android_world
  (README) and the paper, arXiv 2405.14573 ("reward signals for 116 programmatic tasks
  across 20 real-world Android apps"). Categories are per-app, not per-difficulty: the 20
  apps are the ones installed at setup (next bullet). The paper's best baseline completes
  **30.6 %** of tasks ("Our best agent can complete 30.6% of AndroidWorld's tasks",
  https://arxiv.org/abs/2405.14573); no human-baseline number was found in the abstract page.
- **Licence.** Apache License 2.0 (https://github.com/google-research/android_world/blob/main/LICENSE);
  MIT for the vendored MiniWoB HTML assets. The README also says "This is not an officially
  supported Google product."
- **Agent interface.** Agents subclass `EnvironmentInteractingAgent` and implement `step()`;
  each step reads state, picks an action from `json_action.py`, executes it through the env
  and returns `AgentInteractionResult` with `done` (README). The observation is
  `State` with three fields — `pixels` (RGB screenshot), `forest` (raw a11y forest) and
  `ui_elements` (processed elements):
  `android_world/env/interface.py`, `def get_state(self, wait_to_stabilize: bool = False) -> State`
  and `def execute_action(self, action: json_action.JSONAction) -> None`.
  So **screenshot AND UI tree are both available**; T3A uses only the tree, M3A uses both.
- **Action space** (`android_world/env/json_action.py`, 14 constants): `click`, `double_tap`,
  `scroll`, `swipe`, `input_text`, `navigate_home`, `navigate_back`, `keyboard_enter`,
  `open_app`, `status`, `wait`, `long_press`, `answer`, `unknown`. `JSONAction` fields:
  `action_type, index, x, y, text, direction, goal_status, app_name, keycode, clear_text`.
  A click is normally by **element index**, with x/y as the alternative.
- **Mapping to our tools** (1:1 unless noted):

  | AndroidWorld                             | our tool                                          | note                                                                                                                 |
  | ---------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
  | `click` (index)                          | `gesture-tap`                                     | ours takes a selector/point, not an index — the adapter must resolve index → node/point from the same tree it served |
  | `long_press`                             | `gesture-tap` (press duration) / `gesture-custom` | check duration parameter exists                                                                                      |
  | `double_tap`                             | `gesture-tap` ×2 or `run-sequence`                | no native double-tap tool in `packages/tool-server/src/tools/`                                                       |
  | `scroll` / `swipe`                       | `gesture-scroll` / `gesture-swipe`                | direction semantics differ (content vs finger); needs a fixed convention                                             |
  | `input_text`                             | `keyboard` `{text}`                               | `clear_text: true` has no direct flag; needs select-all+delete                                                       |
  | `keyboard_enter`                         | `keyboard` `{key:"enter"}`                        | `packages/tool-server/src/tools/keyboard/index.ts:120`                                                               |
  | `navigate_home` / `navigate_back`        | `button` `{home\|back}`                           | `packages/tool-server/src/tools/button/index.ts:15,34`                                                               |
  | `open_app`                               | `launch-app`                                      | AW resolves app names through its own registry                                                                       |
  | `wait`                                   | `await-screen-idle`                               | not identical: AW `wait` is a fixed sleep                                                                            |
  | `status` (complete/infeasible), `answer` | **no equivalent**                                 | pure agent-protocol, handled in the adapter, never reaches the driver                                                |

- **Emulator + image.** README: create the AVD with **Pixel 6, system image Tiramisu API 33**,
  name `AndroidWorldAvd`, and boot it with `-grpc 8554` ("mandatory for accessibility
  forwarding"). `android_world/env/env_launcher.py` **attaches to an already-running
  emulator** via `console_port` / `grpc_port` and carries the comment "AndroidWorld is
  tested and developed on Pixel 6 with API 33". `setup_apps(env)` runs only when
  `emulator_setup=True`; `datetime_utils.setup_datetime` freezes the clock by default.
- **What setup installs.** `android_world/env/setup_device/setup.py` installs 24 APKs:
  AndroidWorldApp, AudioRecorder, CameraApp, ChromeApp, ClipperApp, ClockApp, ContactsApp,
  DialerApp, ExpenseApp, FilesApp, JoplinApp, MarkorApp, MiniWobApp, OpenTracksApp, OsmAndApp,
  RecipeApp, RetroMusicApp, SettingsApp, SimpleCalendarProApp, SimpleDrawProApp,
  SimpleGalleryProApp, SimpleSMSMessengerApp, TasksApp, VlcApp — downloaded via
  `apps.download_app_data()` and installed with `adb_utils.install_apk()`. Nothing in that file
  requires a **Play** image (`google_apis` is enough on the evidence seen); not proven either way.
- **Scoring.** `android_world/task_evals/task_eval.py`: `is_successful()` returns a float
  ("0: Not successful. 1.0: Task is successful."; composite = `sum(successful)/total`), plus
  `initialize_task` / `tear_down` and an abstract `complexity`. The paper: tasks have "dedicated
  initialization, success-checking, and tear-down logic, which modifies and inspects the device's
  system state". So checkers are **device-state assertions over adb**, not screen assertions.
- **Fixed agent there.** Baselines are **M3A** (multimodal: screenshot + set-of-mark + tree) and
  **T3A** (text only). `run.py` registers `human_agent`, `random_agent`, `m3a_gemini_gcp`,
  `t3a_gemini_gcp`, `t3a_gpt4`, `m3a_gpt4v`, `seeact`; default `--agent_name=m3a_gpt4v`.
  T3A's observation is literally one line per element:
  `tree_info += f'UI element {index}: {str(ui_element)}\n'` (`android_world/agents/t3a.py`),
  assembled into `ACTION_SELECTION_PROMPT_TEMPLATE` = prefix + goal + history +
  `ui_elements_description` + guidance. **This is the swap point for our tiers.**
- **LLM plumbing.** `android_world/agents/infer.py` defines only `GeminiGcpWrapper` and
  `Gpt4Wrapper` over `LlmWrapper.predict(text_prompt)` /
  `MultimodalLlmWrapper.predict_mm(text_prompt, images)`; env vars `GCP_API_KEY`,
  `OPENAI_API_KEY`; temperature 0.0, `max_tokens` 1000 (GPT-4 path), ≤3–5 retries.
  **There is no Anthropic wrapper — AW-1 must write one.**

### 2. Integration shape

Two candidate shapes, and the blocker that decides between them.

- **(a) AW drives the device, our server only observes.** Cheapest in Python, but it collides
  with how AW reads the tree. `android_world/env/android_world_controller.py` gets the forest
  through an **a11y forwarder app over the emulator's gRPC channel** ("Custom gRPC wrapper that
  uses a11y forwarder app", `apply_a11y_forwarder_app_wrapper(env, install_a11y_forwarding_app)`,
  `grpc_port: int = 8554`, `forest = env.accumulate_new_extras()['accessibility_tree'][-1]`), with
  `uiautomator dump` as the secondary path. Our on-device server holds a **UiAutomation**
  connection obtained with default flags —
  `packages/android-device-server/src/main/java/com/argent/devicecontrol/DeviceControlInstrumentation.kt:49-69`
  (`val uiAutomation = uiAutomation`, then `serviceInfo.flags |= FLAG_RETRIEVE_INTERACTIVE_WINDOWS |
FLAG_REPORT_VIEW_IDS`). **Inference (not verified on device):** a default UiAutomation
  connection suppresses other accessibility services for its lifetime, i.e. while our
  instrumentation is alive AW's forwarder would return an empty/stale forest, and `uiautomator
dump` would fail for want of a second UiAutomation. Mitigation is a one-line Kotlin change
  (`getUiAutomation(FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)`) — but that is a driver change,
  and it must be measured (suppression is also what makes our reads cheap). **This must be
  probed on the emulator before AW-1 is scoped as (a).**
- **(b) our driver acts AND observes; AW keeps only init/checker/adb.** This side-steps the
  a11y collision only if AW's forwarder is never attached (construct the env without the
  a11y wrapper, or accept a dead forest since nothing reads it). It is the shape that matches
  the ticket's goal — the tier under test must be the ONLY observation the agent sees.
  Feasible because AW's device access is otherwise adb-shaped:
  `android_world/env/adb_utils.py` issues `adb_pb2.AdbRequest(generic=...)` through
  `env.execute_adb_call()` (android_env's protobuf adb path), `_DEFAULT_TIMEOUT_SECS = 10`,
  `install_apk` 30 s, `uiautomator_dump` 30 s. Checkers therefore need **adb + the app APKs**,
  not the a11y tree.
- **adb contention.** Our path is the host `adb` binary + `adb forward` +
  NDJSON (`packages/tool-server/src/utils/open-server-transport.ts:9-19`,
  `packages/tool-server/src/blueprints/android-open-server.ts:678`, and the instrumentation
  handshake documented at `DeviceControlInstrumentation.kt:11-24`). AW's adb goes through
  android_env to the same device. Two clients of one adb server is normally fine; the risk is
  android_env restarting/owning the adb server and our `am instrument` session being killed on
  task `tear_down` ("Closes apps and recent windows", `task_eval.py`). Not verified.
- **gRPC token.** Our workflow boots with `-grpc 8554 -grpc-use-token`
  (`.github/workflows/bench-open-vs-proprietary.yml:151`, `:517`) because the **proprietary**
  controller needs the discovery token (`.github/workflows/bench-open-vs-proprietary.yml:9`).
  AW connects to the same port and the README shows a plain `-grpc 8554`. For an AW job that
  does not run the proprietary arm, boot **without** `-grpc-use-token`; if both arms ever run in
  one job, this conflict has to be resolved first. Not verified that AW can pass a token.
- **Cost of the adapter.** Python is clearly cheaper: AW is Python 3.11+ (README) and the
  extension points are two small classes — an `LlmWrapper` subclass for Claude and an agent
  that formats our tier text instead of `_generate_ui_elements_description_list_full`. A TS
  adapter would mean re-implementing the env, the registry and 116 checkers: not viable.
  The Python side talks to our tool-server over its existing HTTP/MCP surface; **inference**:
  ~300–500 lines for shape (b), ~150 for shape (a).

### 3. Runner

- Our recipe installs `system-images;android-34;google_apis;x86_64`
  (`.github/workflows/bench-open-vs-proprietary.yml:112`, `:129`, `:496`, `:506`), device
  `pixel_6` (`:130`), 4 GB RAM / 2 vCPUs (`:138-139`), headless swiftshader, KVM on
  `ubuntu-latest`, job timeouts 120 min (latency, `:52`) and 180 min (screen-graph, `:449`).
  AW wants **API 33** (README; `env_launcher.py` comment). Switching the AW job to
  `system-images;android-33;google_apis;x86_64` is a one-line change and the safe default —
  running AW on 34 is unvalidated upstream and its checkers are app/OS-version sensitive.
- AW installs its own 24 APKs at `--perform_emulator_setup` (§1), so no Play services are
  needed for the apps themselves; **unverified** whether any task needs Play.
- **Per-task time:** not published upstream (searched; the paper does not give runtime, and the
  Midscene AndroidWorld report — https://midscenejs.com/android-world-benchmark-report — gives
  pass@1 93.10 % with Gemini-3.5-Flash but no runtime, steps or cost). The step budget is
  `int(10 * task_complexity)` (`android_world/suite_utils.py`, `_allocate_step_budget`), i.e.
  10–30+ steps cap. Artemis's Flash profile is documented at "~3–5 s per step"
  (https://github.com/google/artemis). **Estimate:** 8–15 real steps/task, ~10 s/step wall
  (device + model), plus init/teardown ≈ 1 min/instance → **3–5 min per task instance**.
- **How many fit in 6 h:** at 4 min/instance, ~80 instances of pure run time in 6 h minus
  ~25 min of SDK/AVD/boot/setup overhead (our boot path alone: `wait-for-device` up to 300 s,
  boot poll up to 360 s, 25 s settle, `.github/workflows/bench-open-vs-proprietary.yml:156-186`).
  **A 20-task × 4-tier × 1-model run is 80 instances ≈ 5.3 h + 0.5 h overhead — it does NOT
  fit one 6 h GitHub-hosted job with margin.** Split it: one job per tier (20 instances,
  ~1.5–2 h each), 4 jobs, matrix. Self-hosted alternative: the same recipe on a Linux box with
  KVM, or a device cloud; nothing AW-specific is needed beyond the emulator.

### 4. Model

- No Anthropic wrapper exists upstream (`infer.py`, §1), so AW-1 writes
  `ClaudeWrapper(LlmWrapper)` on the `anthropic` Python SDK, keyed from a CI secret
  (`ANTHROPIC_API_KEY`), mirroring how `OPENAI_API_KEY` / `GCP_API_KEY` are read today.
- **Model:** `claude-opus-5` ($5 / $25 per MTok input/output, 1M context). Fix it across all
  tiers and pin it in the run manifest, exactly as the bench pins `input-manager` today.
  Thinking is on by default on Opus 5; for a benchmark set `output_config.effort` explicitly
  (`low` or `medium`) and record it — effort is part of the "fixed agent" definition, and
  changing it between tiers would void the comparison. Note upstream defaults temperature 0 and
  `max_tokens` 1000 for GPT-4; Opus 5 rejects `temperature` — the wrapper must not forward it.
- **Cost, ticket's grid (20 tasks × 4 tiers × ~50 steps = 4 000 model calls).** Per call
  (estimate): prompt prefix + guidance ~900 tok, history ~600 tok, observation 200–700 tok for
  our tiers (bench-measured 21–179 for graph tiers vs 651–657 for a full describe,
  `docs/open-server/README.md:46-47`) → ~2 000 input; output with thinking ~450.
  → 8 M input ($40) + 1.8 M output ($45) ≈ **$85 per full run** on Opus 5, before prompt
  caching of the static prefix (which is a large fraction of the input). Sonnet 5 ($2/$10)
  would be ≈ $34 — a downgrade is the owner's call, not the default.

### 5. Artemis, and what the closed driver cannot do

- Artemis is Apache-2.0, drives the device over **adb** and installs an "Artemis Accessibility
  Helper" service; its locating strategy "Uses element indices when available, with coordinate
  and visual locating fallbacks" (https://github.com/google/artemis). Its Flash profile is a
  single-model observe-think-act loop at ~3–5 s/step, no graph orchestration.
- Its AndroidWorld claim is **"99%+ task completion"** on "100+ multi-step tasks", with **no
  model named, no per-task table, no reproduction instructions** in the README. That matches
  the standing note at `docs/open-server/README.md:126` ("Not to take: … the undocumented
  '99 % AndroidWorld' as a reference"). **Do not use it as a comparator**; use it only as the
  source of the element-index observation idea.
- **Apples-to-apples for our `index` tier:** AW's own T3A already emits
  `UI element {index}: {str(ui_element)}` per line (`agents/t3a.py`), so the natural control arm
  is _T3A's own serializer_, and our `index` tier competes against it on the same tasks and
  model. That is a stronger comparison than anything Artemis publishes. Caveat: our `index`
  tier **does not exist yet** — `describe`'s `tier` enum is `["summary","compact","full"]`
  (`packages/tool-server/src/tools/describe/index.ts:81-89`), and the index tier is still an
  unstarted item (`docs/open-server/README.md:78-81`). AW-1 must either ship it first or run
  with the two tiers that exist.
- **The closed driver in this benchmark:** `describe`'s `tier` is "Android open-device-server
  path only" (`packages/tool-server/src/tools/describe/index.ts:84-88`), and `summary` +
  the compact cache require the `screen-graph` flag. The proprietary backend therefore has
  exactly one observation — the full tree — so B1 can appear only as a single baseline column,
  never as a tier sweep. It also cannot answer the on-device `query` the bench oracle uses
  without an instrumentation switch (`packages/tool-server/src/screen-graph/bench/policy.ts:109-112`).
- Third parties do re-run AW against their own driver (Midscene, above) and even "applied
  stability improvements and validation condition updates … to the AndroidWorld benchmark
  itself" — a warning that published AW numbers are not comparable across harnesses. Ours must
  state, per run, the AW commit, the tier, the model, the effort and the task list.

### 6. Recommendation — ticket AW-1

**Goal.** One CI run proving the harness end to end: fixed agent (one model, one prompt), one
device driver (open), **two** observation tiers, **five** AndroidWorld tasks, success +
tokens/step + s/step reported per tier.

**Adapter shape (Python, new dir `bench/androidworld/` outside `packages/`, not vendored into
`android_world`).**

1. `claude_wrapper.py` — `ClaudeWrapper(infer.LlmWrapper)` over the `anthropic` SDK, model
   `claude-opus-5`, `output_config.effort` fixed and logged, no `temperature`, returns
   `(text, is_safe, raw)` and **records `usage.input_tokens` / `output_tokens` per call** (the
   authoritative token number; `js-tiktoken` stays for our own payload accounting,
   `packages/tool-server/src/screen-graph/bench/tokens.ts:26`).
2. `tiered_agent.py` — a `base_agent.EnvironmentInteractingAgent` that is **T3A with the
   observation swapped**: instead of `_generate_ui_elements_description_list_full`, it calls our
   tool-server `describe` with `tier=<arm>` and pastes that text into the same
   `ACTION_SELECTION_PROMPT_TEMPLATE` slot. Prompt prefix, guidance, history format and the
   JSON action grammar stay byte-identical across arms — that is what makes the tiers the only
   variable.
3. `driver_env.py` — an `AsyncEnv`-compatible shim: `get_state()` from our server (tier text +
   an index↔node table so `{"action_type":"click","index":N}` resolves), `execute_action()`
   translating the 14 `JSONAction` types to our tools per the §1 table, and **AW's own env kept
   for `initialize_task` / `is_successful` / `tear_down` / adb**. Construct it with the a11y
   forwarder disabled (see the §2 blocker).
4. `run_aw.py` — thin wrapper over `suite_utils`/`run.py` with `--tasks`,
   `--n_task_combinations=1`, `--task_random_seed` pinned, `--checkpoint_dir`, and a JSON
   artifact per episode: task id, tier, steps, per-step observation tokens (ours + API usage),
   per-step wall ms, terminal `is_successful`, the AW commit SHA and the AVD fingerprint.

**Pre-flight probe (blocking, half a day, before any of the above lands).** On the CI emulator:
start our instrumentation, then read AW's forest. If it comes back empty, AW-1 must either add
`FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES` to `DeviceControlInstrumentation.kt:52` (and
re-measure the describe latencies against run 34870686468 at the drift floor) or drop shape (a)
entirely. Pre-register which.

**Five tasks** — pick from apps AW installs itself, deterministic checkers, complexity 1–2, no
network, no clock drift: e.g. `ContactsAddContact`, `ClockStopWatchRunning` (both named in the
README's own example command), plus three from Markor / Tasks / SimpleCalendarPro — the exact
five to be fixed by reading `registry.py` at ticket time and pinned by name + seed in the ticket.

**Two tiers:** `compact` (our default) and `full`. `summary` is graph-dependent and `index`
does not exist yet — both are AW-2.

**One model:** `claude-opus-5`, one effort level, temperature unset, recorded in the manifest.

**One CI run.** New workflow `bench-androidworld.yml`, `workflow_dispatch`, reusing the KVM/SDK
steps of `bench-open-vs-proprietary.yml` with three edits: image `android-33;google_apis;x86_64`,
boot **without** `-grpc-use-token`, and a `--perform_emulator_setup` step before the agent runs.
`timeout-minutes: 180`.

**Minutes and dollars (estimates, to be replaced by the run's own numbers).**
Setup: SDK+AVD ~5 min, boot+settle ~8 min, AW app install/setup ~15 min → ~30 min fixed.
Run: 5 tasks × 2 tiers × ~12 steps × ~10 s ≈ 20 min + 10 × ~1 min init/teardown ≈ **~60 min
total**, comfortably inside 180. Model spend: 120 calls × (~2 000 in / ~450 out) ≈ 0.24 M in
($1.20) + 0.054 M out ($1.35) ≈ **$3 per run**; budget **$10** for one re-run and retries.

**Risks.**

1. **a11y suppression** (§2) — the single blocker; probe first, and if it bites, AW-1 becomes a
   driver change with its own latency re-validation.
2. **API 33 vs our 34** — new image download, new boot timing, and none of the existing bench
   numbers transfer; AW-1 must not reuse 34870686468 as a comparator.
3. **AW task flakiness** — checkers inspect device state and tasks are randomly parameterized
   (`generate_random_params`); with 5 tasks a single flake moves success by 20 points. Pin
   `--task_random_seed`, `--n_task_combinations=1`, and report per-task pass/fail, never a mean.
   Re-run the same seed before reading anything into a delta.
4. **`--perform_emulator_setup` downloads app data from the network** — a flaky external
   dependency inside the job; cache it or accept the failure mode explicitly.
5. **Cross-arm contamination** — history compaction, prompt caching and `tear_down` behaviour
   must be identical across tiers; a cache hit on one arm and not the other silently changes
   both cost and latency. Pre-register the gate rules before the run, per the house rule at
   `docs/open-server/README.md:115`.
6. **Emulator wall-clock** — the full 20×4 grid does not fit one 6 h job (§3); AW-2 must be a
   matrix, one job per tier, or it will be cut off mid-suite.
7. **Not a capability claim** — one image, one emulator, five tasks. AW-1's output is "the
   harness runs and the tiers differ by X tokens/step at equal success", nothing stronger.
