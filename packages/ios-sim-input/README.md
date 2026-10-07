# @argent/ios-sim-input (`sim-input`)

Standalone Swift CLI that injects HID gestures (tap / swipe / key / text) into a
booted **iOS Simulator** over stdin JSONL, acking each command on stdout. It is
the **ON-siminput** input arm of the iOS-2 like-for-like bench: the same
XCUITest snapshot tree as ON-xcuitest, but touch injection through the
IndigoHID digitizer pipeline instead of XCUITest gestures (input and tree are
independent on iOS — see the spec).

## Provenance

The four sources under `Sources/sim-input/` were copied **verbatim** from the
owner's `device-farm/device-stream/tools/sim-input` (since changed only by the
iOS-4 changes below: one timing call in each HID send helper, the ack
`timing` block, tap `holdMs`, and the tap/swipe frame pacer) and carry their own
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
{"id":<int>,"type":"tap","x":<f>,"y":<f>,"screenWidth":<f>,"screenHeight":<f>,"holdMs":<f>}   // holdMs optional, default 50
{"id":<int>,"type":"swipe","fromX":<f>,"fromY":<f>,"toX":<f>,"toY":<f>,"durationMs":<int>,"holdEndMs":<f>,"screenWidth":<f>,"screenHeight":<f>}   // holdEndMs optional
{"id":<int>,"type":"press","key":<int>}     // key = HID usage on page 7
{"id":<int>,"type":"release","key":<int>}
{"id":<int>,"type":"text","text":"..."}      // ASCII; decomposed via KeyboardKey
```

Acks: `{"id":<int>,"ok":true,"timing":{...}}` or
`{"id":<int>,"ok":false,"error":"...","timing":{...}}`, written after the last HID
message of the command. `timing` is in monotonic milliseconds on the sim-input
process's clock (only differences are meaningful):

```
{"recvAt":<f>,"sends":[{"sendStart":<f>,"sendEnd":<f>}, ...],"ackAt":<f>}
```

`recvAt` is when the line was read off stdin, `sends` has one entry per HID
message (`sendWithMessage:` call) in order, `ackAt` is just before the ack is
written. The host driver adds its own `hostWriteAt` / `hostAckAt`
(`performance.now()`) to the resolved ack.

A tap / swipe ack also carries the gesture's pacing:
`{"id":<int>,"ok":true,"scheduledMs":<f>,"actualMs":<f>,"overshootMs":<f>,"maxFrameLateMs":<f>}`.

The host driver (`packages/tool-server/src/utils/ios-sim-input-service.ts`) spawns
one long-lived process per UDID and matches acks by `id` with a FIFO fallback.
`tap` / `swipe` / `typeText` / `send` resolve with one ack object: the host
times, `timing` (null on an older binary) and the pacing fields (absent on an
older binary or a non-gesture command). `tapWithAck` / `swipeWithAck` /
`sendWithAck` are aliases. In the tool-server the `IosSimInput` registry
service (`src/blueprints/ios-sim-input.ts`) owns this driver per simulator.

## Timing

The main thread only reads stdin; each line runs on one serial queue
(`sim-input.send`, QoS user-interactive), one command at a time in arrival
order. The process holds a `latencyCritical` +
`userInitiatedAllowingIdleSystemSleep` activity for its whole life, so App Nap
and timer coalescing do not stretch the waits and the Mac can still sleep when
idle.

Gesture frames (tap hold, swipe moves, dwell, the final Up) are paced against
absolute deadlines from the Down (`t0 + offset`), each waited on a `.strict`
`DispatchSourceTimer` with zero leeway. A late frame does not shift the frames
after it, as chained `usleep` did. The offsets are the recipe's own, computed by
the pure `GestureFrames` plans: tap hold 50 ms; swipe of `durationMs` D uses 10
moves at `D / 12` ms and the Up one step later (220 ms for D = 250).

A swipe with `holdEndMs` holds the finger at the end point before the Up: the
dispatch's dwell pulses, 50 ms apart (`holdEndMs / 50` of them, at least one), then
the Up one step later. The hold is meant to bring the release velocity to about
zero (a momentum-free swipe); its effect on the fling is not measured on a
simulator yet, and the tool-server sends it only with the experimental
`ARGENT_SIM_INPUT_MOMENTUM_FREE=1`.

sim-input logs no typed input: `key` writes no per-key line (the HID usage maps
back to the character), and an unsupported character in `text` is logged without
the character. The host driver also drops any stderr line that names a key usage
or a character before it forwards stderr to the tool-server log.

Key, button and text commands are not paced: `IndigoHIDInput.key` and the
button / edge helpers still hold with `usleep` (100 ms per key). Their acks
carry `timing` but no pacing fields.

Ack fields, in ms on sim-input's monotonic clock:

- `scheduledMs`: the last deadline (Up) after the Down, the sum of the scheduled frames.
- `actualMs`: Down to Up as measured.
- `overshootMs`: `actualMs - scheduledMs`.
- `maxFrameLateMs`: the worst frame wake past its deadline.

`sim-input selftest-pacing` paces the same `GestureFrames` plans a real tap and
swipe use, with no simulator and no HID sends, and prints one JSON line:
`tap-default` (Up at 50 ms, 50-60 ms), `swipe-250` (10 moves at 20 ms, Up at
220 ms, 220-270 ms), `swipe-250-stall60` (a 60 ms stall in frame 3, still
220-270 ms; chained sleeps would end near 280 ms), and `swipe-250-dwell120` (the
120 ms end hold: dwell pulses at 200 and 250 ms, Up at 320 ms, 320-370 ms). Exit 0 when every case is in
range.
