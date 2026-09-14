import UIKit
import XCTest

extension String {
    /// Trimmed and nil when blank.
    var trimmedNonEmpty: String? {
        let t = trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
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

    /// The main screen size in POINTS and the backing scale, read from UIKit's
    /// `UIScreen.main` (the same physical screen `XCUIScreen.main` refers to),
    /// never from a screenshot. Runs on the main thread.
    static func screenGeometry() -> (width: Double, height: Double, scale: Double) {
        let bounds = UIScreen.main.bounds
        return (Double(bounds.width), Double(bounds.height), Double(UIScreen.main.scale))
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
    /// and the main screen geometry in points + scale.
    func getInfo(_ params: RunnerParams) throws -> InfoReply {
        let bundleId = params.bundleId?.trimmedNonEmpty ?? targetBundleId() ?? ""
        let geo = Self.screenGeometry()
        let orientation = geo.width <= geo.height ? "portrait" : "landscape"

        var keyboardVisible = false
        if !bundleId.isEmpty {
            let app = XCUIApplication(bundleIdentifier: bundleId)
            if app.state == .runningForeground {
                keyboardVisible = app.keyboards.firstMatch.exists
            }
        }

        return InfoReply(
            bundleId: bundleId,
            orientation: orientation,
            keyboardVisible: keyboardVisible,
            screenWidth: geo.width,
            screenHeight: geo.height,
            scale: geo.scale,
            version: currentVersion()
        )
    }

    /// `getScreenSize`: cheap geometry with no accessibility read.
    func getScreenSize() -> ScreenSizeReply {
        let geo = Self.screenGeometry()
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
