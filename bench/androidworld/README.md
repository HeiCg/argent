# AW-1 — AndroidWorld harness (fixed agent, open driver, two tiers)

One CI run proving the harness end to end: the agent (model + prompt) is FIXED
and the observation **tier** is the only variable. Ticket:
`docs/open-server/2026-09-15-androidworld-aw1.md`; research:
`docs/open-server/2026-09-15-androidworld-research.md`. Everything here runs in
CI only (`.github/workflows/bench-androidworld.yml`) — never locally (machine
resource policy: no local emulator, no local `pip install`).

## Files

| file                | role                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `claude_wrapper.py` | `ClaudeWrapper` over the `anthropic` SDK — `claude-opus-5`, one `effort`, no temperature, records `usage`. |
| `tiered_agent.py`   | `TieredAgent` = AndroidWorld `T3A` with the observation swapped for our describe `tier=<arm>`.             |
| `driver_env.py`     | `OpenDriverEnv` — observes + acts through our tool-server; keeps AW's env for init/checker/teardown/adb.   |
| `run_aw.py`         | harness: `setup` + `run` subcommands, per-episode JSON, manifest, gate tables G0-G5.                       |
| `probe_a11y.py`     | Step 0 blocking pre-flight probe (a11y suppression).                                                       |
| `requirements.txt`  | AndroidWorld pinned by commit; `anthropic`; `requests`; `tiktoken`.                                        |

Nothing is vendored from `android_world`; it is a pinned git dependency
(`requirements.txt`, commit `e3fea3c`).

## Tool-server entry point (what the Python adapter calls)

The simplest stable surface is the tool-server's **standalone HTTP server**, which
needs only `npm ci` + `npx tsc --build` (no `@swmansion/argent` bundle):

```
node -e 'require("@argent/configuration-core").setFlag("open-device-server",true,"global")'
ARGENT_PORT=3001 ARGENT_HOST=127.0.0.1 node packages/tool-server/dist/index.js start
```

`run_aw.py` starts this itself. `ARGENT_AUTH_TOKEN` is left unset, so loopback
POSTs need no bearer token. The adapter then calls `POST
http://127.0.0.1:3001/tools/<name>` with `{"udid": "emulator-5554", ...}` and
reads the response `data` (`packages/tool-server/src/index.ts:397` `app.listen`,
`packages/tool-server/src/http.ts:616` the `/tools/:name` route,
`packages/tool-server/src/http.ts:419` the no-auth path). The open driver is
selected by the `open-device-server` flag (`packages/configuration-core/src/flags.ts:72`),
re-read per request; the target device is the `udid`/serial.

Action mapping (research §1) is faithful to AndroidWorld's own
`env/actuation.py:execute_adb_action`, but in normalized coordinates through our
tools: `click`→`gesture-tap`; `double_tap`→two taps; `long_press`→`gesture-custom`
(Down held 800 ms); `scroll`/`swipe`→`gesture-swipe` (Android `gesture-scroll` is
Chromium-only); `input_text`→tap + optional select-all/delete + `keyboard{text}` +
enter; `keyboard_enter`→`keyboard{key:enter}`; `navigate_home`/`navigate_back`→
`button`; `open_app`→`launch-app` (package resolved via AW's own name registry);
`wait`→`await-screen-idle`; `status`/`answer`/`unknown` are agent-protocol only.

The index↔node table: each describe line ends with a normalized `(x, y, w, h)`
frame; `driver_env.parse_describe` numbers the frame-bearing lines
(`UI element {i}: ...`, matching T3A's convention) so `{"action_type":"click",
"index":N}` resolves to that node's centre.

## Tiers

`compact` (the default: the pruned tree, screen-graph cache when unchanged) and
`full` (the full tree). `summary` needs the graph and `index` does not exist yet
— both are AW-2. Enum: `packages/tool-server/src/tools/describe/index.ts:81`.

## The five pinned tasks + seed

Picked from `task_evals/single/*` at the pinned AW commit — apps AW installs
itself, deterministic (adb/SQLite/filesystem) checkers, complexity 1-2, offline,
no clock drift (`freeze_datetime=True` locks the device clock to Oct 2023):

| task                           | complexity | app                 |
| ------------------------------ | ---------- | ------------------- |
| `ContactsAddContact`           | 1.2        | contacts (system)   |
| `ClockStopWatchRunning`        | 1          | clock (system)      |
| `MarkorCreateFolder`           | 1          | markor              |
| `MarkorDeleteNote`             | 1          | markor              |
| `SimpleCalendarDeleteOneEvent` | 1.2        | simple calendar pro |

`--task_random_seed = 30`, `--n_task_combinations = 1`. One seeded parameter set
per task, reused across both tiers, so the identical task instance is scored on
each tier (the tier is the only variable). Model `claude-opus-5`, effort
`medium`, temperature unset.

## Pre-registered gates (written before the run)

`run_aw.py` emits these into `gates.md`; they are fixed here before any harness
run grades them (house rule, `docs/open-server/README.md:115`):

- **G0** — the harness completes all 10 episodes, each with a terminal
  `is_successful` (a float per episode; never a mean over 5).
- **G1** — a per-task pass/fail table per tier.
- **G2** — tokens/step per tier from API usage, with the observation share (our
  o200k observation tokens ÷ API input tokens/step).
- **G3** — s/step per tier.
- **G4** — manifest: AW commit, tier list, model, effort, seed, task list, AVD
  fingerprint.
- **G5** — cost from API usage at claude-opus-5 list price ($5 / $25 per MTok).

No capability claim: one image, one emulator, five tasks. AW numbers are not
comparable across harnesses, so every run states its AW commit, tier, model,
effort and task list (research §5).

## Running (CI)

`workflow_dispatch` on `.github/workflows/bench-androidworld.yml`:

- `job=probe` — Step 0 a11y-suppression probe (no model key).
- `job=harness` — Step 3 run. Needs the `ANTHROPIC_API_KEY` repo secret; without
  it the job fails fast naming the secret.

## Step 0 pre-registration (a11y suppression)

The probe decides whether `DeviceControlInstrumentation.getUiAutomation` needs
`FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`. Because the harness uses shape (b)
(our server is the only observation; AW's forest is never read, only its adb
checkers), the harness is expected to work regardless — but the probe confirms it
and pre-registers the choice. If the flag is added, the describe latencies must
be re-measured against run 34870686468 at the drift floor (scheduled as AW-1.1,
never folded into the AW-1 run). The chosen outcome is recorded in the ticket's
`## Result`.

## Left for AW-2

`index` tier (needs the tier shipped first), `summary` tier (graph-dependent),
and the full 20×4 matrix as one job per tier (the full grid does not fit one 6 h
job — research §3).
