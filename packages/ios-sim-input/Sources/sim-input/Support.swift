// Support types + helpers inlined from baguette (Apache-2.0).
// Upstream: https://github.com/tddworks/baguette
// Sources: Domain/Common/CoordinateTypes.swift, Domain/Input/Input.swift,
//          Domain/Input/Keyboard.swift, Domain/Simulator/DeviceHost.swift,
//          Infrastructure/Simulator/CoreSimulators.swift, App/Logger.swift
//
// The ported HID files (IOHIDDigitizerDispatch.swift / IndigoHIDInput.swift)
// reference `Input`, `DeviceHost`, `Point`, `Size`, `GesturePhase`,
// `DeviceEdge`, `KeyboardKey`, `KeyModifier`, `HIDUsage`, `DeviceButton`,
// `CoreSimulators.developerDir()`, and the free functions `log`,
// `logErr`, `dlerrorString`. This file provides those, plus two local
// additions: the per-message send timeline (`SendTimeline`, iOS-4 ticket 1)
// that the two HID files' send helpers record into, and the gesture frame
// pacer (`GesturePacer`, `PacingRecorder`, `LatencyActivity`; iOS-4 ticket 3)
// that IOHIDDigitizerDispatch's tap/swipe wait on instead of chained `usleep`.

import Darwin
import Foundation
import ObjectiveC

// MARK: - Frame pacing (iOS-4 ticket 3)

/// Keeps the process out of App Nap and timer coalescing for its whole life.
/// Run 37610266991 measured a 50 ms tap hold as a 179.5 ms Down→Up gap and a
/// swipe with 220 ms of scheduled sleeps at 1432 ms while each HID send cost
/// ~0.1 ms: the time went into sleeps that overran in a background process.
enum LatencyActivity {
    nonisolated(unsafe) private static var token: NSObjectProtocol?

    static func begin() {
        guard token == nil else { return }
        token = ProcessInfo.processInfo.beginActivity(
            // AllowingIdleSystemSleep: the activity keeps timers precise but
            // does not keep the Mac awake while sim-input idles between commands.
            options: [.latencyCritical, .userInitiatedAllowingIdleSystemSleep],
            reason: "sim-input HID pacing"
        )
    }
}

/// The frame plan of a gesture: the deadlines, in ms after the Down, that
/// IOHIDDigitizerDispatch's tap / swipe wait on before each send. Pure, so
/// `selftest-pacing` paces the same plans the real gestures use.
enum GestureFrames {
    /// IndigoHIDInput.tap's hold when the command has no `holdMs`.
    static let defaultTapHoldSeconds = 0.05

    /// Tap: one deadline, the Up, at the hold (floored at 20 ms; whole µs).
    static func tap(holdSeconds: Double) -> [Double] {
        let holdUs = UInt32(max(0.02, holdSeconds) * 1_000_000)
        return [Double(holdUs) / 1000]
    }

    /// IndigoHIDInput.swipe's split of a duration (seconds; ≤ 0 = 250 ms) into
    /// 10 moves, each `duration / 12` apart (floored at 8 ms, whole ms).
    static func swipeSteps(duration: Double) -> (steps: Int, stepMs: UInt32) {
        let total = duration > 0 ? duration : 0.25
        let steps = 10
        let stepMs = UInt32((total * 1000) / Double(steps + 2))
        return (steps, max(8, stepMs))
    }

    struct Swipe {
        /// One per interpolated move, `i * stepMs` for i in 1...steps.
        let moves: [Double]
        /// End-point holds, 50 ms apart after the last move (`dwellMs` > 0 only).
        let dwell: [Double]
        /// The Up, one step after the last move or dwell deadline.
        let up: Double

        var all: [Double] { moves + dwell + [up] }
    }

    /// Swipe: the move, dwell and Up deadlines. `steps` must be ≥ 1.
    static func swipe(steps: Int, stepMs: UInt32, dwellMs: UInt32) -> Swipe {
        let step = Double(stepMs)
        let moves = (1...steps).map { Double($0) * step }
        var at = Double(steps) * step
        var dwell: [Double] = []
        if dwellMs > 0 {
            let pulses = max(1, Int(dwellMs / 50))
            for _ in 0..<pulses {
                dwell.append(at)
                at += 50
            }
        }
        at += step
        return Swipe(moves: moves, dwell: dwell, up: at)
    }
}

/// What one gesture's pacing measured; written onto its ack.
struct GesturePacing: Sendable {
    /// The last frame's deadline, ms after the Down (sum of the scheduled frames).
    let scheduledMs: Double
    /// Measured Down→Up: from just before the Down send to after the Up send.
    let actualMs: Double
    /// Worst frame: wake time minus its deadline.
    let maxFrameLateMs: Double

    var overshootMs: Double { actualMs - scheduledMs }

    /// The four fields, rounded to µs. NSDecimalNumber so JSONSerialization
    /// writes `50.011`, not `50.011000000000003`.
    var ackFields: [String: Any] {
        func r(_ v: Double) -> NSDecimalNumber { NSDecimalNumber(string: String(format: "%.3f", v)) }
        return [
            "scheduledMs": r(scheduledMs),
            "actualMs": r(actualMs),
            "overshootMs": r(overshootMs),
            "maxFrameLateMs": r(maxFrameLateMs),
        ]
    }
}

/// Paces a gesture's frames against absolute deadlines `t0 + offset` on the
/// monotonic clock (`DispatchTime`, i.e. `mach_absolute_time`): a frame that
/// wakes late does not move the deadlines after it (chained `usleep(frameMs)`
/// adds every overrun to the total).
///
/// Each wait is a one-shot `DispatchSourceTimer` with `.strict` and leeway 0.
/// Measured on this host (24 frames at 20 ms, latencyCritical activity held):
/// `mach_wait_until` woke p50 4.9 / max 7.4 ms late, and p50 75.6 / max 147 ms
/// under `taskpolicy -c utility`; the strict timer woke p50 0.07 / max 0.14 ms,
/// and p50 0.05 / max 0.52 ms under the same clamp.
final class GesturePacer {
    private static let timerQueue = DispatchQueue(label: "sim-input.pacer", qos: .userInteractive)

    private let t0: UInt64
    private var scheduledMs = 0.0
    private var maxLateMs = 0.0

    /// Starts the clock; call just before sending the Down.
    init() { t0 = DispatchTime.now().uptimeNanoseconds }

    /// Blocks until `offsetMs` after the Down; returns at once when the
    /// deadline already passed (the lateness is recorded).
    func wait(untilMs offsetMs: Double) {
        scheduledMs = max(scheduledMs, offsetMs)
        let deadline = DispatchTime(uptimeNanoseconds: t0 + UInt64(max(0, offsetMs) * 1_000_000))
        if DispatchTime.now() < deadline {
            let fired = DispatchSemaphore(value: 0)
            let timer = DispatchSource.makeTimerSource(flags: .strict, queue: Self.timerQueue)
            timer.schedule(deadline: deadline, leeway: .nanoseconds(0))
            timer.setEventHandler { fired.signal() }
            timer.resume()
            fired.wait()
            timer.cancel()
        }
        let woke = DispatchTime.now().uptimeNanoseconds
        let lateNs = woke >= deadline.uptimeNanoseconds ? woke - deadline.uptimeNanoseconds : 0
        maxLateMs = max(maxLateMs, Double(lateNs) / 1_000_000)
    }

    /// Stops the clock; call just after sending the Up.
    func finish() -> GesturePacing {
        GesturePacing(
            scheduledMs: scheduledMs,
            actualMs: Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000,
            maxFrameLateMs: maxLateMs
        )
    }
}

/// The pacing of the gesture the current command ran. main.swift resets it
/// when a command starts and takes it into the ack; the dispatch helpers
/// record into it. Locked because the helpers are not actor-isolated.
final class PacingRecorder: @unchecked Sendable {
    static let shared = PacingRecorder()

    private let lock = NSLock()
    private var last: GesturePacing?

    func reset() {
        lock.lock()
        last = nil
        lock.unlock()
    }

    func record(_ pacing: GesturePacing) {
        lock.lock()
        last = pacing
        lock.unlock()
    }

    func take() -> GesturePacing? {
        lock.lock()
        defer { lock.unlock() }
        let out = last
        last = nil
        return out
    }
}

// MARK: - Wire timing (iOS-4 ticket 1)

/// Monotonic milliseconds (CLOCK_MONOTONIC_RAW, sub-µs resolution). Only
/// differences between two readings are meaningful; the host clock is a
/// different one.
func monotonicMs() -> Double {
    Double(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)) / 1_000_000
}

/// The HID messages sent while one command runs: `sendStart` / `sendEnd` of
/// each `sendWithMessage:` call, in order. main.swift resets it when a line is
/// read and drains it into the ack. Locked because the send helpers are not
/// actor-isolated.
final class SendTimeline: @unchecked Sendable {
    static let shared = SendTimeline()

    private let lock = NSLock()
    private var sends: [(start: Double, end: Double)] = []

    func reset() {
        lock.lock()
        sends.removeAll(keepingCapacity: true)
        lock.unlock()
    }

    func record(start: Double, end: Double) {
        lock.lock()
        sends.append((start: start, end: end))
        lock.unlock()
    }

    func drain() -> [(start: Double, end: Double)] {
        lock.lock()
        defer { lock.unlock() }
        let out = sends
        sends.removeAll(keepingCapacity: true)
        return out
    }
}

/// `sim-input selftest-pacing`: paces the real tap / swipe frame plans
/// (`GestureFrames`, the same deadlines IOHIDDigitizerDispatch waits on) on
/// `queue`, with no simulator and no HID sends, and prints one JSON line with
/// what it measured. Returns true when every case lands in its range.
/// `swipe-250-stall60` stalls 60 ms inside frame 3: with deadlines the gesture
/// still ends near 220 ms; with chained sleeps it would end near 280 ms.
/// `swipe-250-dwell120` adds the 120 ms end hold: dwell pulses at 200 and 250 ms
/// (120 / 50 = 2), the Up one step later at 320 ms.
func runPacingSelftest(on queue: DispatchQueue) -> Bool {
    struct Case {
        let name: String
        let offsets: [Double]
        let stallAtFrame: Int?
        let minMs: Double
        let maxMs: Double
        let minLateMs: Double
    }
    // The plans `{"type":"tap"}` (no holdMs) and `{"type":"swipe","durationMs":250}` run.
    let tapPlan = GestureFrames.tap(holdSeconds: GestureFrames.defaultTapHoldSeconds)
    let split = GestureFrames.swipeSteps(duration: 0.25)
    let swipePlan = GestureFrames.swipe(steps: split.steps, stepMs: split.stepMs, dwellMs: 0).all
    // `{"type":"swipe","durationMs":250,"holdEndMs":120}`: the momentum-free end hold.
    let dwellPlan = GestureFrames.swipe(steps: split.steps, stepMs: split.stepMs, dwellMs: 120).all
    let cases = [
        Case(name: "tap-default", offsets: tapPlan, stallAtFrame: nil,
             minMs: 50, maxMs: 60, minLateMs: 0),
        Case(name: "swipe-250", offsets: swipePlan, stallAtFrame: nil,
             minMs: 220, maxMs: 270, minLateMs: 0),
        Case(name: "swipe-250-stall60", offsets: swipePlan, stallAtFrame: 3,
             minMs: 220, maxMs: 270, minLateMs: 30),
        Case(name: "swipe-250-dwell120", offsets: dwellPlan, stallAtFrame: nil,
             minMs: 320, maxMs: 370, minLateMs: 0),
    ]
    var rows: [[String: Any]] = []
    var allPass = true
    for c in cases {
        let pacing: GesturePacing = queue.sync {
            let pacer = GesturePacer()
            for (i, at) in c.offsets.enumerated() {
                pacer.wait(untilMs: at)
                if i + 1 == c.stallAtFrame {
                    // Busy stall: a sleep here would itself be stretched by a
                    // QoS clamp (usleep(60 ms) measured ~190 ms under utility).
                    let until = DispatchTime.now().uptimeNanoseconds + 60_000_000
                    while DispatchTime.now().uptimeNanoseconds < until {}
                }
            }
            return pacer.finish()
        }
        let pass = pacing.actualMs >= c.minMs && pacing.actualMs <= c.maxMs
            && pacing.maxFrameLateMs >= c.minLateMs
        allPass = allPass && pass
        var row: [String: Any] = pacing.ackFields
        row["name"] = c.name
        row["frames"] = c.offsets.count
        row["offsetsMs"] = c.offsets
        row["minMs"] = c.minMs
        row["maxMs"] = c.maxMs
        row["pass"] = pass
        rows.append(row)
    }
    let out: [String: Any] = ["ok": allPass, "cases": rows]
    if let data = try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
    return allPass
}

// MARK: - Coordinate / gesture types

struct Point: Equatable, Sendable {
    let x: Double
    let y: Double
}

struct Size: Equatable, Sendable {
    let width: Double
    let height: Double
}

enum GesturePhase: String, Sendable, Equatable, CaseIterable {
    case down, move, up
}

struct HIDUsage: Equatable, Hashable, Sendable {
    let page: UInt32
    let usage: UInt32
}

enum DeviceEdge: String, Sendable, Equatable, Hashable, CaseIterable {
    case left, top, right, bottom
}

enum DeviceButton: String, Sendable, Equatable, Hashable {
    case home, lock
    case power, action
    case volumeUp = "volume-up"
    case volumeDown = "volume-down"
    case digitalCrown = "digital-crown"
    case sideButton = "side-button"
    case leftSideButton = "left-side-button"
    case appSwitcher = "app-switcher"
    case swipeToAppSwitcher = "swipe-to-app-switcher"
    case swipeToHome = "swipe-to-home"
    case pullDownToLockScreen = "pull-down-to-lock-screen"
    case pullDownToNotificationCenter = "pull-down-to-notification-center"
}

extension DeviceButton {
    /// Standard HID (page, usage) for arbitrary-HID side buttons.
    /// `home`/`lock` return `nil` — they ride
    /// `IndigoHIDMessageForButton` instead. Codes copied verbatim
    /// from baguette's DeviceButton.standardHIDUsage.
    var standardHIDUsage: HIDUsage? {
        switch self {
        case .home, .lock, .appSwitcher, .swipeToAppSwitcher, .swipeToHome,
             .pullDownToLockScreen, .pullDownToNotificationCenter: return nil
        case .power:      return HIDUsage(page: 12, usage: 48)
        case .volumeUp:   return HIDUsage(page: 12, usage: 233)
        case .volumeDown: return HIDUsage(page: 12, usage: 234)
        case .action:     return HIDUsage(page: 11, usage: 45)
        case .digitalCrown:   return HIDUsage(page: 12, usage: 64)
        case .sideButton:     return HIDUsage(page: 12, usage: 149)
        case .leftSideButton: return HIDUsage(page: 65281, usage: 512)
        }
    }
}

// MARK: - Keyboard

struct KeyboardKey: Equatable, Hashable, Sendable {
    let hidUsage: HIDUsage

    static func from(wireCode: String) -> KeyboardKey? {
        guard let usage = wireCodeMap[wireCode] else { return nil }
        return KeyboardKey(hidUsage: HIDUsage(page: 7, usage: usage))
    }

    static func decompose(character c: Character) -> (key: KeyboardKey, modifiers: Set<KeyModifier>)? {
        guard let scalar = c.unicodeScalars.first,
              c.unicodeScalars.count == 1,
              scalar.isASCII
        else { return nil }
        let value = Int(scalar.value)

        if value >= Int(Character("a").asciiValue!) && value <= Int(Character("z").asciiValue!) {
            let usage = UInt32(0x04 + value - Int(Character("a").asciiValue!))
            return (KeyboardKey(hidUsage: HIDUsage(page: 7, usage: usage)), [])
        }
        if value >= Int(Character("A").asciiValue!) && value <= Int(Character("Z").asciiValue!) {
            let usage = UInt32(0x04 + value - Int(Character("A").asciiValue!))
            return (KeyboardKey(hidUsage: HIDUsage(page: 7, usage: usage)), [.shift])
        }
        if value >= Int(Character("0").asciiValue!) && value <= Int(Character("9").asciiValue!) {
            let usage: UInt32 = (c == "0")
                ? 0x27
                : UInt32(0x1E + value - Int(Character("1").asciiValue!))
            return (KeyboardKey(hidUsage: HIDUsage(page: 7, usage: usage)), [])
        }
        if let pair = punctuationMap[c] {
            return (KeyboardKey(hidUsage: HIDUsage(page: 7, usage: pair.usage)), pair.shifted ? [.shift] : [])
        }
        return nil
    }

    private static let wireCodeMap: [String: UInt32] = {
        var m: [String: UInt32] = [
            "Enter":       0x28,
            "Escape":      0x29,
            "Backspace":   0x2A,
            "Tab":         0x2B,
            "Space":       0x2C,
            "Minus":       0x2D,
            "Equal":       0x2E,
            "BracketLeft": 0x2F,
            "BracketRight":0x30,
            "Backslash":   0x31,
            "Semicolon":   0x33,
            "Quote":       0x34,
            "Backquote":   0x35,
            "Comma":       0x36,
            "Period":      0x37,
            "Slash":       0x38,
            "ArrowRight":  0x4F,
            "ArrowLeft":   0x50,
            "ArrowDown":   0x51,
            "ArrowUp":     0x52,
        ]
        for (i, c) in "ABCDEFGHIJKLMNOPQRSTUVWXYZ".enumerated() {
            m["Key\(c)"] = UInt32(0x04 + i)
        }
        for i in 1...9 {
            m["Digit\(i)"] = UInt32(0x1E + i - 1)
        }
        m["Digit0"] = 0x27
        return m
    }()

    private static let punctuationMap: [Character: (usage: UInt32, shifted: Bool)] = [
        " ":  (0x2C, false),
        "-":  (0x2D, false), "_":  (0x2D, true),
        "=":  (0x2E, false), "+":  (0x2E, true),
        "[":  (0x2F, false), "{":  (0x2F, true),
        "]":  (0x30, false), "}":  (0x30, true),
        "\\": (0x31, false), "|":  (0x31, true),
        ";":  (0x33, false), ":":  (0x33, true),
        "'":  (0x34, false), "\"": (0x34, true),
        "`":  (0x35, false), "~":  (0x35, true),
        ",":  (0x36, false), "<":  (0x36, true),
        ".":  (0x37, false), ">":  (0x37, true),
        "/":  (0x38, false), "?":  (0x38, true),
        "!": (0x1E, true), "@": (0x1F, true), "#": (0x20, true), "$": (0x21, true),
        "%": (0x22, true), "^": (0x23, true), "&": (0x24, true), "*": (0x25, true),
        "(": (0x26, true), ")": (0x27, true),
    ]
}

enum KeyModifier: String, Sendable, Hashable, CaseIterable {
    case shift, control, option, command

    var hidUsage: HIDUsage {
        switch self {
        case .control: return HIDUsage(page: 7, usage: 0xE0)
        case .shift:   return HIDUsage(page: 7, usage: 0xE1)
        case .option:  return HIDUsage(page: 7, usage: 0xE2)
        case .command: return HIDUsage(page: 7, usage: 0xE3)
        }
    }
}

// MARK: - Input / DeviceHost protocols

protocol Input: Sendable {
    func tap(at point: Point, size: Size, duration: Double) -> Bool
    func swipe(from start: Point, to end: Point, size: Size, duration: Double) -> Bool
    func touch1(phase: GesturePhase, at point: Point, size: Size, edge: DeviceEdge?) -> Bool
    func touch2(phase: GesturePhase, first: Point, second: Point, size: Size) -> Bool
    func button(_ button: DeviceButton, duration: Double) -> Bool
    func key(_ key: KeyboardKey, modifiers: Set<KeyModifier>, duration: Double) -> Bool
    func scroll(deltaX: Double, deltaY: Double) -> Bool
    func twoFingerPath(
        start1: Point, end1: Point,
        start2: Point, end2: Point,
        size: Size, duration: Double
    ) -> Bool
}

protocol DeviceHost: AnyObject, Sendable {
    func resolveDevice(udid: String) -> NSObject?
}

// MARK: - Logging (stderr; stdout is reserved for ack JSON)

func log(_ message: String) {
    fputs("[sim-input] \(message)\n", stderr)
}

func logErr(_ message: String) {
    fputs("[sim-input] \(message)\n", stderr)
}

func dlerrorString() -> String {
    guard let err = dlerror() else { return "(null)" }
    return String(cString: err)
}

// MARK: - CoreSimulators (slimmed: only what the ported HID files need)

/// Minimal CoreSimulator host. Loads CoreSimulator + SimulatorKit at
/// runtime, resolves the developer directory via `xcode-select -p`
/// with a fallback scan of `/Applications/Xcode*.app`, and walks the
/// shared device set to look up a `SimDevice` by UDID.
///
/// `developerDir()` is also called by the ported HID files'
/// `dlopen(SimulatorKit)` paths — it's intentionally a static method
/// so callers don't have to thread an instance through.
final class CoreSimulators: DeviceHost, @unchecked Sendable {
    init() {
        Self.loadFrameworks()
    }

    func resolveDevice(udid: String) -> NSObject? {
        guard let set = resolveSet() else { return nil }
        for device in availableDevices(in: set) {
            if (device.value(forKey: "UDID") as? NSUUID)?.uuidString.lowercased() == udid.lowercased() {
                return device
            }
        }
        return nil
    }

    // MARK: - private

    private func resolveSet() -> NSObject? {
        guard let ctx = sharedServiceContext() else { return nil }
        return defaultDeviceSet(context: ctx)
    }

    private func sharedServiceContext() -> NSObject? {
        guard let cls = NSClassFromString("SimServiceContext") else { return nil }
        let sel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
        var err: NSError?
        let ctx = invokeClassObjWithObjAndError(cls, sel, Self.developerDir() as NSString, &err)
        if ctx == nil, let err { logErr("sharedServiceContext: \(err)") }
        return ctx
    }

    private func defaultDeviceSet(context: NSObject) -> NSObject? {
        let sel = NSSelectorFromString("defaultDeviceSetWithError:")
        guard context.responds(to: sel) else { return nil }
        var err: NSError?
        return invokeObjWithError(context, sel, &err)
    }

    private func availableDevices(in set: NSObject) -> [NSObject] {
        (set.value(forKey: "availableDevices") as? [NSObject]) ?? []
    }

    // MARK: - framework loading

    nonisolated(unsafe) private static var loaded = false

    static func loadFrameworks() {
        guard !loaded else { return }
        loaded = true
        let dev = developerDir()
        let coreSim = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"
        let simKit = (dev as NSString)
            .appendingPathComponent("Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit")
        if dlopen(coreSim, RTLD_NOW | RTLD_GLOBAL) == nil {
            logErr("CoreSimulator load failed: \(dlerrorString())")
        }
        if dlopen(simKit, RTLD_NOW | RTLD_GLOBAL) == nil {
            logErr("SimulatorKit load failed: \(dlerrorString())")
        }
    }

    /// Resolve a developer directory that actually contains
    /// `SimulatorKit.framework`. `xcode-select -p` is the first
    /// choice; falls back to scanning `/Applications` for
    /// `Xcode*.app` whose `Contents/Developer` has SimulatorKit.
    static func developerDir() -> String {
        if let dev = xcodeSelectDir(), hasSimulatorKit(at: dev) { return dev }
        if let dev = scanApplications() { return dev }
        return xcodeSelectDir() ?? "/Applications/Xcode.app/Contents/Developer"
    }

    private static func xcodeSelectDir() -> String? {
        let pipe = Pipe()
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
        task.arguments = ["-p"]
        task.standardOutput = pipe
        do { try task.run() } catch { return nil }
        task.waitUntilExit()
        let out = String(
            data: pipe.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        )?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return out.isEmpty ? nil : out
    }

    private static func hasSimulatorKit(at developerDir: String) -> Bool {
        let path = (developerDir as NSString)
            .appendingPathComponent("Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit")
        return FileManager.default.fileExists(atPath: path)
    }

    private static func scanApplications() -> String? {
        let fm = FileManager.default
        let canonical = "/Applications/Xcode.app/Contents/Developer"
        if hasSimulatorKit(at: canonical) { return canonical }
        let entries = (try? fm.contentsOfDirectory(atPath: "/Applications")) ?? []
        for app in entries.sorted()
        where app.hasPrefix("Xcode") && app.hasSuffix(".app") && app != "Xcode.app" {
            let dev = "/Applications/\(app)/Contents/Developer"
            if hasSimulatorKit(at: dev) { return dev }
        }
        return nil
    }
}

// MARK: - ObjC-runtime helpers used by CoreSimulators

func invokeObjWithError(
    _ target: NSObject, _ sel: Selector, _ err: inout NSError?
) -> NSObject? {
    guard let imp = class_getMethodImplementation(type(of: target), sel) else { return nil }
    typealias Fn = @convention(c) (
        AnyObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>
    ) -> AnyObject?
    return unsafeBitCast(imp, to: Fn.self)(target, sel, &err) as? NSObject
}

func invokeClassObjWithObjAndError(
    _ cls: AnyClass, _ sel: Selector, _ arg: AnyObject, _ err: inout NSError?
) -> NSObject? {
    guard let metaCls = object_getClass(cls),
          let imp = class_getMethodImplementation(metaCls, sel)
    else { return nil }
    typealias Fn = @convention(c) (
        AnyClass, Selector, AnyObject, AutoreleasingUnsafeMutablePointer<NSError?>
    ) -> AnyObject?
    return unsafeBitCast(imp, to: Fn.self)(cls, sel, arg, &err) as? NSObject
}
