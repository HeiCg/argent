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

## Result

Branch `feat/androidworld-aw1`, worktree `../argent-fork-wt-aw1`, PR **#7** to
`open/main`. Everything CI-only (no macOS minutes, no local emulator/pip). x86_64/KVM
here is NOT comparable to local numbers; AW-1's output is "the harness runs and the
tiers differ by X tokens/step at equal success", nothing stronger.

### Step 0 — a11y-suppression probe (blocking): SUPPRESSION CONFIRMED → flag added

Probe run **34946274170** (API 33, `google_apis`, x86_64; booted WITHOUT
`-grpc-use-token`). Our instrumentation was alive (ephemeral port 45971). While it held
its `UiAutomation`:

- `uiautomator dump`: **FAILED** — 0 bytes (no second `UiAutomation` available).
- AndroidWorld a11y forest (its controller `get_a11y_forest()`): **FAILED** —
  `RuntimeError: Could not get a11y tree.`

Research §2's inference is confirmed on device: a default `UiAutomation` connection
suppresses other accessibility services for its lifetime, so while our server is alive
AndroidWorld's forwarder forest and `uiautomator dump` are dead.

**Pre-registered choice (before any harness run): ADD
`FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`.** The harness keeps AW's own env for
`initialize_task`/`is_successful`/`tear_down`/adb, and AW's env reads the forest on
`reset`/checkers — so it must coexist with our `UiAutomation`.
`DeviceControlInstrumentation.getUiAutomation` now passes the flag (minimal Kotlin diff,
`packages/android-device-server/src/main/java/com/argent/devicecontrol/DeviceControlInstrumentation.kt:63`).

**Re-probe run 34947435250 (with the flag): harness blocker RESOLVED.** With our server
alive, AndroidWorld's a11y forwarder forest now returns — `aw_forest.ok=true`, **2 windows,
23 nodes, 19 ui_elements** — so AW's env (reset + checkers) reads the tree it needs.
`uiautomator dump` still returns 0 bytes, but that is informational: `uiautomator dump`
needs its own separate `UiAutomation`, which conflicts with our instrumentation regardless
of the flag, and the harness uses AW's forwarder forest (`A11Y_FORWARDER_APP` method), not
the dump. The probe verdict was refined to key on the forwarder forest (the
harness-relevant signal); the flag is validated and the harness is a go once the secret
lands.

**Latency caveat — AW-1.1, NOT folded into AW-1:** suppression is also what makes our
describe reads cheap, so the flag is a driver behavior change. The describe latencies must
be re-measured against run 34870686468 at the within-run drift floor before any latency
row is trusted on a build carrying this flag; do not reuse 34870686468 as a comparator for
this build.

### Step 1 — adapter (`bench/androidworld/`, outside `packages/`, nothing vendored)

- `claude_wrapper.py` — `ClaudeWrapper` over the `anthropic` SDK: `claude-opus-5`, one
  `effort` (`medium`) in the manifest, temperature never forwarded, thinking left at the
  Opus 5 default, `usage.input_tokens`/`output_tokens` recorded per call. No refusal
  fallback (it would break the one-model invariant).
- `tiered_agent.py` — `TieredAgent` = AndroidWorld `T3A` with the observation swapped for
  our describe `tier=<arm>`; `PROMPT_PREFIX`, `GUIDANCE`,
  `ACTION_SELECTION_PROMPT_TEMPLATE`, history format and the `JSONAction` grammar are
  byte-identical across arms; the screenshot-only `add_ui_element_mark` is dropped.
- `driver_env.py` — `OpenDriverEnv` observes via `describe` (index↔node table built from
  each line's normalized `(x,y,w,h)` frame) and acts through our tools per the §1 table
  (double_tap = two taps, long_press = `gesture-custom` hold, clear_text = select-all +
  delete, wait = `await-screen-idle`, Android scroll = `gesture-swipe`); AW's env kept for
  init/checker/teardown/adb; a11y forwarder never read by the harness (shape b).
- `run_aw.py` — `setup` + `run`; one seeded param set per task reused across tiers;
  per-episode JSON (tokens ours + API usage, wall ms, terminal `is_successful`, AW commit,
  AVD fingerprint) + manifest + gates.

**Tool-server entry point used:** the standalone HTTP server, started by
`node packages/tool-server/dist/index.js start` (`ARGENT_PORT=3001`, `ARGENT_HOST=127.0.0.1`,
`ARGENT_AUTH_TOKEN` unset = no auth), needing only `npm ci` + `tsc --build` (no
`@swmansion/argent` bundle). The open driver is enabled by
`setFlag("open-device-server", true, "global")` from `@argent/configuration-core`
(re-read per request). The adapter POSTs `http://127.0.0.1:3001/tools/<name>` with
`{"udid":"emulator-5554", ...}` and reads the response `data`
(`packages/tool-server/src/index.ts:397`, `packages/tool-server/src/http.ts:616`,
`packages/configuration-core/src/flags.ts:72`). Describe frames are normalized 0–1
(`packages/tool-server/src/tools/describe/platforms/android/open-server-tree.ts:75`),
matching `gesture-tap`'s normalized input.

### Step 2 — five tasks, two tiers, one model (pinned)

Verified at the pinned AW commit `e3fea3ccc69787570e282c99573298f1c3019a34`:

| task                           | complexity | app                 |
| ------------------------------ | ---------- | ------------------- |
| `ContactsAddContact`           | 1.2        | contacts (system)   |
| `ClockStopWatchRunning`        | 1          | clock (system)      |
| `MarkorCreateFolder`           | 1          | markor              |
| `MarkorDeleteNote`             | 1          | markor              |
| `SimpleCalendarDeleteOneEvent` | 1.2        | simple calendar pro |

`--task_random_seed = 30`, `--n_task_combinations = 1`. One seeded param set per task,
reused across both tiers (the tier is the only variable). Tiers `compact` + `full`
(`summary` needs the graph, `index` does not exist yet — both AW-2). Model
`claude-opus-5`, effort `medium`, temperature unset. Prompt caching off (identical across
arms).

### Pre-registered gates (before the run)

- **G0** — the harness completes all 10 episodes, each with a terminal `is_successful`
  (a float per episode; never a mean over 5).
- **G1** — per-task pass/fail table per tier.
- **G2** — tokens/step per tier from API usage, with the observation share (our o200k
  observation tokens ÷ API input tokens/step).
- **G3** — s/step per tier.
- **G4** — manifest: AW commit, tier list, model, effort, seed, task list, AVD fingerprint.
- **G5** — cost from API usage at claude-opus-5 list price ($5 / $25 per MTok).

No capability claim.

### Step 3 — one run: BLOCKED on the `ANTHROPIC_API_KEY` repo secret

The secret is not set today. Exact secret name: **`ANTHROPIC_API_KEY`** (repo-level, Settings
→ Secrets and variables → Actions). Once the owner adds it, dispatch:

```
gh workflow run bench-androidworld.yml --ref feat/androidworld-aw1 \
  -f job=harness \
  -f tasks="ContactsAddContact,ClockStopWatchRunning,MarkorCreateFolder,MarkorDeleteNote,SimpleCalendarDeleteOneEvent" \
  -f tiers="compact,full" \
  -f seed=30
```

Estimate ≈ 60 min wall (≈ 30 min fixed setup + AW app install, ≈ 20 min run, ≈ 10 min
init/teardown), well inside the 180-min cap; ≈ **$3** model spend (≈ 120 calls × ~2 000 in
/ ~450 out on Opus 5), budget $10 for one re-run. Budget: one harness run, +1 retry ONLY
for a harness defect (never a task flake); re-run the same seed before reading any delta.

### Runs / hygiene

- Probe **34946274170** (suppression confirmed); re-probe **34947435250** (flag validated —
  forwarder forest returns 23 nodes/19 elements with our server alive).
- PR **#7** → `open/main`: Prettier, ESLint, Knip, Static checks, Unit tests, lockfile all
  PASS. `bench/androidworld/` is Python-only and outside knip's JS/TS workspace
  scope, so no knip config change or rule-disable was needed (knip stays green). Prettier
  clean. No iOS files or A2-branch files touched; scoreboard untouched; `open/main` not
  fast-forwarded (PR only).

### Left for AW-2

The `index` tier (ship the describe `index` tier first), the `summary` tier
(graph-dependent), and the full 20×4 matrix as one job per tier (the full grid does not fit
one 6 h job — research §3). Plus **AW-1.1**: re-measure describe latencies on the
flag-carrying build against run 34870686468 at the drift floor.
