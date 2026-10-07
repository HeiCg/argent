import XCTest

extension ArgentRunnerSession {
    /// An XCUICoordinate at absolute SCREEN POINTS `(x, y)`. Wire `x`/`y` are in
    /// the same space as `XCUIElementSnapshot.frame` (screen points), so the app
    /// origin is subtracted to cancel `withOffset`'s app-relative base. (Base B.)
    private func point(_ app: XCUIApplication, _ x: Double, _ y: Double) -> XCUICoordinate {
        let origin = app.frame.origin
        return app.coordinate(withNormalizedOffset: .zero).withOffset(
            CGVector(dx: x - origin.x, dy: y - origin.y)
        )
    }

    /// `tap`: `clickCount` taps as one on-device gesture. XCUITest builds its own
    /// press/gap timing, so `holdMs`/`gapMs` are accepted but not enforced
    /// per-millisecond. XCUITest cannot report a dropped event, so `dropped` is
    /// always false and `dropReporting` says so.
    func handleTap(_ params: RunnerParams) throws -> TapReply {
        let app = try resolveTargetApp(params)
        guard let x = params.x, let y = params.y else {
            throw RunnerError.invalidParams("tap requires x and y (screen points)")
        }
        let taps = max(1, params.clickCount ?? 1)
        let holdMs = params.holdMs ?? 0
        let coordinate = point(app, x, y)

        switch taps {
        case 1:
            if holdMs > 0 {
                coordinate.press(forDuration: max(0.01, holdMs / 1000))
            } else {
                coordinate.tap()
            }
        case 2:
            coordinate.doubleTap()
        default:
            // XCUICoordinate has no N-tap API; an on-device loop keeps the
            // inter-tap latency inside the OS multi-tap window.
            for _ in 0..<taps { coordinate.tap() }
        }

        return TapReply(success: true, dropped: false, dropReporting: "unsupported")
    }

    /// `longPress`: press at the wire point for `durationMs` (default 800, floor
    /// 50 ms). (Base B.)
    func handleLongPress(_ params: RunnerParams) throws -> OkReply {
        let app = try resolveTargetApp(params)
        guard let x = params.x, let y = params.y else {
            throw RunnerError.invalidParams("longPress requires x and y (screen points)")
        }
        let seconds = max(0.05, (params.durationMs ?? 800) / 1000)
        point(app, x, y).press(forDuration: seconds)
        return OkReply(success: true)
    }

    /// Drag velocity bounds in points per second (base B). Below 60 pt/s XCUITest's
    /// drag stalls; above 5000 pt/s it is a single-frame jump.
    static let swipeVelocityBounds: ClosedRange<Double> = 60...5000

    /// Drag velocity in points per second for a straight swipe of `distance`
    /// points that should take `durationMs`: `distance / (durationMs / 1000)`,
    /// clamped to `swipeVelocityBounds`. `nil` when no positive duration was asked
    /// for (XCUITest's default velocity applies) or the distance is not positive
    /// (nothing to drag; the caller presses instead). Pure, so it is unit-tested.
    static func swipeVelocity(distance: Double, durationMs: Double?) -> Double? {
        guard let durationMs, durationMs > 0, distance > 0 else { return nil }
        let raw = distance / (durationMs / 1000)
        return min(max(raw, swipeVelocityBounds.lowerBound), swipeVelocityBounds.upperBound)
    }

    /// `swipe`: drag between two screen points. `durationMs` maps to drag velocity
    /// through `swipeVelocity`; without it XCUITest's default velocity applies. A
    /// zero-length swipe with a duration is a press of `durationMs`. `holdEndMs > 0`
    /// rests at the destination before lifting so the release velocity decays and
    /// the view does not fling (base B's `settle`). `steps` is accepted and unused:
    /// XCUITest interpolates its own drag.
    func handleSwipe(_ params: RunnerParams) throws -> OkReply {
        let app = try resolveTargetApp(params)
        guard let fromX = params.startX, let fromY = params.startY,
              let toX = params.endX, let toY = params.endY
        else {
            throw RunnerError.invalidParams("swipe requires startX, startY, endX and endY (screen points)")
        }

        let start = point(app, fromX, fromY)
        let distance = hypot(toX - fromX, toY - fromY)

        if distance <= 0, let durationMs = params.durationMs, durationMs > 0 {
            NSLog("ARGENT_RUNNER_SWIPE distance=0 durationMs=%.0f press", durationMs)
            start.press(forDuration: max(0.05, durationMs / 1000))
            return OkReply(success: true)
        }

        let end = point(app, toX, toY)
        let holdEndMs = params.holdEndMs ?? 0
        let endHold: TimeInterval = holdEndMs > 0 ? max(0.3, holdEndMs / 1000) : 0.05
        let velocity: XCUIGestureVelocity
        if let pointsPerSecond = Self.swipeVelocity(distance: distance, durationMs: params.durationMs) {
            NSLog("ARGENT_RUNNER_SWIPE distance=%.1f durationMs=%.0f velocity=%.0f",
                  distance, params.durationMs ?? 0, pointsPerSecond)
            velocity = XCUIGestureVelocity(rawValue: CGFloat(pointsPerSecond))
        } else {
            NSLog("ARGENT_RUNNER_SWIPE distance=%.1f velocity=default", distance)
            velocity = .default
        }

        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: velocity, thenHoldForDuration: endHold)
        return OkReply(success: true)
    }
}
