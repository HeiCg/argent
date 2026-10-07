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
struct ScreenGeometry: Equatable {
    let width: Double
    let height: Double
    let scale: Double

    var orientation: String { width <= height ? "portrait" : "landscape" }
}

/// Per-session geometry state, so `getScreenSize` (which the host calls before
/// every tap and swipe) is a lookup instead of the target's state + frame reads.
///
/// `panelLongSidePx` is measured once per session from a screenshot: the panel
/// does not change. The point size is one entry keyed by the target bundle id and
/// the device orientation; a rotation or a new target is a miss, and `launchApp` /
/// `terminateApp` invalidate it. Pure value; the session guards it with its lock.
struct GeometryCache {
    struct Key: Equatable {
        let bundleId: String
        let orientation: Int
    }

    var panelLongSidePx: Double?
    private var entry: (key: Key, geometry: ScreenGeometry)?

    func geometry(for key: Key) -> ScreenGeometry? {
        guard let entry, entry.key == key else { return nil }
        return entry.geometry
    }

    mutating func store(_ geometry: ScreenGeometry, for key: Key) {
        entry = (key, geometry)
    }

    mutating func invalidate() {
        entry = nil
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

    static let springboardBundleId = "com.apple.springboard"

    /// The screen size in POINTS as the target app sees it, and the scale in
    /// framebuffer pixels per point; `cacheable` is false when either came from a
    /// fallback, so the next call measures again.
    ///
    /// Not `UIScreen.main`: this code runs inside the XCTest runner app
    /// (`ArgentRunnerUITests-Runner`), whose Info.plist Xcode generates from its own
    /// template without a launch screen, so iOS runs that process in legacy
    /// compatibility mode. Its `UIScreen.main.bounds` is a 320×480-class size (480
    /// pt tall on an iPhone 17 whose screen is 402×874 pt @3x, run 37572773799) and
    /// its `nativeBounds` / `nativeScale` follow that mode (1440 px tall, run
    /// 37585976421). The host app's `UILaunchScreen` does not reach that process.
    ///
    /// Points: the frame of `app` when it is in the foreground (the target), else
    /// SpringBoard's — the same space as `XCUIElementSnapshot.frame` and the wire
    /// tap coordinates. Scale: see `geometry(points:)`. Falls back to
    /// `UIScreen.main` only when XCTest returns no frame at all, and logs it.
    /// Runs on the main thread.
    func screenGeometry(foreground app: XCUIApplication?) -> (geometry: ScreenGeometry, cacheable: Bool) {
        if let app, let frame = Self.readableFrame(of: app) {
            return geometry(points: frame)
        }
        if let frame = Self.readableFrame(of: XCUIApplication(bundleIdentifier: Self.springboardBundleId)) {
            return geometry(points: frame)
        }
        let bounds = UIScreen.main.bounds
        NSLog("ARGENT_RUNNER_GEOMETRY_FALLBACK no app frame; UIScreen.main %@", NSCoder.string(for: bounds))
        let geo = ScreenGeometry(
            width: Double(bounds.width), height: Double(bounds.height), scale: Double(UIScreen.main.scale)
        )
        return (geo, false)
    }

    /// Geometry for an app frame in points. The scale is the panel's long side in
    /// pixels, measured from a screenshot once per session (`panelLongSidePixels`),
    /// over the frame's long side in points, rounded to 0.01: the px-per-point of a
    /// simctl screenshot (3 on an iPhone 17). Falls back to `UIScreen.main.scale`
    /// (not cacheable) only when the screenshot gave no size.
    func geometry(points frame: CGRect) -> (geometry: ScreenGeometry, cacheable: Bool) {
        let width = Double(frame.width)
        let height = Double(frame.height)
        if let px = panelLongSidePixels(),
           let scale = Self.roundedScale(panelLongSidePx: px, pointSize: frame.size)
        {
            return (ScreenGeometry(width: width, height: height, scale: scale), true)
        }
        NSLog("ARGENT_RUNNER_GEOMETRY_FALLBACK no panel size; UIScreen.main.scale %.2f", Double(UIScreen.main.scale))
        return (ScreenGeometry(width: width, height: height, scale: Double(UIScreen.main.scale)), false)
    }

    /// Panel pixels over points on the long side (orientation-free), rounded to
    /// 0.01; nil when the inputs give no framebuffer scale (≤ 0, non-finite, < 1).
    static func roundedScale(panelLongSidePx: Double, pointSize: CGSize) -> Double? {
        let longPt = Double(max(pointSize.width, pointSize.height))
        guard panelLongSidePx.isFinite, longPt.isFinite, longPt > 0 else { return nil }
        let raw = panelLongSidePx / longPt
        guard raw.isFinite, raw >= 1 else { return nil }
        return (raw * 100).rounded() / 100
    }

    /// The panel's long side in pixels: cached, else measured from one
    /// `XCUIScreen` screenshot (~100-300 ms, once per session). The screenshot is
    /// the framebuffer as testmanagerd captures it, independent of the runner
    /// process's compatibility mode. Nil (and not cached) if the capture failed.
    func panelLongSidePixels() -> Double? {
        if let px = cachedPanelLongSidePx() { return px }
        var size = CGSize.zero
        let exception = ArgentExceptionGuard.runCatching {
            let image = XCUIScreen.main.screenshot().image
            if let cg = image.cgImage {
                size = CGSize(width: cg.width, height: cg.height)
            } else {
                size = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
            }
        }
        let px = Double(max(size.width, size.height))
        guard exception == nil, px.isFinite, px > 0 else {
            NSLog("ARGENT_RUNNER_GEOMETRY_PANEL screenshot gave no size")
            return nil
        }
        NSLog("ARGENT_RUNNER_GEOMETRY_PANEL %.0fx%.0f px", Double(size.width), Double(size.height))
        setPanelLongSidePx(px)
        return px
    }

    /// Cache key for `bundleId` at the current device orientation, so a rotation
    /// misses the cached point size.
    static func geometryKey(bundleId: String) -> GeometryCache.Key {
        GeometryCache.Key(bundleId: bundleId, orientation: XCUIDevice.shared.orientation.rawValue)
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
    /// and the screen geometry in points + scale (see `screenGeometry`). Always
    /// reads the geometry fresh and refreshes the `getScreenSize` cache with it.
    func getInfo(_ params: RunnerParams) throws -> InfoReply {
        let bundleId = params.bundleId?.trimmedNonEmpty ?? targetBundleId() ?? ""
        let app = Self.foregroundApp(bundleId)
        let (geo, cacheable) = screenGeometry(foreground: app)
        if cacheable, !bundleId.isEmpty, bundleId == targetBundleId() {
            storeGeometry(geo, for: Self.geometryKey(bundleId: bundleId))
        }
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

    /// `getScreenSize`: geometry only, no tree. The host calls it before every tap
    /// and swipe, so it answers from the session cache (target + orientation key)
    /// and reads the target's state and frame only on a miss.
    func getScreenSize() -> ScreenSizeReply {
        let target = targetBundleId() ?? ""
        let key = Self.geometryKey(bundleId: target)
        let geo: ScreenGeometry
        if let cached = cachedGeometry(for: key) {
            geo = cached
        } else {
            let (fresh, cacheable) = screenGeometry(foreground: Self.foregroundApp(target))
            if cacheable { storeGeometry(fresh, for: key) }
            geo = fresh
        }
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
        invalidateGeometry()
        return LaunchAppReply(success: true, bundleId: bundleId)
    }

    /// `terminateApp`: terminate the app by bundle id (defaults to the current
    /// target).
    func handleTerminateApp(_ params: RunnerParams) throws -> LaunchAppReply {
        guard let bundleId = params.bundleId?.trimmedNonEmpty ?? targetBundleId() else {
            throw RunnerError.invalidParams("terminateApp requires bundleId")
        }
        XCUIApplication(bundleIdentifier: bundleId).terminate()
        invalidateGeometry()
        return LaunchAppReply(success: true, bundleId: bundleId)
    }
}
