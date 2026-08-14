import XCTest

extension ArgentRunnerSession {
  /// Gesture coordinates are absolute points anchored at the app element's
  /// origin. XCUICoordinate handles interface orientation for us — one of the
  /// reasons this runner stays on public XCTest APIs.
  private func point(_ app: XCUIApplication, _ x: Double, _ y: Double) -> XCUICoordinate {
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
  }

  func performTap(_ request: CommandRequest, on app: XCUIApplication) -> Envelope {
    guard let x = request.x, let y = request.y else {
      return .failure(.invalidRequest, "tap requires x and y")
    }
    point(app, x, y).tap()
    return .success(MessagePayload(message: "tapped"))
  }

  func performLongPress(_ request: CommandRequest, on app: XCUIApplication) -> Envelope {
    guard let x = request.x, let y = request.y else {
      return .failure(.invalidRequest, "longPress requires x and y")
    }
    let seconds = max(0.05, (request.durationMs ?? 800) / 1000)
    point(app, x, y).press(forDuration: seconds)
    return .success(MessagePayload(message: "long-pressed"))
  }

  func performDrag(_ request: CommandRequest, on app: XCUIApplication) -> Envelope {
    guard let fromX = request.fromX, let fromY = request.fromY,
      let toX = request.toX, let toY = request.toY
    else {
      return .failure(.invalidRequest, "drag requires fromX, fromY, toX and toY")
    }
    let start = point(app, fromX, fromY)
    let end = point(app, toX, toY)
    if let durationMs = request.durationMs, durationMs > 0 {
      // Honor the requested duration through drag velocity (points/second),
      // clamped to a range XCTest executes faithfully.
      let distance = ((toX - fromX) * (toX - fromX) + (toY - fromY) * (toY - fromY)).squareRoot()
      let velocity = min(max(distance / (durationMs / 1000), 60), 5000)
      start.press(
        forDuration: 0.05,
        thenDragTo: end,
        withVelocity: XCUIGestureVelocity(rawValue: CGFloat(velocity)),
        thenHoldForDuration: 0.05
      )
    } else {
      start.press(forDuration: 0.05, thenDragTo: end)
    }
    return .success(MessagePayload(message: "dragged"))
  }

  /// The interaction viewport: the app's main window (falling back to the app
  /// frame), with the keyboard band cut off when the keyboard dominates its
  /// bottom — normalized taps must not land on keys by accident.
  func appViewport(_ app: XCUIApplication) -> Envelope {
    let window = app.windows.firstMatch
    var frame = window.exists ? window.frame : app.frame
    guard !frame.isNull, !frame.isInfinite, !frame.isEmpty else {
      return .failure(
        .appNotAvailable,
        "the app's interaction viewport is unavailable; is the app foregrounded?"
      )
    }
    if let keyboard = visibleKeyboardFrame(app) {
      let overlap = frame.intersection(keyboard)
      // Only trim when the keyboard genuinely spans the viewport (≥50% of its
      // width) and enough usable space remains (≥25% of its height) — a
      // floating or split keyboard must not shrink the viewport to a sliver.
      if !overlap.isNull, overlap.height > 0, overlap.width / max(frame.width, 1) >= 0.5 {
        let safeHeight = keyboard.minY - frame.minY
        if safeHeight >= frame.height * 0.25 {
          frame = CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: safeHeight)
        }
      }
    }
    return .success(
      ViewportPayload(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height)
    )
  }

  func visibleKeyboardFrame(_ app: XCUIApplication) -> CGRect? {
    let keyboard = app.keyboards.firstMatch
    guard keyboard.exists else { return nil }
    let frame = keyboard.frame
    return frame.isEmpty ? nil : frame
  }
}
