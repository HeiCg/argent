import XCTest

extension ArgentRunnerSession {
  enum TargetResolution {
    /// `reactivated` is true when the target was backgrounded (or its state
    /// unreadable) and the runner had to re-front it for this command.
    case ready(XCUIApplication, reactivated: Bool)
    case unavailable(Envelope)
  }

  /// Executes one command on the main thread. XCTest work is wrapped in the
  /// exception guard (stale accessibility elements throw NSExceptions that
  /// would otherwise kill the process), read-only commands get one retry
  /// after a beat, and a mutating command whose execution recorded a real
  /// XCTest failure is reported as failed — the tap that silently missed
  /// must not read as success. A mutating command that stays ok while the
  /// suppressed-issue counter grew keeps its ok verdict but gains an advisory
  /// `warning`: the suppressed shapes accompany healthy mutations too often
  /// to promote back to failure (see the suppression comment in
  /// ArgentRunnerSession.swift), yet the delta is exactly the symptom a
  /// silently missed gesture would leave behind.
  func performOnMain(_ request: CommandRequest) -> Envelope {
    var attempts = 0
    while true {
      attempts += 1
      let failuresBefore = recordedFailureCount()
      let suppressedBefore = currentSuppressedIssueCount()
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
      // Checked after the failure promotion above, so a reply that just
      // flipped to failure never also warns; read-only commands never warn
      // at all (re-observing is what they already do).
      if !request.command.isReadOnly, result.ok,
        currentSuppressedIssueCount() > suppressedBefore {
        result = result.withWarning(
          "accessibility noise was suppressed during this gesture; "
            + "re-observe the screen to confirm the effect."
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
      case .ready(let app, let reactivated):
        let result = performAppCommand(request, on: app)
        return reactivated && result.ok ? result.withReactivated() : result
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

  /// Resolves the target app and guarantees it is frontmost — without ever
  /// LAUNCHING it. On a `.notRunning` app, `activate()` performs a full
  /// launch: after launch X → HOME, any app-scoped command would silently put
  /// X back over the home screen and report success while the screenshot
  /// channel shows otherwise. Launching stays an explicit, named action
  /// (launch-app). A backgrounded or suspended target is still re-fronted for
  /// resilience, and the reply is stamped `reactivated: true` so the agent
  /// learns the foreground changed underneath the command.
  ///
  /// A fresh XCUIApplication proxy per command is deliberate: proxies are
  /// cheap, and never caching them removes the whole class of stale-target
  /// bugs after an app is relaunched behind the runner's back. When the app
  /// is already foreground this costs a single state read.
  private func foregroundTarget(bundleId: String) -> TargetResolution {
    let app = XCUIApplication(bundleIdentifier: bundleId)
    switch app.state {
    case .runningForeground:
      return .ready(app, reactivated: false)
    case .notRunning:
      return .unavailable(
        .failure(
          .appNotAvailable,
          "app '\(bundleId)' is not running",
          hint:
            "Launch it first with launch-app; the runner does not launch apps "
            + "as a side effect of a command."
        )
      )
    default:
      // .runningBackground, .runningBackgroundSuspended, .unknown: the app is
      // alive (or its state unreadable), so activation is resumption, not a
      // launch.
      app.activate()
      guard app.wait(for: .runningForeground, timeout: 15) else {
        return .unavailable(
          .failure(
            .appNotAvailable,
            "app '\(bundleId)' did not reach the foreground",
            hint:
              "The app was running but could not be brought forward; check the "
              + "device screen and retry, or relaunch it with launch-app."
          )
        )
      }
      // Give the first frame of a fresh activation a beat before interacting.
      Thread.sleep(forTimeInterval: 0.25)
      return .ready(app, reactivated: true)
    }
  }
}
