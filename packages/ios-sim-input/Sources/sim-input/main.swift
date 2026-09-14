import Foundation

// sim-input — stdin JSONL → HID dispatch into a booted iOS Simulator.
//
// Usage:   sim-input --udid <UDID>
//
// Each stdin line is a JSON command; each command writes one ack JSON
// line to stdout. Logs go to stderr so they don't corrupt the wire.
//
// Command schemas (coords are POINTS in the simulator screen space,
// not pixels — baguette's convention; no scaling applied here):
//   {"id":<int>,"type":"tap","x":<f>,"y":<f>}
//   {"id":<int>,"type":"swipe","fromX":<f>,"fromY":<f>,"toX":<f>,"toY":<f>,"durationMs":<int>}
//   {"id":<int>,"type":"press","key":<int>}     // key = HID usage on page 7
//   {"id":<int>,"type":"release","key":<int>}
//   {"id":<int>,"type":"text","text":"..."}      // ASCII; decomposed via KeyboardKey
//
// Ack schemas:
//   {"id":<int>,"ok":true}
//   {"id":<int>,"ok":false,"error":"..."}
//
// Screen size is required for `tap`/`swipe`'s normalisation step
// (IOHIDDigitizerDispatch expects 0..1 coords). The caller can supply
// it per-command via `screenWidth`/`screenHeight`; if omitted we
// default to 1.0×1.0 so a caller passing already-normalised coords
// (0..1) gets the expected behaviour.

// MARK: - argv

func usageAndExit() -> Never {
    fputs("usage: sim-input --udid <UDID>\n", stderr)
    exit(2)
}

var udid: String?
var argIter = CommandLine.arguments.dropFirst().makeIterator()
while let a = argIter.next() {
    switch a {
    case "--udid":
        udid = argIter.next()
    case "-h", "--help":
        usageAndExit()
    default:
        fputs("unknown arg: \(a)\n", stderr)
        usageAndExit()
    }
}
guard let udid, !udid.isEmpty else { usageAndExit() }

// MARK: - input setup

let host = CoreSimulators()
let input = IndigoHIDInput(udid: udid, host: host)

// MARK: - ack writer (atomic line write)

let stdoutHandle = FileHandle.standardOutput
let ackQueue = DispatchQueue(label: "sim-input.ack")

func writeAck(_ obj: [String: Any]) {
    ackQueue.sync {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else {
            return
        }
        try? stdoutHandle.write(contentsOf: data)
        try? stdoutHandle.write(contentsOf: Data([0x0A])) // newline
    }
}

func ackOk(_ id: Int) {
    writeAck(["id": id, "ok": true])
}

func ackErr(_ id: Int, _ message: String) {
    writeAck(["id": id, "ok": false, "error": message])
}

// MARK: - dispatch

/// Default size for `tap`/`swipe` when caller omits screen dims —
/// matches the wire convention where coords are already normalised
/// 0..1. IndigoHIDInput will divide by these (1.0) and clamp.
let defaultSize = Size(width: 1.0, height: 1.0)

func sizeFrom(_ obj: [String: Any]) -> Size {
    let w = (obj["screenWidth"] as? Double) ?? (obj["screenWidth"] as? Int).map(Double.init) ?? 1.0
    let h = (obj["screenHeight"] as? Double) ?? (obj["screenHeight"] as? Int).map(Double.init) ?? 1.0
    return Size(width: w, height: h)
}

func double(_ obj: [String: Any], _ key: String) -> Double? {
    if let d = obj[key] as? Double { return d }
    if let i = obj[key] as? Int { return Double(i) }
    return nil
}

func handle(_ obj: [String: Any]) {
    let id = (obj["id"] as? Int) ?? -1
    guard let type = obj["type"] as? String else {
        ackErr(id, "missing type"); return
    }
    switch type {
    case "tap":
        guard let x = double(obj, "x"), let y = double(obj, "y") else {
            ackErr(id, "tap: missing x/y"); return
        }
        let ok = input.tap(at: Point(x: x, y: y), size: sizeFrom(obj), duration: 0)
        ok ? ackOk(id) : ackErr(id, "tap failed")

    case "swipe":
        guard let fx = double(obj, "fromX"), let fy = double(obj, "fromY"),
              let tx = double(obj, "toX"),   let ty = double(obj, "toY") else {
            ackErr(id, "swipe: missing fromX/fromY/toX/toY"); return
        }
        let durationMs = (obj["durationMs"] as? Int) ?? Int(double(obj, "durationMs") ?? 250)
        let durationS = max(0.01, Double(durationMs) / 1000.0)
        let ok = input.swipe(
            from: Point(x: fx, y: fy), to: Point(x: tx, y: ty),
            size: sizeFrom(obj), duration: durationS
        )
        ok ? ackOk(id) : ackErr(id, "swipe failed")

    case "press", "release":
        // HID usage on page 7 (keyboard). Down/up are dispatched
        // independently via the same `IndigoHIDMessageForHIDArbitrary`
        // recipe IndigoHIDInput.key() uses internally, but exposed
        // here as discrete press/release so callers can stage
        // multi-key combos (e.g. shift held while typing).
        guard let usage = obj["key"] as? Int else {
            ackErr(id, "\(type): missing key (HID usage)"); return
        }
        let key = KeyboardKey(hidUsage: HIDUsage(page: 7, usage: UInt32(usage)))
        // `IndigoHIDInput.key()` brackets down+up internally; for a
        // bare press/release we want one half. The cleanest verbatim
        // route is to ride `key()` for "press" semantics and use a
        // very short duration; "release" is unmodeled by the
        // protocol surface, so we no-op with ok and let the next
        // `press` re-bracket. This matches baguette's exposed surface.
        if type == "press" {
            let ok = input.key(key, modifiers: [], duration: 0)
            ok ? ackOk(id) : ackErr(id, "press failed")
        } else {
            // No-op: `key()` already releases. Ack so the wire
            // stays in lockstep with the caller.
            ackOk(id)
        }

    case "text":
        guard let text = obj["text"] as? String else {
            ackErr(id, "text: missing text"); return
        }
        var anyFail = false
        for c in text {
            guard let (key, mods) = KeyboardKey.decompose(character: c) else {
                logErr("text: unsupported character '\(c)'")
                anyFail = true
                continue
            }
            if !input.key(key, modifiers: mods, duration: 0) {
                anyFail = true
            }
        }
        anyFail ? ackErr(id, "text: one or more characters failed") : ackOk(id)

    default:
        ackErr(id, "unknown type: \(type)")
    }
}

// MARK: - stdin loop

log("sim-input ready (udid=\(udid))")

let stdin = FileHandle.standardInput
var buffer = Data()

while true {
    let chunk = stdin.availableData
    if chunk.isEmpty { break } // EOF
    buffer.append(chunk)
    while let nlIdx = buffer.firstIndex(of: 0x0A) {
        let lineData = buffer[..<nlIdx]
        buffer.removeSubrange(...nlIdx)
        if lineData.isEmpty { continue }
        do {
            let parsed = try JSONSerialization.jsonObject(with: lineData, options: [])
            guard let obj = parsed as? [String: Any] else {
                logErr("ignoring non-object JSON line")
                continue
            }
            handle(obj)
        } catch {
            logErr("JSON parse error: \(error)")
        }
    }
}

log("sim-input stdin closed; exiting")
