import XCTest

extension ArgentRunnerSession {
    /// Types text into whatever element currently has keyboard focus. The tool
    /// layer focuses an input with a tap before sending a type command.
    func performType(_ request: CommandRequest, on app: XCUIApplication)
        -> Envelope
    {
        guard let text = request.text, !text.isEmpty else {
            return .failure(.invalidRequest, "type requires non-empty text")
        }

        // Wait for the keyboard's presentation animation to finish.
        _ = app.keyboards.firstMatch.waitForExistence(timeout: 3)

        // typeText targets the first responder directly, with no element
        // resolution, so typing works on screens whose accessibility trees
        // degrade.
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

        return .success(
            MessagePayload(message: "typed \(text.count) characters")
        )
    }

    /// Presses the keyboard's return or submit key.
    func performKeyboardReturn(on app: XCUIApplication) -> Envelope {
        // Prefer tapping the visible submit key. Its label carries the action the
        // app configured, such as Search or Go, and tapping works even when
        // typeText rejects the focus state.
        let keyboard = app.keyboards.firstMatch

        // Scan only when a keyboard is visibly up. Each exists/isHittable probe
        // is a live AX query, and a full scan on a heavy screen with no keyboard
        // can run into the 30s watchdog.
        if keyboard.exists && !keyboard.frame.isEmpty {
            for label in [
                "return", "Return", "Enter", "Go", "go", "Search", "search",
                "Next", "Done", "Send", "Join", "Continue",
            ] {
                for candidate in [
                    app.keyboards.buttons[label], app.keyboards.keys[label],
                ] {
                    if candidate.exists && candidate.isHittable {
                        candidate.tap()

                        return .success(
                            MessagePayload(message: "pressed keyboard \(label)")
                        )
                    }
                }
            }
        }

        // Fall back to typing the return character. When no input is focused
        // this fails with a clear focus error.
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
}
