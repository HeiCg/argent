import XCTest

extension ArgentRunnerSession {
  /// Full-screen PNG, returned inline as base64. Screenshots are the fallback
  /// observation channel when accessibility snapshots degrade, so this path
  /// deliberately touches no accessibility APIs.
  func captureScreenshot() -> Envelope {
    let png = XCUIScreen.main.screenshot().pngRepresentation
    guard !png.isEmpty else {
      return .failure(.commandFailed, "screenshot capture produced no data")
    }
    return .success(ScreenshotPayload(imageBase64: png.base64EncodedString()))
  }
}
