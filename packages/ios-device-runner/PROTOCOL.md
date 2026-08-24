# Argent iOS runner wire protocol (v1)

One HTTP POST per command. The request body is a JSON object; the reply is a
JSON **envelope**. Connections close after each exchange (`Connection:
close`). The server listens on all interfaces on the port given by the
`ARGENT_RUNNER_PORT` environment variable (injected into the `.xctestrun`),
reachable through usbmux (USB cable only).

There is no version handshake: the tool-server's artifact cache key includes
the runner sources, so a protocol change always ships with a rebuilt runner.

## Envelope

```json
{ "ok": true,  "data": { … } }
{ "ok": false, "error": { "code": "…", "message": "…", "hint": "…" } }
```

`hint` is optional, phrased for the agent operating the device.

## Request fields

| Field                      | Used by             | Meaning                                                                 |
| -------------------------- | ------------------- | ----------------------------------------------------------------------- |
| `command`                  | all                 | Command name (below).                                                   |
| `commandId`                | all but `status`    | Client-stamped id for send-once tracking.                               |
| `statusCommandId`          | `status`            | Journal lookup key.                                                     |
| `appBundleId`              | app-scoped commands | Target app. Required — never inferred.                                  |
| `x`, `y`                   | `tap`, `longPress`  | Absolute points in the app's space.                                     |
| `fromX/fromY/toX/toY`      | `drag`              | Absolute start/end points.                                              |
| `durationMs`               | `longPress`, `drag` | Press duration / movement duration.                                     |
| `settle`                   | `drag`              | Rest at the destination before lifting (~0 release velocity, no fling). |
| `text`                     | `type`              | Text for the focused input.                                             |
| `interactiveOnly`, `depth` | `snapshot`          | Tree filtering.                                                         |

## Commands

App-scoped (require `appBundleId`; the runner foregrounds the target first):

- `viewport` → `{x, y, width, height}` — `XCUIApplication.frame` (full app,
  keyboard included). Same rect describe normalizes against, so 0–1 tap
  coordinates invert that mapping.
- `tap`, `longPress`, `drag` → `{message}` — coordinate gestures via
  XCUICoordinate (public API; orientation-safe).
- `type` → `{message}` — types into the current first responder.
  `TEXT_INPUT_NOT_FOCUSED` when nothing has keyboard focus.
- `keyboardReturn`, `keyboardDismiss` → `{message}`.
- `snapshot` → `{nodes, quality}` — one-shot accessibility tree (below).

Device-scoped:

- `status` — without `statusCommandId`: `{uptimeMs, state}` where state is
  `idle | busy | wedged`. With it: the journaled fate of that command:
  `{commandId, state: notAccepted|accepted|started|completed|failed,
command?, responseOk?, responseJson?, errorCode?, errorMessage?,
errorHint?}`. `responseJson` is the completed command's full envelope
  (never retained for `snapshot`/`screenshot`).
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
  "hittable": true,
  "depth": 3,
  "parentIndex": 44,
  "hiddenContentAbove": null,
  "hiddenContentBelow": null
}
```

- `type` — XCUIElement type name (`Button`, `StaticText`, `Cell`, …).
- Included nodes: interactive types, scroll containers, and anything with a
  label/identifier/value; visible in the viewport; deduped by
  type+texts+geometry. Hard cap 1500 nodes (`quality.state` becomes
  `degraded`, `reasonCode: "node_cap"`).
- `hiddenContentAbove/Below` on a scroll container: content exists beyond the
  visible viewport in that direction.
- `quality`: `{state: healthy|degraded, backend: "xctest", reason?,
reasonCode?}`.

## Error codes

`INVALID_REQUEST`, `APP_BUNDLE_ID_REQUIRED`, `APP_NOT_AVAILABLE`,
`TEXT_INPUT_NOT_FOCUSED`, `UNSUPPORTED_OPERATION`, `RUNNER_BUSY` (the one
retryable code), `RUNNER_WEDGED` (recycle the session),
`XCTEST_RECORDED_FAILURE` (a mutation ran but XCTest recorded a real failure
during it), `SNAPSHOT_FAILED`, `COMMAND_TIMED_OUT`, `COMMAND_FAILED`.

## Send-once contract

Every non-`status` command carries a client-stamped `commandId`. Duplicate
sends of an id still executing attach to the in-flight execution and share
its reply. After a lost reply, the client MUST NOT resend a mutating
command; it asks `status` + `statusCommandId` and acts on the journaled
state: `completed` → use `responseJson` (or accept result loss), `failed` →
surface the journaled error, anything else → surface the transport error.
