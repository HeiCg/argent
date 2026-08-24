import XCTest

extension ArgentRunnerSession {
  /// Wire `x`/`y` are absolute points in the same space as `XCUIElement.frame`
  /// and snapshot rects (screen points). `withOffset` is relative to the app
  /// element's origin, so subtract that origin — otherwise a non-zero
  /// `app.frame.origin` would be applied twice. XCUICoordinate still handles
  /// interface orientation for us.
  private func point(_ app: XCUIApplication, _ x: Double, _ y: Double) -> XCUICoordinate {
    let origin = app.frame.origin

    return app.coordinate(withNormalizedOffset: .zero).withOffset(
      CGVector(dx: x - origin.x, dy: y - origin.y))
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

    // A `settle` drag rests at the destination before lifting, so the scroll
    // view reads ~0 release velocity and skips its fling — the hardware
    // analogue of the simulator's ease-out swipe.
    let endHold = request.settle == true ? 0.3 : 0.05

    let velocity: XCUIGestureVelocity
    if let durationMs = request.durationMs, durationMs > 0 {
      // Honor the requested duration through drag velocity (points/second),
      // clamped to a range XCTest executes faithfully.
      let distance = ((toX - fromX) * (toX - fromX) + (toY - fromY) * (toY - fromY)).squareRoot()
      let pointsPerSecond = min(max(distance / (durationMs / 1000), 60), 5000)
      velocity = XCUIGestureVelocity(rawValue: CGFloat(pointsPerSecond))
    } else {
      velocity = .default
    }

    start.press(
      forDuration: 0.05,
      thenDragTo: end,
      withVelocity: velocity,
      thenHoldForDuration: endHold
    )

    return .success(MessagePayload(message: "dragged"))
  }

  /// The 0–1 reference rectangle: `XCUIApplication.frame`, the same rect the
  /// snapshot's Application root uses. Describe normalizes frames against that
  /// root; taps denormalize through this viewport — they must be the same
  /// space, including the keyboard band. Trimming the keyboard (or using the
  /// window frame) made `y = 0.84` mean a different pixel than describe's 0.84.
  func appViewport(_ app: XCUIApplication) -> Envelope {
    let frame = app.frame

    guard !frame.isNull, !frame.isInfinite, !frame.isEmpty else {
      return .failure(
        .appNotAvailable,
        "the app's interaction viewport is unavailable; is the app foregrounded?"
      )
    }

    return .success(
      ViewportPayload(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height)
    )
  }
}
