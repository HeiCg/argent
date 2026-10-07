# @argent/ios-sim-input (`sim-input`)

Standalone Swift CLI that injects HID gestures (tap / swipe / key / text) into a
booted **iOS Simulator** over stdin JSONL, acking each command on stdout. It is
the **ON-siminput** input arm of the iOS-2 like-for-like bench: the same
XCUITest snapshot tree as ON-xcuitest, but touch injection through the
IndigoHID digitizer pipeline instead of XCUITest gestures (input and tree are
independent on iOS — see the spec).

## Provenance

The four sources under `Sources/sim-input/` were copied **verbatim** from the
owner's `device-farm/device-stream/tools/sim-input` and carry their own
Apache-2.0 provenance banners pointing at
[baguette](https://github.com/tddworks/baguette):

- `IndigoHIDInput.swift`, `IOHIDDigitizerDispatch.swift` — ported verbatim from
  baguette; **do not** modify byte layouts, timing constants, or HID event
  ordering (they are the iOS 26.4 recipe).
- `Support.swift` — support types inlined from baguette.
- `main.swift` — the stdin JSONL ↔ HID dispatch loop.

`SimulatorKit` / `CoreSimulator` are **not** linked at build time; they are
`dlopen`'d at runtime from the active Xcode's developer directory. Nothing here
is derived from any closed argent binary.

## Build

```bash
bash packages/ios-sim-input/scripts/build-sim-input.sh   # -> packages/ios-sim-input/bin/sim-input
```

Requires a full Xcode (not just Command Line Tools). CI pins `DEVELOPER_DIR` to
the same Xcode the runner build selected.

## Wire

Each stdin line is a JSON command; each writes one ack line to stdout. Coords are
**points** in the simulator screen space (normalised against `screenWidth` /
`screenHeight` when supplied). Logs go to stderr.

```
{"id":<int>,"type":"tap","x":<f>,"y":<f>,"screenWidth":<f>,"screenHeight":<f>}
{"id":<int>,"type":"swipe","fromX":<f>,"fromY":<f>,"toX":<f>,"toY":<f>,"durationMs":<int>,"screenWidth":<f>,"screenHeight":<f>}
{"id":<int>,"type":"press","key":<int>}     // key = HID usage on page 7
{"id":<int>,"type":"release","key":<int>}
{"id":<int>,"type":"text","text":"..."}      // ASCII; decomposed via KeyboardKey
```

Acks: `{"id":<int>,"ok":true}` or `{"id":<int>,"ok":false,"error":"..."}`.

A tap / swipe ack also carries the gesture's pacing:
`{"id":<int>,"ok":true,"scheduledMs":<f>,"actualMs":<f>,"overshootMs":<f>,"maxFrameLateMs":<f>}`.

The host driver (`packages/tool-server/src/utils/ios-sim-input-service.ts`) spawns
one long-lived process per UDID and matches acks by `id` with a FIFO fallback.
`tapWithAck` / `swipeWithAck` / `sendWithAck` resolve with the pacing fields
(`undefined` on an older binary); `tap` / `swipe` / `send` resolve `undefined`.

## Timing

The main thread only reads stdin; each line runs on one serial queue
(`sim-input.send`, QoS user-interactive), one command at a time in arrival
order. The process holds a `latencyCritical` + `userInitiated` activity for its
whole life, so App Nap and timer coalescing do not stretch the waits.

Gesture frames (tap hold, swipe moves, dwell, the final Up) are paced against
absolute deadlines from the Down (`t0 + offset`), each waited on a `.strict`
`DispatchSourceTimer` with zero leeway. A late frame does not shift the frames
after it, as chained `usleep` did. The offsets are the recipe's own: tap hold
50 ms; swipe of `durationMs` D uses 10 moves at `D / 12` ms and the Up one step
later (220 ms for D = 250).

Ack fields, in ms on sim-input's monotonic clock:

- `scheduledMs`: the last deadline (Up) after the Down, the sum of the scheduled frames.
- `actualMs`: Down to Up as measured.
- `overshootMs`: `actualMs - scheduledMs`.
- `maxFrameLateMs`: the worst frame wake past its deadline.

`sim-input selftest-pacing` runs the pacer with no simulator and prints one JSON
line: 12 frames at 20 ms (240-290 ms), 1 frame at 50 ms (50-60 ms), and 12
frames at 20 ms with a 60 ms stall in frame 3 (still 240-290 ms). Exit 0 when
every case is in range.
