import UIKit
import XCTest

extension String {
    /// Trimmed and nil when blank.
    var trimmedNonEmpty: String? {
        let t = trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
}

/// Screen size in POINTS and framebuffer pixels per point (see
/// `ArgentRunnerSession.screenGeometry`).
struct ScreenGeometry {
    let width: Double
    let height: Double
    let scale: Double

    var orientation: String { width <= height ? "portrait" : "landscape" }
}

extension ArgentRunnerSession {
    /// Hardware buttons the `key` method accepts, mapped onto `XCUIDevice.Button`.
    /// The power/lock button has no public API, and `camera` would pin the runner
    /// to a newer Xcode. Carried over from base B's `button` command.
    ///
    /// `volumeUp` / `volumeDown` are marked unavailable by the iOS Simulator SDK
    /// (they exist only on physical hardware), so they are compiled in only for a
    /// device build. On the simulator `key("volumeUp")` returns "unsupported".
    static let hardwareButtons: [String: XCUIDevice.Button] = {
        var buttons: [String: XCUIDevice.Button] = [
            "home": .home,
            "actionButton": .action,
        ]
        #if !targetEnvironment(simulator)
        buttons["volumeUp"] = .volumeUp
        buttons["volumeDown"] = .volumeDown
        #endif
        return buttons
    }()

    static let springboardBundleId = "com.apple.springboard"

    /// The screen size in POINTS as the target app sees it, and the scale in
    /// framebuffer pixels per point. Never from a screenshot.
    ///
    /// Not `UIScreen.main.bounds`: this code runs inside the XCTest runner app
    /// (`ArgentRunnerUITests-Runner`), whose Info.plist Xcode generates from its own
    /// template without a launch screen, so iOS runs that process in legacy
    /// compatibility mode and its `UIScreen.main.bounds` is a 320×480-class size
    /// (480 pt tall on an iPhone 17 whose screen is 402×874 pt @3x, run
    /// 37572773799). The host app's `UILaunchScreen` does not reach that process.
    ///
    /// Points: the frame of `app` when it is in the foreground (the target), else
    /// SpringBoard's — the same space as `XCUIElementSnapshot.frame` and the wire
    /// tap coordinates. Scale: see `geometry(points:)`. Falls back to
    /// `UIScreen.main` only when XCTest returns no frame at all, and logs it.
    /// Runs on the main thread.
    static func screenGeometry(foreground app: XCUIApplication?) -> ScreenGeometry {
        if let app, let frame = readableFrame(of: app) {
            return geometry(points: frame)
        }
        if let frame = readableFrame(of: XCUIApplication(bundleIdentifier: springboardBundleId)) {
            return geometry(points: frame)
        }
        let bounds = UIScreen.main.bounds
        NSLog("ARGENT_RUNNER_GEOMETRY_FALLBACK no app frame; UIScreen.main %@", NSCoder.string(for: bounds))
        return ScreenGeometry(
            width: Double(bounds.width), height: Double(bounds.height), scale: Double(UIScreen.main.scale)
        )
    }

    /// Geometry for an app frame in points. The scale is the panel's long side in
    /// pixels (`UIScreen.nativeBounds`: the physical panel, portrait-up, which the
    /// runner process's compatibility mode does not rescale) over the frame's long
    /// side in points: the px-per-point of a simctl screenshot (3 on an iPhone 17).
    static func geometry(points frame: CGRect) -> ScreenGeometry {
        let native = UIScreen.main.nativeBounds
        let longPx = Double(max(native.width, native.height))
        let longPt = Double(max(frame.width, frame.height))
        var scale = longPt > 0 ? longPx / longPt : 0
        if !scale.isFinite || scale < 1 { scale = Double(UIScreen.main.scale) }
        return ScreenGeometry(width: Double(frame.width), height: Double(frame.height), scale: scale)
    }

    /// `app.frame` when XCTest can read a non-empty one; nil otherwise (AX error,
    /// no window). Callers pass only a running app, so the read never records an
    /// XCTest failure for a missing process.
    static func readableFrame(of app: XCUIApplication) -> CGRect? {
        var frame = CGRect.null
        let exception = ArgentExceptionGuard.runCatching { frame = app.frame }
        guard exception == nil, !frame.isNull, !frame.isInfinite,
              frame.width > 0, frame.height > 0 else { return nil }
        return frame
    }

    /// The foreground app named `bundleId`, else nil (blank id, not running, or
    /// in the background).
    static func foregroundApp(_ bundleId: String?) -> XCUIApplication? {
        guard let bundleId, !bundleId.isEmpty else { return nil }
        let app = XCUIApplication(bundleIdentifier: bundleId)
        return app.state == .runningForeground ? app : nil
    }

    /// Resolves the app-scoped target: an explicit `bundleId` param, else the app
    /// `launchApp` last targeted. Brings a backgrounded target to the foreground.
    func resolveTargetApp(_ params: RunnerParams) throws -> XCUIApplication {
        guard let bundleId = params.bundleId?.trimmedNonEmpty ?? targetBundleId() else {
            throw RunnerError.invalidParams("no target app set; call launchApp first (e.g. com.apple.Preferences)")
        }
        let app = XCUIApplication(bundleIdentifier: bundleId)
        switch app.state {
        case .runningForeground:
            return app
        case .runningBackground, .runningBackgroundSuspended:
            app.activate()
            _ = app.wait(for: .runningForeground, timeout: 15)
            return app
        default:
            // Not running / unknown: return it anyway so the snapshot or gesture
            // surfaces the real failure rather than a synthesized one here.
            return app
        }
    }

    /// `getInfo`: the target app's bundle id, orientation, keyboard visibility,
    /// and the screen geometry in points + scale (see `screenGeometry`).
    func getInfo(_ params: RunnerParams) throws -> InfoReply {
        let bundleId = params.bundleId?.trimmedNonEmpty ?? targetBundleId() ?? ""
        let app = Self.foregroundApp(bundleId)
        let geo = Self.screenGeometry(foreground: app)
        let keyboardVisible = app?.keyboards.firstMatch.exists ?? false

        return InfoReply(
            bundleId: bundleId,
            orientation: geo.orientation,
            keyboardVisible: keyboardVisible,
            screenWidth: geo.width,
            screenHeight: geo.height,
            scale: geo.scale,
            version: currentVersion()
        )
    }

    /// `getScreenSize`: geometry only — the target's state and frame, no tree.
    func getScreenSize() -> ScreenSizeReply {
        let geo = Self.screenGeometry(foreground: Self.foregroundApp(targetBundleId()))
        return ScreenSizeReply(screenWidth: geo.width, screenHeight: geo.height, scale: geo.scale)
    }

    /// `launchApp`: launch (or relaunch) the app by bundle id and make it the
    /// app-scoped target. This is how the runner targets Settings
    /// (`com.apple.Preferences`), never the empty host app.
    func handleLaunchApp(_ params: RunnerParams) throws -> LaunchAppReply {
        guard let bundleId = params.bundleId?.trimmedNonEmpty else {
            throw RunnerError.invalidParams("launchApp requires bundleId")
        }
        let app = XCUIApplication(bundleIdentifier: bundleId)
        app.launch()
        setTargetBundleId(bundleId)
        return LaunchAppReply(success: true, bundleId: bundleId)
    }

    /// `terminateApp`: terminate the app by bundle id (defaults to the current
    /// target).
    func handleTerminateApp(_ params: RunnerParams) throws -> LaunchAppReply {
        guard let bundleId = params.bundleId?.trimmedNonEmpty ?? targetBundleId() else {
            throw RunnerError.invalidParams("terminateApp requires bundleId")
        }
        XCUIApplication(bundleIdentifier: bundleId).terminate()
        return LaunchAppReply(success: true, bundleId: bundleId)
    }
}
