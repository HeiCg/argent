import UIKit
import XCTest

extension DeviceButton {
  /// The XCUIDevice member for this wire name. Volume up/down are
  /// `XCUI_SIMULATOR_UNAVAILABLE` in the iOS SDK, which costs nothing here: the
  /// runner is only ever built for `generic/platform=iOS` (runner-build.ts),
  /// never against the Simulator SDK that marks them unavailable.
  var hardwareButton: XCUIDevice.Button {
    switch self {
    case .home: return .home
    case .volumeUp: return .volumeUp
    case .volumeDown: return .volumeDown
    case .actionButton: return .action
    }
  }
}

extension ArgentRunnerSession {
  enum TargetResolution {
    /// `reactivated` is true when the target was alive but backgrounded and
    /// the runner had to re-front it for this command.
    case ready(XCUIApplication, reactivated: Bool)
    case unavailable(Envelope)
  }

  /// Executes one command on the main thread. XCTest work is wrapped in the
  /// exception guard (stale accessibility elements throw NSExceptions that
  /// would otherwise kill the process), read-only commands get one retry
  /// after a beat, and a mutating command whose execution recorded a real
  /// XCTest failure is reported as failed: the tap that silently missed
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
          hint: "Launch or target an app first with launch-app."
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
    case .button:
      return pressDeviceButton(request)
    case .screenshot:
      return captureScreenshot()
    case .shutdown:
      return .success(MessagePayload(message: "shutting down"))
    default:
      return .failure(
        .invalidRequest, "\(request.command.rawValue) is not a device-scoped command"
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

  /// Presses one hardware button. `hasHardwareButton` is consulted first: not
  /// every iPhone has every button (a non-Pro iPhone has no Action button), and
  /// `press` on an absent one is a no-op the agent would read as a successful
  /// press. Naming the device class keeps the refusal actionable, since which
  /// buttons exist is a property of the hardware, not of the runner.
  private func pressDeviceButton(_ request: CommandRequest) -> Envelope {
    guard let button = request.button else {
      return .failure(
        .invalidRequest,
        "button requires a button name",
        hint: "Send one of: home, volumeUp, volumeDown, actionButton."
      )
    }
    let device = XCUIDevice.shared
    guard device.hasHardwareButton(button.hardwareButton) else {
      return .failure(
        .unsupportedOperation,
        "this \(UIDevice.current.model) has no \(button.rawValue) button",
        hint: "Press a button this hardware has, or drive the equivalent from on-screen UI."
      )
    }
    device.press(button.hardwareButton)
    return .success(MessagePayload(message: "pressed \(button.rawValue)"))
  }

  /// Resolves the target app and brings it frontmost. Only a live but
  /// backgrounded target is re-fronted, and the reply is stamped
  /// `reactivated: true` so the agent learns the foreground changed underneath
  /// the command. Every other state is refused, because `activate()` on an app
  /// that is not already running performs a FULL LAUNCH (after launch X then
  /// HOME, an app-scoped command would silently put X back over the home
  /// screen), and launching stays an explicit, named action (launch-app).
  ///
  /// That is why `.unknown` is refused alongside `.notRunning`: on hardware a
  /// swipe-killed app this session never launched reports `.unknown`, so
  /// activating it would be exactly the hidden launch the refusal exists to
  /// prevent.
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
    case .runningBackground, .runningBackgroundSuspended:
      app.activate()
      guard app.wait(for: .runningForeground, timeout: 15) else {
        return .unavailable(
          .failure(
            .appNotAvailable,
            "app '\(bundleId)' did not reach the foreground",
            hint: "Check the device screen and retry, or relaunch it with launch-app."
          )
        )
      }
      // Give the first frame of a fresh activation a beat before interacting.
      Thread.sleep(forTimeInterval: 0.25)
      return .ready(app, reactivated: true)
    case .notRunning:
      return .unavailable(
        .failure(
          .appNotAvailable,
          "app '\(bundleId)' is not running",
          hint: "Launch it first with launch-app."
        )
      )
    default:
      // .unknown, plus any state a future SDK adds: XCTest cannot tell a
      // killed app from a live one here, so the command is refused rather
      // than gambling a launch on it.
      return .unavailable(
        .failure(
          .appNotAvailable,
          "app '\(bundleId)' is not reachable: its state is unreadable",
          hint: "Launch it first with launch-app."
        )
      )
    }
  }
}
