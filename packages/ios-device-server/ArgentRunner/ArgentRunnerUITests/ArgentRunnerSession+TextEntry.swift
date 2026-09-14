import XCTest

extension ArgentRunnerSession {
    /// `typeText`: types unicode text into whatever element has keyboard focus.
    /// The host focuses an input with a tap before calling this. (Base B logic.)
    func handleTypeText(_ params: RunnerParams) throws -> TypeTextReply {
        let app = try resolveTargetApp(params)
        guard let text = params.text, !text.isEmpty else {
            throw RunnerError.invalidParams("typeText requires non-empty text")
        }

        // Wait for the keyboard's presentation animation to finish.
        _ = app.keyboards.firstMatch.waitForExistence(timeout: 3)

        // typeText targets the first responder directly, so it works on screens
        // whose accessibility trees degrade.
        let exceptionDescription = ArgentExceptionGuard.runCatching {
            app.typeText(text)
        }

        if let exceptionDescription {
            if exceptionDescription.contains("keyboard focus") {
                throw RunnerError.invalidParams("no text input has keyboard focus; tap the target input first")
            }
            throw RunnerError.failed(exceptionDescription)
        }

        return TypeTextReply(success: true, charsTyped: text.count)
    }

    /// `key`: a named keyboard key (`return` / `delete` / `escape`) typed into the
    /// focused input, or a hardware button (`home` / `volumeUp` / `volumeDown` /
    /// `actionButton`) pressed on the device. Base B's `keyboardReturn` and
    /// `button` commands, folded into one method.
    func handleKey(_ params: RunnerParams) throws -> OkReply {
        guard let key = params.key?.trimmedNonEmpty else {
            throw RunnerError.invalidParams("key requires a key name")
        }

        // Hardware buttons are device-scoped and need no target app.
        if let button = Self.hardwareButtons[key] {
            let device = XCUIDevice.shared
            guard device.hasHardwareButton(button) else {
                throw RunnerError.unsupported("this device has no \(key) button")
            }
            device.press(button)
            return OkReply(success: true)
        }

        let keyboardKey: String
        switch key.lowercased() {
        case "return", "enter":
            keyboardKey = XCUIKeyboardKey.return.rawValue
        case "delete", "backspace":
            keyboardKey = XCUIKeyboardKey.delete.rawValue
        case "escape", "esc":
            keyboardKey = XCUIKeyboardKey.escape.rawValue
        default:
            throw RunnerError.unsupported("unsupported key '\(key)'; use return, delete, escape, or a hardware button")
        }

        let app = try resolveTargetApp(params)
        let exceptionDescription = ArgentExceptionGuard.runCatching {
            app.typeText(keyboardKey)
        }
        if let exceptionDescription {
            throw RunnerError.failed("unable to press key '\(key)': \(exceptionDescription)")
        }
        return OkReply(success: true)
    }
}
