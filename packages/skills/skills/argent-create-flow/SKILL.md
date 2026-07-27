---
name: argent-create-flow
description: Record a reusable flow — a scripted sequence of device actions saved as YAML and replayed with one command. Use when the user asks to create, record, or build a flow, or to script a sequence of device actions. Also use proactively, without an explicit request, when a multi-step interaction is about to be repeated (re-profiling, re-testing, or a hard-won path worth saving).
---

## Overview

A flow is a list of steps in `.argent/flows/<name>.yaml`. You record it by running each step live, so every step is verified before it lands in the file. Replay it with `flow-execute`, or headlessly with `argent flow run <name>`.

Flows carry **no device id** — the runner binds a device at run time.

Two types:

- **e2e** — starts with a `launch:` step (terminate + relaunch), so it controls its own start state, and takes no `executionPrerequisite`. Only e2e flows are meaningful CI entries, since only a clean start gives a deterministic verdict.
- **fragment** — no launch; runs against whatever is on screen. May declare an `executionPrerequisite` describing that entry state. Invoked from another flow with `run:`, or replayed directly.

An e2e flow may `run:` other flows and (iOS/Android) be a `run:` target itself — its `launch` then restarts the app inline for that sub-scenario. **Chromium is the exception:** one Electron app boots per run, so a nested chromium e2e flow's `launch` fails the run. Keep those top-level.

## Tools

| Tool                     | Purpose                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `flow-start-recording`   | Start recording — takes a name and, for fragments, `executionPrerequisite` |
| `flow-add-step`          | Execute a tool call live and record it if it succeeds                      |
| `flow-add-echo`          | Add a label that prints during replay                                      |
| `flow-finish-recording`  | Stop recording and return a summary                                        |
| `flow-read-prerequisite` | Read a flow's execution prerequisite without running it                    |
| `flow-execute`           | Replay a saved flow by name                                                |

- **Every step runs live and only successes are recorded.** A failed call writes nothing — fix it and retry.
- **Pass `project_root` once**: absolute, to `flow-start-recording`. The other tools track the active flow themselves.
- **One flow at a time.** Starting a second recording abandons the first; its file stays on disk.
- Each tool returns the current file contents, so you always see what has been captured. Edit the `.yaml` directly to remove or reorder steps.

`flow-add-step` takes `command` (the MCP tool name) and `args` as a **JSON string**, omitted entirely for tools with no arguments:

```
command: "gesture-tap"
args: "{\"udid\": \"<UDID>\", \"x\": 0.5, \"y\": 0.35}"
```

## Recording

1. **Start.** Call `flow-start-recording` with a descriptive name and the absolute `project_root`. For a fragment, bring the device to the entry state first and pass an `executionPrerequisite` (e.g. "App on the login screen, user logged out").
2. **For an e2e flow, record a `restart-app` of the app under test as the first step** — it resets the device for the rest of the recording and is captured as the flow's `launch`.
3. **Add each action** with `flow-add-step`, checking the live result before moving on. Gate every navigation with an `await-ui-element` step instead of a delay: replay then stops at the unmet wait rather than running blind.
4. **Label with `flow-add-echo`** — echo the expected state, not the action: "On Settings > General, about to tap About". These labels are your reference when the flow later breaks.
5. **Finish** with `flow-finish-recording`, polish the saved file (below), then re-run `flow-execute` to confirm the cleaned flow still passes.

The recorder handles portability: a coordinate tap is captured as a `tap:` selector step whenever the tapped element has stable text or an identifier (otherwise the coordinates are kept, with a warning), `restart-app` becomes `launch:`, a `flow-execute` of a sibling flow becomes `run:`, and device ids are stripped. Captured selectors use the strict map form — `tap: { text: General }` — because the recorder verified the exact element the tap hit.

A live `await-ui-element` call sees only the trimmed `describe` tree. If it can't find an identifier you know exists, gate on visible text to get the step recorded, then retarget the identifier once you convert it to an `await:` directive, which resolves the full hierarchy.

### Polish

Read the saved YAML and rewrite raw `tool:` steps that have a directive form. These directives wait for their target, resolve the full element hierarchy, and carry no device coordinates, so they survive layout changes that break a recorded gesture.

| Recorded tool                                          | Rewrite as                                                        | Keep raw when                                                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `keyboard` typing into a field                         | `type: { into: <field>, text: … }`, folding in the focusing `tap` | —                                                                                                               |
| `await-ui-element`                                     | `await: { visible: … }` (`timeoutMs` → `timeout`)                 | it sets a `pollIntervalMs`/`bundleId` the directive can't express                                               |
| `gesture-swipe` / `gesture-scroll` to reach an element | `scroll-to: { target: <that element> }`                           | it is velocity-dependent (swipe-to-dismiss, edge-swipe-back, swipe-to-reveal) or aimed at no particular element |
| `gesture-pinch`                                        | `pinch: { on: <target>, scale: end ÷ start distance }`            | the pinch is anchored off the element's center or pans via `endCenterX`/`endCenterY`                            |
| `gesture-rotate`                                       | `rotate: { on: <target>, by: end − start angle }`                 | the pivot is off-center, the gesture's speed matters, or the sweep exceeds ±3000°                               |

Drop the recorded geometry when converting — the directive re-derives finger placement, edge avoidance and pacing at run time, and `on:` re-centers on the element's frame. Every other tool (`button`, `screenshot`, …) has no directive form and stays a `tool:` step.

### Example

```
flow-start-recording  { name: "open-about", project_root: "/Users/dev/MyApp" }
flow-add-echo   { message: "Start Settings from scratch" }
flow-add-step   { command: "restart-app", args: "{\"udid\": \"ABC\", \"bundleId\": \"com.apple.Preferences\"}" }
flow-add-echo   { message: "On the Settings root list, tapping the 'General' row" }
flow-add-step   { command: "gesture-tap", args: "{\"udid\": \"ABC\", \"x\": 0.5, \"y\": 0.35}" }
flow-add-step   { command: "await-ui-element", args: "{\"udid\": \"ABC\", \"condition\": \"visible\", \"selector\": {\"text\": \"About\"}}" }
flow-finish-recording  {}
```

After polish — no device ids, the `await-ui-element` step now an `await:` directive:

```yaml
steps:
  - echo: Start Settings from scratch
  - launch: com.apple.Preferences
  - echo: On the Settings root list, tapping the 'General' row
  - tap: { text: General }
  - await: { visible: About }
```

## Replaying

Call `flow-execute` with the flow name (and `project_root`, unless a recording this session already stored it). A flow with an execution prerequisite returns a **notice** with the prerequisite text instead of running: confirm the state is met — `flow-read-prerequisite` inspects it beforehand — then call again with `prerequisiteAcknowledged: true`.

The run executes every step in order and returns `{ ok, passed, failed, skipped, errored, steps }`. Raw `tool:` steps carry the tool's full result (screenshots render as usual); directive steps report `status` + `reason`, plus `artifacts` for a `snapshot` that wrote or failed a comparison.

For headless runs, CI, and screenshot baselines, see `references/runner.md`.

## When a flow breaks

A failure is a hard `ERROR` on a step, or a clean run that ends on the wrong screen. Either way:

1. `screenshot` to see where the app actually is, and `describe` for the current tree.
2. State the root cause in one sentence — drifted coordinates, missing element, wrong screen, timing, or an unmet prerequisite.
3. Apply the smallest fix that addresses it: edit the step's args, or re-record from the divergence point.
4. Re-run `flow-execute`. **Hard cap: 2 correction cycles** — then report the diagnosis and recommend a full re-record.

`references/repair.md` has the full procedure and the habits that keep flows from breaking.

## Record proactively

Record without being asked — telling the user you are doing so — when:

- **You are about to re-profile.** Capture the interaction now so the post-fix profile replays it identically (see `argent-react-native-profiler`, `argent-native-profiler`).
- **You have run a multi-step sequence once and need it again** for a comparison, retry, or re-test.
- **You worked out a non-trivial path** to a desired app state — capture it before it is lost.
- **The user says "again" or "one more time."**

## Reference

- `references/directives.md` — the flow file format and every directive (`launch`, `tap`, `type`, `scroll-to`, `await`, `assert`, `when`, `snapshot`, …), plus TV/Vega targets.
- `references/selectors.md` — selector grammar, regex matchers, and the `within`/`after`/`next` scopes.
- `references/runner.md` — `argent flow run`, snapshot baselines, CI.
- `references/repair.md` — diagnosing and repairing a broken flow.
