# Argent iOS runner wire protocol (v1)

One HTTP POST per command. The request body is a JSON object; the reply is a
JSON **envelope**. Connections close after each exchange (`Connection:
close`). The server listens on loopback on the port given by the
`ARGENT_RUNNER_PORT` environment variable (injected into the `.xctestrun`),
reachable through usbmux (USB cable only) — the forwarded stream terminates
on the device's loopback, so a loopback bind covers the whole transport.

There is no version handshake: the tool-server's artifact cache key includes
the runner sources, so a protocol change always ships with a rebuilt runner.

## Envelope

```json
{ "ok": true,  "data": { … } }
{ "ok": false, "error": { "code": "…", "message": "…", "hint": "…" } }
```

`hint` is optional, phrased for the agent operating the device.

## Request fields

| Field                 | Used by             | Meaning                                                                 |
| --------------------- | ------------------- | ----------------------------------------------------------------------- |
| `command`             | all                 | Command name (below).                                                   |
| `commandId`           | all but `status`    | Client-stamped id for send-once tracking.                               |
| `statusCommandId`     | `status`            | Journal lookup key.                                                     |
| `appBundleId`         | app-scoped commands | Target app. Required — never inferred.                                  |
| `x`, `y`              | `tap`, `longPress`  | Absolute points in the app's space.                                     |
| `numberOfTaps`        | `tap`               | Taps in the one gesture (default 1; 2 = native double-tap).             |
| `fromX/fromY/toX/toY` | `drag`              | Absolute start/end points.                                              |
| `durationMs`          | `longPress`, `drag` | Press duration / movement duration.                                     |
| `settle`              | `drag`              | Rest at the destination before lifting (~0 release velocity, no fling). |
| `text`                | `type`              | Text for the focused input.                                             |

## Commands

App-scoped (require `appBundleId`; the runner foregrounds the target first):

- `viewport` → `{x, y, width, height}` — `XCUIApplication.frame` (full app,
  keyboard included). Same rect describe normalizes against, so 0–1 tap
  coordinates invert that mapping.
- `tap`, `longPress`, `drag` → `{message}` — coordinate gestures via
  XCUICoordinate (public API; orientation-safe). `tap` executes
  `numberOfTaps` taps as one on-device gesture: 2 maps to the native
  `doubleTap()`, >2 to a tight tap loop (no native N-tap API; inter-tap
  latency stays on-device, inside the OS multi-tap window).
- `type` → `{message}` — types into the current first responder.
  `TEXT_INPUT_NOT_FOCUSED` when nothing has keyboard focus.
- `keyboardReturn` → `{message}`.
- `snapshot` → `{nodes, quality}` — one-shot accessibility tree (below).

Device-scoped:

- `status` — without `statusCommandId`: `{uptimeMs, state, suppressedIssues,
recordedFailures}`. `state` is `idle | busy | wedged`. `suppressedIssues`
  counts the XCTest issues muted as accessibility noise since launch;
  `recordedFailures` is XCTest's cumulative recorded-failure count — the
  counter that, past suppression, converts successful mutations into
  `XCTEST_RECORDED_FAILURE`. Suppression substring-matches Apple-owned
  issue wording, pinned here as part of the contract — muted: a
  `Failed to get matching snapshot` description that also contains
  `kAXError` or `No matches found for`; kept recorded: `Timed out while
evaluating UI query`. If an Xcode release rewords those strings,
  suppression misses silently: `suppressedIssues` stops moving while
  `recordedFailures` climbs on healthy mutations. Watch the pair for that
  drift. With `statusCommandId`: the journaled fate of that command:
  `{commandId, state: notAccepted|accepted|started|completed|failed,
command?, responseOk?, responseJson?, errorCode?, errorMessage?,
errorHint?}`. `responseJson` is the completed command's full envelope,
  retained only when the command retains responses (`snapshot`/`screenshot`
  replies never are — large, read-only, cheaper to replay) AND the encoded
  envelope is at most 16 KB (`maxRetainedResponseBytes`,
  CommandJournal.swift). Past either gate the journal still records the fate
  and error fields, so recovery can find a command `completed` with no
  `responseJson`: the effect happened, but the response was too large to
  retain.
- `home` → presses the home button.
- `screenshot` → `{imageBase64}` — full-screen PNG, always inline.
- `shutdown` → acknowledges, then ends the session cleanly after the reply
  is flushed.

## Snapshot nodes

Flat list in emission order; `parentIndex` links reconstruct the tree.

```json
{
  "index": 0,
  "type": "Button",
  "label": "General",
  "identifier": "com.apple.settings.general",
  "value": null,
  "rect": { "x": 16, "y": 768.7, "width": 361, "height": 52 },
  "enabled": true,
  "focused": null,
  "selected": null,
  "depth": 3,
  "parentIndex": 44
}
```

- `type` — XCUIElement type name (`Button`, `StaticText`, `Cell`, …).
- `rect` — viewport points. Non-finite or integer-overflowing coordinates
  encode as `0`: the conversion is total by contract, because a geometry-less
  AX element must degrade to a zeroed rect, never kill the runner mid-snapshot
  (`keyCoordinate` in `ArgentRunnerSession+Snapshot.swift`).
- Included nodes: interactive types, scroll containers, and anything with a
  label/identifier/value; visible in the viewport; deduped by
  type+texts+geometry. Hard cap 1500 nodes (`quality.state` becomes
  `degraded`, `reasonCode: "node_cap"`).
- `quality`: `{state: healthy|degraded, backend: "xctest", reason?,
reasonCode?}`.

## Error codes

`INVALID_REQUEST`, `APP_BUNDLE_ID_REQUIRED`, `APP_NOT_AVAILABLE`,
`TEXT_INPUT_NOT_FOCUSED`, `UNSUPPORTED_OPERATION`, `RUNNER_BUSY` (the one
retryable code), `RUNNER_WEDGED` (recycle the session),
`XCTEST_RECORDED_FAILURE` (a mutation ran but XCTest recorded a real failure
during it), `SNAPSHOT_FAILED`, `COMMAND_TIMED_OUT`, `COMMAND_FAILED`.

## Timeout budgets

Every command runs under a runner-side main-thread watchdog budget
(`CommandKind.executionTimeout`, RunnerProtocol.swift); the client sends it
under a larger transport window (default `RUNNER_COMMAND_TIMEOUT_MS`,
runner-client.ts; overrides in runner-commands.ts — `GESTURE_TIMEOUT_MS` and
the `type`/`snapshot` call sites). This table is the authoritative pairing —
the mirrored code comments point here instead of restating the other side's
numbers.

| Command class              | Runner budget | Client window |
| -------------------------- | ------------- | ------------- |
| `type`                     | 55s           | 60s           |
| `tap`, `longPress`, `drag` | 75s           | 90s           |
| `snapshot`                 | 30s           | 45s           |
| everything else (default)  | 30s           | 45s           |

The invariant: every client window MUST strictly exceed the matching runner
budget, so the client outlasts the runner's verdict. A command that blows
its budget is abandoned on-device and answered with `COMMAND_TIMED_OUT`
(then `RUNNER_BUSY`/`RUNNER_WEDGED` on the commands that follow); a client
window at or below the budget would swallow that verdict as a raw transport
timeout and force journal recovery for an answer the runner was already
delivering. The client window is one whole-transport deadline per send
attempt — the usbmux handshake and the HTTP exchange spend from the same
budget, so a slow handshake shrinks the HTTP stage's share rather than
granting each stage the full window.

## Send-once contract

Every non-`status` command carries a client-stamped `commandId`. Duplicate
sends of an id still executing attach to the in-flight execution and share
its reply. After a lost reply, the client MUST NOT resend a mutating
command; it asks `status` + `statusCommandId` and acts on the journaled
state: `completed` → use `responseJson` (or accept result loss), `failed` →
surface the journaled error, anything else → surface the transport error.
