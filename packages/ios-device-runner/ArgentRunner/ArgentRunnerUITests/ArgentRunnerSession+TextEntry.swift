import XCTest

extension ArgentRunnerSession {
  /// Types into whatever currently has keyboard focus. The tool layer always
  /// focuses an input (a tap) before typing, so the runner only waits out the
  /// keyboard's presentation animation and lets XCTest route keystrokes to
  /// the first responder — no element resolution, which keeps typing working
  /// on screens whose accessibility trees degrade.
  func performType(_ request: CommandRequest, on app: XCUIApplication) -> Envelope {
    guard let text = request.text, !text.isEmpty else {
      return .failure(.invalidRequest, "type requires non-empty text")
    }
    _ = app.keyboards.firstMatch.waitForExistence(timeout: 3)
    let exceptionDescription = ArgentExceptionGuard.runCatching {
      app.typeText(text)
    }
    if let exceptionDescription {
      if exceptionDescription.contains("keyboard focus") {
        return .failure(
          .textInputNotFocused,
          "no text input has keyboard focus",
          hint: "Tap the target input first, then retry type."
        )
      }
      return .failure(.commandFailed, exceptionDescription)
    }
    return .success(MessagePayload(message: "typed \(text.count) characters"))
  }

  func performKeyboardReturn(on app: XCUIApplication) -> Envelope {
    // Prefer tapping the visible submit key: its label carries the action the
    // app configured (Search, Go, …) and tapping works even when typeText
    // would balk at focus.
    for label in ["return", "Return", "Enter", "Go", "go", "Search", "search", "Next", "Done", "Send", "Join", "Continue"] {
      for candidate in [app.keyboards.buttons[label], app.keyboards.keys[label]] {
        if candidate.exists && candidate.isHittable {
          candidate.tap()
          return .success(MessagePayload(message: "pressed keyboard \(label)"))
        }
      }
    }
    let exceptionDescription = ArgentExceptionGuard.runCatching {
      app.typeText(XCUIKeyboardKey.return.rawValue)
    }
    if let exceptionDescription {
      return .failure(
        .unsupportedOperation,
        "unable to press the keyboard return key: \(exceptionDescription)",
        hint: "Focus a text input first (tap it), then retry."
      )
    }
    return .success(MessagePayload(message: "typed return"))
  }

  func performKeyboardDismiss(on app: XCUIApplication) -> Envelope {
    guard visibleKeyboardFrame(app) != nil else {
      return .success(MessagePayload(message: "keyboard was not visible"))
    }
    for label in ["Hide keyboard", "Dismiss keyboard", "Done", "done"] {
      for candidate in [
        app.keyboards.buttons[label],
        app.keyboards.keys[label],
        app.toolbars.buttons[label],
      ] {
        if candidate.exists && candidate.isHittable {
          candidate.tap()
          _ = app.keyboards.firstMatch.waitForNonExistence(timeout: 2)
          return .success(MessagePayload(message: "dismissed keyboard via \(label)"))
        }
      }
    }
    // Blind background taps are never attempted: no coordinate outside the
    // keyboard can be proven side-effect-free, and a "dismiss" that also
    // navigated would be worse than an honest refusal.
    return .failure(
      .unsupportedOperation,
      "the keyboard exposes no dismiss control",
      hint:
        "Interact with the next target directly — the keyboard rarely blocks taps — "
        + "or use keyboardReturn to submit."
    )
  }
}
