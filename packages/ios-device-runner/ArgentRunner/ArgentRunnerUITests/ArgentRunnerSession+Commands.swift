import XCTest

extension ArgentRunnerSession {
  enum TargetResolution {
    case ready(XCUIApplication)
    case unavailable(Envelope)
  }

  /// Executes one command on the main thread. XCTest work is wrapped in the
  /// exception guard (stale accessibility elements throw NSExceptions that
  /// would otherwise kill the process), read-only commands get one retry
  /// after a beat, and a mutating command whose execution recorded a real
  /// XCTest failure is reported as failed — the tap that silently missed
  /// must not read as success.
  func performOnMain(_ request: CommandRequest) -> Envelope {
    var attempts = 0
    while true {
      attempts += 1
      let failuresBefore = recordedFailureCount()
      var envelope: Envelope?
      let exceptionDescription = ArgentExceptionGuard.runCatching {
        envelope = self.performCommand(request)
      }
      if let exceptionDescription {
        if request.command.isReadOnly && attempts == 1 {
          NSLog("ARGENT_RUNNER_RETRY command=%@ reason=exception", request.command.rawValue)
          Thread.sleep(forTimeInterval: 0.2)
          continue
        }
        return .failure(
          .commandFailed,
          exceptionDescription,
          hint: "The target UI likely changed mid-command; re-observe the screen and retry."
        )
      }
      guard var result = envelope else {
        return .failure(.commandFailed, "\(request.command.rawValue) produced no response")
      }
      if !request.command.isReadOnly, result.ok, recordedFailureCount() > failuresBefore {
        result = .failure(
          .xctestRecordedFailure,
          "XCTest recorded a failure while executing \(request.command.rawValue); "
            + "the action may not have been performed.",
          hint: "Re-observe the screen to confirm the effect before retrying."
        )
      }
      return result
    }
  }

  private func recordedFailureCount() -> Int {
    testRun?.totalFailureCount ?? 0
  }

  private func performCommand(_ request: CommandRequest) -> Envelope {
    if request.command.requiresAppBundleId {
      guard let bundleId = request.normalizedAppBundleId else {
        return .failure(
          .appBundleIdRequired,
          "\(request.command.rawValue) requires appBundleId",
          hint:
            "Launch or target an app first — the runner never redirects app commands "
            + "to its own host app."
        )
      }
      switch foregroundTarget(bundleId: bundleId) {
      case .unavailable(let envelope):
        return envelope
      case .ready(let app):
        return performAppCommand(request, on: app)
      }
    }
    switch request.command {
    case .home:
      XCUIDevice.shared.press(.home)
      return .success(MessagePayload(message: "pressed home"))
    case .screenshot:
      return captureScreenshot()
    case .shutdown:
      return .success(MessagePayload(message: "shutting down"))
    default:
      return .failure(
        .invalidRequest, "\(request.command.rawValue) is not executable on this path"
      )
    }
  }

  private func performAppCommand(_ request: CommandRequest, on app: XCUIApplication) -> Envelope {
    switch request.command {
    case .viewport:
      return appViewport(app)
    case .tap:
      return performTap(request, on: app)
    case .longPress:
      return performLongPress(request, on: app)
    case .drag:
      return performDrag(request, on: app)
    case .type:
      return performType(request, on: app)
    case .keyboardReturn:
      return performKeyboardReturn(on: app)
    case .snapshot:
      return captureSnapshot(of: app)
    default:
      return .failure(.invalidRequest, "\(request.command.rawValue) is not an app-scoped command")
    }
  }

  /// Resolves the target app and guarantees it is frontmost. A fresh
  /// XCUIApplication proxy per command is deliberate: proxies are cheap, and
  /// never caching them removes the whole class of stale-target bugs after an
  /// app is relaunched behind the runner's back. When the app is already
  /// foreground this costs a single state read.
  private func foregroundTarget(bundleId: String) -> TargetResolution {
    let app = XCUIApplication(bundleIdentifier: bundleId)
    if app.state != .runningForeground {
      app.activate()
      guard app.wait(for: .runningForeground, timeout: 15) else {
        return .unavailable(
          .failure(
            .appNotAvailable,
            "app '\(bundleId)' did not reach the foreground",
            hint:
              "Verify the bundle id and that the app is installed; launch it first "
              + "(devicectl) if it is not running."
          )
        )
      }
      // Give the first frame of a fresh activation a beat before interacting.
      Thread.sleep(forTimeInterval: 0.25)
    }
    return .ready(app)
  }
}
