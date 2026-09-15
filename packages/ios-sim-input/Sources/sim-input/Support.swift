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
// `logErr`, `dlerrorString`. This file provides those — and ONLY those —
// so the two HID files can stay byte-for-byte verbatim.

import Foundation
import ObjectiveC

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
